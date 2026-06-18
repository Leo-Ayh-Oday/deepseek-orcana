# Contributing to DeepSeek Orcana

Thanks for your interest in contributing! This document outlines the process.

## Getting Started

```bash
# Clone and install
git clone https://github.com/Leo-Ayh-Oday/wine-pack-erp.git  # or your fork
cd deepseek-code   # if cloned from monorepo root
bun install
```

## Development Workflow

```bash
# Type check
bun run typecheck

# Run tests
bun test

# Build
bun run build

# Run locally
bun run dev
```

## Project Structure

```
src/
├── agent/          # Loop controller, gates, task tracking
├── context/        # Context assembly, kernel files
├── evaluator/      # Confidence scoring, plan judging
├── hooks/          # Safety policy, permission enforcement
├── lsp/            # TypeScript LSP client
├── mcp/            # MCP bridge, config
├── memory/         # Hybrid memory (SQLite + compaction)
├── provider/       # DeepSeek/Anthropic API adapter
├── ripple/         # TypeScript-aware code intelligence
├── sandbox/        # Path guard, job object isolation
├── tools/          # Tool definitions (Bash, Read, Write, etc.)
├── tui/            # Terminal UI components
├── ui/             # Slash commands, startup screen
└── verification/   # Build/typecheck/lint collector
```

## Pull Request Process

1. Fork the repo and create a feature branch
2. Make your changes — keep them focused
3. Run `bun run typecheck && bun test` — both must pass
4. Submit a PR with a clear description

## Code Style

- TypeScript strict mode
- No `any` without a comment explaining why
- Prefer `interface` over `type` for object shapes
- Single-task modules over god-files
- Constraints inline in the loop, not in standalone modules

## Reporting Bugs

Use GitHub Issues. Include:
- OS and Bun version (`bun --version`)
- Steps to reproduce
- Expected vs actual behavior
- Relevant error logs

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
