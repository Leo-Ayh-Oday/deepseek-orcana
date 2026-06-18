/** EventBus — type-safe pub/sub with middleware chain. */
import type { EventPayload, Handler, Middleware, PipelineContext } from "./types"
import { createMiddlewareChain } from "./middleware"

export class EventBus {
  private handlers = new Map<string, Set<Handler>>()
  private middlewares: Middleware[] = []

  use(middleware: Middleware): this {
    this.middlewares.push(middleware)
    return this
  }

  subscribe(eventType: string, handler: Handler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set())
    }
    this.handlers.get(eventType)!.add(handler)
    return () => this.handlers.get(eventType)?.delete(handler)
  }

  emit(event: EventPayload): EventPayload[] {
    const handlers = this.handlers.get(event.type)
    if (!handlers || handlers.size === 0) return []

    const ctx: PipelineContext = {
      traceId: `trace-${Date.now()}`,
      source: "event-bus",
      tags: [],
    }

    const results: EventPayload[] = []
    for (const handler of handlers) {
      const chain = () => handler(event, ctx)
      const result = createMiddlewareChain(event, ctx, this.middlewares, chain)
      if (result !== null) results.push(result)
    }

    return results
  }

  /** Health check — always returns true unless no handlers registered. */
  get healthy(): boolean {
    return this.handlers.size > 0
  }
}
