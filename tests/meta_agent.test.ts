import { describe, expect, test, beforeEach } from "bun:test"
import { MetaAgent, MetaDecision, RoundSummary } from "../src/agent/meta-agent"

function fresh(): MetaAgent { return new MetaAgent() }
function summary(overrides: Partial<RoundSummary>): RoundSummary {
  return {
    round: 1,
    toolNames: ["read_file"],
    toolResults: [{ name: "read_file", success: true, content: "file content here" }],
    filePaths: ["src/index.ts"],
    hadError: false,
    outputText: "I read the file and will proceed.",
    roundMs: 500,
    ...overrides,
  }
}

describe("MetaAgent", () => {
  let ma: MetaAgent
  beforeEach(() => { ma = fresh() })

  // ── CONTINUE cases ──
  test("high confidence round → CONTINUE", () => {
    const v = ma.evaluate(summary({ round: 1 }), 30)
    expect(v.decision).toBe(MetaDecision.CONTINUE)
    expect(v.confidence).toBeGreaterThanOrEqual(0.9)
  })

  test("reasonable error rate (1/4) → CONTINUE", () => {
    const v = ma.evaluate(summary({
      round: 1,
      toolNames: ["read", "web_search", "git_status", "shell"],
      toolResults: [
        { name: "read", success: true, content: "ok" },
        { name: "web_search", success: false, content: "connection refused" },
        { name: "git_status", success: true, content: "" },
        { name: "shell", success: true, content: "done" },
      ],
    }), 30)
    expect(v.decision).toBe(MetaDecision.CONTINUE)
    // 1/4 errors should drop but not below threshold
    expect(v.confidence).toBeGreaterThanOrEqual(0.5)
  })

  // ── OVERRIDE cases (medium confidence) ──
  test("many errors, round pressure → OVERRIDE", () => {
    const v = ma.evaluate(summary({
      round: 20,
      toolNames: ["write", "shell"],
      toolResults: [
        { name: "write", success: false, content: "permission denied" },
        { name: "shell", success: false, content: "command not found" },
      ],
      outputText: "",
    }), 30)
    expect(v.decision).toBe(MetaDecision.OVERRIDE)
    expect(v.overrideMessage).toBeDefined()
    expect(v.overrideMessage).toContain("裁判介入")
    expect(v.confidence).toBeLessThan(0.55)
    expect(v.confidence).toBeGreaterThanOrEqual(0.25)
  })

  test("three consecutive no-progress rounds → ESCALATE", () => {
    // Round 1: progress
    let v = ma.evaluate(summary({ round: 1, filePaths: ["a.ts"] }), 30)
    expect(v.decision).toBe(MetaDecision.CONTINUE)

    // Round 2: no new files
    v = ma.evaluate(summary({ round: 2, filePaths: ["a.ts"] }), 30)
    expect(v.decision).toBe(MetaDecision.CONTINUE)

    // Round 3: still no new files
    v = ma.evaluate(summary({ round: 3, filePaths: ["a.ts"] }), 30)
    expect(v.decision).toBe(MetaDecision.CONTINUE)

    // Round 4: third consecutive no-progress → ESCALATE
    v = ma.evaluate(summary({ round: 4, filePaths: ["a.ts"] }), 30)
    expect(v.decision).toBe(MetaDecision.ESCALATE)
    expect(v.escalatePrompt).toContain("Agent 在原地打转")
  })

  // ── Hard stop at maxRounds ──
  test("max rounds reached → OVERRIDE", () => {
    const v = ma.evaluate(summary({ round: 30, toolNames: [], toolResults: [], outputText: "" }), 30)
    expect(v.decision).toBe(MetaDecision.OVERRIDE)
    expect(v.reason).toContain("最大轮次")
  })

  // ── Diagnostic failures ──
  test("typecheck/test failure in results → lowered confidence", () => {
    const v = ma.evaluate(summary({
      round: 1,
      toolResults: [
        { name: "shell", success: true, content: "src/index.ts:10:5 - error TS2322: Type 'string' is not assignable to type 'number'.\n[diagnostics]\nsrc/index.ts:10:5 - error TS2322" },
      ],
    }), 30)
    // Should still CONTINUE on round 1 with just one diagnostic failure
    expect(v.decision).toBe(MetaDecision.CONTINUE)
    expect(v.confidence).toBeLessThan(0.7)
  })

  // ── Stagnation reset on new file ──
  test("new file resets stagnation counter", () => {
    ma.evaluate(summary({ round: 1, filePaths: ["a.ts"] }), 30)
    ma.evaluate(summary({ round: 2, filePaths: ["a.ts"] }), 30)
    // Now new file
    const v = ma.evaluate(summary({ round: 3, filePaths: ["b.ts"] }), 30)
    expect(v.decision).toBe(MetaDecision.CONTINUE)
    expect(v.confidence).toBeGreaterThan(0.7)
  })

  // ── reset ──
  test("reset clears internal state", () => {
    ma.evaluate(summary({ round: 1, filePaths: ["a.ts"] }), 30)
    ma.evaluate(summary({ round: 2, filePaths: ["a.ts"] }), 30)
    ma.reset()
    const v = ma.evaluate(summary({ round: 1, filePaths: ["a.ts"] }), 30)
    expect(v.decision).toBe(MetaDecision.CONTINUE)
    // No stagnation penalty after reset
    expect(v.confidence).toBeGreaterThanOrEqual(0.9)
  })

  // ── Low confidence → ESCALATE ──
  test("very low confidence → ESCALATE", () => {
    const v = ma.evaluate(summary({
      round: 25,
      toolNames: ["write", "shell", "edit"],
      toolResults: [
        { name: "write", success: false, content: "error: disk full" },
        { name: "shell", success: false, content: "error: not found" },
        { name: "edit", success: false, content: "error: locked" },
      ],
      outputText: "",
    }), 30)
    expect(v.decision).toBe(MetaDecision.ESCALATE)
    expect(v.confidence).toBeLessThan(0.25)
    expect(v.escalatePrompt).toBeDefined()
  })
})
