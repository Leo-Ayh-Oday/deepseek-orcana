/** Event Pipeline — core types.
 *
 *  A type-safe event processing system with generic context propagation,
 *  middleware chains, and batched retry logic.
 *
 *  This is the benchmark codebase. Changes here ripple through 9 other files.
 */

// ── Event base types ──

export type EventType = "user.created" | "user.updated" | "order.placed" | "order.cancelled" | "payment.received" | "payment.failed"

export interface EventPayload {
  type: EventType
  timestamp: number
  data: Record<string, unknown>
}

// ── Pipeline context — generic, must stay consistent across all handlers ──

export interface PipelineContext {
  traceId: string
  source: string
  tags: string[]
}

// ── Handler signature — the core contract.  ──

export type Handler<T = EventPayload> = (event: T, ctx: PipelineContext) => T | null

// ── Middleware — transforms the pipeline. ──

export interface Middleware<C extends PipelineContext = PipelineContext> {
  name: string
  process: (event: EventPayload, ctx: C, next: () => EventPayload | null) => EventPayload | null
}

// ── Retry policy ──

export interface RetryPolicy {
  maxRetries: number
  backoffMs: number
  /** Called before each retry. Return false to abort. */
  shouldRetry: (event: EventPayload, attempt: number, error: Error) => boolean
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 3,
  backoffMs: 100,
  shouldRetry: () => true,
}

// ── Batch processing ──

export interface BatchOptions {
  maxBatchSize: number
  concurrency: number
  retry: RetryPolicy
}

// ── Error strategy — pluggable error handling ──

export type ErrorAction = "retry" | "skip" | "dead-letter"

export interface ErrorEntry {
  event: EventPayload
  error: Error
  attempt: number
}

export function defaultErrorHandler(entry: ErrorEntry): ErrorAction {
  if (entry.attempt < 3) return "retry"
  return "dead-letter"
}
