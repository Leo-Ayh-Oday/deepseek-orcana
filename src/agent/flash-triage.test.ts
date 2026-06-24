import { describe, expect, test } from "bun:test"
import { FlashTriage, resolveFlashTriagePolicy, shouldUseFlashTriage } from "./flash-triage"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../provider/types"

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

class CountingProvider implements LLMProvider {
  calls = 0
  options: ProviderCallOptions[] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.calls += 1
    this.options.push(options)
    yield { type: "text", data: '{"mode":"discussion","needsWeb":false,"researchQueries":[],"relevantSkillNames":[],"planSteps":[],"requiredVerification":[],"reasoning":"ok","riskLevel":"low"}' }
  }
}

describe("FlashTriage cost policy", () => {
  test("resolves explicit Flash triage policies", () => {
    expect(resolveFlashTriagePolicy(undefined)).toBe("auto")
    expect(resolveFlashTriagePolicy("0")).toBe("off")
    expect(resolveFlashTriagePolicy("auto")).toBe("auto")
    expect(resolveFlashTriagePolicy("1")).toBe("always")
    expect(resolveFlashTriagePolicy("always")).toBe("always")
  })

  test("auto policy avoids short ordinary turns and keeps complex turns eligible", () => {
    expect(shouldUseFlashTriage("off", "build a full-stack app")).toBe(false)
    expect(shouldUseFlashTriage("always", "hi")).toBe(true)
    expect(shouldUseFlashTriage("auto", "hi")).toBe(false)
    expect(shouldUseFlashTriage("auto", "Please build a full-stack app with backend API, frontend design, tests, deployment checks, and architecture tradeoffs.".repeat(3))).toBe(true)
  })

  test("strict mode skips the Flash triage provider call", async () => {
    const old = process.env.DEEPSEEK_COST_MODE
    const provider = new CountingProvider()
    try {
      process.env.DEEPSEEK_COST_MODE = "strict"
      const triage = new FlashTriage(provider)
      const result = await triage.triage("build a small app", "package.json")
      expect(result).toBeNull()
      expect(provider.calls).toBe(0)
    } finally {
      restoreEnv("DEEPSEEK_COST_MODE", old)
    }
  })

  test("normal mode labels Flash triage calls with purpose", async () => {
    const old = process.env.DEEPSEEK_COST_MODE
    const provider = new CountingProvider()
    try {
      delete process.env.DEEPSEEK_COST_MODE
      const triage = new FlashTriage(provider)
      const result = await triage.triage("build a small app", "package.json")
      expect(result?.mode).toBe("discussion")
      expect(provider.calls).toBe(1)
      expect(provider.options[0]?.purpose).toBe("flash_triage")
    } finally {
      restoreEnv("DEEPSEEK_COST_MODE", old)
    }
  })
})
