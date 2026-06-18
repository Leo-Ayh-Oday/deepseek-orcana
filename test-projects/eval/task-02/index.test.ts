import { describe, expect, it } from "bun:test"
import appModule from "./src/index"

describe("GET /time", () => {
  it("returns 200 with valid JSON", async () => {
    const res = await appModule.fetch(new Request("http://localhost/time"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.now).toBe("string")
    expect(typeof body.unix).toBe("number")
    // ISO string round-trips
    expect(new Date(body.now).toISOString()).toBe(body.now)
    // unix is within last 60s
    expect(Date.now() - body.unix).toBeLessThan(60_000)
  })
})

describe("GET /", () => {
  it("returns 200 OK", async () => {
    const res = await appModule.fetch(new Request("http://localhost/"))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toBe("OK")
  })
})
