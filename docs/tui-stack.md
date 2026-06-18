# TUI Stack

DeepSeek Code currently uses a readline CLI with ANSI render helpers. The next
UI slices can gradually move visible surfaces to Ink components without
rewriting the agent runtime.

## Installed Libraries

- `ink`: React renderer for terminal layouts.
- `@inkjs/ui`: high-level Ink components for alerts, badges, progress bars,
  spinners, text inputs, selects, and status messages.
- `ink-spinner`: spinner components for thinking, retry, and verification states.
- `ink-text-input`: controlled terminal text input.
- `ink-select-input`: command palettes and startup mode selection.
- `@json-render/ink`: schema-driven forms or structured debug views.
- `ink-gradient`: gradient text for brand moments and high-signal states.
- `ink-big-text`: large ASCII wordmarks for splash or mode changes.
- `@clack/prompts`: polished one-shot setup/configuration prompts outside the
  long-running chat surface.
- `boxen`: non-React boxed banners and error panels.
- `figlet`: generated ASCII wordmarks.
- `string-width`: correct terminal width handling for CJK and ANSI-adjacent text.
- `chalk`: ANSI color primitives used by the existing renderer.

## Quality Direction

Use Ink for the long-running agent surface and Clack only for finite setup
flows. The target UI should feel like a workbench, not a decorative splash:

- Startup: `ink-big-text` or the current ANSI banner, with restrained
  `ink-gradient` accents.
- Top status rail: `@inkjs/ui` badges for model, thinking depth, cache,
  context budget, and verification state.
- Activity stream: stable rows for planning, tool calls, Ripple obligations,
  retries, and verification results.
- Prompt input: `@inkjs/ui` or `ink-text-input` after Windows Terminal stdin
  behavior is verified.
- Command palette: `@inkjs/ui Select` or `ink-select-input` for `/help`,
  `/sessions`, `/effort`, and resume choices.
- Setup/config wizard: `@clack/prompts`, because it is polished for finite
  prompts but should not own the persistent chat loop.

## Migration Order

1. Keep `src/ui/startup-screen.ts` as the stable non-interactive boot surface.
2. Build reusable Ink components under `src/tui/` for status, tool trace, and command palettes.
3. Keep the current readline input loop until Ink input is proven with streaming output.
4. Only move agent streaming into a full Ink app after tool trace, final response, and prompt input are covered by tests.

## Guardrails

- Do not let Ink own the whole process until Ctrl+C, stdin focus, and streamed output are verified on Windows Terminal.
- Keep non-interactive `deepseek "prompt"` mode plain and script-friendly.
- Add focused renderer tests for every component that formats status, tool calls, or command choices.
- Avoid `ink-table@3.1.0` with Ink 7 on Bun/Windows. It requires Ink from CommonJS and fails with the ESM Ink build.
- Avoid `ink-markdown@1.0.4` with Ink 7 on Bun/Windows for the same CJS/ESM
  reason. Keep Markdown rendering local until a compatible renderer is proven.
