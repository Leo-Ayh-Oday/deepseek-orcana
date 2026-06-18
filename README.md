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

## Highlights

**26 safety mechanisms per round.** Every agent loop iteration passes through a chain of independent gates — context budget, intent, ripple block, permission, rate limiting, quality gate, completion gate, Flash Judge, and more. No single mechanism is trusted alone.

| Layer | Mechanism | Source |
|-------|-----------|--------|
| **Entrance** | Flash Triage — one Flash call replaces 4 keyword classifiers | `src/agent/flash-triage.ts` |
| **Budget** | Context budget: WARN at 50%, BLOCK at 60% | `loop.ts:294-315` |
| **Safety** | Gate overflow: 3 blocks → strategy switch, 5 → BLOCKED | `loop.ts:1562-1607` |
| **Learning** | Error tracker: 2 repeated failures → web search prompt, 4 → admit defeat | `loop.ts:96-123` |
| **Verification** | Flash Judge — independent model evaluates completion (SATISFIED/NOT_SATISFIED/IMPOSSIBLE) | `src/agent/flash-judge.ts` |
| **Testimony** | Testimony Ledger — tracks agent promises vs delivery, detects circular promises | `flash-judge.ts:196-249` |
| **Dependency** | Ripple Engine — TypeScript-aware cascade detection, blocks writes until resolved | `src/ripple/` |
| **Sandbox** | Job Object (kernel32) + PathGuard + env whitelist + timeout | `src/sandbox/` |
| **Memory** | CJK bigram+trigram tokenizer, thinking compaction, knowledge reconciliation | `src/memory/` |
| **Truncation** | Smart head+tail with error-aware allocation (70% head on errors, 85% otherwise) | `loop.ts:1357-1376` |
| **Cache** | Frozen stable prefix — computed once, reused all rounds preserving Anthropic prefix cache | `loop.ts:733-742` |

→ See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full 26-gate loop anatomy and deep dives into each system.

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
