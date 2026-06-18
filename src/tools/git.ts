/** Git tools — status, diff, log, blame. */

import { execSync } from "node:child_process"
import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"

function runGit(args: string[], timeout = 30): { code: number; stdout: string; stderr: string } {
  try {
    const out = execSync(`git ${args.join(" ")}`, { timeout: timeout * 1000, encoding: "utf-8" })
    return { code: 0, stdout: out, stderr: "" }
  } catch (e: any) {
    return { code: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "git command failed" }
  }
}

/** Cap output with a truncation note — model knows it got snipped and can request more. */
function capOutput(raw: string, label: string, maxChars: number): string {
  if (raw.length <= maxChars) return raw
  const head = raw.slice(0, maxChars)
  const skipped = raw.length - maxChars
  return `${head}\n\n… [${label}: ${skipped} chars trimmed — use 'path' param or re-run with line range to narrow scope]`
}

async function git_status(): Promise<ToolResult> {
  const { code, stdout, stderr } = runGit(["status", "--short"])
  if (code !== 0) return Result.fail(stderr)
  if (!stdout.trim()) return Result.ok("Clean working tree")
  return Result.ok(capOutput(stdout, "git status", 6000))
}

async function git_diff(params: Record<string, unknown>): Promise<ToolResult> {
  const args = ["diff"]
  if (params.staged) args.push("--staged")
  if (params.path) args.push("--", String(params.path))
  const { code, stdout, stderr } = runGit(args)
  if (code !== 0) return Result.fail(stderr)
  if (!stdout.trim()) return Result.ok("No changes")
  return Result.ok(capOutput(stdout, "git diff", 12000))
}

async function git_log(params: Record<string, unknown>): Promise<ToolResult> {
  const n = Number(params.n ?? 10)
  const args = ["log", `-${n}`, "--oneline", "--decorate"]
  if (params.path) args.push("--", String(params.path))
  const { code, stdout, stderr } = runGit(args)
  if (code !== 0) return Result.fail(stderr)
  return Result.ok(capOutput(stdout, "git log", 6000))
}

async function git_blame(params: Record<string, unknown>): Promise<ToolResult> {
  const path = String(params.path ?? "")
  const args = ["blame", "--date=short"]
  if (params.line_start && params.line_end) {
    args.push("-L", `${params.line_start},${params.line_end}`)
  }
  args.push("--", path)
  const { code, stdout, stderr } = runGit(args)
  if (code !== 0) return Result.fail(stderr)
  return Result.ok(capOutput(stdout, "git blame", 6000))
}

export const GIT_STATUS: ToolDef = {
  name: "git_status",
  description: "Show git working tree status (short format)",
  isReadonly: true,
  category: "git" as const,
  inputSchema: { type: "object", properties: {} },
  execute: git_status,
}

export const GIT_DIFF: ToolDef = {
  name: "git_diff",
  description: "Show git diff (unstaged by default, set staged=true for staged)",
  isReadonly: true,
  category: "git" as const,
  inputSchema: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "Show staged changes" },
      path: { type: "string", description: "Filter to file" },
    },
  },
  execute: git_diff,
}

export const GIT_LOG: ToolDef = {
  name: "git_log",
  description: "Show recent git commits (oneline format)",
  isReadonly: true,
  category: "git" as const,
  inputSchema: {
    type: "object",
    properties: {
      n: { type: "integer", description: "Number of commits (default 10)" },
      path: { type: "string", description: "Filter to file" },
    },
  },
  execute: git_log,
}

export const GIT_BLAME: ToolDef = {
  name: "git_blame",
  description: "Show who last modified each line",
  isReadonly: true,
  category: "git" as const,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      line_start: { type: "integer" },
      line_end: { type: "integer" },
    },
    required: ["path"],
  },
  execute: git_blame,
}

export const GIT_TOOLS: ToolDef[] = [GIT_STATUS, GIT_DIFF, GIT_LOG, GIT_BLAME]
