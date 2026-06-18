# Architecture — DeepSeek Orcana

## Design Philosophy

> Every design decision answers one question: **"Does this make it harder for AI to write bad code?"**

Orcana is a single-agent architecture with a constraint-first design. The core differentiator is not feature count — it's the depth at which constraints are enforced.

## Architecture Overview

```
CLI / TUI (Ink)
    │
    ▼
Loop Controller (src/agent/loop.ts)
    ├─ Permission Gate ─── blocks unsafe tool calls before execution
    ├─ Flash Judge ─────── evaluates output completeness per step
    ├─ State Machine ───── enforces agent phase transitions
    ├─ Ripple Engine ───── TypeScript-aware code search/refactor
    ├─ Sandbox ─────────── path-guard + job-object isolation (Windows)
    └─ Memory ──────────── hybrid SQLite + compaction cycles
```

## Key Architectural Decisions

### 1. Constraint Layer is the Moat

All effective constraints are **inline in `loop.ts`**, not in standalone modules. Rules defined in separate files and "waiting to be called" have zero effect in practice. The constraint surface:
- **State Machine**: Enforces valid agent state transitions (discuss → execute, not execute → discuss without gate)
- **Contracts**: Tool output must satisfy schema assertions before next step
- **Confidence Scoring**: Multi-axis evaluation (3 concurrent scorers) gates file writes

### 2. Single Agent by Default

Multi-agent orchestration is available via `--autonomous` for long-running tasks, but the default mode is a single agent with deep context. This avoids the coordination tax and keeps latency low for interactive use.

### 3. Intent Gate: Discuss ≠ Execute

"Discuss" and "execute" are strictly separated. The agent cannot write files or run commands until it passes through the intent gate, preventing premature or hallucinated actions.

### 4. Provider Abstraction

The provider layer is intentionally thin — it translates between the Anthropic-compatible API format and the loop controller. DeepSeek is the primary provider target, but any OpenAI/Anthropic-compatible endpoint works via `ANTHROPIC_BASE_URL`.

### 5. Flash Judge > Multi-Gate

Originally 15 gates. Reduced to 13 by removing Output Gate and Evidence Gate — Flash Judge (a unified semantic completeness evaluator) covers both. Multiple judges doing the same thing = over-engineering.

## Infrastructure Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Bun 1.3+ | Fast startup, native TS, test runner |
| TUI | Ink 7 (React) | Terminal UI components |
| Provider | Anthropic SDK | DeepSeek-compatible endpoint |
| MCP | Custom bridge | `~/.deepseek-code/mcp.json` |
| LSP | TypeScript compiler API | Diagnostics, references via ripple |
| Memory | SQLite (better-sqlite3) | Hybrid: structured + embedding |
| Sandbox | Job Objects (Win) + path-guard | Cross-platform isolation |

## Learning from Mistakes (Do-Not-Repeat)

These are recorded in the codebase to prevent regression:

1. **Don't define constraint modules without wiring them into the main loop** — they will never fire.
2. **Don't insert messages between `tool_use` and `tool_result`** — DeepSeek's Anthropic-compatible API requires contiguous tool blocks (Bug-002).
3. **Don't use `split(/\s+/)` for CJK text** — Chinese has no spaces. Use bigram+trigram tokenizer.
4. **Don't call `tsc` without caching** — N file writes in one turn would trigger N redundant typechecks.
5. **Don't batch external data at start-of-turn only** — stale research evidence degrades decision quality.
6. **Don't silently swallow rollback failures** — callers need to know when file state is inconsistent.

## Ripple Engine

A TypeScript-aware code intelligence layer that:
- Parses project structure via `tsconfig.json`
- Resolves imports and symbol references
- Provides structured diagnostics
- Enforces `tsc --noEmit` before allowing file writes

## Benchmark: RippleBench Pro

`benchmarks/ripplebench/` contains a pipeline-based benchmark framework for evaluating the ripple engine against real-world TypeScript projects. It measures:
- Event pipeline throughput
- Middleware overhead
- Batch processing latency
