import type { RippleObligation } from "../ripple/obligations"
import type { VerificationResult } from "../verification/result"
import type { TaskTracker } from "./task-tracker"

export interface CompletionGateInput {
  finalText: string
  taskTracker: TaskTracker | null
  missingTaskRequirements: string[]
  pendingRippleObligations: RippleObligation[]
  verificationResults: VerificationResult[]
  changedFiles: string[]
  taskHadWrite: boolean
  toolErrors: number
  lastTypecheck?: { passed: boolean; issues: number; output?: string }
}

export interface CompletionGateReport {
  allowed: boolean
  missing: string[]
  evidenceLines: string[]
  changedFiles: string[]
  residualRisks: string[]
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))]
}

function formatVerification(result: VerificationResult): string {
  const state = result.passed ? "passed" : "failed"
  const issues = result.issues > 0 ? `, issues=${result.issues}` : ""
  return `${result.kind}: ${state} (${result.command}${issues})`
}

function compactFinalText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return "Implementation work completed."
  const lines = trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^#{1,4}\s+/.test(line))
    .filter(line => !/^(External Completion Evidence|Changed Files|Residual Risk)/i.test(line))
  const selected = lines.slice(0, 4).join("\n")
  return selected.length > 700 ? `${selected.slice(0, 700)}...` : selected
}

export function needsExternalCompletionGate(input: Pick<CompletionGateInput, "taskTracker" | "taskHadWrite" | "toolErrors">): boolean {
  return Boolean(input.taskTracker || input.taskHadWrite || input.toolErrors > 0)
}

export function evaluateCompletionGate(input: CompletionGateInput): CompletionGateReport {
  const missing: string[] = []
  const residualRisks: string[] = []
  const evidenceLines = input.verificationResults.map(formatVerification)

  if (input.missingTaskRequirements.length > 0) {
    missing.push(...input.missingTaskRequirements)
  }
  if (input.pendingRippleObligations.length > 0) {
    missing.push(`pending ripple obligations: ${input.pendingRippleObligations.length}`)
  }
  if (input.lastTypecheck && !input.lastTypecheck.passed) {
    missing.push(`typecheck failed: ${input.lastTypecheck.issues} issue(s)`)
  }
  if (input.toolErrors > 0) {
    residualRisks.push(`tool errors occurred during this task: ${input.toolErrors}`)
  }
  if (input.taskHadWrite && input.verificationResults.length === 0 && !input.lastTypecheck?.passed) {
    missing.push("no external verification evidence after writes")
  }
  if (input.taskTracker) {
    for (const kind of input.taskTracker.requiredVerificationKinds) {
      if (!input.taskTracker.verificationEvidence[kind]) missing.push(`missing required verification: ${kind}`)
    }
  }
  if (!input.finalText.trim()) {
    residualRisks.push("model final text was empty")
  }

  return {
    allowed: missing.length === 0,
    missing: unique(missing),
    evidenceLines: unique(evidenceLines),
    changedFiles: unique(input.changedFiles).sort(),
    residualRisks: unique(residualRisks),
  }
}

export function formatCompletionGatePrompt(report: CompletionGateReport): string {
  return [
    "## External Completion Gate",
    "You cannot give a final completion answer yet. External evidence is still missing or contradictory.",
    "",
    "Missing evidence or obligations:",
    ...report.missing.slice(0, 16).map(item => `- ${item}`),
    "",
    "Required next step:",
    "Use tools to resolve the first missing item, run the concrete verification command, then only finish when this gate can produce an evidence report.",
  ].join("\n")
}

export function formatBlockedCompletion(report: CompletionGateReport): string {
  return [
    "## Completion blocked",
    "External evidence is still missing, so I cannot honestly mark this task complete.",
    "",
    "Missing:",
    ...report.missing.slice(0, 16).map(item => `- ${item}`),
  ].join("\n")
}

export function formatCompletionEvidenceReport(finalText: string, report: CompletionGateReport): string {
  const lines = [
    "## Delivery Report",
    compactFinalText(finalText),
    "",
    "## Evidence",
    ...(report.evidenceLines.length > 0 ? report.evidenceLines.map(item => `- ${item}`) : ["- no structured verification result was recorded"]),
  ]

  if (report.changedFiles.length > 0) {
    lines.push("", "## Changed Files", ...report.changedFiles.slice(0, 12).map(file => `- ${file}`))
  }
  lines.push(
    "",
    "## Risk",
    ...(report.residualRisks.length > 0 ? report.residualRisks.map(item => `- ${item}`) : ["- no unresolved runtime gate risk recorded"]),
  )

  return lines.join("\n")
}
