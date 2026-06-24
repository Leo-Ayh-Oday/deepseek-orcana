import type { LLMProvider } from "../provider/types"
import type { ToolDescriptor } from "../tools/registry"
import type { StagedContextManager } from "../context/staged"
import type { ThinkingStore } from "../memory/thinking-store"
import type { KnowledgeBase } from "../memory/knowledge"
import type { HookSystem } from "../hooks"
import type { AgentRunTrace } from "./run-trace"
import type { SessionCheckpoint } from "../session/checkpoint"

export interface UsageStats {
  apiCalls: number
  estimatedInputTokens: number
  cacheHits: number
  cacheMisses: number
  flashRounds: number
  proRounds: number
  flashUsed: boolean
}

export interface AgentOptions {
  provider: LLMProvider
  model: string
  tools: ToolDescriptor[]
  maxRounds?: number
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>
  stagedContext?: StagedContextManager
  thinkingStore?: ThinkingStore
  knowledgeBase?: KnowledgeBase
  thinkEffort?: "high" | "max"
  hooks?: HookSystem
  autoFinishOnVerifiedWrite?: boolean
  runTrace?: AgentRunTrace
  stableMemoryContext?: string
  autoApprovePlan?: boolean
  modelRouter?: import("../provider/router").ModelRouter
  sessionId?: string
  resumeFromCheckpoint?: SessionCheckpoint
  /** Optional: gate telemetry collector for the 3-step validation plan. */
  gateTelemetry?: import("./gates/telemetry").GateTelemetry
  /** Optional: file path to auto-save telemetry on agent exit. */
  gateTelemetryFile?: string
}
