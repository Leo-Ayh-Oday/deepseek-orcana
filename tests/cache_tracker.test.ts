import { describe, expect, test } from "bun:test"
import { CacheTracker } from "../src/provider/cache-tracker"

describe("CacheTracker", () => {
  test("tracks the real provider prefix shape", () => {
    const tracker = new CacheTracker()
    const first = tracker.checkPrefixShape([
      { kind: "model", value: "deepseek-v4-pro" },
      { kind: "system", value: "stable system" },
      { kind: "tools", value: [{ name: "read_file", input_schema: { type: "object" } }] },
      { kind: "messages", value: [{ role: "user", content: "hello" }] },
    ])
    const second = tracker.checkPrefixShape([
      { kind: "model", value: "deepseek-v4-pro" },
      { kind: "system", value: "stable system" },
      { kind: "tools", value: [{ input_schema: { type: "object" }, name: "read_file" }] },
      { kind: "messages", value: [{ role: "user", content: "hello" }] },
    ])
    const third = tracker.checkPrefixShape([
      { kind: "model", value: "deepseek-v4-pro" },
      { kind: "system", value: "stable system" },
      { kind: "tools", value: [{ name: "read_file", input_schema: { type: "object" } }] },
      { kind: "messages", value: [{ role: "user", content: "hello" }, { role: "assistant", content: "tool use" }] },
    ])

    expect(first.status).toBe("miss")
    expect(first.firstChangedSection).toBe("model")
    expect(second.status).toBe("hit")
    expect(third.status).toBe("miss")
    expect(third.firstChangedSection).toBe("messages")
    expect(third.sections.find(section => section.kind === "tools")?.changed).toBe(false)
  })

  test("treats model changes as cache prefix changes", () => {
    const tracker = new CacheTracker()
    tracker.checkPrefixShape([
      { kind: "model", value: "deepseek-v4-flash" },
      { kind: "system", value: "stable system" },
    ])
    const next = tracker.checkPrefixShape([
      { kind: "model", value: "deepseek-v4-pro" },
      { kind: "system", value: "stable system" },
    ])

    expect(next.status).toBe("miss")
    expect(next.firstChangedSection).toBe("model")
  })
})
