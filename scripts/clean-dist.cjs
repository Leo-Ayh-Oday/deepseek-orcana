const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const repoRoot = fs.realpathSync(path.resolve(__dirname, ".."))
const distDir = path.resolve(repoRoot, "dist")
const parentDir = fs.realpathSync(path.dirname(distDir))

if (parentDir !== repoRoot || path.basename(distDir) !== "dist") {
  throw new Error(`Refusing to remove unexpected path: ${distDir}`)
}

if (!fs.existsSync(distDir)) {
  process.exit(0)
}

if (process.platform === "win32") {
  const ps = spawnSync("powershell", [
    "-NoProfile",
    "-Command",
    `Remove-Item -LiteralPath ${JSON.stringify(distDir)} -Recurse -Force -ErrorAction Stop`,
  ], { stdio: "inherit" })
  if (ps.status !== 0) {
    throw new Error(`Failed to remove ${distDir} with PowerShell`)
  }
} else {
  fs.rmSync(distDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

if (fs.existsSync(distDir)) {
  throw new Error(`Failed to remove ${distDir}`)
}
