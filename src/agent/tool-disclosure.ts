/** Dynamic tool disclosure — filters tools by context to save 30-50% token overhead.
 *
 * Instead of sending all tool schemas every round, we analyze the conversation
 * context and select only the tools likely to be needed.
 *
 * Categories:
 *   baseTools    — always available
 *   gitTools     — triggered by git-related keywords
 *   searchTool   — triggered by search/web keywords
 *   codegraphTools — triggered by symbol/ref keywords
 */

import type { ToolDescriptor } from "../tools/registry"

// ── Tool sets ──

const CATEGORIES: Record<string, string[]> = {
  base: ["read_file", "write_file", "edit_file", "multi_edit", "shell"],
  git: ["git_status", "git_diff", "git_log", "git_blame"],
  search: ["web_search"],
  codegraph: ["find_symbol", "find_references", "project_structure"],
  fim: ["edit_fim"],
}

function categorize(t: ToolDescriptor): string[] {
  const cats: string[] = []
  for (const [cat, names] of Object.entries(CATEGORIES)) {
    if (names.includes(t.defn.name)) cats.push(cat)
  }
  return cats.length ? cats : ["base"]
}

// ── Keyword triggers for each category ──

const TRIGGERS: Record<string, RegExp[]> = {
  git: [
    /git/i, /提交/i, /commit/i, /分支/i, /branch/i, /合并/i, /merge/i,
    /diff/i, /log/i, /blame/i, /回退/i, /revert/i, /暂存/i, /stash/i,
  ],
  search: [
    /搜索/i, /搜/i, /查/i, /search/i, /web/i, /文档/i, /doc/i,
    /怎么/i, /如何/i, /api/i, /npm/i, /pypi/i, /crate/i,
    /github/i, /最新/i, /recent/i, /latest/i,
  ],
  codegraph: [
    /函数/i, /function/i, /类/i, /class/i, /定义/i, /definition/i,
    /引用/i, /references/i, /符号/i, /symbol/i, /在哪/i, /where is/i,
    /谁在用/i, /调用/i, /call/i, /项目结构/i, /结构/i, /目录/i,
  ],
  fim: [
    /行\s*\d+/i, /第\s*\d+/i, /line\s*\d+/i, /这一行/i, /这个范围/i,
    /start_line/i, /end_line/i, /范围/i, /区域/i, /region/i,
    /替换这段/i, /改这/i, /这段代码/i, /这个函数/i,
  ],
}

// ── Scoring ──

function scoreContext(text: string, category: string): number {
  const triggers = TRIGGERS[category]
  if (!triggers) return 0
  let score = 0
  for (const re of triggers) {
    const matches = text.match(re)
    if (matches) score += matches.length
  }
  return score
}

/**
 * Select tools based on the conversation context.
 * Returns a filtered list plus metadata for cache-aware prompting.
 */
export function selectTools(
  tools: ToolDescriptor[],
  contextText: string,
  roundNumber: number,
): { selected: ToolDescriptor[]; categories: Set<string>; tokensSaved: number } {
  // Always include base tools
  const selected: ToolDescriptor[] = []
  const categories = new Set<string>(["base"])

  // Score each category
  const scores = new Map<string, number>()
  for (const cat of ["git", "search", "codegraph", "fim"]) {
    scores.set(cat, scoreContext(contextText, cat))
  }

  // Round 0: keep base tools, plus categories explicitly triggered by the user's first prompt.
  if (roundNumber === 0) {
    for (const [cat, score] of scores) {
      if (score > 0) categories.add(cat)
    }
    for (const t of tools) {
      const cats = categorize(t)
      if (cats.some(cat => categories.has(cat))) selected.push(t)
    }
    const schemasSize = tools.reduce((s, t) => s + JSON.stringify(t.toAnthropicSchema()).length, 0)
    const selectedSize = selected.reduce((s, t) => s + JSON.stringify(t.toAnthropicSchema()).length, 0)
    return { selected, categories, tokensSaved: Math.round((schemasSize - selectedSize) / 3.5) }
  }

  // Rounds 1+: include triggered categories
  for (const [cat, score] of scores) {
    if (score > 0) categories.add(cat)
  }

  // Second round: if nothing triggered, add everything (model might need anything)
  if (roundNumber === 1 && categories.size === 1) {
    return { selected: tools, categories: new Set(Object.keys(CATEGORIES)), tokensSaved: 0 }
  }

  for (const t of tools) {
    const cats = categorize(t)
    for (const c of cats) {
      if (categories.has(c)) {
        selected.push(t)
        break
      }
    }
  }

  // Round 2+: if model had errors, add all tools (it might need alternatives)
  if (roundNumber >= 2 && selected.length < 5) {
    for (const t of tools) {
      if (!selected.includes(t)) selected.push(t)
    }
  }

  const schemasSize = tools.reduce((s, t) => s + JSON.stringify(t.toAnthropicSchema()).length, 0)
  const selectedSize = selected.reduce((s, t) => s + JSON.stringify(t.toAnthropicSchema()).length, 0)
  return { selected, categories, tokensSaved: Math.round((schemasSize - selectedSize) / 3.5) }
}
