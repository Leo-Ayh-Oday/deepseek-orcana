import { Hono } from "hono"

const app = new Hono()

// ── In-memory store ──────────────────────────────────────────────
interface Entry {
  originalUrl: string
  visits: number
  createdAt: string
}

const store = new Map<string, Entry>()

// ── Slug helpers ─────────────────────────────────────────────────
const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

function randomSlug(length = 6): string {
  let slug = ""
  for (let i = 0; i < length; i++) {
    slug += CHARS[Math.floor(Math.random() * CHARS.length)]
  }
  return slug
}

function generateUniqueSlug(): string {
  for (let i = 0; i < 10; i++) {
    const slug = randomSlug()
    if (!store.has(slug)) return slug
  }
  throw new Error("slug collision after 10 attempts — store may be too full")
}

// ── URL validation ───────────────────────────────────────────────
function isValidUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false
  return raw.startsWith("http://") || raw.startsWith("https://")
}

// ── Routes ───────────────────────────────────────────────────────

// Health
app.get("/", (c) => c.text("OK"))

// POST /shorten
app.post("/shorten", async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "invalid JSON body" }, 400)
  }

  if (body === null || typeof body !== "object" || !("url" in body)) {
    return c.json({ error: "body must contain a 'url' field" }, 400)
  }

  const url = (body as Record<string, unknown>).url

  if (!isValidUrl(url)) {
    return c.json({ error: "url must start with http:// or https://" }, 400)
  }

  const slug = generateUniqueSlug()
  const entry: Entry = {
    originalUrl: url,
    visits: 0,
    createdAt: new Date().toISOString(),
  }
  store.set(slug, entry)

  const shortUrl = `${new URL(c.req.url).origin}/${slug}`

  return c.json({ shortUrl, originalUrl: url, slug, createdAt: entry.createdAt }, 201)
})

// GET /:slug → redirect
app.get("/:slug{[A-Za-z0-9]{6}}", (c) => {
  const slug = c.req.param("slug")
  const entry = store.get(slug)

  if (!entry) {
    return c.json({ error: "not found" }, 404)
  }

  entry.visits++
  return c.redirect(entry.originalUrl, 302)
})

// GET /stats/:slug
app.get("/stats/:slug{[A-Za-z0-9]{6}}", (c) => {
  const slug = c.req.param("slug")
  const entry = store.get(slug)

  if (!entry) {
    return c.json({ error: "not found" }, 404)
  }

  return c.json({
    slug,
    originalUrl: entry.originalUrl,
    visits: entry.visits,
    createdAt: entry.createdAt,
  })
})

// GET /stats
app.get("/stats", (c) => {
  const all = Array.from(store.entries()).map(([slug, entry]) => ({
    slug,
    originalUrl: entry.originalUrl,
    visits: entry.visits,
    createdAt: entry.createdAt,
  }))

  all.sort((a, b) => b.visits - a.visits)

  return c.json(all)
})

export default { port: 3000, fetch: app.fetch }
export { app, store }
