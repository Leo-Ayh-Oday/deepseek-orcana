/** Language detection — used to adapt system prompts to the user's language. */

export type UILanguage = "zh" | "en"

const CJK_RE = /[一-鿿㐀-䶿豈-﫿]/

/**
 * Detect the user's primary language from their input text.
 * Simple heuristic: if ≥5 CJK characters → Chinese, otherwise English.
 */
export function detectLanguage(text: string): UILanguage {
  const cjkCount = (text.match(CJK_RE) ?? []).length
  return cjkCount >= 5 ? "zh" : "en"
}

/**
 * Return a one-line language instruction for LLM system prompts.
 * Use this in dynamic system/user messages (NOT the frozen prefix).
 */
export function languageInstruction(lang: UILanguage): string {
  return lang === "zh"
    ? "用户使用中文。你必须用中文回复，包括提问、计划、错误信息和完成报告。"
    : "The user is using English. Reply in English only."
}
