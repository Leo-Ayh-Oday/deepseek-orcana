# DeepSeek Orcana

<p align="center"><strong>基于 Bun 的终端编码智能体，约束优先架构，DeepSeek 驱动。</strong></p>

<p align="center">
  中文 | <a href="./README.md">English</a>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="./CONTRIBUTING.zh.md"><img src="https://img.shields.io/badge/贡献-欢迎-brightgreen.svg" alt="欢迎贡献"></a>
</p>

---

DeepSeek Orcana 是一个单智能体终端编程助手。它能读、写、推理代码——通过**约束优先设计**，让 AI 更难写出坏代码。

基于 Bun + TypeScript + Ink（React TUI），默认使用 DeepSeek 的 Anthropic 兼容 API。

## 为什么叫 Orcana？

Orcana = Orchestra + Cana（迦拿，变水为酒的奇迹），寓意"把代码编排成好酒"。

## 亮点

**每轮 26 道安全机制。** 每次 agent 循环都穿过一系列独立门控——上下文预算、意图门、涟漪阻止、权限门、频率限制、质量门、完成门、Flash Judge 等。不信任任何单一机制。

| 层次 | 机制 | 源码 |
|------|------|------|
| **入口** | Flash Triage——一次 Flash 调用替代 4 个关键词分类器 | `src/agent/flash-triage.ts` |
| **预算** | 上下文预算：50% 警告，60% 阻止 | `loop.ts:294-315` |
| **安全** | 门控溢出：拦截 3 次→强制换策略，5 次→BLOCKED | `loop.ts:1562-1607` |
| **自学习** | 错误追踪器：重复 2 次→提示搜索解决方案，4 次→承认失败 | `loop.ts:96-123` |
| **验证** | Flash Judge——独立模型评估完成度（SATISFIED/NOT_SATISFIED/IMPOSSIBLE） | `src/agent/flash-judge.ts` |
| **证词** | 证词账本——追踪 Agent 承诺 vs 交付，检测循环空头支票 | `flash-judge.ts:196-249` |
| **依赖** | Ripple 引擎——TypeScript 感知的级联检测，未解决则阻止写入 | `src/ripple/` |
| **沙箱** | Job Object（kernel32）+ PathGuard + 环境变量白名单 + 超时 | `src/sandbox/` |
| **记忆** | CJK bigram+trigram 分词器，思考压实，知识协调 | `src/memory/` |
| **截断** | 智能 head+tail，错误时保留更多尾部（70% head），无错误 85% head | `loop.ts:1357-1376` |
| **缓存** | 冻结稳定前缀——首轮计算，全会话复用，保持 Anthropic 前缀缓存 | `loop.ts:733-742` |

→ 详见 [ARCHITECTURE.md](./ARCHITECTURE.md)，包含完整 26 门循环解剖和每个系统的深度分析。

## 快速开始

### 环境要求
- **Bun** ≥ 1.3
- **Node.js** ≥ 18（npm shim 需要）
- **DeepSeek API Key**（[点此获取](https://platform.deepseek.com)）

### 安装

```bash
npm install -g deepseek-orcana
```

可用命令：`orcana`、`deepseek-orcana`、`deepseek-code`、`deepseek`。

> 注意：`deepseek-code` 在 npm 上已被占用。包名为 `deepseek-orcana`，推荐使用 `orcana` 命令。

### 配置

```bash
# 设置 API Key
export DEEPSEEK_API_KEY="sk-your-key-here"

# 或复制环境变量模板
cp .env.example .env   # 编辑 .env 填入你的 key
```

详见 [`.env.example`](./.env.example)。

### 使用

```bash
orcana                              # 启动 TUI
orcana "分析这个代码库"               # 一次性提问
orcana --cli                        # 经典 CLI 模式
orcana list                         # 列出所有会话
orcana last                         # 恢复上次会话
```

## 配置说明

Orcana 使用 `~/.deepseek-code/settings.json` 持久化配置。复制模板开始：

```bash
mkdir -p ~/.deepseek-code
cp settings.example.json ~/.deepseek-code/settings.json
```

### 配置文件

| 文件 | 位置 | 用途 |
|------|------|------|
| `settings.json` | `~/.deepseek-code/` | 提供商、TUI、记忆、沙箱、MCP |
| `mcp.json` | `~/.deepseek-code/` | MCP 服务器定义 |
| `permissions.json` | `~/.deepseek-code/` 或 `<项目>/.deepseek-code/` | 工具权限规则 |
| `.env` | 项目根目录 | API Key（切勿提交到 Git） |

## 架构

```
CLI/TUI (Ink React)
    │
    ▼
主循环控制器 (Loop Controller)
    ├─ 权限门 ──── 执行前拦截不安全调用
    ├─ Flash Judge ─ 每步完成度评估
    ├─ 状态机 ──── 强制阶段转换
    ├─ Ripple 引擎 ─ TypeScript 代码智能
    ├─ 沙箱 ────── 路径守卫 + 进程隔离
    └─ 记忆 ────── SQLite 混合存储 + 压缩周期
```

详见 [ARCHITECTURE.md](./ARCHITECTURE.md) —— 设计决策、约束哲学、"不重犯"知识库。

## 开发

```bash
bun install
bun run typecheck    # tsc --noEmit
bun test             # 运行测试套件
bun run build        # tsc → dist/
```

## 灵感来源

Orcana 借鉴了以下开源项目的设计思路：

| 项目 | 借鉴内容 |
|------|----------|
| [OpenCode](https://github.com/anomalyco/opencode) (MIT) | MCP 桥接、配置系统、TUI 模式 |
| [MiMo Code](https://github.com/XiaoMi/mimo-code) (MIT) | 记忆系统、检查点模板、智能截断 |
| [Claude Code](https://claude.ai/code) | Hook 系统、权限 UX |
| [Aider](https://github.com/Aider-AI/aider) | Map-reduce 编辑 |

完整列表见 [ACKNOWLEDGMENTS.md](./ACKNOWLEDGMENTS.md)。

## 协议

MIT — 详见 [LICENSE](./LICENSE)。

## 参与贡献

欢迎 PR！详见 [CONTRIBUTING.zh.md](./CONTRIBUTING.zh.md)。

## 安全

漏洞报告见 [SECURITY.md](./SECURITY.md)。
