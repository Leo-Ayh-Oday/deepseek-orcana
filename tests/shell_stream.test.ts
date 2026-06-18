import { describe, expect, test } from "bun:test"
import { shellStream } from "../src/tools/shell"

async function collectShell(params: Record<string, unknown>) {
  const events = []
  for await (const event of shellStream(params)) {
    events.push(event)
  }
  return events
}

describe("shellStream", () => {
  test("requires explicit confirmation", async () => {
    const events = await collectShell({ command: "echo hello" })
    const done = events.at(-1)

    expect(done?.type).toBe("done")
    if (done?.type === "done") {
      expect(done.data.success).toBe(false)
      expect(done.data.content).toContain("confirmation")
    }
  })

  test("times out instead of hanging forever", async () => {
    const command = process.platform === "win32"
      ? "powershell -NoProfile -Command Start-Sleep -Seconds 3"
      : "sleep 3"
    const started = Date.now()
    const events = await collectShell({ command, timeout: 1, confirm: true })
    const elapsed = Date.now() - started
    const done = events.at(-1)

    expect(done?.type).toBe("done")
    if (done?.type === "done") {
      expect(done.data.success).toBe(false)
      expect(done.data.content).toContain("timed out")
    }
    expect(elapsed).toBeLessThan(4000)
  })

  test("treats non-zero exit code as failure", async () => {
    const command = process.platform === "win32"
      ? "powershell -NoProfile -Command exit 7"
      : "sh -c 'exit 7'"
    const events = await collectShell({ command, timeout: 5, confirm: true })
    const done = events.at(-1)

    expect(done?.type).toBe("done")
    if (done?.type === "done") {
      expect(done.data.success).toBe(false)
      if (!done.data.success) expect(done.data.error).toContain("code 7")
    }
  })

  test("blocks long-running dev server commands", async () => {
    const events = await collectShell({ command: "bun run dev", timeout: 5, confirm: true })
    const done = events.at(-1)

    expect(done?.type).toBe("done")
    if (done?.type === "done") {
      expect(done.data.success).toBe(false)
      expect(done.data.content).toContain("常驻服务")
      expect(done.data.content).toContain("bun test")
    }
  })

  test("blocks direct server entrypoint execution", async () => {
    const events = await collectShell({ command: "bun run server/index.ts", timeout: 5, confirm: true })
    const done = events.at(-1)

    expect(done?.type).toBe("done")
    if (done?.type === "done") {
      expect(done.data.success).toBe(false)
      expect(done.data.content).toContain("后端服务入口")
    }
  })
})
