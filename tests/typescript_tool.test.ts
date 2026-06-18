import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getTscCommand } from "../src/tools/typescript"

describe("TypeScript tool helpers", () => {
  test("finds npm local tsc shim on the current platform", () => {
    const dir = join(tmpdir(), `dscode-tsc-${Date.now()}`)
    try {
      const bin = join(dir, "node_modules", ".bin")
      mkdirSync(bin, { recursive: true })
      const shim = process.platform === "win32" ? "tsc.cmd" : "tsc"
      writeFileSync(join(bin, shim), "")

      const command = getTscCommand(dir)
      expect(command).toContain(shim)
      expect(command).toContain("node_modules")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
