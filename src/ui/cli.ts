/** DeepSeek Code v0.3.0 readline UI with streaming output and Chinese status text. */

import { agentLoop } from "../agent/loop"
import { DeepSeekProvider } from "../provider/deepseek"
import { AnthropicProvider } from "../provider/anthropic"
import { OpenAIProvider } from "../provider/openai"
import { MultiProvider } from "../provider/multi"
import { ProviderRegistry } from "../provider/registry"
import { ModelRouter } from "../provider/router"
import { buildTools } from "../tools/registry"
import { FILE_TOOLS } from "../tools/file"
import { SHELL_TOOL } from "../tools/shell"
import { START_SERVICE_TOOL } from "../tools/service"
import { GIT_TOOLS } from "../tools/git"
import { WEB_SEARCH } from "../tools/search"
import { WEB_FETCH_TOOL } from "../tools/webfetch"
import { CODEGRAPH_TOOLS } from "../tools/codegraph"
import { LSP_TOOLS } from "../tools/lsp"
import { TYPECHECK_TOOL } from "../tools/typescript"
import type { ToolDef } from "../tools/registry"
import { StagedContextManager } from "../context/staged"
import { SessionManager, SessionCorruptedError, SessionStore, searchAllSessions, needsMigration, migrateAllJsonSessions } from "../session"
import { lastCheckpoint, buildRecoveryPrompt, verifyCheckpoint, registerCheckpointStore, unregisterCheckpointStore } from "../session/checkpoint"
import type { SessionCheckpoint } from "../session/checkpoint"
import { buildResumeContext, resumeMessages } from "../session/summarizer"
import { ThinkingStore } from "../memory/thinking-store"
import { KnowledgeBase } from "../memory/knowledge"
import {
  addTurn,
  buildCompactionPreview,
  buildDynamicMemoryContext,
  buildStableAnchorContext,
  createBaseCheckpoint,
  createCompactor,
  restoreCompactorState,
  saveCompactorState,
} from "../memory/compactor"
import type { UsageStats } from "../agent/loop"
import { createStreamRenderState, dim, flushStreamRender, green, yellow, red, renderResponse, renderStreamChunk } from "./render"
import { reprompt, startInput } from "./input"
import { CommandRegistry } from "./commands/registry"
import { createBuiltinCommands } from "./commands/definitions"
import { formatCacheAnatomyHud, formatTokenHud } from "./token-hud"
import { closeToolCalls, createToolTraceState, renderToolCall, renderToolResult, renderToolStatus } from "./tool-trace"
import { shouldUseChatLite } from "./chat-lite"
import { shouldSkipProviderPurpose } from "../provider/cost-policy"
import { playStartupScreen } from "./startup-screen"
import { playInkStartupScreen } from "./ink-startup"
import { HookSystem } from "../hooks"
import { writeGuard, createJournalGuard } from "../hooks/builtin"
import { createSafetyPolicyHook } from "../hooks/safety-policy"
import { AgentRunTrace } from "../agent/run-trace"
import { findPendingClarification } from "../agent/clarification"
import { getLSPClient, resetLSPClient } from "../lsp/client"
import { bootstrapMCP } from "../mcp/bridge"

const formatK = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)
const LITE_CONTEXT_MAX = 1_000_000
const CHAT_LITE_SYSTEM = "你是 DeepSeek Code。当前是轻聊天模式：简短回应用户，不读取文件，不调用工具，不做项目分析。"

let sessionInputTokens = 0
let sessionOutputTokens = 0
let sessionMs = 0
let prevInput = 0
let prevOutput = 0
let lastUsage: UsageStats | null = null

interface TokenUsageEvent {
  requestedModel?: string
  actualModel?: string
  inputTokens: number
  outputTokens: number
  contextMax: number
  roundMs?: number
  cacheHitRate?: number
  cacheSource?: string
  contextUsagePercent?: number
  cacheReadInputTokens?: number
  cacheMissInputTokens?: number
  cacheCreationInputTokens?: number
  outputShare?: number
  missShare?: number
  claudeStyleCacheShape?: boolean
  cacheAnatomy?: { stableTokens: number; volatileTokens: number }
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function replaceCompactorState(compactor: ReturnType<typeof createCompactor>, next: ReturnType<typeof createCompactor>) {
  Object.assign(compactor, next)
}

function rememberTurn(compactor: ReturnType<typeof createCompactor>, turn: { role: "user" | "assistant"; content: string }) {
  replaceCompactorState(compactor, addTurn(compactor, turn))
}

function maybeCreateM0(compactor: ReturnType<typeof createCompactor>, title: string) {
  const thresholdTokens = envNumber("DEEPSEEK_M0_THRESHOLD_TOKENS", 50_000)
  if (compactor.anchor || compactor.estimatedTokens < thresholdTokens) return
  replaceCompactorState(compactor, createBaseCheckpoint(compactor, {
    sessionId: "auto-m0",
    thresholdTokens,
    title: title.slice(0, 140),
  }))
}

import { addNode, removeNode, skipNode, planRef, planProgress } from "../agent/master-plan"

const REQUEST_DEEPER_THINKING: ToolDef = {
  name: "request_deeper_thinking",
  description:
    "当你发现当前推理不足以解决此问题、需要更大的思考预算时调用。" +
    "如果问题涉及架构决策、安全审查、跨文件影响、多层抽象或需要穷举边界条件，说明理由。" +
    "触发后下一轮将升级到 think-max 32K tokens。",
  isReadonly: true,
  isConcurrencySafe: true,
  userFacingName: "更深思考",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "为什么需要更深推理（架构/安全/跨文件/多抽象层/边界穷举）" },
    },
    required: ["reason"],
  },
  execute: async (_params: Record<string, unknown>) => {
    return { success: true, content: "下一轮将使用 thinking max 32K tokens 深度推理。", metadata: { upgradeThinking: "max" } }
  },
}

const TASK_TOOL: ToolDef = {
  name: "task",
  description:
    "管理主计划的任务树。当一个长任务被分解为多个阶段时，用它追踪进度。\n" +
    "\n" +
    "## 什么时候用它\n" +
    "- 任务涉及 3+ 个独立交付阶段（如「后端→前端→测试」）\n" +
    "- 执行中发现新的必须完成的子任务，但不在当前计划里\n" +
    "- 某个阶段发现没必要做了，需要从计划中移除\n" +
    "- 完成一个阶段后，想查看整体进度决定下一步\n" +
    "\n" +
    "## 操作\n" +
    "- list: 查看所有节点和状态\n" +
    "- add: 新增节点。参数 title（标题）, depends_on（依赖哪个节点 ID，可选）\n" +
    "- done: 标记完成。参数 node_id, reason（完成了什么，可选）\n" +
    "- remove: 删除不需要的节点。参数 node_id, reason（为什么不需要）\n" +
    "- skip: 跳过不做的节点。参数 node_id, reason",
  isReadonly: false,
  isConcurrencySafe: false,
  userFacingName: "任务管理",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: "list | add | done | remove | skip",
      },
      title: {
        type: "string",
        description: "add 时的节点标题",
      },
      node_id: {
        type: "string",
        description: "done/remove/skip 时的节点 ID",
      },
      depends_on: {
        type: "string",
        description: "add 时的依赖节点 ID（逗号分隔，可选）",
      },
      reason: {
        type: "string",
        description: "done/remove/skip 时的原因或证据",
      },
    },
    required: ["operation"],
  },
  execute: async (params: Record<string, unknown>) => {
    const plan = planRef.current
    if (!plan) return { success: false, content: "没有活跃的主计划。长任务启动后主计划会自动创建。", error: "no active plan" }

    const op = String(params.operation ?? "")
    switch (op) {
      case "list": {
        const nodes = plan.nodes.map(n => {
          const icon = { pending: "🔵", active: "🔄", blocked: "🟡", done: "✅", skipped: "❌" }[n.status]
          return `${icon} ${n.id}. ${n.title}${n.dependsOn.length ? ` (依赖: ${n.dependsOn.join(", ")})` : ""}${n.evidence ? ` — ${n.evidence}` : ""}`
        })
        return { success: true, content: `主计划: ${planProgress(plan)}\n\n${nodes.join("\n")}` }
      }
      case "add": {
        const title = String(params.title ?? "").trim()
        if (!title) return { success: false, content: "add 需要 title 参数", error: "missing title" }
        const deps = String(params.depends_on ?? "").split(",").map(s => s.trim()).filter(Boolean)
        const node = addNode(plan, title, deps)
        return { success: true, content: `已添加节点 ${node.id}. ${title}${deps.length ? ` (依赖: ${deps.join(", ")})` : ""}` }
      }
      case "done": {
        const id = String(params.node_id ?? "")
        if (!id) return { success: false, content: "done 需要 node_id 参数", error: "missing node_id" }
        const node = plan.nodes.find(n => n.id === id)
        if (!node) return { success: false, content: `节点 ${id} 不存在`, error: "not found" }
        node.status = "done"
        node.evidence = String(params.reason ?? "")
        plan.updatedAt = Date.now()
        return { success: true, content: `节点 ${id}. ${node.title} 已标记完成。${node.evidence ? `证据: ${node.evidence}` : ""}` }
      }
      case "remove": {
        const id = String(params.node_id ?? "")
        const reason = String(params.reason ?? "")
        const ok = removeNode(plan, id, reason)
        return ok
          ? { success: true, content: `节点 ${id} 已删除。${reason ? `原因: ${reason}` : ""}` }
          : { success: false, content: `无法删除节点 ${id}（不存在或已完成）`, error: "cannot remove" }
      }
      case "skip": {
        const id = String(params.node_id ?? "")
        const reason = String(params.reason ?? "")
        const ok = skipNode(plan, id, reason)
        return ok
          ? { success: true, content: `节点 ${id} 已跳过。${reason ? `原因: ${reason}` : ""}` }
          : { success: false, content: `无法跳过节点 ${id}（不存在或已完成）`, error: "cannot skip" }
      }
      default:
        return { success: false, content: `未知操作: ${op}。支持: list | add | done | remove | skip`, error: "unknown operation" }
    }
  },
}

export async function startCLI(cliPrompt?: string, resumeId?: string) {
  const undoStack: Array<{ path: string; previousContent: string | null }> = []
  const dsApiKey = process.env.DEEPSEEK_API_KEY ?? ""
  const anthApiKey = process.env.ANTHROPIC_API_KEY ?? ""
  const openaiApiKey = process.env.OPENAI_API_KEY ?? ""

  // ── Multi-provider setup ──
  const registry = new ProviderRegistry()

  // DeepSeek (always registered — primary)
  if (!dsApiKey) { console.error("DEEPSEEK_API_KEY not set (required for default provider)"); process.exit(1) }
  const dsProvider = new DeepSeekProvider(dsApiKey)
  registry.register({ id: "deepseek", provider: dsProvider, defaultModel: "deepseek-v4-pro" })

  // Anthropic (optional)
  if (anthApiKey) {
    registry.register({ id: "anthropic", provider: new AnthropicProvider(anthApiKey), defaultModel: "claude-sonnet-4-6" })
  }

  // OpenAI (optional)
  if (openaiApiKey) {
    registry.register({ id: "openai", provider: new OpenAIProvider(openaiApiKey), defaultModel: "gpt-5" })
  }

  registry.registerBuiltinModels()

  // MultiProvider wraps the registry — transparent to loop.ts
  const modelOverride = process.env.DEEPSEEK_MODEL_OVERRIDE
  const multiProvider = new MultiProvider({ registry, defaultModel: modelOverride ?? "deepseek-v4-pro" })
  const modelRouter = new ModelRouter(registry, multiProvider)

  // ── Migrate old JSON sessions to SQLite ──
  if (needsMigration()) {
    const result = migrateAllJsonSessions()
    if (result.migrated > 0) {
      process.stderr.write(`已迁移 ${result.migrated} 个旧格式会话到 SQLite\n`)
    }
    if (result.errors.length > 0) {
      process.stderr.write(`迁移错误: ${result.errors.join(", ")}\n`)
    }
  }

  // ── MCP bootstrap — connect servers + discover tools ──
  const mcpResult = await bootstrapMCP({
    onStatus: (msg) => { process.stderr.write(`${msg}\n`) },
  })
  const mcpToolDefs = mcpResult.tools
  if (mcpResult.failed.length > 0) {
    process.stderr.write(`MCP: ${mcpResult.failed.length} server(s) failed: ${mcpResult.failed.join(", ")}\n`)
  }

  const toolDefs = [...FILE_TOOLS, SHELL_TOOL, START_SERVICE_TOOL, ...GIT_TOOLS, WEB_SEARCH, WEB_FETCH_TOOL, ...CODEGRAPH_TOOLS, ...LSP_TOOLS, TYPECHECK_TOOL, ...mcpToolDefs, TASK_TOOL, REQUEST_DEEPER_THINKING]
  const tools = buildTools(...toolDefs)
  const hooks = new HookSystem()
  // Before hooks: safety → writeGuard (ordered: widest guard first)
  hooks.onToolBefore(createSafetyPolicyHook({ projectRoot: process.cwd() }))
  hooks.onToolBefore(writeGuard)
  // After hooks: journal guard (vetoes on write after results)
  hooks.onToolAfter(createJournalGuard(process.cwd()))
  const stagedCtx = new StagedContextManager(process.cwd())
  const sessions = new SessionManager()
  const thinkingStore = new ThinkingStore()
  const knowledgeBase = new KnowledgeBase()
  let sessionId = resumeId || sessions.create().id
  let thinkEffort: "auto" | "high" | "max" = "auto"
  const history: Array<{ role: "user" | "assistant"; content: string }> = []

  // ── LSP client — start lazily in background ──
  const lspClient = getLSPClient(process.cwd())
  lspClient.start().then(available => {
    if (available) {
      process.stderr.write(`LSP: typescript-language-server connected\n`)
    }
  }).catch(() => { /* silent — tsc fallback handles it */ })

  // ── SessionStore for checkpoint/save — open once for the session lifetime ──
  const sessionStore = new SessionStore(sessionId)
  registerCheckpointStore(sessionId, sessionStore)

  let resumeFromCheckpoint: SessionCheckpoint | null = null

  if (resumeId) {
    try {
      const restored = sessions.load(resumeId)
      if (restored) {
        const stagedFiles = (restored.metadata?.stagedFiles as string[]) ?? []
        for (const f of stagedFiles) { try { stagedCtx.markLoaded(f) } catch { } }
        // ── Checkpoint recovery: if checkpoint exists, verify and load ──
        const cp = lastCheckpoint(resumeId)
        if (cp) {
          const integrity = verifyCheckpoint(cp)
          if (integrity.valid) {
            resumeFromCheckpoint = cp
            const stepsDone = cp.taskSteps.filter(s => s.status === "done").length
            console.log(green(
              `从检查点恢复 (round ${cp.round}, ${stepsDone}/${cp.taskSteps.length} 步骤, ${cp.changedFiles.length} 文件)`
            ))
          } else {
            console.log(yellow(
              `检查点文件已变更 (${integrity.filesMismatched.length} 个不匹配)，从对话历史恢复`
            ))
            history.push({ role: "assistant", content: buildResumeContext(restored) })
          }
        } else {
          history.push({ role: "assistant", content: buildResumeContext(restored) })
        }
        for (const m of resumeMessages(restored)) history.push(m)
        sessionId = resumeId
      } else {
        console.log(yellow(`会话 ${resumeId} 不存在，创建新会话`))
      }
    } catch (e) {
      if (e instanceof SessionCorruptedError) {
        console.log(yellow(`会话 ${resumeId} 已损坏（${e.message}），创建新会话`))
      } else {
        throw e
      }
    }
  }

  const startupOptions = {
    version: "0.3.0",
    toolsCount: tools.length,
    thinkingEffort: thinkEffort,
    modelName: modelOverride ?? "deepseek-v4-pro",
  }
  const usedInkStartup = await playInkStartupScreen(startupOptions).catch(() => false)
  if (!usedInkStartup) await playStartupScreen(startupOptions)

  const compactor = createCompactor()
  if (resumeId) restoreCompactorState(compactor, resumeId)

  if (cliPrompt) {
    process.stdout.write(`${dim(">")}  ${cliPrompt}\n\n`)
    if (shouldUseChatLite(cliPrompt) && !shouldSkipProviderPurpose("chat_lite")) await runLiteTurn(multiProvider, modelRouter, cliPrompt, history, compactor)
    else await runTurn(multiProvider, modelRouter, tools, cliPrompt, stagedCtx, thinkingStore, compactor, history, undoStack, knowledgeBase, thinkEffort, hooks, sessionId, resumeFromCheckpoint)
    return
  }

  // ── Safe session ID setter — re-registers checkpoint store on change ──
  const setSessionId = (id: string) => {
    if (id !== sessionId) {
      unregisterCheckpointStore(sessionId)
      sessionId = id
      registerCheckpointStore(id, new SessionStore(id))
    }
  }

  // ── Command registry ──
  const commandRegistry = new CommandRegistry()
  const cmdCtx = {
    history,
    stagedCtx,
    sessions,
    thinkingStore,
    knowledgeBase,
    compactor,
    sessionId,
    undoStack,
    thinkEffort,
    hooks,
    setThinkEffort: (val: "auto" | "high" | "max") => { thinkEffort = val },
    setSessionId,
    showHelp: () => { console.log(commandRegistry.buildHelp() + "\n") },
    reprompt: () => {},
  }
  for (const def of createBuiltinCommands({
    getSessionTokens: () => ({ input: sessionInputTokens, output: sessionOutputTokens, ms: sessionMs }),
    resetSessionTokens: () => { sessionInputTokens = 0; sessionOutputTokens = 0; sessionMs = 0 },
    getLastUsage: () => lastUsage,
  })) {
    commandRegistry.register(def)
  }

  const rl = startInput(async (input: string) => {
    rl.pause()

    // Dispatch slash commands through registry
    if (input.startsWith("/")) {
      const handled = commandRegistry.execute(input, { ...cmdCtx, reprompt: () => reprompt(rl) })
      if (handled) { reprompt(rl); return }
    }

    lastUsage = null
    if (shouldUseChatLite(input) && !shouldSkipProviderPurpose("chat_lite") && !findPendingClarification(history)) await runLiteTurn(multiProvider, modelRouter, input, history, compactor)
    else await runTurn(multiProvider, modelRouter, tools, input, stagedCtx, thinkingStore, compactor, history, undoStack, knowledgeBase, thinkEffort, hooks, sessionId, resumeFromCheckpoint)
    if (history.length % 5 === 0 && history.length > 0) {
      setSessionId(persistSession(sessions, history, stagedCtx, compactor, sessionId, !sessionId))
    }
    reprompt(rl)
  })

  if (resumeId) {
    setTimeout(() => reprompt(rl), 50)
  }
}

function showStats(sessionId: string, msgCount: number, fileCount: number) {
  console.log(dim(`会话: ${sessionId || "(未保存)"}  |  消息: ${msgCount}  |  文件: ${fileCount}`))
  if (lastUsage) {
    const u = lastUsage
    const hr = u.apiCalls > 0 ? Math.round(u.cacheHits / u.apiCalls * 100) : 0
    console.log(dim(`API: ${u.apiCalls} 次 | Flash ${u.flashRounds} Pro ${u.proRounds} | ${Math.round(u.estimatedInputTokens / 1000)}K | 缓存 ${hr}%`))
  }
  console.log(dim(`累计: ${formatK(sessionInputTokens + sessionOutputTokens)} tokens | ${(sessionMs / 1000).toFixed(0)}s\n`))
}

function persistSession(
  sessions: SessionManager,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  stagedCtx: StagedContextManager,
  compactor: ReturnType<typeof createCompactor>,
  sessionId: string,
  isNew: boolean,
  /** Optional: update active SessionStore when session ID changes (first save). */
  onNewId?: (oldId: string, newId: string) => void,
): string {
  const s = isNew
    ? sessions.create({ topic: history[0]?.content?.slice(0, 50), messageCount: history.length })
    : (() => { try { return sessions.load(sessionId) } catch { return null } })()
      ?? sessions.create({ topic: history[0]?.content?.slice(0, 50), messageCount: history.length })
  s.messages = history.map(h => ({ role: h.role as "user" | "assistant", content: h.content, timestamp: Date.now(), metadata: {} }))
  s.metadata = { ...s.metadata, messageCount: history.length, stagedFiles: [...stagedCtx.loadedFiles.keys()] }
  sessions.save(s)
  saveCompactorState(compactor, s.id)

  // Notify that the session ID changed (first save)
  if (onNewId && s.id !== sessionId) {
    onNewId(sessionId, s.id)
  }
  return s.id
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 3))
}

async function runLiteTurn(
  provider: MultiProvider,
  router: ModelRouter,
  prompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  compactor: ReturnType<typeof createCompactor>,
) {
  const started = Date.now()
  const streamRender = createStreamRenderState()
  const recentHistory = history
    .slice(-4)
    .filter(item => item.content.length <= 500)
  const messages = [
    ...recentHistory,
    { role: "user" as const, content: prompt },
  ]

  const inputTokens = estimateTokens(CHAT_LITE_SYSTEM + JSON.stringify(messages))
  let outputText = ""
  let streamedTextStarted = false
  const liteModel = router.selectForPurpose("chat_lite")

  for await (const event of provider.streamChat({
    model: liteModel,
    purpose: "chat_lite",
    system: CHAT_LITE_SYSTEM,
    messages,
    maxTokens: 512,
  })) {
    if (event.type === "text") {
      if (!streamedTextStarted) {
        process.stdout.write(dim("DS  "))
        streamedTextStarted = true
      }
      const chunk = String(event.data ?? "")
      process.stdout.write(renderStreamChunk(streamRender, chunk))
      outputText += chunk
    } else if (event.type === "error") {
      process.stdout.write(red(`  ✗ ${event.data}\n`))
    }
  }

  if (streamedTextStarted) {
    const tail = flushStreamRender(streamRender)
    if (tail) process.stdout.write(tail)
    process.stdout.write("\n")
  }

  const outputTokens = estimateTokens(outputText)
  sessionInputTokens += inputTokens
  sessionOutputTokens += outputTokens
  const elapsedMs = Date.now() - started
  sessionMs += elapsedMs
  const total = formatTokenHud({
    inputTokens: sessionInputTokens,
    outputTokens: sessionOutputTokens,
    contextMax: LITE_CONTEXT_MAX,
  })
  console.log(dim(`[轻聊天 本轮 ~${formatK(inputTokens + outputTokens)} tokens | 上下文 ${total} | 耗时 ${(elapsedMs / 1000).toFixed(1)}s]`))

  rememberTurn(compactor, { role: "user", content: prompt })
  if (outputText) rememberTurn(compactor, { role: "assistant", content: outputText })
  maybeCreateM0(compactor, prompt)
  history.push({ role: "user", content: prompt })
  if (outputText) history.push({ role: "assistant", content: outputText })
}

async function runTurn(
  provider: MultiProvider,
  router: ModelRouter,
  tools: ReturnType<typeof buildTools>,
  prompt: string,
  stagedCtx: StagedContextManager,
  thinkingStore: ThinkingStore,
  compactor: ReturnType<typeof createCompactor>,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  _undoStack: Array<{ path: string; previousContent: string | null }>,
  knowledgeBase: KnowledgeBase,
  thinkEffort: "auto" | "high" | "max",
  hooks: HookSystem,
  sessionId: string,
  resumeFromCheckpoint: SessionCheckpoint | null,
) {
  prevInput = 0
  prevOutput = 0
  let lastText = ""
  let streamedTextStarted = false
  const streamRender = createStreamRenderState()
  const toolTrace = createToolTraceState()
  let tokenData: TokenUsageEvent | null = null
  let cumulativeCacheRead = 0
  let cumulativeCacheMiss = 0
  let cumulativeCacheCreation = 0
  let totalMs = 0
  let printedToolTrace = false

  const isTTY = process.stdout.isTTY
  const frames = ["-", "\\", "|", "/"]
  let si = 0
  let spinnerActive = Boolean(isTTY)
  let spinnerNote = ""
  const renderSpinner = () => {
    const sIn = sessionInputTokens + prevInput
    const note = spinnerNote ? `  ${spinnerNote}` : ""
    process.stdout.write(`\r\x1b[K${dim(`${frames[si++ % frames.length]} 思考中`)}${dim(note)}  ${dim(`累计 ${formatK(sIn)} tokens`)}`)
  }
  const stopTransientStatus = () => {
    spinnerActive = false
    if (isTTY) process.stdout.write("\r\x1b[K")
  }
  const spinnerTimer = setInterval(() => {
    if (!spinnerActive) return
    renderSpinner()
  }, 80)

  maybeCreateM0(compactor, prompt)
  const stableMemoryContext = buildStableAnchorContext(compactor)
  const dynamicMemoryContext = buildDynamicMemoryContext(compactor)
  const warmHistory = dynamicMemoryContext
    ? [...history, { role: "assistant" as const, content: dynamicMemoryContext }]
    : [...history]
  const runTrace = AgentRunTrace.start(process.cwd(), prompt)
  let planNeedsReinvoke = false

  const opts: Record<string, unknown> = {
    provider,
    model: router.selectForPurpose("agent_main"),
    tools,
    conversationHistory: warmHistory,
    stagedContext: stagedCtx,
    thinkingStore,
    knowledgeBase,
    thinkEffort: thinkEffort === "auto" ? undefined : thinkEffort,
    stableMemoryContext,
    hooks,
    autoFinishOnVerifiedWrite: true,
    autoApprovePlan: Boolean(prompt) || process.stdin?.isTTY !== true,
    runTrace,
    sessionId,
    modelRouter: router,
    ...(resumeFromCheckpoint ? { resumeFromCheckpoint } : {}),
  }

  do {
  try {
    planNeedsReinvoke = false
    for await (const event of agentLoop(prompt, opts as unknown as Parameters<typeof agentLoop>[1])) {
      switch (event.type) {
        case "text":
          stopTransientStatus()
          if (!streamedTextStarted) {
            const closed = closeToolCalls(toolTrace)
            if (closed) { process.stdout.write(closed); printedToolTrace = true }
            if (printedToolTrace) process.stdout.write("\n")
            process.stdout.write(dim("DS  "))
            streamedTextStarted = true
          }
          process.stdout.write(renderStreamChunk(streamRender, String(event.data ?? "")))
          lastText += String(event.data ?? "")
          break

        case "tool_call": {
          stopTransientStatus()
          const data = event.data as { name: string; input?: Record<string, unknown> }
          const out = renderToolCall(toolTrace, data.name, data.input ?? {})
          if (out) printedToolTrace = true
          if (out) process.stdout.write(out + "\n")
          if (isTTY) {
            spinnerNote = "执行工具"
            spinnerActive = true
            renderSpinner()
          }
          break
        }

        case "tool_result": {
          stopTransientStatus()
          const data = event.data as { name: string; content: string }
          const out = renderToolResult(toolTrace, data.name, String(data.content ?? ""))
          if (out) printedToolTrace = true
          process.stdout.write(out)
          break
        }

        case "status": {
          const status = String(event.data ?? "")
          const out = renderToolStatus(toolTrace, status)
          if (out) {
            stopTransientStatus()
            printedToolTrace = true
            process.stdout.write(out)
          } else if (isTTY) {
            spinnerNote = /^(thinking|working|continue)$/i.test(status) ? "" : status
            spinnerActive = true
            renderSpinner()
          }
          break
        }

        case "token_usage": {
          tokenData = event.data as TokenUsageEvent
          if (!tokenData) break
          if (tokenData.roundMs) totalMs += tokenData.roundMs
          if (tokenData.roundMs && tokenData.cacheSource === "provider") {
            cumulativeCacheRead += tokenData.cacheReadInputTokens ?? 0
            cumulativeCacheMiss += tokenData.cacheMissInputTokens ?? 0
            cumulativeCacheCreation += tokenData.cacheCreationInputTokens ?? 0
          }
          const dInput = tokenData.inputTokens - prevInput
          const dOutput = tokenData.outputTokens - prevOutput
          if (dInput > 0) sessionInputTokens += dInput
          if (dOutput > 0) sessionOutputTokens += dOutput
          prevInput = tokenData.inputTokens
          prevOutput = tokenData.outputTokens
          break
        }

        case "plan_ready": {
          stopTransientStatus()
          const data = event.data as {
            planText: string; score: number; signals: string[];
            goal: string; steps: Array<{ id: string; title: string }>;
            requiredFiles: string[]; requiredVerificationKinds: string[];
            missingItems: string[];
          }
          process.stdout.write("\n" + yellow("=== 执行计划 (请审核) ===") + "\n")
          process.stdout.write(`目标: ${data.goal}\n`)
          process.stdout.write(`质量评分: ${data.score}/8\n`)
          if (data.missingItems.length > 0) {
            process.stdout.write(yellow("注意事项: " + data.missingItems.join("; ")) + "\n")
          }
          process.stdout.write("\n步骤:\n")
          for (const step of data.steps) {
            process.stdout.write(`  - ${step.title}\n`)
          }
          process.stdout.write(`\n交付文件: ${data.requiredFiles.join(", ")}\n`)
          process.stdout.write(`验证: ${data.requiredVerificationKinds.join(", ")}\n`)
          process.stdout.write("\n")
          const answer = await new Promise<string>(resolve => {
            const { stdin, stdout } = process
            stdout.write(yellow("[Y] 批准执行  [n] 修改计划  [x] 取消] "))
            const onData = (data: Buffer) => {
              stdin.removeListener("data", onData)
              if (stdin.isTTY) stdin.setRawMode(false)
              resolve(data.toString().trim())
            }
            if (stdin.isTTY) stdin.setRawMode(true)
            stdin.on("data", onData)
          })
          const normalized = answer.trim().toLowerCase()
          if (normalized === "" || normalized === "y" || normalized === "yes") {
            warmHistory.push({ role: "user", content: "[PLAN_APPROVED] 用户已批准计划，进入执行阶段。" })
            planNeedsReinvoke = true
          } else if (normalized === "x" || normalized === "cancel") {
            process.stdout.write(red("计划已取消\n"))
            return
          } else {
            warmHistory.push({ role: "user", content: `[PLAN_REVISE] 用户要求修改计划：${answer}` })
            planNeedsReinvoke = true
          }
          break
        }

        case "error":
          stopTransientStatus()
          process.stdout.write(red(`  ✗ ${event.data}\n`))
          break
      }
    }
  } finally {
    stopTransientStatus()
    clearInterval(spinnerTimer)
  }
  } while (planNeedsReinvoke)

  process.stdout.write(closeToolCalls(toolTrace))

  if (streamedTextStarted) {
    const tail = flushStreamRender(streamRender)
    if (tail) process.stdout.write(tail)
    process.stdout.write("\n")
  }
  if (lastText && !streamedTextStarted) {
    process.stdout.write(dim("DS  ") + renderResponse(lastText) + "\n")
  }

  sessionMs += totalMs
  if (tokenData) {
    const turnTokens = Math.max(0, tokenData.inputTokens + tokenData.outputTokens)
    const total = formatTokenHud({
      inputTokens: sessionInputTokens,
      outputTokens: sessionOutputTokens,
      contextMax: tokenData.contextMax,
    })
    const parts = [`本轮 ~${formatK(turnTokens)} tokens`]
    const cumulativeCacheTotal = cumulativeCacheRead + cumulativeCacheMiss
    const cacheHud = formatCacheAnatomyHud({
      ...tokenData,
      cumulativeCacheReadInputTokens: cumulativeCacheTotal > 0 ? cumulativeCacheRead : undefined,
      cumulativeCacheMissInputTokens: cumulativeCacheTotal > 0 ? cumulativeCacheMiss : undefined,
      cumulativeCacheCreationInputTokens: cumulativeCacheCreation > 0 ? cumulativeCacheCreation : undefined,
      cumulativeCacheHitRate: cumulativeCacheTotal > 0 ? Math.round((cumulativeCacheRead / cumulativeCacheTotal) * 100) : undefined,
    })
    if (cacheHud) parts.push(cacheHud)
    parts.push(`上下文 ${total}${typeof tokenData.contextUsagePercent === "number" ? ` (${tokenData.contextUsagePercent}%)` : ""}`)
    if (totalMs > 0) parts.push(`耗时 ${(totalMs / 1000).toFixed(1)}s`)
    console.log(dim(`[${parts.join(" | ")}]`))
  }

  rememberTurn(compactor, { role: "user", content: prompt })
  if (lastText) rememberTurn(compactor, { role: "assistant", content: lastText })
  maybeCreateM0(compactor, prompt)
  history.push({ role: "user", content: prompt })
  if (lastText) history.push({ role: "assistant", content: lastText })
}
