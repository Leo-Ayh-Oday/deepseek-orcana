import { relative, resolve } from "node:path"
import type { RippleCaller, RippleReport } from "./types"

export interface RippleObligation {
  targetFile: string
  symbol: string
  caller: RippleCaller
  reason: string
}

export function normalizeProjectPath(path: string, projectRoot = process.cwd()): string {
  const normalized = relative(projectRoot, resolve(projectRoot, path)).replace(/\\/g, "/")
  return normalized || path.replace(/\\/g, "/")
}

export function obligationsFromReport(report: RippleReport, modifiedFiles: Set<string>): RippleObligation[] {
  if (!report.changedSymbols.length || !report.callers.length) return []
  const obligations: RippleObligation[] = []
  for (const caller of report.callers) {
    const callerFile = normalizeProjectPath(caller.file)
    if (modifiedFiles.has(callerFile)) continue
    obligations.push({
      targetFile: report.targetFile,
      symbol: caller.symbol,
      caller: { ...caller, file: callerFile },
      reason: `${caller.file}:${caller.line} still references changed symbol '${caller.symbol}'.`,
    })
  }
  return obligations
}

export function resolveObligations(existing: RippleObligation[], modifiedFiles: Set<string>): RippleObligation[] {
  return existing.filter(obligation => !modifiedFiles.has(normalizeProjectPath(obligation.caller.file)))
}

export function mergeObligations(existing: RippleObligation[], next: RippleObligation[]): RippleObligation[] {
  const byKey = new Map<string, RippleObligation>()
  for (const obligation of [...existing, ...next]) {
    byKey.set(`${obligation.targetFile}:${obligation.symbol}:${obligation.caller.file}:${obligation.caller.line}`, obligation)
  }
  return [...byKey.values()]
}

export function formatRippleExitGate(obligations: RippleObligation[]): string {
  const lines = [
    "## Ripple Exit Gate",
    "You cannot finish yet. The latest Ripple report still has unsynchronized callers.",
    "Before finalizing, read or update these callers, or explicitly prove why each caller is still compatible.",
    "",
    "Pending callers:",
  ]

  for (const obligation of obligations.slice(0, 12)) {
    lines.push(`- ${obligation.caller.file}:${obligation.caller.line} uses ${obligation.symbol} from ${obligation.targetFile}`)
    lines.push(`  code: ${obligation.caller.text.slice(0, 160)}`)
  }

  lines.push("")
  lines.push("Required next step:")
  lines.push("1. Inspect the pending caller files.")
  lines.push("2. Prepare one multi_edit cascade that updates the target and affected callers together.")
  lines.push("3. Verify with typecheck/tests.")
  lines.push("4. If the cascade write fails verification and repair is riskier than revert, use rollback_transaction with the returned transactionId.")
  return lines.join("\n")
}
