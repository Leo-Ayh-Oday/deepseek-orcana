export type ExperienceCardKind =
  | "research_first"
  | "theory_validation"
  | "minimum_validation"
  | "taste"
  | "freedom_guardrails"

export interface ExperienceCard {
  id: string
  kind: ExperienceCardKind
  title: string
  trigger: string
  guidance: string[]
}

export interface ExperienceKernelInput {
  prompt: string
  intentMode?: "readonly" | "narrow_edit" | "long_task"
}

export const BUILTIN_EXPERIENCE_CARDS: ExperienceCard[] = [
  {
    id: "research-first-engineering",
    kind: "research_first",
    title: "Research-first engineering loop",
    trigger: "Use for architecture, new capability, long task, product direction, or unfamiliar technology.",
    guidance: [
      "Before building a large idea, compare it with known prior attempts or adjacent systems.",
      "Ask why similar attempts succeeded, failed, or became too complex.",
      "Separate what can be borrowed from what must be invented locally.",
      "Do not over-research simple local edits; use this as judgment, not ceremony.",
    ],
  },
  {
    id: "theory-risk-reward",
    kind: "theory_validation",
    title: "Theory risk and reward check",
    trigger: "Use before committing to a design path.",
    guidance: [
      "State the expected product or engineering payoff.",
      "Predict where the work is likely to break: dependencies, UX, validation, cost, runtime, or maintainability.",
      "Prefer a smaller reversible slice when the risk is still theoretical.",
      "Name assumptions clearly instead of hiding them inside confident prose.",
    ],
  },
  {
    id: "minimum-validation-loop",
    kind: "minimum_validation",
    title: "Minimum validation loop",
    trigger: "Use before declaring progress complete.",
    guidance: [
      "Define the smallest test, build, smoke check, or manual verification that proves the next step is real.",
      "Do not claim a service works unless it was started or the command is explicitly left for the user.",
      "If verification cannot run, say exactly why and what evidence is missing.",
      "Prefer one tight validation loop over broad unverified implementation.",
    ],
  },
  {
    id: "taste-beyond-expectation",
    kind: "taste",
    title: "Taste and beyond-expectation delivery",
    trigger: "Use for user-facing product, frontend, docs, demos, and complete projects.",
    guidance: [
      "Do not stop at a bare functional skeleton when the user expects a product.",
      "Infer reasonable high-quality defaults when ambiguity is low.",
      "Ask only for choices that would materially change direction, risk, or taste.",
      "Aim for a finished-feeling result: coherent structure, visual hierarchy, real content, clear startup, and concise handoff.",
    ],
  },
  {
    id: "freedom-with-guardrails",
    kind: "freedom_guardrails",
    title: "Freedom with runtime guardrails",
    trigger: "Use every time the model is tempted to follow rules mechanically.",
    guidance: [
      "Use your own reasoning; do not reduce the task to a rigid checklist.",
      "Runtime gates exist to prevent danger, stale self-edits, missing verification, and incomplete obligations.",
      "Within those guardrails, choose the strongest design and engineering move available.",
      "If the best path is surprising but defensible, explain the tradeoff briefly and proceed with a reversible slice.",
    ],
  },
]

const NON_TRIVIAL_PATTERNS = [
  /architecture|架构|方案|计划|规划|对标|benchmark|评估|research|调研/i,
  /full.?stack|全栈|项目|产品|frontend|前端|backend|后端|design|设计/i,
  /agent|runtime|缓存|cache|memory|记忆|long.?task|长程|重构|refactor/i,
  /实现|开发|build|create|做一个|优化|改造/i,
]

export function shouldUseExperienceKernel(input: ExperienceKernelInput): boolean {
  if (input.intentMode === "long_task") return true
  const prompt = input.prompt.trim()
  if (prompt.length < 16) return false
  return NON_TRIVIAL_PATTERNS.some(pattern => pattern.test(prompt))
}

export function selectExperienceCards(input: ExperienceKernelInput): ExperienceCard[] {
  if (!shouldUseExperienceKernel(input)) return []
  const prompt = input.prompt
  const cards = new Map<string, ExperienceCard>()

  const add = (kind: ExperienceCardKind) => {
    for (const card of BUILTIN_EXPERIENCE_CARDS) {
      if (card.kind === kind) cards.set(card.id, card)
    }
  }

  add("freedom_guardrails")
  add("minimum_validation")

  if (input.intentMode === "long_task" || /architecture|架构|方案|计划|规划|对标|research|调研|agent|runtime|缓存|cache|memory|记忆/i.test(prompt)) {
    add("research_first")
    add("theory_validation")
  }
  if (/frontend|前端|design|设计|product|产品|blog|博客|全栈|full.?stack|demo|页面/i.test(prompt)) {
    add("taste")
  }

  return [...cards.values()]
}

export function buildExperienceKernelContext(input: ExperienceKernelInput): string {
  const cards = selectExperienceCards(input)
  if (!cards.length) return ""

  const lines = [
    "## Experience Kernel",
    "Use these as soft engineering instincts, not hard-coded commands.",
    "The goal is to let the model reason deeply while runtime gates prevent unsafe or incomplete work.",
    "",
  ]

  for (const card of cards) {
    lines.push(`### ${card.title}`)
    lines.push(`Trigger: ${card.trigger}`)
    for (const item of card.guidance) lines.push(`- ${item}`)
    lines.push("")
  }

  return lines.join("\n").trim()
}

