/** Event Pipeline integration tests.
 *
 *  These tests define the expected behavior after each benchmark task
 *  is applied. The benchmark runner clones the fixture, applies the
 *  task description, then runs these tests to verify correctness.
 */
import { describe, test, expect } from "bun:test"
import { EventBus, BatchProcessor, createMiddlewareChain, loggingMiddleware, createValidateMiddleware, DEFAULT_RETRY } from "../src"

// ── Fixtures ──

import type { EventPayload } from "../src/types"

function makeEvent(type: EventPayload["type"], data: Record<string, unknown> = {}): EventPayload {
  return { type, timestamp: Date.now(), data }
}

describe("EventBus", () => {
  test("subscribe and emit with handler", () => {
    const bus = new EventBus()
    const received: Array<{ type: string; data: unknown }> = []

    bus.subscribe("user.created", (event, ctx) => {
      received.push({ type: event.type, data: event.data })
      expect(ctx.traceId).toMatch(/^trace-/)
      expect(ctx.source).toBe("event-bus")
      return event
    })

    const results = bus.emit(makeEvent("user.created", { id: 1 }))
    expect(results).toHaveLength(1)
    expect(received[0]!.type).toBe("user.created")
  })

  test("emit with no subscribers returns empty", () => {
    const bus = new EventBus()
    const results = bus.emit(makeEvent("user.created"))
    expect(results).toEqual([])
  })

  test("health check reflects handler state", () => {
    const bus = new EventBus()
    expect(bus.healthy).toBe(false)
    bus.subscribe("user.created", e => e)
    expect(bus.healthy).toBe(true)
  })

  test("middleware chain is applied in order", () => {
    const bus = new EventBus()
    const order: string[] = []

    bus.use({
      name: "first",
      process(_event, _ctx, next) { order.push("first"); return next() },
    })
    bus.use({
      name: "second",
      process(_event, _ctx, next) { order.push("second"); return next() },
    })

    bus.subscribe("user.created", e => { order.push("handler"); return e })
    bus.emit(makeEvent("user.created"))
    expect(order).toEqual(["first", "second", "handler"])
  })

  test("handler returning null filters event", () => {
    const bus = new EventBus()
    bus.subscribe("user.created", () => null)
    bus.subscribe("user.created", e => e)

    const results = bus.emit(makeEvent("user.created"))
    expect(results).toHaveLength(1)
  })

  test("validate middleware blocks invalid types", () => {
    const bus = new EventBus()
    bus.use(createValidateMiddleware(["user.created"]))
    bus.subscribe("user.created", e => e)

    bus.subscribe("order.placed", e => e)
    expect(() => bus.emit(makeEvent("order.placed"))).toThrow("Invalid event type")
  })
})

describe("BatchProcessor", () => {
  test("processes events in batches with retry on failure", async () => {
    let calls = 0
    const handler = (_e: ReturnType<typeof makeEvent>) => {
      calls++
      if (calls <= 2) throw new Error("temporary failure")
      return _e
    }

    const proc = new BatchProcessor({ maxBatchSize: 5, concurrency: 2, retry: { maxRetries: 3, backoffMs: 10, shouldRetry: () => true } })
    const events = [1, 2, 3].map(i => makeEvent("user.created", { i }))
    const result = await proc.processBatch(events, handler)

    expect(result.processed).toBe(3)
    expect(result.failed).toBe(0)
    expect(result.deadLetter).toHaveLength(0)
  })

  test("dead-letter after max retries", async () => {
    const handler = () => { throw new Error("persistent failure") }
    const proc = new BatchProcessor({ maxBatchSize: 5, concurrency: 1, retry: { maxRetries: 1, backoffMs: 5, shouldRetry: () => true } })
    const result = await proc.processBatch([makeEvent("user.created")], handler)

    expect(result.failed).toBe(1)
    expect(result.deadLetter).toHaveLength(1)
  })

  test("shouldRetry=false skips without retry", async () => {
    const handler = () => { throw new Error("skip me") }
    const proc = new BatchProcessor({ maxBatchSize: 5, concurrency: 1, retry: { maxRetries: 3, backoffMs: 5, shouldRetry: () => false } })
    const result = await proc.processBatch([makeEvent("user.created")], handler)

    expect(result.failed).toBe(1)
    expect(result.deadLetter).toHaveLength(0)
  })
})

describe("Middleware chain", () => {
  test("createMiddlewareChain with no middlewares calls handler directly", () => {
    let called = false
    const evt = makeEvent("user.created")
    const result = createMiddlewareChain(
      evt,
      { traceId: "test", source: "test", tags: [] },
      [],
      () => { called = true; return evt },
    )
    expect(called).toBe(true)
    expect(result).not.toBeNull()
  })

  test("middleware context is isolated between calls", () => {
    const ctx = { traceId: "test", source: "test", tags: [] }
    let mw1CtxTags: string[] | undefined
    const evt = makeEvent("user.created")

    createMiddlewareChain(evt, ctx, [
      {
        name: "tagger",
        process(_event, mwCtx, next) {
          mwCtx.tags.push("tagged")
          mw1CtxTags = mwCtx.tags
          return next()
        },
      },
    ], () => evt)

    // Original ctx should not be mutated
    expect(ctx.tags).toEqual([])
    // Middleware's copy had the tag
    expect(mw1CtxTags).toEqual(["tagged"])
  })
})
