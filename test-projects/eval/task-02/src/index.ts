import { Hono } from "hono"
const app = new Hono()
app.get("/", (c) => c.text("OK"))

app.get("/time", (c) => {
  const now = new Date()
  return c.json({ now: now.toISOString(), unix: now.getTime() })
})

export default { port: 3000, fetch: app.fetch }
