/** Model router — purpose-based model selection and thinking budget adaptation.
 *
 *  Replaces hardcoded model strings in loop.ts and other modules.
 *  Thinking budget tiers are now provider-aware: each model's max thinking
 *  budget is looked up from its ModelSpec rather than assuming 8192/16384/32768
 *  (which was DeepSeek-V4-specific).
 */

import type { ProviderCallPurpose, ThinkingConfig } from "./types"
import { ProviderRegistry } from "./registry"
import { MultiProvider } from "./multi"
import type { IntentMode } from "../agent/intent"

/** Signals that tell the router to upgrade thinking. */
export interface ThinkingProfile {
  prompt?: string
  intentMode?: IntentMode
  planningPhase?: boolean
  contextUsagePercent?: number
  autoMaxSignals?: {
    consecutiveErrors: number
    modifiedFiles: number
  }
}

export class ModelRouter {
  private registry: ProviderRegistry
  private multi: MultiProvider
  /** Session-pinned model ID: resolved once at startup, never changes. */
  private sessionModel: string

  constructor(registry: ProviderRegistry, multi: MultiProvider) {
    this.registry = registry
    this.multi = multi
    this.sessionModel = multi.resolveForCall().modelId
  }

  /** Select model for a given purpose — always returns the session-pinned model.
   *
   *  Per-purpose routing (fast model for cheap calls, etc.) is disabled by
   *  default to keep prefix cache continuity. All sub-calls use the same
   *  model as the main agent loop.
   */
  selectForPurpose(_purpose: ProviderCallPurpose): string {
    return this.sessionModel
  }

  /** Adapt thinking config to the selected model's capability. */
  adaptThinking(
    modelId: string,
    baseThinking: ThinkingConfig | undefined,
    profile?: ThinkingProfile,
  ): ThinkingConfig | undefined {
    if (!baseThinking) return undefined

    const spec = this.registry.resolveModel(modelId)
    if (!spec || !spec.thinking.supported) return undefined

    const capability = spec.thinking

    // Force max thinking on error cascades or broad edits
    const forceMax =
      profile?.intentMode !== "readonly" &&
      profile?.autoMaxSignals &&
      (profile.autoMaxSignals.consecutiveErrors >= 3 || profile.autoMaxSignals.modifiedFiles >= 5)

    let budget = baseThinking.budget_tokens ?? capability.defaultBudget ?? 16384
    if (forceMax) {
      budget = capability.maxBudgetTokens ?? 32768
    }
    if (budget && capability.maxBudgetTokens) {
      budget = Math.min(budget, capability.maxBudgetTokens)
    }

    let effort = forceMax ? "max" : baseThinking.effort ?? "high"
    if (!capability.effortLevels.includes(effort)) {
      effort = capability.effortLevels[0] ?? "high"
    }

    return {
      type: "enabled",
      budget_tokens: budget,
      effort,
    }
  }

  /** Get the thinking budget tiers for the current model. */
  getThinkingTiers(modelId: string): { low: number; medium: number; high: number; max: number } {
    const spec = this.registry.resolveModel(modelId)
    const max = spec?.thinking.maxBudgetTokens ?? 32768
    return {
      low: Math.floor(max / 4),
      medium: Math.floor(max / 2),
      high: Math.floor(max * 0.75),
      max,
    }
  }

  /** Get context window for a model. */
  getContextWindow(modelId: string): number {
    const spec = this.registry.resolveModel(modelId)
    return spec?.contextWindow ?? 1_048_576
  }
}

/** Convenience: build the full provider stack.
 *
 *  registry = new ProviderRegistry()
 *  register providers + models
 *  multi = new MultiProvider({ registry, defaultModel: "deepseek-v4-pro" })
 *  router = new ModelRouter(registry, multi)
 */
export function createProviderStack(
  registrations: Array<{
    id: string
    provider: import("./types").LLMProvider
    defaultModel: string
    toolAdapter?: import("./types").ToolSchemaAdapter
  }>,
  defaultModel: string,
): { registry: ProviderRegistry; multi: MultiProvider; router: ModelRouter } {
  const registry = new ProviderRegistry()
  for (const reg of registrations) {
    registry.register({
      id: reg.id,
      provider: reg.provider,
      defaultModel: reg.defaultModel,
      toolAdapter: reg.toolAdapter,
    })
  }
  registry.registerBuiltinModels()

  const multi = new MultiProvider({ registry, defaultModel })
  const router = new ModelRouter(registry, multi)

  return { registry, multi, router }
}
