export type RippleDecision = "allow" | "warn" | "block"

export type RippleSeverity = "info" | "warn" | "block"

export type RippleFindingKind =
  | "signature-change"
  | "async-return-change"
  | "exported-type-change"
  | "exported-symbol-removal"
  | "deprecated-replacement"
  | "memory-contract"
  | "caller-overflow"
  | "depth-warning"

export interface RippleFinding {
  file: string
  line?: number
  severity: RippleSeverity
  kind: RippleFindingKind
  reason: string
  suggestedFix?: string
}

export interface RippleCaller {
  file: string
  line: number
  symbol: string
  text: string
}

export interface RippleMemoryHit {
  id: string
  scope: "project" | "global"
  topic: string
  rule: string
  source: string
  confidence: number
}

export interface RippleContextKernel {
  hash: string
  estimatedTokens: number
  sections: string[]
}

export interface RippleCascadePlan {
  required: boolean
  recommendedTool: "multi_edit" | "edit_file"
  targetFile: string
  affectedFiles: string[]
  callerFiles: string[]
  blockedReasons: string[]
  steps: string[]
}

export interface RippleReport {
  targetFile: string
  changedSymbols: string[]
  callers: RippleCaller[]
  findings: RippleFinding[]
  decision: RippleDecision
  memoryHits: RippleMemoryHit[]
  contextKernel?: RippleContextKernel
  cascadePlan?: RippleCascadePlan
}

export interface RipplePreviewInput {
  targetFile: string
  oldContent: string
  newContent: string
  projectRoot?: string
  mode?: "write_file" | "edit_file" | "edit_fim"
}
