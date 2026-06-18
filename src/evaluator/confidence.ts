/** Confidence evaluator — deterministic + LLM scoring, capped at 80%. */

import type {
  EvaluationResult,
  EvaluatorWeights,
  LLMScoreInput,
  LLMScoreOutput,
  ObjectiveSignals,
  TestResults,
} from "./types"
import type { LLMProvider } from "../provider/types"
import { buildLLMScorePrompt, parseLLMScoreResponse } from "./prompts"
import { shouldSkipProviderPurpose } from "../provider/cost-policy"

const DEFAULT_WEIGHTS: EvaluatorWeights = {
  objectiveWeight: 0.6,
  testWeight: 0.4,
  typecheckWeight: 0.3,
  rippleWeight: 0.2,
  lintWeight: 0.1,
}

/** Upper cap — no automated system can reach 100% confidence */
const CONFIDENCE_CAP = 0.8

// ── Thresholds for recommendation ──
const ACCEPT_THRESHOLD = 0.7   // ≥70% → accept
const RETRY_THRESHOLD = 0.4    // <40% → retry
// 40-69% → review

// ── Individual signal scorers ──

function scoreTests(tr?: TestResults): number {
  if (!tr || tr.total === 0) return 0.5  // no tests = neutral (not bad, not good)
  return tr.passed / tr.total
}

function scoreTypecheck(tc?: { passed: boolean; issues: number }): number {
  if (!tc) return 0.5
  return tc.passed ? 1.0 : Math.max(0.25, 1.0 - tc.issues * 0.2)
}

function scoreRipple(decision?: string): number {
  switch (decision) {
    case "allow": return 1.0
    case "warn": return 0.6
    case "block": return 0.0
    default: return 0.5
  }
}

function scoreLint(lint?: { issues: number }): number {
  if (!lint) return 0.5
  return Math.max(0, 1.0 - lint.issues * 0.1)
}

/** Weighted geometric mean — pulls score down hard if any dimension is very low */
function weightedGeometricMean(scores: number[], weights: number[]): number {
  if (scores.length === 0) return 0.5
  // Clamp scores to avoid log(0)
  const clamped = scores.map(s => Math.max(s, 0.001))
  let logSum = 0
  let weightSum = 0
  for (let i = 0; i < clamped.length; i++) {
    logSum += Math.log(clamped[i]!) * weights[i]!
    weightSum += weights[i]!
  }
  return Math.exp(logSum / weightSum)
}

// ── Main evaluator ──

export class ConfidenceEvaluator {
  private weights: EvaluatorWeights
  private provider?: LLMProvider
  private llmScoreModel: string

  constructor(provider?: LLMProvider, weights?: Partial<EvaluatorWeights>, llmScoreModel = "deepseek-v4-pro") {
    this.provider = provider
    this.weights = { ...DEFAULT_WEIGHTS, ...weights }
    this.llmScoreModel = llmScoreModel
  }

  // ── Public API ──

  /** Full evaluation: objective + optional LLM */
  async evaluate(
    signals: ObjectiveSignals,
    llmInput?: LLMScoreInput,
  ): Promise<EvaluationResult> {
    const w = this.weights
    const testScore = scoreTests(signals.testResults)
    const tcScore = scoreTypecheck(signals.typecheck)
    const rippleScore = scoreRipple(signals.rippleDecision)
    const lintScore = scoreLint(signals.lint)

    // Weighted geometric mean for objective — one failure drags everything down
    const objectiveScore = weightedGeometricMean(
      [testScore, tcScore, rippleScore, lintScore],
      [w.testWeight, w.typecheckWeight, w.rippleWeight, w.lintWeight],
    )

    // LLM scoring (async)
    let llmScore: number | undefined
    let llmSubScores: LLMScoreOutput | undefined
    if (llmInput && this.provider && !shouldSkipProviderPurpose("completion_judge")) {
      try {
        llmSubScores = await this.scoreWithLLM(llmInput)
        llmScore = llmSubScores.overall
      } catch {
        // LLM scoring failed — skip it, rely on objective only
      }
    }

    // Combine
    const rawScore = llmScore != null
      ? w.objectiveWeight * objectiveScore + (1 - w.objectiveWeight) * llmScore
      : objectiveScore

    const confidence = signals.rippleDecision === "block"
      ? 0.02
      : Math.min(rawScore * CONFIDENCE_CAP, CONFIDENCE_CAP)

    const recommendation = confidence >= ACCEPT_THRESHOLD ? "accept"
      : confidence < RETRY_THRESHOLD ? "retry"
      : "review"

    const summary = this.buildSummary(confidence, objectiveScore, llmScore, signals, recommendation)

    return {
      confidence: Math.round(confidence * 1000) / 1000,
      rawScore: Math.round(rawScore * 1000) / 1000,
      objectiveScore: Math.round(objectiveScore * 1000) / 1000,
      llmScore: llmScore != null ? Math.round(llmScore * 1000) / 1000 : undefined,
      breakdown: {
        testScore: Math.round(testScore * 1000) / 1000,
        typecheckScore: Math.round(tcScore * 1000) / 1000,
        rippleScore: Math.round(rippleScore * 1000) / 1000,
        lintScore: Math.round(lintScore * 1000) / 1000,
        llmSubScores,
      },
      recommendation,
      summary,
    }
  }

  /** Synchronous evaluation — objective only, no LLM call */
  evaluateSync(signals: ObjectiveSignals): EvaluationResult {
    const result: EvaluationResult = {
      confidence: 0,
      rawScore: 0,
      objectiveScore: 0,
      breakdown: { testScore: 0, typecheckScore: 0, rippleScore: 0, lintScore: 0 },
      recommendation: "review",
      summary: "",
    }
    // Reuse the scoring logic without LLM
    const w = this.weights
    result.breakdown.testScore = scoreTests(signals.testResults)
    result.breakdown.typecheckScore = scoreTypecheck(signals.typecheck)
    result.breakdown.rippleScore = scoreRipple(signals.rippleDecision)
    result.breakdown.lintScore = scoreLint(signals.lint)

    result.objectiveScore = weightedGeometricMean(
      [result.breakdown.testScore, result.breakdown.typecheckScore, result.breakdown.rippleScore, result.breakdown.lintScore],
      [w.testWeight, w.typecheckWeight, w.rippleWeight, w.lintWeight],
    )
    result.rawScore = result.objectiveScore
    result.objectiveScore = Math.round(result.objectiveScore * 1000) / 1000
    result.rawScore = Math.round(result.rawScore * 1000) / 1000
    result.confidence = signals.rippleDecision === "block"
      ? 0.02
      : Math.min(result.rawScore * CONFIDENCE_CAP, CONFIDENCE_CAP)
    result.confidence = Math.round(result.confidence * 1000) / 1000
    result.recommendation = result.confidence >= ACCEPT_THRESHOLD ? "accept"
      : result.confidence < RETRY_THRESHOLD ? "retry" : "review"
    result.summary = this.buildSummary(result.confidence, result.objectiveScore, undefined, signals, result.recommendation)
    return result
  }

  // ── Private ──

  private async scoreWithLLM(input: LLMScoreInput): Promise<LLMScoreOutput> {
    if (!this.provider) throw new Error("No provider for LLM scoring")
    const prompt = buildLLMScorePrompt(input)
    const messages = [{ role: "user" as const, content: prompt }]

    const events: string[] = []
    for await (const event of this.provider.streamChat({
      model: this.llmScoreModel, // always use configured model for evaluation
      purpose: "completion_judge",
      system: "You are a code quality evaluator. Output ONLY valid JSON.",
      messages,
      maxTokens: 1024,
    })) {
      if (event.type === "text" && typeof event.data === "string") events.push(event.data)
      if (event.type === "done" && typeof event.data === "string") events.push(event.data)
    }

    const text = events.join("").trim()
    return parseLLMScoreResponse(text)
  }

  private buildSummary(
    confidence: number,
    objective: number,
    llmScore: number | undefined,
    signals: ObjectiveSignals,
    recommendation: "accept" | "review" | "retry",
  ): string {
    const pct = (n: number) => `${Math.round(n * 100)}%`
    const parts: string[] = [`置信度: ${pct(confidence)} (上限 80%)`]
    parts.push(`客观分: ${pct(objective)}`)
    if (llmScore != null) parts.push(`LLM评: ${pct(llmScore)}`)

    const details: string[] = []
    if (signals.testResults) {
      const t = signals.testResults
      details.push(`测试: ${t.passed}/${t.total} (${pct(scoreTests(t))})`)
    }
    if (signals.typecheck) {
      details.push(`类型检查: ${signals.typecheck.passed ? "✅" : `❌ ${signals.typecheck.issues}问题`}`)
    }
    if (signals.rippleDecision) {
      details.push(`Ripple: ${signals.rippleDecision}`)
    }
    if (details.length) parts.push(`  ${details.join(" · ")}`)

    const emoji = recommendation === "accept" ? "✅" : recommendation === "retry" ? "❌" : "⚠️"
    parts.push(`${emoji} 建议: ${recommendation}`)

    return parts.join("\n")
  }
}
