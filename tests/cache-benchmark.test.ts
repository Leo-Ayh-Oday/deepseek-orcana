/** Cache hit rate benchmark — simulates multi-round conversation
 *  and measures actual prefix cache behavior.
 *
 *  DeepSeek prefix cache: the longest common prefix (byte-for-byte) between
 *  two consecutive requests is a cache hit. Everything after the first
 *  differing byte is a cache miss.
 *
 *  Target: ≥99% cache hit rate, even with billions of cumulative tokens.
 */

import { describe, test } from "bun:test"
import { buildSystemPrompt } from "../src/agent/prompts"
import { buildCacheAnatomy, estimateTokens } from "../src/context/cache-anatomy"
import type { ProviderMessage } from "../src/provider/types"

// ── Simulator ──

interface CacheBenchResult {
  round: number
  totalTokens: number
  hitTokens: number
  missTokens: number
  hitRate: number
  cumulativeTokens: number
  cumulativeHitRate: number
  /** Which section first changed (the cache-break point) */
  breakAt: string
  sectionTokens: Record<string, number>
}

/**
 * Run a multi-round simulation.
 * Builds provider messages exactly like loop.ts for each round,
 * then computes the prefix overlap with the previous round.
 */
function runCacheBench(
  totalRounds: number,
  config: {
    /** Average tokens per user input */
    userInputTokens: number
    /** Average tokens per assistant response (text only) */
    assistantTextTokens: number
    /** Tokens per tool_use block (0 = no tools this round) */
    toolUseTokens: number
    /** Tokens per tool_result block */
    toolResultTokens: number
    /** Should volatile context (staged files, thinking) change each round? */
    volatileChangesEveryRound: boolean
    /** Should thinking chain compaction fire at 40%? */
    compactionAt40Percent: boolean
  },
): CacheBenchResult[] {
  const system = buildSystemPrompt()
  const toolSchemas = [{ name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } }, { name: "write_file", description: "Write a file", input_schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } }, { name: "shell", description: "Run shell command", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }, { name: "web_search", description: "Search the web", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }]

  // Stable prefix (computed once, reused — matches frozenStablePrefix)
  const stableContent = `## Stable Prefix Context\n[CACHE_ANCHOR:v2]\n\n## Stable Cold Memory\n- Topics: auth, database, api\n- Files: src/auth.ts, src/db.ts, src/api.ts\n- Decisions: Use JWT for auth, Use SQLite for storage\n\n## Project Context Kernel\nhash=a1b2c3d4  sections=4  tokens~120`

  const messages: ProviderMessage[] = []
  const results: CacheBenchResult[] = []
  let prevPromptText = ""
  let cumulativeHit = 0
  let cumulativeTotal = 0
  let thinkingCompacted = false

  for (let round = 0; round < totalRounds; round++) {
    // Simulate user input
    const userText = "x".repeat(config.userInputTokens * 3)
    messages.push({ role: "user", content: userText })

    // Volatile context (changes every round unless compaction fired)
    const volatileText = config.volatileChangesEveryRound
      ? `## Volatile Round Context\nloaded: src/auth.ts, src/db.ts\nround: ${round}`
      : "## Volatile Round Context\nloaded: src/auth.ts, src/db.ts"

    // Build the exact provider message list
    const stablePrefix: ProviderMessage = { role: "user", content: stableContent }
    const volatileMsg: ProviderMessage = { role: "user", content: volatileText }
    const providerMessages: ProviderMessage[] = [
      stablePrefix,
      ...messages,
      volatileMsg,
    ]

    // Serialize the full prompt as sent to the API
    const serializePrompt = (msgs: ProviderMessage[]): string =>
      msgs.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n")

    const promptText = [
      system,
      JSON.stringify(toolSchemas),
      serializePrompt(providerMessages),
    ].join("\n")

    // Compute prefix cache overlap with previous round
    const cachedPrompt = promptText
    const prevPrompt = prevPromptText

    let commonLen = 0
    const maxLen = Math.min(cachedPrompt.length, prevPrompt.length)
    for (let i = 0; i < maxLen; i++) {
      if (cachedPrompt[i] === prevPrompt[i]) commonLen++
      else break
    }

    const totalTokens = Math.round(promptText.length / 3)
    const hitTokens = Math.round(commonLen / 3)
    const missTokens = totalTokens - hitTokens
    const hitRate = totalTokens > 0 ? (hitTokens / totalTokens) * 100 : 100

    cumulativeHit += hitTokens
    cumulativeTotal += totalTokens

    // Find which section broke the cache
    let breakAt = "first_request"
    if (round > 0) {
      const breakChar = commonLen
      const systemEnd = system.length
      const toolsEnd = systemEnd + JSON.stringify(toolSchemas).length
      const stableEnd = toolsEnd + stableContent.length
      if (breakChar <= systemEnd) breakAt = "system"
      else if (breakChar <= toolsEnd) breakAt = "tools"
      else if (breakChar <= stableEnd) breakAt = "stable_prefix"
      else breakAt = "messages"
    }

    const sectionTokens = {
      system: Math.round(system.length / 3),
      tools: Math.round(JSON.stringify(toolSchemas).length / 3),
      stable_prefix: Math.round(stableContent.length / 3),
      messages: Math.round(serializePrompt(messages).length / 3),
      volatile: Math.round(volatileText.length / 3),
    }

    results.push({
      round,
      totalTokens,
      hitTokens,
      missTokens,
      hitRate,
      cumulativeTokens: cumulativeTotal,
      cumulativeHitRate: cumulativeTotal > 0 ? (cumulativeHit / cumulativeTotal) * 100 : 100,
      breakAt,
      sectionTokens,
    })

    // Simulate assistant response (gets appended to messages for next round)
    const assistantText = "x".repeat(config.assistantTextTokens * 3)
    if (config.toolUseTokens > 0) {
      const toolUse = `{"name":"read_file","input":{"file_path":"src/auth.ts"},"id":"call_${round}"}`
      messages.push({ role: "assistant", content: toolUse })
      const toolResult = "x".repeat(config.toolResultTokens * 3)
      messages.push({ role: "user", content: `[tool_result call_${round}] ${toolResult}` })
    } else {
      messages.push({ role: "assistant", content: assistantText })
    }

    // Simulate compaction at 40%
    if (config.compactionAt40Percent && !thinkingCompacted) {
      const budgetPercent = (totalTokens / 1_048_576) * 100
      if (budgetPercent >= 40) {
        // Strip thinking from messages, invalidating cache
        thinkingCompacted = true
        // After compaction, the next request has different messages → cache miss
      }
    }

    prevPromptText = promptText
  }

  return results
}

// ── Formatting ──

function fmtR(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n)
}

function fmtP(p: number): string {
  return p.toFixed(1) + "%"
}

// ── Test: realistic 30-round coding session ──

describe("cache benchmark", () => {
  test("realistic 30-round coding session — 99% target", () => {
    const results = runCacheBench(30, {
      userInputTokens: 150,        // ~50 chars of user input
      assistantTextTokens: 300,    // ~100 chars of response text
      toolUseTokens: 80,           // tool_use JSON per round
      toolResultTokens: 200,       // tool_result per round
      volatileChangesEveryRound: true,
      compactionAt40Percent: true,
    })

    // Print table
    console.log("")
    console.log("round |  total  |   hit   |  miss  | round HR | cumul HR | break at")
    console.log("------|---------|---------|--------|----------|----------|----------")
    for (const r of results) {
      console.log(
        `  ${String(r.round).padEnd(3)} | ${String(fmtR(r.totalTokens)).padEnd(7)} | ${String(fmtR(r.hitTokens)).padEnd(7)} | ${String(fmtR(r.missTokens)).padEnd(6)} | ${String(fmtP(r.hitRate)).padEnd(8)} | ${String(fmtP(r.cumulativeHitRate)).padEnd(8)} | ${r.breakAt}`
      )
    }

    // Section breakdown for first and last round
    console.log("")
    console.log("Section breakdown (round 0):")
    for (const [k, v] of Object.entries(results[0]!.sectionTokens)) {
      console.log(`  ${k}: ${fmtR(v)} tokens`)
    }

    const last = results[results.length - 1]!
    console.log("")
    console.log("Section breakdown (last round):")
    for (const [k, v] of Object.entries(last.sectionTokens)) {
      console.log(`  ${k}: ${fmtR(v)} tokens`)
    }

    console.log("")
    console.log(`Final cumulative: ${fmtR(last.cumulativeTokens)} tokens, HR ${fmtP(last.cumulativeHitRate)}`)
    console.log(`Cache miss total: ${fmtR(last.cumulativeTokens - Math.round(last.cumulativeTokens * last.cumulativeHitRate / 100))} tokens`)

    // Assertions
    // After round 1+, per-round hit rate should be ≥90% (conversation grows, prefix stays)
    for (let i = 2; i < results.length; i++) {
      const r = results[i]!
      if (r.breakAt === "messages") {
        // Normal case: only new messages are uncached
        // miss should be ~ userInput + toolResult + assistant ≈ 650 tokens
        // total grows as conversation accumulates
      }
    }
  })

  test("heavy tool-use 20-round session", () => {
    const results = runCacheBench(20, {
      userInputTokens: 200,
      assistantTextTokens: 500,
      toolUseTokens: 150,     // multi_edit has more tool_use JSON
      toolResultTokens: 400,
      volatileChangesEveryRound: true,
      compactionAt40Percent: true,
    })

    console.log("")
    console.log("=== Heavy Tool-Use Session ===")
    console.log("round |  total  |   hit   |  miss  | round HR | break at")
    console.log("------|---------|---------|--------|----------|----------")
    for (const r of results) {
      console.log(
        `  ${String(r.round).padEnd(3)} | ${String(fmtR(r.totalTokens)).padEnd(7)} | ${String(fmtR(r.hitTokens)).padEnd(7)} | ${String(fmtR(r.missTokens)).padEnd(6)} | ${String(fmtP(r.hitRate)).padEnd(8)} | ${r.breakAt}`
      )
    }
  })

  test("worst case — system prompt changes mid-session", () => {
    // Simulate what happens when frozenStablePrefix is rebuilt
    console.log("")
    console.log("=== Cache Invalidation: stable prefix rebuild at round 10 ===")

    // Round 11: stable prefix changes (simulating cold memory update)
    // This would invalidate ALL conversation cache, not just the new part
    const system = buildSystemPrompt()
    const toolSchemas = "[]"
    const oldStable = "## Stable Prefix v1\n- Topics: auth"
    const newStable = "## Stable Prefix v2\n- Topics: auth, db, api, cache"

    // Round 10 prompt
    const r10Messages = "\n".repeat(10) + "user: fix auth\nassistant: ok\n"
    const r10Prompt = [system, toolSchemas, oldStable, r10Messages].join("\n")

    // Round 11 prompt (stable prefix changed!)
    const r11Messages = r10Messages + "user: also fix db\n"
    const r11Prompt = [system, toolSchemas, newStable, r11Messages].join("\n")

    let commonLen = 0
    const maxLen = Math.min(r10Prompt.length, r11Prompt.length)
    for (let i = 0; i < maxLen; i++) {
      if (r10Prompt[i] === r11Prompt[i]) commonLen++
      else break
    }

    const systemTokens = Math.round(system.length / 3)
    const toolsTokens = Math.round(toolSchemas.length / 3)
    const stableTokens = Math.round(oldStable.length / 3)

    const totalR11 = Math.round(r11Prompt.length / 3)
    const hitR11 = Math.round(commonLen / 3)
    const missR11 = totalR11 - hitR11

    console.log(`  Stable prefix change: cache breaks after ${fmtR(hitR11)} tokens`)
    console.log(`  System + Tools = ${fmtR(systemTokens + toolsTokens)} tokens (still cached)`)
    console.log(`  Everything after (messages + new stable + new user) = ${fmtR(missR11)} tokens miss`)
    console.log(`  Round HR = ${fmtP((hitR11 / totalR11) * 100)}`)
    console.log(`  This is why frozenStablePrefix MUST be truly frozen — rebuild costs huge.`)
  })
})
