/** Agent Contracts — pre/post conditions and invariants for each state.
 *
 * Contracts are checked:
 *   - Before entering a state (precondition)
 *   - Before leaving a state (postcondition)
 *   - Continuously (invariant — checked each round)
 *
 * A failed contract triggers:
 *   1. Warning logged to thinking store
 *   2. Attempt auto-repair (if REPAIR transition available)
 *   3. Fallback to BLOCKED if unrecoverable
 */

import { AgentState, READ_ONLY_STATES, WRITE_STATES } from "./state-machine"
import type { AgentContext } from "./state-machine"

// ── Contract violation ──

export interface ContractViolation {
  type: "precondition" | "postcondition" | "invariant"
  state: AgentState
  message: string
  /** If true, the agent should not continue */
  fatal: boolean
  /** Suggested repair action */
  repair?: string
}

// ── Contract checker type ──

export type ContractCheck = (ctx: AgentContext) => ContractViolation | null

// ── Preconditions: what must be true to ENTER a state ──

const PRECONDITIONS: Partial<Record<AgentState, ContractCheck[]>> = {
  [AgentState.CODE]: [
    (ctx) => {
      // Must have at least one file read before editing
      if (ctx.priorFiles.size === 0) {
        return {
          type: "precondition",
          state: AgentState.CODE,
          message: "Entering CODE state without reading any files first. Risk: blind edits.",
          fatal: false,
          repair: "Read target file(s) before editing.",
        }
      }
      return null
    },
  ],
  [AgentState.REPAIR]: [
    (ctx) => {
      if (ctx.consecutiveErrors === 0) {
        return {
          type: "precondition",
          state: AgentState.REPAIR,
          message: "Entering REPAIR state with no errors recorded. Unnecessary repair cycle.",
          fatal: false,
        }
      }
      if (ctx.consecutiveErrors >= 5) {
        return {
          type: "precondition",
          state: AgentState.REPAIR,
          message: `Consecutive errors at ${ctx.consecutiveErrors}. Repair may be futile.`,
          fatal: true,
          repair: "Admit inability and transition to BLOCKED.",
        }
      }
      return null
    },
  ],
  [AgentState.VERIFY]: [
    (ctx) => {
      if (!ctx.priorTools.some(t => t === "write_file" || t === "edit_file" || t === "edit_fim")) {
        return {
          type: "precondition",
          state: AgentState.VERIFY,
          message: "Entering VERIFY state but no file was modified. Skipping verification.",
          fatal: false,
          repair: "Skip to DONE if no changes were made.",
        }
      }
      return null
    },
  ],
}

// ── Postconditions: what must be true to LEAVE a state ──

const POSTCONDITIONS: Partial<Record<AgentState, ContractCheck[]>> = {
  [AgentState.SEARCH]: [
    (ctx) => {
      // Should have gathered something useful
      if (ctx.roundNum > 1 && ctx.priorTools.length === 0) {
        return {
          type: "postcondition",
          state: AgentState.SEARCH,
          message: "Leaving SEARCH but no tools were called. Wasted round.",
          fatal: false,
        }
      }
      return null
    },
  ],
  [AgentState.CODE]: [
    (ctx) => {
      const wrote = ctx.priorTools.some(t => t === "write_file" || t === "edit_file" || t === "edit_fim")
      if (!wrote && ctx.priorTools.every(t => t === "read_file")) {
        return {
          type: "postcondition",
          state: AgentState.CODE,
          message: "CODE state ended but no write/edit was performed.",
          fatal: false,
        }
      }
      return null
    },
  ],
  [AgentState.VERIFY]: [
    (ctx) => {
      if (ctx.consecutiveErrors > 0) {
        return {
          type: "postcondition",
          state: AgentState.VERIFY,
          message: `VERIFY found ${ctx.consecutiveErrors} errors. Transition to REPAIR.`,
          fatal: false,
          repair: "Transition to REPAIR to fix errors.",
        }
      }
      return null
    },
  ],
}

// ── Invariants: always-true properties ──

const INVARIANTS: ContractCheck[] = [
  (ctx) => {
    if (ctx.roundNum > 50) {
      return {
        type: "invariant",
        state: ctx.state,
        message: `Round count ${ctx.roundNum} exceeds safety limit 50. Possible infinite loop.`,
        fatal: true,
        repair: "Terminate and report. The task may need human intervention.",
      }
    }
    return null
  },
  (ctx) => {
    if (ctx.consecutiveErrors >= 3 && ctx.state !== AgentState.REPAIR && ctx.state !== AgentState.BLOCKED) {
      return {
        type: "invariant",
        state: ctx.state,
        message: `${ctx.consecutiveErrors} consecutive errors but not in REPAIR state. Drifting.`,
        fatal: false,
        repair: "Force transition to REPAIR.",
      }
    }
    return null
  },
]

// ── Validator ──

export interface ContractResult {
  ok: boolean
  violations: ContractViolation[]
  /** Non-fatal violations that have repair suggestions */
  repairable: ContractViolation[]
  /** Fatal: must transition to BLOCKED */
  fatal: ContractViolation[]
}

/**
 * Validate all contracts for a given context.
 * Called before each state transition.
 */
export function validateContracts(ctx: AgentContext, targetState?: AgentState): ContractResult {
  const violations: ContractViolation[] = []

  // Check invariants (always)
  for (const check of INVARIANTS) {
    const v = check(ctx)
    if (v) violations.push(v)
  }

  // Check preconditions of target state
  if (targetState) {
    for (const check of PRECONDITIONS[targetState] ?? []) {
      const v = check(ctx)
      if (v) violations.push(v)
    }
  }

  // Check postconditions of current state
  for (const check of POSTCONDITIONS[ctx.state] ?? []) {
    const v = check(ctx)
    if (v) violations.push(v)
  }

  return {
    ok: violations.every(v => !v.fatal),
    violations,
    repairable: violations.filter(v => !v.fatal && v.repair),
    fatal: violations.filter(v => v.fatal),
  }
}

/**
 * Shortcut: check if current context passes all contracts.
 * Returns null if ok, or the first fatal / first repairable violation.
 */
export function checkQuick(ctx: AgentContext, targetState?: AgentState): ContractViolation | null {
  const result = validateContracts(ctx, targetState)
  if (result.fatal.length) return result.fatal[0]!
  if (result.repairable.length) return result.repairable[0]!
  if (result.violations.length) return result.violations[0]!
  return null
}
