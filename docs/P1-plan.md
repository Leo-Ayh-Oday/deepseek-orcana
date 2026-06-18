# P1 实施计划：3-Agent 架构迁移

> 目标版本: 0.2.0
> 起始版本: 0.1.0 (当前)
> 创建日期: 2025-06-09
> 预计工期: 3-5 个开发会话

## 总览

将当前**单 Agent 循环** (`src/agent/loop.ts`) 重构为 **3-Agent + Meta-Agent** 的协作架构。

```
当前:  CLI → AgentLoop (一人分饰三角)
目标:  CLI → MetaAgent → Planner | Coder | Inspector
```

## P1 阶段范围

| 包含 | 不包含 (留给 P2) |
|------|-----------------|
| Planner 类型定义 + 产出 Plan | Planner 自动搜索优化 |
| Coder 按 Plan 逐步执行 | Coder 并行执行多个 step |
| Inspector Plan-checklist 打勾 | Inspector 自动补全遗漏项 |
| Meta-Agent 置信度仲裁 | Meta-Agent 协商对话 |
| 事件总线 (TypedEventBus) | 分布式 Agent 通信 |
| 端到端集成 + 测试 | 性能基准测试 |

---

## Checklist：实施步骤

### Phase A：基础架构 (类型 + 事件)

- [ ] **A1** `src/agent/contracts.ts` — 契约类型定义
  - PlanDocument, PlanStep, ChecklistItem
  - CoderReport, ExecutedStep, ExecError
  - InspectionReport, ChecklistResult, InspectionVerdict
  - ArbitrationResult
  - **验证**: `tsc --noEmit` 无类型错误

- [ ] **A2** `src/agent/bus.ts` — TypedEventBus
  - emit / on / once / off 接口
  - AgentEvent 联合类型
  - 异步处理器栈
  - **验证**: `tests/bus.test.ts` 基本发布订阅通过

- [ ] **A3** `src/agent/confidence.ts` — 置信度计算
  - `calculateOverall(min(...), 80)` 硬上限
  - `disagreementScore(plan, inspector, failedCount)` 分歧度
  - `recommendAction(score)` → "approve" | "negotiate" | "reject"
  - **验证**: `tests/confidence.test.ts` 边界值覆盖

### Phase B：三个 Agent

- [ ] **B1** `src/agent/planner.ts` — Planner Agent
  - 输入：用户 prompt + context kernel
  - 调用 LLM，要求产出 `PlanDocument` JSON
  - 解析 + 验证 Plan 结构 (Zod 或手动校验)
  - confidence 截断到 ≤80
  - **验证**: `tests/planner.test.ts` 输入样例产出合法 Plan

- [ ] **B2** `src/agent/coder.ts` — Coder Agent
  - 输入：`PlanDocument`
  - 逐 step 执行：read_file → write/edit → tsc → 自检
  - 产出 `CoderReport`
  - 错误处理：最多 fix 2 次 → escalate
  - **验证**: `tests/coder.test.ts` 模拟工具执行

- [ ] **B3** `src/agent/inspector.ts` — Inspector Agent
  - 输入：`PlanDocument` + `CoderReport` + 文件系统
  - 逐 checklist 验证（grep / tsc / bun test）
  - 产出 `InspectionReport`
  - **禁止**添加 checklist 之外的评审
  - **验证**: `tests/inspector.test.ts` 通过/失败场景

### Phase C：仲裁 + 集成

- [ ] **C1** `src/agent/meta-agent.ts` — Meta-Agent 仲裁器
  - 协调 P→C→I 工作流
  - 执行 `contract.md §3.2` 的仲裁决策树
  - 产出 `ArbitrationResult`
  - **验证**: `tests/meta_agent.test.ts` 各分支覆盖

- [ ] **C2** `src/ui/cli.ts` — CLI 适配
  - 将 `agentLoop()` 替换为 `metaAgentPipeline()`
  - 保持现有交互模式不变
  - 新 flag: `--mode agent3` (默认单Agent向后兼容)
  - **验证**: 手动交互测试，CI 不变

### Phase D：端到端验证

- [ ] **D1** `tests/p1_integration.test.ts` — 端到端测试
  - 场景1: 简单单文件修改 → plan→code→inspect→approve
  - 场景2: step 失败 2 次 → escalate → meta 裁决 reject
  - 场景3: 高分歧度 → negotiation 触发
  - **验证**: 3 个场景全部 green

- [ ] **D2** 回归测试 — 确保原有功能不受影响
  - `bun test` 全部通过
  - `bun run typecheck` 零错误
  - 单 Agent 模式 (`--mode default`) 正常工作

---

## 文件清单 (新增/修改)

### 新增文件

| 文件 | 行数估计 | 说明 |
|------|---------|------|
| `src/agent/contracts.ts` | ~120 | 所有契约类型定义 |
| `src/agent/bus.ts` | ~80 | TypedEventBus |
| `src/agent/confidence.ts` | ~60 | 置信度计算 |
| `src/agent/planner.ts` | ~150 | Planner Agent |
| `src/agent/coder.ts` | ~180 | Coder Agent |
| `src/agent/inspector.ts` | ~150 | Inspector Agent |
| `src/agent/meta-agent.ts` | ~200 | Meta-Agent 仲裁器 |
| `tests/bus.test.ts` | ~40 | EventBus 测试 |
| `tests/confidence.test.ts` | ~50 | 置信度测试 |
| `tests/planner.test.ts` | ~60 | Planner 测试 |
| `tests/coder.test.ts` | ~80 | Coder 测试 |
| `tests/inspector.test.ts` | ~80 | Inspector 测试 |
| `tests/meta_agent.test.ts` | ~100 | Meta-Agent 测试 |
| `tests/p1_integration.test.ts` | ~80 | 端到端集成测试 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/ui/cli.ts` | 集成 metaAgentPipeline |
| `src/agent/prompts.ts` | 新增 Planner/Coder/Inspector 专用提示词 |
| `src/agent/router.ts` | 保留，供单Agent模式兼容 |
| `src/agent/loop.ts` | 保留，供单Agent模式兼容 |

---

## 风险 + 缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| LLM 产出不合法的 JSON Plan | 中 | 高 | JSON repair 模块已就绪，加 Zod schema 校验 |
| Coder 擅自偏离 Plan | 高 | 中 | Coder 只读 PlanDocument，用 prompt 约束 |
| Inspector 自由发挥加评审项 | 高 | 中 | Prompt 硬约束 + inspector.ts 解析时过滤外来项 |
| 3 个 Agent 延迟太高 | 低 | 中 | Phase A 先不做协商对话，只做一次性仲裁 |
| 置信度分歧导致频繁 escalate | 中 | 低 | 先调高 disagreement 阈值到 30 |

---

## 进度追踪

| 阶段 | 状态 | 开始 | 完成 |
|------|------|------|------|
| Phase A (基础) | ⬜ 待开始 | — | — |
| Phase B (Agent) | ⬜ 待开始 | — | — |
| Phase C (仲裁) | ⬜ 待开始 | — | — |
| Phase D (测试) | ⬜ 待开始 | — | — |

> 每个 Phase 完成后打 ✅，并记录实际耗时。
