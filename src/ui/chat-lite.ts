const NOOP_PATTERNS = [
  /什么都不要做/,
  /不用做/,
  /先别做/,
  /别动/,
  /别改/,
  /等一下/,
  /等等/,
]

const CASUAL_PATTERNS = [
  /^(你好|您好|嗨|哈喽|hello|hi|hey|在吗|早|早上好|下午好|晚上好)+$/i,
  /^(谢谢|谢了|多谢|好的|好|可以|嗯|哦|行|明白|收到|ok|okay)$/i,
  /^(你是谁|你是什么|你能做什么|介绍一下自己|聊聊|随便聊聊)$/i,
]

const TASK_PATTERN = /(读|写|改|修|查|找|搜|运行|测试|报错|项目|文件|代码|实现|删除|创建|生成|提交|对比|审查|review|bug|error|git|npm|bun|tsc|build|test|file|code)/i

function normalizePrompt(input: string): string {
  return input
    .trim()
    .replace(/[，。！？!?.、~～\s]+/g, "")
}

export function shouldUseChatLite(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed || trimmed.startsWith("/")) return false
  if (trimmed.length > 100) return false

  const normalized = normalizePrompt(trimmed)
  if (!normalized) return false
  if (NOOP_PATTERNS.some(pattern => pattern.test(normalized))) return true
  if (CASUAL_PATTERNS.some(pattern => pattern.test(normalized))) return true
  if (TASK_PATTERN.test(normalized)) return false

  return normalized.length <= 12
}
