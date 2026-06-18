/** Meta-Agent — supervisor that monitors the main agent loop and intervenes
 *  when confidence is low or loop iterations exceed limits.
 *
 *  Inspired by SWE-agent's guardrail system and Claude's confidence scoring.
 *
 *  evaluate() → MetaDecision.CONTINUE | OVERRIDE | ESCALATE
 *
 *  Confidence signals:
 *    - Error rate: how many tool calls failed vs. succeeded per round
 *    - Round pressure: approaching maxRounds reduces confidence
 *    - Output staleness: when the agent stagnates (same files, no progress)
 *    - Test/typecheck results: diagnostics form a key quality signal
 */

import type { ToolDescriptor } from "../tools/registry"

// ── Decision enum ──

export enum MetaDecision {
  CONTINUE  = "CONTINUE",
  OVERRIDE  = "OVERRIDE",   // MetaAgent produces final answer
  ESCALATE  = "ESCALATE",   // Ask user for guidance
}

export interface RoundSummary {
  round: number
  toolNames: string[]
  toolResults: Array<{ name: string; success: boolean; content: string }>
  filePaths: string[]
  hadError: boolean
  outputText: string
  roundMs: number
}

export interface MetaVerdict {
  decision: MetaDecision
  confidence: number           // 0.0–1.0
  reason: string
  /** If OVERRIDE, the override message to inject */
  overrideMessage?: string
  /** If ESCALATE, the escalation prompt for the user */
  escalatePrompt?: string
}

// ── Confidence factors (weights) ──

const WEIGHTS = {
  errorPenalty:   0.35,   // per failed tool call
  roundPressure:  0.05,   // per round beyond safe zone
  staleness:      0.20,   // no new files touched
  outputBrevity:  0.10,   // very short output may indicate truncation
  diagnosticFail: 0.40,   // typecheck/test failure
} as const

const SAFE_ROUNDS = 5       // rounds before pressure starts
const MAX_CONFIDENCE = 1.0
const CONTINUE_THRESHOLD  = 0.55
const OVERRIDE_THRESHOLD   = 0.25  // below this, escalate instead of override

// ── MetaAgent ──

export class MetaAgent {
  private roundsSeen = 0
  private filesTouched = new Set<string>()
  private consecutiveNoProgress = 0
  private lastFileSet = ""

  /** Evaluate the current round and decide what happens next */
  evaluate(summary: RoundSummary, maxRounds: number): MetaVerdict {
    this.roundsSeen++

    // ═══ Compute confidence ═══
    let confidence = MAX_CONFIDENCE

    // 1. Error penalty
    const failed = summary.toolResults.filter(r => !r.success).length
    const total  = summary.toolResults.length || 1
    const errorRate = failed / total
    confidence -= errorRate * WEIGHTS.errorPenalty * 1.85

    // 2. Round pressure (only beyond safe zone)
    if (summary.round > SAFE_ROUNDS) {
      const excess = summary.round - SAFE_ROUNDS
      const remaining = Math.max(maxRounds - summary.round, 1)
      const pressure = excess / remaining
      confidence -= Math.min(pressure * WEIGHTS.roundPressure, 0.35)
    }

    // 3. Staleness — no new files touched
    const currentFiles = new Set(summary.filePaths)
    const newFiles = [...currentFiles].filter(f => !this.filesTouched.has(f))
    for (const f of currentFiles) this.filesTouched.add(f)

    if (newFiles.length === 0) {
      this.consecutiveNoProgress++
      confidence -= Math.min(this.consecutiveNoProgress * WEIGHTS.staleness, 0.35)
    } else {
      this.consecutiveNoProgress = 0
    }

    // 4. Output brevity — very short output with no tool calls
    if (summary.outputText.length < 40 && summary.toolNames.length === 0) {
      confidence -= WEIGHTS.outputBrevity
    }

    // 5. Diagnostic failures in results
    const diagFailCount = summary.toolResults.filter(r =>
      r.content.includes("[diagnostics]") &&
      (r.content.includes("error TS") || r.content.includes("error:") || r.content.includes("FAILED"))
    ).length
    confidence -= Math.min(diagFailCount * WEIGHTS.diagnosticFail, 0.5)

    // Clamp
    confidence = Math.max(0, Math.min(confidence, MAX_CONFIDENCE))
    confidence = Math.round(confidence * 100) / 100

    // ═══ Decide ═══

    // Hard stop: maxRounds reached
    if (summary.round >= maxRounds) {
      return {
        decision: MetaDecision.OVERRIDE,
        confidence,
        reason: `达到最大轮次 ${maxRounds}`,
        overrideMessage: this.buildOverride(summary),
      }
    }

    // Hard stop: 3+ consecutive rounds with no progress
    if (this.consecutiveNoProgress >= 3) {
      return {
        decision: MetaDecision.ESCALATE,
        confidence,
        reason: `连续 ${this.consecutiveNoProgress} 轮无新文件推进`,
        escalatePrompt: "Agent 在原地打转。您希望我(a)换一种方案重试, (b)缩小范围只改最核心文件, 还是(c)放弃并总结当前状态?",
      }
    }

    // High confidence → continue
    if (confidence >= CONTINUE_THRESHOLD) {
      return { decision: MetaDecision.CONTINUE, confidence, reason: `置信度 ${confidence} ≥ ${CONTINUE_THRESHOLD}` }
    }

    // Medium confidence → override (make a final decision)
    if (confidence >= OVERRIDE_THRESHOLD) {
      return {
        decision: MetaDecision.OVERRIDE,
        confidence,
        reason: `置信度 ${confidence} < ${CONTINUE_THRESHOLD}，由裁判代理做最终裁决`,
        overrideMessage: this.buildOverride(summary),
      }
    }

    // Low confidence → escalate to user
    return {
      decision: MetaDecision.ESCALATE,
      confidence,
      reason: `置信度过低 ${confidence} < ${OVERRIDE_THRESHOLD}`,
      escalatePrompt: "Agent 当前的置信度很低。您希望我(a)给出目前最好的答案, (b)回到上一轮重试, 还是(c)放弃?",
    }
  }

  /** Build an override message that summarizes what the agent has done */
  private buildOverride(summary: RoundSummary): string {
    const parts = [
      `\n[裁判介入] 经过 ${summary.round} 轮执行，置信度不足，这里是当前最佳结论：`,
    ]
    if (summary.toolResults.length > 0) {
      const done = summary.toolResults.filter(r => r.success)
      const failed = summary.toolResults.filter(r => !r.success)
      parts.push(`\n已完成: ${done.length} / ${summary.toolResults.length} 个工具调用`)
      if (failed.length > 0) {
        parts.push(`失败: ${failed.map(r => r.name).join(", ")}`)
      }
      const touched = [...new Set(summary.filePaths)]
      if (touched.length > 0) {
        parts.push(`涉及文件: ${touched.join(", ")}`)
      }
    }
    if (summary.outputText.length > 0) {
      parts.push(`\n[当前输出]\n${summary.outputText.slice(0, 1000)}`)
    }
    parts.push("\n建议：请确认以上结果是否符合预期。如需继续，请指明具体方向。")
    return parts.join("\n")
  }

  /** Reset internal state (for a new session) */
  reset() {
    this.roundsSeen = 0
    this.filesTouched.clear()
    this.consecutiveNoProgress = 0
    this.lastFileSet = ""
  }
}
