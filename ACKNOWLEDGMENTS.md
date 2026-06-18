# Acknowledgments

DeepSeek Orcana builds on ideas, patterns, and code from these excellent open-source projects.

## Direct Inspirations (MIT License)

### [OpenCode](https://github.com/anomalyco/opencode) — MIT
The pioneering open-source AI coding agent by [Anomaly Co](https://anomalyco.com). OpenCode established the TUI-driven coding agent paradigm that many projects (including this one) build upon.

**What we learned:**
- MCP bridge architecture for tool registry
- Multi-provider config system (`config.ts` with Zod schema)
- TUI component patterns (React Ink-based terminal UI)
- Permission system design (allow/deny rules with path patterns)
- Agent loop structure with step gating

### [MiMo Code](https://github.com/XiaoMi/mimo-code) — MIT *(Xiaomi Corporation)*
A terminal-native AI coding assistant with cross-session memory, built on OpenCode's foundation.

**What we learned:**
- Cross-session persistent memory via SQLite FTS5
- Structured checkpoint templates (6-segment format)
- Smart context truncation (head + tail + error-aware)
- Memory cycle coordination (reconcile)
- Provider normalization layer

## Infrastructure & Tooling

| Project | License | Usage |
|---------|---------|-------|
| [Ink](https://github.com/vadimdemedes/ink) | MIT | Terminal UI framework (React for CLI) |
| [Bun](https://github.com/oven-sh/bun) | MIT | JavaScript runtime, bundler, test runner |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache 2.0 | Compiler API for ripple engine |
| [Hono](https://github.com/honojs/hono) | MIT | Embedded HTTP server for API endpoints |
| [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) | MIT | Provider communication layer |

## Design Philosophy Influences

These projects shaped our thinking even when we didn't adopt their code directly:

| Project | Key Idea |
|---------|----------|
| [Claude Code](https://claude.ai/code) | Hook system, permission model, settings.json UX |
| [Aider](https://github.com/Aider-AI/aider) | Map-reduce editing, edit-block format |
| [Cline](https://github.com/cline/cline) | VSCode-integrated agent loop with human-in-the-loop |
| [SWE-Agent](https://github.com/princeton-nlp/SWE-Agent) | Agent-Computer Interface (ACI) design |

## License Compatibility

All directly referenced code is under MIT (or MIT-compatible) licenses. See [LICENSE](./LICENSE) for this project's terms.

---

*If we've missed a project that influenced this work, please open an issue or PR.*
