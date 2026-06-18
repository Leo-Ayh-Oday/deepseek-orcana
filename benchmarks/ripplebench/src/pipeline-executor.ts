/** PipelineExecutor — shared event processing logic used by EventBus and BatchProcessor. */
import type { EventPayload, Middleware, PipelineContext, Handler } from "./types"
import { createMiddlewareChain } from "./middleware"

export class PipelineExecutor {
  private middlewares: Middleware[] = []

  use(middleware: Middleware): this {
    this.middlewares.push(middleware)
    return this
  }

  /** Run a handler through the middleware chain. Errors propagate to caller (for retry wrapping). */
  execute(
    event: EventPayload,
    ctx: PipelineContext,
    handler: Handler,
  ): EventPayload | null {
    const chain = () => handler(event, ctx)
    return createMiddlewareChain(event, ctx, this.middlewares, chain)
  }

  /** Create a fresh pipeline context for the given source. */
  createContext(source: string): PipelineContext {
    return {
      traceId: `trace-${Date.now()}`,
      source,
      tags: [],
    }
  }
}
