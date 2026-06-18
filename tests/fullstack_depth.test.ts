/**
 * V4 思考深度实战 — 全栈项目计划质量
 *
 * 不测写文件。测计划本身是否足够深入——能不能当真正的施工蓝图。
 *
 * 核心对比:
 *   能跑就行（浅）: "用 React + Hono 做文档中心，功能包括增删改查和搜索"
 *   生产级（深）:   架构图 + 模块职责 + 数据流 + API合约 + 前端组件树 +
 *                  错误处理矩阵 + 安全策略 + trade-off分析 + 边缘情况 + 测试计划
 *
 * 如果 V4 在复杂任务前走捷径，计划会明显偏浅。
 */

import { DeepSeekProvider } from "../src/provider/deepseek"
import { test, expect } from "bun:test"

const provider = new DeepSeekProvider(process.env.DEEPSEEK_API_KEY ?? "")

const SYSTEM = [
  "你是资深全栈架构师。面对复杂项目时，你交付的不是'能做'的方案，",
  "而是经过严密推演的生产级蓝图。",
  "",
  "## 推理标准",
  "- 每项技术选型必须对比至少一个替代方案，给出选择理由",
  "- 识别关键风险点，给出缓解策略",
  "- 输出可以量化的验收标准",
  "- 不确定的地方明确标记，不要糊弄",
].join(" ")

const PROMPT = [
  "设计「团队技术文档中心」的完整实施蓝图。这个蓝图要能直接交给工程团队施工。",
  "",
  "## 核心需求",
  "- 创建、编辑、搜索 Markdown 技术文档",
  "- 首页展示最近 10 篇 + 搜索框",
  "- 文档详情页支持 Markdown 渲染 + 代码高亮",
  "- RESTful API: GET/POST/PUT/DELETE + 搜索",
  "- JSON 文件存储",
  "",
  "## 技术栈（已确定）",
  "- 后端: Bun + Hono | 前端: React 19 + TypeScript + Vite",
  "- Markdown: react-markdown + rehype-highlight | 测试: Bun test",
  "",
  "## 蓝图要求",
  "1. 架构概览: 模块划分 + 数据流",
  "2. API 合约: 每个端点的 request/response 格式 + 错误码",
  "3. 前端组件树: 每个组件的 props 类型和职责",
  "4. 安全策略: CORS、输入校验、路径遍历防护",
  "5. 关键风险 + trade-off 分析（至少 2 处）",
  "6. 边缘情况清单（至少 8 项）",
  "7. 验证步骤: 开发完成后怎么确认交付物合格",
  "",
  "输出用 Markdown 格式。",
].join("\n")

test("全栈计划深度: 生产级 vs 能跑就行 (V4 Pro Max)", async () => {
  console.log("\n" + "=".repeat(70))
  console.log("全栈计划深度评估")
  console.log("模型: V4 Pro Max | 标准: 能否当施工蓝图")
  console.log("=".repeat(70) + "\n")

  const text = await callMax(PROMPT, SYSTEM)
  console.log(`输出长度: ${text.length} chars\n`)

  // ── 评分维度 ──
  // 不是"有没有提到X"，是"X的详细程度有多少"

  // API 合约深度 — 不是 "RESTful API"，是有无具体的 method+path+request/response+错误码
  const apiMethods = text.match(/\b(GET|POST|PUT|DELETE)\b/g) ?? []
  const apiPaths = (text.match(/\/api\/\w+/g) ?? []).length
  const apiStatusCodes = (text.match(/[45]\d{2}/g) ?? []).length
  const apiDepth = apiMethods.length >= 3 && apiPaths >= 3 && apiStatusCodes >= 2

  // 前端深度 — 不是 "用 React"，是具体组件 + props + 状态
  const componentNames = (text.match(/<[A-Z]\w+/g) ?? []).length // <App>, <DocumentList> etc
  const propsDefined = (text.match(/props.*:.*\{|interface.*Props/g) ?? []).length
  const stateTalk = (text.match(/useState|useEffect|useMemo|状态管理/g) ?? []).length
  const frontendDepth = componentNames >= 2 && (propsDefined >= 1 || stateTalk >= 1)

  // 架构: 模块划分 + 数据流
  const hasModules = /模块|分层|layer|directory|目录|server\/|client\//i.test(text)
  const hasDataFlow = /数据.*流|flow|request.*->|->.*response|fetch.*->|proxy/i.test(text)
  const archDepth = hasModules && hasDataFlow

  // 安全: CORS + 输入校验 + 路径防护
  const cors = /CORS|Access-Control|跨域|allowedOrigins/i.test(text)
  const validation = /validat|校验|sanitize|净化|escape|trim|pattern|regex/i.test(text)
  const pathTraversal = /路径.*(?:遍历|穿越|防护)|path.*(?:traversal|injection)|\.\./i.test(text)
  const securityDepth = [cors, validation, pathTraversal].filter(Boolean).length

  // Edge cases
  const edgeCaseCount = (text.match(/边缘|边界|edge.?case|corner.?case|极端|异常|空.*(?:输入|值|数组|字符串)/gi) ?? []).length
  const specificEdgeCases = (text.match(/空文档|空标题|超长|malformed|并发|重复.*标题|特殊字符/g) ?? []).length

  // Trade-off
  const tradeoffCount = (text.match(/权衡|trade.?off|vs\.?|对比|替代|另一种|与其|不如|优势|劣势|代价/g) ?? []).length

  // ── 打分 ──
  let score = 0
  const report: string[] = []

  if (apiDepth) { score += 25; report.push("✅ API合约(具体method+path+statusCode)") }
  else { report.push("❌ API合约不够深入——需要具体method+path+response格式+错误码") }

  if (frontendDepth) { score += 20; report.push("✅ 前端深度(组件+props+状态)") }
  else { report.push("❌ 前端不够深入——需要具体组件+props类型+状态管理") }

  if (archDepth) { score += 15; report.push("✅ 架构(模块划分+数据流)") }
  else { report.push("❌ 缺少架构设计——需要模块职责和数据流描述") }

  score += Math.min(15, securityDepth * 5)
  report.push(`安全: ${securityDepth}/3 (CORS=${cors} 校验=${validation} 路径=${pathTraversal})`)

  score += Math.min(15, edgeCaseCount * 2 + specificEdgeCases * 3)
  report.push(`边缘: ${edgeCaseCount}处提及, ${specificEdgeCases}处具体化`)

  score += Math.min(10, tradeoffCount * 2)
  report.push(`Trade-off: ${tradeoffCount}处`)

  // 完整度感知
  if (text.length < 3000) { score -= 10; report.push("❌ 太短——可能偷懒了") }
  else if (text.length > 5000) { score += 5; report.push("✅ 足够详尽") }

  console.log(report.join("\n"))

  // ── 打印关键内容预览 ──
  console.log("\n" + "=".repeat(70))
  console.log(`总分: ${score}/100`)
  console.log("内容预览:")
  console.log(text.slice(0, 600))
  if (text.length > 600) console.log(`... (${text.length - 600} more chars)`)
  console.log("")

  expect(score).toBeGreaterThanOrEqual(70)
}, { timeout: 300_000 })

async function callMax(prompt: string, system: string): Promise<string> {
  const text: string[] = []
  for await (const ev of provider.streamChat({
    model: "deepseek-v4-pro",
    system,
    messages: [{ role: "user", content: prompt }],
    thinking: { type: "enabled", budget_tokens: 32768, effort: "max" },
    maxTokens: 8192,
  })) {
    if (ev.type === "text" && typeof ev.data === "string") text.push(ev.data)
  }
  return text.join("")
}
