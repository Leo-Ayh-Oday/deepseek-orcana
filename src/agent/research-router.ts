import type { IntentMode } from "./intent"

export type ResearchMode = "normal_answer" | "code_task" | "deep_discussion" | "research_answer" | "clarification_first"

export interface ResearchRouteInput {
  prompt: string
  intentMode: IntentMode
}

export interface ResearchRouteDecision {
  mode: ResearchMode
  confidence: number
  needWeb: boolean
  reason: string
  researchQuestions: string[]
}

const EXPLICIT_RESEARCH = [
  /联网|上网|搜索|搜一下|查一下|查资料|结合.*搜索|结合.*联网|证据|证明|来源|引用|论文|GitHub|最近|最新/i,
  /web\s*search|search the web|look up|sources?|citations?|evidence|prove|paper|arxiv|github|latest|recent/i,
]

const NO_WEB = [
  /不要联网|别联网|不用联网|不要搜索|别搜索|不搜索|只根据当前|先不要搜/i,
  /do not search|no web|without web|don't browse|do not browse/i,
]

const RESEARCH_TOPIC = [
  /架构|战略|路线|技术路线|对标|竞品|趋势|研究|原理|机制|差距|方案|证明|推翻|重组|智能体|agent/i,
  /architecture|strategy|roadmap|technical direction|compare|competitor|research|mechanism|agent|self[-\s]?improve|recursive/i,
]

const IMPLEMENTATION = [
  /实现|修复|修改|写代码|开始做|直接做|落地|创建文件/i,
  /implement|fix|edit|write code|create files?|modify/i,
]

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text))
}

function splitClauses(prompt: string): string[] {
  return prompt
    .split(/[。！？；;!?]|\n+/)
    .map(part => part.trim())
    .filter(Boolean)
}

export function buildResearchQuestions(prompt: string): string[] {
  const clauses = splitClauses(prompt)
  const questions: string[] = []
  const text = prompt.trim()

  if (/推翻|重组|self[-\s]?improve|recursive/i.test(text)) {
    questions.push("self-improving coding agents recursive self-modification evidence")
    questions.push("LLM agent self-reflection external feedback coding benchmark")
  }
  if (/架构|技术路线|architecture|strategy|roadmap/i.test(text)) {
    questions.push("coding agent architecture planning verification external feedback")
  }
  if (/DeepSeek|deepseek|DSV4|V4/i.test(text)) {
    questions.push("DeepSeek API thinking mode tool calling context caching official docs")
  }
  if (/Claude Code|claude code/i.test(text)) {
    questions.push("Claude Code agent architecture tools planning verification")
  }
  if (/GitHub|开源|项目|竞品|对标/i.test(text)) {
    questions.push(`${clauses[0] ?? text} GitHub coding agent`)
  }

  for (const clause of clauses.slice(0, 3)) {
    if (clause.length >= 8 && questions.length < 5) questions.push(clause)
  }

  if (questions.length === 0) questions.push(text.slice(0, 120))
  return [...new Set(questions)].slice(0, 5)
}

export function classifyResearchRoute(input: ResearchRouteInput): ResearchRouteDecision {
  const prompt = input.prompt.trim()
  const noWeb = hasAny(prompt, NO_WEB)
  const explicitResearch = hasAny(prompt, EXPLICIT_RESEARCH)
  const researchTopic = hasAny(prompt, RESEARCH_TOPIC)
  const implementation = input.intentMode !== "readonly" || hasAny(prompt, IMPLEMENTATION)

  if (implementation && !explicitResearch) {
    return {
      mode: input.intentMode === "long_task" ? "clarification_first" : "code_task",
      confidence: 0.82,
      needWeb: false,
      reason: "用户主要在要求执行代码任务",
      researchQuestions: [],
    }
  }

  if (explicitResearch && !noWeb) {
    return {
      mode: "research_answer",
      confidence: 0.9,
      needWeb: true,
      reason: "用户明确要求联网、证据、来源或证明观点",
      researchQuestions: buildResearchQuestions(prompt),
    }
  }

  if (researchTopic) {
    return {
      mode: "deep_discussion",
      confidence: 0.72,
      needWeb: false,
      reason: noWeb ? "用户要求不联网，保留为深度讨论" : "问题属于架构、战略或技术路线讨论",
      researchQuestions: noWeb ? [] : buildResearchQuestions(prompt),
    }
  }

  return {
    mode: "normal_answer",
    confidence: 0.6,
    needWeb: false,
    reason: "普通回答路径",
    researchQuestions: [],
  }
}

export function shouldRunResearch(decision: ResearchRouteDecision): boolean {
  return decision.mode === "research_answer" && decision.needWeb
}
