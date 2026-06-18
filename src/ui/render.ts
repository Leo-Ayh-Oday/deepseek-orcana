/** Terminal markdown to ANSI renderer. Handles **bold**, `code`, code fences, and headings. */

const B = "\x1b[1m"
const D = "\x1b[2m"
const C = "\x1b[36m"
const Y = "\x1b[33m"
const R = "\x1b[31m"
const G = "\x1b[32m"
const RESET = "\x1b[0m"

export const dim = (s: string) => `${D}${s}${RESET}`
export const cyan = (s: string) => `${C}${s}${RESET}`
export const yellow = (s: string) => `${Y}${s}${RESET}`
export const red = (s: string) => `${R}${s}${RESET}`
export const green = (s: string) => `${G}${s}${RESET}`
export const bold = (s: string) => `${B}${s}${RESET}`

/** Render a single line with inline markdown: **bold**, `code`. */
export function renderLine(line: string): string {
  let out = ""
  let i = 0

  while (i < line.length) {
    if (line[i] === "*" && line[i + 1] === "*") {
      i += 2
      const end = line.indexOf("**", i)
      if (end === -1) { out += "**"; continue }
      out += B + line.slice(i, end) + RESET
      i = end + 2
      continue
    }
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1)
      if (end === -1) { out += "`"; i++; continue }
      out += C + line.slice(i + 1, end) + RESET
      i = end + 1
      continue
    }
    out += line[i]
    i++
  }

  return out
}

/** Render a full assistant response. Handles code fences, headers, and inline formatting. */
export function renderResponse(text: string): string {
  const lines = text.split("\n")
  const out: string[] = []
  let inCode = false

  for (const raw of lines) {
    if (raw.startsWith("```")) {
      inCode = !inCode
      continue
    }

    if (inCode) {
      out.push(D + raw + RESET)
    } else if (raw.startsWith("## ")) {
      out.push(B + Y + renderLine(raw) + RESET)
    } else if (raw.startsWith("### ")) {
      out.push(B + renderLine(raw) + RESET)
    } else if (raw.startsWith("- ") || raw.startsWith("* ") || /^\d+[.)]\s/.test(raw)) {
      out.push("  " + D + raw.slice(0, 2) + RESET + renderLine(raw.slice(2)))
    } else {
      out.push(renderLine(raw))
    }
  }

  return out.join("\n")
}

export interface StreamRenderState {
  buffer: string
  inCode: boolean
}

export function createStreamRenderState(): StreamRenderState {
  return { buffer: "", inCode: false }
}

function renderBlockLine(raw: string, state: { inCode: boolean }): string {
  if (raw.startsWith("```")) {
    state.inCode = !state.inCode
    return ""
  }
  if (state.inCode) return D + raw + RESET
  if (raw.startsWith("## ")) return B + Y + renderLine(raw) + RESET
  if (raw.startsWith("### ")) return B + renderLine(raw) + RESET
  if (raw.startsWith("- ") || raw.startsWith("* ") || /^\d+[.)]\s/.test(raw)) {
    return "  " + D + raw.slice(0, 2) + RESET + renderLine(raw.slice(2))
  }
  return renderLine(raw)
}

export function renderStreamChunk(state: StreamRenderState, chunk: string): string {
  state.buffer += chunk
  let out = ""
  while (true) {
    const newline = state.buffer.indexOf("\n")
    if (newline === -1) break
    const line = state.buffer.slice(0, newline)
    state.buffer = state.buffer.slice(newline + 1)
    out += renderBlockLine(line, state) + "\n"
  }
  return out
}

export function flushStreamRender(state: StreamRenderState): string {
  if (!state.buffer) return ""
  const out = renderBlockLine(state.buffer, state)
  state.buffer = ""
  return out
}

/** Render tool names with Chinese labels and colors. */
export function toolLabel(name: string): string {
  const map: Record<string, string> = {
    read_file: cyan("读文件"),
    write_file: yellow("写文件"),
    edit_file: yellow("修改"),
    edit_fim: yellow("FIM"),
    multi_edit: yellow("批量修改"),
    rollback_transaction: yellow("回滚"),
    shell: green("终端"),
    start_service: green("启动服务"),
    web_search: cyan("搜索"),
    find_symbol: cyan("找符号"),
    find_references: cyan("找引用"),
    project_structure: cyan("扫描项目"),
    read_definition: cyan("读定义"),
    git_status: cyan("Git状态"),
    git_diff: cyan("Git差异"),
    git_log: cyan("Git日志"),
    git_blame: cyan("Git追溯"),
  }
  return map[name] ?? name
}
