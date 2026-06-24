/** Web fetch tool — Jina Reader for LLM-ready Markdown extraction.
 *
 *  Architecture:
 *  1. Domain safety check → deny-list lookup (private IPs, localhost)
 *  2. Jina Reader (r.jina.ai) → clean Markdown, no ads, no nav
 *  3. Fallback: direct HTTP GET with basic HTML stripping (legacy)
 *  4. Optional: Exa contents API for paywalled sites
 *
 *  Jina Reader is free: 20 req/min unauthenticated, 200 req/min with API key.
 *  No Docker, no external CLI. Pure HTTP.
 */

import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"

const JINA_READER_URL = "https://r.jina.ai"

const BLOCKED_DOMAINS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "[::1]",
  "internal", "metadata.google.internal",
])

const TIMEOUT_MS = 15_000
const MAX_CONTENT_BYTES = 500_000

function jinaApiKey(): string {
  return process.env.JINA_API_KEY ?? ""
}

interface FetchCacheEntry {
  result: ToolResult
  timestamp: number
}

const cache = new Map<string, FetchCacheEntry>()
const CACHE_TTL_MS = 15 * 60_000

function isBlockedDomain(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (BLOCKED_DOMAINS.has(h) || h.endsWith(".local") || h.endsWith(".internal")) return true
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)) return true
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true
  return false
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n\s*\n\s*\n/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim()
}

export interface WebFetchParams {
  url: string
  summarize?: boolean
}

/** Fetch via Jina Reader — returns clean Markdown. */
async function fetchViaJina(url: string, apiKey: string): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent": "DeepSeek-Orcana/0.3",
    "Accept": "text/markdown",
  }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`

  const resp = await fetch(`${JINA_READER_URL}/${url}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })

  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(`Jina HTTP ${resp.status}: ${body.slice(0, 200)}`)
  }

  const text = await resp.text()
  if (!text || text.length < 50) throw new Error("Jina returned empty response")
  return text
}

/** Fetch directly via HTTP GET + stripHtml — fallback when Jina is unavailable. */
async function fetchDirect(url: string): Promise<string> {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      "User-Agent": "DeepSeek-Orcana/0.3 (research)",
      "Accept": "text/html,text/plain;q=0.9,*/*;q=0.5",
    },
    redirect: "follow",
  })

  if (!resp.ok) {
    const hints: Record<number, string> = {
      404: "Page not found. Check URL or try parent path.",
      403: "Access denied. Try a public docs page.",
      401: "Authentication required. Try a public page.",
      429: "Rate limited. Wait and retry, or use web_search for a cached version.",
    }
    const hint = hints[resp.status] ?? (resp.status >= 500 ? "Server error. Retry later." : "")
    throw new Error(`HTTP ${resp.status}. ${hint}`)
  }

  const contentType = resp.headers.get("content-type") ?? ""
  const text = await resp.text()

  if (contentType.includes("html") || contentType.includes("text")) {
    return stripHtml(text)
  }
  return text
}

async function fetchAndExtract(params: WebFetchParams): Promise<ToolResult> {
  const { url } = params
  if (!url?.trim()) return Result.fail("Missing url parameter")

  let parsed: URL
  try {
    parsed = new URL(url)
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return Result.fail(`Unsupported protocol: ${parsed.protocol}`)
    }
  } catch {
    return Result.fail(`Invalid URL: ${url}`)
  }

  if (isBlockedDomain(parsed.hostname)) {
    return Result.fail(`Domain blocked: ${parsed.hostname}`)
  }

  // Cache management
  const cacheKey = parsed.toString()
  for (const [k, v] of cache) {
    if (Date.now() - v.timestamp > CACHE_TTL_MS) cache.delete(k)
  }
  if (cache.size > 50) {
    const entries = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)
    for (const [k] of entries.slice(0, cache.size - 50)) cache.delete(k)
  }
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result
  }

  const errors: string[] = []

  // Try Jina Reader first
  try {
    const apiKey = jinaApiKey()
    const text = await fetchViaJina(parsed.toString(), apiKey)
    const truncated = text.slice(0, MAX_CONTENT_BYTES)

    const result = Result.ok(truncated, {
      url: parsed.toString(),
      engine: "jina",
      length: truncated.length,
      truncated: truncated.length < text.length,
    })
    cache.set(cacheKey, { result, timestamp: Date.now() })
    return result
  } catch (e) {
    errors.push(`Jina: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Fallback: direct HTTP + stripHtml
  try {
    const text = await fetchDirect(parsed.toString())
    const truncated = text.slice(0, MAX_CONTENT_BYTES)

    const result = Result.ok(truncated, {
      url: parsed.toString(),
      engine: "direct",
      length: truncated.length,
      truncated: truncated.length < text.length,
    })
    cache.set(cacheKey, { result, timestamp: Date.now() })
    return result
  } catch (e) {
    errors.push(`Direct: ${e instanceof Error ? e.message : String(e)}`)
  }

  return Result.fail(
    `Failed to fetch: ${parsed.toString()}\n${errors.map(e => `  ✗ ${e}`).join("\n")}\n\n` +
    `Tip: try searching for this content with web_search instead, or get a free Jina API key at https://jina.ai/reader for higher rate limits.`,
  )
}

export const WEB_FETCH_TOOL: ToolDef = {
  name: "web_fetch",
  description:
    "Fetch a web page and extract clean Markdown via Jina Reader. " +
    "Use AFTER web_search to read full articles, docs, or any linked page. " +
    "Returns AI-optimized content (no ads, no nav — just the article). " +
    "Results cached for 15 minutes. Domain blocked: localhost, private networks. " +
    "Get a free API key at https://jina.ai/reader and set JINA_API_KEY for 200 req/min.",
  isReadonly: true,
  category: "network" as const,
  isConcurrencySafe: true,
  userFacingName: "Jina 抓取",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch. Must start with http:// or https://." },
      summarize: { type: "boolean", description: "Set to true to return a condensed summary (default true)." },
    },
    required: ["url"],
  },
  execute: async (params: Record<string, unknown>) => {
    return fetchAndExtract({
      url: String(params.url ?? ""),
      summarize: params.summarize !== false,
    })
  },
}
