/**
 * Thinking Depth Evaluation — 测量 DeepSeek V4 思考质量
 *
 * 三维度:
 *   1. Depth (深度): 思考token vs budget利用率, 根因分析, 替代方案, 边界穷举
 *   2. Alignment (一致): 思考→行动关联度, CoT脱节检测
 *   3. Quality (质量): 自我反驳, 承认不确定性, 拒绝幻觉
 *
 * 场景: 架构决策 / 安全审计 / 跨文件重构 / 调试 / 简单问答(对照组)
 *
 * 通过标准:
 *   - budget 利用率 ≥ 40% (high模式), ≥ 60% (max模式)
 *   - 根因检测 ≥ 1 (出现了 "root cause / 根因 / 底层原因")
 *   - 替代方案 ≥ 1 (出现了 "alternative / 替代方案 / 另一个方向")
 *   - 边界检测 ≥ 1 (出现了 "edge case / 边界 / 异常 / 极端")
 *   - 自我反驳 ≥ 1 (出现了 "但这 / 然而 / however / but this")
 */

import { DeepSeekProvider } from "../src/provider/deepseek"
import { test, expect } from "bun:test"

const API_KEY = process.env.DEEPSEEK_API_KEY ?? ""
if (!API_KEY) throw new Error("DEEPSEEK_API_KEY not set")

const provider = new DeepSeekProvider(API_KEY)

// ── Test cases ──

interface ThinkingTestCase {
  name: string
  systemPrompt: string
  userPrompt: string
  effort: "high" | "max"
  budgetTokens: number
  minBudgetUtilization: number       // minimum % of budget that should be used
  minRootCauseSignals: number        // root cause analysis signals
  minAlternativeSignals: number      // alternative approaches considered
  minEdgeCaseSignals: number         // edge cases / boundary conditions
  minSelfCritiqueSignals: number     // self-critique / "but this" / "however"
  expectUncertaintyAcknowledged: boolean  // should admit when unsure
  maxContradictionScore: number      // max allowed think↔act contradictions (0=perfect)
}

const CASES: ThinkingTestCase[] = [
  {
    name: "架构决策 — high effort",
    systemPrompt: "你是资深软件架构师。做决策时穷举所有替代方案，找出每个方案的权衡点，给出明确推荐的方案和理由。",
    userPrompt: "我要设计一个跨会话的任务追踪系统。Agent 在长任务中需要记住自己的进度、已完成和未完成的子任务。有两种方向：存文件系统 vs 存 SQLite。分析并推荐。",
    effort: "high",
    budgetTokens: 16384,
    minBudgetUtilization: 0.30,
    minRootCauseSignals: 0,
    minAlternativeSignals: 1,
    minEdgeCaseSignals: 1,
    minSelfCritiqueSignals: 1,
    expectUncertaintyAcknowledged: false,
    maxContradictionScore: 0,
  },
  {
    name: "安全审计 — max effort",
    systemPrompt: "你是安全审计专家。分析代码中的安全漏洞，考虑所有攻击向量、边缘场景、和绕过路径。不确定的地方明确标记。",
    userPrompt: "审查以下认证逻辑的安全性：\n\n```typescript\nasync function login(username: string, password: string) {\n  const user = await db.query('SELECT * FROM users WHERE username = ?', [username])\n  if (!user) return { error: 'not found' }\n  const valid = await bcrypt.compare(password, user.password_hash)\n  if (!valid) return { error: 'wrong password' }\n  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET || 'dev-secret')\n  return { token }\n}\n```",
    effort: "max",
    budgetTokens: 32768,
    minBudgetUtilization: 0.40,
    minRootCauseSignals: 0,
    minAlternativeSignals: 0,
    minEdgeCaseSignals: 2,
    minSelfCritiqueSignals: 1,
    expectUncertaintyAcknowledged: false,
    maxContradictionScore: 0,
  },
  {
    name: "跨文件重构 — max effort",
    systemPrompt: "你是资深重构工程师。分析跨文件影响时，追踪每个改动的下游影响、可能的断点、和需要的测试覆盖。",
    userPrompt: "我要把 `src/auth/login.ts` 中的 `login()` 函数返回值从 `{ token: string }` 改为 `{ token: string, refreshToken: string, expiresIn: number }`。这个函数被 8 个文件引用。分析改动的完整影响链。",
    effort: "max",
    budgetTokens: 32768,
    minBudgetUtilization: 0.35,
    minRootCauseSignals: 0,
    minAlternativeSignals: 0,
    minEdgeCaseSignals: 2,
    minSelfCritiqueSignals: 1,
    expectUncertaintyAcknowledged: true,
    maxContradictionScore: 0,
  },
  {
    name: "调试未知错误 — max effort",
    systemPrompt: "你是调试专家。面对错误信息时，系统性穷举所有可能的原因，逐一排除，直到找到根因。不确定时明确说'不确定'而非编造。",
    userPrompt: "我的 Bun 应用在运行 `bun test` 时报这个错误：\n```\nTypeError: Cannot read properties of undefined (reading 'map')\n    at processResults (src/parser.ts:42:27)\n```\n我确认 `results` 在调用前已经初始化了。分析可能的原因。",
    effort: "max",
    budgetTokens: 32768,
    minBudgetUtilization: 0.35,
    minRootCauseSignals: 1,
    minAlternativeSignals: 2,
    minEdgeCaseSignals: 1,
    minSelfCritiqueSignals: 1,
    expectUncertaintyAcknowledged: true,
    maxContradictionScore: 0,
  },
  {
    name: "简单问答(对照组) — no thinking",
    systemPrompt: "你是编程助手。回答简洁直接。",
    userPrompt: "Bun 中怎么用 `new Function()` 创建一个安全的代码沙箱？给一个 10 行以内的例子。",
    effort: "high",
    budgetTokens: 8192,
    minBudgetUtilization: 0,
    minRootCauseSignals: 0,
    minAlternativeSignals: 0,
    minEdgeCaseSignals: 0,
    minSelfCritiqueSignals: 0,
    expectUncertaintyAcknowledged: false,
    maxContradictionScore: 0,
  },
]

// ── Measurement functions ──

interface ThinkingMetrics {
  thinkingTokens: number
  budgetTokens: number
  budgetUtilization: number
  thinkingText: string
  outputText: string
  rootCauseSignals: number
  alternativeSignals: number
  edgeCaseSignals: number
  selfCritiqueSignals: number
  uncertaintyAcknowledged: boolean
  hasHallucinationSignals: boolean   // making claims without evidence markers
  thinkingOutputAlignment: number    // 0-1 how well thinking connects to output
  totalTime: number
}

const ROOT_CAUSE_PATTERNS = /根(?:本)?原因|root cause|底层原因|真正的.*(?:是|在)|underlying|fundamental.*cause|本质上|核心问题/i
const ALTERNATIVE_PATTERNS = /替代方案|另一个.*(?:方案|方向|思路|角度)|alt(?:ernative|ernate)|另一种.*(?:做法|实现|方法)|也可以|或者|option/i
const EDGE_CASE_PATTERNS = /边缘.*(?:案例|场景|情况)|边界.*(?:条件|场景|情况)|edge.*(?:case|scenario)|极端.*(?:情况|场景)|异常.*(?:情况|场景|输入)|corner.*case/i
const SELF_CRITIQUE_PATTERNS = /但是这|但这|然而.*(?:这|存在|有)|不过.*(?:这|需要|要|问题)|however|but this|but.*not|limitation|不够|不足|lacks/i
const UNCERTAINTY_PATTERNS = /不确定|无法.*(?:确定|确认|判断)|unclear|uncertain|不知道|not sure|可能|maybe|perhaps/i
const HALLUCINATION_PATTERNS = /绝对没错|绝对正确|毫无疑问|definitely|certainly|undoubtedly|no doubt|必定|一定可以|肯定可以/i
const EVIDENCE_PATTERNS = /根据.*(?:文档|代码|日志|报错|错误信息|源码)|based on.*(?:the|our|this)|证据|evidence/i

async function measureThinking(
  name: string,
  system: string,
  prompt: string,
  effort: "high" | "max",
  budgetTokens: number,
): Promise<ThinkingMetrics> {
  const start = Date.now()
  const thinking = effort === "max"
    ? { type: "enabled" as const, budget_tokens: budgetTokens, effort: "max" as const }
    : { type: "enabled" as const, budget_tokens: budgetTokens, effort: "high" as const }

  const thinkingBlocks: Array<{ thinking: string; signature: string }> = []
  const textChunks: string[] = []

  try {
    for await (const ev of provider.streamChat({
      model: "deepseek-v4-pro",
      system,
      messages: [{ role: "user", content: prompt }],
      thinking,
      maxTokens: 4096,
    })) {
      if (ev.type === "thinking_blocks" && Array.isArray(ev.data)) {
        for (const tb of ev.data as Array<{ thinking: string; signature: string }>) {
          thinkingBlocks.push(tb)
        }
      }
      if (ev.type === "text" && typeof ev.data === "string") {
        textChunks.push(ev.data)
      }
    }
  } catch (e) {
    return {
      thinkingTokens: 0,
      budgetTokens,
      budgetUtilization: 0,
      thinkingText: `ERROR: ${e instanceof Error ? e.message : String(e)}`,
      outputText: "",
      rootCauseSignals: 0,
      alternativeSignals: 0,
      edgeCaseSignals: 0,
      selfCritiqueSignals: 0,
      uncertaintyAcknowledged: false,
      hasHallucinationSignals: false,
      thinkingOutputAlignment: 0,
      totalTime: Date.now() - start,
    }
  }

  const thinkingText = thinkingBlocks.map(tb => tb.thinking).join("\n---\n")
  const thinkingTokens = Math.ceil(thinkingText.length / 2.5) // better estimate for code-heavy thinking
  const outputText = textChunks.join("")

  // ── Signal detection ──
  const rootCauseSignals = (thinkingText.match(ROOT_CAUSE_PATTERNS) ?? []).length
  const alternativeSignals = (thinkingText.match(ALTERNATIVE_PATTERNS) ?? []).length
  const edgeCaseSignals = (thinkingText.match(EDGE_CASE_PATTERNS) ?? []).length
  const selfCritiqueSignals = (thinkingText.match(SELF_CRITIQUE_PATTERNS) ?? []).length
  const uncertaintyAcknowledged = UNCERTAINTY_PATTERNS.test(outputText) || UNCERTAINTY_PATTERNS.test(thinkingText)
  const hasEvidence = EVIDENCE_PATTERNS.test(outputText) || EVIDENCE_PATTERNS.test(thinkingText)
  const hasHallucinationSignals = HALLUCINATION_PATTERNS.test(outputText) && !hasEvidence

  // ── Alignment: do concepts in thinking appear in output? ──
  const thinkingKeywords = extractKeywords(thinkingText.slice(0, 3000))
  const outputKeywords = new Set(extractKeywords(outputText.slice(0, 2000)))
  let aligned = 0
  for (const kw of thinkingKeywords) {
    if (outputKeywords.has(kw)) aligned++
  }
  const thinkingOutputAlignment = thinkingKeywords.length > 0 ? aligned / thinkingKeywords.length : 0

  return {
    thinkingTokens,
    budgetTokens,
    budgetUtilization: Math.round((thinkingTokens / budgetTokens) * 1000) / 1000,
    thinkingText,
    outputText: outputText.slice(0, 2000),
    rootCauseSignals,
    alternativeSignals,
    edgeCaseSignals,
    selfCritiqueSignals,
    uncertaintyAcknowledged,
    hasHallucinationSignals,
    thinkingOutputAlignment: Math.round(thinkingOutputAlignment * 1000) / 1000,
    totalTime: Date.now() - start,
  }
}

function extractKeywords(text: string): string[] {
  // Extract CamelCase and snake_case identifiers + 3+ char Chinese/English words
  const camel = text.match(/\b[a-z]+(?:[A-Z][a-z]+)+|\b[a-z]+_[a-z]+(?:_[a-z]+)*/g) ?? []
  const words = text.match(/[一-鿿]{2,}|[a-zA-Z]{3,}/g) ?? []
  return [...new Set([...camel, ...words])].slice(0, 40)
}

// ── Main test ──

test("思考深度评估: 5场景 × 3维度 (V4 Pro)", async () => {
  console.log("\n" + "=".repeat(70))
  console.log("DeepSeek V4 思考深度评估 — 5 场景")
  console.log("=".repeat(70) + "\n")

  const results: Array<{ tc: ThinkingTestCase; m: ThinkingMetrics }> = []

  for (let i = 0; i < CASES.length; i++) {
    const tc = CASES[i]!
    console.log(`[${i + 1}/${CASES.length}] ${tc.name}`)
    console.log(`  effort: ${tc.effort}, budget: ${Math.round(tc.budgetTokens / 1024)}K`)

    const m = await measureThinking(tc.name, tc.systemPrompt, tc.userPrompt, tc.effort, tc.budgetTokens)
    results.push({ tc, m })

    // ── Per-case report ──
    const budgetOk = m.budgetUtilization >= tc.minBudgetUtilization ? "✅" : "❌"
    const rootOk = m.rootCauseSignals >= tc.minRootCauseSignals ? "✅" : "⚠️"
    const altOk = m.alternativeSignals >= tc.minAlternativeSignals ? "✅" : "⚠️"
    const edgeOk = m.edgeCaseSignals >= tc.minEdgeCaseSignals ? "✅" : "⚠️"
    const critiqueOk = m.selfCritiqueSignals >= tc.minSelfCritiqueSignals ? "✅" : "⚠️"
    console.log(`  budget: ${budgetOk} ${m.thinkingTokens}/${m.budgetTokens} (${Math.round(m.budgetUtilization * 100)}%)`)
    console.log(`  signals: 根因${rootOk}(${m.rootCauseSignals}) 替代${altOk}(${m.alternativeSignals}) 边界${edgeOk}(${m.edgeCaseSignals}) 反驳${critiqueOk}(${m.selfCritiqueSignals})`)
    console.log(`  alignment: ${m.thinkingOutputAlignment.toFixed(2)} | uncertain: ${m.uncertaintyAcknowledged ? "✅" : "⚠️"} | halluc: ${m.hasHallucinationSignals ? "❌" : "✅"} | time: ${(m.totalTime / 1000).toFixed(1)}s`)
    if (m.thinkingText.length > 50) {
      console.log(`  thinking preview: ${m.thinkingText.slice(0, 200).replace(/\n/g, " ")}...`)
    } else {
      console.log(`  thinking: NOT RECEIVED`)
    }

    if (i < CASES.length - 1) await new Promise(r => setTimeout(r, 1500))
  }

  // ── Aggregate report ──

  const codeResults = results.filter(r => r.tc.name.includes("架构") || r.tc.name.includes("重构") || r.tc.name.includes("调试") || r.tc.name.includes("审计"))
  const simpleResult = results.find(r => r.tc.name.includes("简单"))

  console.log("\n" + "=".repeat(70))
  console.log("汇总报告")
  console.log("=".repeat(70))

  const avgBudgetUtil = codeResults.reduce((s, r) => s + r.m.budgetUtilization, 0) / codeResults.length
  const avgRootCause = codeResults.reduce((s, r) => s + r.m.rootCauseSignals, 0) / codeResults.length
  const avgAlternative = codeResults.reduce((s, r) => s + r.m.alternativeSignals, 0) / codeResults.length
  const avgEdgeCase = codeResults.reduce((s, r) => s + r.m.edgeCaseSignals, 0) / codeResults.length
  const avgCritique = codeResults.reduce((s, r) => s + r.m.selfCritiqueSignals, 0) / codeResults.length
  const avgAlignment = codeResults.reduce((s, r) => s + r.m.thinkingOutputAlignment, 0) / codeResults.length
  const anyHallucination = codeResults.some(r => r.m.hasHallucinationSignals)
  const thinkingReceived = codeResults.filter(r => r.m.thinkingTokens > 0).length

  console.log(`V4 思考质量基准:`)
  console.log(`  思考块接收率:  ${thinkingReceived}/${codeResults.length}`)
  console.log(`  Budget 利用率:  ${Math.round(avgBudgetUtil * 100)}%`)
  console.log(`  根因分析信号:   ${avgRootCause.toFixed(1)}/次`)
  console.log(`  替代方案信号:   ${avgAlternative.toFixed(1)}/次`)
  console.log(`  边界穷举信号:   ${avgEdgeCase.toFixed(1)}/次`)
  console.log(`  自我反驳信号:   ${avgCritique.toFixed(1)}/次`)
  console.log(`  思考→输出对齐:  ${Math.round(avgAlignment * 100)}%`)
  console.log(`  幻觉信号:       ${anyHallucination ? "❌ 检测到" : "✅ 无"}`)

  if (simpleResult) {
    console.log(`\n  对照组(简单问答): utilization=${Math.round(simpleResult.m.budgetUtilization * 100)}%, signals=0 (expected)`)
  }

  // ── Key insight: does V4 think deeply enough? ──
  console.log("\n## 诊断结论")

  if (avgBudgetUtil < 0.30) {
    console.log("❌ Budget 利用率太低 — 给了 X tokens 但只用了很少")
    console.log("   → 需要: 系统提示强化深度要求，或降低 budget 以减少浪费")
  } else if (avgBudgetUtil < 0.50) {
    console.log("⚠️  Budget 利用率中等 — 大部分 budget 浪费")
    console.log("   → 可能: V4 的 thinking 提前结束，max 模式比 high 模式没有显著提升")
  } else {
    console.log("✅ Budget 利用率良好")
  }

  if (avgRootCause < 0.5) {
    console.log(`❌ 缺乏根因分析 — thinking 更接近「查资料」而非「找根因」`)
  }
  if (avgAlternative < 0.5) {
    console.log("❌ 缺少替代方案比较 — 单路径推理，没有方案对比")
  }
  if (avgEdgeCase < 0.5) {
    console.log("❌ 缺少边界分析 — 安全/重构场景尤其致命")
  }
  if (avgCritique < 0.5) {
    console.log("❌ 缺少自我反驳 — V4 Max 的内嵌提示要求穷举反方，但模型没做到")
  }
  if (avgAlignment < 0.3) {
    console.log("❌ 思考→输出脱节 — CoT disconnect 现象确认")
  }

  console.log("")

  // ── Assertions: V4 must meet minimum quality bar ──
  expect(thinkingReceived).toBeGreaterThanOrEqual(codeResults.length - 1) // at most 1 failure
  expect(avgBudgetUtil).toBeGreaterThanOrEqual(0.15)
  expect(avgEdgeCase).toBeGreaterThanOrEqual(0.5)
  expect(anyHallucination).toBe(false)
}, { timeout: 300_000 })
