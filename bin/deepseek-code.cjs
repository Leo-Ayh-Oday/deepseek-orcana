#!/usr/bin/env node

const { spawnSync } = require("node:child_process")
const { fileURLToPath, pathToFileURL } = require("node:url")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const entry = path.join(root, "dist", "src", "index.js")
const args = process.argv.slice(2)

const result = spawnSync("bun", [fileURLToPath(pathToFileURL(entry)), ...args], {
  stdio: "inherit",
  shell: process.platform === "win32",
})

if (result.error) {
  console.error("Orcana requires Bun. Install it from https://bun.sh, then run this command again.")
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 0)
