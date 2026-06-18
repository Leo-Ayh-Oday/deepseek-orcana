/** JSON repair for malformed tool-call inputs from LLM.
 *
 * LLMs often produce broken JSON in tool_use blocks:
 *   - Trailing commas: {"path":"x",}
 *   - Missing closing braces/quotes
 *   - Unescaped newlines in strings
 *   - Wrong field names (file_path → path, content → text, etc.)
 *   - Python literals (True/False/None → true/false/null)
 *
 * We fix these without a full parser — regex-based, fast, aggressive.
 */

const FIELD_ALIASES: Record<string, string> = {
  file_path: "path",
  filePath: "path",
  file: "path",
  filename: "path",
  content: "content",
  text: "content",
  code: "content",
  body: "content",
  source: "content",
  cmd: "command",
  shell: "command",
  run: "command",
  query_string: "query",
  search: "query",
  keyword: "name",
  symbol: "name",
  func: "function_name",
  function: "function_name",
  fn: "function_name",
  start: "start_line",
  start_line_number: "start_line",
  end: "end_line",
  end_line_number: "end_line",
  instruction_text: "instruction",
  message: "instruction",
  desc: "instruction",
}

/** Try to parse JSON, with escalating repair attempts. */
export function repairToolCall(raw: string): Record<string, unknown> | null {
  // ═══ Pre-processing: fix known LLM quirks BEFORE any parse attempt ═══
  // If we try to parse first, valid JSON with wrong field names (like
  // {"filePath":"x"}) would succeed and return early, skipping field aliasing.

  let fixed = raw.trim()

  // A. Fix Python-style literals: True→true, False→false, None→null
  // Use word-boundary match — JSON keys are always quoted, so standalone
  // True/False/None are always value literals needing conversion.
  fixed = fixed.replace(/\b(True|False|None)\b/g, (_, word) => {
    const map: Record<string, string> = { True: "true", False: "false", None: "null" }
    return map[word] ?? word
  })

  // B. Fix field name aliases (filePath → path, etc.)
  for (const [bad, good] of Object.entries(FIELD_ALIASES)) {
    const re = new RegExp(`"${bad}"\\s*:`, "g")
    fixed = fixed.replace(re, `"${good}":`)
  }

  // ═══ Parse attempts ═══

  // 1. Try direct parse (handles most cases after pre-processing)
  try {
    return JSON.parse(fixed) as Record<string, unknown>
  } catch { /* fall through */ }

  // 2. Fix trailing commas: ,} → }  ,] → ]
  fixed = fixed.replace(/,\s*}/g, "}").replace(/,\s*\]/g, "]")

  try {
    return JSON.parse(fixed) as Record<string, unknown>
  } catch { /* fall through */ }

  // 3. Fix missing closing braces/brackets
  const openBraces = (fixed.match(/{/g) ?? []).length
  const closeBraces = (fixed.match(/}/g) ?? []).length
  const openBrackets = (fixed.match(/\[/g) ?? []).length
  const closeBrackets = (fixed.match(/\]/g) ?? []).length

  if (openBraces > closeBraces) {
    fixed += "}".repeat(openBraces - closeBraces)
  }
  if (openBrackets > closeBrackets) {
    fixed += "]".repeat(openBrackets - closeBrackets)
  }

  try {
    return JSON.parse(fixed) as Record<string, unknown>
  } catch { /* fall through */ }

  // 4. Fix unescaped newlines in string values
  fixed = fixed.replace(/"([^"]*\\n[^"]*)"/g, (_, inner) => {
    return JSON.stringify(inner)
  })

  try {
    return JSON.parse(fixed) as Record<string, unknown>
  } catch { /* fall through */ }

  // 5. Last resort: try to extract just the first valid JSON object
  const firstBrace = fixed.indexOf("{")
  if (firstBrace >= 0) {
    for (let end = fixed.length; end > firstBrace + 2; end--) {
      const slice = fixed.slice(firstBrace, end)
      try {
        return JSON.parse(slice) as Record<string, unknown>
      } catch { /* continue */ }
    }
  }

  return null
}

/** Quick sanity check: does this look like partial JSON that could be fixed? */
export function isProbablyJSON(s: string): boolean {
  const t = s.trim()
  return t.startsWith("{") || t.startsWith("[")
}
