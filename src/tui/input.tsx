import React, { useMemo, useRef, useState } from "react"
import { Box, Text, useInput } from "ink"

const C = {
  cyan: "#38BDF8",
  blue: "#60A5FA",
  border: "#334155",
  dim: "#64748B",
  fg: "#E5E7EB",
  yellow: "#F59E0B",
}

export interface SlashCommandHint {
  name: string
  description: string
  usage?: string
}

interface Props {
  onSubmit: (value: string) => void
  disabled?: boolean
  placeholder?: string
  status?: string
  commands?: SlashCommandHint[]
  focused?: boolean
  onScrollUp?: () => void
  onScrollDown?: () => void
}

// ── Composer Segment Model ──
// Each segment is either typed text or a staged paste block.
// The display renders paste segments as compact labels; submit expands them.

interface TextSegment {
  type: "text"
  text: string
}

interface PasteSegment {
  type: "paste"
  id: number
  text: string   // full pasted content (expanded on submit)
  label: string  // compact display label
}

type ComposerSegment = TextSegment | PasteSegment

// ── Constants ──

const PASTE_CHARS = Number(process.env.DEEPSEEK_TUI_PASTE_CHARS ?? "800")
const PASTE_LINES = Number(process.env.DEEPSEEK_TUI_PASTE_LINES ?? "2")
const DISPLAY_CHARS = Number(process.env.DEEPSEEK_TUI_INPUT_DISPLAY_CHARS ?? "260")
const ACCUMULATE_MS = 80

// ── Pure helpers ──

function countLines(text: string): number {
  if (!text) return 0
  return text.split("\n").length
}

function normalizeText(input: string): string {
  return input
    .replace(/\x1b\[200~/g, "")
    .replace(/\x1b\[201~/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
}

function sanitizeInline(input: string): string {
  return input
    .replace(/\x1b\[200~/g, "")
    .replace(/\x1b\[201~/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x1F\x7F]/g, "")
}

function isMouseSeq(input: string): boolean {
  if (!input) return false
  if (/^\x1b\[<\d+;\d+;\d+[mM]$/.test(input)) return true
  if (/^\x1b\[M/.test(input)) return true
  if (/^\[<\d+;\d+;\d+[mM]$/.test(input)) return true
  return false
}

function isEscapeSeq(input: string): boolean {
  if (!input.includes("\x1b")) return false
  if (input.includes("\x1b[200~") || input.includes("\x1b[201~")) return false
  return true
}

function pasteLabel(lines: number, chars: number, id: number): string {
  const lineStr = lines > 1 ? ` +${lines} lines` : ""
  return `[Pasted #${id}${lineStr}, ${chars} chars]`
}

function shouldStage(text: string): boolean {
  if (!text) return false
  return countLines(text) >= PASTE_LINES || text.length >= PASTE_CHARS
}

// ── Segment → flat display / full text converters ──

function flatDisplay(segs: ComposerSegment[]): string {
  let out = ""
  for (const s of segs) {
    if (s.type === "text") out += s.text
    else out += s.label
  }
  return out
}

function flatFull(segs: ComposerSegment[]): string {
  let out = ""
  for (const s of segs) {
    out += s.text
  }
  return out
}

function flatCursor(segs: ComposerSegment[]): number {
  // Return length of display string (for placing cursor at end after ops)
  let n = 0
  for (const s of segs) {
    if (s.type === "text") n += s.text.length
    else n += s.label.length
  }
  return n
}

// ── Segment list mutators (all return new list, never mutate) ──

function insertChar(segs: ComposerSegment[], flatPos: number, char: string): ComposerSegment[] {
  let pos = 0
  const out: ComposerSegment[] = []
  for (const s of segs) {
    const len = s.type === "text" ? s.text.length : s.label.length
    if (flatPos >= pos && flatPos <= pos + len) {
      const offset = flatPos - pos
      // Split this text segment and insert char
      const before = s.text.slice(0, offset)
      const after = s.text.slice(offset)
      if (before) out.push({ type: "text", text: before })
      out.push({ type: "text", text: char })
      if (after) out.push({ type: "text", text: after })
      pos += len
    } else {
      out.push(s)
      pos += len
    }
  }
  // If at end, just append
  if (flatPos >= pos) {
    // Merge with last text segment if possible
    const last = out[out.length - 1]
    if (last && last.type === "text") {
      out[out.length - 1] = { type: "text", text: last.text + char }
    } else {
      out.push({ type: "text", text: char })
    }
  }
  return mergeTextSegments(out)
}

function deleteBefore(segs: ComposerSegment[], flatPos: number): { segs: ComposerSegment[]; newPos: number } {
  if (flatPos <= 0) return { segs, newPos: 0 }
  const display = flatDisplay(segs)
  if (flatPos > display.length) return { segs, newPos: display.length }

  // If cursor is inside a paste segment label, delete the whole paste segment
  let pos = 0
  const out: ComposerSegment[] = []
  let removed = false
  let newPos = flatPos
  for (const s of segs) {
    const len = s.type === "text" ? s.text.length : s.label.length
    if (!removed && flatPos > pos && flatPos <= pos + len) {
      if (s.type === "paste") {
        newPos = pos
        // Skip this segment (delete the paste block)
        removed = true
        pos += len
        continue
      }
      const offset = flatPos - pos
      const before = s.text.slice(0, offset - 1)
      const after = s.text.slice(offset)
      const merged = before + after
      if (merged) out.push({ type: "text", text: merged })
      newPos = pos + (offset - 1)
      removed = true
    } else {
      out.push(s)
    }
    pos += len
  }
  return { segs: mergeTextSegments(out), newPos: Math.max(0, newPos) }
}

function deleteAfter(segs: ComposerSegment[], flatPos: number): ComposerSegment[] {
  const display = flatDisplay(segs)
  if (flatPos >= display.length) return segs

  let pos = 0
  const out: ComposerSegment[] = []
  let removed = false
  for (const s of segs) {
    const len = s.type === "text" ? s.text.length : s.label.length
    if (!removed && flatPos >= pos && flatPos < pos + len) {
      if (s.type === "paste") {
        // Delete whole paste segment
        removed = true
        pos += len
        continue
      }
      const offset = flatPos - pos
      const before = s.text.slice(0, offset)
      const after = s.text.slice(offset + 1)
      const merged = before + after
      if (merged) out.push({ type: "text", text: merged })
      removed = true
    } else {
      out.push(s)
    }
    pos += len
  }
  return mergeTextSegments(out)
}

function insertPasteSegment(segs: ComposerSegment[], flatPos: number, id: number, text: string): ComposerSegment[] {
  const lines = countLines(text)
  const p: PasteSegment = { type: "paste", id, text, label: pasteLabel(lines, text.length, id) }

  let pos = 0
  const out: ComposerSegment[] = []
  let inserted = false
  for (const s of segs) {
    const len = s.type === "text" ? s.text.length : s.label.length
    if (!inserted && flatPos >= pos && flatPos <= pos + len) {
      const offset = flatPos - pos
      if (s.type === "text") {
        const before = s.text.slice(0, offset)
        const after = s.text.slice(offset)
        if (before) out.push({ type: "text", text: before })
        out.push(p)
        if (after) out.push({ type: "text", text: after })
      } else {
        // Insert before paste segment
        out.push(p)
        out.push(s)
      }
      inserted = true
    } else {
      out.push(s)
    }
    pos += len
  }
  if (!inserted) out.push(p)
  return mergeTextSegments(out)
}

function mergeTextSegments(segs: ComposerSegment[]): ComposerSegment[] {
  const out: ComposerSegment[] = []
  for (const s of segs) {
    const last = out[out.length - 1]
    if (last && last.type === "text" && s.type === "text") {
      out[out.length - 1] = { type: "text", text: last.text + s.text }
    } else {
      out.push(s)
    }
  }
  return out
}

function previousFlatPos(segs: ComposerSegment[], flatPos: number): number {
  if (flatPos <= 0) return 0
  const display = flatDisplay(segs)
  let pos = 0
  for (const s of segs) {
    const len = s.type === "text" ? s.text.length : s.label.length
    if (flatPos > pos && flatPos <= pos + len) {
      if (s.type === "paste") return pos      // skip entire paste
      return flatPos - 1                       // normal char
    }
    pos += len
  }
  return Math.max(0, flatPos - 1)
}

function nextFlatPos(segs: ComposerSegment[], flatPos: number): number {
  const display = flatDisplay(segs)
  if (flatPos >= display.length) return display.length
  let pos = 0
  for (const s of segs) {
    const len = s.type === "text" ? s.text.length : s.label.length
    if (flatPos >= pos && flatPos < pos + len) {
      if (s.type === "paste") return pos + len  // skip entire paste
      return flatPos + 1                         // normal char
    }
    pos += len
  }
  return display.length
}

// ── Display helpers ──

function displayWindow(text: string, cursor: number): { text: string; cursor: number } {
  const limit = Math.max(80, DISPLAY_CHARS)
  if (text.length <= limit) return { text, cursor }

  const leftRoom = Math.floor(limit * 0.62)
  const start = Math.max(0, Math.min(cursor - leftRoom, text.length - limit))
  const end = Math.min(text.length, start + limit)
  const prefix = start > 0 ? "…" : ""
  const suffix = end < text.length ? "…" : ""
  return {
    text: `${prefix}${text.slice(start, end)}${suffix}`,
    cursor: Math.max(0, Math.min(prefix.length + cursor - start, prefix.length + end - start)),
  }
}

// ═══════════════════════════════════════════════════════════════════════
// InputLine — v3 Segment-based composer
// ═══════════════════════════════════════════════════════════════════════

export function InputLine({
  onSubmit,
  disabled,
  placeholder,
  status,
  commands = [],
  focused = true,
  onScrollUp,
  onScrollDown,
}: Props) {
  const [segments, setSegments] = useState<ComposerSegment[]>([{ type: "text", text: "" }])
  const [cursor, setCursor] = useState(0)
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const [commandIdx, setCommandIdx] = useState(0)
  const nextPasteId = useRef(1)

  // Time-window paste accumulation (handles chunked terminal pastes)
  const accumRef = useRef<{ startSegs: ComposerSegment[]; startCursor: number; accumulated: string } | null>(null)
  const accumTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearAccum = () => {
    if (accumTimer.current) { clearTimeout(accumTimer.current); accumTimer.current = null }
    accumRef.current = null
  }

  const flushAccum = () => {
    const session = accumRef.current
    accumRef.current = null
    accumTimer.current = null
    if (!session) return
    const norm = normalizeText(session.accumulated)
    if (!norm || !shouldStage(norm)) return
    // Undo the char-by-char insertions and replace with paste segment
    const id = nextPasteId.current++
    const newSegs = insertPasteSegment(session.startSegs, session.startCursor, id, norm)
    setSegments(newSegs)
    setCursor(session.startCursor + pasteLabel(countLines(norm), norm.length, id).length)
    setHistoryIdx(-1)
    setCommandIdx(0)
  }

  // Derived
  const display = useMemo(() => flatDisplay(segments), [segments])
  const expanded = useMemo(() => flatFull(segments), [segments])
  const hasPaste = segments.some(s => s.type === "paste")
  // Slash-command detection uses display text (paste blocks hidden)
  const cmdText = hasPaste ? "" : display
  const slashQ = cmdText.trimStart().startsWith("/") ? cmdText.trimStart().slice(1).split(/\s+/)[0] ?? "" : ""
  const showCmds = !disabled && cmdText.trimStart().startsWith("/")
  const cmdMatches = commands.filter(c => c.name.startsWith(slashQ)).slice(0, 5)
  const selectedCmd = cmdMatches[Math.min(commandIdx, Math.max(0, cmdMatches.length - 1))]
  const cursorVis = focused && !disabled
  const pasteCount = segments.filter(s => s.type === "paste").length

  const rendered = useMemo(() => {
    const win = displayWindow(display, cursor)
    if (!cursorVis) return { text: win.text, cursor: -1 }
    const before = win.text.slice(0, win.cursor)
    const after = win.text.slice(win.cursor)
    const chr = after.slice(0, 1) || " "
    return { before, chr, after: after.slice(1) }
  }, [cursorVis, cursor, segments, display])

  const submitValue = (rawDisplay: string) => {
    const rawTrimmed = rawDisplay.trim()
    const hasArgs = rawTrimmed.startsWith("/") && /\s/.test(rawTrimmed.slice(1))
    const trimmed = showCmds && selectedCmd && !hasArgs ? `/${selectedCmd.name}` : expanded.trim()
    if (!trimmed) return
    const histLabel = display.trim()
    setHistory(h => [...h.slice(-50), histLabel || trimmed.slice(0, 240)])
    setHistoryIdx(-1)
    setCommandIdx(0)
    onSubmit(trimmed)
    setSegments([{ type: "text", text: "" }])
    setCursor(0)
  }

  const setFromHistory = (val: string) => {
    setSegments([{ type: "text", text: val }])
    setCursor(val.length)
    setHistoryIdx(-1)
    setCommandIdx(0)
  }

  useInput((input, key) => {
    const canEdit = focused && !disabled

    // Filter mouse and unrecognised escape sequences
    if (isMouseSeq(input)) return
    if (isEscapeSeq(input) && !(key.upArrow || key.downArrow || key.leftArrow || key.rightArrow ||
        key.pageUp || key.pageDown || key.home || key.end ||
        key.backspace || key.delete || key.return || key.tab || key.escape)) return

    // Single-chunk paste staging (fast path)
    if (canEdit && input) {
      const norm = normalizeText(input)
      if (shouldStage(norm)) {
        clearAccum()
        const id = nextPasteId.current++
        setSegments(prev => {
          const next = insertPasteSegment(prev, cursor, id, norm)
          setCursor(flatCursor(next))
          return next
        })
        setHistoryIdx(-1)
        setCommandIdx(0)
        return
      }
    }

    // Any control key cancels pending time-window accumulation
    if (canEdit && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow ||
        key.pageUp || key.pageDown || key.home || key.end ||
        key.backspace || key.delete || key.tab || key.return || key.escape ||
        (key.ctrl && input))) {
      clearAccum()
    }

    if (key.upArrow) {
      if (!canEdit) { onScrollUp?.(); return }
      if (showCmds && cmdMatches.length > 0) {
        setCommandIdx(i => (i <= 0 ? cmdMatches.length - 1 : i - 1))
        return
      }
      if (!display.trim() && onScrollUp) { onScrollUp(); return }
      if (history.length > 0) {
        const idx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1)
        setHistoryIdx(idx)
        setSegments([{ type: "text", text: history[idx]! }])
        setCursor(history[idx]!.length)
      }
      return
    }

    if (key.downArrow) {
      if (!canEdit) { onScrollDown?.(); return }
      if (showCmds && cmdMatches.length > 0) {
        setCommandIdx(i => (i + 1) % cmdMatches.length)
        return
      }
      if (!display.trim() && onScrollDown) { onScrollDown(); return }
      if (historyIdx >= 0) {
        const idx = historyIdx + 1
        if (idx >= history.length) {
          setHistoryIdx(-1)
          setSegments([{ type: "text", text: "" }])
          setCursor(0)
        } else {
          setHistoryIdx(idx)
          setSegments([{ type: "text", text: history[idx]! }])
          setCursor(history[idx]!.length)
        }
      }
      return
    }

    if (key.leftArrow)  { if (canEdit) setCursor(p => previousFlatPos(segments, p)); return }
    if (key.rightArrow) { if (canEdit) setCursor(p => nextFlatPos(segments, p)); return }
    if (key.home || (key.ctrl && input === "a")) { if (canEdit) setCursor(0); return }
    if (key.end  || (key.ctrl && input === "e"))  { if (canEdit) setCursor(flatCursor(segments)); return }

    if (key.backspace) {
      if (!canEdit || cursor <= 0) return
      setHistoryIdx(-1); setCommandIdx(0)
      setSegments(prev => {
        const r = deleteBefore(prev, cursor)
        setCursor(r.newPos)
        return r.segs
      })
      return
    }

    if (key.delete) {
      if (!canEdit || cursor >= flatCursor(segments)) return
      setHistoryIdx(-1); setCommandIdx(0)
      setSegments(prev => deleteAfter(prev, cursor))
      return
    }

    if (key.tab) {
      if (canEdit && showCmds && selectedCmd && !/\s/.test(cmdText.trimStart().slice(1))) {
        setFromHistory(`/${selectedCmd.name}`)
      }
      return
    }

    if (key.return) {
      if (canEdit) submitValue(display)
      return
    }

    const ch = sanitizeInline(input)
    if (canEdit && ch) {
      // Time-window accumulation for chunked terminal pastes
      const raw = normalizeText(input)
      if (!accumRef.current) {
        accumRef.current = { startSegs: segments, startCursor: cursor, accumulated: raw }
      } else {
        accumRef.current.accumulated += raw
      }
      if (accumTimer.current) clearTimeout(accumTimer.current)
      accumTimer.current = setTimeout(flushAccum, ACCUMULATE_MS)

      setHistoryIdx(-1); setCommandIdx(0)
      setSegments(prev => {
        const next = insertChar(prev, cursor, ch)
        setCursor(p => Math.min(p + 1, flatCursor(next)))
        return next
      })
    }
  }, { isActive: focused || disabled || Boolean(onScrollUp || onScrollDown) })

  const statusText = disabled
    ? (status || "working...")
    : showCmds
      ? "Up/Down select  Enter send command"
      : pasteCount > 0
        ? `Enter send · ${pasteCount} paste block${pasteCount === 1 ? "" : "s"} · Backspace removes block`
        : "Enter send  / commands  Up/Down scroll  long-paste auto-compact"

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={disabled ? C.border : C.cyan} paddingX={1}>
      {showCmds && (
        <Box flexDirection="column" marginBottom={1}>
          {cmdMatches.length === 0 ? (
            <Text color={C.dim}>No slash command matches.</Text>
          ) : cmdMatches.map((cmd, i) => (
            <Text key={cmd.name} color={i === commandIdx ? C.cyan : C.dim}>
              {i === commandIdx ? ">" : " "} /{cmd.name} {cmd.description}{cmd.usage ? ` ${cmd.usage}` : ""}
            </Text>
          ))}
        </Box>
      )}
      <Box>
        <Text color={disabled ? C.dim : C.cyan}>{"> "}</Text>
        {disabled ? (
          <Text color={C.dim}>{placeholder || "DeepSeek Code is working..."}</Text>
        ) : (
          <Text>
            <Text color={C.fg}>{rendered.before}</Text>
            {cursorVis && <Text inverse color={C.fg}>{rendered.chr}</Text>}
            <Text color={C.fg}>{rendered.after}</Text>
          </Text>
        )}
      </Box>
      <Text color={pasteCount > 0 ? C.yellow : C.dim}>{statusText}</Text>
    </Box>
  )
}
