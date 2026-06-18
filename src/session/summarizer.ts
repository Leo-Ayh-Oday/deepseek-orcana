/** Session summarizer: deterministic structured context for resume. */

import type { Message, Session } from "./index"

export interface SessionDigest {
  topics: string[]
  filesTouched: string[]
  decisions: string[]
  lastActions: string[]
  summary: string
}

const FILE_RE = /\b[\w./-]+\.(py|ts|tsx|js|jsx|rs|go|json|toml|yaml|yml|md)\b/gi
const DECISION_RE = /\b(decided|decision|choose|chosen|must|should|do not|avoid|changed|fixed|implemented|completed|blocked|risk|todo|next)\b/i

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function extractFiles(text: string): string[] {
  const files: string[] = []
  for (const match of text.matchAll(FILE_RE)) files.push(match[0])
  return [...new Set(files)]
}

function maybeDecision(text: string): string | null {
  const clean = compactWhitespace(text)
  if (clean.length >= 12 && clean.length <= 320 && DECISION_RE.test(clean)) return clean.slice(0, 240)
  return null
}

export function digestSession(session: Session): SessionDigest {
  const topics: string[] = []
  const filesTouched = new Set<string>()
  const decisions: string[] = []

  for (const message of session.messages) {
    const text = compactWhitespace(message.content)
    if (!text) continue

    for (const file of extractFiles(text)) filesTouched.add(file)

    const decision = maybeDecision(text)
    if (decision && decisions.length < 8 && !decisions.includes(decision)) decisions.push(decision)

    if (message.role === "user" && topics.length < 6) {
      const topic = text.slice(0, 100)
      if (!topics.includes(topic)) topics.push(topic)
    }
  }

  const lastActions = session.messages
    .slice(-6)
    .filter((message): message is Message & { role: "user" | "assistant" } => message.role === "user" || message.role === "assistant")
    .map(message => {
      const label = message.role === "user" ? "User" : "DS"
      return `${label}: ${compactWhitespace(message.content).slice(0, 220)}`
    })

  return {
    topics,
    filesTouched: [...filesTouched].slice(0, 20),
    decisions,
    lastActions,
    summary: buildSummary(topics, filesTouched, decisions),
  }
}

function buildSummary(topics: string[], files: Set<string>, decisions: string[]): string {
  const parts: string[] = []
  if (topics.length) parts.push(`topics=${topics.slice(0, 3).join(" | ")}`)
  if (files.size) parts.push(`files=${[...files].slice(0, 10).join(", ")}`)
  if (decisions.length) parts.push(`signals=${decisions.slice(0, 3).join(" | ")}`)
  return parts.length ? parts.join(" ; ") : "No compact resume signals were extracted."
}

export function buildResumeContext(session: Session): string {
  const digest = digestSession(session)
  const lines: string[] = []

  lines.push("## Resume Context")
  lines.push("This is deterministic context reconstructed from a saved session. Treat it as background, not a new user request.")
  lines.push("")
  lines.push(`Summary: ${digest.summary}`)

  if (digest.filesTouched.length) {
    lines.push("")
    lines.push("### Files Mentioned Or Touched")
    for (const file of digest.filesTouched.slice(0, 12)) lines.push(`- ${file}`)
  }

  if (digest.decisions.length) {
    lines.push("")
    lines.push("### Decisions / Risks / TODO Signals")
    for (const decision of digest.decisions.slice(0, 6)) lines.push(`- ${decision}`)
  }

  if (digest.lastActions.length) {
    lines.push("")
    lines.push("### Last Actions")
    for (const action of digest.lastActions) lines.push(`- ${action}`)
  }

  lines.push("")
  lines.push("Continue from this context only if it matches the user's latest request.")
  return lines.join("\n")
}

export function resumeMessages(session: Session): Array<{ role: "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = []
  const picks: number[] = []

  if (session.messages.length > 6) {
    picks.push(0, 1)
    for (let index = Math.max(2, session.messages.length - 4); index < session.messages.length; index++) {
      picks.push(index)
    }
  } else {
    for (let index = 0; index < session.messages.length; index++) picks.push(index)
  }

  for (const index of [...new Set(picks)]) {
    const message = session.messages[index]
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue
    const content = message.content.length > 1000 ? `${message.content.slice(0, 1000)}...` : message.content
    messages.push({ role: message.role, content })
  }

  return messages
}
