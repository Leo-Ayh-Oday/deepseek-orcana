/** Evaluator types — confidence scoring for agent outputs. */

import type { RippleDecision } from "../ripple/types"

// ── Objective signals ──

export interface TestResults {
  passed: number
  failed: number
  total: number
  output?: string
}

export interface TypecheckResult {
  passed: boolean
  issues: number
  output?: string
}

export interface LintResult {
  issues: number
  output?: string
}

export interface ObjectiveSignals {
  testResults?: TestResults
  typecheck?: TypecheckResult
  rippleDecision?: RippleDecision
  lint?: LintResult
  /** Extra signal: files touched, lines changed, tool errors */
  filesChanged?: number
  linesChanged?: number
  toolErrors?: number
}

// ── LLM scoring ──

export interface LLMScoreInput {
  /** Original user request */
  request: string
  /** The agent's output (code or response) */
  response: string
  /** Test results for context */
  testResults?: TestResults
  /** Any errors encountered */
  errors?: string[]
}

export interface LLMScoreOutput {
  correctness: number    // 0-1
  completeness: number   // 0-1
  style: number          // 0-1
  safety: number         // 0-1
  overall: number        // 0-1 weighted
  reasoning: string
}

// ── Final result ──

export interface EvaluationResult {
  /** Final confidence 0-1, capped at 0.8 */
  confidence: number
  /** Raw combined score before cap */
  rawScore: number
  /** Objective score 0-1 */
  objectiveScore: number
  /** LLM score 0-1 (undefined if skipped) */
  llmScore?: number
  /** Breakdown */
  breakdown: {
    testScore: number
    typecheckScore: number
    rippleScore: number
    lintScore: number
    llmSubScores?: LLMScoreOutput
  }
  /** Recommendation */
  recommendation: "accept" | "review" | "retry"
  /** Human-readable summary */
  summary: string
}

// ── Weights ──

export interface EvaluatorWeights {
  /** Weight of objective signals vs LLM (default 0.6) */
  objectiveWeight: number
  /** Within objective: test weight (default 0.4) */
  testWeight: number
  /** Within objective: typecheck weight (default 0.3) */
  typecheckWeight: number
  /** Within objective: ripple weight (default 0.2) */
  rippleWeight: number
  /** Within objective: lint weight (default 0.1) */
  lintWeight: number
}
