import { describe, test, expect, beforeEach } from "bun:test"
import { app, store } from "./index"

// ── Helpers ──────────────────────────────────────────────────────
function makeReq(method: string, path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, { method, ...init })
}
const req = makeReq

// Wipe store between tests
beforeEach(() => {
  store.clear()
})

// ══════════════════════════════════════════════════════════════════
// GET /
// ══════════════════════════════════════════════════════════════════
describe("GET /", () => {
  test("returns 200 OK", async () => {
    const res = await app.fetch(req("GET", "/"))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("OK")
  })
})

// ══════════════════════════════════════════════════════════════════
// POST /shorten
// ══════════════════════════════════════════════════════════════════
describe("POST /shorten", () => {
  test("creates short URL and returns 201", async () => {
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      })
    )

    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.shortUrl).toMatch(/^http:\/\/localhost\/[A-Za-z0-9]{6}$/)
    expect(json.originalUrl).toBe("https://example.com")
    expect(json.slug).toHaveLength(6)
    expect(json.createdAt).toBeDefined()

    // Verify store
    expect(store.has(json.slug)).toBe(true)
    expect(store.get(json.slug)!.originalUrl).toBe("https://example.com")
    expect(store.get(json.slug)!.visits).toBe(0)
  })

  test("returns 400 for invalid JSON body", async () => {
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      })
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("invalid JSON body")
  })

  test("returns 400 for empty body", async () => {
    const res = await app.fetch(req("POST", "/shorten"))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("invalid JSON body")
  })

  test("returns 400 when body is null", async () => {
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: "null",
      })
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("body must contain a 'url' field")
  })

  test("returns 400 when url field is missing", async () => {
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notUrl: "nope" }),
      })
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("body must contain a 'url' field")
  })

  test("returns 400 when body is an array", async () => {
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: "[]",
      })
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("body must contain a 'url' field")
  })

  test("returns 400 when body is a string", async () => {
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify("just a string"),
      })
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("body must contain a 'url' field")
  })

  test("returns 400 when body is a number", async () => {
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: "42",
      })
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("body must contain a 'url' field")
  })

  test("returns 400 when url is missing protocol", async () => {
    // No protocol
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "example.com" }),
      })
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("url must start with http:// or https://")
  })

  test("returns 400 for non-http protocol like ftp://", async () => {
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "ftp://files.example.com" }),
      })
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("url must start with http:// or https://")
  })

  test("returns 400 when url is not a string (number)", async () => {
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: 123 }),
      })
    )
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("url must start with http:// or https://")
  })

  test("generates unique slugs for different URLs", async () => {
    const slugs = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(
        req("POST", "/shorten", {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: `https://site-${i}.com` }),
        })
      )
      const json = await res.json()
      slugs.add(json.slug)
    }
    expect(slugs.size).toBe(5)
  })

  test("accepts extra fields in body, ignores them", async () => {
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com", extra: "ignored" }),
      })
    )
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.slug).toBeDefined()
  })

  test("handles very long URL", async () => {
    const longPath = "https://example.com/" + "a".repeat(2000)
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: longPath }),
      })
    )
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.originalUrl).toBe(longPath)
  })

  test("handles URL with unicode query params", async () => {
    const unicodeUrl = "https://example.com/search?q=café"
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: unicodeUrl }),
      })
    )
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.originalUrl).toBe(unicodeUrl)
  })

  test("handles URL with Chinese characters", async () => {
    const cnUrl = "https://example.com/你好"
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: cnUrl }),
      })
    )
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.originalUrl).toBe(cnUrl)
  })
})

// ══════════════════════════════════════════════════════════════════
// GET /:slug (redirect)
// ══════════════════════════════════════════════════════════════════
describe("GET /:slug", () => {
  // Helper: shorten a URL and return the slug
  async function shorten(url = "https://example.com"): Promise<string> {
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      })
    )
    const json = await res.json()
    return json.slug
  }

  test("redirects to original URL with 302", async () => {
    const slug = await shorten("https://example.com/page")
    const res = await app.fetch(req("GET", `/${slug}`))

    expect(res.status).toBe(302)
    expect(res.headers.get("Location")).toBe("https://example.com/page")
  })

  test("increments visit count on each redirect", async () => {
    const slug = await shorten()

    // 0 visits initially
    expect(store.get(slug)!.visits).toBe(0)

    // 1st visit
    await app.fetch(req("GET", `/${slug}`))
    expect(store.get(slug)!.visits).toBe(1)

    // 2nd visit
    await app.fetch(req("GET", `/${slug}`))
    expect(store.get(slug)!.visits).toBe(2)

    // 3rd visit
    await app.fetch(req("GET", `/${slug}`))
    expect(store.get(slug)!.visits).toBe(3)
  })

  test("returns 404 for non-existent slug", async () => {
    const res = await app.fetch(req("GET", "/aBcDeF"))
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe("not found")
  })

  test("does not match too-short slug (5 chars)", async () => {
    // The route regex requires exactly 6 chars, so a 5-char slug should
    // fall through and not match this route. Hono returns 404 by default.
    const res = await app.fetch(req("GET", "/abcde"))
    expect(res.status).toBe(404)
  })

  test("does not match slug with special chars", async () => {
    // Slashes, hyphens, underscores should not match the [A-Za-z0-9]{6} regex
    const res = await app.fetch(req("GET", "/abc-def"))
    expect(res.status).toBe(404)
  })

  test("does not match slug with spaces encoded", async () => {
    const res = await app.fetch(req("GET", "/ab cd12"))
    expect(res.status).toBe(404)
  })

  test("redirects with https:// URL", async () => {
    const slug = await shorten("https://secure.example.com")
    const res = await app.fetch(req("GET", `/${slug}`))
    expect(res.status).toBe(302)
    expect(res.headers.get("Location")).toBe("https://secure.example.com")
  })
})

// ══════════════════════════════════════════════════════════════════
// GET /stats/:slug
// ══════════════════════════════════════════════════════════════════
describe("GET /stats/:slug", () => {
  async function shorten(url = "https://example.com"): Promise<string> {
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      })
    )
    const json = await res.json()
    return json.slug
  }

  test("returns stats for existing slug with 0 visits", async () => {
    const slug = await shorten("https://example.com")
    const res = await app.fetch(req("GET", `/stats/${slug}`))

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.slug).toBe(slug)
    expect(json.originalUrl).toBe("https://example.com")
    expect(json.visits).toBe(0)
    expect(json.createdAt).toBeDefined()
  })

  test("returns updated visit count after redirects", async () => {
    const slug = await shorten()
    await app.fetch(req("GET", `/${slug}`))
    await app.fetch(req("GET", `/${slug}`))

    const res = await app.fetch(req("GET", `/stats/${slug}`))
    const json = await res.json()
    expect(json.visits).toBe(2)
  })

  test("returns 404 for non-existent slug", async () => {
    const res = await app.fetch(req("GET", "/stats/zzzzzz"))
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toBe("not found")
  })
})

// ══════════════════════════════════════════════════════════════════
// GET /stats
// ══════════════════════════════════════════════════════════════════
describe("GET /stats", () => {
  async function shorten(url: string): Promise<string> {
    const res = await app.fetch(
      req("POST", "/shorten", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      })
    )
    const json = await res.json()
    return json.slug
  }

  test("returns empty array when store is empty", async () => {
    const res = await app.fetch(req("GET", "/stats"))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual([])
  })

  test("returns all entries sorted by visits descending", async () => {
    const slugA = await shorten("https://a.com")
    const slugB = await shorten("https://b.com")
    const slugC = await shorten("https://c.com")

    // Visit B 3 times, A 1 time, C 0 times
    await app.fetch(req("GET", `/${slugB}`))
    await app.fetch(req("GET", `/${slugB}`))
    await app.fetch(req("GET", `/${slugB}`))
    await app.fetch(req("GET", `/${slugA}`))

    const res = await app.fetch(req("GET", "/stats"))
    const json: Array<{ slug: string; visits: number }> = await res.json()

    expect(json.length).toBe(3)

    // Sorted: B(3) → A(1) → C(0)
    expect(json[0]!.slug).toBe(slugB)
    expect(json[0]!.visits).toBe(3)
    expect(json[1]!.slug).toBe(slugA)
    expect(json[1]!.visits).toBe(1)
    expect(json[2]!.slug).toBe(slugC)
    expect(json[2]!.visits).toBe(0)
  })

  test("each entry has required fields", async () => {
    await shorten("https://example.com")
    const res = await app.fetch(req("GET", "/stats"))
    const json: Array<Record<string, unknown>> = await res.json()

    expect(json.length).toBe(1)
    const entry = json[0]!
    expect(entry.slug).toBeString()
    expect(entry.originalUrl).toBe("https://example.com")
    expect(entry.visits).toBe(0)
    expect(entry.createdAt).toBeString()
  })
})
