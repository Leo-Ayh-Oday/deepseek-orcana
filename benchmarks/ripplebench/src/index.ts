/** Event Pipeline — barrel export. */
export { EventBus } from "./event-bus"
export { BatchProcessor } from "./batch-processor"
export type { BatchResult } from "./batch-processor"
export { createMiddlewareChain, loggingMiddleware, metricsMiddleware, createValidateMiddleware } from "./middleware"
export type {
  EventType, EventPayload, PipelineContext, Handler,
  Middleware, RetryPolicy, BatchOptions,
  ErrorAction, ErrorEntry,
} from "./types"
export { DEFAULT_RETRY, defaultErrorHandler } from "./types"
