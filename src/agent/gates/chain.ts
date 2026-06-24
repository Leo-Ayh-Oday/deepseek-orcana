/** Composable gate chain — evaluates gates in order, first block wins.
 *
 *  Usage:
 *    const chain = GateChain.pipe<ToolContext>([
 *      new RateLimitGate(),
 *      new PermissionGate(permissionGate, pmode),
 *      new ReadonlyIntentGate(),
 *      new RippleBlockGate(),
 *      new PlanningPhaseGate(),
 *      new WebSearchGate(),
 *    ])
 *    const result = await chain.evaluate(toolCtx)
 *    if (!result.pass) { ... handle block ... }
 */

import type { Gate, GateResult, GateTrace } from "./types"
import type { GateTelemetry } from "./telemetry"

export class GateChain<TContext> {
  private constructor(private gates: Gate<TContext>[]) {}

  /** Create a chain from an ordered list of gates. */
  static pipe<T>(gates: Gate<T>[]): GateChain<T> {
    return new GateChain(gates)
  }

  /** Number of gates in the chain. */
  get length(): number {
    return this.gates.length
  }

  /** Evaluate all gates in order. Returns the first block result, or `{ pass: true }` if all pass.
   *  Pass an optional GateTelemetry to record pass/block outcomes. */
  async evaluate(ctx: TContext, telemetry?: GateTelemetry): Promise<GateResult> {
    for (const gate of this.gates) {
      const result = await gate.evaluate(ctx)
      telemetry?.record(gate.name, result.pass ? "pass" : "block")
      if (!result.pass) return result
    }
    return { pass: true }
  }

  /** Evaluate with tracing — returns which gate blocked (for logging/overflow tracking). */
  async evaluateWithTrace(ctx: TContext, telemetry?: GateTelemetry): Promise<{ result: GateResult; trace: GateTrace[] }> {
    const trace: GateTrace[] = []
    for (const gate of this.gates) {
      const result = await gate.evaluate(ctx)
      telemetry?.record(gate.name, result.pass ? "pass" : "block")
      trace.push({ gateName: gate.name, result })
      if (!result.pass) return { result, trace }
    }
    return { result: { pass: true }, trace }
  }

  /** Evaluate synchronously (throws if any gate returns a Promise).
   *  Pass an optional GateTelemetry to record pass/block outcomes. */
  evaluateSync(ctx: TContext, telemetry?: GateTelemetry): GateResult {
    for (const gate of this.gates) {
      const result = gate.evaluate(ctx)
      if (result instanceof Promise) {
        throw new Error(`Gate "${gate.name}" returned a Promise — use evaluate() instead`)
      }
      telemetry?.record(gate.name, result.pass ? "pass" : "block")
      if (!result.pass) return result
    }
    return { pass: true }
  }
}
