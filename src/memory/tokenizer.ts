/** Unified tokenizer for CJK and Latin text dedup + retrieval.
 *
 *  Extracted from KnowledgeBase.tokenize() / tokenOverlap() so both
 *  KnowledgeBase and HybridMemory can share the same tokenization logic.
 *
 *  CJK → character bigrams+trigrams (no spaces between words)
 *  Latin → word split (space-delimited)
 */

/** Check if text is primarily CJK (Chinese/Japanese/Korean). */
export function isCJK(text: string): boolean {
  const cjkCount = (text.match(/[一-鿿㐀-䶿豈-﫿぀-ゟ゠-ヿ가-힯]/g) ?? []).length
  return cjkCount > text.length * 0.25
}

/** Tokenize text for fuzzy matching. CJK → character n-grams; Latin → word split. */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  const clean = text.toLowerCase().trim()
  if (!clean) return tokens

  if (isCJK(clean)) {
    // Character bigrams + trigrams catch 80%+ semantic overlap
    for (let i = 0; i < clean.length - 1; i++) {
      tokens.add(clean.slice(i, i + 2))
    }
    for (let i = 0; i < clean.length - 2; i++) {
      tokens.add(clean.slice(i, i + 3))
    }
    // Individual CJK chars as fallback
    for (const ch of clean) {
      if (/[一-鿿]/.test(ch)) tokens.add(ch)
    }
  } else {
    for (const w of clean.split(/[\s,.;:!?()\[\]{}'"\/\\\-–—|@#$%^&*+=<>]+/)) {
      if (w.length >= 3) tokens.add(w)
    }
  }
  return tokens
}

/** Jaccard similarity between two token sets. */
export function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const t of a) { if (b.has(t)) intersection++ }
  return intersection / Math.max(a.size, b.size)
}
