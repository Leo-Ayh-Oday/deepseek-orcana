import { describe, expect, test } from "bun:test"
import {
  buildExperienceKernelContext,
  selectExperienceCards,
  shouldUseExperienceKernel,
} from "../src/experience/kernel"

describe("Experience Kernel", () => {
  test("does not inject for tiny chat", () => {
    expect(shouldUseExperienceKernel({ prompt: "你好", intentMode: "readonly" })).toBe(false)
    expect(buildExperienceKernelContext({ prompt: "你好", intentMode: "readonly" })).toBe("")
  })

  test("injects research-first cards for architecture tasks", () => {
    const context = buildExperienceKernelContext({
      prompt: "评估这个 agent 架构方案，先看风险收益和前人做法",
      intentMode: "readonly",
    })

    expect(context).toContain("Experience Kernel")
    expect(context).toContain("Research-first engineering loop")
    expect(context).toContain("Theory risk and reward check")
    expect(context).toContain("soft engineering instincts")
  })

  test("injects taste card for full-stack product tasks", () => {
    const cards = selectExperienceCards({
      prompt: "Build a full-stack personal blog product",
      intentMode: "long_task",
    })

    expect(cards.map(card => card.kind)).toContain("taste")
    expect(cards.map(card => card.kind)).toContain("minimum_validation")
    expect(cards.map(card => card.kind)).toContain("freedom_guardrails")
  })

  test("guidance is not a hard block list", () => {
    const context = buildExperienceKernelContext({
      prompt: "做一个新产品 demo",
      intentMode: "long_task",
    })

    expect(context).toContain("Use your own reasoning")
    expect(context).toContain("not hard-coded commands")
    expect(context).not.toContain("BLOCK")
    expect(context).not.toContain("MUST NOT")
  })
})

