import { describe, expect, test } from "bun:test"
import { classifyIntent } from "../src/agent/intent"

describe("Intent gate", () => {
  test("classifies discussion and planning as readonly", () => {
    expect(classifyIntent("review this plan, no edits").mode).toBe("readonly")
    expect(classifyIntent("discuss the architecture without changing files").mode).toBe("readonly")
  })

  test("classifies explicit implementation as narrow edit", () => {
    expect(classifyIntent("implement this feature").mode).toBe("narrow_edit")
    expect(classifyIntent("fix the failing test").mode).toBe("narrow_edit")
  })

  test("explicit no-write wins over execute wording", () => {
    expect(classifyIntent("review how to fix it, no edits").mode).toBe("readonly")
  })

  test("classifies full-stack project creation as long task", () => {
    expect(classifyIntent("做一个全栈个人博客，包含前端后端和测试").mode).toBe("long_task")
    expect(classifyIntent("Build a complete full-stack personal blog with React and API").mode).toBe("long_task")
  })
})
