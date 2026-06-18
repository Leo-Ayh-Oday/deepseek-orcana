import { appendFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"

export interface RunTraceEvent {
  runId: string
  timestamp: string
  type: string
  data?: unknown
}

export class AgentRunTrace {
  readonly runId: string
  readonly file: string

  private constructor(runId: string, file: string) {
    this.runId = runId
    this.file = file
  }

  static start(cwd: string, prompt: string): AgentRunTrace {
    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
    const dir = join(cwd, ".deepseek-code", "runs")
    mkdirSync(dir, { recursive: true })
    const trace = new AgentRunTrace(runId, join(dir, `${runId}.jsonl`))
    trace.record("run_started", { prompt: prompt.slice(0, 1000) })
    return trace
  }

  record(type: string, data?: unknown) {
    const event: RunTraceEvent = {
      runId: this.runId,
      timestamp: new Date().toISOString(),
      type,
      data: sanitize(data),
    }
    // Defensive: ensure dir exists (Windows temp dirs may lag)
    try { mkdirSync(dirname(this.file), { recursive: true }) } catch { /* best effort */ }
    appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf-8")
  }
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]"
  if (value === null || value === undefined) return value
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value
  if (typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitize(item, depth + 1))
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      if (/api[_-]?key|token|secret|password|authorization/i.test(key)) {
        out[key] = "[redacted]"
      } else {
        out[key] = sanitize(item, depth + 1)
      }
    }
    return out
  }
  return String(value)
}

