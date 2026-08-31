# Taskboard 主会话与任务会话工作流设计

> 状态：已确认，可进入技术实现拆解（2026-08-30）

## 1. 目标

把“发起任务会话”从一次性打开 Codex 新对话，升级为一条可追踪的编排链：

`主会话读取 Jira -> 提炼并确认任务意图 -> 派生任务会话执行 -> 结果包回传 -> 主会话检查 -> Jira 写回`

主会话是任务的管理者和唯一写回者；任务会话是执行者，并在独立 Codex 窗口中运行。任务会话不应重复读取和解释 Jira 原始内容，也不应直接改变 Jira 状态。

## 2. 当前产品基线

当前入口和数据路径如下：

| 环节 | 当前实现 | 观察 |
| --- | --- | --- |
| 入口 | [TaskDetail.tsx](/Users/pengxinchao/Develop/Github/open-taskboard/web/src/components/TaskDetail.tsx:1574) 的“在新对话打开” | 只表达打开动作，没有编排阶段 |
| 创建 | [App.tsx](/Users/pengxinchao/Develop/Github/open-taskboard/web/src/App.tsx:3040) 的 `openTaskInThread` | 通过 host bridge 发送 `taskboard:create-thread` |
| 注入 | [codex-taskboard.user.js](/Users/pengxinchao/Develop/Github/open-taskboard/inject/codex-taskboard.user.js:1052) | 预填 `[$manage-taskboard] + 议题 ID`，把 Jira 读取留给新会话 |
| 绑定 | [types.ts](/Users/pengxinchao/Develop/Github/open-taskboard/web/src/types.ts:441) 的 `Task.threadBinding` | 一张任务只有一个主线程字段；评论另有线程绑定 |
| 本地 AI | [ai-chat.mjs](/Users/pengxinchao/Develop/Github/open-taskboard/server/ai-chat.mjs:362) | 可创建带 issue origin 的本地 AI thread，但没有父子任务会话语义 |
| Jira 写回 | [jira-integration.mjs](/Users/pengxinchao/Develop/Github/open-taskboard/server/jira-integration.mjs:400) | 支持字段更新和状态 transition，状态与字段必须分步 |

因此，本设计不复用单一 `task.threadId` 表达父子关系，而是增加“会话编排记录”；现有任务线程绑定保留为主会话绑定，子会话由编排记录关联。

## 3. Codex 能力与设计选择

官方 Codex app-server 将 Thread 定义为包含 turns 和持久历史的技术对象；支持 `thread/start`、`thread/resume`、`thread/fork`，并通过 `turn/start` 和事件通知驱动执行。`thread/fork` 会复制已有历史，适合需要继承上下文的场景，不适合作为本流程的默认方式，因为 Jira 原文和读取噪声会进入执行会话。

Codex 的 subagent workflow 由主线程负责派生、路由后续指令、等待结果，并把子线程摘要返回主线程。本设计要求子线程被打开为独立 Codex 窗口，但仍保留明确的父子编排关系；“独立窗口”不等于“无关联的新对话”。

默认创建策略是启动一个新的任务 thread，并把它放入独立 Codex 窗口；不使用 `thread/fork` 复制完整 Jira 历史，而是只发送确认后的“任务意图信封”。如果当前 Codex 版本只能通过原生 subagent 派生，则由 host 将该子 thread 路由到新窗口；如果只能创建普通新 thread，则由 Taskboard 保存 `parentThreadId`，并通过跨任务消息完成关联。

### Taskboard 适配边界

- **主线程识别**：沿用现有 host context 的 `threadId` 和 `CodexProjectIdentity`，写入编排记录的 `parentThreadBinding`。
- **派发入口**：Taskboard 的“确认并派发”让主线程创建任务 thread，并请求 Codex 在独立窗口打开该 thread；Taskboard 不复制完整 Jira 历史，只发送意图信封。
- **事件订阅**：通过 app-server 的 `thread/started`、`turn/*`、`item/*` 和 `thread/status/changed` 事件更新子会话状态；以子线程返回的 `forkedFromId`/父子元数据或 `thread/list(parentThreadId)` 建立关联。
- **结果回传**：任务会话窗口中的用户点击“报告主会话”后，发送 `task-result.v1` 到 `parentThreadId`；主会话收到后再持久化结果并检查。任务会话可以多轮执行，但不因某一轮完成就自动报告。
- **兼容降级**：若当前 Codex 版本没有可用的子线程路由，仍可创建独立 thread，但必须由 Taskboard 持久化父子关系，并通过 `@` 引用或跨任务消息发送意图和结果；不得丢失关联。

参考：

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：线程、fork、turn、事件和 `parentThreadId` 查询能力。
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)：主线程、子线程、结果汇总、权限继承和 worker/explorer 角色。
- [Codex Changelog](https://learn.chatgpt.com/docs/changelog)：近期版本支持用 `@` 引用其他 Codex task，并让 Agent 读取、创建或发送消息。

## 4. 领域对象

### 4.1 主会话

用户可见的 Codex 主线程，绑定一张 Taskboard 议题。它拥有以下职责：

- 读取 Jira 议题、评论、附件和关联议题；
- 生成和修订任务意图；
- 创建、暂停、继续、取消任务会话；
- 接收进度、问题和结果包；
- 检查代码、测试和结果包；
- 通过 Taskboard Jira API 更新评论、字段和状态。

### 4.2 任务会话

主会话派生的 Codex worker thread。它只接收确认后的任务意图、执行上下文和必要附件，负责代码或文档工作，并回传结果包。默认不启用 Jira 读取权限；只有主会话显式发出“补充读取 Jira”消息时才允许例外。

### 4.3 任务意图

任务意图不是 Jira 原文复制，而是可执行合同：

```json
{
  "version": "task-intent.v1",
  "goal": "一句话描述要达成的结果",
  "why": "业务背景和问题",
  "scope": { "in": ["范围内"], "out": ["明确不做"] },
  "acceptanceCriteria": ["可验证的验收标准"],
  "constraints": ["技术、兼容性、时间或流程约束"],
  "implementationHints": ["主会话认为有帮助但不强制的建议"],
  "openQuestions": ["需要主会话决定的问题"]
}
```

### 4.4 结果包

任务会话必须以结构化结果包结束。结果包采用“精简展示、完整协议”两层表示：用户预览只显示做了什么、为什么这样做，并仅在存在风险时显示风险；主会话收到的协议保留检查、幂等和审计所需字段。

```json
{
  "version": "task-result.v1",
  "outcome": "completed | blocked | needs_input",
  "summary": "做了什么",
  "rationale": "为什么这么做",
  "changedFiles": [{ "path": "相对路径", "kind": "added | modified | deleted" }],
  "verification": [{ "command": "实际执行的检查", "result": "通过或失败及关键证据" }],
  "risks": ["仅在存在风险时提供"],
  "blockers": ["阻塞原因"],
  "suggestedJiraUpdate": { "comment": "建议写回的内容", "status": "建议状态" }
}
```

报告采用两步操作：先生成可编辑预览，再由用户确认发送。`changedFiles`、`verification`、`blockers`、意图版本和结果版本不占用默认预览空间，但始终随协议发送给主会话。

## 5. 主流程

### 阶段 A：绑定主会话

1. 用户在 Jira 任务详情点击“发起任务会话”。
2. Taskboard 检测当前 Codex thread；没有主会话时先创建或要求用户在 Codex 主窗口打开一个新主会话。
3. Taskboard 将该 thread 记录为任务的主会话绑定，并显示“主会话已绑定”。
4. 主会话只获得 Jira 读取范围，不自动获得 Jira 写回授权。

### 阶段 B：读取与提炼

1. 主会话读取任务详情、评论、附件元数据/内容、关联任务和当前 Jira 状态。
2. 主会话生成任务意图，并把 Jira 来源记录为不可变快照：`originId + issueKey + fetchedAt + digest + attachmentIds`。
3. Taskboard 在“任务意图”面板展示目标、范围、验收标准、约束和待确认问题。
4. 用户点击“确认并派发”；有未解决的 `openQuestions` 时只能保存意图或继续在主会话对话，不能直接派发。

### 阶段 C：派生任务会话

1. 主会话请求 Codex 创建一个 worker 任务 thread，并在独立 Codex 窗口打开它。
2. 发送一个 `task-intent.v1` 信封，其中只包含确认后的意图、快照摘要、执行目录/worktree、权限和必要附件引用。
3. 任务会话窗口标题统一为 `{issueIdentifier} · 执行`，并在 Taskboard 中显示为主会话的子会话。
4. Taskboard 任务状态从 `todo` 进入 `in_progress`；子会话状态单独记录为 `queued/running`。

任务会话的系统指令应明确：

> 你是执行会话。只根据 `task-intent.v1` 完成工作；不要重新读取或解释 Jira。遇到意图缺失、验收标准冲突或需要产品决策时，返回 `needs_input`，不要自行扩大范围或写回 Jira。

### 阶段 D：独立窗口内执行与通信

- 进度：任务会话窗口显示完整多轮对话、命令、文件变更和测试；Taskboard 主窗口只显示摘要状态，不灌入中间噪声。
- 多轮交流：用户可以在任务会话窗口直接补充要求、修正范围、要求重跑测试或调整实现；这些消息只进入任务 thread。
- 主会话追问：主会话只有在用户明确要求时才发送补充指令；默认不打断任务会话的多轮执行。任务会话需要产品决策或权限时，直接在独立窗口向用户提问；问题正文不回传主会话，但 `running / waiting_for_user / paused / reported` 等最小生命周期状态仍同步到 Taskboard。
- 报告：任务会话完成后，用户点击窗口内的“报告主会话”。该动作生成 `task-result.v1` 并通过跨任务消息发给主线程，状态进入 `result_ready`。
- 暂停/关闭：暂停只停止当前 turn，不解除绑定；关闭独立窗口后仍可从 Taskboard 或 Codex 恢复同一个任务 thread。
- 取消：主会话或任务会话窗口都可以发送 interrupt；Taskboard 记录取消原因，任务保留在 `in_progress` 或转 `blocked`，由用户决定。

### 阶段 E：结果回传与检查

1. 用户在任务会话窗口点击“报告主会话”，回传 `task-result.v1` 结果包，并将执行会话标记为 `reported`。
2. Taskboard 收到结果后将任务移到 `in_review`，但不自动写 Jira。
3. 主会话收到结果包后自动开始结果检查，读取并核对：变更范围、验收标准、实际验证证据、工作区 diff、风险和快照是否过期。自动开始只代表生成检查草稿，不代表自动通过、集成代码或写回 Jira。
4. 对包含编码变更的结果，主会话可以调用 `open code review` 辅助检查实现正确性和真实缺陷；是否调用由主会话按变更风险决定，审查结果作为证据进入检查草稿。
5. 主会话生成检查结论：`approved`、`needs_rework` 或 `blocked`。

`needs_rework` 时，主会话发送结构化返工要求，任务会话沿用原 child thread、worktree 和意图编排继续执行；返工完成后递增 `resultRevision`，重新走报告预览、用户确认和自动检查流程。

结果检查通过只表示结果满足当前意图和验收标准，不表示代码已经进入主工作区。任务会话只提交到自己的分支；用户确认后，主会话才执行“集成变更”（merge 或 cherry-pick），并单独记录集成提交、冲突和验证结果。

第一期“集成变更”默认将任务会话分支 merge 到主会话对应分支；用户可改为选择性 cherry-pick。遇到冲突时停止自动集成，由用户处理后再继续；PR 创建不作为本地集成前置条件。

### 阶段 F：Jira 写回

只有主会话检查结论为 `approved` 且用户点击“写回 Jira”时才执行：

1. 先写 Jira 评论（结果摘要、验证证据、子会话链接、主会话链接）。
2. 再按现有 Jira 约束分步执行字段更新和状态 transition；不可把状态和字段合并为一个请求。
3. Taskboard 保存 Jira 写回结果和远端响应时间；成功后任务进入 `done` 仍需遵循现有用户验收规则，未确认时保持 `in_review`。

`synced`（Jira 写回成功）、`integrated`（代码已进入主工作区）和 `done`（用户确认整个闭环完成）是三个独立状态。任何自动检查或外部 API 成功都不能替代完成确认。

## 6. 会话编排状态

会话编排状态与任务状态、Agent 运行状态分开：

| 编排状态 | 含义 | 可执行动作 |
| --- | --- | --- |
| `unbound` | 没有主会话 | 绑定主会话 |
| `intent_draft` | 已读取 Jira，意图仍可编辑 | 编辑、保存、重新提炼 |
| `intent_ready` | 意图已确认，尚未派发 | 确认并派发 |
| `dispatched` | 独立任务窗口已创建，等待首个 turn | 打开、取消 |
| `executing` | 任务窗口内正在多轮执行 | 打开、暂停、取消 |
| `waiting_for_user` | 任务会话在独立窗口等待用户回答或决定，可继续执行 | 打开任务窗口、回答并继续 |
| `reporting` | 用户已请求将结果发送给主会话 | 等待发送完成、取消报告 |
| `result_ready` | 主会话已收到结果包 | 主会话检查 |
| `reviewing` | 主会话正在检查 | 通过、要求返工、阻塞 |
| `writeback_pending` | 已通过检查，等待 Jira 写回 | 写回、返回检查 |
| `synced` | Jira 写回成功 | 查看审计记录 |
| `blocked` | 因权限、环境、Jira 冲突或外部依赖无法继续 | 重试、补充信息、解除阻塞 |

## 7. Taskboard 界面

### 7.1 任务详情主操作

将现有“在新对话打开”替换为“在独立窗口发起任务会话”，旁边显示主会话/任务会话状态。已有编排记录时，按钮变为“打开任务窗口”或“继续编排”，避免重复创建子会话。

### 7.2 编排面板

在任务详情右侧新增一个不嵌套卡片的纵向面板，按顺序显示：

1. **主会话**：绑定状态、打开按钮、最近动作。
2. **任务意图**：快照时间、来源附件数、目标/验收标准摘要、“查看与编辑”。
3. **任务会话**：worker 名称、运行状态、worktree/分支、打开独立窗口/暂停/取消/重试；收到结果前显示“等待任务会话报告”。
4. **结果检查**：结果包摘要、变更文件、验证证据、风险和四个动作：`通过并写回 Jira`、`要求返工`、`仅保存结果`、`标记阻塞`。

控件使用现有 Taskboard 的按钮、状态图标和对话跳转模式；危险操作（取消、写回 Jira）必须在动作时确认。移动端改为底部抽屉，保持同一顺序。

### 7.3 主会话内状态

主会话收到子会话事件时，在 composer 上方显示一条紧凑的“任务编排”条：任务标识、独立任务窗口状态、最近结果和“打开 Taskboard 检查”。原始命令输出和中间噪声留在任务窗口，不灌入主会话正文。

### 7.4 任务会话窗口

独立窗口需要有自己的任务上下文栏，但不复制 Jira 全文：

- 顶部显示任务标识、任务意图版本、worktree/分支和主会话链接；
- 正常使用 Codex composer，允许任意多轮执行和用户补充指令；
- 提供“查看任务意图”“打开主会话”和唯一的完成动作“报告主会话”；
- 点击“报告主会话”后先展示精简结果预览：做了什么、为什么这样做，以及仅在存在时显示的风险；用户确认后才发送。发送后仍可继续交流，但新的变更需要重新生成结果包并再次报告。

## 8. 报告关系维护

报告关系以 `orchestrationId` 为业务主键，以父子 thread binding 为身份校验，不依赖窗口是否仍然打开：

```json
{
  "protocol": "taskboard.task-session/v1",
  "type": "result",
  "orchestrationId": "编排记录 ID",
  "parentThreadId": "主会话 thread ID",
  "childThreadId": "任务会话 thread ID",
  "intentVersion": 3,
  "resultRevision": 2,
  "idempotencyKey": "orchestrationId:resultRevision",
  "payload": { "version": "task-result.v1" }
}
```

发送链路固定为：

1. 任务会话窗口生成结果包，Taskboard 先保存一条 `reporting` 消息和结果版本。
2. Taskboard 校验 `orchestrationId + childThreadId + intentVersion` 是否仍属于当前 active 编排；不匹配的报告只保存为历史，不转发。
3. Taskboard 通过 Codex 跨任务消息发送给 `parentThreadId`，并记录 `delivery_state = sent`。
4. 主会话确认收到后回传 ack，Taskboard 将消息改为 `acknowledged`，编排状态改为 `result_ready`。
5. `acknowledged` 只表示主会话收到，不表示结果通过；主会话仍需完成 `approved/needs_rework/blocked` 检查。

关系维护规则：

- **一主一子**：每个 active 编排只有一个 `parentThreadBinding` 和一个 `childThreadBinding`；窗口 ID 只是打开入口，不是关联主键。
- **幂等**：`idempotencyKey = orchestrationId + resultRevision`。重试同一报告不会重复发送或重复写 Jira。
- **多次报告**：每次报告生成不可变的 `resultRevision`；用户在任务窗口继续修改后只能创建新版本，旧版本仍可审计。
- **过期报告**：如果 Jira 快照或任务意图已更新，旧报告显示“基于旧意图”，不能直接进入写回流程。
- **断线恢复**：主会话暂时不可用时，消息保持 `pending`，恢复后按幂等键重试；任务窗口不需要保持打开。
- **回传权限**：只有被编排记录绑定的 child thread 才能报告；任意其他 thread 的消息不能冒充结果包。
- **可见状态**：Taskboard 显示“报告发送中 / 主会话已收到 / 主会话检查中 / 需要返工 / 已通过”，将传输确认与业务验收明确分开。

## 9. 数据模型建议

新增 provider-neutral 的 `task_session_orchestrations`：

```text
id, task_id, parent_thread_binding, child_thread_binding, child_window_id,
state, intent_json, source_snapshot_json, intent_digest,
result_json, review_json, jira_writeback_json,
created_at, updated_at, version
```

新增 `task_session_messages`（或复用事件表但必须增加方向和协议版本）：

```text
id, orchestration_id, direction, type, idempotency_key,
payload_json, delivery_state, created_at
```

约束：

- 一张任务可有多个历史编排，但同时只有一个 `active` 编排；第一期一个主会话只绑定一张 Jira 任务。
- `task.threadBinding` 只代表主会话；子会话绑定不覆盖它。
- 意图、来源快照和结果包不可被静默覆盖；修订生成新版本并保留审计。
- 所有向 Jira 的写回请求使用 `idempotency_key`，重试不能产生重复评论或重复 transition。
- 附件优先传递 Taskboard attachment id 和受限读取引用，不把 Jira 凭据或完整本地路径写入普通消息。

## 10. 异常和边界

- **子会话创建结果不确定**：先用 thread id 和窗口标识查询/去重；不能确认时显示“可能已创建”，禁止再次盲发。
- **Jira 在提炼后发生变化**：派发前重新比对快照 digest；变化时要求主会话重新读取并确认意图。
- **子会话试图读取 Jira**：默认权限/指令拒绝；需要额外信息时返回 `needs_input`。
- **主会话关闭**：编排记录保留，子会话可继续运行；重新打开主会话后从事件游标恢复。
- **子会话失败**：保留失败结果和日志摘要，提供“按同一意图重试”与“编辑意图后重试”，不新建重复编排。
- **远程项目/worktree**：沿用现有 Codex project identity 和 workspace 映射；父子会话必须记录相同的目标环境。
- **多个子会话**：第一期只支持一主一子窗口；并行 worker 属于后续扩展，避免 Jira 写回竞态。

### 10.1 不同议题的并行执行

“一主一子”只约束同一条 `Orchestration`；同一仓库的不同 Jira 议题可以各自创建独立 worktree、分支和任务窗口并行执行。Taskboard 提供隔离和关系记录，但不自动判断文件、功能语义或运行时冲突，也不替用户排队。用户负责决定哪些编排可以并行，以及何时让主会话顺序集成结果。

并行执行仍受以下边界约束：

- 每个任务会话只能修改自己的 worktree，不能共享未提交文件。
- 结果报告必须回到各自的 `parentThreadId`；主会话分别检查，不跨任务复用结果包。
- 共享 Launcher、Codex 注入、CDP、Jira 写回等运行时若无法隔离，用户需要错峰验证或手动排队。

## 11. 分阶段落地

### P1：单子会话闭环

- 主会话绑定任务。
- Jira 读取快照和任务意图编辑/确认。
- 通过 Codex 原生 subagent 派发一个 worker。
- 任务会话回传结构化结果包。
- Taskboard 显示编排状态和子会话链接。

### P2：主会话检查与 Jira 写回

- 结果检查视图和 `approved/needs_rework/blocked` 结论。
- 主会话触发 Jira 评论、字段和状态的分步写回。
- 写回审计、幂等键和冲突提示。

### P3：可恢复协作

- 主会话/子会话断线恢复和事件游标。
- `needs_input` 追问、暂停/继续/取消、同意图重试。
- 远程项目和本地 worktree 的完整 UI 验证。

明确不在第一期：子会话直接改 Jira、自动关闭 Jira、多个 worker 并行、把整个父会话历史 fork 给子会话。

## 12. 验收标准

- 用户可以从一张 Jira 任务进入“绑定主会话 -> 确认意图 -> 派发任务会话”。
- 任务会话首次输入包含意图和必要附件引用，不要求重新读取 Jira。
- 子会话完成后，主会话能看到结构化结果包并进行通过/返工/阻塞决策。
- Jira 只由主会话在用户动作后更新，状态和字段遵循现有分步约束。
- 刷新 Taskboard、关闭并重新打开 Codex 后，主子会话关系、意图版本、结果包和写回记录仍可恢复。

## 13. Multica 借鉴与不照搬

Multica 的核心不是“同时打开多个聊天框”，而是把人和 Agent 当成一支可追踪的团队。它把持续工作的 `Issue`、一次执行的 `Task`、可复用的 `Agent`、执行环境 `Runtime` 分开建模，并把 briefing、活动时间线、工具证据和最终交付都保留下来。本设计采用以下原则：

| Multica 设计理念 | Taskboard 落地 | 取舍原因 |
| --- | --- | --- |
| Agent 是一等队友 | 任务会话有明确执行身份、状态、窗口和链接 | 用户需要知道“谁在做、在哪里做、做到哪一步” |
| Issue 与 Task 分离 | Jira 任务是业务目标；会话编排/执行轮次是一次实施 | 同一 Jira 任务可以返工、重试、重新派发，不能覆盖历史 |
| Agent 与 Runtime 分离 | Codex thread 是会话；Codex Project、worktree、机器/Host 是 Runtime | 关闭窗口、切换机器或重启 Codex 不应丢失关系 |
| 保存共同理解 | 用不可变 Jira 快照和版本化 `task-intent` 传递上下文 | 子会话不必重新读 Jira，也避免复制无关聊天噪声 |
| 审核实际工作 | 结果检查展示 diff、测试证据、预览、风险和未解决问题 | “完成”只是一种运行状态，不是质量结论 |
| 活动时间线 | 编排面板保留派发、阻塞、报告、检查、写回事件 | 让用户能回答发生了什么、为什么这样做 |
| 显式路由和交接 | 报告必须由用户点击，主会话显式要求返工或补充信息 | 保护主会话的管理权，避免子会话自动改 Jira |

不照搬 Multica 的部分：

1. Multica 的 Agent 可以直接读取并更新 Issue；Taskboard 中主会话是 Jira 的唯一读取和写回协调者，任务会话默认没有 Jira 读取/写回职责。
2. Multica 的 Issue/评论是共享协作空间；Taskboard 需要独立 Codex 窗口承载完整多轮执行，主会话只接收摘要和结构化报告。
3. Multica Squad 适合多个成员动态路由；第一期只做一主一子，先保证单任务的报告、验收和 Jira 写回没有竞态。
4. Multica 的运行时可承载多个 Agent；Taskboard 仍记录具体 Codex Host、Project、worktree 和窗口，防止跨窗口恢复时发生错配。

## 14. 统一领域模型

```text
Jira Task (业务目标)
  └── Session Orchestration (一次主会话到任务会话的编排)
        ├── Parent Thread (主会话)
        ├── Child Thread (任务会话)
        ├── Child Window (独立 Codex 窗口)
        ├── Intent Revision(s) + Jira Snapshot
        ├── Execution Evidence / Activity Timeline
        ├── Result Revision(s)
        ├── Review Decision
        └── Jira Writeback

Codex Agent Profile ── runs on ── Codex Runtime
Codex Runtime ── hosts ── Thread / Window / Worktree
```

| 对象 | 产品含义 | 是否可替代 |
| --- | --- | --- |
| `JiraTask` | Jira 的目标、状态、评论和附件的业务记录 | 不由子会话创建 |
| `Orchestration` | 一次有效的主子协作链，拥有唯一 `orchestrationId` | 同一任务可有多条历史，但同时只有一条 active |
| `AgentProfile` | 执行身份、模型、技能和权限配置 | 可在重试时复用，不能改变历史结果归属 |
| `Runtime` | Codex Project/Host、工作目录、worktree、权限和可用性 | 窗口关闭后仍存在；运行时变化需记录事件 |
| `Thread` | Codex 持久会话和 turns；主子各一条 | 是通信和恢复主键之一，不等于窗口 |
| `Window` | 用户看到的独立 Codex 窗口实例 | 可关闭、重新打开或换窗口，不能作为唯一关联键 |
| `IntentRevision` | 某一版可执行目标、范围、验收标准和来源快照 | 不可静默覆盖；变更产生新版本 |
| `ResultRevision` | 某一版执行产出、验证和风险 | 可多次报告；每版可审计、可重新检查 |
| `DeliveryMessage` | 主子之间的意图、追问、进度摘要、报告和 ack | 通过幂等键投递，可重试 |
| `ReviewDecision` | 主会话对结果的业务判断 | `approved` 才能进入写回；代码集成仍需用户单独确认 |

这里的“独立窗口”是视图边界，不是数据边界：用户可以在任务窗口连续交流；Taskboard 通过 `childThreadId` 恢复同一历史，而不是每次打开都新建会话。

## 15. 上下文交接设计

### 15.1 主会话生成任务简报

主会话读取 Jira 后先形成 `sourceSnapshot`，再生成 `IntentRevision`。快照至少包含 `issueKey`、远端版本/更新时间、状态、描述摘要、评论摘要、附件引用、关联任务和 `captureDigest`。原文可以在主会话或受限附件服务中保留，但不默认复制到任务会话。

发送给任务会话的 briefing 分为四层：

1. **目标层**：`goal`、`why`、用户希望的最终结果。
2. **边界层**：范围内、明确不做、约束、权限、执行目录和分支。
3. **验收层**：可观察的 acceptance criteria、必须运行的检查、预览或交付物。
4. **交接层**：已知事实、已做决定、待确认问题、附件引用和主会话链接。

任务会话只收到确认版 briefing。缺少关键信息或发现验收冲突时，返回 `needs_input`，不自行扩大范围、不重新解释 Jira、不写回 Jira。

任务会话的执行配置默认继承主会话的模型、推理级别、技能、权限和 Runtime。用户可以在派发前覆盖配置；派发后任何模型、权限或 Runtime 变化都必须创建新的执行配置版本并记录原因，不能静默改变。

### 15.2 执行中变更

- 主会话修改目标或范围时创建新的 `intentRevision`，显示影响范围并要求任务会话确认。
- 仅补充说明且不改变验收标准时，可作为 `instructionPatch` 进入下一轮 turn。
- 已产生结果后再改意图，旧 `ResultRevision` 标记为 `stale`，不能直接写回 Jira。
- Jira 远端 digest 与派发时不一致时，主会话必须重新读取并确认，禁止用旧快照继续派发。

### 15.3 凭据和附件边界

briefing 只传 Taskboard attachment id、受限下载引用和摘要，不传 Jira token、完整本地绝对路径或无关附件。任务会话需要额外附件时，由主会话授权一次性引用并记录审计事件。

## 16. 活动时间线和可见性

编排时间线是“共同理解”的最小记录，不把任务窗口里的每一行命令复制到主会话。事件采用单调 `sequence`、`actor`、`occurredAt`、`visibility` 和 JSON payload：

| 事件 | 主会话可见内容 | 详细证据位置 |
| --- | --- | --- |
| `snapshot_captured` | Jira 快照时间、来源附件数 | 主会话/Jira 快照 |
| `intent_confirmed` | 意图版本、目标和验收摘要 | 意图详情 |
| `child_dispatched` | 子 thread、窗口、Runtime、worktree | Codex 任务窗口 |
| `progress_summary` | 最近阶段、阻塞、预计下一步 | 任务窗口完整活动 |
| `needs_input` | 仅显示任务会话正在等待用户输入，不显示问题正文 | 任务窗口对话 |
| `result_created` | 结果版本和报告预览 | 结果包详情 |
| `result_sent/acknowledged` | 发送状态和主会话收件确认 | 消息投递记录 |
| `review_started/decision` | 检查范围、通过/返工/阻塞原因 | 主会话检查记录 |
| `jira_writeback` | 评论、字段、状态写回结果 | Jira 审计与远端响应 |

任务窗口保留完整 Codex turn、tool use、命令输出和文件 diff；主会话只显示阶段摘要、链接和需要决策的事项。这样既保留 Multica 的可追溯性，又避免主会话被执行噪声淹没。

第一期不发送操作系统级通知。`waiting_for_user`、`reported` 和 `blocked` 只通过任务窗口提示、主会话状态条和 Taskboard 编排面板可见；系统通知属于后续可选偏好设置。

## 17. 独立窗口交互规格

### 17.1 主会话窗口

主会话顶部显示 Jira 标识和“编排状态条”，包含当前意图版本、任务窗口状态、最新结果版本和待处理动作。点击状态条可打开 Taskboard 编排面板。主会话 composer 支持三个明确动作：`重新读取 Jira`、`向任务会话补充要求`、`检查最新结果`。

### 17.2 任务会话窗口

任务窗口是正常 Codex 会话，不是只读日志页：

- 顶部固定显示 `{issueKey} · 执行`、意图版本、Runtime/worktree 和主会话链接。
- 用户可以自由多轮提问、执行命令、修改文件、要求重跑验证；这些内容只写入 child thread。
- “查看任务意图”显示 briefing 原文及来源版本；“打开主会话”只跳转，不复制上下文。
- 完成动作是 `生成结果报告`，先展示可编辑的精简预览，再由用户点击 `报告主会话`；完整检查字段留在协议中，不占用默认预览空间。
- 报告发送后仍可继续交流；如又产生变更，结果版本自动变为 `draft`，必须再次报告。

### 17.3 Taskboard 编排面板

面板用一条垂直时间线连接“主会话 → 意图 → 任务窗口 → 结果 → 检查 → Jira”。每个节点显示状态、版本、最近活动和唯一下一步。不要把主会话和任务会话嵌套成两个聊天区域；聊天在 Codex 窗口内，Taskboard 负责关系、证据和动作。

## 18. 报告协议和关系维护

### 18.1 版本规则

同一编排的结果报告按 `resultRevision` 递增，报告内容不可变。用户再次报告时创建新版本，而不是修改已发送消息。主会话检查结论绑定到具体 `resultRevision`；如果意图版本或工作区 digest 变化，结论自动失效。

### 18.2 消息生命周期

```text
draft -> reporting -> sent -> acknowledged -> reviewing
                                  ├─ needs_rework -> executing
                                  ├─ blocked      -> blocked
                                  └─ approved     -> writeback_pending -> synced
```

`acknowledged` 只表示主会话已收到并通过身份校验，不表示业务验收通过。主会话必须显式创建 `ReviewDecision`，才能允许 Jira 写回。

### 18.3 身份、幂等和过期

- 身份校验：`orchestrationId + parentThreadId + childThreadId + intentVersion` 必须匹配当前 active 编排。
- 幂等：`idempotencyKey = orchestrationId:resultRevision`；重复点击或断线重试只返回已有投递结果。
- 过期：Jira 快照 digest、intent revision、worktree commit 任一不匹配时，报告标记 `stale`，只能保存或重新执行。
- ack：主会话收到后回传 `report_ack`，包含 `resultRevision`、接收时间和检查入口；没有 ack 时消息保持 `pending`，不自动判失败。
- 回溯：历史编排、意图、报告、检查和写回记录均保留，窗口删除不影响数据关系。

### 18.4 主会话操作命令

主会话只接受三种业务结果：

| 操作 | 作用 | 子会话状态 |
| --- | --- | --- |
| `通过并写回 Jira` | 固化检查结论，执行分步写回 | `approved` → `synced` |
| `要求返工` | 附带结构化反馈和验收差距 | 回到 `executing`，沿用同一 child thread |
| `标记阻塞` | 记录需要人或外部系统处理的问题 | `blocked`，等待明确恢复动作 |

## 19. 重试、阻塞和恢复

| 场景 | 默认处理 | 是否新建编排 |
| --- | --- | --- |
| Codex turn 临时失败/网络断开 | 保留 child thread 和 worktree，允许从最近安全点重试 | 否 |
| 子会话提出 `needs_input` | 主会话展示问题；用户回答后作为新 turn 发送 | 否 |
| 任务窗口关闭 | 不改变执行状态；从编排面板恢复原 child thread | 否 |
| 主会话暂时关闭 | 结果消息进入 pending；恢复后按幂等键投递 | 否 |
| Jira 在执行期间更新 | 主会话提示快照过期；用户选择刷新意图或继续旧版本 | 通常否 |
| worktree 不可恢复 | 保存失败证据；允许“按同一意图新运行”并链接旧结果 | 是，新的 execution attempt |
| 用户明确改变目标 | 创建新 intent revision；必要时新建 child thread | 可选 |

重试按钮要区分“继续同一会话”和“新运行”：前者复用 child thread/worktree，后者创建新的执行尝试，但都挂在同一 `orchestrationId` 下并保留 `attemptNo`。

## 20. 产品职责矩阵

| 能力 | 主会话 | 任务会话 | Taskboard | Jira |
| --- | --- | --- | --- | --- |
| 读取任务、评论、附件 | 发起并解释 | 默认无 | 受控代理/快照 | 数据源 |
| 提炼意图和验收 | 负责 | 可指出冲突 | 展示、版本和审计 | 不感知 |
| 修改代码/文档 | 可检查，不作为默认执行者 | 负责 | 记录证据 | 不感知 |
| 多轮执行交流 | 管理性追问 | 主要执行空间 | 提供入口和状态 | 不感知 |
| 结果报告 | 接收、检查 | 生成、发送 | 持久化、投递、去重 | 不感知 |
| Jira 评论/字段/状态 | 唯一发起者 | 禁止 | 执行 API、展示结果 | 最终写入 |
| 用户最终责任 | 设定标准、批准写回 | 直接指导执行 | 保留完整链路 | 接收已确认结果 |

## 21. API、事件和权限边界

建议以 provider-neutral API 对外暴露编排，而把 Codex app-server 适配放在 host adapter：

```text
POST   /tasks/{taskId}/orchestrations
GET    /orchestrations/{id}
POST   /orchestrations/{id}/intent/confirm
POST   /orchestrations/{id}/dispatch
POST   /orchestrations/{id}/messages
POST   /orchestrations/{id}/reports
POST   /orchestrations/{id}/review
POST   /orchestrations/{id}/jira-writeback
GET    /orchestrations/{id}/timeline?after=sequence
```

Codex adapter 负责 `thread/start`/resume/fork 的能力探测、独立窗口打开、turn/event 订阅和跨任务消息；Taskboard 负责业务身份校验、版本、幂等、审计和 Jira API。任何 child thread 发送 Jira 写回请求都必须被 adapter 拦截为 `needs_input` 或拒绝。

权限按最小范围拆分：主会话 `jira.read + orchestration.manage + jira.write.request`；任务会话 `workspace.execute + attachment.read(scoped)`；Taskboard service 才持有实际 Jira 写回凭据。窗口链接使用短期 token，不能仅凭 URL 冒充 child thread。

## 22. 指标与验收补充

首期关注以下产品指标：

- 意图确认率、从意图确认到独立窗口打开的成功率；
- 子会话重新读取 Jira 的比例（应保持低，反映 briefing 是否足够）；
- 报告发送成功率、重复报告去重率、主会话 ack 延迟；
- `needs_rework` 比例、返工后通过率、过期报告比例；
- Jira 写回失败率和重复写回次数（目标为 0）；
- 用户从主会话打开任务窗口、从任务窗口返回主会话的跳转成功率。

除第 12 节验收标准外，必须满足：

1. 关闭任一窗口并重新打开后，仍能进入同一 thread、看到同一意图和未发送/已发送报告版本。
2. 重复点击“报告主会话”不会生成重复主会话消息，也不会触发 Jira 写回。
3. 主会话收到报告但未检查时，界面明确显示“已收到，待检查”，不能显示“已完成”。
4. `needs_rework` 后，任务会话仍能在独立窗口继续多轮执行，旧报告和返工差异可比较。
5. Jira 写回失败时，保留结果检查结论和远端错误，可安全重试，不要求子会话重新执行。
