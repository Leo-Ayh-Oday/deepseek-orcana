# Changelog

All notable changes to DeepSeek Orcana.

## [0.2.1] — 2026-06-24

### Fixed
- Remove dead `_usage` type-penetration code (`loop.ts:324`) — written but never read.
- Replace `[PLAN_APPROVED]` string protocol with `AgentOptions.initialPlanState` field. Plan approval now passes through typed options instead of synthetic message content.
- Flash Triage now defaults to `"auto"` instead of `"off"`, matching the design intent of replacing 4 keyword classifiers.
- Remove duplicate field assignments in `buildTrackerFromTriage` spread — `requiredFiles`, `requiredVerificationKinds`, `steps` were already provided by the spread.

### Changed
- `DEEPSEEK_MAX_ROUNDS` env var as fallback for `maxRounds` default (was hardcoded 50).
- Softened "zero identity bias" → "reduced identity bias" in ARCHITECTURE.md, with training-distribution limitation noted.
- Documented FIM `/beta/completions` endpoint risk and Gate Overflow prompt-only limitation.

### Removed
- `package-lock.json` — Bun-only project, no npm lockfile.
- `parse_trending.mjs` moved from root to `scripts/`.
- `Co-Authored-By: Claude` attribution disabled via `~/.claude/settings.json`.

## [0.2.0] — 2026-06-24

### Added
- **GateChain architecture**: 14 gates across 4 phases (pre-round, tool policy, completion, overflow). 3 pass-through filters, 4 guards, 3 verify gates, 4 safety nets.
- **GateTelemetry**: pure data collector with `record`, `markFalsePositive`, `markMissed`, `report`, `summary`, `toJSON`/`fromJSON`, `merge`, cross-session persistence via `saveToFile`/`loadFromFile`. Wired into `agentLoop` at all 3 exit points.
- **Gate Manifest**: decision matrix (`keep`/`tune`/`observe`/`delete`/`safety_net`/`pass_through`) encoded as code in `src/agent/gates/manifest.ts`, with `generateManifest` and `manifestReport`.
- `gateTelemetryFile` option auto-saved to `.wolf/gate-telemetry.json` on every agent run, with additive merge across runs.
- `--model` flag for CLI runtime model override.
- `modelRouter` field in `AgentOptions` for sub-purpose model selection.
- 46 gate tests (33 telemetry + 13 manifest).

### Changed
- Planning gate re-architecture: `forcePlanningPassAfterLimit` integrated into completion chain.
- `maxRounds` default now reads `DEEPSEEK_MAX_ROUNDS` env var, falls back to 50.

## [0.1.2] — 2026-06-23

### Added
- Auto-detect user language (Chinese/English/Japanese) from prompt text.
- All system prompts adapt to detected language.
- `UILanguage` type and `detectLanguage` / `languageInstruction` helpers.

## [0.1.1] — 2026-06-23

### Fixed
- User confirmation now bypasses the planning gate to prevent infinite re-planning loop.
- Block Unix system paths (`/System`, `/etc`, `/boot`, `/sys`, `/proc`) in safety policy.

## [0.1.0] — 2026-06-22

### Added
- Initial open-source release.
- CLI (`src/ui/cli.ts`) and TUI (`src/tui/main.tsx`, Ink React) entry points.
- Agent loop with staged context, thinking store, knowledge base, ripple engine.
- DeepSeek V4 provider with thinking tokens, Flash sub-processing, FIM endpoint, prefix caching.
- 26 safety mechanisms: permission gate, Flash Judge, state machine, ripple engine, sandbox, memory compaction.
- MCP server bridge, tool registry, hook system.
- Session checkpoint (save/resume).
- npm distribution (`deepseek-orcana` package, `orcana` CLI command).
