import { describe, expect, test } from "bun:test"
import { buildSystemPrompt } from "../src/agent/prompts"

describe("system prompt boundaries", () => {
  test("keeps broad capability questions separate from current repo context", () => {
    const prompt = buildSystemPrompt()

    expect(prompt).toContain("can you do X")
    expect(prompt).toContain("not automatically current-project tasks")
    expect(prompt).toContain("Answer them generally first")
    expect(prompt).toContain("current repo's language")
  })
})
