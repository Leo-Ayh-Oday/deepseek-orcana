/** Functional verification of new features */
import { selectTools } from "../src/agent/tool-disclosure"
import { buildTools } from "../src/tools/registry"
import { FILE_TOOLS } from "../src/tools/file"
import { SHELL_TOOL, shellStream } from "../src/tools/shell"
import { GIT_TOOLS } from "../src/tools/git"
import { CODEGRAPH_TOOLS } from "../src/tools/codegraph"
import { WEB_SEARCH } from "../src/tools/search"

let pass = 0
let fail = 0

function check(label: string, ok: boolean) {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.log(`  ❌ ${label}`) }
}

const toolDefs = [...FILE_TOOLS, SHELL_TOOL, ...GIT_TOOLS, WEB_SEARCH, ...CODEGRAPH_TOOLS]
const tools = buildTools(...toolDefs)

// ── Dynamic tool disclosure ──
console.log("\n## 动态工具披露")
console.log("  Total tools:", tools.length)

const r0 = selectTools(tools, "", 0)
const n0 = r0.selected.map(t => t.defn.name)
console.log("  Round 0:", n0)
check("Round 0 only base tools (≥4, no git)", n0.length >= 4 && !n0.includes("git_status"))

const r1 = selectTools(tools, "看看 git 最近提交了什么", 1)
console.log("  Git context:", r1.selected.map(t => t.defn.name))
check("Git context → git tools", r1.selected.some(t => t.defn.name === "git_log"))

const r2 = selectTools(tools, "帮我搜索一下怎么用 Bun", 1)
console.log("  Search context:", r2.selected.map(t => t.defn.name))
check("Search context → web_search", r2.selected.some(t => t.defn.name === "web_search"))

const r3 = selectTools(tools, "用 edit_fim 改第 15 行", 1)
console.log("  FIM context:", r3.selected.map(t => t.defn.name))
check("FIM context → edit_fim", r3.selected.some(t => t.defn.name === "edit_fim"))

// ── Stream shell ──
console.log("\n## 流式 Shell")

try {
  let chunks = 0
  let hasHello = false
  
  const streamDone = (async () => {
    for await (const c of shellStream({ command: "echo hello", timeout: 10 })) {
      if (c.type === "progress") {
        chunks++
        if (c.data.includes("hello")) hasHello = true
      }
    }
  })()
  
  const timeout = new Promise<void>(r => setTimeout(r, 8000).unref())
  await Promise.race([streamDone, timeout])
  
  check("Stream captures 'hello'", hasHello)
  check("Stream produces output chunks", chunks > 0)
} catch (e: any) {
  check("Stream runs without error: " + e.message, false)
}

// ── Summary ──
console.log(`\n${pass} pass / ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
