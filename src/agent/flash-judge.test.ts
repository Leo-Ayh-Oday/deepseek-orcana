/** Tests for FlashJudge — 5 scenarios covering all verdict types + edge cases. */

import { describe, test, expect } from "bun:test"
import { FlashJudge } from "./flash-judge"
import type { FlashJudgeInput } from "./flash-judge"
import type { LLMProvider, ProviderMessage, StreamEvent } from "../provider/types"

// ── Mock provider factory ──

function mockProvider(response: string, usage?: { input?: number; output?: number }): LLMProvider {
  return {
    async *streamChat() {
      yield { type: "text", data: response } satisfies StreamEvent
      if (usage) {
        yield { type: "token_usage", data: { inputTokens: usage.input ?? 100, outputTokens: usage.output ?? 50 } } satisfies StreamEvent
      }
    },
  }
}

// ── Minimal input factory ──

function baseInput(overrides: Partial<FlashJudgeInput> = {}): FlashJudgeInput {
  return {
    finalText: "代码已写完，typecheck 通过，test 通过。任务完成。",
    taskTracker: {
      goal: "创建 hello world API",
      intent: "long_task",
      phase: "complete",
      requiredFiles: ["server/index.ts"],
      requiredVerificationKinds: ["typecheck", "test"],
      verificationEvidence: { typecheck: "tsc --noEmit passed", test: "bun test passed" },
      verification: ["typecheck passed", "test passed"],
      steps: [
        { id: "init", title: "初始化项目", status: "done", evidence: "package.json created" },
        { id: "code", title: "写代码", status: "done", evidence: "server/index.ts written" },
        { id: "verify", title: "验证", status: "done", evidence: "typecheck + test passed" },
      ],
    },
    missingTaskRequirements: [],
    pendingRippleObligations: [],
    verificationResults: [
      { kind: "typecheck", passed: true, command: "tsc --noEmit", issues: 0, summary: "ok", durationMs: 0 },
      { kind: "test", passed: true, command: "bun test", issues: 0, summary: "3 passed", durationMs: 0 },
    ],
    changedFiles: ["server/index.ts", "server/index.test.ts"],
    taskHadWrite: true,
    toolErrors: 0,
    round: 5,
    recentTurns: [
      { role: "user", content: "请创建 hello world API" },
      { role: "assistant", content: "我创建了 server/index.ts 和测试，typecheck 和 test 都通过了。" },
    ],
    ...overrides,
  }
}

// ── Tests ──

describe("FlashJudge", () => {
  test("SATISFIED — task complete with verification evidence", async () => {
    const judge = new FlashJudge(mockProvider(
      '{"verdict":"SATISFIED","gaps":[],"evidence_found":["typecheck passed","test passed","all steps done"]}'
    ))
    judge.resetForTask("test-1")

    const input = baseInput()
    const result = await judge.evaluate(input)

    expect(result.verdict).toBe("SATISFIED")
    expect(result.evidenceFound.length).toBeGreaterThan(0)
    expect(result.gaps.length).toBe(0)
  })

  test("NOT_SATISFIED — agent claims done but no verification ran", async () => {
    const judge = new FlashJudge(mockProvider(
      '{"verdict":"NOT_SATISFIED","gaps":["没有运行 typecheck","没有运行 test"],"evidence_found":[]}'
    ))
    judge.resetForTask("test-2")

    const input = baseInput({
      verificationResults: [],
      taskTracker: {
        ...baseInput().taskTracker!,
        verificationEvidence: {},
        steps: baseInput().taskTracker!.steps.map(s => s.id === "verify" ? { ...s, status: "pending" as const } : s),
      },
      finalText: "代码写完了，需要我继续优化吗？",
    })
    const result = await judge.evaluate(input)

    expect(result.verdict).toBe("NOT_SATISFIED")
    expect(result.gaps.length).toBeGreaterThan(0)
  })

  test("IMPOSSIBLE — task cannot be completed", async () => {
    const judge = new FlashJudge(mockProvider(
      '{"verdict":"IMPOSSIBLE","gaps":["缺少 API key","无法连接外部服务"],"evidence_found":[]}'
    ))
    judge.resetForTask("test-3")

    const input = baseInput({
      finalText: "我试了 3 种方法都失败，需要 API key 才能继续。",
      taskTracker: {
        ...baseInput().taskTracker!,
        steps: baseInput().taskTracker!.steps.map(s =>
          s.id === "verify" ? { ...s, status: "failed" as const, evidence: "missing API key" } : s
        ),
      },
      verificationResults: [],
      toolErrors: 5,
    })
    const result = await judge.evaluate(input)

    expect(result.verdict).toBe("IMPOSSIBLE")
  })

  test("circuit breaker — blocks after 3 evaluations", async () => {
    const judge = new FlashJudge(mockProvider(
      '{"verdict":"NOT_SATISFIED","gaps":["test"],"evidence_found":[]}'
    ))
    judge.resetForTask("test-4")

    // 3 evaluations should work
    for (let i = 0; i < 3; i++) {
      await judge.evaluate(baseInput({ round: 5 + i }))
    }

    // 4th should be blocked by circuit breaker
    expect(judge.shouldEvaluate({ taskTracker: baseInput().taskTracker, taskHadWrite: true, toolErrors: 0, round: 8 })).toBe(false)
    expect(judge.callsRemaining).toBe(0)
  })

  test("no task tracker — skips evaluation early", async () => {
    const judge = new FlashJudge(mockProvider("{}"))
    judge.resetForTask("test-5")

    expect(judge.shouldEvaluate({ taskTracker: null, taskHadWrite: false, toolErrors: 0, round: 5 })).toBe(false)
  })

  test("round < 3 — too early to judge", async () => {
    const judge = new FlashJudge(mockProvider("{}"))
    judge.resetForTask("test-6")

    expect(judge.shouldEvaluate({ taskTracker: baseInput().taskTracker, taskHadWrite: true, toolErrors: 0, round: 2 })).toBe(false)
    expect(judge.shouldEvaluate({ taskTracker: baseInput().taskTracker, taskHadWrite: true, toolErrors: 0, round: 3 })).toBe(true)
  })

  test("FlashJudge.formatUnsatisfiedPrompt includes all gaps", () => {
    const prompt = FlashJudge.formatUnsatisfiedPrompt(["没运行 typecheck", "没运行 test", "ripple obligations 未解决"])
    expect(prompt).toContain("没运行 typecheck")
    expect(prompt).toContain("没运行 test")
    expect(prompt).toContain("ripple obligations 未解决")
  })

  test("FlashJudge.formatImpossiblePrompt includes reasons", () => {
    const prompt = FlashJudge.formatImpossiblePrompt(["缺少 API key", "服务端返回 403"])
    expect(prompt).toContain("缺少 API key")
    expect(prompt).toContain("403")
  })
})
