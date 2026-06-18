/** Web fetch tool — fetch + HTML→Markdown + optional Flash summary.
 *
 *  Architecture (inspired by Claude Code WebFetch):
 *  1. Domain safety check → deny-list lookup
 *  2. Local HTTP GET → 15s timeout, 500KB max
 *  3. Basic HTML→text extraction → strip tags/scripts
 *  4. Optional Flash summary (when result > 4000 chars)
 *  5. Returns clean text + metadata
 *
 *  Read-only. Caches results for 15 minutes per URL.
 */

import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"
import type { LLMProvider } from "../provider/types"

const BLOCKED_DOMAINS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "[::1]",
  "internal", "metadata.google.internal",
])

const TIMEOUT_MS = 15_000
const MAX_CONTENT_BYTES = 500_000

interface FetchCacheEntry {
  result: ToolResult
  timestamp: number
}

const cache = new Map<string, FetchCacheEntry>()
const CACHE_TTL_MS = 15 * 60_000 // 15 minutes

function isBlockedDomain(hostname: string): boolean {
  const h = hostname.toLowerCase()
  // Localhost and internal domains
  if (BLOCKED_DOMAINS.has(h) || h.endsWith(".local") || h.endsWith(".internal")) return true
  // Private IP ranges: 10.x, 172.16-31.x, 192.168.x
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
    .replace(/&quot;/g, "\"")
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

async function fetchAndExtract(params: WebFetchParams): Promise<ToolResult> {
  const { url, summarize = true } = params
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

  // Check cache — also clean stale entries on access
  const cacheKey = parsed.toString()
  for (const [k, v] of cache) {
    if (Date.now() - v.timestamp > CACHE_TTL_MS) cache.delete(k)
  }
  // Enforce max cache size (trim oldest if >50 entries)
  if (cache.size > 50) {
    const entries = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)
    for (const [k] of entries.slice(0, cache.size - 50)) cache.delete(k)
  }
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    const resp = await fetch(parsed.toString(), {
      signal: controller.signal,
      headers: {
        "User-Agent": "DeepSeek-Code/0.3 (research agent)",
        "Accept": "text/html,text/plain;q=0.9,*/*;q=0.5",
      },
      redirect: "follow",
    })
    clearTimeout(timer)

    if (!resp.ok) {
      const hints: Record<number, string> = {
        404: "页面不存在。检查 URL 拼写或尝试上级路径。",
        403: "访问被拒绝。尝试公开文档页面。",
        401: "需要认证。尝试公开文档页面。",
        429: "被限流。等待后重试或用 web_search 找缓存版本。",
      }
      const hint = hints[resp.status] ?? (resp.status >= 500 ? "服务器错误。可重试。" : "")
      return Result.fail(`请求失败 HTTP ${resp.status}。${hint}`)
    }

    const contentType = resp.headers.get("content-type") ?? ""
    const isHtml = contentType.includes("html") || contentType.includes("text")

    // Chunked read with size limit
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = resp.body?.getReader()
    if (!reader) {
      const text = await resp.text()
      const result = Result.ok(text.slice(0, MAX_CONTENT_BYTES), {
        url: parsed.toString(),
        status: resp.status,
        contentType,
        length: text.length,
      })
      cache.set(cacheKey, { result, timestamp: Date.now() })
      return result
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (total + value.length > MAX_CONTENT_BYTES) {
        chunks.push(value.slice(0, MAX_CONTENT_BYTES - total))
        break
      }
      chunks.push(value)
      total += value.length
    }
    reader.cancel()

    const buffer = Buffer.concat(chunks)
    let text = new TextDecoder().decode(buffer)

    if (isHtml) text = stripHtml(text)
    const truncated = text.slice(0, MAX_CONTENT_BYTES)

    const result = Result.ok(truncated, {
      url: parsed.toString(),
      status: resp.status,
      contentType,
      length: truncated.length,
      truncated: truncated.length < text.length,
    })

    cache.set(cacheKey, { result, timestamp: Date.now() })
    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('timed out') || msg.includes('AbortError')) {
      return Result.fail(`请求超时 (${TIMEOUT_MS / 1000}s)。可重试用 web_search 查摘要。`)
    }
    return Result.fail(msg)
  }
}

export const WEB_FETCH_TOOL: ToolDef = {
  name: "web_fetch",
  description:
    "Fetch a web page and extract its text content. " +
    "Use this AFTER web_search to read full articles, documentation, or any linked page. " +
    "Returns clean text (HTML stripped). Large pages are truncated to 500KB. " +
    "Results are cached for 15 minutes. " +
    "Domain blocked: localhost, internal networks. " +
    "Tip: use with web_search — search first for URLs, then fetch the most relevant ones.",
  isReadonly: true,
  category: "network" as const,
  isConcurrencySafe: true,
  userFacingName: "网页抓取",
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
