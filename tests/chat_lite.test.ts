import { describe, expect, test } from "bun:test"
import { shouldUseChatLite } from "../src/ui/chat-lite"

describe("chat-lite routing", () => {
  test("routes greetings and no-op chat to chat-lite", () => {
    expect(shouldUseChatLite("你好")).toBe(true)
    expect(shouldUseChatLite("hi")).toBe(true)
    expect(shouldUseChatLite("什么都不要做")).toBe(true)
    expect(shouldUseChatLite("等一下")).toBe(true)
  })

  test("keeps code and project tasks on the full agent path", () => {
    expect(shouldUseChatLite("帮我改 src/index.ts")).toBe(false)
    expect(shouldUseChatLite("跑一下测试")).toBe(false)
    expect(shouldUseChatLite("查一下 loadUser 在哪里调用")).toBe(false)
    expect(shouldUseChatLite("/stats")).toBe(false)
  })

  test("does not route long ambiguous prompts to chat-lite", () => {
    const prompt = "我想讨论一下这个项目接下来怎么优化，尤其是 token、工具调用、上下文和多文件编辑之间的关系"

    expect(shouldUseChatLite(prompt)).toBe(false)
  })
})
