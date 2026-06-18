/**
 * External Monitor V2 — independently surveilled, zero model dependency.
 *
 * Design invariants:
 *   1. No check reads model-generated data (no "completed steps", no confidence scores)
 *   2. Every check compares ACTUAL system state against a PREVIOUS snapshot
 *   3. Three action levels: WARNING (inject into next round) / ALARM (serialize + notify) / BLOCK (stop + report)
 *   4. File scope: compare changed files against plan expectations (not raw count)
 *   5. Cold memory: SHA + periodic independent semantic audit (Flash, but NOT the agent model)
 *   6. Progress: files written count + shell test output — model can't fake either
 *
 * Credit: structural feedback from Claude Sonnet 4.6 on V1 blind spots.
 */

import { createHash } from "node:crypto"
import type { StreamEvent } from "../provider/types"

// ═══════════════════════════════════════════════════════════
// Action protocol
// ═══════════════════════════════════════════════════════════

export type ActionLevel = "WARNING" | "ALARM" | "BLOCK"

export interface MonitorAction {
  level: ActionLevel
  check: string
  message: string
  /** Injected into system prompt for the next round (WARNING) */
  injectPrompt?: string
  /** If BLOCK: serialized incident report */
  incident?: string
}

// ═══════════════════════════════════════════════════════════
// Check 1: Plan alignment — changed files vs declared intent
// ═══════════════════════════════════════════════════════════

/**
 * Compare actually-modified files against what the current plan node
 * describes. We don't read model output — we check whether the file
 * paths overlap semantically with the plan node's domain keywords.
 */

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  backend:  ["server", "api", "routes", "hono", "express", "bun", "index.ts", "middleware", "handler"],
  frontend: ["client", "app", "page", "html", "css", "component", "react", "vite", "browser", "render", "dom", "style"],
  data:     ["data", "json", "posts", "store", "storage", "db", "sql", "schema", "model"],
  test:     ["test", "spec", "verify", "assert", "expect", "beforeAll", "afterAll"],
  config:   ["package.json", "tsconfig", "config", "env", "lock", "gitignore", "docker"],
  infra:    ["ci", "deploy", "build", "dist", "out", "public", "assets", "static"],
}

function classifyFile(path: string): string[] {
  const p = path.toLowerCase()
  const cats: string[] = []
  for (const [cat, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    if (keywords.some(kw => p.includes(kw))) cats.push(cat)
  }
  return cats.length ? cats : ["unknown"]
}

function classifyPlanIntent(currentNodeTitle: string): string[] {
  const lower = currentNodeTitle.toLowerCase()
  const cats: string[] = []
  for (const [cat, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) cats.push(cat)
  }
  return cats.length ? cats : ["unknown"]
}

export function checkPlanAlignment(
  changedFiles: string[],
  currentNodeTitle: string | undefined,
): { aligned: boolean; unexpectedCount: number; actions: MonitorAction[] } {
  if (!currentNodeTitle || changedFiles.length === 0) return { aligned: true, unexpectedCount: 0, actions: [] }

  const planCats = classifyPlanIntent(currentNodeTitle)
  const unexpected: string[] = []

  for (const f of changedFiles) {
    const fileCats = classifyFile(f)
    const overlap = fileCats.some(c => planCats.includes(c))
    if (!overlap && !fileCats.includes("config") && !fileCats.includes("test")) {
      unexpected.push(f)
    }
  }

  const actions: MonitorAction[] = []
  if (unexpected.length >= 3) {
    actions.push({
      level: "ALARM",
      check: "plan-alignment",
      message: `[Monitor] ${unexpected.length} 个文件可能偏离计划 (${unexpected.slice(0, 5).join(", ")})`,
      injectPrompt: `警告: 本轮修改了 ${unexpected.length} 个不属于当前计划节点的文件。检查是否在执行计划外的操作。`,
    })
  } else if (unexpected.length >= 1 && changedFiles.length >= 5) {
    actions.push({
      level: "WARNING",
      check: "plan-alignment",
      message: `[Monitor] 1-2 个文件不在当前计划域内 (${unexpected.join(", ")}) — 可能是合理的跨域修改`,
      injectPrompt: `注意: 你改了 ${unexpected.join(", ")}，这些文件不在当前计划节点范围内。如果这是有意的跨域变更，请用 task add 补充。`,
    })
  }

  return { aligned: unexpected.length === 0, unexpectedCount: unexpected.length, actions }
}

// ═══════════════════════════════════════════════════════════
// Check 2: Cold memory integrity — SHA + periodic semantic audit
// ═══════════════════════════════════════════════════════════

interface ColdMemorySnapshot {
  round: number
  sha: string
  tokenCount: number
  /** Original thinking fragments used to produce this snapshot */
  sourceFragments: string[]
}

export class ColdMemoryGuard {
  private snapshots: ColdMemorySnapshot[] = []
  private readonly MAX_SNAPSHOTS = 6
  private immutableArchive: Map<number, { sha: string; fragments: string[] }> = new Map()

  /** Record a snapshot BEFORE thinking is stripped. */
  record(round: number, memory: string, sourceThinkingFragments: string[]) {
    const sha = createHash("sha256").update(memory).digest("hex").slice(0, 16)
    const tokenCount = Math.ceil(memory.length / 2.5)
    this.snapshots.push({ round, sha, tokenCount, sourceFragments: sourceThinkingFragments.slice(0, 3) })
    if (this.snapshots.length > this.MAX_SNAPSHOTS) {
      const removed = this.snapshots.shift()!
      // Archive the removed one — we may need it for audit
      this.immutableArchive.set(removed.round, { sha: removed.sha, fragments: removed.sourceFragments })
    }
  }

  /** Basic structural checks. Returns actions. */
  check(round: number, memory: string): MonitorAction[] {
    const sha = createHash("sha256").update(memory).digest("hex").slice(0, 16)
    const tokenCount = Math.ceil(memory.length / 2.5)
    const prev = this.snapshots[this.snapshots.length - 1]
    const actions: MonitorAction[] = []

    if (!prev) {
      this.record(round, memory, [])
      return []
    }

    const tokenDelta = tokenCount - prev.tokenCount

    // Token spike: >4K growth in ≤3 rounds → Flash may be dumping noise
    if (tokenDelta > 4000 && round - prev.round <= 3) {
      actions.push({
        level: "ALARM",
        check: "cold-memory",
        message: `[Monitor] 冷记忆增长过快: +${tokenDelta} tokens/${round - prev.round} 轮`,
        injectPrompt: `冷记忆最近增长过快 (+${tokenDelta} tokens)，可能包含冗余条目。下一轮请检查冷记忆内容是否准确。`,
      })
    }

    // SHA unchanged for ≥8 rounds → possible compression stall
    if (sha === prev.sha && round - prev.round >= 8) {
      actions.push({
        level: "WARNING",
        check: "cold-memory",
        message: `[Monitor] 冷记忆 ${round - prev.round} 轮 SHA 不变 — 压缩可能停滞`,
      })
    }

    this.record(round, memory, [])
    return actions
  }

  /**
   * Every N rounds, run an independent audit: does compressed memory
   * faithfully represent the original thinking? Uses a separate Flash call.
   */
  async audit(
    round: number,
    currentMemory: string,
    streamChat: (system: string, prompt: string) => AsyncGenerator<{ type: string; data?: unknown }>,
  ): Promise<MonitorAction[]> {
    if (round % 6 !== 0 || round < 6) return []

    const archived = this.immutableArchive.get(round - 4) ?? this.immutableArchive.get(round - 3)
    if (!archived) return []

    const fragments = archived.fragments.slice(0, 2).join("\n---\n").slice(0, 3000)
    if (fragments.length < 100) return []

    const prompt = [
      "对比原始思考片段和压缩后的冷记忆。判断压缩是否忠实于原文。",
      "",
      "规则:",
      "- 如果压缩引入了原文中没有的事实 → 返回 { faithful: false, issues: [...] }",
      "- 如果压缩遗漏了原文中的关键结论 → 返回 { faithful: false, issues: [...] }",
      "- 如果压缩准确反映了原文内容 → 返回 { faithful: true }",
      "- 最多找3个问题",
      "",
      "输出纯 JSON。",
      "",
      "## 原始思考片段",
      fragments,
      "",
      "## 压缩后冷记忆",
      currentMemory.slice(0, 3000),
    ].join("\n")

    try {
      const chunks: string[] = []
      for await (const ev of streamChat(
        "你是冷记忆审计器。输出纯 JSON。",
        prompt,
      )) {
        if (ev.type === "text" && typeof ev.data === "string") chunks.push(ev.data)
      }
      const text = chunks.join("").trim()
      const json = text.match(/\{[\s\S]*\}/)
      if (!json) return []
      const result = JSON.parse(json[0]) as { faithful?: boolean; issues?: string[] }
      if (!result.faithful && result.issues?.length) {
        return [{
          level: "ALARM",
          check: "cold-memory-audit",
          message: `[Monitor] 冷记忆审计: 压缩引入错误 — ${result.issues.join("; ")}`,
          injectPrompt: `冷记忆审计发现压缩不准确: ${result.issues.join("; ")}。请不要完全信任冷记忆中的内容。`,
        }]
      }
    } catch { /* audit is best-effort */ }

    return []
  }
}

// ═══════════════════════════════════════════════════════════
// Check 3: Independent progress signal — NOT model-reported
// ═══════════════════════════════════════════════════════════

/**
 * Progress is measured by file writes (count, type) and test output (pass/fail).
 * Neither depends on model honesty — both are actual system events.
 */

export interface ProgressState {
  filesWritten: number
  testsRun: number
  testsPassed: number
  roundsSinceLastWrite: number
  roundsSinceLastTest: number
}

export function initProgressState(): ProgressState {
  return { filesWritten: 0, testsRun: 0, testsPassed: 0, roundsSinceLastWrite: 0, roundsSinceLastTest: 0 }
}

export function updateProgressState(
  state: ProgressState,
  input: { wroteFiles: number; ranTests: boolean; testsPassed: boolean },
): ProgressState {
  const next = { ...state }
  if (input.wroteFiles > 0) {
    next.filesWritten += input.wroteFiles
    next.roundsSinceLastWrite = 0
  } else {
    next.roundsSinceLastWrite++
  }
  if (input.ranTests) {
    next.testsRun++
    next.roundsSinceLastTest = 0
    if (input.testsPassed) next.testsPassed++
  } else {
    next.roundsSinceLastTest++
  }
  return next
}

export function checkProgress(state: ProgressState, isPlanningPhase: boolean): MonitorAction[] {
  const actions: MonitorAction[] = []
  if (isPlanningPhase) return actions

  // 3 rounds no writes → self-check injection (not idle if reading/searching heavily)
  if (state.roundsSinceLastWrite === 3) {
    actions.push({
      level: "WARNING",
      check: "progress",
      message: `[Monitor] 3 轮无文件写入 — 是否卡住了？`,
      injectPrompt: "你最近 3 轮没有写任何文件。检查：当前任务是否被阻塞？是否需要切换到不同的方法？",
    })
  }

  // 5 rounds no writes → ALARM
  if (state.roundsSinceLastWrite === 5) {
    actions.push({
      level: "ALARM",
      check: "progress",
      message: `[Monitor] 5 轮无文件写入 — 严重停滞`,
      injectPrompt: "你已经 5 轮没有写任何文件了。序列化当前进度并考虑向用户求助或切换到不同的任务节点。",
    })
  }

  // 8 rounds no writes → BLOCK
  if (state.roundsSinceLastWrite >= 8) {
    actions.push({
      level: "BLOCK",
      check: "progress",
      message: `[Monitor] ${state.roundsSinceLastWrite} 轮无文件写入 — 强制中断`,
      incident: [
        "## 事故报告: 进度停滞",
        `文件写入: ${state.filesWritten} 总`,
        `测试运行: ${state.testsRun} 次 (${state.testsPassed} 通过)`,
        `停滞轮数: ${state.roundsSinceLastWrite}`,
        "可能原因: 搜索循环、计划错误、模型幻觉",
      ].join("\n"),
    })
  }

  // Tests ran and all passed → positive signal, no negative action needed
  // Tests ran and some failed → not a stall, repair is progress

  return actions
}

// ═══════════════════════════════════════════════════════════
// Unified monitor
// ═══════════════════════════════════════════════════════════

let coldGuard = new ColdMemoryGuard()
let progress = initProgressState()

export function resetMonitor() {
  coldGuard = new ColdMemoryGuard()
  progress = initProgressState()
}

export function monitorRoundSync(input: {
  round: number
  taskHadWrite: boolean
  modifiedFiles: string[]
  modifiedCount: number
  currentNodeTitle?: string
  coldMemory?: string
  isPlanning: boolean
  ranTests: boolean
  testsPassed: boolean
}): { actions: MonitorAction[]; events: StreamEvent[] } {
  const actions: MonitorAction[] = []

  // ── Progress update (independent of model) ──
  progress = updateProgressState(progress, {
    wroteFiles: input.modifiedCount,
    ranTests: input.ranTests,
    testsPassed: input.testsPassed,
  })

  // ── Check 1: Plan alignment ──
  if (input.taskHadWrite && input.currentNodeTitle) {
    const alignment = checkPlanAlignment(input.modifiedFiles, input.currentNodeTitle)
    actions.push(...alignment.actions)
  }

  // ── Check 2: Cold memory ──
  if (input.coldMemory) {
    const cmActions = coldGuard.check(input.round, input.coldMemory)
    actions.push(...cmActions)
    coldGuard.record(input.round, input.coldMemory, [])
  }

  // ── Check 3: Progress ──
  actions.push(...checkProgress(progress, input.isPlanning))

  // ── Emit events + inject prompts ──
  const events: StreamEvent[] = []
  for (const action of actions) {
    events.push({ type: "status", data: action.message })
    // Inject into next round's system context
    if (action.injectPrompt) {
      events.push({ type: "status", data: `monitor-action: ${action.injectPrompt}` })
    }
  }

  return { actions, events }
}

/** Async audit (called by loop when coldGuard says it's time). */
export async function monitorColdAudit(
  round: number,
  memory: string,
  streamChat: (system: string, prompt: string) => AsyncGenerator<{ type: string; data?: unknown }>,
): Promise<MonitorAction[]> {
  return coldGuard.audit(round, memory, streamChat)
}
