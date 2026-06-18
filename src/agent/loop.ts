/** Agent while-True tool loop — with self-learn triggers, staged context, thinking store, post-edit lint. */

import type { LLMProvider, ProviderMessage, ProviderTokenUsage, StreamEvent } from "../provider/types"
import type { ToolDescriptor, ToolResult } from "../tools/registry"
import { createState, decideThinkingPlan, updateState } from "./router"
import { buildSystemPrompt } from "./prompts"
import { CacheTracker } from "../provider/cache-tracker"
import type { StagedContextManager } from "../context/staged"
import type { ThinkingStore } from "../memory/thinking-store"
import type { KnowledgeBase } from "../memory/knowledge"
import { distillAndStore, shouldDistill } from "../memory/distiller"
import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { selectTools } from "./tool-disclosure"
import { buildContextKernel } from "../context/kernel"
import { classifyIntent } from "./intent"
import { FlashTriage, triageModeToIntent, triageToTaskIntent, buildTrackerFromTriage, activateSkillNamesByKeywords, resolveFlashTriagePolicy, shouldUseFlashTriage } from "./flash-triage"
import { activateSkillsByNames } from "../skills/registry"
import { revisePlan } from "./task-tracker"
import { mergeProviderTokenUsage } from "../provider/usage"
import { setRuntimeContextBudgetMode } from "./runtime-context"
import type { RippleReport } from "../ripple/types"
import { mergeObligations, normalizeProjectPath, obligationsFromReport, resolveObligations, type RippleObligation } from "../ripple/obligations"
import { formatRippleExitGateCallers, setCascadeFiles } from "../ripple/engine"
import { buildCacheAnatomy } from "../context/cache-anatomy"
import type { ModelRouter } from "../provider/router"
import { ConfidenceEvaluator } from "../evaluator/confidence"
import type { ObjectiveSignals } from "../evaluator/types"
import { validateContracts } from "./contracts"
import { AgentState, StateMachine } from "./state-machine"
import type { AgentContext } from "./state-machine"
import type { HookSystem } from "../hooks"
import { formatSkippedProviderPurpose, shouldSkipProviderPurpose } from "../provider/cost-policy"
import { formatToolLedgerStatus, ToolExecutionLedger } from "./tool-ledger"
import { runTypeScriptNoEmit } from "../tools/typescript"
import { getLSPClient } from "../lsp/client"
import { formatServiceTestGuidance, hasServiceTestFailure, type VerificationResult } from "../verification/result"
import type { AgentRunTrace } from "./run-trace"
import {
  createTaskTracker,
  formatTaskPlanningPrompt,
  formatTaskTrackerPrompt,
  formatTaskTrackerStatus,
  markPlanAccepted,
  missingTaskRequirements,
  snapshotTaskTracker,
  taskTrackerComplete,
  updateTaskTrackerAfterTools,
} from "./task-tracker"
import { buildEffectivePrompt, buildModelClarificationCall, evaluateClarificationNeed, formatModelClarificationFailure, parseModelClarification } from "./clarification"
import { buildExperienceKernelContext } from "../experience/kernel"
import { compactThinkingChain } from "../memory/compactor"
import { evaluatePlanningArtifact, formatPlanningBlockedToolResult, formatPlanningGatePrompt } from "./planning-gate"
import { evaluateCompletionGate, formatBlockedCompletion, formatCompletionEvidenceReport, formatCompletionGatePrompt, needsExternalCompletionGate } from "./completion-gate"
import { formatGenericProviderStreamBlockedReport, formatGenericProviderStreamRecoveryPrompt, formatProviderStreamBlockedReport, formatProviderStreamRecoveryPrompt } from "./runtime-failure"
import { buildResearchEvidenceContext, buildResearchInsufficientEvidenceMessage, type ResearchEvidence } from "./research-answer"
import { classifyResearchRoute, shouldRunResearch } from "./research-router"
import { FlashJudge, TestimonyLedger } from "./flash-judge"
import { inferToolCategory, PermissionGate } from "./permission"
import { loadUserConfig, loadProjectConfig } from "./permission-config"
import type { ToolCategory } from "./permission"
import { SandboxManager } from "../sandbox/sandbox"
import { setShellSandbox } from "../tools/shell"
import { saveCheckpoint, adaptiveCheckpointThreshold, shouldSkipCheckpointThisRound, recordCheckpointTaken, formatCheckpointSummary, type ComplexityMetrics } from "../session/checkpoint"

export interface UsageStats {
  apiCalls: number
  estimatedInputTokens: number
  cacheHits: number
  cacheMisses: number
  flashRounds: number
  proRounds: number
  flashUsed: boolean
}

export interface AgentOptions {
  provider: LLMProvider
  model: string
  tools: ToolDescriptor[]
  maxRounds?: number
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>
  stagedContext?: StagedContextManager
  thinkingStore?: ThinkingStore
  knowledgeBase?: KnowledgeBase
  thinkEffort?: "high" | "max"
  hooks?: HookSystem
  autoFinishOnVerifiedWrite?: boolean
  runTrace?: AgentRunTrace
  stableMemoryContext?: string
  autoApprovePlan?: boolean
  /** Optional: model router for sub-purpose model selection (compaction/semantic-recall etc.) */
  modelRouter?: ModelRouter
}

// ── Self-learning error tracker ──

interface ErrorRecord { toolName: string; errorContent: string; count: number }

class ErrorTracker {
  private errors = new Map<string, ErrorRecord>()
  private triggered = new Set<string>()

  record(name: string, content: string): string | null {
    if (!/[ef]ail|[ef]rr|blocked|not found|denied/i.test(content)) return null
    const key = name + ":" + content.slice(0, 80).replace(/[^a-zA-Z0-9一-鿿]/g, "")
    const rec = this.errors.get(key)
    if (rec) {
      rec.count++
      if (rec.count === 2 && !this.triggered.has(key)) {
        this.triggered.add(key)
        return `\n[系统提示] 工具 "${name}" 重复失败。请用 web_search 搜索此错误并学习正确用法:\n  "${content.slice(0, 200)}"\n不要用同样的参数重试。搜索完把解决方案总结存入知识库。\n`
      }
      if (rec.count >= 4 && !this.triggered.has(key + "_skip")) {
        this.triggered.add(key + "_skip")
        return `\n[系统提示] "${name}" 已失败 ${rec.count} 次。放弃当前方案，向用户承认遇到了困难并解释已尝试的方法。\n`
      }
    } else {
      this.errors.set(key, { toolName: name, errorContent: content.slice(0, 200), count: 1 })
    }
    return null
  }
}

const TOOL_TIMEOUT_SLOW = 180_000  // shell, test, build commands — can legitimately be slow
const TOOL_TIMEOUT_DEFAULT = 60_000  // file ops, search, codegraph, etc.

const SLOW_TOOLS = new Set(["shell", "multi_edit", "edit_file", "edit_fim"])

async function withToolTimeout<T>(name: string, work: Promise<T>, timeoutMs?: number): Promise<T> {
  const effectiveTimeout = timeoutMs ?? (SLOW_TOOLS.has(name) ? TOOL_TIMEOUT_SLOW : TOOL_TIMEOUT_DEFAULT)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tool '${name}' timed out after ${effectiveTimeout / 1000}s`)), effectiveTimeout)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function nextProviderEvent(
  iterator: AsyncIterator<StreamEvent>,
  timeoutMs: number,
): Promise<IteratorResult<StreamEvent>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`provider stream idle timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function providerIdleTimeoutMs(): number {
  const raw = Number(process.env.DEEPSEEK_PROVIDER_IDLE_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000
}

function blockedByHookResult(tool: string, reason?: string): ToolResult {
  const message = reason?.trim() || `Tool '${tool}' blocked by runtime hook`
  return { success: false, content: `[blocked] ${message}`, error: message, metadata: { blocked: true, hookBlocked: true } }
}

function normalizeHookResult(result: { success: boolean; content: string }, previous?: ToolResult): ToolResult {
  if (result.success) return { success: true, content: result.content, metadata: previous?.metadata }
  return {
    success: false,
    content: result.content,
    error: result.content,
    metadata: previous?.metadata,
  }
}

async function runToolBeforeHook(
  hooks: HookSystem | undefined,
  tool: string,
  params: Record<string, unknown>,
): Promise<{ blocked?: ToolResult; warnings: string[] }> {
  if (!hooks) return { warnings: [] }
  const output = await hooks.runBefore(tool, params)
  const warnings = output.warn ? [output.warn] : []
  if (output.blocked) return { blocked: blockedByHookResult(tool, output.warn), warnings: [] }
  return { warnings }
}

async function runToolAfterHook(
  hooks: HookSystem | undefined,
  tool: string,
  params: Record<string, unknown>,
  result: ToolResult,
): Promise<{ result: ToolResult; warnings: string[] }> {
  if (!hooks) return { result, warnings: [] }
  const output = await hooks.runAfter(tool, params, { success: result.success, content: result.content })
  const warnings = output.warn ? [output.warn] : []
  return { result: output.result ? normalizeHookResult(output.result, result) : result, warnings }
}

function appendHookWarnings(result: ToolResult, warnings: string[]): ToolResult {
  if (warnings.length === 0) return result
  const content = `${result.content}\n\n[hook warning] ${warnings.join("\n[hook warning] ")}`
  if (result.success) return { ...result, content }
  return { ...result, content, error: result.error }
}

async function executeToolWithHooks(input: {
  hooks?: HookSystem
  tool: ToolDescriptor
  params: Record<string, unknown>
  execute: () => Promise<ToolResult>
}): Promise<ToolResult> {
  const before = await runToolBeforeHook(input.hooks, input.tool.defn.name, input.params)
  if (before.blocked) return appendHookWarnings(before.blocked, before.warnings)

  const rawResult = await input.execute()
  const after = await runToolAfterHook(input.hooks, input.tool.defn.name, input.params, rawResult)
  return appendHookWarnings(after.result, [...before.warnings, ...after.warnings])
}

function buildVolatileContextMessage(ctxText: string, thinkContext: string, knowledgeContext: string): ProviderMessage | null {
  const chunks: string[] = []
  if (ctxText.trim()) chunks.push(`## Loaded Context\n${ctxText.trim()}`)
  if (thinkContext.trim()) chunks.push(`## Similar Thinking Notes\n${thinkContext.trim()}`)
  if (knowledgeContext.trim()) chunks.push(`## Learned Knowledge\n${knowledgeContext.trim()}`)
  if (chunks.length === 0) return null

  return {
    role: "user",
    content: [
      "## Volatile Round Context",
      "Use this as temporary context for the current request. Do not treat it as a new user request.",
      chunks.join("\n\n"),
    ].join("\n\n"),
  }
}

function buildContextBudgetMessage(mode: ContextBudgetMode, percent: number): ProviderMessage | null {
  if (mode !== "degraded") return null
  return {
    role: "user",
    content: [
      "## Context Budget Guard",
      `The current request is using about ${percent}% of the model context window.`,
      "Continue only the current atomic stage. Do not expand scope, do not start broad exploration, and do not introduce new optional work.",
      "If the next step would require a large new search, many new files, or a multi-stage rewrite, stop after the current checkpoint and ask for compaction or a fresh continuation.",
    ].join("\n"),
  }
}

async function collectResearchEvidence(input: {
  tools: ToolDescriptor[]
  queries: string[]
  hooks?: HookSystem
}): Promise<ResearchEvidence[]> {
  const webSearch = input.tools.find(tool => tool.defn.name === "web_search")
  if (!webSearch) {
    return input.queries.slice(0, 3).map(query => ({
      query,
      success: false,
      content: "web_search tool is not available.",
    }))
  }

  const evidence: ResearchEvidence[] = []
  for (const query of input.queries.slice(0, 3)) {
    try {
      const result = await executeToolWithHooks({
        hooks: input.hooks,
        tool: webSearch,
        params: { query },
        execute: () => withToolTimeout("web_search", webSearch.execute({ query }), 12_000),
      })
      evidence.push({ query, success: result.success, content: result.content })
    } catch (e) {
      evidence.push({ query, success: false, content: e instanceof Error ? e.message : String(e) })
    }
  }
  return evidence
}

function stableToolSet(tools: ToolDescriptor[], readonlyOnly: boolean): ToolDescriptor[] {
  return readonlyOnly ? tools.filter(tool => tool.defn.isReadonly) : tools
}

type ContextBudgetMode = "normal" | "degraded" | "block"

function envRatio(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : fallback
}

function contextBudgetMode(currentInputTokens: number, contextMax: number): { mode: ContextBudgetMode; percent: number } {
  const warnRatio = envRatio("DEEPSEEK_CONTEXT_WARN_RATIO", 0.5)
  const blockRatio = envRatio("DEEPSEEK_CONTEXT_BLOCK_RATIO", 0.6)
  const ratio = currentInputTokens / contextMax
  const percent = Math.round(ratio * 100)
  if (ratio >= blockRatio) return { mode: "block", percent }
  if (ratio >= warnRatio) return { mode: "degraded", percent }
  return { mode: "normal", percent }
}

function contextSafeToolSet(tools: ToolDescriptor[], mode: ContextBudgetMode): ToolDescriptor[] {
  // Degraded mode is a soft gate: finish the current atomic stage, but avoid
  // broad new exploration. Hard blocking happens only in "block" mode before
  // the provider is called.
  void mode
  return tools
}

function containsTypecheckFailure(text: string): boolean {
  return /\berror TS\d+|\btypecheck\b.*\b(fail|failed|error)|\[diagnostics\]|\[tsc unavailable\]/i.test(text)
}

function countTypecheckIssues(text: string): number {
  const matches = text.match(/\berror TS\d+/g)
  if (matches?.length) return matches.length
  return containsTypecheckFailure(text) ? 1 : 0
}

function isVerificationUnavailable(text: string): boolean {
  return /\[tsc unavailable\]|not recognized|command not found|failed to spawn/i.test(text)
}

function strongestRippleDecision(reports: RippleReport[], pending: RippleObligation[]): "allow" | "warn" | "block" | undefined {
  if (pending.length > 0) return "warn"
  if (reports.some(report => report.decision === "block")) return "block"
  if (reports.some(report => report.decision === "warn")) return "warn"
  if (reports.length > 0) return "allow"
  return undefined
}

function applyRippleToolFilter(
  tools: ToolDescriptor[],
  reports: RippleReport[],
  pending: RippleObligation[],
): { tools: ToolDescriptor[]; blocked: boolean } {
  const decision = strongestRippleDecision(reports, pending)
  if (decision === "block") {
    return { tools: tools.filter(t => t.defn.isReadonly), blocked: true }
  }
  return { tools, blocked: false }
}

function isRuntimeProjectRoot(cwd = process.cwd()): boolean {
  return existsSync(resolve(cwd, "src/agent/loop.ts")) &&
    existsSync(resolve(cwd, "src/provider/deepseek.ts")) &&
    existsSync(resolve(cwd, "package.json"))
}

function isRuntimeSourceFile(path: string, cwd = process.cwd()): boolean {
  if (!isRuntimeProjectRoot(cwd)) return false
  const normalized = normalizeProjectPath(path)
  return (
    normalized.startsWith("src/agent/") ||
    normalized.startsWith("src/tools/") ||
    normalized.startsWith("src/ui/") ||
    normalized.startsWith("src/provider/") ||
    normalized.startsWith("src/memory/") ||
    normalized.startsWith("src/context/") ||
    normalized.startsWith("src/hooks/") ||
    normalized.startsWith("src/verification/") ||
    normalized.startsWith("tests/")
  )
}

function rootRuntimeVerificationPassed(results: VerificationResult[]): boolean {
  return results.some(result => {
    if (!result.passed || result.kind !== "typecheck") return false
    const command = result.command.replace(/\\/g, "/").toLowerCase()
    return !/\bcd\s+blog\b|\/blog\b|blog\//.test(command)
  })
}

function formatRuntimeSelfEditGate(files: string[]): string {
  return [
    "## Runtime Self-Edit Gate",
    "You changed DeepSeek Code runtime source files in the currently running process.",
    "The current Node process cannot use those source changes until the CLI is restarted.",
    "",
    "Required next step:",
    "1. Run exactly one root project typecheck command, for example: `bun run typecheck` or `npx tsc --noEmit --pretty false` from the deepseek-code root.",
    "2. If it passes, stop and tell the user to restart DeepSeek Code.",
    "3. Do not inspect unrelated files, do not keep debugging the old in-memory behavior, and do not claim the running process has picked up the fix.",
    "",
    "Changed runtime files:",
    ...files.slice(0, 12).map(file => `- ${file}`),
  ].join("\n")
}

function buildAgentContractContext(input: {
  round: number
  priorTools: string[]
  priorFiles: Set<string>
  toolErrors: number
  modifiedFiles: number
}): AgentContext {
  const wrote = input.modifiedFiles > 0 || input.priorTools.some(tool => tool === "write_file" || tool === "edit_file" || tool === "edit_fim" || tool === "multi_edit")
  const currentState = input.toolErrors > 0 ? AgentState.REPAIR : wrote ? AgentState.VERIFY : AgentState.DONE
  return {
    state: currentState,
    roundNum: input.round,
    priorTools: input.priorTools,
    priorFiles: new Set(input.priorFiles),
    errorCount: input.toolErrors,
    consecutiveErrors: input.toolErrors,
    toolResults: new Map(),
  }
}

function formatQualityGatePrompt(input: {
  confidence: ReturnType<ConfidenceEvaluator["evaluateSync"]>
  contractMessages: string[]
  signals: ObjectiveSignals
}): string {
  const lines = [
    "## Runtime Quality Gate",
    "You cannot finish yet. The runtime quality gate found unresolved objective risks.",
    `Confidence recommendation: ${input.confidence.recommendation} (${Math.round(input.confidence.confidence * 100)}%).`,
  ]
  if (input.signals.typecheck && !input.signals.typecheck.passed) {
    lines.push(`Typecheck/diagnostics: failed with ${input.signals.typecheck.issues} issue(s).`)
  }
  if (typeof input.signals.toolErrors === "number" && input.signals.toolErrors > 0) {
    lines.push(`Tool errors this task: ${input.signals.toolErrors}.`)
  }
  if (input.signals.rippleDecision && input.signals.rippleDecision !== "allow") {
    lines.push(`Ripple decision: ${input.signals.rippleDecision}.`)
  }
  for (const message of input.contractMessages.slice(0, 5)) {
    lines.push(`Contract: ${message}`)
  }
  lines.push("")
  lines.push("Required next step: inspect the failing objective signal, repair or verify it with tools, then provide a concise completion only after the gate can pass.")
  return lines.join("\n")
}

function compactAssistantContext(text: string, maxChars = 1200): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const head = lines.slice(0, 8).join("\n")
  const compact = head.length > maxChars ? head.slice(0, maxChars) : head
  return `${compact}\n[assistant output compacted from ${trimmed.length} chars]`
}

function normalizeExplicitFile(path: string): string {
  return normalizeProjectPath(path)
    .replace(/^\.\/+/, "")
    .replace(/[),.;:]+$/g, "")
}

function explicitRequiredFiles(prompt: string): string[] {
  const files = new Set<string>()
  const patterns = [
    /\b(?:add|create|write|include)\b[^.\n\r]{0,120}?\b([A-Za-z0-9_./\\-]+(?:\.test|\.spec)\.(?:ts|tsx|js|jsx|mjs|cjs))\b/gi,
    /(?:添加|创建|新建|写入|编写)[^。\n\r]{0,120}?([A-Za-z0-9_./\\-]+(?:\.test|\.spec)\.(?:ts|tsx|js|jsx|mjs|cjs))/gi,
  ]
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const file = match[1] ? normalizeExplicitFile(match[1]) : ""
      if (file) files.add(file)
    }
  }
  return [...files]
}

function missingExplicitRequiredFiles(prompt: string, modifiedFiles: Set<string>, cwd = process.cwd()): string[] {
  return explicitRequiredFiles(prompt).filter(file => {
    if (modifiedFiles.has(file)) return false
    return !existsSync(resolve(cwd, file))
  })
}

export async function* agentLoop(
  prompt: string,
  options: AgentOptions,
): AsyncGenerator<StreamEvent> {
  const { provider, model, tools, maxRounds = 50, stagedContext, hooks } = options
  const effectivePrompt = buildEffectivePrompt(prompt, options.conversationHistory)

  const rawMessages: ProviderMessage[] = []

  if (options.conversationHistory?.length) {
    for (const h of options.conversationHistory.slice(-24)) {
      rawMessages.push({ role: h.role, content: h.content })
    }
  }

  rawMessages.push({ role: "user", content: prompt })

  const state = createState()
  const cacheTracker = new CacheTracker()
  const errorTracker = new ErrorTracker()
  const contextKernel = buildContextKernel(process.cwd())

  // ── Flash Triage: semantic task classification (replaces 4 keyword classifiers) ──
  const flashTriagePolicy = resolveFlashTriagePolicy()
  const flashTriageEnabled = shouldUseFlashTriage(flashTriagePolicy, effectivePrompt, contextKernel.text)
  const flashTriage = flashTriageEnabled ? new FlashTriage(provider) : null
  const triageResult = flashTriage ? await flashTriage.triage(effectivePrompt, contextKernel.text) : null
  let intentPolicy: ReturnType<typeof classifyIntent>
  let taskTracker: ReturnType<typeof createTaskTracker> = null
  let researchContext: ProviderMessage | null = null
  let researchEvidence: ResearchEvidence[] = []
  let triageSkillPrompts: string[] = []

  if (triageResult) {
    // Flash succeeded — use semantic classification
    intentPolicy = { mode: triageModeToIntent(triageResult.mode), reason: `Flash triage: ${triageResult.reasoning}` }
    const trackerDef = buildTrackerFromTriage(triageResult, effectivePrompt)
    if (trackerDef) {
      taskTracker = { ...trackerDef, verificationEvidence: {}, verification: trackerDef.requiredVerificationKinds.map(k => k === "typecheck" ? "运行类型检查" : k === "test" ? "运行测试" : k === "build" ? "运行构建" : "运行验证"), requiredFiles: trackerDef.requiredFiles, requiredVerificationKinds: trackerDef.requiredVerificationKinds, steps: trackerDef.steps }
    }
    triageSkillPrompts = activateSkillsByNames(triageResult.relevantSkillNames)
  } else {
    // Flash unavailable — fallback to keyword classifiers (current behavior)
    intentPolicy = classifyIntent(effectivePrompt)
    taskTracker = createTaskTracker(effectivePrompt, intentPolicy.mode)
    triageSkillPrompts = activateSkillsByNames(activateSkillNamesByKeywords(effectivePrompt))
  }

  const researchDecision = triageResult?.needsWeb && triageResult.researchQueries.length > 0
    ? {
        mode: "research_answer" as const,
        confidence: 0.85,
        needWeb: true,
        reason: `Flash triage: ${triageResult.reasoning}`,
        researchQuestions: triageResult.researchQueries,
      }
    : classifyResearchRoute({ prompt: effectivePrompt, intentMode: intentPolicy.mode })
  const experienceContext = buildExperienceKernelContext({ prompt: effectivePrompt, intentMode: intentPolicy.mode })
  let announcedKernel = false
  let webSearchFailedThisTurn = false
  let webSearchFailReason = ""
  let announcedContextDegraded = false
  let pendingRippleObligations: RippleObligation[] = []
  const cacheStableTools = process.env.DEEPSEEK_CACHE_STABLE_TOOLS !== "0"
  const confidenceEvaluator = new ConfidenceEvaluator()
  const flashJudge = new FlashJudge(provider)
  const testimonyLedger = new TestimonyLedger()
  const permissionGate = new PermissionGate()
  // Load user + project permission configs (gracefully)
  const userCfg = loadUserConfig()
  const projectCfg = loadProjectConfig(process.cwd())
  permissionGate.loadRules(userCfg?.rules ?? [], projectCfg?.rules ?? [])
  // Sandbox init — shared Job Object for all shell commands in this agent run
  const sandbox = new SandboxManager({
    projectRoot: process.cwd(),
    maxRuntimeSec: Number(process.env.DEEPSEEK_SANDBOX_TIMEOUT_SEC) || 30,
    jobMemoryLimitMb: process.env.DEEPSEEK_SANDBOX_MEMORY_MB ? Number(process.env.DEEPSEEK_SANDBOX_MEMORY_MB) : 512,
  })
  setShellSandbox(sandbox)
  const pmode: "full" | "strict" = process.env.DEEPSEEK_PERMISSION_MODE === "strict" ? "strict" : "full"
  const toolLedger = new ToolExecutionLedger()
  let rippleBlockActive = false
  const gateBlockCounts = new Map<string, { count: number; lastSeen: number }>()
  const deferredGateMessages: string[] = []
  let thinkingTokenTotal = 0
  let microcompactCount = 0
  let rateLimitShell = 0
  let rateLimitFile = 0
  let rateLimitNetwork = 0
  let planApproved = false
  let taskHadWrite = false
  let taskToolErrors = 0
  let taskModifiedFiles = 0
  let consecutiveErrors = 0
  let requestedMaxThinking = false
  let lastKernelHash = ""
  let thinkingCompacted = false
  let frozenStablePrefix: ProviderMessage | null = null
  let stablePrefixHash = ""
  let lastTypecheck: { passed: boolean; issues: number; output?: string } | undefined
  let lastRippleReports: RippleReport[] = []
  let lastToolNames: string[] = []
  let lastVerificationResults: VerificationResult[] = []
  let runtimeSelfEditFiles = new Set<string>()
  const taskFiles = new Set<string>()
  options.runTrace?.record("agent_loop_started", { maxRounds, toolCount: tools.length })

  // ── State machine — validates transitions, secondary to ad-hoc flags ──
  const sm = new StateMachine()
  sm.transition(AgentState.UNDERSTAND, "agent loop started")

  const clarification = evaluateClarificationNeed({
    prompt: effectivePrompt,
    tracker: taskTracker,
    history: options.conversationHistory,
  })
  if (clarification.required) {
    yield { type: "status", data: "clarification-gate: thinking before planning" }
    let modelText = ""
    let modelFailed = !taskTracker
    let modelInputTokens = 0
    if (taskTracker) {
      const clarificationCall = buildModelClarificationCall({
        provider,
        model,
        prompt: effectivePrompt,
        tracker: taskTracker,
        result: clarification,
      })
      modelInputTokens = Math.max(1, Math.round((clarificationCall.system.length + JSON.stringify(clarificationCall.messages).length) / 3))
      try {
        for await (const event of provider.streamChat(clarificationCall)) {
          if (event.type === "text") {
            const chunk = String(event.data ?? "")
            modelText += chunk
            yield {
              type: "token_usage",
              data: {
                inputTokens: modelInputTokens,
                outputTokens: Math.max(1, Math.round(modelText.length / 3)),
                contextMax: 1_048_576,
                cacheSource: "estimate",
              },
            }
          } else if (event.type === "status" || event.type === "error" || event.type === "token_usage") {
            yield event
          }
        }
      } catch {
        modelFailed = true
      }
    }

    const structuredClarification = !modelFailed
      ? parseModelClarification(modelText, clarification.originalPrompt ?? effectivePrompt)
      : null
    if (structuredClarification) {
      yield { type: "clarification_ready", data: structuredClarification }
    } else {
      yield { type: "error", data: formatModelClarificationFailure() }
    }
    options.runTrace?.record("gate_decision", {
      gate: "clarification",
      decision: "ask",
      reason: clarification.reason,
      source: structuredClarification ? "model_structured" : "model_failed",
    })
    return
  }

  if (shouldRunResearch(researchDecision)) {
    yield { type: "status", data: `research-router: ${researchDecision.reason}` }
    options.runTrace?.record("gate_decision", {
      gate: "research_router",
      decision: "research_answer",
      reason: researchDecision.reason,
      questions: researchDecision.researchQuestions,
    })
    researchEvidence = await collectResearchEvidence({
      tools,
      queries: researchDecision.researchQuestions,
      hooks,
    })
    const successCount = researchEvidence.filter(item => item.success).length
    yield { type: "status", data: `research-router: evidence ${successCount}/${researchEvidence.length}` }
    researchContext = successCount > 0
      ? buildResearchEvidenceContext(researchDecision, researchEvidence)
      : { role: "user", content: buildResearchInsufficientEvidenceMessage(researchDecision, researchEvidence) }
  } else if (researchDecision.mode === "deep_discussion") {
    options.runTrace?.record("gate_decision", {
      gate: "research_router",
      decision: "deep_discussion",
      reason: researchDecision.reason,
      needWeb: researchDecision.needWeb,
    })
  }

  const usage: UsageStats = { apiCalls: 0, estimatedInputTokens: 0, cacheHits: 0, cacheMisses: 0, flashRounds: 0, proRounds: 0, flashUsed: false }
  if (options.conversationHistory) { ;(options as unknown as Record<string, unknown>)._usage = usage }

  // Cumulative context tracking (DeepSeek V4: 1M context window)
  let contextInputTotal = 0
  let contextOutputTotal = 0
  const CONTEXT_MAX = 1_048_576

  for (let round = 0; round < maxRounds; round++) {
    options.runTrace?.record("round_started", { round })
    // ── Plan approval detection: check for synthetic plan messages from CLI ──
    const lastMsg = rawMessages.length > 0 ? rawMessages[rawMessages.length - 1] : null
    if (lastMsg?.role === "user" && typeof lastMsg.content === "string") {
      if (lastMsg.content.startsWith("[PLAN_APPROVED]")) {
        planApproved = true
      } else if (lastMsg.content.startsWith("[PLAN_REVISE]")) {
        planApproved = false
        // Revision feedback stays in rawMessages; loop re-evaluates the plan
      }
    }
    const thinkingDecision = decideThinkingPlan(state, requestedMaxThinking ? "max" : options.thinkEffort, {
      prompt: effectivePrompt,
      intentMode: intentPolicy.mode,
      planningPhase: taskTracker?.phase === "planning",
      autoMaxSignals: { consecutiveErrors, modifiedFiles: taskModifiedFiles },
    })
    const thinking = thinkingDecision.thinking
    const maxTok = thinkingDecision.maxTokens
    options.runTrace?.record("thinking_decision", { round, ...thinkingDecision })

    // Project context
    let ctxText = ""
    if (stagedContext && (stagedContext.loadedFiles.size > 0 || state.roundNum > 0)) {
      ctxText = stagedContext.buildContext().toPromptText()
    }

    // Thinking store
    let thinkContext = ""
    if (options.thinkingStore && state.roundNum > 0) {
      thinkContext = options.thinkingStore.formatForPrompt(options.thinkingStore.findSimilar(prompt))
    }

    // Knowledge base
    let knowledgeContext = ""
    if (options.knowledgeBase && state.roundNum > 1) {
      const hits = options.knowledgeBase.findRelevant(prompt)
      if (hits.length > 0) {
        knowledgeContext = "\n## 已学知识\n" + hits.map(e =>
          `问题: ${e.problem}\n方案: ${e.solution}`
        ).join("\n\n") + "\n"
      }
    }

    const system = buildSystemPrompt()
    // ── Frozen stable prefix: computed once on round 0, reused across all rounds ──
    if (!frozenStablePrefix) {
      const stablePrefixParts: string[] = []
      if (options.stableMemoryContext?.trim()) stablePrefixParts.push(`## Stable Cold Memory\n${options.stableMemoryContext.trim()}`)
      if (experienceContext) stablePrefixParts.push(experienceContext)
      if (contextKernel.text) stablePrefixParts.push(`## Project Context Kernel\n${contextKernel.text}`)
      if (triageSkillPrompts.length) stablePrefixParts.push(triageSkillPrompts.join("\n\n"))
      frozenStablePrefix = stablePrefixParts.length > 0
        ? { role: "user", content: ["## Stable Prefix Context\n[CACHE_ANCHOR:v3]", stablePrefixParts.join("\n\n")].join("\n\n") }
        : null
    }
    const stablePrefixContext = frozenStablePrefix
    const volatileContext = buildVolatileContextMessage(ctxText, thinkContext, knowledgeContext)
    const taskPlanning = taskTracker?.phase === "planning"
    const planningContext: ProviderMessage | null = taskPlanning && taskTracker
      ? { role: "user", content: formatTaskPlanningPrompt(taskTracker, round) }
      : null
    // ── Context messages: all go BEFORE rawMessages ──
    // Anthropic API requires tool_use→tool_result adjacency. Any user
    // message inserted between an assistant(tool_use) and user(tool_result)
    // is a 400 error. So volatile/planning/budget context must precede
    // rawMessages, never follow it.
    const contextMessages: ProviderMessage[] = [
      ...(stablePrefixContext ? [stablePrefixContext] : []),
      ...(researchContext ? [researchContext] : []),
      ...(volatileContext ? [volatileContext] : []),
      ...(planningContext ? [planningContext] : []),
    ]
    if (!announcedKernel) {
      announcedKernel = true
      yield { type: "status", data: `context-kernel: ${contextKernel.hash} (~${contextKernel.estimatedTokens} tokens)` }
    }

    // Use session model for all rounds — model switching breaks prefix cache
    const modelName = model
    usage.proRounds++
    options.runTrace?.record("model_selected", {
      round,
      requestedModel: modelName,
      route: "configured_model",
      thinkingEnabled: Boolean(thinking),
      maxTokens: maxTok,
    })

    usage.apiCalls++
    let roundInputTokens = Math.round((system.length + contextMessages.reduce((s, m) => s + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0) + rawMessages.reduce((s, m) => s + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0)) / 3)
    const contextBudget = contextBudgetMode(roundInputTokens, CONTEXT_MAX)
    setRuntimeContextBudgetMode(contextBudget.mode)
    const budgetContext = buildContextBudgetMessage(contextBudget.mode, contextBudget.percent)
    if (budgetContext) contextMessages.push(budgetContext)
    const providerMessages = [
      ...contextMessages,
      ...rawMessages,
    ]
    if (budgetContext) {
      roundInputTokens = Math.round((system.length + providerMessages.reduce((s, m) => s + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0)) / 3)
    }
    const estimatedRoundInputTokens = roundInputTokens
    usage.estimatedInputTokens += roundInputTokens
    contextInputTotal += roundInputTokens

    if (contextBudget.mode === "block") {
      yield { type: "status", data: `context-budget: block ${contextBudget.percent}%` }
      options.runTrace?.record("gate_decision", { gate: "context_budget", decision: "block", percent: contextBudget.percent })
      yield { type: "text", data: `Context budget exceeded (${contextBudget.percent}%). Compact or start a fresh continuation before more tool use.` }
      break
    }
    if (contextBudget.mode === "degraded" && !announcedContextDegraded) {
      announcedContextDegraded = true
      yield { type: "status", data: `context-budget: degraded ${contextBudget.percent}%; finish current stage only` }
    }

    // Dynamic tool disclosure: filter tools by conversation context
    const contextText = providerMessages.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n").slice(-4000) + "\n" + system
    const { selected, tokensSaved } = selectTools(tools, contextText, round)
    const planOnlyRound = Boolean(taskPlanning && round > 0)
    const rippleFilter = applyRippleToolFilter(
      intentPolicy.mode === "readonly" || taskPlanning
        ? selected.filter(tool => tool.defn.isReadonly)
        : selected,
      lastRippleReports,
      pendingRippleObligations,
    )
    rippleBlockActive = rippleFilter.blocked
    if (rippleBlockActive) {
      for (const report of lastRippleReports) sandbox.blockFileWrite(report.targetFile)
    }
    const activeTools = planOnlyRound
      ? []
      : cacheStableTools
      ? stableToolSet(tools, intentPolicy.mode === "readonly" || taskPlanning || rippleBlockActive)
      : rippleFilter.tools
    if (!cacheStableTools && tokensSaved > 0) {
      yield { type: "status", data: `tools: ${activeTools.length}/${tools.length} (↓${tokensSaved} tokens)` }
    }
    if (round === 0 && intentPolicy.mode === "readonly") {
      yield { type: "status", data: `intent-gate: readonly (${intentPolicy.reason})` }
    }
    if (round === 0 && taskTracker) {
      yield { type: "status", data: "任务追踪: 已识别为长任务，先规划再执行" }
    }
    if (taskTracker) {
      const status = formatTaskTrackerStatus(taskTracker)
      if (status) yield { type: "status", data: status }
      yield { type: "task_progress", data: snapshotTaskTracker(taskTracker) }
    }
    if (planOnlyRound) {
      yield { type: "status", data: "任务追踪: 规划阶段只输出计划" }
    }
    if (rippleBlockActive) {
      yield { type: "status", data: `涟漪阻止: 写工具已禁用 (${pendingRippleObligations.length} 个调用方未更新)` }
      options.runTrace?.record("gate_decision", { gate: "ripple_block", decision: "block", pending: pendingRippleObligations.length })
    }
    const budgetedTools = contextSafeToolSet(activeTools, contextBudget.mode)
    const toolSchemas = budgetedTools.map(t => t.toAnthropicSchema())
    const providerToolSchemas = toolSchemas.slice(0, 128)
    const cacheAnatomy = buildCacheAnatomy({ system, tools: providerToolSchemas, messages: providerMessages, thinkingTokens: thinkingTokenTotal, contextMax: CONTEXT_MAX })
    const cacheShape = cacheTracker.checkPrefixShape([
      { kind: "model", value: modelName },
      { kind: "system", value: system },
      { kind: "tools", value: providerToolSchemas },
      { kind: "messages", value: providerMessages },
    ])
    const cacheStatus = cacheShape.status
    if (cacheStatus === "hit") { usage.cacheHits++ } else { usage.cacheMisses++ }
    options.runTrace?.record("cache_prefix_shape", {
      round,
      cacheStatus,
      prefixHash: cacheShape.prefixHash,
      firstChangedSection: cacheShape.firstChangedSection,
      sections: cacheShape.sections,
    })
    const estimatedUsageEvent = { requestedModel: modelName, inputTokens: contextInputTotal, outputTokens: contextOutputTotal, contextMax: CONTEXT_MAX, round, cacheHitRate: cacheShape.hitRate, cacheStatus, cacheSource: "estimate", cachePrefixShape: { firstChangedSection: cacheShape.firstChangedSection, sections: cacheShape.sections }, contextUsagePercent: contextBudget.percent, cacheAnatomy }
    options.runTrace?.record("token_usage", estimatedUsageEvent)
    yield { type: "token_usage", data: estimatedUsageEvent }
    yield { type: "status", data: thinking ? thinkingDecision.visibleStatus : "working" }

    const textChunks: string[] = []
    const completedToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
    let thinkingBlocks: Array<{ thinking: string; signature: string }> = []
    let streamError = ""
    const roundStart = Date.now()
    let bufferedTextEmitted = false
    const shouldBufferCompletionText = taskTracker?.phase === "building" || taskTracker?.phase === "complete" || taskHadWrite || taskToolErrors > 0
    const bufferReadonlyText = intentPolicy.mode === "readonly" || shouldBufferCompletionText
    let providerUsage: ProviderTokenUsage | null = null

    try {
      const providerIterator = provider.streamChat({ model: modelName, purpose: "agent_main", system, messages: providerMessages, tools: providerToolSchemas, thinking, maxTokens: maxTok })[Symbol.asyncIterator]()
      while (true) {
        const next = await nextProviderEvent(providerIterator, providerIdleTimeoutMs())
        if (next.done) break
        const event = next.value
        if (event.type === "text" && event.data) {
          textChunks.push(String(event.data))
          if (!bufferReadonlyText) yield event
        }
        else if (event.type === "thinking_blocks" && event.data) { thinkingBlocks = event.data as typeof thinkingBlocks }
        else if (event.type === "token_usage" && event.data) {
          providerUsage = mergeProviderTokenUsage(providerUsage, event.data as ProviderTokenUsage)
        }
        else if (event.type === "status") {
          options.runTrace?.record("provider_status", { round, status: event.data })
          yield event
        }
        else if (event.type === "tool_call" && event.data) {
          if (bufferReadonlyText && !bufferedTextEmitted && textChunks.length > 0) {
            yield { type: "text", data: textChunks.join("") }
            bufferedTextEmitted = true
          }
          completedToolCalls.push(event.data as typeof completedToolCalls[0]); yield event
        }
        else if (event.type === "error") { streamError = String(event.data ?? ""); yield event }
      }
    } catch (e) {
      streamError = e instanceof Error ? e.message : String(e)
      yield { type: "error", data: streamError }
    }

    const roundMs = Date.now() - roundStart

    const finalText = textChunks.join("")
    const providerRoundInputTokens = providerUsage
      ? (providerUsage.cacheReadInputTokens ?? 0) + (providerUsage.cacheMissInputTokens ?? providerUsage.inputTokens ?? 0)
      : undefined
    if (typeof providerRoundInputTokens === "number" && providerRoundInputTokens > 0) {
      contextInputTotal += providerRoundInputTokens - estimatedRoundInputTokens
    }

    const estimatedOutputTokens = Math.round(finalText.length / 3 + completedToolCalls.reduce((s, tc) => s + JSON.stringify(tc.input).length / 3, 0))
    contextOutputTotal += providerUsage?.outputTokens ?? estimatedOutputTokens
    const displayedCacheHitRate = providerUsage?.cacheHitRate ?? cacheTracker.hitRate
    const finalUsageEvent = {
        requestedModel: modelName,
        actualModel: providerUsage?.actualModel,
        inputTokens: contextInputTotal,
        outputTokens: contextOutputTotal,
        contextMax: CONTEXT_MAX,
        round,
        roundMs,
        cacheHitRate: displayedCacheHitRate,
        cacheStatus,
        cacheSource: providerUsage ? "provider" : "estimate",
        cacheReadInputTokens: providerUsage?.cacheReadInputTokens,
        cacheMissInputTokens: providerUsage?.cacheMissInputTokens,
        cacheCreationInputTokens: providerUsage?.cacheCreationInputTokens,
        cachePrefixShape: { firstChangedSection: cacheShape.firstChangedSection, sections: cacheShape.sections },
        contextUsagePercent: contextBudget.percent,
        cacheAnatomy,
    }
    options.runTrace?.record("token_usage", finalUsageEvent)
    yield {
      type: "token_usage",
      data: finalUsageEvent,
    }

    if (streamError) {
      if (taskTracker) {
        const missingAfterStreamFailure = missingTaskRequirements(taskTracker)
        if (round + 1 < maxRounds) {
          if (finalText.trim()) rawMessages.push({ role: "assistant", content: compactAssistantContext(finalText) })
          rawMessages.push({ role: "user", content: formatProviderStreamRecoveryPrompt({
            error: streamError,
            missing: missingAfterStreamFailure,
          }) })
          yield { type: "status", data: "provider-stream-gate: retrying unfinished long task" }
          options.runTrace?.record("gate_decision", {
            gate: "provider_stream",
            decision: "continue",
            error: streamError,
            missing: missingAfterStreamFailure,
          })
          continue
        }
        yield { type: "status", data: "provider-stream-gate: blocked unfinished long task" }
        yield { type: "text", data: formatProviderStreamBlockedReport({
          error: streamError,
          missing: missingAfterStreamFailure,
          changedFiles: [...taskFiles],
        }) }
        options.runTrace?.record("gate_decision", {
          gate: "provider_stream",
          decision: "blocked",
          error: streamError,
          missing: missingAfterStreamFailure,
        })
        break
      }

      if (round + 1 < maxRounds) {
        if (finalText.trim()) rawMessages.push({ role: "assistant", content: compactAssistantContext(finalText) })
        rawMessages.push({ role: "user", content: formatGenericProviderStreamRecoveryPrompt({ error: streamError }) })
        yield { type: "status", data: "provider-stream-gate: retrying interrupted round" }
        options.runTrace?.record("gate_decision", {
          gate: "provider_stream",
          decision: "continue",
          error: streamError,
        })
        continue
      }

      yield { type: "status", data: "provider-stream-gate: blocked interrupted round" }
      yield { type: "text", data: formatGenericProviderStreamBlockedReport({ error: streamError }) }
      options.runTrace?.record("gate_decision", {
        gate: "provider_stream",
        decision: "blocked",
        error: streamError,
      })
      break
    }

    if (completedToolCalls.length === 0 && finalText) {
      // Flash Judge handles semantic completion evaluation.
      // No regex-based output/evidence gates — model + judge cover this.

      if (intentPolicy.mode !== "readonly" && pendingRippleObligations.length > 0 && round + 1 < maxRounds) {
        rawMessages.push({ role: "assistant", content: compactAssistantContext(finalText) })
        rawMessages.push({ role: "user", content: formatRippleExitGateCallers(pendingRippleObligations.map(o => ({ caller: o.caller, symbol: o.symbol }))) })
        yield { type: "status", data: `ripple-exit-gate: pending ${pendingRippleObligations.length}` }
        continue
      }

      if (taskTracker && taskTracker.phase === "planning" && round + 1 < maxRounds) {
        const planningGate = evaluatePlanningArtifact(finalText, taskTracker)
        rawMessages.push({ role: "assistant", content: compactAssistantContext(finalText) })
        if (!planningGate.ok) {
          rawMessages.push({ role: "user", content: formatPlanningGatePrompt(planningGate, taskTracker) })
          yield { type: "status", data: `planning-gate: revise plan (${planningGate.missing.length} missing)` }
          options.runTrace?.record("gate_decision", {
            gate: "planning",
            decision: "revise",
            missing: planningGate.missing,
            score: planningGate.score,
          })
          continue
        }
        // Plan passed evaluation but needs user approval
        if (!planApproved && !options.autoApprovePlan) {
          yield {
            type: "plan_ready",
            data: {
              planText: finalText.slice(0, 3000),
              score: planningGate.score,
              signals: planningGate.signals,
              goal: taskTracker.goal,
              steps: taskTracker.steps.map(s => ({ id: s.id, title: s.title })),
              requiredFiles: taskTracker.requiredFiles,
              requiredVerificationKinds: taskTracker.requiredVerificationKinds,
              missingItems: planningGate.missing,
            },
          }
          yield { type: "status", data: "plan-mode: awaiting user approval" }
          break  // stop generator; CLI re-invokes agentLoop with approval/revision
        }
        markPlanAccepted(taskTracker)
        rawMessages.push({ role: "user", content: formatTaskTrackerPrompt(taskTracker) })
        yield { type: "status", data: "任务追踪: 规划完成，进入执行阶段" }
        planApproved = false  // reset for any future replanning
        options.runTrace?.record("gate_decision", {
          gate: "planning",
          decision: "accepted",
          score: planningGate.score,
          signals: planningGate.signals,
        })
        continue
      }

      const missingLongTask = missingTaskRequirements(taskTracker)
      if (taskTracker && !taskTrackerComplete(taskTracker) && missingLongTask.length > 0 && round + 1 < maxRounds) {
        rawMessages.push({ role: "assistant", content: compactAssistantContext(finalText) })
        rawMessages.push({ role: "user", content: [
          "## 任务追踪未完成",
          "你现在不能结束。下面这些项目仍然没有完成：",
          ...missingLongTask.slice(0, 12).map(item => `- ${item}`),
          "",
          "请继续执行第一个未完成项。不要输出最终总结，除非清单全部完成并完成验证。",
        ].join("\n") })
        yield { type: "status", data: `任务追踪: 仍有 ${missingLongTask.length} 项未完成，继续执行` }
        continue
      }

      if (intentPolicy.mode !== "readonly" && (taskHadWrite || taskToolErrors > 0)) {
        const rippleDecision = strongestRippleDecision(lastRippleReports, pendingRippleObligations)
        const latestTest = [...lastVerificationResults].reverse().find(result => result.kind === "test")
        const signals: ObjectiveSignals = {
          testResults: latestTest ? {
            passed: latestTest.passed ? 1 : 0,
            failed: latestTest.passed ? 0 : Math.max(1, latestTest.issues),
            total: latestTest.passed ? 1 : Math.max(1, latestTest.issues),
            output: latestTest.summary,
          } : undefined,
          typecheck: lastTypecheck,
          rippleDecision,
          toolErrors: taskToolErrors,
          filesChanged: taskModifiedFiles,
        }
        const confidence = confidenceEvaluator.evaluateSync(signals)
        const contractResult = validateContracts(buildAgentContractContext({
          round,
          priorTools: lastToolNames,
          priorFiles: taskFiles,
          toolErrors: taskToolErrors,
          modifiedFiles: taskModifiedFiles,
        }), AgentState.DONE)
        const contractMessages = contractResult.violations.map(violation => violation.message)
        const shouldContinueForQuality =
          round + 1 < maxRounds &&
          (
            confidence.recommendation === "retry" ||
            contractResult.fatal.length > 0 ||
            Boolean(lastTypecheck && !lastTypecheck.passed)
          )
        if (shouldContinueForQuality) {
          rawMessages.push({ role: "assistant", content: compactAssistantContext(finalText) })
          rawMessages.push({ role: "user", content: formatQualityGatePrompt({ confidence, contractMessages, signals }) })
          yield { type: "status", data: `quality-gate: ${confidence.recommendation} ${Math.round(confidence.confidence * 100)}%` }
          continue
        }
      }

      if (needsExternalCompletionGate({ taskTracker, taskHadWrite, toolErrors: taskToolErrors })) {
        const completionReport = evaluateCompletionGate({
          finalText,
          taskTracker,
          missingTaskRequirements: missingLongTask,
          pendingRippleObligations,
          verificationResults: lastVerificationResults,
          changedFiles: [...taskFiles],
          taskHadWrite,
          toolErrors: taskToolErrors,
          lastTypecheck,
        })
        if (!completionReport.allowed && round + 1 < maxRounds) {
          rawMessages.push({ role: "assistant", content: compactAssistantContext(finalText) })
          rawMessages.push({ role: "user", content: formatCompletionGatePrompt(completionReport) })
          yield { type: "status", data: `external-completion-gate: blocked (${completionReport.missing.length} missing)` }
          options.runTrace?.record("gate_decision", { gate: "external_completion", decision: "continue", missing: completionReport.missing })
          continue
        }
        if (!completionReport.allowed) {
          yield { type: "status", data: `external-completion-gate: blocked (${completionReport.missing.length} missing)` }
          yield { type: "text", data: formatBlockedCompletion(completionReport) }
          options.runTrace?.record("gate_decision", { gate: "external_completion", decision: "blocked", missing: completionReport.missing })
          break
        }
        yield { type: "status", data: "external-completion-gate: evidence accepted" }
        yield { type: "text", data: formatCompletionEvidenceReport(finalText, completionReport) }
        options.runTrace?.record("gate_decision", { gate: "external_completion", decision: "accepted", evidence: completionReport.evidenceLines })

        // ── Flash Judge: independent model completion verification ──
        if (flashJudge.shouldEvaluate({ taskTracker, taskHadWrite, toolErrors: taskToolErrors, round })) {
          yield { type: "status", data: "flash-judge: evaluating completion..." }
          const judgeResult = await flashJudge.evaluate({
            finalText,
            taskTracker,
            missingTaskRequirements: missingLongTask,
            pendingRippleObligations,
            verificationResults: lastVerificationResults,
            changedFiles: [...taskFiles],
            taskHadWrite,
            toolErrors: taskToolErrors,
            round,
            recentTurns: collectRecentTurns(rawMessages, 6),
            testimonyLedger,
          })
          // Record testimony: what evidence the judge found vs what the agent promised
          const promisedThisRound = extractPromises(finalText)
          testimonyLedger.record(round, promisedThisRound, judgeResult.evidenceFound)
          if (judgeResult.verdict === "SATISFIED") {
            yield { type: "status", data: `flash-judge: ${judgeResult.evidenceFound.length} evidence items confirmed` }
            break
          }
          if (judgeResult.verdict === "IMPOSSIBLE") {
            yield { type: "text", data: FlashJudge.formatImpossiblePrompt(judgeResult.gaps) }
            break
          }
          // NOT_SATISFIED — push gaps and continue
          rawMessages.push({ role: "assistant", content: compactAssistantContext(finalText) })
          rawMessages.push({ role: "user", content: FlashJudge.formatUnsatisfiedPrompt(judgeResult.gaps) })
          yield { type: "status", data: `flash-judge: not satisfied (${judgeResult.gaps.length} gaps)` }
          options.runTrace?.record("gate_decision", { gate: "flash_judge", decision: "continue", gaps: judgeResult.gaps })
          continue
        }
        break
      }

      if (bufferReadonlyText && !bufferedTextEmitted) {
        yield { type: "text", data: finalText }
      }
      break
    }
    if (completedToolCalls.length === 0) {
      yield { type: "status", data: "empty-round: no tool calls or final text" }
      break
    }

    const assistantContent: Array<Record<string, unknown>> = []
    for (const tb of thinkingBlocks) assistantContent.push({ type: "thinking", thinking: tb.thinking, signature: tb.signature })
    if (finalText) assistantContent.push({ type: "text", text: finalText })
    for (const tc of completedToolCalls) assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input })
    rawMessages.push({ role: "assistant", content: assistantContent })

    // ── Persist thinking chain ──
    if (options.thinkingStore && thinkingBlocks.length > 0) {
      thinkingTokenTotal += thinkingBlocks.reduce((sum, tb) => sum + Math.round(tb.thinking.length / 3), 0)
      options.thinkingStore.storeThinking({
        query: effectivePrompt,
        thinkingBlocks,
        roundNum: round,
        filePattern: [...taskFiles].join(","),
        tags: [
          ...(state.hadError ? ["error"] : []),
          intentPolicy.mode,
          `round-${round}`,
        ],
        toolContext: completedToolCalls.map(tc => tc.name),
      })
    }

    // ── Execute tools + self-learn tracking ──
    const toolNames: string[] = []
    const filePaths: string[] = []
    const resultsContent: Array<Record<string, unknown>> = []
    const learnPrompts: string[] = []
    const modifiedFilesThisRound = new Set<string>()
    const rippleReportsThisRound: RippleReport[] = []
    const verificationResultsThisRound: VerificationResult[] = []
    let roundHadToolError = false
    let completionGateText = ""
    let verificationPassedThisRound = false
    let serviceTestGuidanceNeeded = false
    rateLimitShell = 0; rateLimitFile = 0; rateLimitNetwork = 0

    const parallelReadonly = completedToolCalls.length > 1 && completedToolCalls.every(tc => {
      const tool = tools.find(t => t.defn.name === tc.name)
      return Boolean(tc.name !== "web_search" && tool && tool.defn.isReadonly && !tool.executeStream && (tool.defn.isConcurrencySafe ?? true))
    })
    const parallelResults = new Map<string, { content: string; success: boolean; metadata?: Record<string, unknown>; startedAt: number }>()
    if (parallelReadonly) {
      yield { type: "status", data: `greedy-tools: ${completedToolCalls.length} readonly calls` }
      const results = await Promise.all(completedToolCalls.map(async tc => {
        const tool = tools.find(t => t.defn.name === tc.name)!
        const startedAt = Date.now()
        try {
          const result = await executeToolWithHooks({
            hooks,
            tool,
            params: tc.input,
            execute: () => withToolTimeout(tc.name, tool.execute(tc.input)),
          })
          return { id: tc.id, content: result.content, success: result.success, metadata: result.metadata, startedAt }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          return { id: tc.id, content: message, success: false, metadata: undefined, startedAt }
        }
      }))
      for (const result of results) parallelResults.set(result.id, result)
    }

    for (const tc of completedToolCalls) {
      toolNames.push(tc.name)
      options.runTrace?.record("tool_call", { round, id: tc.id, tool: tc.name, input: tc.input })
      const tool = tools.find(t => t.defn.name === tc.name)
      let resultContent = "Unknown tool"
      let resultObj: { success: boolean; content: string; metadata?: Record<string, unknown> } = { success: false, content: "" }
      let toolStartedAt = Date.now()

      // ── Rate limit: per-round caps on high-frequency tools ──
      const cat: ToolCategory = inferToolCategory(tc.name, tool)
      const rateCaps: Partial<Record<ToolCategory, { count: number; max: number }>> = {
        shell: { count: rateLimitShell, max: 5 },
        file: { count: rateLimitFile, max: 10 },
        network: { count: rateLimitNetwork, max: 3 },
      }
      const cap = rateCaps[cat]
      if (cap && cap.count >= cap.max) {
        resultContent = `频率限制：本回合 ${cat} 工具已达上限 (${cap.count}/${cap.max})。请在下一回合继续。`
        resultObj = { success: false, content: resultContent }
        resultsContent.push({ type: "tool_result", tool_use_id: tc.id, content: resultContent.slice(0, 4000) })
        if (cat === "shell") rateLimitShell++; else if (cat === "file") rateLimitFile++; else if (cat === "network") rateLimitNetwork++
        continue
      }
      if (cat === "shell") rateLimitShell++; else if (cat === "file") rateLimitFile++; else if (cat === "network") rateLimitNetwork++

      // ── PermissionGate: deny always hard-blocks; ask may be auto-allowed in full mode ──
      if (tool) {
        const perm = permissionGate.check(tc.name, tc.input, tool)
        if (!perm.allowed) {
          // deny: hard block always. ask: block unless full mode.
          const isFullModeAsk = perm.level === "ask" && pmode === "full"
          if (!isFullModeAsk) {
            resultContent = PermissionGate.formatBlockedMessage(tc.name, perm, tc.input)
            resultObj = { success: false, content: resultContent }
            resultsContent.push({ type: "tool_result", tool_use_id: tc.id, content: resultContent.slice(0, 4000) })
            continue
          }
          // full mode: ask is silently promoted to allow — but deny still blocks above
        }
      }

      if (tool && intentPolicy.mode === "readonly" && !tool.defn.isReadonly) {
        resultContent = `意图门已阻止：当前请求是只读模式（${intentPolicy.reason}），不允许调用 ${tc.name}。请让用户明确要求执行后再写入或运行命令。`
        resultObj = { success: false, content: resultContent }
      } else if (tool && rippleBlockActive && !tool.defn.isReadonly) {
        resultContent = `涟漪阻止：存在 ${pendingRippleObligations.length} 个未解决的调用方需要级联更新。请先用 multi_edit 完成所有受影响的调用方修改，然后再写新文件。`
        resultObj = { success: false, content: resultContent }
      } else if (tool && taskTracker?.phase === "planning" && !tool.defn.isReadonly) {
        const planningGate = evaluatePlanningArtifact(finalText, taskTracker)
        resultContent = planningGate.ok
          ? `任务追踪已阻止：长任务必须先完成规划回合，规划阶段不允许在同一轮调用 ${tc.name}。下一轮将进入执行阶段。`
          : formatPlanningBlockedToolResult(planningGate)
        resultObj = { success: false, content: resultContent }
      } else if (tool && tc.name === "web_search" && webSearchFailedThisTurn) {
        resultContent = `⚠️ 网页搜索不可用：${webSearchFailReason || "SearXNG Docker 未运行"}。\n\n解决方案（你来决定）：\n1) 启动 SearXNG Docker 容器修复搜索\n2) 用 web_fetch 直接访问已知 URL\n3) 用本地代码搜索 (findstr / grep) 代替\n4) 向用户报告搜索不可用，继续现有的本地分析`
        resultObj = { success: false, content: resultContent }
      } else if (tool) {
        const parallelResult = parallelResults.get(tc.id)
        // Use streaming variant if available (shell, long-running commands)
        if (parallelResult) {
          resultContent = parallelResult.content
          resultObj = { success: parallelResult.success, content: parallelResult.content, metadata: parallelResult.metadata }
          toolStartedAt = parallelResult.startedAt
        } else if (tool.executeStream) {
          try {
            const before = await runToolBeforeHook(hooks, tc.name, tc.input)
            if (before.blocked) {
              resultObj = appendHookWarnings(before.blocked, before.warnings)
              resultContent = resultObj.content
            } else {
              for await (const ev of tool.executeStream(tc.input)) {
                if (ev.type === "progress") {
                  // Raw shell stdout/stderr is often noisy progress output.
                  // Keep it out of the spinner/status line; the final result
                  // still carries command output for diagnostics.
                  continue
                } else if (ev.type === "done") {
                  const rawResult = ev.data
                  const after = await runToolAfterHook(hooks, tc.name, tc.input, rawResult)
                  const finalResult = appendHookWarnings(after.result, [...before.warnings, ...after.warnings])
                  resultContent = finalResult.content
                  resultObj = { success: finalResult.success, content: finalResult.content, metadata: finalResult.metadata }
                }
              }
            }
          } catch (e) {
            resultContent = e instanceof Error ? e.message : String(e)
            resultObj = { success: false, content: resultContent }
          }
        } else {
          try {
            const result = await executeToolWithHooks({
              hooks,
              tool,
              params: tc.input,
              execute: () => withToolTimeout(tc.name, tool.execute(tc.input)),
            })
            resultContent = result.content
            resultObj = { success: result.success, content: result.content, metadata: result.metadata }
          } catch (e) {
            resultContent = e instanceof Error ? e.message : String(e)
            resultObj = { success: false, content: resultContent }
          }
        }
      }
        const changedFilesForLedger = new Set<string>()
        // ── Smart truncation: head+tail with error-aware allocation ──
        if (resultObj.success && resultContent.length > 1400) {
          const lines = resultContent.split("\n")
          const totalBytes = Buffer.byteLength(resultContent, "utf-8")
          const MAX_LINES = 60; const MAX_BYTES = 12000
          if (lines.length > MAX_LINES || totalBytes > MAX_BYTES) {
            const tailScan = resultContent.slice(-2048)
            const hasErrors = /error|exception|failed|fatal|traceback|panic|exit code|Error|FAIL/i.test(tailScan)
            const headPct = hasErrors ? 0.7 : 0.85
            const headMaxLines = Math.floor(MAX_LINES * headPct)
            const tailMaxLines = MAX_LINES - headMaxLines
            const head = lines.slice(0, headMaxLines)
            const tail = lines.slice(-tailMaxLines)
            const omitted = lines.length - head.length - tail.length
            const marker = hasErrors
              ? `\n... [${omitted} lines trimmed — errors detected in tail] ...\n`
              : `\n... [${omitted} lines trimmed] ...\n`
            resultContent = head.join("\n") + marker + tail.join("\n")
          }
        }

        yield { type: "tool_result", data: { name: tc.name, content: resultContent.slice(0, 500) } }
        if (tc.name === "web_search" && !resultObj.success) {
          webSearchFailedThisTurn = true
          webSearchFailReason = resultContent.slice(0, 200)
        }
        if (tc.name === "request_deeper_thinking" && resultObj.success) {
          requestedMaxThinking = true
          yield { type: "status", data: "深度思考: 模型请求升级到 max 32K" }
        }

        // Self-learn: detect repeated errors
        if (!resultObj.success || /[ef]ail|[ef]rr|blocked|not found|denied/i.test(resultContent)) {
          roundHadToolError = true
          taskToolErrors += 1
          consecutiveErrors += 1
          const learnPrompt = errorTracker.record(tc.name, resultContent)
          if (learnPrompt) learnPrompts.push(learnPrompt)
        } else {
          consecutiveErrors = 0
        }
        if (containsTypecheckFailure(resultContent)) {
          lastTypecheck = {
            passed: isVerificationUnavailable(resultContent),
            issues: countTypecheckIssues(resultContent),
            output: resultContent.slice(0, 1000),
          }
        } else if (tc.name === "shell" && /\btsc\b|typescript|typecheck/i.test(String(tc.input.command ?? "")) && !resultObj.success) {
          const unavailable = isVerificationUnavailable(resultContent)
          lastTypecheck = {
            passed: unavailable,
            issues: unavailable ? 0 : 1,
            output: resultContent.slice(0, 1000),
          }
        }
        const verification = resultObj.metadata?.verification as VerificationResult | undefined
        if (verification) {
          verificationResultsThisRound.push(verification)
          options.runTrace?.record("verification_result", verification)
          if (verification.kind === "typecheck") {
            lastTypecheck = {
              passed: verification.passed,
              issues: verification.issues,
              output: verification.summary,
            }
          }
          if (verification.passed) verificationPassedThisRound = true
          if (!verification.passed && verification.kind === "test" && hasServiceTestFailure(resultContent)) {
            serviceTestGuidanceNeeded = true
          }
        }

        const path = tc.input.path as string | undefined
        if (path) {
          filePaths.push(path)
          taskFiles.add(normalizeProjectPath(path))
          const isWriteTool = tc.name === "write_file" || tc.name === "edit_file" || tc.name === "edit_fim"
          if (resultObj.success && isWriteTool) {
            const normalizedPath = normalizeProjectPath(path)
            modifiedFilesThisRound.add(normalizedPath)
            changedFilesForLedger.add(normalizedPath)
            taskHadWrite = true
            taskModifiedFiles += 1
          }
          const rippleReport = resultObj.metadata?.rippleReport as RippleReport | undefined
          if (resultObj.success && rippleReport) {
            rippleReportsThisRound.push(rippleReport)
            modifiedFilesThisRound.add(normalizeProjectPath(rippleReport.targetFile))
          }
          if (stagedContext) {
            if (tc.name === "read_file") stagedContext.markLoaded(path)
            else if (tc.name === "write_file" || tc.name === "edit_file" || tc.name === "edit_fim") {
              stagedContext.markEdited(path)
              runPostEditDiagnostics(path, resultObj)
            }
          }
          if (options.thinkingStore && (tc.name === "shell" || tc.name === "edit_fim" || tc.name === "write_file")) {
            options.thinkingStore.store(prompt, `Tool: ${tc.name}\nResult: ${resultContent.slice(0, 500)}`, resultContent.includes("error") || resultContent.includes("Error") ? "fix" : "implement")
          }
        }

        if (resultObj.success && Array.isArray(resultObj.metadata?.paths)) {
          for (const path of resultObj.metadata.paths) {
            if (typeof path === "string") {
              filePaths.push(path)
              const normalized = normalizeProjectPath(path)
              modifiedFilesThisRound.add(normalized)
              changedFilesForLedger.add(normalized)
              taskFiles.add(normalized)
              taskHadWrite = true
              taskModifiedFiles += 1
              if (stagedContext) stagedContext.markEdited(path)
            }
          }
        }
        if (resultObj.success && Array.isArray(resultObj.metadata?.rippleReports)) {
          for (const report of resultObj.metadata.rippleReports) {
            rippleReportsThisRound.push(report as RippleReport)
            const normalized = normalizeProjectPath((report as RippleReport).targetFile)
            modifiedFilesThisRound.add(normalized)
            changedFilesForLedger.add(normalized)
          }
        }

        const ledgerEntry = toolLedger.record({
          id: tc.id,
          round,
          tool: tc.name,
          startedAt: toolStartedAt,
          result: resultObj,
          changedFiles: [...changedFilesForLedger],
        })
        options.runTrace?.record("tool_result", ledgerEntry)
        yield { type: "status", data: formatToolLedgerStatus(ledgerEntry) }

      resultsContent.push({ type: "tool_result", tool_use_id: tc.id, content: resultContent.slice(0, 4000) })
    }

    // ── Microcompact: forward pass — compact fresh tool results before they enter history ──
    if (contextBudget.percent >= 35 || rawMessages.length >= 40) {
      const mcResult = microcompactToolResults(resultsContent, completedToolCalls)
      while (resultsContent.length > 0) resultsContent.pop()
      for (const r of mcResult.results) resultsContent.push(r)
      if (mcResult.compacted > 0) {
        microcompactCount += mcResult.compacted
        yield { type: "status", data: `microcompact: ${mcResult.compacted} tool results compacted (${microcompactCount} total)` }
      }
    }

    let postToolRequiredFilesPrompt = ""
    let postToolPlanningPrompt = ""
    if (modifiedFilesThisRound.size > 0 || rippleReportsThisRound.length > 0) {
      const rippleVerification = runRippleVerification(modifiedFilesThisRound)
      const hadTsWriteThisRound = [...modifiedFilesThisRound].some(path => path.endsWith(".ts") || path.endsWith(".tsx"))
      if (rippleVerification.passed) {
        pendingRippleObligations = resolveObligations(pendingRippleObligations, modifiedFilesThisRound)
        if (!lastTypecheck || lastTypecheck.passed) lastTypecheck = { passed: true, issues: 0 }
      } else if (modifiedFilesThisRound.size > 0 && rippleVerification.available) {
        lastTypecheck = { passed: false, issues: rippleVerification.issues, output: rippleVerification.output || "ripple verification failed" }
        yield { type: "status", data: "ripple-verification: failed; obligations retained" }
      } else if (modifiedFilesThisRound.size > 0) {
        lastTypecheck = { passed: true, issues: 0, output: rippleVerification.output || "tsc unavailable" }
        yield { type: "status", data: "ripple-verification: skipped; tsc unavailable" }
      }
      for (const report of rippleReportsThisRound) {
        pendingRippleObligations = mergeObligations(
          pendingRippleObligations,
          obligationsFromReport(report, modifiedFilesThisRound),
        )
      }
      if (pendingRippleObligations.length > 0) {
        // Let ripple engine know agent is cascading — promotes block→warn
        setCascadeFiles(new Set(pendingRippleObligations.map(o => o.targetFile)))
        yield { type: "status", data: `ripple-obligations: pending ${pendingRippleObligations.length}` }
        options.runTrace?.record("gate_decision", { gate: "ripple_obligations", decision: "continue", pending: pendingRippleObligations.length })
      } else {
        setCascadeFiles(new Set())
      }
      const missingNarrowFiles = intentPolicy.mode === "narrow_edit"
        ? missingExplicitRequiredFiles(effectivePrompt, modifiedFilesThisRound)
        : []
      if (
        options.autoFinishOnVerifiedWrite &&
        intentPolicy.mode === "narrow_edit" &&
        hadTsWriteThisRound &&
        pendingRippleObligations.length === 0 &&
        lastTypecheck?.passed &&
        missingNarrowFiles.length === 0
      ) {
        const files = [...modifiedFilesThisRound].sort().join(", ")
        completionGateText = `Done. Applied a verified TypeScript cascade edit. TypeScript verification passed. Changed files: ${files}.`
      } else if (missingNarrowFiles.length > 0) {
        postToolRequiredFilesPrompt = [
          "## Required files still missing",
          "The user explicitly requested these files, so do not finish yet:",
          ...missingNarrowFiles.map(file => `- ${file}`),
          "",
          "Create the missing file(s), then run the requested verification.",
        ].join("\n")
        yield { type: "status", data: `completion-gate: missing requested file ${missingNarrowFiles[0]}` }
        options.runTrace?.record("gate_decision", { gate: "explicit_required_files", decision: "continue", missing: missingNarrowFiles })
      }
    }
    if (rippleReportsThisRound.length > 0) lastRippleReports = rippleReportsThisRound

    // ── Gate overflow: track cumulative blocks, force strategy switch at 3, BLOCKED at 5 ──
    // Clear stale block entries
    sandbox.clearBlockedFiles()

    const blockedGates: string[] = []
    if (rippleBlockActive) blockedGates.push("ripple")
    if (pendingRippleObligations.length > 0) blockedGates.push("ripple_obligations")
    if (postToolPlanningPrompt || postToolRequiredFilesPrompt) {
      if (postToolPlanningPrompt) blockedGates.push("planning")
      if (postToolRequiredFilesPrompt) blockedGates.push("required_files")
    }

    for (const gate of blockedGates) {
      const entry = gateBlockCounts.get(gate) ?? { count: 0, lastSeen: 0 }
      entry.count++
      entry.lastSeen = round
      gateBlockCounts.set(gate, entry)
    }
    for (const [gate, entry] of gateBlockCounts) {
      if (!blockedGates.includes(gate) && round - entry.lastSeen >= 2) gateBlockCounts.delete(gate)
    }

    for (const [gate, entry] of gateBlockCounts) {
      if (entry.count === 3) {
        deferredGateMessages.push([
          "<system-reminder>",
          `[Gate overflow] ${gate} 已拦截 3 次。不要继续走同一条路径。`,
          gate === "ripple" ? "→ 停止逐文件编辑，立即用 multi_edit 级联修复所有调用方。" : "",
          gate === "ripple_obligations" ? "→ 读取被影响的调用方文件并级联修复，不要再次触发写盘。" : "",
          gate === "planning" ? "→ 缩小任务范围，列出最小可交付单元，不要追求完美方案。" : "",
          gate === "completion" ? "→ 检查是否缺少外部验证证据（typecheck/test/build）。不要声称完成但不验证。" : "",
          gate === "required_files" ? "→ 立即创建缺失的必需文件，停止分析已经存在的文件。" : "",
          "</system-reminder>",
        ].filter(Boolean).join("\n"))
        yield { type: "status", data: `gate-overflow: ${gate} blocked 3 times` }
      }
      if (entry.count >= 5) {
        const reason = `${gate} 累积阻断 ${entry.count} 次，请求人工介入。`
        sm.transition(AgentState.BLOCKED, reason)
        yield { type: "status", data: `gate-overflow: ${gate} blocked ${entry.count} times — BLOCKED` }
        options.runTrace?.record("agent_loop_blocked", { reason, gate, blockCount: entry.count })
        setRuntimeContextBudgetMode("normal")
        sandbox.dispose()
        setShellSandbox(null)
        return
      }
    }

    // ── Revise plan: stuck detection → push back to planning ──
    if (
      taskTracker &&
      taskTracker.phase === "building" &&
      completedToolCalls.length === 0 &&
      modifiedFilesThisRound.size === 0 &&
      verificationResultsThisRound.length === 0 &&
      (consecutiveErrors >= 3 || !taskTracker.steps.some(s => s.status === "done"))
    ) {
      const reason = consecutiveErrors >= 3
        ? `连续 ${consecutiveErrors} 次工具错误`
        : "步骤未推进，当前方案可能有问题"
      const reviseMsg = revisePlan(taskTracker, reason)
      deferredGateMessages.push(reviseMsg)
      yield { type: "status", data: `revise-plan: ${reason}` }
      options.runTrace?.record("gate_decision", { gate: "revise_plan", decision: "replan", reason })
    }

    if (taskTracker?.phase === "planning" && finalText.trim()) {
      const planningGate = evaluatePlanningArtifact(finalText, taskTracker)
      if (planningGate.ok) {
        markPlanAccepted(taskTracker)
        yield { type: "status", data: "任务追踪: 已读取计划，进入执行阶段" }
        options.runTrace?.record("gate_decision", {
          gate: "planning",
          decision: "accepted",
          score: planningGate.score,
          signals: planningGate.signals,
        })
      } else if (round + 1 < maxRounds) {
        postToolPlanningPrompt = formatPlanningGatePrompt(planningGate, taskTracker)
        yield { type: "status", data: `planning-gate: revise plan (${planningGate.missing.length} missing)` }
        options.runTrace?.record("gate_decision", {
          gate: "planning",
          decision: "revise",
          missing: planningGate.missing,
          score: planningGate.score,
        })
      }
    }

    // ── Batch typecheck: run tsc once per round instead of per-file ──
    const tsFilesWritten = [...modifiedFilesThisRound].filter(f => f.endsWith(".ts") || f.endsWith(".tsx"))
    if (tsFilesWritten.length > 0) {
      const tscResult = runTypeScriptNoEmit(process.cwd())
      lastTypecheck = tscResult.available
        ? { passed: tscResult.passed, issues: tscResult.issues, output: tscResult.output }
        : { passed: true, issues: 0, output: tscResult.output || "tsc unavailable" }
      if (!tscResult.passed && tscResult.available) {
        const diagLines = tscResult.output
          .split("\n")
          .filter(l => tsFilesWritten.some(f => l.includes(f)))
          .join("\n")
        if (diagLines) {
          const lastResult = resultsContent[resultsContent.length - 1]
          if (lastResult) {
            lastResult.content = String(lastResult.content) + `\n\n[post-round typecheck — fix in next round]\n${diagLines}`
          }
        }
      }
    }

    updateTaskTrackerAfterTools({
      tracker: taskTracker,
      changedFiles: [...modifiedFilesThisRound],
      toolNames,
      typecheckPassed: lastTypecheck?.passed,
      verificationPassed: verificationPassedThisRound,
      verificationResults: verificationResultsThisRound,
    })
    if (taskTracker) {
      const status = formatTaskTrackerStatus(taskTracker)
      if (status) yield { type: "status", data: status }
      yield { type: "task_progress", data: snapshotTaskTracker(taskTracker) }
    }
    if (verificationResultsThisRound.length > 0) {
      lastVerificationResults = [...lastVerificationResults, ...verificationResultsThisRound].slice(-20)
    }
    // ── Inject gate overflow / revisePlan messages BEFORE tool results ──
    // Must go as CONTENT BLOCKS in the same user message as tool_results,
    // NOT as separate user messages (breaks Anthropic format: tool_use→tool_result adjacency).
    if (deferredGateMessages.length > 0) {
      for (const msg of deferredGateMessages) {
        resultsContent.unshift({ type: "text", text: msg + "\n" })
      }
      deferredGateMessages.length = 0
    }

    // Inject self-learn prompts AFTER tool results (Anthropic format: user message after tool_use)
    if (learnPrompts.length > 0) {
      const learnMsg = "## 自我学习建议\n\n" + learnPrompts.join("\n")
      const lastResult = resultsContent[resultsContent.length - 1]
      if (lastResult) {
        lastResult.content = String(lastResult.content) + "\n" + learnMsg
      }
    }

    if (postToolRequiredFilesPrompt) {
      const lastResult = resultsContent[resultsContent.length - 1]
      if (lastResult) {
        lastResult.content = String(lastResult.content) + "\n" + postToolRequiredFilesPrompt
      }
    }

    // Safety net: ensure every tool_use has a tool_result (prevents 400)
    for (const tc of completedToolCalls) {
      if (!resultsContent.some(r => isRecord(r) && r.type === "tool_result" && r.tool_use_id === tc.id)) {
        resultsContent.push({ type: "tool_result", tool_use_id: tc.id, content: "(skipped)", is_error: true })
      }
    }
    rawMessages.push({ role: "user", content: resultsContent })

    // ── Microcompact: retrospective pass — compact historical tool results every 10 rounds ──
    if (round >= 15 && round % 10 === 0) {
      const histCompacted = compactHistoricalToolResults(rawMessages, 8)
      if (histCompacted > 0) {
        microcompactCount += histCompacted
        yield { type: "status", data: `microcompact: ${histCompacted} historical results compacted (${microcompactCount} total)` }
      }
    }

    // ── State machine transition (after tool results, before next round) ──
    updateStateMachine(sm, {
      roundHadToolError,
      hadSearchTool: toolNames.some(t => /read_file|web_search|find_symbol|find_references|project_structure|glob|grep/.test(t)),
      hadWriteTool: toolNames.some(t => /write_file|edit_file|edit_fim/.test(t)),
      hadVerifyTool: toolNames.some(t => t === "shell" || t === "typescript"),
      isDone: round + 1 >= maxRounds || false,
      pendingRippleCount: pendingRippleObligations.length,
    })
    // Reset one-shot thinking upgrade
    if (requestedMaxThinking) requestedMaxThinking = false

    // ── Thinking compaction (40% context budget, one-shot per session) ──
    if (
      !thinkingCompacted &&
      contextBudget.mode === "normal" &&
      contextBudget.percent >= 40 &&
      options.thinkingStore
    ) {
      const thinkingRounds = collectThinkingRounds(rawMessages)
      if (thinkingRounds.length >= 2) {
        if (shouldSkipProviderPurpose("thinking_compaction")) {
          yield { type: "status", data: formatSkippedProviderPurpose("thinking_compaction") }
          options.runTrace?.record("gate_decision", { gate: "cost_mode", decision: "skip", purpose: "thinking_compaction" })
        } else {
        yield { type: "status", data: `thinking-compaction: ${thinkingRounds.length} rounds → analyzing...` }
        try {
          const compactResult = await compactThinkingChain(
            thinkingRounds,
            async function* (system, prompt) {
              for await (const ev of provider.streamChat({
                model: options.modelRouter?.selectForPurpose("thinking_compaction") ?? "deepseek-v4-flash",
                purpose: "thinking_compaction",
                system,
                messages: [{ role: "user", content: prompt }],
                maxTokens: 1024,
              })) {
                yield ev
              }
            },
          )
          if (compactResult.success) {
            const mergeResult = options.thinkingStore!.mergeCompressedInsights(
              options.stableMemoryContext ?? "",
              compactResult.output,
            )
            const insightCount = compactResult.output.key_insights.length +
              compactResult.output.discarded.length +
              compactResult.output.verified.length +
              compactResult.output.open.length

            if (mergeResult.changed) {
              // Inject updated cold memory as a user message — does NOT
              // mutate rawMessages or invalidate the frozen stable prefix.
              // Prefix cache continuity is preserved (system+tools+stable_prefix
              // remain byte-identical; only a new user message is appended).
              const compactSummary = [
                "<system-reminder>",
                "思考链已压实。以下是从本次会话推理中提取的关键洞察（已去重并存入冷记忆）：",
                ...compactResult.output.key_insights.map((k, i) => `${i + 1}. [insight] ${k}`),
                ...compactResult.output.verified.map((v, i) => `✓ [verified] ${v}`),
                ...compactResult.output.open.map((o, i) => `? [open] ${o}`),
                "</system-reminder>",
              ].join("\n")
              rawMessages.push({ role: "user", content: compactSummary })
              options.stableMemoryContext = mergeResult.merged
              // NOTE: frozenStablePrefix is NOT invalidated. The next round's
              // cold memory diff is carried as a volatile message, preserving
              // the system+tools+stable_prefix cache boundary.
              yield { type: "status", data: `thinking-compaction: ${thinkingRounds.length} rounds → ${insightCount} insights (appended, cache preserved)` }
            }

            options.thinkingStore!.storeCompressed({
              query: effectivePrompt,
              compactOutput: compactResult.output,
              roundRange: `r${thinkingRounds[0]?.roundNum ?? 0}-r${thinkingRounds[thinkingRounds.length - 1]?.roundNum ?? round}`,
              filePattern: [...taskFiles].join(","),
            })
            thinkingCompacted = true
            yield { type: "status", data: `thinking-compaction: ${thinkingRounds.length} rounds → ${insightCount} insights` }
          }
        } catch {
          yield { type: "status", data: "thinking-compaction: failed, keeping full chains" }
        }
        }
      }
    }

    // ── Historical Context injection (L3 volatile, semantic recall) ──
    if (options.thinkingStore && round > 0 && state.roundNum % 3 === 0) {
      if (shouldSkipProviderPurpose("semantic_recall_score")) {
        yield { type: "status", data: formatSkippedProviderPurpose("semantic_recall_score") }
        options.runTrace?.record("gate_decision", { gate: "cost_mode", decision: "skip", purpose: "semantic_recall_score" })
      } else {
      try {
        const semanticRecords = await options.thinkingStore.findSimilarSemantic(
          effectivePrompt,
          async (query, candidates) => {
            const lines = candidates.map((c, i) => `候选${i + 1}: ${c.queryPreview.slice(0, 80)}`).join("\n")
            const prompt = `当前问题: "${query.slice(0, 120)}"\n\n对以下每个候选与当前问题的相关性从0-10打分，只输出逗号分隔的数字:\n${lines}\n\n输出格式: 8,3,9,1,6,...`
            const scores: number[] = []
            try {
              for await (const ev of provider.streamChat({
                model: options.modelRouter?.selectForPurpose("semantic_recall_score") ?? "deepseek-v4-flash",
                purpose: "semantic_recall_score",
                system: "你是相关性打分器。只输出数字。",
                messages: [{ role: "user", content: prompt }],
                maxTokens: 128,
              })) {
                if (ev.type === "text" && typeof ev.data === "string") {
                  for (const part of ev.data.split(",")) {
                    const n = parseInt(part.trim(), 10)
                    if (!isNaN(n)) scores.push(n)
                  }
                }
              }
            } catch { /* fall through to keyword results */ }
            return scores
          },
        )
        if (semanticRecords.length > 0) {
          const historicalContext = options.thinkingStore.formatForVolatileContext(semanticRecords)
          if (historicalContext) {
            // Inject as an additional user message before the next round
            // This goes into L3 volatile — does NOT affect prefix cache
            rawMessages.push({ role: "user", content: historicalContext })
          }
        }
      } catch { /* semantic recall is best-effort */ }
      }
    }
    updateState(state, toolNames, filePaths, streamError !== "" || roundHadToolError)
    lastToolNames = toolNames
    if (postToolPlanningPrompt) {
      rawMessages.push({ role: "user", content: postToolPlanningPrompt })
      continue
    }

    const runtimeFilesThisRound = [...modifiedFilesThisRound].filter(path => isRuntimeSourceFile(path))
    if (runtimeFilesThisRound.length > 0) {
      runtimeSelfEditFiles = new Set([...runtimeSelfEditFiles, ...runtimeFilesThisRound])
    }
    if (runtimeSelfEditFiles.size > 0) {
      if (rootRuntimeVerificationPassed(verificationResultsThisRound) || rootRuntimeVerificationPassed(lastVerificationResults)) {
        const files = [...runtimeSelfEditFiles].sort().join(", ")
        yield { type: "status", data: "runtime-self-edit-gate: verified; restart required" }
        yield {
          type: "text",
          data: `Runtime source changes were verified, but the current DeepSeek Code process cannot hot-load them. Restart DeepSeek Code before continuing. Changed runtime files: ${files}.`,
        }
        options.runTrace?.record("gate_decision", { gate: "runtime_self_edit", decision: "restart_required", files: [...runtimeSelfEditFiles].sort() })
        break
      }
      if (round + 1 < maxRounds) {
        rawMessages.push({ role: "user", content: formatRuntimeSelfEditGate([...runtimeSelfEditFiles].sort()) })
        yield { type: "status", data: "runtime-self-edit-gate: run root typecheck then stop" }
        options.runTrace?.record("gate_decision", { gate: "runtime_self_edit", decision: "verify_then_restart", files: [...runtimeSelfEditFiles].sort() })
        continue
      }
    }

    if (serviceTestGuidanceNeeded) {
      rawMessages.push({ role: "user", content: formatServiceTestGuidance() })
      yield { type: "status", data: "服务型测试: 要求改为测试内启动并关闭服务" }
      options.runTrace?.record("gate_decision", { gate: "service_test", decision: "repair_guidance" })
    }

    const missingLongTask = missingTaskRequirements(taskTracker)
    if (taskTracker?.phase === "planning" && missingLongTask.length > 0 && round + 1 < maxRounds) {
      rawMessages.push({ role: "user", content: formatTaskPlanningPrompt(taskTracker, round + 1) })
      yield { type: "status", data: "任务追踪: 等待计划文本，下一轮不允许调用工具" }
      options.runTrace?.record("gate_decision", { gate: "task_tracker", decision: "plan_required", missing: missingLongTask })
      continue
    }
    if (taskTracker && missingLongTask.length > 0) {
      rawMessages.push({ role: "user", content: [
        "## 任务追踪未完成",
        "继续执行。尚未完成：",
        ...missingLongTask.slice(0, 12).map(item => `- ${item}`),
        "",
        "下一轮必须处理第一个未完成项，并在完成后运行验证。",
      ].join("\n") })
      yield { type: "status", data: `任务追踪: 阻止结束，剩余 ${missingLongTask.length} 项` }
      options.runTrace?.record("gate_decision", { gate: "task_tracker", decision: "continue", missing: missingLongTask })
    } else if (completionGateText) {
      yield { type: "status", data: "completion-gate: verified write; stopping without extra provider round" }
      yield { type: "text", data: completionGateText }
      options.runTrace?.record("gate_decision", { gate: "completion", decision: "verified_write_stop" })
      break
    }

    if (stagedContext && completedToolCalls.length && finalText) {
      stagedContext.addSummary(finalText.slice(0, 120))
      stagedContext.advance()
    }

    // ── Checkpoint (adaptive density) ──
    const metrics: ComplexityMetrics = {
      filesPerRound: round > 0 ? taskModifiedFiles / round : 0,
      errorRate: round > 0 ? taskToolErrors / round : 0,
      round,
    }
    const cpDecision = adaptiveCheckpointThreshold(contextBudget.percent, metrics)
    if (cpDecision && !shouldSkipCheckpointThisRound(round)) {
      yield { type: "status", data: `checkpoint: ${cpDecision.label} (${cpDecision.urgency})` }
      saveCheckpoint({
        version: 1,
        round,
        timestamp: Date.now(),
        sessionId: process.env.DEEPSEEK_SESSION_ID ?? "ds-default",
        masterPlan: taskTracker ? { goal: taskTracker.goal, steps: taskTracker.steps.map(s => ({ id: s.id, status: s.status, title: s.title })) } : {},
        taskSteps: taskTracker?.steps.map(s => ({ id: s.id, status: s.status, title: s.title })) ?? [],
        changedFiles: [...taskFiles],
        fileSHAs: {},
        coldMemorySHA: stablePrefixHash,
        knowledgeCount: 0,
        lastVerification: lastTypecheck ? { kind: "typecheck", passed: lastTypecheck.passed, command: "tsc --noEmit" } : null,
        conversationTokens: contextBudget.percent > 0 ? Math.round(contextBudget.percent * 1000) : 0,
        prevRound: round,
        summary: formatCheckpointSummary({
          version: 1, round, timestamp: Date.now(), sessionId: "",
          masterPlan: taskTracker ? { goal: taskTracker.goal, steps: taskTracker.steps } : {},
          taskSteps: taskTracker?.steps ?? [],
          changedFiles: [...taskFiles],
          fileSHAs: {},
          coldMemorySHA: stablePrefixHash,
          knowledgeCount: 0,
          lastVerification: lastTypecheck ? { kind: "typecheck", passed: lastTypecheck.passed, command: "tsc --noEmit" } : null,
          conversationTokens: Math.round(contextBudget.percent * 1000),
          prevRound: round,
          summary: `Round ${round}: ${taskModifiedFiles} files, ${taskToolErrors} errors`,
        }),
      })
      recordCheckpointTaken(round)
      options.runTrace?.record("checkpoint", { label: cpDecision.label, round, metrics })
    }

    // ── Stage 2: distill web_search results into knowledge base ──
    if (options.knowledgeBase && learnPrompts.length > 0) {
      for (const tc of completedToolCalls) {
        if (tc.name !== "web_search") continue
        const query = (tc.input as Record<string, unknown>).query as string | undefined
        if (!query || !shouldDistill(query, "error")) continue
        const resultEntry = resultsContent.find(r => r.tool_use_id === tc.id)
        if (!resultEntry) continue
        const resultText = String(resultEntry.content ?? "")
        if (!resultText.includes("[SearXNG]") && !resultText.includes("[DuckDuckGo]")) continue
        // Fire distillation (best-effort, don't block next round if it fails)
        distillAndStore(
          { query, results: resultText, trigger: "error" },
          provider,
          options.knowledgeBase,
          options.modelRouter?.selectForPurpose("knowledge_distill") ?? "deepseek-v4-flash",
        ).catch(() => {})
      }
    }

    // ── Memory reconcile: periodic prune + FTS5 rebuild every 50 rounds ──
    if (options.knowledgeBase && round > 0 && round % 50 === 0) {
      const recResult = options.knowledgeBase.reconcile()
      if (recResult.pruned > 0) {
        yield { type: "status", data: `knowledge-reconcile: pruned ${recResult.pruned} expired, ${recResult.indexed} active` }
      }
    }
  }

  options.runTrace?.record("agent_loop_finished", {
    apiCalls: usage.apiCalls,
    changedFiles: [...taskFiles],
    toolErrors: taskToolErrors,
    modifiedFiles: taskModifiedFiles,
  })
  setRuntimeContextBudgetMode("normal")
  sandbox.dispose()
  setShellSandbox(null)
}

function runPostEditDiagnostics(path: string, result: { success: boolean; content: string }) {
  if (!path.endsWith(".py") && !path.endsWith(".ts") && !path.endsWith(".tsx")) return
  try {
    let diagnostics = ""
    if (path.endsWith(".py")) {
      const out = execSync(`ruff check "${path}" --output-format concise`, { encoding: "utf-8", timeout: 10000 })
      if (out.trim()) diagnostics = out.trim()
    }
    if (path.endsWith(".ts") || path.endsWith(".tsx")) {
      // LSP fast path: notify change + read cached diagnostics for this file
      const lsp = getLSPClient()
      lsp.notifyChange(path).catch(() => {})
      // Small delay for LSP to process (non-blocking — we just wait a tick)
      const lspResult = lsp.getVerificationResult(path)
      if (lspResult && lspResult.issues > 0) {
        diagnostics = lspResult.summary
      } else if (!lsp.isAvailable) {
        // LSP unavailable — fall back to full tsc (preserved ground truth)
        const check = runTypeScriptNoEmit(process.cwd())
        const out = check.passed ? "" : check.output
        if (out.trim() && out.includes(path)) diagnostics = out.trim().split("\n").filter(l => l.includes(path)).join("\n")
      }
    }
    if (diagnostics && result.success) { ;(result as Record<string, unknown>).content = result.content + `\n\n[diagnostics]\n${diagnostics}` }
  } catch { /* not available */ }
}

function runRippleVerification(modifiedFiles: Set<string>): { passed: boolean; available: boolean; issues: number; output?: string } {
  const tsFiles = [...modifiedFiles].filter(path => path.endsWith(".ts") || path.endsWith(".tsx"))
  if (!tsFiles.length) return { passed: true, available: true, issues: 0 }
  if (!tsFiles.some(path => existsSync(resolve(path)))) return { passed: true, available: true, issues: 0 }

  // LSP fast path: check cached diagnostics for modified files
  const lsp = getLSPClient()
  if (lsp.isAvailable) {
    let totalErrors = 0
    const summaries: string[] = []
    for (const file of tsFiles) {
      const counts = lsp.getSeverityCounts(file)
      if (counts.errors > 0) {
        totalErrors += counts.errors
        summaries.push(`${file}: ${counts.errors} errors`)
      }
    }
    if (totalErrors > 0) {
      return { passed: false, available: true, issues: totalErrors, output: summaries.join("\n") }
    }
    return { passed: true, available: true, issues: 0, output: "LSP: no errors" }
  }

  // LSP unavailable — tsc ground truth
  return runTypeScriptNoEmit(process.cwd())
}

// ── Thinking compaction helpers ──

interface CollectedThinkingRound {
  roundNum: number
  thinking: string
  toolsUsed: string[]
  hadError: boolean
}

function collectThinkingRounds(messages: ProviderMessage[]): CollectedThinkingRound[] {
  const rounds: CollectedThinkingRound[] = []
  let roundNum = 0
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    const content = Array.isArray(msg.content) ? msg.content : []
    const thinkingBlocks: string[] = []
    const toolNames: string[] = []
    for (const block of content) {
      if (isRecord(block) && block.type === "thinking" && typeof block.thinking === "string") {
        thinkingBlocks.push(block.thinking)
      }
      if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") {
        toolNames.push(block.name)
      }
    }
    if (thinkingBlocks.length > 0) {
      rounds.push({
        roundNum: roundNum++,
        thinking: thinkingBlocks.join("\n---\n"),
        toolsUsed: toolNames,
        hadError: false, // approximated — errors detected during tool execution, not in history
      })
    }
  }
  return rounds
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ── Thinking insufficiency detection ──

function collectRecentTurns(messages: ProviderMessage[], count: number): Array<{ role: string; content: string }> {
  return messages.slice(-count).map(m => {
    const content = Array.isArray(m.content)
      ? m.content.filter((b: unknown) => isRecord(b) && b.type === "text").map((b: Record<string, unknown>) => String(b.text ?? "")).join("\n")
      : String(m.content ?? "")
    return { role: m.role, content: content.slice(0, 800) }
  })
}

// ── Microcompact: tool result placeholder substitution ──

const MC_READFILE_CHARS = Number(process.env.DEEPSEEK_READFILE_COMPACT_CHARS) || 0
const MC_SHELL_CHARS = Number(process.env.DEEPSEEK_SHELL_COMPACT_CHARS) || 3000
const MC_WEBFETCH_CHARS = Number(process.env.DEEPSEEK_WEBFETCH_COMPACT_CHARS) || 5000

function mcThreshold(toolName: string): number {
  if (toolName === "read_file") return MC_READFILE_CHARS
  if (toolName === "shell") return MC_SHELL_CHARS
  if (toolName === "web_fetch") return MC_WEBFETCH_CHARS
  return Infinity
}

/** Extract future-tense promises from agent text for testimony ledger. */
function extractPromises(text: string): string[] {
  const patterns = [
    /(?:接下来|下一步|随后|下一步骤|马上|立即|现在)\s*(?:我会|我将|我们要|需要)\s*([^。\n]{4,40})/g,
    /(?:我会|我将|我们要|打算)\s*([^。\n]{4,40})/g,
    /(?:需要\s*(?:再|补充|额外|进一步))\s*([^。\n]{4,40})/g,
  ]
  const results: string[] = []
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const p = match[1]?.trim()
      if (p && p.length > 3 && !p.includes("？") && !p.includes("?")) {
        results.push(p)
      }
    }
  }
  return [...new Set(results)].slice(0, 5)
}

function microcompactToolResults(
  results: Array<Record<string, unknown>>,
  completedCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): { compacted: number; results: Array<Record<string, unknown>> } {
  let compacted = 0
  const nameById = new Map(completedCalls.map(tc => [tc.id, tc]))
  const out: Array<Record<string, unknown>> = []
  for (const r of results) {
    if (r.type !== "tool_result" || typeof r.content !== "string" || r.content.length < 100) {
      out.push(r); continue
    }
    const tc = nameById.get(String(r.tool_use_id ?? ""))
    if (!tc) { out.push(r); continue }
    const threshold = mcThreshold(tc.name)
    if (threshold <= 0 || r.content.length <= threshold) { out.push(r); continue }
    const pathOrCmd = tc.name === "read_file" ? String(tc.input.path ?? "")
      : tc.name === "shell" ? String(tc.input.command ?? "").slice(0, 80)
      : tc.name === "web_fetch" ? String(tc.input.url ?? "")
      : ""
    const prefix = r.content.slice(0, 300)
    const placeholder = `[Microcompact: ${tc.name} ${pathOrCmd} — ${r.content.length} chars trimmed. Re-execute ${tc.name}(${JSON.stringify(pathOrCmd)}) to retrieve full content.]`
    out.push({ ...r, content: prefix + "\n\n" + placeholder })
    compacted++
  }
  return { compacted, results: out }
}

function compactHistoricalToolResults(messages: ProviderMessage[], keepRecentRounds: number): number {
  let compacted = 0
  let assistantCount = 0
  const compactAfterAssistant = messages.length - keepRecentRounds * 2
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role === "assistant") assistantCount++
    if (assistantCount <= compactAfterAssistant) continue
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (!isRecord(block) || block.type !== "tool_result" || typeof block.content !== "string" || block.content.includes("[Microcompact:")) continue
      if (block.content.length < 400) continue
      const tid = String(block.tool_use_id ?? "")
      // Only compact read_file/shell/web_fetch whose full output is embedded
      if (!/^(read_file|shell|web_fetch)/.test(tid.split("_")[0] ?? "")) continue
      if (block.content.length < MC_READFILE_CHARS && block.content.length < MC_SHELL_CHARS) continue
      block.content = block.content.slice(0, 300) + `\n\n[Microcompact: historical ${tid.slice(0, 8)}… — content trimmed. Re-execute the original tool call to retrieve.]`
      compacted++
    }
  }
  return compacted
}

// ──

interface StateMachineInput {
  roundHadToolError: boolean
  hadSearchTool: boolean
  hadWriteTool: boolean
  hadVerifyTool: boolean
  isDone: boolean
  pendingRippleCount: number
}

function updateStateMachine(sm: StateMachine, input: StateMachineInput) {
  const current = sm.currentState
  try {
    if (input.isDone && current !== AgentState.DONE) {
      sm.transition(AgentState.DONE, `task complete (pending ripple: ${input.pendingRippleCount})`)
      return
    }
    if (input.roundHadToolError && current !== AgentState.REPAIR && current !== AgentState.BLOCKED) {
      sm.transition(AgentState.REPAIR, "tool errors detected")
      return
    }
    if (input.hadVerifyTool && (current === AgentState.CODE || current === AgentState.REPAIR)) {
      sm.transition(AgentState.VERIFY, "verification running")
      return
    }
    if (input.hadWriteTool && current !== AgentState.CODE && current !== AgentState.VERIFY && current !== AgentState.REPAIR) {
      sm.transition(AgentState.CODE, "writing code")
      return
    }
    if (input.hadSearchTool && (current === AgentState.UNDERSTAND || current === AgentState.SEARCH)) {
      sm.transition(AgentState.SEARCH, "searching")
      return
    }
  } catch {
    // Transition validation failed — state machine caught an illegal transition.
    // The ad-hoc flags still drive behavior; SM is a monitoring layer.
  }
}
