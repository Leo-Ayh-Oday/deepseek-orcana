import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  addTurn,
  appendDeltaMemory,
  buildAnchorDeltaContext,
  buildCompactionContext,
  buildCompactionPreview,
  buildDynamicMemoryContext,
  buildStableAnchorContext,
  createBaseCheckpoint,
  createCompactor,
  restoreAnchorDeltaState,
  saveCompactorState,
} from "../src/memory/compactor"

describe("context compactor", () => {
  test("builds structured continuity context without treating it as a new request", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-compactor-"))
    try {
      let state = createCompactor(dir)
      for (let i = 0; i < 22; i++) {
        state = addTurn(state, {
          role: i % 2 === 0 ? "user" : "assistant",
          content: `turn ${i}: decided to update src/app.ts and keep current stage focused`,
        })
      }

      const context = buildCompactionContext(state)
      expect(context).toContain("Earlier Conversation Digest")
      expect(context).toContain("not a new user request")
      expect(context).toContain("src/app.ts")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("builds an auditable compact preview without activating compaction", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-compactor-"))
    try {
      let state = createCompactor(dir)
      for (let i = 0; i < 24; i++) {
        state = addTurn(state, {
          role: i % 2 === 0 ? "user" : "assistant",
          content: `turn ${i}: should keep src/context.ts and tests/context.test.ts in the resume plan`,
        })
      }

      const preview = buildCompactionPreview(state, {
        sessionId: "abc123",
        messageCount: 24,
        loadedFiles: ["src/context.ts"],
      })

      expect(preview).toContain("[Compact Preview]")
      expect(preview).toContain("preview only")
      expect(preview).toContain("saved as abc123")
      expect(preview).toContain("Loaded files: src/context.ts")
      expect(preview).toContain("Safety Notes")
      expect(preview).toContain("src/context.ts")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("creates M0 at threshold and persists raw archive outside prompt context", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-compactor-"))
    try {
      let state = createCompactor(dir)
      for (let i = 0; i < 30; i++) {
        state = addTurn(state, {
          role: i % 2 === 0 ? "user" : "assistant",
          content: `raw transcript secret detail ${i}: decided to keep src/ripple.ts stable and verify with bun test`,
        })
      }

      state = createBaseCheckpoint(state, {
        sessionId: "s1",
        thresholdTokens: 1,
        title: "Implement cache-friendly memory",
        unresolvedObligations: ["cart.ts still needs caller update"],
        activeDecisions: ["M0 must stay stable"],
      })

      expect(state.anchor).toBeDefined()
      expect(state.archives.length).toBe(1)
      expect(state.anchor?.archivePath).toBeDefined()
      expect(existsSync(state.anchor!.archivePath!)).toBe(true)
      expect(readFileSync(state.anchor!.archivePath!, "utf-8")).toContain("raw transcript secret detail")

      const context = buildAnchorDeltaContext(state)
      expect(context).toContain("M0 Base Checkpoint")
      expect(context).toContain("cart.ts still needs caller update")
      expect(context).not.toContain("raw transcript secret detail")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("delta append preserves M0 and records order", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-compactor-"))
    try {
      let state = createCompactor(dir)
      state = addTurn(state, { role: "user", content: "decided to update src/cache.ts" })
      state = createBaseCheckpoint(state, { thresholdTokens: 1, title: "Base" })
      const m0Digest = state.anchor!.digest

      state = appendDeltaMemory(state, {
        title: "Fix cache HUD",
        summary: "Added provider real cache miss display.",
        decisions: ["Provider real cache is authoritative"],
        filesTouched: ["src/ui/token-hud.ts"],
        verifiedBy: "bun test tests/token_hud.test.ts",
      })
      state = appendDeltaMemory(state, {
        title: "Add loop cache anatomy",
        summary: "Emitted cacheAnatomy in token_usage events.",
        decisions: ["Stable and volatile sections are tracked separately"],
        filesTouched: ["src/agent/loop.ts"],
      })

      expect(state.anchor!.digest).toBe(m0Digest)
      expect(state.deltas.map(delta => delta.title)).toEqual(["Fix cache HUD", "Add loop cache anatomy"])
      const context = buildAnchorDeltaContext(state)
      expect(context.indexOf("Fix cache HUD")).toBeLessThan(context.indexOf("Add loop cache anatomy"))
      expect(context).toContain("Provider real cache is authoritative")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("splits stable M0 anchor from dynamic deltas", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-compactor-"))
    try {
      let state = createCompactor(dir)
      state = addTurn(state, { role: "user", content: "decided to keep src/cache.ts stable" })
      state = createBaseCheckpoint(state, { thresholdTokens: 1, title: "Stable cache base" })
      const m0Digest = state.anchor!.digest
      state = appendDeltaMemory(state, {
        title: "Later repair",
        summary: "Fixed a volatile task issue.",
        decisions: ["Delta should not rewrite M0"],
      })

      const stable = buildStableAnchorContext(state)
      const dynamic = buildDynamicMemoryContext(state)

      expect(stable).toBe(m0Digest)
      expect(stable).toContain("M0 Base Checkpoint")
      expect(stable).not.toContain("Later repair")
      expect(dynamic).toContain("Later repair")
      expect(dynamic).not.toContain("M0 Base Checkpoint")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("buildAnchorDeltaContext respects token budget", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-compactor-"))
    try {
      let state = createCompactor(dir)
      state = addTurn(state, { role: "user", content: "decided to keep summary short" })
      state = createBaseCheckpoint(state, { thresholdTokens: 1, title: "Budget" })
      state = appendDeltaMemory(state, {
        title: "Large delta",
        summary: "x".repeat(3000),
      })

      const context = buildAnchorDeltaContext(state, { maxTokens: 20 })
      expect(Math.ceil(context.length / 3)).toBeLessThanOrEqual(20)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("unresolved obligations and active decisions survive persistence", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-compactor-"))
    try {
      let state = createCompactor(dir)
      state = addTurn(state, { role: "user", content: "decided to use multi_edit for callers" })
      state = createBaseCheckpoint(state, {
        sessionId: "persist",
        thresholdTokens: 1,
        activeDecisions: ["Use multi_edit for cascade edits"],
        unresolvedObligations: ["checkout.ts caller pending"],
      })
      state = appendDeltaMemory(state, {
        title: "Cascade follow-up",
        summary: "Caller update remains pending.",
        unresolvedObligations: ["cart.ts caller pending"],
      })

      saveCompactorState(state, "persist")
      const restored = createCompactor(dir)
      restoreAnchorDeltaState(restored, "persist")

      expect(restored.anchor?.digest).toContain("Use multi_edit for cascade edits")
      expect(restored.manifest.unresolvedObligations).toContain("checkout.ts caller pending")
      expect(restored.manifest.unresolvedObligations).toContain("cart.ts caller pending")
      expect(buildAnchorDeltaContext(restored)).toContain("cart.ts caller pending")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("preview distinguishes M0, deltas, manifest, and raw archives", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepseek-compactor-"))
    try {
      let state = createCompactor(dir)
      state = addTurn(state, { role: "user", content: "decided to update src/preview.ts" })
      state = createBaseCheckpoint(state, { sessionId: "preview", thresholdTokens: 1 })
      state = appendDeltaMemory(state, {
        title: "Preview delta",
        summary: "Preview should show memory layers.",
        filesTouched: ["src/preview.ts"],
      })

      const preview = buildCompactionPreview(state, { sessionId: "preview" })
      expect(preview).toContain("M0 anchor:")
      expect(preview).toContain("Delta memories: 1")
      expect(preview).toContain("Manifest:")
      expect(preview).toContain("Raw archives:")
      expect(preview).toContain("Raw archives stay on disk")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
