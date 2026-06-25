/** [PR 6] Evidence Ledger — structured verification evidence with hard completion gate.
 *
 *  Replaces ad-hoc `verificationEvidence: Partial<Record<VerificationKind, string>>`
 *  with timestamped, linked evidence entries. Four evidence types:
 *    - typecheck — static analysis (tsc, lint)
 *    - test — test runner output
 *    - build — build/compile success
 *    - manual — human review sign-off, manual QA, etc.
 *
 *  `canClaimDone()` is the single hard-check entry point: no passed evidence
 *  for a required kind → cannot claim done.
 */

import type { VerificationKind, VerificationResult } from "../verification/result"
import type { TaskTracker } from "./task-tracker"

// ── Evidence types ──

/** The four evidence types. Narrower than VerificationKind (which includes lint/smoke/unknown). */
export type EvidenceKind = "typecheck" | "test" | "build" | "manual"

/** A single piece of verification evidence. */
export interface EvidenceEntry {
  id: string
  kind: EvidenceKind
  /** The command that produced this evidence (e.g. "tsc --noEmit"). */
  command?: string
  /** Summary or snippet of the verification output. */
  output: string
  /** Whether the verification passed. Only passed evidence counts toward canClaimDone. */
  passed: boolean
  /** Unix timestamp (ms) when this evidence was collected. */
  timestamp: number
  /** Optional link to the PatchTransaction that produced the code under verification. */
  txId?: string
}

/** Collection of all evidence gathered during a task. */
export interface EvidenceLedger {
  entries: EvidenceEntry[]
}

/** Result of the canClaimDone() hard check. */
export interface CanClaimDoneResult {
  canClaim: boolean
  /** Human-readable reasons why completion cannot be claimed. */
  missing: string[]
  /** Hard blockers (distinct from soft warnings). */
  blocked: string[]
  /** Evidence kinds required by the task tracker. */
  requiredKinds: EvidenceKind[]
  /** Evidence kinds that have at least one passed entry. */
  satisfiedKinds: EvidenceKind[]
  /** Evidence kinds that are required but lack passed evidence. */
  unsatisfiedKinds: EvidenceKind[]
}

// ── Mapping: VerificationKind → EvidenceKind ──

/** Map a VerificationKind to its canonical EvidenceKind.
 *
 *  Mapping:
 *  - typecheck → typecheck
 *  - lint → typecheck (static analysis)
 *  - test → test
 *  - smoke → test (runtime verification)
 *  - build → build
 *  - unknown → null (cannot auto-classify)
 */
export function toEvidenceKind(kind: VerificationKind): EvidenceKind | null {
  switch (kind) {
    case "typecheck":
    case "lint":
      return "typecheck"
    case "test":
    case "smoke":
      return "test"
    case "build":
      return "build"
    case "unknown":
      return null
  }
}

/** Human-readable label for an evidence kind. */
export function evidenceKindLabel(kind: EvidenceKind): string {
  switch (kind) {
    case "typecheck": return "类型检查"
    case "test": return "测试"
    case "build": return "构建"
    case "manual": return "人工验证"
  }
}

// ── Factory ──

let nextEvidenceId = 0

/** Create a fresh evidence ledger. */
export function createEvidenceLedger(): EvidenceLedger {
  return { entries: [] }
}

/** Generate a unique evidence entry ID. */
export function generateEvidenceId(): string {
  nextEvidenceId++
  return `evi_${Date.now()}_${nextEvidenceId}`
}

// ── Ledger operations ──

/** Reset the ID counter (for test reproducibility). */
export function resetEvidenceIdCounter(start = 0): void {
  nextEvidenceId = start
}

/** Add an evidence entry to the ledger. */
export function addEvidence(ledger: EvidenceLedger, entry: EvidenceEntry): void {
  ledger.entries.push(entry)
}

/** Check whether the ledger has at least one passed evidence entry of the given kind. */
export function hasEvidence(ledger: EvidenceLedger, kind: EvidenceKind): boolean {
  return ledger.entries.some(e => e.kind === kind && e.passed)
}

/** Get all evidence entries of a given kind (passed or not). */
export function getEvidence(ledger: EvidenceLedger, kind: EvidenceKind): EvidenceEntry[] {
  return ledger.entries.filter(e => e.kind === kind)
}

/** Get the latest passed evidence entry for a kind, or null. */
export function latestPassedEvidence(ledger: EvidenceLedger, kind: EvidenceKind): EvidenceEntry | null {
  const passed = ledger.entries.filter(e => e.kind === kind && e.passed)
  if (passed.length === 0) return null
  return passed.reduce((latest, e) => e.timestamp > latest.timestamp ? e : latest)
}

// ── Ingestion: VerificationResult → EvidenceEntry ──

/** Convert a VerificationResult into evidence entries and add them to the ledger.
 *
 *  A single VerificationResult may produce evidence for its primary kind.
 *  Returns the newly added entries.
 */
export function ingestVerificationResult(ledger: EvidenceLedger, result: VerificationResult, txId?: string): EvidenceEntry | null {
  const kind = toEvidenceKind(result.kind)
  if (!kind) return null

  const entry: EvidenceEntry = {
    id: generateEvidenceId(),
    kind,
    command: result.command,
    output: result.summary,
    passed: result.passed,
    timestamp: Date.now(),
    txId,
  }
  addEvidence(ledger, entry)
  return entry
}

/** Batch-ingest multiple verification results. */
export function ingestVerificationResults(ledger: EvidenceLedger, results: VerificationResult[], txId?: string): EvidenceEntry[] {
  const entries: EvidenceEntry[] = []
  for (const r of results) {
    const entry = ingestVerificationResult(ledger, r, txId)
    if (entry) entries.push(entry)
  }
  return entries
}

/** Add a manual evidence entry (e.g. code review sign-off, manual QA). */
export function addManualEvidence(ledger: EvidenceLedger, opts: {
  description: string
  passed: boolean
  txId?: string
}): EvidenceEntry {
  const entry: EvidenceEntry = {
    id: generateEvidenceId(),
    kind: "manual",
    command: undefined,
    output: opts.description,
    passed: opts.passed,
    timestamp: Date.now(),
    txId: opts.txId,
  }
  addEvidence(ledger, entry)
  return entry
}

// ── The hard check: canClaimDone ──

/** Determine which EvidenceKinds are required based on the task tracker's
 *  requiredVerificationKinds. */
export function requiredEvidenceKinds(tracker: TaskTracker | null): EvidenceKind[] {
  if (!tracker || tracker.requiredVerificationKinds.length === 0) return []
  const kinds = new Set<EvidenceKind>()
  for (const vk of tracker.requiredVerificationKinds) {
    const ek = toEvidenceKind(vk)
    if (ek) kinds.add(ek)
  }
  return [...kinds]
}

/** The single hard-check entry point for claiming task completion.
 *
 *  Checks:
 *  1. No tracker → can claim (no structured task)
 *  2. Tracker already complete → can claim
 *  3. All steps must be done (no pending/running)
 *  4. All required evidence kinds must have at least one passed entry
 *  5. All required files must exist on disk
 *
 *  Returns a structured result with canClaim + detailed missing/blocked lists.
 */
export function canClaimDone(params: {
  tracker: TaskTracker | null
  evidence: EvidenceLedger
  cwd?: string
}): CanClaimDoneResult {
  const { tracker, evidence, cwd } = params
  const missing: string[] = []
  const blocked: string[] = []

  // No tracker → nothing to check
  if (!tracker) {
    return {
      canClaim: true,
      missing: [],
      blocked: [],
      requiredKinds: [],
      satisfiedKinds: [],
      unsatisfiedKinds: [],
    }
  }

  // Already complete
  if (tracker.phase === "complete") {
    return {
      canClaim: true,
      missing: [],
      blocked: [],
      requiredKinds: [],
      satisfiedKinds: [],
      unsatisfiedKinds: [],
    }
  }

  // Check: all steps must be done
  const undoneSteps = tracker.steps.filter(s => s.status !== "done")
  if (undoneSteps.length > 0) {
    for (const s of undoneSteps) {
      missing.push(`步骤未完成: ${s.title}`)
    }
  }

  // Check: required files exist
  if (cwd) {
    const { existsSync } = require("node:fs")
    const { resolve } = require("node:path")
    for (const file of tracker.requiredFiles) {
      const candidates = [file, `blog/${file}`, `client/${file}`]
      const found = candidates.some(candidate => existsSync(resolve(cwd, candidate)))
      if (!found) {
        missing.push(`缺少文件: ${file}`)
      }
    }
  }

  // Check: required evidence
  const required = requiredEvidenceKinds(tracker)
  const satisfied: EvidenceKind[] = []
  const unsatisfied: EvidenceKind[] = []

  for (const kind of required) {
    if (hasEvidence(evidence, kind)) {
      satisfied.push(kind)
    } else {
      unsatisfied.push(kind)
      missing.push(`缺少验证证据: ${evidenceKindLabel(kind)}`)
    }
  }

  // Hard blockers: unsatisfied required evidence kinds
  if (unsatisfied.length > 0) {
    blocked.push(
      `必需的验证证据缺失: ${unsatisfied.map(evidenceKindLabel).join(", ")}`
    )
  }

  // Hard blockers: undone steps
  if (undoneSteps.length > 0) {
    blocked.push(
      `仍有 ${undoneSteps.length} 个步骤未完成`
    )
  }

  return {
    canClaim: missing.length === 0,
    missing,
    blocked,
    requiredKinds: required,
    satisfiedKinds: satisfied,
    unsatisfiedKinds: unsatisfied,
  }
}

// ── Formatting ──

/** Format evidence ledger status for model-facing context. */
export function formatEvidenceLedgerStatus(ledger: EvidenceLedger): string {
  if (ledger.entries.length === 0) return "暂无验证证据"

  const lines: string[] = ["## 验证证据", ""]
  const byKind: Record<EvidenceKind, EvidenceEntry[]> = {
    typecheck: [],
    test: [],
    build: [],
    manual: [],
  }

  for (const e of ledger.entries) {
    byKind[e.kind].push(e)
  }

  for (const kind of ["typecheck", "test", "build", "manual"] as EvidenceKind[]) {
    const entries = byKind[kind]
    if (entries.length === 0) continue
    const passed = entries.filter(e => e.passed).length
    const total = entries.length
    const latest = entries.reduce((a, b) => a.timestamp > b.timestamp ? a : b)
    const icon = passed === total ? "✓" : passed > 0 ? "⚠" : "✗"
    lines.push(`${icon} **${evidenceKindLabel(kind)}**: ${passed}/${total} 通过`)
    if (latest.command) {
      lines.push(`  命令: \`${latest.command}\``)
    }
    lines.push(`  输出: ${latest.output.slice(0, 200)}`)
    lines.push("")
  }

  return lines.join("\n")
}

/** Format a canClaimDone result for model-facing injection. */
export function formatCanClaimDoneBlocked(result: CanClaimDoneResult): string {
  if (result.canClaim) return ""

  const lines = [
    "## 完成被阻止",
    "以下条件未满足，无法声明任务完成：",
    "",
    ...result.blocked.map(b => `- **${b}**`),
    "",
    "### 缺失项",
    ...result.missing.map(m => `- ${m}`),
  ]

  if (result.unsatisfiedKinds.length > 0) {
    lines.push(
      "",
      `需要但未满足的证据类型: ${result.unsatisfiedKinds.map(evidenceKindLabel).join(", ")}`,
      `已满足的证据类型: ${result.satisfiedKinds.length > 0 ? result.satisfiedKinds.map(evidenceKindLabel).join(", ") : "无"}`,
    )
  }

  return lines.join("\n")
}

// ── Serialization ──

export interface SerializedEvidenceEntry {
  id: string
  kind: EvidenceKind
  command?: string
  output: string
  passed: boolean
  timestamp: number
  txId?: string
}

export interface SerializedLedger {
  entries: SerializedEvidenceEntry[]
}

/** Serialize evidence ledger for checkpoint/transmission. */
export function serializeLedger(ledger: EvidenceLedger): SerializedLedger {
  return {
    entries: ledger.entries.map(e => ({
      id: e.id,
      kind: e.kind,
      command: e.command,
      output: e.output,
      passed: e.passed,
      timestamp: e.timestamp,
      txId: e.txId,
    })),
  }
}

/** Deserialize evidence ledger from checkpoint/transmission. */
export function deserializeLedger(data: SerializedLedger): EvidenceLedger {
  return {
    entries: data.entries.map(e => ({
      id: e.id,
      kind: e.kind,
      command: e.command,
      output: e.output,
      passed: e.passed,
      timestamp: e.timestamp,
      txId: e.txId,
    })),
  }
}
