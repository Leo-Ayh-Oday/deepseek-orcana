/** Hook system — intercept tool execution, API calls, session events.
 *
 * Inspired by OpenCode's plugin/hook architecture:
 *   - onToolBefore: intercept + optionally block tool calls
 *   - onToolAfter: post-process tool results
 *   - onApiCall: monitor API usage
 */

export interface HookInput {
  tool?: string
  params?: Record<string, unknown>
  result?: { success: boolean; content: string }
  error?: string
}

export interface HookOutput {
  /** Set to true to block execution */
  blocked?: boolean
  /** Override result */
  result?: { success: boolean; content: string }
  /** Warning message */
  warn?: string
}

export type HookHandler = (input: HookInput) => HookOutput | Promise<HookOutput>

export class HookSystem {
  private toolBeforeHandlers: HookHandler[] = []
  private toolAfterHandlers: HookHandler[] = []

  onToolBefore(handler: HookHandler) { this.toolBeforeHandlers.push(handler) }
  onToolAfter(handler: HookHandler) { this.toolAfterHandlers.push(handler) }

  async runBefore(tool: string, params: Record<string, unknown>): Promise<HookOutput> {
    for (const h of this.toolBeforeHandlers) {
      const out = await h({ tool, params })
      if (out.blocked) return out
    }
    return {}
  }

  async runAfter(tool: string, params: Record<string, unknown>, result: { success: boolean; content: string }): Promise<HookOutput> {
    for (const h of this.toolAfterHandlers) {
      const out = await h({ tool, params, result })
      if (out.result) return out
    }
    return {}
  }
}
