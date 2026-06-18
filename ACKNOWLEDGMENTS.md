# Acknowledgments

DeepSeek Orcana builds on ideas and patterns from these open-source projects.

## [OpenCode](https://github.com/anomalyco/opencode) — MIT

The pioneering open-source AI coding agent by [Anomaly Co](https://anomalyco.com). OpenCode established the TUI-driven coding agent paradigm that Orcana builds upon.

**What we adopted:**
- MCP bridge architecture for dynamic tool registration
- Multi-provider config system with Zod schema validation
- TUI component patterns (React Ink-based terminal UI)
- Permission system design (allow/deny rules with path-pattern matching)
- Agent loop structure with step gating

## [CodeGraph](https://github.com/colbymchenry/codegraph) — MIT

Local-first code intelligence MCP server by Colby McHenry. Indexes codebases into a SQLite-backed knowledge graph using tree-sitter, exposes structural search and impact analysis tools to AI agents.

Orcana integrates CodeGraph via MCP for symbol search, reference lookup, and project structure analysis — reducing token usage and tool calls compared to raw file-system traversal.

## [Reasonix](https://github.com/esengine/reasonix) — MIT

A Go-based terminal coding agent by esengine, one of the earliest to deeply exploit DeepSeek V4's auto-caching behavior.

Orcana adopted Reasonix's **cache-first context compaction** strategy:

| Reasonix (`compact.go`) | Orcana (`loop.ts`) |
|---|---|
| `softCompactRatio = 0.5` — warn but keep cache | `DEEPSEEK_CONTEXT_WARN_RATIO = 0.5` |
| `compactRatio = 0.8` — trigger compaction | `DEEPSEEK_CONTEXT_BLOCK_RATIO = 0.6` |
| `compactForceRatio = 0.9` — force even low-value folds | Gate overflow: 3 → warn, 5 → BLOCKED |
| `PruneStaleToolResults` before compact | Microcompact forward pass |
| `foldEconomics` — skip if savings < 400 tokens | MC_*_CHARS — configurable thresholds |
| Structured summary sections | `key_insights / discarded / verified / open` |
| `compactStuck` detection | Gate overflow cumulative counter |

**Key difference:** Reasonix uses a dedicated summarizer model call. Orcana uses V4 Flash — same model family, cheaper tier — preserving the cache pattern at lower cost.

## License

All referenced projects use MIT (or MIT-compatible) licenses. See [LICENSE](./LICENSE) for this project's terms.

---

*If we've missed a project that influenced this work, please open an issue or PR.*
