import { describe, expect, test } from "bun:test"
import { createStreamRenderState, flushStreamRender, renderStreamChunk } from "../src/ui/render"

describe("Streaming renderer", () => {
  test("renders complete streamed markdown lines with color", () => {
    const state = createStreamRenderState()
    const out =
      renderStreamChunk(state, "## 核心") +
      renderStreamChunk(state, "能力\n- 使用 `edit_file`\n") +
      flushStreamRender(state)

    expect(out).toContain("\x1b[33m")
    expect(out).toContain("\x1b[36medit_file\x1b[0m")
  })

  test("preserves markdown tables and star ratings", () => {
    const state = createStreamRenderState()
    const out =
      renderStreamChunk(state, "| 维度 | Ripple | TDD+反思 |\n") +
      renderStreamChunk(state, "| --- | --- | --- |\n") +
      renderStreamChunk(state, "| 可扩展性 | ⭐⭐ | ⭐⭐⭐ |\n") +
      flushStreamRender(state)

    expect(out).toContain("| 维度 | Ripple | TDD+反思 |")
    expect(out).toContain("| 可扩展性 | ⭐⭐ | ⭐⭐⭐ |")
  })
})
