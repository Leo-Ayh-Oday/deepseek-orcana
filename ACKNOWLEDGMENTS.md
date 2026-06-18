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

## License

All referenced projects use MIT (or MIT-compatible) licenses. See [LICENSE](./LICENSE) for this project's terms.

---

*If we've missed a project that influenced this work, please open an issue or PR.*
