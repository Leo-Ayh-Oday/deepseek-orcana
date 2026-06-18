import type { IntentMode } from "./intent"

export interface OutputGateOptions {
  intentMode: IntentMode
  prompt: string
  rewriteAttempts: number
}

export interface OutputGateResult {
  ok: boolean
  findings: string[]
  rewritePrompt?: string
}

const CODE_FENCE_PATTERN = /```/g
const HEADING_PATTERN = /^#{1,4}\s+\S+/gm
const RULE_PATTERN = /^-{3,}\s*$/gm
const BOX_DRAWING_PATTERN = /[\u2500-\u257f\u25bc\u25b2\u2190-\u21ff]/gu
const TOKEN_METER_PATTERN = /\[turn\s+~?\d+(?:\.\d+)?K?\s+tokens\b/gi
const DETAIL_REQUEST_PATTERN =
  /\b(detailed|full|complete|comprehensive|thorough|long)\b|\u8be6\u7ec6|\u5b8c\u6574|\u5168\u9762|\u5c55\u5f00|\u957f\u6587/i

const INVITATION_PATTERNS = [
  /\u8981\u4e0d\u8981/g,
  /\u9700\u8981\u6211/g,
  /\u6211\u53ef\u4ee5/g,
  /\u662f\u5426\u9700\u8981/g,
  /do you want me/gi,
  /should i/gi,
  /would you like me to/gi,
]

const TOPIC_TERMS = [
  "Ripple",
  "MetaAgent",
  "Meta-Agent",
  "Multi-Agent",
  "Context Kernel",
  "Checkpoint",
  "Hybrid Memory",
  "Hybrid-Memory",
  "Shadow",
  "TDD",
  "RAG",
  "MCP",
  "rollback",
  "confidence",
  "contract",
  "worktree",
  "provider",
  "LSP",
  "AST",
]

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

function countInvitations(text: string): number {
  return INVITATION_PATTERNS.reduce((sum, pattern) => sum + countMatches(text, pattern), 0)
}

function countTopicTerms(text: string): number {
  const lower = text.toLowerCase()
  return TOPIC_TERMS.reduce((sum, term) => lower.includes(term.toLowerCase()) ? sum + 1 : sum, 0)
}

function buildRewritePrompt(findings: string[]): string {
  return [
    "Rewrite your previous answer for terminal readability.",
    "Constraints:",
    "- Use the user's language.",
    "- Answer only the current question.",
    "- Use at most 4 bullets or 2 short paragraphs.",
    "- Do not add new architecture branches.",
    "- Do not ask whether to implement or continue.",
    "- Do not include ASCII diagrams, code fences, or token/status lines.",
    `Quality issues detected: ${findings.join("; ")}.`,
  ].join("\n")
}

export function evaluateOutputQuality(text: string, options: OutputGateOptions): OutputGateResult {
  if (options.intentMode !== "readonly") return { ok: true, findings: [] }
  if (options.rewriteAttempts > 0) return { ok: true, findings: [] }

  const trimmed = text.trim()
  if (!trimmed) return { ok: true, findings: [] }

  const estimatedTokens = Math.ceil(trimmed.length / 3)
  const findings: string[] = []
  const explicitDetail = DETAIL_REQUEST_PATTERN.test(options.prompt)

  if (trimmed.length > 4500 || (!explicitDetail && trimmed.length > 1800)) {
    findings.push(`too_long: readonly answer is ~${estimatedTokens} tokens`)
  }

  const structureCount = countMatches(trimmed, HEADING_PATTERN) + countMatches(trimmed, RULE_PATTERN)
  if (structureCount >= 6) findings.push(`fragmented_structure: ${structureCount} headings/separators`)

  const diagramCount = countMatches(trimmed, BOX_DRAWING_PATTERN)
  const codeFenceCount = countMatches(trimmed, CODE_FENCE_PATTERN)
  if (codeFenceCount >= 2 || diagramCount >= 24) {
    findings.push(`diagram_noise: ${codeFenceCount} fences, ${diagramCount} diagram chars`)
  }

  const invitationCount = countInvitations(trimmed)
  if (invitationCount >= 2) {
    findings.push(`implementation_invitation: ${invitationCount} invitation phrases`)
  }

  const tokenMeterCount = countMatches(trimmed, TOKEN_METER_PATTERN)
  if (tokenMeterCount >= 2) {
    findings.push(`token_trace_leak: ${tokenMeterCount} token meter lines`)
  }

  const topicTermCount = countTopicTerms(trimmed)
  if (trimmed.length > 1200 && topicTermCount >= 7 && !explicitDetail) {
    findings.push(`topic_sprawl: ${topicTermCount} architecture terms`)
  }

  if (findings.length === 0) return { ok: true, findings }
  return { ok: false, findings, rewritePrompt: buildRewritePrompt(findings) }
}
