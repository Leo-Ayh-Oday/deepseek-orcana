import { describe, expect, test } from "bun:test"
import { evaluatePlanningArtifact, formatPlanningGatePrompt } from "../src/agent/planning-gate"
import { createTaskTracker } from "../src/agent/task-tracker"

function goodPlan(): string {
  return [
    "Problem model: build a complete full-stack personal blog, not a one-screen demo. Scope includes package setup, TypeScript config, Bun API, JSON content, React/Vite UI, integration, tests, and build verification. Deployment, auth, comments, and database persistence are out of scope for this first loop.",
    "Assumptions and uncertainty: the workspace may be empty, so I will create a small but complete project. If existing files are discovered, I will adapt to them. The design direction is unknown, so I will choose a restrained editorial style and keep it responsive.",
    "Risk and counter-argument: a default list page would be fast but too low quality. API tests can also become flaky if they expect a manually running server, so service tests must self-start and self-stop or use finite smoke helpers.",
    "Selected approach: Option A is React/Vite with a Bun TypeScript API and JSON posts. Option B is SQLite plus an admin login. I choose Option A because it gives a complete vertical slice with low operational complexity. I am not choosing SQLite or admin login yet because that would expand scope before the first validation loop.",
    "Checklist:",
    "- Create package.json and tsconfig.json with typecheck, test, and build scripts.",
    "- Create server/index.ts, server/index.test.ts, and server/posts.json with success and error API paths.",
    "- Create client/src/App.tsx and client/src/App.css with responsive layout, visual assets, and reading surfaces.",
    "- Wire the frontend to the backend data shape and handle loading/error states.",
    "- Run external verification: bun run typecheck, bun test, and bunx vite build.",
  ].join("\n")
}

describe("Planning Gate", () => {
  test("rejects thin planning artifacts", () => {
    const result = evaluatePlanningArtifact("Plan: create files then test.")

    expect(result.ok).toBe(false)
    expect(result.score).toBeLessThan(4)
    expect(result.missing.length).toBeGreaterThan(0)
  })

  test("accepts a task-specific plan with risks, checklist, and verification", () => {
    const tracker = createTaskTracker("Build a complete full-stack personal blog with React, API, tests, and build verification", "long_task")
    const result = evaluatePlanningArtifact(goodPlan(), tracker)

    expect(result.ok).toBe(true)
    expect(result.signals).toContain("problem model")
    expect(result.signals).toContain("assumptions or uncertainty")
    expect(result.signals).toContain("risk or counter-argument")
    expect(result.signals).toContain("selected approach")
    expect(result.signals).toContain("external verification plan")
    expect(result.signals.some(signal => signal.startsWith("task-specific checklist"))).toBe(true)
  })

  test("rejects generic checklists even when the plan sounds long", () => {
    const tracker = createTaskTracker("Build a complete full-stack personal blog with React, API, tests, and build verification", "long_task")
    // Generic checklist with no concrete file/module references should fail
    const result = evaluatePlanningArtifact([
      "Problem model: build a personal blog.",
      "Selected approach: direct implementation.",
      "Checklist:",
      "- Set up the project.",
      "- Add the files.",
      "- Test everything.",
      "- Deploy.",
    ].join("\n"), tracker)

    expect(result.ok).toBe(false)
    expect(result.missing).toContain("缺少任务相关 checklist，不能只写泛泛步骤")
  })

  test("rejects plans without real alternative tradeoff", () => {
    const tracker = createTaskTracker("Build a complete full-stack personal blog with React, API, tests, and build verification", "long_task")
    // No Option A/B comparison, just "I chose X"
    const result = evaluatePlanningArtifact([
      "Problem model: build a personal blog.",
      "Selected approach: I will implement it simply.",
      "Checklist:",
      "- Create server/index.ts.",
      "- Run typecheck and test.",
    ].join("\n"), tracker)

    expect(result.ok).toBe(false)
    expect(result.missing).toContain("缺少至少两个方案/路径的取舍和选择理由")
  })

  test("formats a revision prompt with missing items and concrete deliverables", () => {
    const tracker = createTaskTracker("Build a complete full-stack personal blog with React, API, tests, and build verification", "long_task")!
    const thin = evaluatePlanningArtifact("Plan: create files then test.", tracker)
    const prompt = formatPlanningGatePrompt(thin, tracker)

    expect(prompt).toContain("Planning Gate")
    expect(prompt).toContain("typecheck")
    expect(prompt).toContain("server/index.ts")
    expect(prompt).toContain("client/src/App.tsx")
    expect(prompt.length).toBeGreaterThan(500)
  })
})
