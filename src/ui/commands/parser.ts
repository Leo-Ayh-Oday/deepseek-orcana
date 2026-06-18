/** Minimal argument parser for slash commands.
 *
 *  Supports:
 *    - Positional args matched by order
 *    - Rest args: everything after command name captured as one value
 *    - Boolean flags: --verbose / -v
 *    - String flags: --model gpt-5 / -m gpt-5
 */

import type { CommandDef, ParsedArgs } from "./types"

export function parseArgs(rawInput: string, def: CommandDef): ParsedArgs {
  const tokens = splitTokens(rawInput)
  const positional: Record<string, string> = {}
  const flags: Record<string, unknown> = {}

  let argIdx = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!

    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=")
      const name = eqIdx >= 0 ? token.slice(2, eqIdx) : token.slice(2)
      const value = eqIdx >= 0 ? token.slice(eqIdx + 1) : tokens[i + 1] ?? "true"
      flags[name] = value
      if (eqIdx < 0 && tokens[i + 1] !== undefined) i++
      continue
    }

    if (token.startsWith("-") && token.length === 2) {
      const name = token.slice(1)
      const next = tokens[i + 1]
      if (next !== undefined && !next.startsWith("-")) {
        flags[name] = next
        i++
      } else {
        flags[name] = "true"
      }
      continue
    }

    // Positional matching
    if (def.args && argIdx < def.args.length) {
      const slot = def.args[argIdx]!
      if (slot.rest) {
        positional[slot.name] = tokens.slice(i).join(" ")
        i = tokens.length
      } else {
        positional[slot.name] = token
        argIdx++
      }
    }
  }

  return { positional, flags, raw: tokens.join(" ") }
}

function splitTokens(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inQuote = false
  let quoteChar = ""

  for (const ch of input) {
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; continue }
      current += ch
    } else if (ch === '"' || ch === "'") {
      inQuote = true
      quoteChar = ch
    } else if (ch === " ") {
      if (current) { tokens.push(current); current = "" }
    } else {
      current += ch
    }
  }
  if (current) tokens.push(current)

  return tokens
}
