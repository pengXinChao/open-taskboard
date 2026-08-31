# Taskboard 任务会话编排技术实现计划

> **状态**：产品基线已批准，计划用于技术实现拆解；尚未开始业务代码实现。
>
> **规格**：[2026-08-30-task-session-orchestration-design.md](../specs/2026-08-30-task-session-orchestration-design.md)

## 目标

打通第一期主路径：

`TaskDetail 发起 -> 自动绑定主会话 -> 主会话读取 Jira 并确认意图 -> 创建独立任务窗口 -> 任务会话多轮执行 -> 用户确认报告 -> 主会话自动检查 -> 用户确认集成/Jira 写回/完成`

## 真实现状路径（实现前证据）

当前产品的可执行路径已经存在，但只有“一次性打开新对话”：

1. 入口是 [TaskDetail.tsx](../../web/src/components/TaskDetail.tsx) 的 `onOpenInThread` 按钮（约 1574 行）。
2. [App.tsx](../../web/src/App.tsx) 的 `openTaskInThread`（约 3040 行）解析任务项目、worktree 和 Codex project identity，然后向宿主发送 `taskboard:create-thread`。
3. [codex-taskboard.user.js](../../inject/codex-taskboard.user.js) 的 `createThreadForTask`（约 1052 行）切换 Codex 项目，调用 `navigate-to-route`，并把 `prefillPrompt` 放入 composer。
4. 用户在 Codex composer 中继续执行；当前任务只保存单一 `Task.threadBinding`，没有主子编排、意图版本或结果报告记录。

目标实现需保留上述入口和宿主导航能力，但把一次性 prompt 替换成可恢复的编排记录和版本化消息。

## 架构边界

| 边界 | 第一阶段实现 |
|---|---|
| 主会话 | 使用宿主 `hostContext.threadId`；没有时先打开新主会话并等待 thread identity，再创建编排 |
| 任务会话 | 一个 active 编排只创建一个 child thread；独立 Codex 窗口、独立 worktree |
| Jira | 主会话读取快照和附件；只有主会话在用户确认后写回 |
| 消息 | Taskboard 持久化 `task-intent.v1`、`task-result.v1`、ack 和生命周期事件；Codex adapter 负责实际 thread/turn/窗口通信 |
| 并行 | 不同 Jira 任务可在不同 worktree 并行；Taskboard 不自动判断冲突或排队 |
| 集成 | 默认 merge，支持选择性 cherry-pick；冲突停止并交给用户 |
| 审查 | 主会话自动开始检查；编码变更可调用 `open code review`，结果只作为检查证据 |

## 先行验证：独立窗口与线程身份 Spike

这是实现前唯一需要先验证的宿主边界，避免在错误的 Codex 导航假设上扩展业务模型。

- 在 `codex-taskboard.user.js` 复用现有 `navigate-to-route`，打开第二个 Codex 窗口/任务路由。
- 用宿主 context 和 sidebar thread row 验证 child thread ID 的获得时机；确认是导航时可获得，还是首个 `turn/start` 后才产生。
- 对比本地 `CodexHostAppServer`（[server/codex-app-server.mjs](../../server/codex-app-server.mjs)）和注入脚本 CDP 请求能力，选择唯一 adapter 路径。
- Spike 只输出 thread/window identity handshake，不创建业务表；失败时记录明确宿主限制，再调整 P1 派发方式。

## 数据模型与协议

### 新增类型（`web/src/types.ts`）

- `OrchestrationState`：`unbound | intent_draft | intent_ready | dispatched | executing | waiting_for_user | reporting | result_ready | reviewing | writeback_pending | synced | blocked | integrated | done`。
- `TaskSessionOrchestration`：任务、parent/child thread binding、window/runtime/worktree、当前状态、意图/结果版本、快照摘要和审计时间。
- `TaskIntentRevision`：`task-intent.v1` 的目标、原因、范围、验收、约束、必要附件引用和 `captureDigest`。
- `TaskResultRevision`：`task-result.v1` 的摘要、原因、变更文件、验证证据、风险/阻塞、建议 Jira 更新和 `resultRevision`。
- `TaskSessionMessage`、`ReviewDecision`、`JiraWritebackPreview`。

### SQLite（`server/database.mjs`）

新增两张表，使用现有 `#migrate()` 初始化方式：

```text
task_session_orchestrations
  id, task_id, state, parent_thread_json, child_thread_json,
  child_window_json, runtime_json, worktree_json,
  intent_json, source_snapshot_json, intent_digest,
  current_result_revision, review_json, writeback_json,
  version, created_at, updated_at

task_session_messages
  id, orchestration_id, direction, type, idempotency_key,
  payload_json, delivery_state, sequence, created_at
```

约束：一个 task 同时只有一个 active orchestration；报告幂等键为 `orchestrationId:resultRevision`；意图、快照、结果和消息只追加版本，不静默覆盖。

## API 与服务端任务

在 [server/app.mjs](../../server/app.mjs) 增加 provider-neutral 路由，在 [web/src/api.ts](../../web/src/api.ts) 增加客户端函数：

| API | 作用 |
|---|---|
| `POST /api/tasks/:taskId/orchestrations` | 自动绑定/复用主会话，创建 `intent_draft` |
| `GET /api/orchestrations/:id` | 返回编排、当前意图、报告、检查和状态 |
| `POST /api/orchestrations/:id/intent` | 保存意图草稿或新版本 |
| `POST /api/orchestrations/:id/intent/confirm` | 校验 Jira digest，确认意图 |
| `POST /api/orchestrations/:id/dispatch` | 创建 child thread/window handshake，保存 child binding |
| `POST /api/orchestrations/:id/messages` | 主会话补充要求、状态 ack 和结构化通信 |
| `POST /api/orchestrations/:id/reports` | 保存 `reporting` 结果版本并执行幂等投递 |
| `POST /api/orchestrations/:id/reports/:revision/ack` | 主会话收件确认 |
| `POST /api/orchestrations/:id/review` | 保存自动检查草稿及 `approved/needs_rework/blocked` |
| `POST /api/orchestrations/:id/integrate` | 用户确认后 merge/cherry-pick，记录提交/冲突 |
| `POST /api/orchestrations/:id/jira-writeback` | 用户选择评论/字段/状态后分步写回 |
| `POST /api/orchestrations/:id/complete` | 用户显式完成确认，进入 `done` |
| `GET /api/orchestrations/:id/timeline?after=` | 读取单调序列事件 |

服务端实现重点：

- `server/database.mjs` 提供编排读写、版本递增、幂等去重和时间线序列。
- `server/app.mjs` 校验 parent/child thread binding，禁止 child 直接调用 Jira 写回。
- `server/jira-integration.mjs` 复用现有评论、字段和 transition 能力，评论/字段/状态分步执行。
- `server/ai-chat.mjs` 复用既有 thread/turn 生命周期；结果检查不把中间 tool 输出复制到主会话。
- `server/codex-app-server.mjs` 扩展 adapter 能力探测和通知订阅，不把 Codex provider 字段泄漏到 Taskboard 业务协议。

## 前端与宿主任务

### Taskboard Web

- `TaskDetail.tsx`：把“在新对话打开”替换为“发起任务会话/打开任务窗口”，展示主会话、意图、任务会话、结果检查和下一动作。
- 新建 `TaskSessionOrchestrationPanel.tsx`：按已确认顺序显示状态、版本、worktree、结果预览、检查结论、集成和 Jira 写回动作。
- `App.tsx`：实现创建/读取/确认/派发/检查/集成/写回/完成 action，订阅 `/api/events` 或编排 SSE，并保留当前 host context。
- `web/src/api.ts`：加入上述 API 调用、timeline 游标和幂等请求头。
- `web/src/types.ts`：加入协议类型，保留 `Task.threadBinding` 作为主会话兼容字段，不用它表达 child。
- `web/src/styles.css`：桌面右侧纵向面板，移动端底部抽屉；不嵌套两个聊天区域。

### Codex 注入与独立窗口

- `inject/codex-taskboard.user.js`：新增 `taskboard:open-orchestration`、`taskboard:child-thread-ready`、`taskboard:child-state`、`taskboard:report-result` 消息。
- 派发时只注入确认版 `task-intent.v1` briefing 和必要附件引用，不注入完整 Jira 原文或凭据。
- 子窗口标题使用 `{issueKey} · 执行`，保留“查看意图”“打开主会话”“生成结果报告”入口。
- 任务窗口关闭/恢复通过 child thread identity 恢复，不以窗口 ID 作为关联主键。
- `waiting_for_user` 只同步状态，不同步问题正文；`reported` 只在用户确认报告后产生。

## 分阶段实施

### P0：Adapter Spike（高风险，先行）

- 完成独立窗口、child thread ID、主/子窗口导航和恢复 handshake。
- 直接验证：从现有 TaskDetail 入口打开第二个 Codex 窗口，确认能定位同一 child thread。

### P1：单子会话闭环（高风险）

- SQLite 编排/消息表和类型。
- 创建编排、Jira 快照/意图草稿、用户确认、digest 过期检查。
- child 派发、独立窗口、worktree/runtime 绑定和最小生命周期状态。
- 任务窗口多轮执行和报告预览/确认发送。
- 主会话收件 ack、结果版本和 Taskboard 时间线。

### P2：自动检查与用户驱动写回（高风险）

- 主会话收到 ack 后自动生成检查草稿。
- 编码变更按风险选择 `open code review`。
- `approved/needs_rework/blocked`、同一 child/worktree 返工。
- 集成变更（merge/cherry-pick）和 Jira 评论/字段/状态分步预览确认。
- `synced/integrated/done` 分离及显式完成确认。

### P3：恢复与可观测性（中风险）

- 断线恢复、执行尝试、报告重试和幂等审计。
- 关闭窗口后恢复同一 thread；不可恢复时创建新 attempt 并链接旧记录。
- Taskboard 内状态同步；第一期不做系统级通知。

## 直接验证计划

按仓库 E3 规则，只验证主路径和一个成功闭环：

1. **主路径**：TaskDetail 发起 → 自动绑定主会话 → Jira 意图确认 → 独立任务窗口打开 → 任务会话发送一轮真实指令。
2. **报告路径**：任务窗口生成精简报告 → 用户预览确认 → 主会话收到 ack → 自动检查草稿可见。
3. **写回路径**：用户勾选评论/字段/状态 → 主会话按顺序调用 Jira API → 返回 `synced`；再由用户确认 `done`。
4. **恢复路径**：关闭任务窗口 → 从 Taskboard 重新打开 → 进入同一 child thread，保留意图和未发送/已发送结果版本。

聚焦检查：`node --test` 对新增编排协议/数据库/API 单元测试；Web 路径使用真实 Taskboard/Codex 窗口；涉及注入、进程、持久化和跨会话通信，完成可用 demo 后按仓库规则进行 Pro review。

## 不在第一期

- 多 worker 并行处理同一 Jira 任务；
- 子会话直接读取或写回 Jira；
- 自动冲突检测、自动排队或自动合并；
- 系统级通知；
- 自动创建 PR 作为本地集成前置条件；
- 把完整主会话历史 fork 给任务会话。
