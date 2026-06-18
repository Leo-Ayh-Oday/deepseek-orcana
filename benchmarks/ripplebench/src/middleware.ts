/** Middleware chain builder. */
import type { EventPayload, Middleware, PipelineContext } from "./types"

export function createMiddlewareChain(
  event: EventPayload,
  ctx: PipelineContext,
  middlewares: Middleware[],
  handler: () => EventPayload | null,
): EventPayload | null {
  if (middlewares.length === 0) return handler()

  let index = 0
  function next(): EventPayload | null {
    if (index >= middlewares.length) return handler()
    const mw = middlewares[index++]!
    const ctxCopy = { ...ctx, tags: [...ctx.tags] }
    return mw.process(event, ctxCopy, next)
  }

  return next()
}

// ── Built-in middleware ──

export const loggingMiddleware: Middleware = {
  name: "logging",
  process(event, ctx, next) {
    console.log(`[${ctx.traceId}] processing ${event.type}`)
    return next()
  },
}

export const metricsMiddleware: Middleware = {
  name: "metrics",
  process(event, ctx, next) {
    const started = Date.now()
    const result = next()
    console.log(`[${ctx.traceId}] ${event.type} took ${Date.now() - started}ms`)
    return result
  },
}

export function createValidateMiddleware(allowedTypes: string[]): Middleware {
  return {
    name: "validate",
    process(event, _ctx, next) {
      if (!allowedTypes.includes(event.type)) {
        throw new Error(`Invalid event type: ${event.type}`)
      }
      return next()
    },
  }
}
