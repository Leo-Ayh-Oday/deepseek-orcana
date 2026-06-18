/** BatchProcessor — concurrent event batch processing with retry. */
import type { EventPayload, BatchOptions, RetryPolicy } from "./types"
import { DEFAULT_RETRY } from "./types"

export interface BatchResult {
  processed: number
  failed: number
  deadLetter: EventPayload[]
}

export class BatchProcessor {
  private retryPolicy: RetryPolicy

  constructor(private options: BatchOptions) {
    this.retryPolicy = options.retry
  }

  async processBatch(events: EventPayload[], handler: (e: EventPayload) => EventPayload | null): Promise<BatchResult> {
    const result: BatchResult = { processed: 0, failed: 0, deadLetter: [] }
    const chunks = this.chunk(events, this.options.maxBatchSize)

    for (const chunk of chunks) {
      let offset = 0
      while (offset < chunk.length) {
        const batch = chunk.slice(offset, offset + this.options.concurrency)
        offset += batch.length
        const promises = batch.map(event =>
          this.processOne(event, handler)
        )
        const outcomes = await Promise.all(promises)
        for (const o of outcomes) {
          if (o.ok) result.processed++
          else {
            result.failed++
            if (o.action === "dead-letter") result.deadLetter.push(o.event)
          }
        }
      }
    }

    return result
  }

  private async processOne(
    event: EventPayload,
    handler: (e: EventPayload) => EventPayload | null,
  ): Promise<{ ok: boolean; event: EventPayload; action?: string }> {
    let attempt = 0
    while (attempt <= this.retryPolicy.maxRetries) {
      try {
        const r = handler(event)
        return { ok: r !== null, event }
      } catch (e) {
        attempt++
        if (!this.retryPolicy.shouldRetry(event, attempt, e as Error)) {
          return { ok: false, event, action: "skip" }
        }
        if (attempt > this.retryPolicy.maxRetries) {
          return { ok: false, event, action: "dead-letter" }
        }
        await this.delay(this.retryPolicy.backoffMs * attempt)
      }
    }
    return { ok: false, event, action: "dead-letter" }
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size))
    }
    return chunks
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms))
  }
}
