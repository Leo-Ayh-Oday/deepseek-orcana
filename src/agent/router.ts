/** Reasoning router - decides thinking mode, depth, and token budget per round.
 *
 * Silent work should happen inside provider thinking mode. The loop only
 * decides when deeper model-internal reasoning is justified.
 */

import type { ThinkingConfig } from "../provider/types"
import type { IntentMode } from "./intent"

const READONLY_TOOLS = new Set([
  "read_file", "find_symbol", "find_references", "project_structure",
  "read_definition", "web_search", "git_status", "git_diff", "git_log", "git_blame",
  "request_deeper_thinking",
])

export interface RoundState {
  roundNum: number
  priorTools: string[]
  priorFiles: Set<string>
  hadError: boolean
  hadFim: boolean
}

export interface ThinkingProfile {
  prompt?: string
  intentMode?: IntentMode
  planningPhase?: boolean
  contextUsagePercent?: number
  /** Objective auto-max triggers (model self-upgrade signal) */
  autoMaxSignals?: AutoMaxSignals
}

export interface AutoMaxSignals {
  consecutiveErrors: number
  modifiedFiles: number
}

export interface ThinkingDecision {
  thinking: ThinkingConfig | undefined
  maxTokens: number
  score: number
  reason: string
  factors: string[]
  visibleStatus: string
}

export function createState(): RoundState {
  return { roundNum: 0, priorTools: [], priorFiles: new Set(), hadError: false, hadFim: false }
}

const STRUCTURAL_PATTERNS = [
  /architecture|architectural|runtime|router|provider|agent|tool\s*use|tooling/i,
  /refactor|redesign|migration|cascade|impact|dependency|contract|quality\s*gate/i,
  /ripple|codegraph|lsp|ast|typecheck|compiler|verification|benchmark|eval/i,
  /cache|memory|context|compaction|checkpoint|resume|long[-\s]?task/i,
  /deep\s*thinking|think\s*deep|self[-\s]?critique|self[-\s]?reflect|reorganize|capability/i,
  /security|auth|permission|transaction|rollback|database|api|full[-\s]?stack/i,
  /架构|重构|运行时|推理|深度思考|深思|反思|自我反驳|自我推翻|重组|能力|测试|验证/i,
  /缓存|记忆|上下文|全栈|多文件|长任务/i,
]

const BROAD_SCOPE_PATTERNS = [
  /complete|entire|whole|end[-\s]?to[-\s]?end|production|project/i,
  /optimi[sz]e|improve|harden|stabili[sz]e|quality|polish/i,
  /完整|整个|生产|优化|深化|稳定|质量/i,
]

function matchCount(patterns: RegExp[], text: string): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0)
}

function scoreThinkingNeed(state: RoundState, profile?: ThinkingProfile): { score: number; factors: string[] } {
  const factors: string[] = []
  let score = 0
  const prompt = profile?.prompt?.trim() ?? ""

  if (/深度思考|深度分析|深思|认真思考|仔细思考|推演|反方|反驳|自我推翻|推翻自己|重组自己|智能体.*能力|agent.*capability/i.test(prompt)) {
    score += 7
    factors.push("明确要求深思")
  }

  if (profile?.intentMode === "long_task") {
    score += 5
    factors.push("长任务")
  }
  if (profile?.planningPhase) {
    score += 8
    factors.push("规划阶段（高优先级）")
  }
  if (prompt.length > 300) {
    score += 1
    factors.push("非简单问题")
  }
  if (prompt.length > 1200) {
    score += 2
    factors.push("长提示词")
  }

  const structural = matchCount(STRUCTURAL_PATTERNS, prompt)
  if (structural > 0) {
    score += Math.min(6, structural * 2)
    factors.push(`结构信号 x${structural}`)
  }

  const broad = matchCount(BROAD_SCOPE_PATTERNS, prompt)
  if (broad > 0) {
    score += Math.min(3, broad)
    factors.push(`范围较大 x${broad}`)
  }

  if (state.hadError) {
    score += 4
    factors.push("前轮有错误")
  }
  if (state.hadFim) {
    score += 4
    factors.push("FIM 编辑")
  }
  if (state.priorFiles.size >= 3) {
    score += 3
    factors.push(`多文件影响 ${state.priorFiles.size}`)
  } else if (state.priorFiles.size >= 2) {
    score += 1
    factors.push("双文件影响")
  }

  const hadWrite = state.priorTools.some(tool => !READONLY_TOOLS.has(tool))
  if (hadWrite) {
    score += 2
    factors.push("已经写入")
  }

  if (typeof profile?.contextUsagePercent === "number" && profile.contextUsagePercent >= 50) {
    score += 2
    factors.push(`上下文 ${profile.contextUsagePercent}%`)
  }

  return { score, factors }
}

export function decideThinkingPlan(
  state: RoundState,
  effortOverride?: "high" | "max",
  profile?: ThinkingProfile,
): ThinkingDecision {
  const { score, factors } = scoreThinkingNeed(state, profile)
  const hadWrite = state.priorTools.some(tool => !READONLY_TOOLS.has(tool))
  const readonlyOnly = state.priorTools.length > 0 && !hadWrite

  // ── Objective auto-max: force upgrade on error cascade or broad edit ──
  const autoMax = profile?.autoMaxSignals
  const forceMax = profile?.intentMode !== "readonly" && autoMax && (
    autoMax.consecutiveErrors >= 3 || autoMax.modifiedFiles >= 5
  )
  if (forceMax && effortOverride !== "high") {
    return {
      thinking: { type: "enabled", budget_tokens: 32768, effort: "max" },
      maxTokens: 8192,
      score: Math.max(score, 11),
      reason: `auto-max: ${autoMax!.consecutiveErrors >= 3 ? `${autoMax!.consecutiveErrors} errors` : ""}${autoMax!.consecutiveErrors >= 3 && autoMax!.modifiedFiles >= 5 ? " + " : ""}${autoMax!.modifiedFiles >= 5 ? `${autoMax!.modifiedFiles} files` : ""}`,
      factors: [...factors, "auto-max"],
      visibleStatus: `深度思考：最高 32K · auto-max · ${autoMax!.consecutiveErrors} errors / ${autoMax!.modifiedFiles} files`,
    }
  }

  const complexFirstRound = state.roundNum === 0 && score >= (profile?.intentMode === "readonly" ? 7 : 6)

  if (!complexFirstRound) {
    if (state.roundNum === 0) return noThinkingDecision(state, score, factors, "简单首轮")
    if (state.priorTools.length === 0) return noThinkingDecision(state, score, factors, "没有工具信号")
    if (readonlyOnly && score < 7) return noThinkingDecision(state, score, factors, "简单只读路径")
  }

  let thinking: ThinkingConfig
  let reason = "聚焦编辑"

  if (effortOverride === "max" || score >= 11) {
    thinking = { type: "enabled", budget_tokens: 32768, effort: "max" }
    reason = score >= 11 ? "深度结构预检" : "手动最高深度"
  } else if (state.hadFim || state.hadError || state.priorFiles.size >= 3 || score >= 6) {
    thinking = { type: "enabled", budget_tokens: 16384, effort: effortOverride ?? "max" }
    reason = "结构或修复路径"
  } else {
    thinking = { type: "enabled", budget_tokens: 8192, effort: effortOverride ?? "high" }
  }

  return {
    thinking,
    maxTokens: decideMaxTokens(thinking, state),
    score,
    reason,
    factors,
    visibleStatus: formatThinkingStatus(thinking, score, reason, factors),
  }
}

function noThinkingDecision(
  state: RoundState,
  score: number,
  factors: string[],
  reason: string,
): ThinkingDecision {
  return {
    thinking: undefined,
    maxTokens: decideMaxTokens(undefined, state),
    score,
    reason,
    factors,
    visibleStatus: "思考中",
  }
}

function formatThinkingStatus(thinking: ThinkingConfig, score: number, reason: string, factors: string[]): string {
  const budget = thinking.budget_tokens ? `${Math.round(thinking.budget_tokens / 1024)}k` : "auto"
  const effort = thinking.effort === "max" ? "最高" : "高"
  const factorText = factors.slice(0, 3).join("，") || "模型预检"
  return `深度思考：${effort} ${budget} · ${reason} · ${factorText} · 分数 ${score}`
}

export function decideThinking(
  state: RoundState,
  effortOverride?: "high" | "max",
  profile?: ThinkingProfile,
): ThinkingConfig | undefined {
  return decideThinkingPlan(state, effortOverride, profile).thinking
}

export function decideMaxTokens(thinking: ThinkingConfig | undefined, state: RoundState): number {
  if (state.hadFim) return 4096
  if (state.priorTools.includes("write_file")) return 16384
  if (thinking?.budget_tokens && thinking.budget_tokens >= 32768) return 6144
  if (state.priorFiles.size >= 3 && thinking) return 6144
  if (thinking) return 3072
  return 1024
}

export function updateState(state: RoundState, toolNames: string[], filePaths: string[], hadError: boolean): void {
  state.roundNum++
  state.priorTools = toolNames
  state.priorFiles = new Set(filePaths)
  state.hadError = hadError
  state.hadFim = toolNames.includes("edit_fim")
}
