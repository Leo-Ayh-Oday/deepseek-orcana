/** Evaluator prompt — ask LLM to rate code quality on structured dimensions. */

import type { LLMScoreInput, LLMScoreOutput } from "./types"

export function buildLLMScorePrompt(input: LLMScoreInput): string {
  const parts = [
    "## 评分任务",
    "",
    "评估以下 Agent 输出的代码质量。按 JSON 格式输出评分。",
    "",
    "### 原始需求",
    input.request,
    "",
    "### Agent 输出",
    input.response.slice(0, 6000),
    "",
  ]

  if (input.testResults) {
    parts.push(
      "### 测试结果",
      `通过: ${input.testResults.passed}/${input.testResults.total}`,
      input.testResults.output?.slice(0, 500) ?? "",
      "",
    )
  }

  if (input.errors?.length) {
    parts.push(
      "### 执行错误",
      ...input.errors.slice(0, 3).map(e => `- ${e}`),
      "",
    )
  }

  parts.push(
    "### 评分维度 (每个 0-1 分)",
    "- correctness: 逻辑正确性，是否满足需求",
    "- completeness: 完整性，边缘情况是否覆盖",
    "- style: 代码风格，可读性、命名、结构",
    "- safety: 安全性，是否有明显 bug 或风险",
    "- overall: 加权综合分 (0.4·correctness + 0.25·completeness + 0.15·style + 0.2·safety)",
    "- reasoning: 一句话评价（中文）",
    "",
    "输出严格 JSON，不要任何其他内容:",
    `{"correctness":0.0,"completeness":0.0,"style":0.0,"safety":0.0,"overall":0.0,"reasoning":""}`,
  )

  return parts.join("\n")
}

export function parseLLMScoreResponse(text: string): LLMScoreOutput {
  // Try to extract JSON from the response (may have markdown fences)
  let json = text.trim()

  // Strip markdown fences
  const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch?.[1]) json = fenceMatch[1].trim()

  // Find first { or [ and last } or ]
  const start = json.indexOf("{")
  const end = json.lastIndexOf("}")
  if (start >= 0 && end > start) {
    json = json.slice(start, end + 1)
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(json)
  } catch {
    return { correctness: 0.5, completeness: 0.5, style: 0.5, safety: 0.5, overall: 0.5, reasoning: "无法解析 LLM 评分" }
  }

  const clamp = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5
  }
  return {
    correctness: clamp(parsed.correctness),
    completeness: clamp(parsed.completeness),
    style: clamp(parsed.style),
    safety: clamp(parsed.safety),
    overall: clamp(parsed.overall),
    reasoning: String(parsed.reasoning ?? "").slice(0, 200),
  }
}
