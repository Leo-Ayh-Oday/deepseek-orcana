/** Search result distiller — extracts structured knowledge from web search results.
 *
 *  V2 triggers:
 *    "error"       — search was triggered by tool failure (self-learning path)
 *    "uncertainty"  — model was uncertain and searched for docs
 *    "research"     — proactive web_search/web_fetch research (new)
 *
 *  The research trigger fires for EVERY successful web_search/web_fetch call
 *  with substantial results. Knowledge is extracted by Flash into KeyFact[]
 *  and stored in KnowledgeBase for cross-session reuse.
 */

import type { KnowledgeBase, KeyFact, KnowledgeEntry } from "./knowledge"
import type { LLMProvider } from "../provider/types"
import { shouldSkipProviderPurpose } from "../provider/cost-policy"

export interface DistillInput {
  query: string
  results: string
  trigger: "error" | "uncertainty" | "research"
  sourceURL?: string
}

function buildDistillPrompt(input: DistillInput): string {
  return [
    "从下面的搜索结果中提取核心事实。返回严格 JSON。",
    "",
    `搜索词: ${input.query.slice(0, 200)}`,
    `触发原因: ${input.trigger === "error"
      ? "工具反复失败，需要查资料修复"
      : input.trigger === "uncertainty"
      ? "模型不确定，需要查文档确认"
      : "主动研究搜索，积累知识"}`,
    input.sourceURL ? `来源URL: ${input.sourceURL}` : "",
    "",
    "规则:",
    '- "facts": 事实列表，每条 { "topic": "...", "fact": "...", "confidence": 0-1 }',
    "- topic: 简短主题标签（≤30字）",
    "- fact: 一句话事实描述（≤100字）",
    "- confidence: 置信度（0.5=可能对, 0.8=比较确定, 1.0=官方来源）",
    "- 只提取可验证的事实，跳过广告/导航/纯观点",
    "- 最多 5 条。没有实质信息返回空数组",
    "- 用中文",
    "",
    "输出纯 JSON，不要其他文字。",
    "",
    "## 搜索结果内容",
    input.results.slice(0, 4000),
  ].filter(Boolean).join("\n")
}

function parseDistillResponse(text: string): KeyFact[] {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return []
    const parsed = JSON.parse(jsonMatch[0]) as { facts?: KeyFact[] }
    if (!Array.isArray(parsed.facts)) return []
    return parsed.facts
      .filter(f => f.topic && f.fact && f.topic.length >= 2 && f.fact.length >= 10)
      .slice(0, 5)
  } catch { return [] }
}

async function streamCollect(provider: LLMProvider, model: string, system: string, prompt: string): Promise<string> {
  const chunks: string[] = []
  try {
    for await (const event of provider.streamChat({
      model,
      purpose: "knowledge_distill",
      system,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 1024,
    })) {
      if (event.type === "text" && event.data) {
        chunks.push(String(event.data))
      }
    }
  } catch { /* best-effort */ }
  return chunks.join("")
}

/**
 * Full distillation pipeline: Flash extract → store in KnowledgeBase.
 * Research trigger uses Flash model for structured fact extraction.
 * Error/uncertainty triggers use simpler topic-based store.
 * Rule-based fallback when Flash is not available.
 */
export async function distillAndStore(
  input: DistillInput,
  provider: LLMProvider,
  knowledgeBase: KnowledgeBase,
  distillModel = "deepseek-v4-flash",
): Promise<KnowledgeEntry[]> {
  try {
    if (input.trigger === "research" && input.results.length > 200) {
      if (shouldSkipProviderPurpose("knowledge_distill")) {
        const ruleFacts = extractFactsRuleBased(input.results, 3)
        return ruleFacts.length > 0 ? knowledgeBase.storeFacts(ruleFacts, "web_search", input.sourceURL) : []
      }
      const text = await streamCollect(provider, distillModel, "你是知识提取器。输出纯 JSON。", buildDistillPrompt(input))
      if (!text.trim()) return []
      const facts = parseDistillResponse(text)
      if (facts.length > 0) {
        return knowledgeBase.storeFacts(facts, "web_search", input.sourceURL)
      }
      // Fallback: rule-based extraction
      const ruleFacts = extractFactsRuleBased(input.results, 3)
      if (ruleFacts.length > 0) {
        return knowledgeBase.storeFacts(ruleFacts, "web_search", input.sourceURL)
      }
      return []
    }

    // Error/uncertainty: simpler store
    if (input.trigger === "error" || input.trigger === "uncertainty") {
      const entry = knowledgeBase.store(
        input.query.slice(0, 60),
        input.query.slice(0, 200),
        input.results.slice(0, 500),
        "self-discovered",
        input.sourceURL,
      )
      return [entry]
    }

    return []
  } catch {
    return []
  }
}

const EXTRACT_PATTERNS = [
  /(?:关键|核心|重要).*?(?:是|在于)[^。]{10,}[。]/g,
  /(?:答案|解决|方案|方法|步骤)[^。]{10,}[。\n]/g,
]

/** Rule-based fallback extraction (no Flash call needed). */
function extractFactsRuleBased(text: string, maxFacts = 3): KeyFact[] {
  const facts: KeyFact[] = []
  for (const pattern of EXTRACT_PATTERNS) {
    const matches = text.match(pattern)
    if (matches) {
      for (const m of matches) {
        const clean = m.trim().slice(0, 200)
        if (clean.length >= 20 && facts.length < maxFacts) {
          facts.push({ topic: clean.slice(0, 30), fact: clean, confidence: 0.4 })
        }
      }
    }
  }
  return facts
}

export function shouldDistill(query: string, trigger: "error" | "uncertainty" | "research"): boolean {
  if (!query || query.trim().length < 5) return false

  if (trigger === "research") {
    const t = query.trim()
    if (t.length < 8) return false
    const skipPatterns = [
      /trending/i, /热点/i, /天气/i, /weather/i, /股价/i, /stock/i,
      /latest news/i, /笑话/i, /joke/i,
    ]
    for (const p of skipPatterns) {
      if (p.test(t)) return false
    }
    return true
  }

  if (trigger === "uncertainty") return true
  if (trigger === "error") return query.trim().length > 6
  return true
}
