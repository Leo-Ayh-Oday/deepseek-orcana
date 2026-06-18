/** Web search — SearXNG + DuckDuckGo. */

import type { ToolDef, ToolResult } from "./registry"
import { Result } from "./registry"

function timeoutFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.max(1, Math.round(raw))
}

async function fetchWithDeadline(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const upstream = init.signal
  const onAbort = () => controller.abort()
  if (upstream) {
    if (upstream.aborted) controller.abort()
    else upstream.addEventListener("abort", onAbort, { once: true })
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`search request timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (upstream) upstream.removeEventListener("abort", onAbort)
  }
}

async function web_search(params: Record<string, unknown>): Promise<ToolResult> {
  const query = String(params.query ?? "").trim()
  if (!query) return Result.fail("web_search requires a non-empty query.")

  const results: Array<{ title: string; url: string; snippet: string }> = []
  const errors: string[] = []
  const searxngTimeoutMs = timeoutFromEnv("DEEPSEEK_SEARCH_SEARXNG_TIMEOUT_MS", 1500)
  const duckDuckGoTimeoutMs = timeoutFromEnv("DEEPSEEK_SEARCH_DDG_TIMEOUT_MS", 4000)

  // Try local SearXNG first. Common local ports are 8888 and 8080.
  for (const baseUrl of ["http://127.0.0.1:8888", "http://127.0.0.1:8080"]) {
    try {
      const resp = await fetchWithDeadline(`${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`, {
        headers: { "User-Agent": "DeepSeekCode/0.1" },
      }, searxngTimeoutMs)
      if (resp.ok) {
        const data = await resp.json() as { results?: Array<{ title: string; url: string; content: string }> }
        for (const r of (data.results ?? []).slice(0, 10)) {
          results.push({ title: r.title, url: r.url, snippet: (r.content ?? "").slice(0, 300) })
        }
        if (results.length > 0) {
          return formatResults(query, results, `SearXNG ${baseUrl}`)
        }
      }
    } catch (e) {
      errors.push(`SearXNG ${baseUrl}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Fallback to DuckDuckGo HTML
  try {
    const resp = await fetchWithDeadline(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    }, duckDuckGoTimeoutMs)
    if (resp.ok) {
      const html = await resp.text()
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>.*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gis
      let m: RegExpExecArray | null
      while ((m = re.exec(html)) && results.length < 10) {
        results.push({
          title: (m[2] ?? "").trim(),
          url: (m[1] ?? "").trim(),
          snippet: (m[3] ?? "").replace(/<[^>]+>/g, "").trim().slice(0, 300),
        })
      }
      if (results.length > 0) {
        return formatResults(query, results, "DuckDuckGo")
      }
    } else {
      errors.push(`DuckDuckGo: HTTP ${resp.status} — likely rate-limited`)
    }
  } catch (e) {
    errors.push(`DuckDuckGo: ${e instanceof Error ? e.message : String(e)}`)
  }

  const diag = errors.map(e => `  ✗ ${e}`).join("\n")
  return Result.fail(
    `All search engines failed for: ${query}\n${diag}\n\nSuggestions: Start SearXNG on port 8888 or 8080, provide a URL, or try again later.`,
  )
}

function formatResults(query: string, results: Array<{ title: string; url: string; snippet: string }>, engine: string): ToolResult {
  const lines = [`[${engine}] Search results for: ${query}\n`]
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`)
    lines.push(`   ${r.url}`)
    if (r.snippet) lines.push(`   ${r.snippet.slice(0, 200)}`)
    lines.push("")
  })
  return Result.ok(lines.join("\n"), { count: results.length, engine })
}

export const WEB_SEARCH: ToolDef = {
  name: "web_search",
  description: "Search the web using SearXNG (local Docker) or DuckDuckGo (fallback). Returns results or diagnostic error. If search fails, try different keywords or ask user to start SearXNG.",
  isReadonly: true,
  category: "network" as const,
  isConcurrencySafe: true,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  },
  execute: web_search,
}
