const { existsSync, readdirSync, statSync } = require("node:fs")
const { join, relative, sep } = require("node:path")
const { spawnSync } = require("node:child_process")

const root = process.cwd()
const extraArgs = process.argv.slice(2)

const excluded = new Set([
  "tests/agent_loop.test.ts",
  "tests/code_as_action.test.ts",
  "tests/e2e_fullstack_flow.test.ts",
  "tests/e2e_user_flow.test.ts",
  "tests/fullstack_depth.test.ts",
  "tests/knowledge_pipeline.test.ts",
  "tests/thinking_depth.test.ts",
  "tests/thinking_quality.test.ts",
])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full, out)
    } else if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) {
      const rel = relative(root, full).split(sep).join("/")
      if (!excluded.has(rel)) out.push(rel)
    }
  }
  return out
}

const files = [...walk(join(root, "tests")), ...walk(join(root, "src"))].sort()
function resolveBun() {
  if (process.platform !== "win32") return { command: "bun", shell: false }
  const candidates = [
    process.env.BUN_EXE,
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bin", "bun.exe") : undefined,
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "bun", "bin", "bun.exe") : undefined,
  ].filter(Boolean)
  const found = candidates.find(p => existsSync(p))
  return found ? { command: found, shell: false } : { command: "bun", shell: true }
}

const bun = resolveBun()
for (const file of files) {
  console.log(`\n[run-tests] ${file}`)
  const nativeFile = `.${sep}${file.split("/").join(sep)}`
  const result = spawnSync(bun.command, ["test", nativeFile, ...extraArgs], {
    stdio: "inherit",
    shell: bun.shell,
  })

  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
