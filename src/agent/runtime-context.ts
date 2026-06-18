export type RuntimeContextBudgetMode = "normal" | "degraded" | "block"

let currentContextBudgetMode: RuntimeContextBudgetMode = "normal"

export function setRuntimeContextBudgetMode(mode: RuntimeContextBudgetMode) {
  currentContextBudgetMode = mode
}

export function getRuntimeContextBudgetMode(): RuntimeContextBudgetMode {
  return currentContextBudgetMode
}
