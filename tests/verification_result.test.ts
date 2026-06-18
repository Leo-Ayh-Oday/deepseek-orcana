import { describe, expect, test } from "bun:test"
import { buildVerificationResult, detectVerificationKind, hasServiceTestFailure } from "../src/verification/result"
import { shellStream } from "../src/tools/shell"
import type { VerificationResult } from "../src/verification/result"

async function shellDone(command: string) {
  let done
  for await (const event of shellStream({ command, confirm: true, timeout: 5 })) {
    if (event.type === "done") done = event.data
  }
  return done
}

describe("VerificationResult", () => {
  test("detects verification command kinds", () => {
    expect(detectVerificationKind("bun test")).toBe("test")
    expect(detectVerificationKind("tsc --noEmit")).toBe("typecheck")
    expect(detectVerificationKind("bun run build")).toBe("build")
    expect(detectVerificationKind("eslint src")).toBe("lint")
  })

  test("builds failed verification result with issue count", () => {
    const result = buildVerificationResult({
      command: "tsc --noEmit",
      passed: false,
      exitCode: 2,
      durationMs: 12,
      output: "src/a.ts(1,1): error TS2304: Cannot find name 'x'.",
    })

    expect(result?.kind).toBe("typecheck")
    expect(result?.passed).toBe(false)
    expect(result?.issues).toBe(1)
    expect(result?.summary).toContain("TS2304")
  })

  test("detects service-style test failures", () => {
    expect(hasServiceTestFailure("TypeError: fetch failed ECONNREFUSED 127.0.0.1:3000")).toBe(true)
  })

  test("shell attaches verification metadata on successful finite verification", async () => {
    const command = process.platform === "win32"
      ? "powershell -NoProfile -Command Write-Output '1 pass'"
      : "sh -c 'echo 1 pass'"
    const result = await shellDone(command.replace("Write-Output", "Write-Output")) // ordinary shell is not verification
    expect(result?.metadata?.verification).toBeUndefined()

    const verificationCommand = process.platform === "win32"
      ? "powershell -NoProfile -Command Write-Output '1 pass'; # bun test"
      : "sh -c 'echo 1 pass' # bun test"
    const verificationResult = await shellDone(verificationCommand)
    const verification = verificationResult?.metadata?.verification as VerificationResult | undefined

    expect(verification?.kind).toBe("test")
    expect(verification?.passed).toBe(true)
  })

  test("shell attaches failed verification metadata", async () => {
    const command = process.platform === "win32"
      ? "powershell -NoProfile -Command Write-Output 'error TS2304'; exit 2 # tsc --noEmit"
      : "sh -c 'echo error TS2304; exit 2' # tsc --noEmit"
    const result = await shellDone(command)
    const verification = result?.metadata?.verification as VerificationResult | undefined

    expect(result?.success).toBe(false)
    expect(verification?.passed).toBe(false)
    expect(verification?.kind).toBe("typecheck")
  })
})

