/** Confidence scoring system with 80% hard cap.
 *
 * Why 80%?
 *   - No single agent can be 100% sure about code in a real codebase
 *   - The remaining 20% forces meta-agent negotiation
 *   - Prevents "arrogant agent" syndrome where one agent dominates
 *
 * Scoring dimensions (0-1 each, weighted):
 *   1. Specificity   — how concrete / verifiable is the claim?
 *   2. Consistency   — does it align with the original plan / requirements?
 *   3. Completeness  — are all edge cases / side effects covered?
 *   4. Verifiability — can the claim be checked by a deterministic test?
 */

// ── Types ──

export interface ConfidenceScore {
  /** Overall confidence: 0.0 - 0.80 (hard cap) */
  overall: number
  /** Dimension breakdown */
  dimensions: {
    specificity: number    // 0-1: concrete file paths, line numbers, code snippets
    consistency: number    // 0-1: aligns with plan and existing code style
    completeness: number   // 0-1: edge cases, errors, side effects covered
    verifiability: number  // 0-1: testable by typecheck / bun test / grep
  }
  /** Warnings that dragged the score down */
  warnings: string[]
}

export const CONFIDENCE_CAP = 0.80

// ── Heuristic scoring (deterministic, no LLM needed) ──

/** Keywords that indicate high specificity (concrete actions) */
const SPECIFICITY_SIGNALS = [
  /file:\s*[\w.\/\-]+/i,           // file path mentioned
  /line\s*[:#]?\s*\d+/i,            // line number
  /function\s+\w+/i,                // function name
  /`[^`]+`/,                        // inline code
  /参数\s*\w+/i,                    // parameter name
  /import\s+/i,                     // import statement
  /type\s*\{/i,                     // type annotation
  /edge\s*case/i,                   // edge case mentioned
]

/** Keywords that indicate low confidence / vagueness */
const VAGUENESS_SIGNALS = [
  /maybe/i, /perhaps/i, /might/i, /could/i,
  /大概|可能|也许|或许|说不定/,
  /I think/i, /I guess/i,
  /somehow/i, /some way/i,
  /need more context/i,
  /not sure/i,
]

/** Signals of completeness */
const COMPLETENESS_SIGNALS = [
  /test|测试/i,
  /edge case|边界/i,
  /error handling|错误处理/i,
  /type check/i,
  /side effect|副作用/i,
  /rollback|回退/i,
  /if.*fail/i,
  /catch/i,
]

/** Signals of verifiability */
const VERIFIABILITY_SIGNALS = [
  /bun test/i,
  /tsc/i,
  /typecheck/i,
  /grep/i,
  /find_symbol/i,
  /read_file/i,
  /git diff/i,
  /assert|expect/i,
]

// ── Scoring function ──

export function scoreConfidence(text: string, planRef?: string): ConfidenceScore {
  const warnings: string[] = []

  // 1. Specificity score
  let specificity = 0.0
  let specHits = 0
  for (const re of SPECIFICITY_SIGNALS) {
    if (re.test(text)) specHits++
  }
  specificity = Math.min(specHits / 4, 1.0) // 4+ signals = full

  let vagueHits = 0
  for (const re of VAGUENESS_SIGNALS) {
    if (re.test(text)) vagueHits++
  }
  specificity = Math.max(0, specificity - vagueHits * 0.25)
  if (vagueHits >= 3) warnings.push("高模糊度：输出包含大量不确定表述")

  // 2. Consistency score (if planRef provided)
  let consistency = 0.5 // neutral default
  if (planRef && planRef.length > 20) {
    // Check keyword overlap between plan and output
    const planTokens = new Set(
      planRef.toLowerCase().match(/\b[a-z_]{3,15}\b/g) ?? []
    )
    const outputTokens = text.toLowerCase().match(/\b[a-z_]{3,15}\b/g) ?? []
    const overlap = outputTokens.filter(t => planTokens.has(t)).length
    consistency = Math.min(overlap / Math.max(outputTokens.length, 1) * 2, 1.0)
  }
  if (consistency < 0.3 && planRef) warnings.push("与计划一致性低：输出偏离原计划")

  // 3. Completeness score
  let completeness = 0.0
  let compHits = 0
  for (const re of COMPLETENESS_SIGNALS) {
    if (re.test(text)) compHits++
  }
  completeness = Math.min(compHits / 4, 1.0)
  if (compHits === 0) warnings.push("完整性低：未考虑测试/边界/错误处理")

  // 4. Verifiability score
  let verifiability = 0.0
  let verHits = 0
  for (const re of VERIFIABILITY_SIGNALS) {
    if (re.test(text)) verHits++
  }
  verifiability = Math.min(verHits / 3, 1.0)
  if (verHits === 0) warnings.push("可验证性低：无法通过 typecheck/test/grep 验证")

  // Weighted overall (0-1)
  const weights = { specificity: 0.35, consistency: 0.25, completeness: 0.20, verifiability: 0.20 }
  const raw = (
    specificity * weights.specificity +
    consistency * weights.consistency +
    completeness * weights.completeness +
    verifiability * weights.verifiability
  )

  // Apply cap
  const overall = Math.min(raw, CONFIDENCE_CAP)

  return {
    overall: Math.round(overall * 100) / 100,
    dimensions: {
      specificity: Math.round(specificity * 100) / 100,
      consistency: Math.round(consistency * 100) / 100,
      completeness: Math.round(completeness * 100) / 100,
      verifiability: Math.round(verifiability * 100) / 100,
    },
    warnings,
  }
}

/** Format confidence as a compact string for agent prompts */
export function formatConfidence(score: ConfidenceScore): string {
  const bar = (v: number) => "█".repeat(Math.round(v * 10)).padEnd(10, "░")
  const pct = (v: number) => `${Math.round(v * 100)}%`

  return [
    `置信度: ${pct(score.overall)} (上限 ${pct(CONFIDENCE_CAP)})`,
    `  特异性:   ${bar(score.dimensions.specificity)} ${pct(score.dimensions.specificity)}`,
    `  一致性:   ${bar(score.dimensions.consistency)} ${pct(score.dimensions.consistency)}`,
    `  完整性:   ${bar(score.dimensions.completeness)} ${pct(score.dimensions.completeness)}`,
    `  可验证性: ${bar(score.dimensions.verifiability)} ${pct(score.dimensions.verifiability)}`,
    ...(score.warnings.length ? ["警告:", ...score.warnings.map(w => `  ⚠ ${w}`)] : []),
  ].join("\n")
}
