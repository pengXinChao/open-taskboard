import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const boardColumnSource = await readFile(new URL("../web/src/components/BoardColumn.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");
const orchestrationPanelSource = await readFile(
  new URL("../web/src/components/TaskSessionOrchestrationPanel.tsx", import.meta.url),
  "utf8",
);
const editorSource = await readFile(new URL("../web/src/components/TaskEditor.tsx", import.meta.url), "utf8");
const labelPickerSource = await readFile(new URL("../web/src/components/LabelPicker.tsx", import.meta.url), "utf8");
const contextMenuSource = await readFile(new URL("../web/src/components/TaskContextMenu.tsx", import.meta.url), "utf8");
const cardSource = await readFile(new URL("../web/src/components/TaskCard.tsx", import.meta.url), "utf8");
const filterSource = await readFile(new URL("../web/src/taskFilters.ts", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");
const composerSource = await readFile(new URL("../web/src/components/InlineMediaComposer.tsx", import.meta.url), "utf8");
const cliSource = await readFile(new URL("../cli/taskctl.mjs", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../server/app.mjs", import.meta.url), "utf8");

test("Jira issues open a projectless main session with a read-only orchestration panel", () => {
  assert.match(detailSource, /TaskSessionOrchestrationPanel/);
  assert.match(detailSource, /orchestrationRevision=\{orchestrationRevision\}/);
  assert.match(orchestrationPanelSource, /getTaskSessionForTask/);
  assert.match(orchestrationPanelSource, /onOpenThread/);
  assert.match(orchestrationPanelSource, /task-session-row/);
  assert.match(orchestrationPanelSource, /waiting_for_user/);
  assert.match(orchestrationPanelSource, /阻塞/);
  assert.doesNotMatch(orchestrationPanelSource, /保存意图|确认意图|派发|报告|集成/);
  assert.doesNotMatch(detailSource, /onCreateParentTaskSession|onDispatchTaskSession/);
  assert.match(appSource, /taskboardProject\?\.source === "jira"/);
  assert.match(appSource, /jiraEntry[\s\S]*conversationRole = session\?\.conversationRole[\s\S]*?jiraEntry \? "parent"/);
  assert.match(appSource, /const projectless = conversationRole === "parent" \|\| jiraEntry/);
  assert.doesNotMatch(detailSource, /在新对话打开/);
  assert.doesNotMatch(detailSource, /onOpenInThread\(currentTask\)/);
  assert.doesNotMatch(appSource, /detail-thread-button/);
  assert.doesNotMatch(detailSource, /输入对话 ID|解除 Codex 对话绑定|>绑定</);
  assert.doesNotMatch(editorSource, /对话 ID|linkedThreadId/);
  assert.match(detailSource, /currentTask\.threadBinding \|\| currentTask\.legacyLocalThreadId/);
  assert.doesNotMatch(detailSource, /currentTask\.threadIds/);
  assert.match(detailSource, /<strong>\{text\("查看对话", "View conversation"\)\}<\/strong>/);
  assert.doesNotMatch(detailSource, /className="conversation-thread-id">\{threadId\}/);
  assert.doesNotMatch(detailSource, /shortThreadId/);
  assert.doesNotMatch(detailSource, /detail-property-label">Codex/);
  assert.match(detailSource, /comment\.threadBinding \|\| comment\.legacyLocalThreadId/);
  assert.match(detailSource, /onOpenLegacyLocalThread\(comment\.legacyLocalThreadId!\)/);
  assert.doesNotMatch(detailSource, /compact/);
  assert.doesNotMatch(styles, /issue-conversation-link\.compact/);
  assert.match(detailSource, /\.\.\.developmentOptions\.map\(\(context\) => \(\{/);
  assert.match(detailSource, /context\.type === "branch"[\s\S]*?<BranchIcon[\s\S]*?<LinearIcon name="folder"/);
  assert.match(detailSource, /developmentContext/);
  assert.doesNotMatch(detailSource, /placeholder="绑定分支/);
  assert.doesNotMatch(contextMenuSource, /打开关联 Codex 对话/);
  assert.match(contextMenuSource, /onOpenInThread/);
});

test("main sessions can create and message a worker through the local bridge", () => {
  assert.match(appSource, /task-session-orchestration/);
  assert.match(appSource, /分析需求，确认执行范围，并协调任务会话完成实现/);
  assert.match(appSource, /执行主会话下发的已确认执行项，并提交结果/);
  assert.doesNotMatch(appSource, /请先使用.*读取完整 Jira 上下文/);
  assert.match(cliSource, /\["session create-child"/);
  assert.match(cliSource, /\["session report"/);
  assert.match(cliSource, /\/child-session/);
  assert.match(serverSource, /\/api\/session\/context/);
  assert.match(serverSource, /createTaskSessionChild/);
  assert.match(serverSource, /options\.createChildSession/);
  assert.match(serverSource, /analysis: input\.analysis/);
  assert.match(serverSource, /attachmentRefs: input\.attachmentRefs/);
  assert.match(serverSource, /analysis_forwarded/);
  assert.match(appSource, /projectless/);
});

test("orchestration realtime events refresh only the open issue panel", () => {
  assert.match(appSource, /"orchestration\.updated"/);
  assert.match(appSource, /"orchestration\.message"/);
  assert.match(appSource, /const eventTaskId = payload\.taskId \?\? payload\.orchestration\?\.taskId/);
  assert.match(appSource, /orchestration: detailTaskId === eventTaskId/);
  assert.match(appSource, /if \(refreshOrchestrationPending && selectionRef.current.detailTaskId\)/);
  assert.match(appSource, /orchestrationRevision=\{orchestrationRevision\}/);
  assert.match(orchestrationPanelSource, /orchestrationRevision/);
});
