import { cyan, dim, green, red, yellow } from "./render"

export interface ToolTraceGroup {
  kind: string
  label: string
  count: number
  completed: number
  firstDetail: string
  summaryPrinted: boolean
  riskCount: number
  riskSamples: string[]
}

export interface ToolTraceState {
  groups: ToolTraceGroup[]
  activeIndex: number
  callsClosed: boolean
  lastStatus: string
  statusTick: number
}

export function createToolTraceState(): ToolTraceState {
  return { groups: [], activeIndex: -1, callsClosed: false, lastStatus: "", statusTick: 0 }
}

function clip(text: string, max = 96): string {
  const oneLine = text.replace(/\s+/g, " ").trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max - 1)}...`
}

function toolKind(name: string): string {
  if (name === "read_file") return "read"
  if (name === "write_file" || name === "edit_file" || name === "edit_fim" || name === "multi_edit") return "write"
  if (name === "web_search" || name === "web_fetch" || name === "find_symbol" || name === "find_references" || name === "project_structure") return "search"
  if (name.startsWith("git_")) return "git"
  return name
}

function groupLabel(kind: string, fallback: string): string {
  const map: Record<string, string> = {
    read: "read",
    write: "edit",
    search: "search",
    shell: "terminal",
    git: "git",
    start_service: "service",
    typecheck: "typecheck",
  }
  return map[kind] ?? fallback
}

function detailFor(name: string, input: Record<string, unknown>): string {
  if (typeof input.path === "string") return input.path
  if (typeof input.query === "string") return input.query
  if (typeof input.symbol === "string") return input.symbol
  if (typeof input.command === "string") return clip(input.command, 120)
  if (typeof input.function_name === "string") return input.function_name
  return ""
}

function activeGroup(state: ToolTraceState): ToolTraceGroup | undefined {
  return state.activeIndex >= 0 ? state.groups[state.activeIndex] : undefined
}

function pulse(state: ToolTraceState): string {
  const frames = ["·", "•", "◆", "•"]
  const frame = frames[state.statusTick % frames.length] ?? "·"
  state.statusTick += 1
  return frame
}

function renderGroupLine(group: ToolTraceGroup): string {
  const count = group.count > 1 ? ` x${group.count}` : ""
  const detail = group.firstDetail ? `  ${dim(clip(group.firstDetail, 96))}` : ""
  return `\n  ${cyan(pulseSymbol(group.kind))} ${group.label}${count}${detail}`
}

function pulseSymbol(kind: string): string {
  const map: Record<string, string> = {
    read: "◇",
    write: "◆",
    search: "○",
    shell: "▶",
    git: "⌁",
  }
  return map[kind] ?? "•"
}

function updateGroupLine(group: ToolTraceGroup): string {
  if (group.count <= 1) return ""
  return `\r  ${cyan(pulseSymbol(group.kind))} ${group.label} x${group.count}  ${dim(clip(group.firstDetail, 96))}`
}

function renderGroupSummary(group: ToolTraceGroup): string {
  if (group.summaryPrinted || group.count <= 1) return ""
  group.summaryPrinted = true
  return `\n    ${dim(`folded ${group.count - 1} more ${group.label} call(s)`) }`
}

export function renderToolCall(
  state: ToolTraceState,
  name: string,
  input: Record<string, unknown> = {},
): string {
  const kind = toolKind(name)
  const label = groupLabel(kind, name)
  const current = activeGroup(state)

  if (current && current.kind === kind && !state.callsClosed) {
    current.count += 1
    return updateGroupLine(current)
  }

  let out = ""
  if (current && !state.callsClosed) out += renderGroupSummary(current)

  state.groups.push({
    kind,
    label,
    count: 1,
    completed: 0,
    firstDetail: detailFor(name, input),
    summaryPrinted: false,
    riskCount: 0,
    riskSamples: [],
  })
  state.activeIndex = state.groups.length - 1

  out += renderGroupLine(state.groups[state.activeIndex]!)
  return out
}

export function closeToolCalls(state: ToolTraceState): string {
  if (state.callsClosed) return ""
  state.callsClosed = true
  const group = activeGroup(state)
  return group ? renderGroupSummary(group) : ""
}

function isRisky(content: string): boolean {
  return /ripple|blocked|error|failed|fail|not found|denied|timed out|tsc diagnostics|risk|blocked|failure/i.test(content)
}

function findResultGroup(state: ToolTraceState, name: string): ToolTraceGroup | undefined {
  const kind = toolKind(name)
  return state.groups.find(group => group.kind === kind && group.completed < group.count)
    ?? state.groups.find(group => group.completed < group.count)
}

export function renderToolResult(state: ToolTraceState, name: string, content: string): string {
  let out = closeToolCalls(state)
  const group = findResultGroup(state, name)
  if (!group) return out

  group.completed += 1

  if (isRisky(content)) {
    group.riskCount += 1
    if (group.riskSamples.length < 2) group.riskSamples.push(clip(content, 96))
    if (group.riskCount === 1) {
      out += `\n    ${red("risk")}  ${dim(group.riskSamples[0] ?? "")}`
    } else {
      const samples = group.riskSamples.map(sample => dim(sample)).join(dim(" | "))
      out += `\r    ${red(`risk x${group.riskCount}`)}  ${samples}`
    }
  }

  return out
}

function renderStatusLine(state: ToolTraceState, label: string, status: string, color: (s: string) => string): string {
  let out = closeToolCalls(state)
  out += `\n    ${color(pulse(state))} ${dim(label)} ${clip(status, 120)}`
  return out
}

export function renderToolStatus(state: ToolTraceState, status: string): string {
  const text = clip(status, 120)
  if (!text || text === state.lastStatus) return ""
  state.lastStatus = text

  if (text.startsWith("greedy-tools:")) {
    const count = text.match(/\d+/)?.[0] ?? "many"
    return renderStatusLine(state, "parallel", `${count} readonly tools`, cyan)
  }

  if (/task|任务|progress|tracker/i.test(text)) return renderStatusLine(state, "task", text, green)
  if (/thinking|think|思考|推理|plan|planning|规划/i.test(text)) return renderStatusLine(state, "thinking", text, cyan)
  if (/retry|429|rate limit|backoff|重试/i.test(text)) return renderStatusLine(state, "retry", text, yellow)
  if (/cache|缓存/i.test(text)) return renderStatusLine(state, "cache", text, green)
  if (/verify|verification|typecheck|test|build|验证|测试|构建/i.test(text)) return renderStatusLine(state, "verify", text, green)

  return ""
}
