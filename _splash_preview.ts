// Preview final splash screen state as plain text (no Ink needed)
const c = {
  cyan: "\x1b[38;2;136;192;208m",
  blue: "\x1b[38;2;129;161;193m",
  white: "\x1b[38;2;216;222;233m",
  dim: "\x1b[38;2;97;110;136m",
  yellow: "\x1b[38;2;235;203;139m",
  green: "\x1b[38;2;163;190;140m",
  purple: "\x1b[38;2;180;142;173m",
  border: "\x1b[38;2;76;86;106m",
  reset: "\x1b[0m",
}

const lines = [
  `${c.dim}  ╭─ ◦ ◌ ○ ◎ ○ ◌ ◦ ────────────────────────────────╮`,
  `${c.cyan}  │  🐋 DeepSeek Code v0.4.0 · hraness               │`,
  `${c.white}  ╰──────────────────────────────────────────────────╯`,
  ``,
  `${c.cyan}       ▄▄▄▄▄▄▄▄`,
  `${c.cyan}     ▄██████████▄`,
  `${c.blue}    ██▀▀▀▀▀▀▀▀██`,
  `${c.blue}   ██    ▄▄   ██`,
  `${c.cyan}   ██   ████  ██     🐋 Hraness`,
  `${c.cyan}    ██▄▄▄▄▄▄▄▄██     DeepSeek Code v0.4`,
  `${c.dim}      ▀▀▀▀▀▀▀▀`,
  ``,
  `${c.cyan}  🐋 DeepSeek Code v0.4.0 — Hraness`,
  ``,
  `${c.blue}  深海之下，声呐先行。Sonar first, strike once.`,
  ``,
  `${c.cyan}  ripple${c.dim} · ${c.blue}think${c.dim} · ${c.purple}verify${c.dim} · ${c.yellow}checkpoint${c.dim} · ${c.green}resume`,
  ``,
  `${c.border}  ══════════════════════════════════════════════════════`,
  ``,
  `${c.white}  Ready. Type your request or /help to get started.`,
]

for (const l of lines) console.log(l)
process.exit(0)
