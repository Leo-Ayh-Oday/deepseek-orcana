import type { TaskTracker } from "./task-tracker"

export interface PlanningGateResult {
  ok: boolean
  score: number
  missing: string[]
  signals: string[]
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text))
}

function countListItems(text: string): number {
  return text
    .split(/\r?\n/)
    .filter(line => /^\s*(?:[-*]|\d+[.)]|\[[ x]\])\s+/.test(line.trim()))
    .length
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function extractListItems(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^\s*(?:[-*]|\d+[.)]|\[[ x]\])\s+/.test(line))
}

function hasTaskSpecificChecklist(text: string, tracker?: TaskTracker | null): boolean {
  const items = extractListItems(text)
  if (items.length < 4) return false

  const concreteSignals = [
    /typecheck|test|build|smoke|browser|api|screenshot|dom|lint/i,
    /server|client|src|tests?|package\.json|tsconfig|vite|react|bun|index|app|css|json/i,
    /错误|异常|边界|响应式|视觉|前端|后端|接口|构建|测试|验证|截图|浏览器/i,
  ]

  const concreteCount = items.filter(item => concreteSignals.some(pattern => pattern.test(item))).length
  if (concreteCount >= 2) return true

  if (tracker?.requiredFiles.length) {
    return items.some(item => tracker.requiredFiles.some(file => item.includes(file) || item.includes(file.replace(/\\/g, "/"))))
  }

  return false
}

function hasAlternativeTradeoff(body: string): boolean {
  return (
    hasAny(body, [/方案\s*[AB一二两2]|option\s*[AB12]|path\s*[AB12]|至少两个|two approaches|alternative/i]) &&
    hasAny(body, [/不选|淘汰|取舍|trade[-\s]?off|instead|because|因为|代价|维护|成本|复杂/i])
  )
}

export function evaluatePlanningArtifact(text: string, tracker?: TaskTracker | null): PlanningGateResult {
  const body = normalized(text)
  const missing: string[] = []
  const signals: string[] = []
  let score = 0

  if (body.length >= 220) {
    score += 1
    signals.push("substantial text")
  } else {
    missing.push("计划太短，无法支撑长任务执行")
  }

  if (hasAny(body, [/problem|goal|scope|requirement|目标|范围|需求|问题|边界/i])) {
    score += 1
    signals.push("problem model")
  } else {
    missing.push("缺少问题建模或任务边界")
  }

  if (hasAny(body, [/assumption|unknown|uncertain|uncertainty|不确定|未知|假设|隐含/i])) {
    score += 1
    signals.push("assumptions or uncertainty")
  } else {
    missing.push("缺少隐含假设或不确定性")
  }

  if (hasAny(body, [/risk|failure|fail|trade[-\s]?off|counter|反方|风险|失败|取舍|代价/i])) {
    score += 1
    signals.push("risk or counter-argument")
  } else {
    missing.push("缺少风险、失败模式或反方推演")
  }

  if (hasAlternativeTradeoff(body)) {
    score += 1
    signals.push("selected approach")
  } else {
    missing.push("缺少至少两个方案/路径的取舍和选择理由")
  }

  const listItems = countListItems(text)
  if (hasTaskSpecificChecklist(text, tracker)) {
    score += 1
    signals.push(`task-specific checklist ${listItems}`)
  } else {
    missing.push("缺少任务相关 checklist，不能只写泛泛步骤")
  }

  if (hasAny(body, [/typecheck|test|build|smoke|browser|api|screenshot|external signal|验证|测试|构建|浏览器|截图|外部信号/i])) {
    score += 1
    signals.push("external verification plan")
  } else {
    missing.push("缺少外部验证动作")
  }

  if (tracker?.requiredFiles.length) {
    const requiredMentioned = tracker.requiredFiles.some(file => body.includes(file) || body.includes(file.replace(/\\/g, "/")))
    if (requiredMentioned) {
      score += 1
      signals.push("mentions concrete deliverable path")
    }
  }

  // Gate threshold: 5/8 signals = good enough. Zero-missing forces infinite loops.
  const minScore = 5
  return {
    ok: missing.length <= 3 && score >= minScore,
    score,
    missing,
    signals,
  }
}

/**
 * After maxPlanningRounds consecutive planning-phase rejections, force-allow
 * execution regardless of gate score. Models sometimes produce high-quality
 * plans embedded in thinking blocks that the text-pattern gate can't score.
 */
export function forcePlanningPassAfterLimit(round: number, maxRounds = 3): boolean {
  return round >= maxRounds
}

export function formatPlanningGatePrompt(result: PlanningGateResult, tracker: TaskTracker): string {
  return [
    "## Planning Gate",
    "你还不能进入写文件阶段。上一版计划太薄，无法支撑长任务高质量执行。",
    "",
    "缺失项：",
    ...result.missing.map(item => `- ${item}`),
    "",
    "请重新输出一个任务专属的计划 artifact。不要调用工具，不要写代码，不要使用固定模板。",
    "",
    "必须自然覆盖：",
    "- 问题建模：目标、范围、边界",
    "- 隐含假设与不确定性",
    "- 风险、失败模式或反方推演",
    "- 至少两个方案/路径的取舍，并说明为什么选当前方案",
    "- 动态执行 checklist，必须贴合当前任务",
    "- 外部验证动作，例如 typecheck、test、build、API smoke、browser smoke、截图/DOM 检查",
    "",
    `当前任务：${tracker.goal}`,
    "已知交付要求：",
    ...tracker.requiredFiles.map(file => `- ${file}`),
  ].join("\n")
}

export function formatPlanningBlockedToolResult(result: PlanningGateResult): string {
  return [
    "任务追踪已阻止：长任务必须先完成合格规划，当前规划 artifact 不足，不能写文件。",
    "缺失项：",
    ...result.missing.map(item => `- ${item}`),
  ].join("\n")
}
