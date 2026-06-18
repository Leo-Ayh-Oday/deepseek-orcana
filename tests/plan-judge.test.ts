import { describe, expect, test } from "bun:test"
import { PlanJudge, type PlanJudgeInput } from "../src/evaluator/plan-judge"
import type { MasterPlan } from "../src/agent/master-plan"
import { createMasterPlan } from "../src/agent/master-plan"

// ── Test helpers ──

function makePlan(overrides?: Partial<MasterPlan>): MasterPlan {
  const plan = createMasterPlan(
    "Build a REST API for user management",
    "long_task",
    ["Set up project structure", "Implement user model", "Add CRUD endpoints", "Write tests", "Add authentication"],
  )
  if (overrides) Object.assign(plan, overrides)
  return plan
}

function makeInput(plan: MasterPlan, overrides?: Partial<PlanJudgeInput>): PlanJudgeInput {
  return {
    plan,
    userGoal: "Build a REST API for user management with CRUD endpoints and JWT auth",
    context: "Project uses Bun + Hono + SQLite. Existing codebase has middleware pattern established.",
    agentSelfAssessment: "The plan looks solid. We've broken it into 5 clear steps.",
    ...overrides,
  }
}

// ── Tests ──

describe("PlanJudge — evaluateSync (heuristic fallback)", () => {
  const judge = new PlanJudge(null as any) // null provider → always uses sync fallback

  test("empty plan → low confidence, needs_revision", () => {
    const plan = makePlan()
    plan.nodes = []
    const result = judge.evaluateSync(makeInput(plan))
    expect(result.confidence).toBeLessThan(0.5)
    expect(result.verdict).toBe("needs_revision")
  })

  test("all nodes done → high confidence, approve", () => {
    const plan = makePlan()
    for (const n of plan.nodes) n.status = "done"
    const result = judge.evaluateSync(makeInput(plan))
    expect(result.confidence).toBeGreaterThanOrEqual(0.6)
    expect(result.verdict).toBe("approve")
  })

  test("many nodes, none done → moderate confidence, needs_revision", () => {
    const plan = makePlan()
    // 5 nodes, all pending
    const result = judge.evaluateSync(makeInput(plan))
    expect(result.confidence).toBeLessThan(0.6)
    expect(result.verdict).toBe("needs_revision")
  })

  test("some nodes done → moderate confidence", () => {
    const plan = makePlan()
    plan.nodes[0]!.status = "done"
    plan.nodes[1]!.status = "active"
    const result = judge.evaluateSync(makeInput(plan))
    // doneCount > 0 → heuristic 0.5
    expect(result.confidence).toBe(0.5)
    expect(result.dimensions.feasibility).toBe(0.5)
  })
})

describe("PlanJudge — computeConfidence edge cases", () => {
  const judge = new PlanJudge(null as any)

  test("perfect dimensions → capped at 0.8", () => {
    const plan = makePlan()
    for (const n of plan.nodes) n.status = "done"
    // all-done plan gets high heuristic
    const result = judge.evaluateSync(makeInput(plan))
    expect(result.confidence).toBeLessThanOrEqual(0.8)
  })

  test("zero feasibility → very low confidence", () => {
    const plan = makePlan()
    plan.nodes = [] // empty plan
    const result = judge.evaluateSync(makeInput(plan, {
      agentSelfAssessment: "This might be impossible with the current toolset",
    }))
    expect(result.confidence).toBeLessThan(0.4)
  })

  test("judge includes evidence in output", () => {
    const plan = makePlan()
    const result = judge.evaluateSync(makeInput(plan))
    expect(result.evidence).toBeInstanceOf(Array)
    expect(result.evidence.length).toBeGreaterThan(0)
  })

  test("critique is always a string", () => {
    const plan = makePlan()
    const result = judge.evaluateSync(makeInput(plan))
    expect(typeof result.critique).toBe("string")
    expect(result.critique.length).toBeGreaterThan(0)
  })
})

describe("PlanJudge — verdict boundaries", () => {
  const judge = new PlanJudge(null as any)

  test("approve requires confidence ≥ 0.6", () => {
    const plan = makePlan()
    for (const n of plan.nodes) n.status = "done"
    const result = judge.evaluateSync(makeInput(plan))
    if (result.verdict === "approve") {
      expect(result.confidence).toBeGreaterThanOrEqual(0.6)
    }
  })

  test("verdict is never undefined", () => {
    const plan = makePlan()
    const result = judge.evaluateSync(makeInput(plan))
    expect(["approve", "needs_revision", "impossible"]).toContain(result.verdict)
  })
})
