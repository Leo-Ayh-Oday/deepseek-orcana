# 自进化系统设计

## 核心循环

```
遇到问题 → 解决不了 → 自动搜索 → 提炼知识 → 存入仓库 → 下次复用
```

## 触发条件

不是什么都搜——烧 token。三种情况下触发学习：

| 触发 | 条件 | 做什么 |
|------|------|--------|
| **连续失败** | 同一工具同类错误 ≥2 次 | 搜错误信息 + 解决方案 |
| **模型不确定** | DS 明确说"我不确定"/"需要查资料" | 搜文档 + API 用法 |
| **新模式** | 用户要求用没见过的库/框架 | 搜官方文档 + 示例 |

## 五个阶段

### Stage 1: 自动搜索（已有）
web_search 工具已就绪。只需要在 agent loop 中加检测：连续错误 → 自动发起搜索。

```
if (toolErrors[name] >= 2) {
  yield autoSearch(`error: ${lastError}`)
}
```

### Stage 2: 知识提炼
搜索结果 → LLM 二次提炼为结构化知识点：

```json
{
  "topic": "DeepSeek V4 thinking mode HTTP 400",
  "problem": "thinking block 未回传导致 API 400",
  "solution": "assistant content 中必须包含 thinking block",
  "sources": ["官方文档", "GitHub issue #1378"]
}
```

### Stage 3: 存入项目知识库
提炼的知识写入 `.deepseek/knowledge/`：
- `python-errors.md` — Python 踩坑
- `api-usage.md` — API 使用经验
- `windows-shell.md` — Windows 命令备忘

下次启动时自动加载到 Cold 上下文层。

### Stage 4: 测试自验证
改完代码自动 `bun test` → 结果注入上下文：
- 全过 → 记录成功到 thinking store
- 失败 → 看哪个测试挂了 → 自动修复 → 重测

### Stage 5: 自改进
agent 能改自己的 prompt、工具描述、推理规则：
- 如果反复犯同一个错（比如总用 ls 不用 dir）
- 自动往 system prompt 里加一条"禁止用 ls，Windows 用 dir"
- 存为 `.deepseek/rules/` 自动加载

## 与 Thinking Store 的关系

Thinking store 存的是"推理链"（做了什么事、怎么做的、结果如何）
知识库存的是"知识点"（这个问题 + 解决 = 可复用方案）

不同维度，互补：thinking chain 帮助保持多轮连贯性，knowledge base 帮助跨会话复用。

## 安全边界

- 只搜索，不自动安装包（需要 explicit 权限）
- 搜索到的代码不让 agent 直接粘贴执行（先展示，人工审查）
- 知识库文件标记来源（URL + 时间），防止过期信息污染
- 每个自动学习周期后需要人工确认才写入永久存储
