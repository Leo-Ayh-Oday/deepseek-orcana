/** ModeContract — single-agent internal role discipline (PR 8).
 *
 *  Five modes enforce tool access and exit criteria WITHOUT splitting the agent
 *  into separate processes. Each mode is a contract the agent must obey:
 *    - allowedTools / forbiddenTools → enforced at tool execution (policy.ts gate 7)
 *    - exitCriteria → enforced at completion (completion gate)
 *    - inputRequired / outputSchema → injected as prompt context
 *
 *  "不拆 agent，但强制角色纪律"
 *
 *  Phase 1 known limitations:
 *    - Mode transitions not wired to MasterPlan node transitions (mode stays at AgentOptions.activeMode)
 *    - shouldTransitionMode is a stub returning null
 */

import type { EvidenceKind } from "./evidence-ledger"

import type { ToolPolicyInput } from "./tool-execution/policy"
import type { CompletionGateInput } from "./completion-gate"
import type { EvidenceLedger } from "./evidence-ledger"
import { hasEvidence } from "./evidence-ledger"

// ── Types ──

export type ModeName = "planner" | "coder" | "review" | "repair" | "report"

export interface ModeExitCriterion {
  kind: "no_tool_errors" | "output_not_empty" | "has_evidence"
  description: string
  /** For has_evidence: which EvidenceKind is required. */
  evidenceKind?: EvidenceKind
}

export interface ModeContract {
  mode: ModeName
  description: string
  /** Tool names explicitly allowed. Empty array = all tools allowed (except those in forbiddenTools). */
  allowedTools: string[]
  /** Tool names explicitly forbidden. Takes precedence over allowedTools. */
  forbiddenTools: string[]
  /** What the mode needs as input context to function. Injected into mode prompt. */
  inputRequired: string[]
  /** Human-readable expected output schema. Injected into mode prompt. */
  outputSchema: string
  /** Conditions that must ALL be met to exit this mode at completion. */
  exitCriteria: ModeExitCriterion[]
}

// ── All known tool names (kept in sync with tool definitions) ──

const READ_TOOLS = [
  "read_file",
  "find_symbol",
  "find_references",
  "project_structure",
  "lsp_diagnostics",
  "lsp_hover",
  "lsp_definition",
  "lsp_references",
]

const WRITE_TOOLS = [
  "write_file",
  "edit_file",
  "multi_edit",
  "edit_fim",
  "rollback_transaction",
]

const GIT_TOOLS = ["git_status", "git_diff", "git_log", "git_blame"]

const NETWORK_TOOLS = ["web_search", "web_fetch"]

const SHELL_TOOLS = ["shell", "start_service"]

const CHECK_TOOLS = ["typecheck"]

/** Meta-tools that should never be blocked by any mode. */
const META_TOOLS = ["request_deeper_thinking"]

// ── Mode definitions ──

export const MODES: Record<ModeName, ModeContract> = {
  planner: {
    mode: "planner",
    description: "只读分析 + 产出可执行计划。禁止写入和命令执行。",
    allowedTools: [...READ_TOOLS, ...GIT_TOOLS, ...NETWORK_TOOLS, ...META_TOOLS],
    forbiddenTools: [...WRITE_TOOLS, ...SHELL_TOOLS],
    inputRequired: ["任务描述", "代码库上下文"],
    outputSchema: "包含步骤列表、目标文件、验证方式的 actionable plan",
    exitCriteria: [
      { kind: "output_not_empty", description: "计划文本非空" },
      { kind: "no_tool_errors", description: "规划阶段无工具错误" },
    ],
  },

  coder: {
    mode: "coder",
    description: "完整工具访问。读取、写入、构建、测试。默认工作模式。",
    allowedTools: [],
    forbiddenTools: [],
    inputRequired: ["已批准的计划或任务包", "当前任务状态"],
    outputSchema: "代码变更 + 验证结果（typecheck/tests）",
    exitCriteria: [
      { kind: "output_not_empty", description: "产出非空" },
      { kind: "no_tool_errors", description: "无工具错误" },
    ],
  },

  review: {
    mode: "review",
    description: "只读审查。检视代码变更，产出审查报告。禁止写入。",
    allowedTools: [...READ_TOOLS, ...GIT_TOOLS, ...CHECK_TOOLS, ...META_TOOLS],
    forbiddenTools: [...WRITE_TOOLS, ...SHELL_TOOLS, ...NETWORK_TOOLS],
    inputRequired: ["代码变更 diff", "变更上下文"],
    outputSchema: "审查报告：issues 列表、严重程度、建议修复",
    exitCriteria: [
      { kind: "output_not_empty", description: "审查报告已产出" },
      { kind: "no_tool_errors", description: "审查阶段无工具错误" },
    ],
  },

  repair: {
    mode: "repair",
    description: "定向修复。根据审查 issues 精准修改，最小变更范围。",
    allowedTools: [],
    forbiddenTools: [],
    inputRequired: ["审查报告和 issues 列表", "修复目标"],
    outputSchema: "修复后的代码 + 验证通过证据",
    exitCriteria: [
      { kind: "output_not_empty", description: "修复产出非空" },
      { kind: "no_tool_errors", description: "修复过程无工具错误" },
      { kind: "has_evidence", evidenceKind: "typecheck", description: "类型检查通过" },
    ],
  },

  report: {
    mode: "report",
    description: "只读汇总。产出交付报告，禁止任何修改和网络访问。",
    allowedTools: [...READ_TOOLS, ...GIT_TOOLS, ...META_TOOLS],
    forbiddenTools: [...WRITE_TOOLS, ...SHELL_TOOLS, ...NETWORK_TOOLS, ...CHECK_TOOLS],
    inputRequired: ["已完成的任务上下文", "变更记录"],
    outputSchema: "交付报告：做了什么、证据摘要、残余风险",
    exitCriteria: [
      { kind: "output_not_empty", description: "报告文本非空" },
      { kind: "no_tool_errors", description: "报告阶段无工具错误" },
    ],
  },
}

// ── Module-level active mode (same pattern as patch-transaction.ts) ──

let _activeMode: ModeContract = MODES.coder

export function setActiveMode(mode: ModeName): void {
  _activeMode = MODES[mode]
}

export function getActiveMode(): ModeContract {
  return _activeMode
}

// ── Tool enforcement ──

export interface ModeToolCheck {
  allowed: boolean
  reason: string
}

/** Check whether a tool is allowed in the current mode.
 *  ForbiddenTools takes precedence over allowedTools.
 *  Empty allowedTools means "all tools allowed" (except those in forbiddenTools).
 *  MCP tools (mcp__*) and meta-tools are always allowed when not explicitly forbidden. */
export function enforceModeTools(mode: ModeContract, toolName: string): ModeToolCheck {
  // Check forbidden first (takes precedence)
  if (mode.forbiddenTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `[ModeContract:${mode.mode}] ${toolName} 在此模式下被禁止。${mode.description}`,
    }
  }
  // If allowedTools is non-empty, tool must be in the list (or be an MCP/meta tool)
  if (mode.allowedTools.length > 0 && !mode.allowedTools.includes(toolName)) {
    // PR 8: MCP tools (mcp__*) are dynamically registered and always read-only safe
    const isMcpTool = toolName.startsWith("mcp__")
    if (!isMcpTool) {
      return {
        allowed: false,
        reason: `[ModeContract:${mode.mode}] ${toolName} 不在此模式允许列表中。允许: ${mode.allowedTools.slice(0, 8).join(", ")}${mode.allowedTools.length > 8 ? "..." : ""}`,
      }
    }
  }
  return { allowed: true, reason: "" }
}

// ── Exit criteria check ──

export interface ModeExitResult {
  met: boolean
  unmet: string[]
}

/** Check mode exit criteria against completion gate state.
 *  Returns unmet criteria descriptions. */
export function checkModeExitCriteria(
  mode: ModeContract,
  context: {
    toolErrors: number
    finalText: string
    evidenceLedger?: EvidenceLedger
  },
): ModeExitResult {
  const unmet: string[] = []

  for (const criterion of mode.exitCriteria) {
    switch (criterion.kind) {
      case "no_tool_errors": {
        if (context.toolErrors > 0) {
          unmet.push(`${criterion.description} (当前 ${context.toolErrors} 个错误)`)
        }
        break
      }
      case "output_not_empty": {
        if (!context.finalText.trim()) {
          unmet.push(criterion.description)
        }
        break
      }
      case "has_evidence": {
        if (criterion.evidenceKind && context.evidenceLedger) {
          if (!hasEvidence(context.evidenceLedger, criterion.evidenceKind)) {
            unmet.push(criterion.description)
          }
        } else if (criterion.evidenceKind && !context.evidenceLedger) {
          // No evidence ledger at all → unmet
          unmet.push(criterion.description)
        }
        break
      }
    }
  }

  return { met: unmet.length === 0, unmet }
}

// ── Prompt injection ──

/** Format a mode contract reminder for injection into the system context.
 *  Tells the model what mode it's in, what tools it can use, and what it must produce. */
export function formatModePrompt(mode: ModeContract): string {
  const lines = [
    `## 当前模式: ${mode.mode.toUpperCase()}`,
    mode.description,
    "",
  ]

  if (mode.allowedTools.length > 0) {
    lines.push(`允许工具: ${mode.allowedTools.join(", ")}`)
  } else {
    lines.push("允许工具: 全部")
  }

  if (mode.forbiddenTools.length > 0) {
    lines.push(`禁止工具: ${mode.forbiddenTools.join(", ")}`)
  }

  if (mode.inputRequired.length > 0) {
    lines.push(`输入要求: ${mode.inputRequired.join("、")}`)
  }

  lines.push(`期望产出: ${mode.outputSchema}`)

  if (mode.exitCriteria.length > 0) {
    lines.push(`退出条件: ${mode.exitCriteria.map(c => c.description).join("；")}`)
  }

  return lines.join("\n")
}

/** Lightweight check: whether a mode change is needed based on completion state.
 *  Phase 1: returns the mode name unchanged — mode transitions deferred to future PR. */
export function shouldTransitionMode(_current: ModeName, _context: Record<string, unknown>): ModeName | null {
  // Phase 1: no automatic mode transitions. Mode is set externally via AgentOptions.
  return null
}
