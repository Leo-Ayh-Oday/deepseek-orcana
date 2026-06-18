import { describe, expect, test } from "bun:test"
import { ConfidenceEvaluator } from "../src/evaluator/confidence"
import { parseLLMScoreResponse, buildLLMScorePrompt } from "../src/evaluator/prompts"
import type { ObjectiveSignals, LLMScoreInput } from "../src/evaluator/types"

describe("ConfidenceEvaluator — evaluateSync", () => {
  const evaluator = new ConfidenceEvaluator()

  test("all signals perfect → high confidence (capped at 0.8)", () => {
    const signals: ObjectiveSignals = {
      testResults: { passed: 5, failed: 0, total: 5 },
      typecheck: { passed: true, issues: 0 },
      rippleDecision: "allow",
      lint: { issues: 0 },
    }
    const result = evaluator.evaluateSync(signals)
    expect(result.confidence).toBe(0.8)
    expect(result.objectiveScore).toBe(1)
    expect(result.recommendation).toBe("accept")
  })

  test("tests fail → low confidence + retry recommendation", () => {
    const signals: ObjectiveSignals = {
      testResults: { passed: 0, failed: 5, total: 5 },
      typecheck: { passed: true, issues: 0 },
      rippleDecision: "allow",
    }
    const result = evaluator.evaluateSync(signals)
    expect(result.confidence).toBeLessThan(0.4)
    expect(result.recommendation).toBe("retry")
  })

  test("typecheck fails with many issues → score drops", () => {
    const signals: ObjectiveSignals = {
      testResults: { passed: 4, failed: 0, total: 4 },
      typecheck: { passed: false, issues: 6 },
      rippleDecision: "allow",
      lint: { issues: 0 },
    }
    const result = evaluator.evaluateSync(signals)
    // typecheck failure drags down via geometric mean
    expect(result.confidence).toBeLessThan(0.6)
    expect(result.recommendation).toBe("review")
  })

  test("ripple block → very low confidence", () => {
    const signals: ObjectiveSignals = {
      testResults: { passed: 3, failed: 0, total: 3 },
      typecheck: { passed: true, issues: 0 },
      rippleDecision: "block",
      lint: { issues: 0 },
    }
    const result = evaluator.evaluateSync(signals)
    // geometric mean with ripple=0 → overall approaches 0
    expect(result.confidence).toBeLessThan(0.05)
    expect(result.recommendation).toBe("retry")
  })

  test("missing signals → neutral scores (0.5 each)", () => {
    const signals: ObjectiveSignals = {}
    const result = evaluator.evaluateSync(signals)
    expect(result.objectiveScore).toBe(0.5)
    expect(result.recommendation).toBe("review")
  })

  test("partial test pass → proportional score", () => {
    const signals: ObjectiveSignals = {
      testResults: { passed: 3, failed: 1, total: 4 },
      typecheck: { passed: true, issues: 0 },
      rippleDecision: "allow",
      lint: { issues: 0 },
    }
    const result = evaluator.evaluateSync(signals)
    expect(result.breakdown.testScore).toBe(0.75)
    expect(result.confidence).toBeGreaterThan(0.6)
    expect(result.confidence).toBeLessThan(0.8)
  })

  test("lint with many issues → score drops", () => {
    const signals: ObjectiveSignals = {
      testResults: { passed: 5, failed: 0, total: 5 },
      typecheck: { passed: true, issues: 0 },
      rippleDecision: "allow",
      lint: { issues: 8 },
    }
    const result = evaluator.evaluateSync(signals)
    expect(result.breakdown.lintScore).toBeLessThan(0.5)
    expect(result.confidence).toBeLessThan(0.8)
  })

  test("configuration at thresholds", () => {
    // Just below 70% should be review
    const e = new ConfidenceEvaluator()
    // test 50% + tc 100% + ripple 100% + lint 100% with geom mean
    const signals: ObjectiveSignals = {
      testResults: { passed: 1, failed: 1, total: 2 },
      typecheck: { passed: true, issues: 0 },
      rippleDecision: "allow",
      lint: { issues: 0 },
    }
    const result = e.evaluateSync(signals)
    expect(result.recommendation).toBe("review")
  })
})

describe("LLM score parsing", () => {
  test("parses valid JSON", () => {
    const text = `{"correctness":0.9,"completeness":0.8,"style":0.7,"safety":0.6,"overall":0.78,"reasoning":"还不错"}`
    const result = parseLLMScoreResponse(text)
    expect(result.correctness).toBe(0.9)
    expect(result.overall).toBe(0.78)
  })

  test("parses JSON wrapped in markdown fences", () => {
    const text = "```json\n{\"correctness\":0.8,\"completeness\":0.7,\"style\":0.6,\"safety\":0.5,\"overall\":0.7,\"reasoning\":\"ok\"}\n```"
    const result = parseLLMScoreResponse(text)
    expect(result.correctness).toBe(0.8)
    expect(result.overall).toBe(0.7)
  })

  test("falls back on invalid JSON", () => {
    const text = "not json at all"
    const result = parseLLMScoreResponse(text)
    expect(result.overall).toBe(0.5)
    expect(result.reasoning).toContain("无法解析")
  })

  test("clamps scores to 0-1 range", () => {
    const text = `{"correctness":1.5,"completeness":-0.5,"style":2,"safety":0,"overall":2,"reasoning":"极端值"}`
    const result = parseLLMScoreResponse(text)
    expect(result.correctness).toBe(1)
    expect(result.completeness).toBe(0)
    expect(result.safety).toBe(0)
  })
})

describe("LLM score prompt", () => {
  test("builds prompt with input", () => {
    const input: LLMScoreInput = {
      request: "写一个快排",
      response: "function qsort(arr) { ... }",
      testResults: { passed: 3, failed: 0, total: 3, output: "all good" },
    }
    const prompt = buildLLMScorePrompt(input)
    expect(prompt).toContain("写一个快排")
    expect(prompt).toContain("function qsort")
    expect(prompt).toContain("3/3")
    expect(prompt).toContain("correctness")
    expect(prompt).toContain("completeness")
    expect(prompt).toContain("style")
    expect(prompt).toContain("safety")
  })

  test("truncates long response", () => {
    const input: LLMScoreInput = {
      request: "test",
      response: "x".repeat(10000),
    }
    const prompt = buildLLMScorePrompt(input)
    expect(prompt.length).toBeLessThan(7000)
  })
})
