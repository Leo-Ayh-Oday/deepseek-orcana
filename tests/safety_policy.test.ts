import { describe, expect, test } from "bun:test"
import { createSafetyPolicyHook } from "../src/hooks/safety-policy"

describe("SafetyPolicy hook", () => {
  test("allows ordinary project file reads", async () => {
    const hook = createSafetyPolicyHook({ projectRoot: process.cwd() })
    const result = await hook({ tool: "read_file", params: { path: "src/agent/loop.ts" } })
    expect(result.blocked).toBeUndefined()
  })

  test("blocks sensitive file paths", async () => {
    const hook = createSafetyPolicyHook({ projectRoot: process.cwd() })
    const result = await hook({ tool: "read_file", params: { path: ".env" } })
    expect(result.blocked).toBe(true)
    expect(result.warn).toContain("sensitive")
  })

  test("blocks paths outside project by default", async () => {
    const hook = createSafetyPolicyHook({ projectRoot: process.cwd() })
    const outside = process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts"
    const result = await hook({ tool: "read_file", params: { path: outside } })
    expect(result.blocked).toBe(true)
    expect(result.warn).toContain("blocked")
  })

  test("blocks destructive shell commands", async () => {
    const hook = createSafetyPolicyHook({ projectRoot: process.cwd() })
    const result = await hook({ tool: "shell", params: { command: "git reset --hard HEAD" } })
    expect(result.blocked).toBe(true)
    expect(result.warn).toContain("git reset --hard")
  })

  test("blocks destructive start_service commands", async () => {
    const hook = createSafetyPolicyHook({ projectRoot: process.cwd() })
    const result = await hook({ tool: "start_service", params: { command: "git reset --hard HEAD", cwd: process.cwd() } })
    expect(result.blocked).toBe(true)
    expect(result.warn).toContain("start_service")
  })

  test("allows ordinary verification shell commands", async () => {
    const hook = createSafetyPolicyHook({ projectRoot: process.cwd() })
    const result = await hook({ tool: "shell", params: { command: "bun test tests/agent_loop.test.ts" } })
    expect(result.blocked).toBeUndefined()
  })
})
