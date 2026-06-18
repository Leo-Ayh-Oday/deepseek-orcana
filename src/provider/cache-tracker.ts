/** Prefix cache tracker - predicts and reports cache hit rate.
 *
 * DeepSeek V4 auto-caches prompt prefixes. Cache hits save heavily on input
 * cost. The provider sees more than the system prompt: model, system, tools,
 * and provider messages all shape the real prefix. Track those sections
 * together so local telemetry does not claim a hit when the provider cannot.
 */

export interface CachePrefixSection {
  kind: string
  value: unknown
  stable?: boolean
}

export interface CachePrefixSectionShape {
  kind: string
  hash: string
  chars: number
  stable: boolean
  changed: boolean
}

export interface CachePrefixCheck {
  status: "hit" | "miss"
  hitRate: number
  prefixHash: string
  firstChangedSection?: string
  sections: CachePrefixSectionShape[]
}

export class CacheTracker {
  private lastPrefix = ""
  private lastPrefixHash = ""
  private lastSections: CachePrefixSectionShape[] = []
  cacheHitCount = 0
  cacheMissCount = 0

  /** Hash a string quickly (FNV-1a, no crypto needed for cache keys). */
  private hash(s: string): string {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return (h >>> 0).toString(16)
  }

  private stableSerialize(value: unknown): string {
    if (typeof value === "string") return value
    return JSON.stringify(sortJson(value))
  }

  checkPrefixShape(sections: CachePrefixSection[]): CachePrefixCheck {
    const serialized = sections.map(section => ({
      kind: section.kind,
      stable: section.stable ?? true,
      text: this.stableSerialize(section.value),
    }))
    const prefix = serialized.map(section => `${section.kind}\0${section.text}`).join("\n")
    const prefixHash = this.hash(prefix)
    const shapes = serialized.map((section, index): CachePrefixSectionShape => {
      const previous = this.lastSections[index]
      const hash = this.hash(section.text)
      return {
        kind: section.kind,
        hash,
        chars: section.text.length,
        stable: section.stable,
        changed: !previous || previous.kind !== section.kind || previous.hash !== hash,
      }
    })
    const firstChangedSection = shapes.find(section => section.changed)?.kind
    const status = prefixHash === this.lastPrefixHash ? "hit" : "miss"

    if (status === "hit") {
      this.cacheHitCount++
    } else {
      this.cacheMissCount++
    }
    this.lastPrefix = prefix
    this.lastPrefixHash = prefixHash
    this.lastSections = shapes

    return {
      status,
      hitRate: this.hitRate,
      prefixHash,
      firstChangedSection,
      sections: shapes,
    }
  }

  /** Backward-compatible string-only check. Prefer checkPrefixShape(). */
  checkPrefix(system: string): "hit" | "miss" {
    return this.checkPrefixShape([{ kind: "system", value: system }]).status
  }

  get hitRate(): number {
    const total = this.cacheHitCount + this.cacheMissCount
    return total === 0 ? 0 : Math.round((this.cacheHitCount / total) * 100)
  }

  reset() {
    this.cacheHitCount = 0
    this.cacheMissCount = 0
    this.lastPrefix = ""
    this.lastPrefixHash = ""
    this.lastSections = []
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortJson((value as Record<string, unknown>)[key])
  }
  return out
}
