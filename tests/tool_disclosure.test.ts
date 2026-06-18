import { describe, expect, test } from "bun:test"
import { selectTools } from "../src/agent/tool-disclosure"
import { buildTools, Result } from "../src/tools/registry"

const tools = buildTools(
  {
    name: "read_file",
    description: "Read file",
    isReadonly: true,
    inputSchema: { type: "object", properties: {} },
    async execute() { return Result.ok("read") },
  },
  {
    name: "edit_file",
    description: "Edit file",
    isReadonly: false,
    inputSchema: { type: "object", properties: {} },
    async execute() { return Result.ok("edit") },
  },
  {
    name: "web_search",
    description: "Search web",
    isReadonly: true,
    inputSchema: { type: "object", properties: {} },
    async execute() { return Result.ok("search") },
  },
  {
    name: "git_status",
    description: "Git status",
    isReadonly: true,
    inputSchema: { type: "object", properties: {} },
    async execute() { return Result.ok("git") },
  },
)

describe("Dynamic tool disclosure", () => {
  test("keeps round 0 lean for ordinary prompts", () => {
    const selected = selectTools(tools, "你好", 0).selected.map(tool => tool.defn.name)

    expect(selected).toContain("read_file")
    expect(selected).toContain("edit_file")
    expect(selected).not.toContain("web_search")
    expect(selected).not.toContain("git_status")
  })

  test("exposes web_search on round 0 when search is explicitly requested", () => {
    const selected = selectTools(tools, "搜一下 Hraness agent GitHub 最新信息", 0).selected.map(tool => tool.defn.name)

    expect(selected).toContain("web_search")
  })
})
