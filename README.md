# DeepSeek Orcana

DeepSeek Orcana is a Bun-based terminal coding agent with an Ink TUI, DeepSeek-backed provider runtime, task tracking, cache telemetry, and local workflow gates.

## Requirements

- Bun 1.3 or newer
- Node.js 18 or newer, used by the npm command shim
- A DeepSeek API key

## Install

```powershell
npm install -g deepseek-orcana
```

The package exposes these commands:

```powershell
orcana
deepseek-orcana
deepseek-code
deepseek
```

Note: `deepseek-code` is already occupied on npm. The package name for this repo is `deepseek-orcana`; the shorter `orcana` command is the primary command.

## Configure

Set your API key in the shell:

```powershell
$env:DEEPSEEK_API_KEY="sk-your-key-here"
```

Or create a `.env` file in the installed package/project root using `.env.example` as a template.

## Usage

Start the TUI:

```powershell
orcana
```

Send a one-shot prompt:

```powershell
orcana "inspect this repo and suggest the next safe step"
```

Use the classic CLI mode:

```powershell
orcana --cli
```

List saved sessions:

```powershell
orcana list
```

Resume the latest session:

```powershell
orcana last
```

## Local State

Orcana writes runtime state such as traces, transactions, and local memory under `.deepseek-code/` in the working project. That directory is intentionally excluded from npm packages.

## Development

```powershell
bun install
bun run typecheck
bun test
bun run build
npm pack --dry-run
```

Do not publish `.env`, `.deepseek-code/`, benchmark outputs, or test project traces.
