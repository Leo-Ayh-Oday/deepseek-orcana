/** Eval scenario definitions — what to test and how to score.
 *
 *  Each scenario is a self-contained coding task with:
 *    - input: the user prompt
 *    - rubric: what good looks like (verifiable outcomes)
 *    - metrics: what to measure (cost, latency, pass/fail, quality score)
 */

export interface EvalRubric {
  /** Free-text description of expected behavior */
  description: string
  /** Verifiable checks (pass/fail) */
  checks: EvalCheck[]
  /** Minimum acceptable score for each quality dimension */
  qualityFloor: {
    correctness: number    // 0-1
    completeness: number   // 0-1
    codeQuality: number    // 0-1
  }
}

export interface EvalCheck {
  id: string
  description: string
  /** One of: "file_exists", "file_contains", "test_passes", "typecheck_passes", "build_passes" */
  kind: "file_exists" | "file_contains" | "test_passes" | "typecheck_passes" | "build_passes"
  /** For file_exists: path; for file_contains: regex pattern; for test/build: command */
  target: string
  /** For file_contains: expected match count or min count */
  minCount?: number
}

export interface EvalScenario {
  id: string
  name: string
  description: string
  /** The user prompt to send to the agent */
  prompt: string
  /** Optional: setup commands to run before the scenario */
  setup?: string[]
  /** Optional: working directory for this scenario */
  cwd?: string
  /** Maximum rounds allowed (default: 10) */
  maxRounds?: number
  /** Expected rubric */
  rubric: EvalRubric
  /** Tags for categorization */
  tags: string[]
}

// ── Metric types ──

export interface EvalMetrics {
  scenarioId: string
  /** Whether all rubric checks passed */
  passed: boolean
  /** Individual check results */
  checkResults: Array<{ id: string; passed: boolean; detail: string }>
  /** Quality scores 0-1 */
  quality: {
    correctness: number
    completeness: number
    codeQuality: number
    overall: number
  }
  /** Cost metrics */
  cost: {
    totalTokens: number
    inputTokens: number
    outputTokens: number
    cacheHitTokens: number
    estimatedCost: number
  }
  /** Timing */
  timing: {
    totalMs: number
    rounds: number
    avgRoundMs: number
  }
  /** Failure classification (if failed) */
  failure?: {
    type: "provider_failure" | "tool_failure" | "verification_failure" | "requirement_miss" | "context_failure" | "model_failure"
    detail: string
  }
}

export interface EvalRun {
  id: string
  timestamp: number
  scenarios: EvalScenario[]
  results: EvalMetrics[]
  summary: {
    total: number
    passed: number
    failed: number
    passRate: number
    avgTokens: number
    avgMs: number
  }
}

// ── Scenario definitions ──

export const STANDARD_SCENARIOS: EvalScenario[] = [
  {
    id: "sc-01-single-edit",
    name: "Single file edit — add a function",
    description: "Agent should add a utility function to an existing file without breaking anything.",
    prompt: "Add a `formatDate(date: Date, locale?: string): string` function to src/utils/format.ts that returns YYYY-MM-DD format. If the file doesn't exist, create it.",
    maxRounds: 5,
    rubric: {
      description: "Add formatDate function",
      checks: [
        { id: "file-exists", kind: "file_exists", target: "src/utils/format.ts", description: "Format file exists" },
        { id: "function-defined", kind: "file_contains", target: "export function formatDate", description: "formatDate is exported", minCount: 1 },
        { id: "typecheck", kind: "typecheck_passes", target: "bun run typecheck", description: "TypeScript compiles" },
      ],
      qualityFloor: { correctness: 0.8, completeness: 0.8, codeQuality: 0.6 },
    },
    tags: ["edit", "single-file", "typescript"],
  },
  {
    id: "sc-02-multi-file",
    name: "Multi-file refactor — rename and update callers",
    description: "Agent should rename an exported function and update all callers.",
    prompt: "Rename the `greet()` function in src/hello.ts to `sayHello()`, then update all files that call `greet()` to use `sayHello()`.",
    maxRounds: 8,
    rubric: {
      description: "Rename greet → sayHello across project",
      checks: [
        { id: "function-renamed", kind: "file_contains", target: "export function sayHello", description: "Function renamed", minCount: 1 },
        { id: "no-old-refs", kind: "file_contains", target: "\\bgreet\\(\\)", description: "No remaining greet() calls", minCount: 0 },
        { id: "tests-pass", kind: "test_passes", target: "bun test", description: "Tests pass after rename" },
      ],
      qualityFloor: { correctness: 0.9, completeness: 0.9, codeQuality: 0.6 },
    },
    tags: ["refactor", "multi-file", "ripple"],
  },
  {
    id: "sc-03-bug-fix",
    name: "Bug fix — null reference",
    description: "Agent should fix a null reference error and add a test.",
    prompt: 'The file src/user.ts has a bug: `user.name.toUpperCase()` crashes when `user.name` is null. Fix it with a null check. Then write a test in tests/user.test.ts that proves the fix works.',
    maxRounds: 8,
    rubric: {
      description: "Fix null reference + add test",
      checks: [
        { id: "null-check", kind: "file_contains", target: "user\\.name\\s*[?\\?]\\.\\s*toUpperCase|\\bif\\s*\\(\\s*user\\.name", description: "Null check exists", minCount: 1 },
        { id: "test-exists", kind: "file_exists", target: "tests/user.test.ts", description: "Test file created" },
        { id: "tests-pass", kind: "test_passes", target: "bun test tests/user.test.ts", description: "Tests pass" },
      ],
      qualityFloor: { correctness: 0.9, completeness: 0.8, codeQuality: 0.7 },
    },
    tags: ["bug-fix", "test", "typescript"],
  },
  {
    id: "sc-04-deepseek-code-self",
    name: "Self-test: verify project integrity",
    description: "Agent should verify that the core source files compile and tests pass.",
    prompt: "Run `bun run typecheck` and `bun test` on this project. Report if everything passes. Do NOT modify any files.",
    maxRounds: 5,
    rubric: {
      description: "Verify project integrity without modifications",
      checks: [
        { id: "typecheck-passed", kind: "typecheck_passes", target: "bun run typecheck", description: "TypeScript compiles" },
        { id: "no-files-modified", kind: "file_contains", target: "no writes|0 files changed", description: "No files modified", minCount: 0 },
      ],
      qualityFloor: { correctness: 0.9, completeness: 0.9, codeQuality: 0.8 },
    },
    tags: ["verification", "readonly", "self-test"],
  },
]

// ── Failure classifier ──

export function classifyFailure(metrics: Partial<EvalMetrics>): EvalMetrics["failure"] {
  if (!metrics.checkResults?.length) {
    return { type: "verification_failure", detail: "No check results produced" }
  }

  const failed = metrics.checkResults.filter(c => !c.passed)
  if (failed.length === 0) return undefined

  // Check if test/timeout failures suggest provider issues
  const testFailures = failed.filter(c => c.id.includes("test"))
  const typecheckFailures = failed.filter(c => c.id.includes("typecheck"))
  const fileFailures = failed.filter(c => c.id.includes("file"))

  if (testFailures.length > 0 && typecheckFailures.length === 0 && fileFailures.length === 0) {
    return { type: "verification_failure", detail: `${testFailures.length} test check(s) failed` }
  }
  if (typecheckFailures.length > 0) {
    return { type: "tool_failure", detail: `TypeScript compilation failed in ${typecheckFailures.length} check(s)` }
  }
  if (fileFailures.length > 0) {
    return { type: "requirement_miss", detail: `${fileFailures.length} file check(s) failed` }
  }
  return { type: "requirement_miss", detail: `${failed.length} check(s) failed` }
}

/** Count tokens from raw usage data. */
export function estimateCost(tokens: { total: number; input: number; output: number; cacheHit: number }): number {
  // DeepSeek V4 pricing: ~$0.14/1M input tokens, ~$1.10/1M output tokens (approximate)
  const inputCost = (tokens.input / 1_000_000) * 0.14
  const outputCost = (tokens.output / 1_000_000) * 1.10
  // Cache hits cut input cost by ~90%
  const cacheSavings = (tokens.cacheHit / 1_000_000) * 0.14 * 0.9
  return inputCost + outputCost - cacheSavings
}
