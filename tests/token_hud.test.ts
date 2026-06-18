import { describe, expect, test } from "bun:test"
import { formatCacheAnatomyHud, formatTokenHud } from "../src/ui/token-hud"

describe("Token HUD", () => {
  test("formats used tokens and remaining context percent", () => {
    expect(formatTokenHud({
      inputTokens: 763,
      outputTokens: 11,
      contextMax: 1000,
    })).toBe("774 /1k tokens")
  })

  test("uses compact K formatting", () => {
    expect(formatTokenHud({
      inputTokens: 12345,
      outputTokens: 6789,
      contextMax: 1_048_576,
    })).toBe("19.1k /1M tokens")
  })

  test("formats provider-real cache cost before context details", () => {
    expect(formatCacheAnatomyHud({
      requestedModel: "deepseek-v4-pro",
      cacheHitRate: 72,
      cacheSource: "provider",
      cacheReadInputTokens: 8100,
      cacheMissInputTokens: 3123,
      cacheCreationInputTokens: 120,
      missShare: 27.5,
      outputShare: 0,
      claudeStyleCacheShape: false,
      cacheAnatomy: {
        stableTokens: 42_000,
        volatileTokens: 8_100,
      },
    })).toBe("model deepseek-v4-pro | cache miss 3.1k | cache create 120 | cache read 8.1k | cache 72% provider | shape miss 27.5% out 0%")
  })

  test("formats cumulative provider cache stats", () => {
    expect(formatCacheAnatomyHud({
      cacheHitRate: 70,
      cacheSource: "provider",
      cacheMissInputTokens: 300,
      cumulativeCacheHitRate: 88,
      cumulativeCacheReadInputTokens: 6400,
      cumulativeCacheMissInputTokens: 900,
      cumulativeCacheCreationInputTokens: 120,
    })).toBe("cache miss 300 | cache 70% provider | run cache 88% provider | run miss 900/7.3k | run cache create 120")
  })

  test("formats Claude-style cache shape success", () => {
    expect(formatCacheAnatomyHud({
      cacheHitRate: 99,
      cacheSource: "provider",
      cacheReadInputTokens: 331_501_312,
      cacheMissInputTokens: 1_354_726,
      outputShare: 0.2,
      missShare: 0.4,
      claudeStyleCacheShape: true,
    })).toContain("shape ok")
  })
})
