import { describe, expect, test } from "bun:test"
import {
  closeToolCalls,
  createToolTraceState,
  renderToolCall,
  renderToolResult,
  renderToolStatus,
} from "../src/ui/tool-trace"

describe("Tool trace renderer", () => {
  test("folds consecutive read_file calls into one visible group", () => {
    const state = createToolTraceState()
    const out =
      renderToolCall(state, "read_file", { path: "src/a.ts" }) +
      renderToolCall(state, "read_file", { path: "src/b.ts" }) +
      renderToolCall(state, "read_file", { path: "src/c.ts" }) +
      closeToolCalls(state)

    expect(out).toContain("read")
    expect(out).toContain("x3")
    expect(out).toContain("src/a.ts")
    expect(out).not.toContain("src/b.ts")
    expect(out).not.toContain("src/c.ts")
    expect(out).toContain("folded 2 more read call")
  })

  test("starts a new visible group when tool kind changes", () => {
    const state = createToolTraceState()
    const out =
      renderToolCall(state, "read_file", { path: "src/a.ts" }) +
      renderToolCall(state, "read_file", { path: "src/b.ts" }) +
      renderToolCall(state, "edit_file", { path: "src/a.ts" })

    expect(out).toContain("folded 1 more read call")
    expect(out).toContain("edit")
    expect(out).toContain("src/a.ts")
  })

  test("renders multi_edit with an edit label", () => {
    const state = createToolTraceState()
    const out = renderToolCall(state, "multi_edit", { edits: [] })

    expect(out).toContain("edit")
    expect(out).not.toContain("multi_edit")
  })

  test("summarizes grouped results and still surfaces risky output", () => {
    const state = createToolTraceState()
    renderToolCall(state, "edit_file", { path: "src/api.ts" })

    const out = renderToolResult(
      state,
      "edit_file",
      "Ripple block: edit_file paused before disk write.",
    )

    expect(out).toContain("risk")
    expect(out).toContain("Ripple block")
  })

  test("collapses repeated risks under the same group", () => {
    const state = createToolTraceState()
    renderToolCall(state, "read_file", { path: "src/a.ts" })
    renderToolCall(state, "read_file", { path: "src/b.ts" })

    const out =
      renderToolResult(state, "read_file", "error: first read failed with a long path") +
      renderToolResult(state, "read_file", "error: second read failed with another long path")

    expect(out).toContain("risk x2")
    expect(out).toContain("first read failed")
    expect(out).toContain("second read failed")
  })

  test("renders verification progress as a durable status", () => {
    const state = createToolTraceState()
    renderToolCall(state, "shell", { command: "bun test" })

    const out = renderToolStatus(state, "running tests")

    expect(out).toContain("verify")
    expect(out).toContain("running tests")
  })

  test("renders durable animated status categories", () => {
    const state = createToolTraceState()

    expect(renderToolStatus(state, "greedy-tools: 3 readonly calls")).toContain("parallel")
    expect(renderToolStatus(state, "thinking: planning next step")).toContain("thinking")
    expect(renderToolStatus(state, "cache hit 99%")).toContain("cache")
    expect(renderToolStatus(state, "retry after 429")).toContain("retry")
    expect(renderToolStatus(state, "verification: typecheck passed")).toContain("verify")
  })
})
