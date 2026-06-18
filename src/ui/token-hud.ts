export interface TokenHudState {
  inputTokens: number
  outputTokens: number
  contextMax: number
}

export interface CacheAnatomyHudState {
  requestedModel?: string
  actualModel?: string
  cacheHitRate?: number
  cacheSource?: string
  cacheReadInputTokens?: number
  cacheMissInputTokens?: number
  cacheCreationInputTokens?: number
  outputShare?: number
  missShare?: number
  claudeStyleCacheShape?: boolean
  cumulativeCacheHitRate?: number
  cumulativeCacheReadInputTokens?: number
  cumulativeCacheMissInputTokens?: number
  cumulativeCacheCreationInputTokens?: number
  cacheAnatomy?: {
    stableTokens: number
    volatileTokens: number
  }
}

export function formatCompact(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, "")}M`
  }
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return String(n)
}

export function formatTokenHud(state: TokenHudState): string {
  const used = state.inputTokens + state.outputTokens
  return `${formatCompact(used)} /${formatCompact(state.contextMax)} tokens`
}

export function formatCacheAnatomyHud(state: CacheAnatomyHudState): string {
  const parts: string[] = []
  const model = state.actualModel ?? state.requestedModel
  if (model) parts.push(`model ${model}`)
  if (typeof state.cacheMissInputTokens === "number") {
    parts.push(`cache miss ${formatCompact(state.cacheMissInputTokens)}`)
  }
  if (typeof state.cacheCreationInputTokens === "number" && state.cacheCreationInputTokens > 0) {
    parts.push(`cache create ${formatCompact(state.cacheCreationInputTokens)}`)
  }
  if (typeof state.cacheReadInputTokens === "number" && state.cacheReadInputTokens > 0) {
    parts.push(`cache read ${formatCompact(state.cacheReadInputTokens)}`)
  }
  if (typeof state.cacheHitRate === "number") {
    parts.push(`cache ${state.cacheHitRate}%${state.cacheSource === "provider" ? " provider" : ""}`)
  }
  if (state.cacheSource === "provider" && (typeof state.missShare === "number" || typeof state.outputShare === "number")) {
    parts.push(state.claudeStyleCacheShape
      ? "shape ok"
      : `shape miss ${state.missShare ?? "?"}% out ${state.outputShare ?? "?"}%`)
  }
  if (typeof state.cumulativeCacheHitRate === "number") {
    parts.push(`run cache ${state.cumulativeCacheHitRate}% provider`)
  }
  if (typeof state.cumulativeCacheMissInputTokens === "number" && typeof state.cumulativeCacheReadInputTokens === "number") {
    const total = state.cumulativeCacheReadInputTokens + state.cumulativeCacheMissInputTokens
    parts.push(`run miss ${formatCompact(state.cumulativeCacheMissInputTokens)}/${formatCompact(total)}`)
  }
  if (typeof state.cumulativeCacheCreationInputTokens === "number" && state.cumulativeCacheCreationInputTokens > 0) {
    parts.push(`run cache create ${formatCompact(state.cumulativeCacheCreationInputTokens)}`)
  }
  return parts.join(" | ")
}
