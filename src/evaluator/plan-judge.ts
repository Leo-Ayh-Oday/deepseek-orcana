/** [Phase 2] PlanJudge — independent plan quality evaluator.
 *
 *  Status: IMPLEMENTED, NOT YET WIRED into loop.ts.
 *  Will be called at plan→code transition to validate plan quality before
 *  the agent starts writing code. Integrates with MasterPlan.reviewGate().
 *
 *  Inspired by MiMo goal.ts: a separate, cold model evaluates the plan
 *  based on transcript evidence only. Temperature 0, structured JSON output.
 *
 *  Key differences from ConfidenceEvaluator:
 *    - ConfidenceEvaluator evaluates CODE OUTPUT quality (tests, typecheck, ripple)
 *    - PlanJudge evaluates PLAN QUALITY (feasibility, completeness, risk)
 *    - PlanJudge runs BEFORE plan→code transition
 *    - PlanJudge can override the working agent's optimism about its own plan
 *
 *  Invariants:
 *    - Judge only reads the plan + transcript, never does the work
 *    - Judge confidence ≤ 0.8 (hard cap, same as ConfidenceEvaluator)
 *    - Judge verdict overrides agent self-assessment
 *    - "impossible" requires independent confirmation, not just agent's claim
 */

import type { LLMProvider } from "../provider/types"
import type { MasterPlan } from "../agent/master-plan"
import { shouldSkipProviderPurpose } from "../provider/cost-policy"

// ── Verdict types (MiMo-compatible) ──

export interface PlanJudgment {
  /** 0-1 overall plan quality estimate */
  confidence: number
  /** Per-dimension scores */
  dimensions: {
    feasibility: number     // 0-1: is this technically achievable?
    completeness: number    // 0-1: does the plan cover all requirements?
    risk: number            // 0-1: higher = riskier (inverted in confidence)
  }
  /** Binary verdict */
  verdict: "approve" | "needs_revision" | "impossible"
  /** Specific critique — what's wrong and how to fix */
  critique: string
  /** Suggested remedy if needs_revision */
  suggestion?: string
  /** Evidence quoted from the plan/transcript */
  evidence: string[]
}

export interface PlanJudgeInput {
  plan: MasterPlan
  /** Short summary of user's original request */
  userGoal: string
  /** Relevant context: files read, tools used, errors encountered */
  context: string
  /** Optional: agent's self-assessment of the plan */
  agentSelfAssessment?: string
}

// ── Thresholds ──

const APPROVE_THRESHOLD = 0.6    // ≥60% confidence → approve
const IMPOSSIBLE_THRESHOLD = 0.2 // <20% confidence → impossible
// 20-59% → needs_revision

const CONFIDENCE_CAP = 0.8

// ── Judge system prompt (MiMo-inspired) ──

const JUDGE_SYSTEM = [
  "You are a plan quality evaluator — a cold, skeptical judge.",
  "Your job: independently evaluate whether an agent's plan is likely to succeed.",
  "",
  "You are NOT the working agent. You do not write code, call tools, or trust the agent's self-assessment.",
  "You only read the plan and evidence. Your verdict must be based on evidence, not optimism.",
  "",
  "## Evaluation dimensions",
  "",
  "1. Feasibility (0-1): Is each step technically achievable with the described approach?",
  "   - 0.9+: straightforward implementation, well-understood patterns",
  "   - 0.5-0.8: achievable but requires care (complex API, edge cases)",
  "   - 0.2-0.4: significant uncertainty, unclear if approach will work",
  "   - 0.0-0.1: technically impossible (tool doesn't exist, constraint violation)",
  "",
  "2. Completeness (0-1): Does the plan cover ALL requirements stated by the user?",
  "   - 0.9+: every requirement has a matching plan node",
  "   - 0.5-0.8: most covered, minor gaps",
  "   - 0.2-0.4: major requirements missing",
  "   - 0.0-0.1: plan misses the core requirement entirely",
  "",
  "3. Risk (0-1, higher = riskier): What could go wrong?",
  "   - 0.0-0.2: low risk, well-tested approach",
  "   - 0.3-0.5: moderate risk (external dependencies, new library)",
  "   - 0.6-0.8: high risk (data loss, breaking changes, untested approach)",
  "   - 0.9-1.0: extreme risk (security vulnerability, irreversible operation)",
  "",
  "## Verdict rules",
  "",
  "- **approve**: confidence ≥ 0.6, no fatal gaps or impossible steps",
  "- **needs_revision**: confidence 0.2-0.59, or specific fixable gaps found",
  "- **impossible**: confidence < 0.2, or a step is genuinely unachievable",
  "",
  'IMPORTANT: "impossible" means you have independently confirmed the plan CANNOT work.',
  "The agent saying 'this is impossible' is evidence, not proof — verify yourself.",
  "When in doubt between needs_revision and impossible, choose needs_revision.",
  "",
  "## Counter optimism",
  "",
  "The working agent may claim 'this plan looks good' when it is not.",
  "Be skeptical. Look for:",
  "- Scope creep: is the plan doing more than the user asked?",
  "- Missing verification: are steps testable and verifiable?",
  "- Dependency blindness: does the plan ignore existing code constraints?",
  "- Timeline delusion: are too many steps planned for one session?",
  "- Technology mismatch: using wrong tools for the problem?",
  "",
  "## Output format",
  "",
  "Respond with ONLY a JSON object — no markdown, no code fences, no explanation:",
  '{',
  '  "feasibility": <0-1>,',
  '  "completeness": <0-1>,',
  '  "risk": <0-1>,',
  '  "verdict": "approve" | "needs_revision" | "impossible",',
  '  "critique": "<specific, actionable critique>",',
  '  "suggestion": "<what to change, if needs_revision>",',
  '  "evidence": ["<quote from plan>", "<quote from context>"]',
  '}',
].join("\n")

// ── Build judge prompt ──

function buildJudgePrompt(input: PlanJudgeInput): string {
  const lines: string[] = []

  lines.push("## User Goal")
  lines.push(input.userGoal)
  lines.push("")

  lines.push("## Agent's Plan")
  lines.push(`Goal: ${input.plan.goal}`)
  lines.push(`Nodes (${input.plan.nodes.length}):`)
  for (const node of input.plan.nodes) {
    const icon = node.status === "done" ? "✅" : node.status === "active" ? "🔄" : node.status === "blocked" ? "🟡" : "🔵"
    lines.push(`  ${icon} [${node.id}] ${node.title} (status: ${node.status}, react: ${node.reactCount})`)
    if (node.dependsOn.length) lines.push(`      depends on: ${node.dependsOn.join(", ")}`)
  }
  lines.push(`Current active node: ${input.plan.current}`)
  lines.push(`Plan age: ${Math.round((Date.now() - input.plan.createdAt) / 60000)} minutes`)
  lines.push("")

  lines.push("## Context & Evidence")
  lines.push(input.context || "(no context provided)")
  lines.push("")

  if (input.agentSelfAssessment) {
    lines.push("## Agent's Self-Assessment")
    lines.push(input.agentSelfAssessment)
    lines.push("")
    lines.push("Note: the agent's self-assessment may be overly optimistic. Verify independently.")
    lines.push("")
  }

  lines.push("Based on the plan and evidence above, evaluate the plan quality.")
  lines.push("Remember: output ONLY the JSON object, no markdown wrapping.")

  return lines.join("\n")
}

// ── Parse structured output ──

interface RawJudgment {
  feasibility?: number
  completeness?: number
  risk?: number
  verdict?: string
  critique?: string
  suggestion?: string
  evidence?: string[]
}

function parseJudgment(text: string): RawJudgment | null {
  // Strip any accidental markdown code fences
  let cleaned = text.trim()
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")
  }

  try {
    const parsed = JSON.parse(cleaned) as RawJudgment
    // Validate required fields exist
    if (typeof parsed.feasibility !== "number") return null
    if (typeof parsed.completeness !== "number") return null
    if (typeof parsed.risk !== "number") return null
    return parsed
  } catch {
    return null
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function computeConfidence(dimensions: { feasibility: number; completeness: number; risk: number }): number {
  // Risk is inverted (high risk → low confidence impact)
  const riskPenalty = 1 - dimensions.risk
  // Weighted geometric mean — one bad dimension drags everything down
  const clamped = [
    Math.max(0.01, dimensions.feasibility),
    Math.max(0.01, dimensions.completeness),
    Math.max(0.01, riskPenalty),
  ]
  const weights = [0.4, 0.35, 0.25] // feasibility > completeness > risk
  let logSum = 0, weightSum = 0
  for (let i = 0; i < clamped.length; i++) {
    logSum += Math.log(clamped[i]!) * weights[i]!
    weightSum += weights[i]!
  }
  const raw = Math.exp(logSum / weightSum)
  return Math.min(raw, CONFIDENCE_CAP)
}

// ── Main evaluator ──

export class PlanJudge {
  private provider: LLMProvider

  constructor(provider: LLMProvider) {
    this.provider = provider
  }

  /**
   * Evaluate a plan independently.
   *
   * Uses a separate model call (Flash/deepseek-chat) with no tools,
   * structured JSON output, and temperature effectively 0 via thinking=disabled.
   * The judge only reads evidence — it does not do the work.
   */
  async evaluate(input: PlanJudgeInput): Promise<PlanJudgment> {
    if (shouldSkipProviderPurpose("plan_judge")) {
      return this.fallbackJudgment(input, "cost-mode strict: skipped plan_judge")
    }

    const prompt = buildJudgePrompt(input)

    // Collect the full text response
    const events: string[] = []
    try {
      for await (const event of this.provider.streamChat({
        model: "deepseek-chat",  // Flash model for judge (cheaper, cold)
        purpose: "plan_judge",
        system: JUDGE_SYSTEM,
        messages: [{ role: "user", content: prompt }],
        maxTokens: 2048,
        // No tools, no thinking — judge only outputs JSON
      })) {
        if (event.type === "text" && typeof event.data === "string") {
          events.push(event.data)
        }
        if (event.type === "done" && typeof event.data === "string") {
          events.push(event.data)
        }
      }
    } catch {
      // Judge model unavailable → conservative fallback
      return this.fallbackJudgment(input, "Judge model unavailable — deferring to agent")
    }

    const text = events.join("").trim()
    const raw = parseJudgment(text)

    if (!raw) {
      // Parse failure → conservative fallback
      return this.fallbackJudgment(input, `Judge parse failed on: "${text.slice(0, 200)}"`)
    }

    const feasibility = clamp(raw.feasibility ?? 0.7, 0, 1)
    const completeness = clamp(raw.completeness ?? 0.7, 0, 1)
    const risk = clamp(raw.risk ?? 0.3, 0, 1)
    const confidence = computeConfidence({ feasibility, completeness, risk })

    let verdict: PlanJudgment["verdict"]
    if (confidence >= APPROVE_THRESHOLD && (raw.verdict !== "impossible")) {
      verdict = "approve"
    } else if (confidence < IMPOSSIBLE_THRESHOLD || raw.verdict === "impossible") {
      verdict = "impossible"
    } else {
      verdict = "needs_revision"
    }

    return {
      confidence: Math.round(confidence * 1000) / 1000,
      dimensions: {
        feasibility: Math.round(feasibility * 1000) / 1000,
        completeness: Math.round(completeness * 1000) / 1000,
        risk: Math.round(risk * 1000) / 1000,
      },
      verdict,
      critique: raw.critique ?? "No specific critique provided by judge.",
      suggestion: raw.suggestion,
      evidence: raw.evidence ?? [],
    }
  }

  /** Synchronous fallback: conservative approval with warning. */
  evaluateSync(input: PlanJudgeInput): PlanJudgment {
    return this.fallbackJudgment(input, "Synchronous path — skipping judge model")
  }

  private fallbackJudgment(input: PlanJudgeInput, reason: string): PlanJudgment {
    const nodeCount = input.plan.nodes.length
    const doneCount = input.plan.nodes.filter(n => n.status === "done").length
    // Simple heuristic: if all nodes done, approve; if none done and many nodes, needs_revision
    const heuristicConfidence = nodeCount === 0 ? 0.3
      : doneCount === nodeCount ? 0.7
      : doneCount > 0 ? 0.5
      : nodeCount > 5 ? 0.4
      : 0.5

    return {
      confidence: heuristicConfidence,
      dimensions: { feasibility: 0.5, completeness: 0.5, risk: 0.5 },
      verdict: heuristicConfidence >= 0.6 ? "approve" : "needs_revision",
      critique: `${reason}. Using heuristic assessment.`,
      evidence: [`plan nodes: ${nodeCount}, done: ${doneCount}`],
    }
  }
}
