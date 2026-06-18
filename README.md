# DeepSeek Orcana

<p align="center"><strong>A Bun-based terminal coding agent with constraint-first architecture and DeepSeek-powered runtime.</strong></p>

<p align="center">
  <a href="./README.zh.md">中文</a> | English
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="./CONTRIBUTING.md"><img src="https://img.shields.io/badge/contributions-welcome-brightgreen.svg" alt="Contributions welcome"></a>
</p>

---

DeepSeek Orcana is a single-agent terminal coding assistant. It reads, writes, and reasons about code — with a **constraint-first design** that makes it actively harder for AI to produce bad code.

Built with Bun + TypeScript + Ink (React TUI). Uses DeepSeek's Anthropic-compatible API as the default provider.

## Why Orcana?

| Feature | What it does |
|---------|-------------|
| **Constraint Layer** | State machine + contracts + confidence scoring inline in the main loop |
| **Flash Judge** | Unified semantic completeness gate (replaces multi-judge sprawl) |
| **Ripple Engine** | TypeScript-aware code intelligence via compiler API |
| **Permission Gate** | Three-tier allow/deny rules before any tool executes |
| **Sandbox** | Path-guard + job-object isolation (Windows native) |
| **Memory** | SQLite hybrid memory with checkpoint cycles |
| **Code-as-Action** | ~100 lines of JS replacing ~2000 lines of AST manipulation |

## Quick Start

### Requirements
- **Bun** ≥ 1.3
- **Node.js** ≥ 18 (for npm shim)
- **DeepSeek API key** ([Get one here](https://platform.deepseek.com))

### Install

```bash
npm install -g deepseek-orcana
```

The package exposes these commands: `orcana`, `deepseek-orcana`, `deepseek-code`, `deepseek`.

> `deepseek-code` is occupied on npm. The package name is `deepseek-orcana`; `orcana` is the primary command.

### Configure

```bash
# Set your API key
export DEEPSEEK_API_KEY="sk-your-key-here"

# Or copy the example env file
cp .env.example .env   # then edit .env with your key
```

See [`.env.example`](./.env.example) for all configuration options.

### Usage

```bash
orcana                              # Start TUI
orcana "explain this codebase"      # One-shot prompt
orcana --cli                        # Classic CLI mode
orcana list                         # List saved sessions
orcana last                         # Resume latest session
```

## Configuration

Orcana uses `~/.deepseek-code/settings.json` for persistent configuration. Copy [`settings.example.json`](./settings.example.json) as a starting point:

```bash
mkdir -p ~/.deepseek-code
cp settings.example.json ~/.deepseek-code/settings.json
```

### Config Files

| File | Location | Purpose |
|------|----------|---------|
| `settings.json` | `~/.deepseek-code/` | Provider, TUI, memory, sandbox, MCP |
| `mcp.json` | `~/.deepseek-code/` | MCP server definitions |
| `permissions.json` | `~/.deepseek-code/` or `<project>/.deepseek-code/` | Tool access rules |
| `.env` | Project root | API keys (never committed) |

## Architecture

```
CLI/TUI (Ink React)
    │
    ▼
Loop Controller
    ├─ Permission Gate ── blocks unsafe calls pre-execution
    ├─ Flash Judge ────── completeness evaluation per step
    ├─ State Machine ──── enforces phase transitions
    ├─ Ripple Engine ──── TypeScript code intelligence
    ├─ Sandbox ────────── path-guard + job-object isolation
    └─ Memory ─────────── SQLite hybrid + compaction cycles
```

Read [ARCHITECTURE.md](./ARCHITECTURE.md) for design decisions, constraints philosophy, and the "Do-Not-Repeat" knowledge base.

## Development

```bash
bun install
bun run typecheck    # tsc --noEmit
bun test             # run test suite
bun run build        # tsc → dist/
```

## Inspired By

Orcana builds on ideas from these open-source projects:

| Project | What We Learned |
|---------|----------------|
| [OpenCode](https://github.com/anomalyco/opencode) (MIT) | MCP bridge, config system, TUI patterns |
| [MiMo Code](https://github.com/XiaoMi/mimo-code) (MIT) | Memory system, checkpoint templates, truncation |
| [Claude Code](https://claude.ai/code) | Hook system, permission UX |
| [Aider](https://github.com/Aider-AI/aider) | Map-reduce editing |

See [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md) for the full list with links.

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

PRs welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## Security

See [SECURITY.md](./SECURITY.md) for vulnerability reporting.
