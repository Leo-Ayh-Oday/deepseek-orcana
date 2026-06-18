/** Built-in hooks — write guard, journal veto, context monitor, api fallback. */

import type { HookHandler } from "./index"
import { JournalEngine } from "../agent/journal"

/**
 * Guards against editing files that haven't been read first.
 * Ported from Oh-My-OpenAgent's Write-Existing-File-Guard.
 */
const writeGuardReadFiles = new Set<string>()

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/")
}

export const writeGuard: HookHandler = (input) => {
  const tool = input.tool ?? ""
  const rawPath = input.params?.path as string | undefined
  const path = rawPath ? normalizePath(rawPath) : undefined

  if (tool === "read_file" && path && input.result?.success) {
    writeGuardReadFiles.add(path)
  }

  if ((tool === "write_file" || tool === "edit_file") && path) {
    const isNewFile = tool === "write_file" && !normalizePath(rawPath!).includes("/")
    if (!isNewFile && !writeGuardReadFiles.has(path)) {
      return { warn: `File ${path} hasn't been read yet — read it first before editing` }
    }
  }

  return {}
}

/** Reset the tracked read-files set (e.g. on new session). */
export function resetWriteGuard() {
  writeGuardReadFiles.clear()
}

/**
 * Journal veto — 铁律一票否决 hook.
 * 写操作后自动检查日记铁律。若触发 block 级别违规，
 * 返回 blocked:true + 回溯指令，强制 Agent 重新规划。
 *
 * 这就是"元 Agent 仲裁"的落地实现：
 * 代码能跑 ≠ 通过，铁律是最后一道防线。
 */
export function createJournalGuard(projectRoot: string): HookHandler {
  const engine = new JournalEngine(projectRoot)
  const changedFiles = new Set<string>()

  return (input) => {
    const tool = input.tool ?? ""
    const path = input.params?.path as string | undefined

    // Track all written files
    if ((tool === "write_file" || tool === "edit_file" || tool === "edit_fim") && path) {
      changedFiles.add(path)
    }

    // Check only on write-ish operations that succeeded
    if (
      input.result?.success &&
      (tool === "write_file" || tool === "edit_file" || tool === "edit_fim" || tool === "shell")
    ) {
      const ctx = {
        projectRoot,
        changedFiles: [...changedFiles],
        toolName: tool,
        params: input.params ?? {},
        result: input.result,
        recentMessages: [],
      }
      const violations = engine.check(ctx)
      if (violations.length > 0) {
        const report = engine.formatViolations(violations)
        if (engine.hasBlockingViolation(violations)) {
          return {
            blocked: true,
            result: {
              success: false,
              content: `操作被元 Agent 一票否决。${report}`,
            },
          }
        }
        // Warning only — append to result
        return {
          result: {
            success: true,
            content: input.result.content + report,
          },
        }
      }
    }

    return {}
  }
}
