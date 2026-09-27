import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import { transformWithOxc } from "vite";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");

function functionSource(start, end) {
  const startIndex = appSource.indexOf(start);
  const endIndex = appSource.indexOf(end, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex);
  return appSource.slice(startIndex, endIndex);
}

// 执行实际的启动函数，仅隔离 API 和宿主消息，避免验证时修改真实任务或打开真实会话。
const { code } = await transformWithOxc([
  functionSource("  function startTaskLaunch(", "  function openTaskDetail("),
  functionSource("  async function openTaskInThread(", "  function changeProject("),
].join("\n"), "task-launch.ts");

for (const selectedName of ["B", "A"]) {
  test(`launching from project A preserves the selected workspace ${selectedName}`, async () => {
    const workspace = {
      id: `project-${selectedName}`,
      name: selectedName,
      workspacePath: `/workspace/${selectedName}`,
      projectKind: "local",
      hostId: "local",
    };
    const task = {
      id: "task-1", projectId: "jira", source: "jira", title: "Launch issue",
      identifier: "EXAMPLE-1", externalUrl: "https://example.invalid/EXAMPLE-1",
      developmentContext: null,
    };
    const context = { type: "worktree", path: workspace.workspacePath, branch: null };
    const messages = [];
    const updates = [];
    const sandbox = {
      embedded: true,
      window: { parent: {} },
      GLOBAL_PROJECT_ID: "global",
      projects: [{ id: "jira", workspacePath: "/workspace/A" }],
      projectCodexIdentities: {},
      codexProjectContextForTaskProject: () => ({
        codexProjectId: "project-A", codexProjectKind: "local",
        codexHostId: "local", workspacePath: "/workspace/A",
      }),
      deviceWorkspacePaths: {},
      hostContext: { threadId: "thread-A" },
      text: (zh) => zh,
      openingThreadTaskId: null,
      setLaunchTaskId() {},
      setActionError(error) { assert.equal(error, null); },
      errorMessage: (error) => error.message,
      setOpeningThreadTaskId() {},
      setPendingThreadBindingTaskId() {},
      updateTaskProperties: async (current, changes) => {
        updates.push(changes);
        return { ...current, ...changes };
      },
      listDevelopmentContexts: async () => ({
        workspacePath: "/workspace/A",
        contexts: [{ type: "worktree", path: "/workspace/A", branch: "main" }],
      }),
      postEmbeddedHostMessage: (message) => messages.push(message),
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    sandbox.startTaskLaunch(task, context, workspace);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(updates.length, 1);
    assert.equal(updates[0].developmentContext, context);
    assert.equal(messages.length, 1);
    const { type, payload } = messages[0];
    assert.equal(type, "taskboard:create-thread");
    assert.equal(payload.codexProjectId, workspace.id);
    assert.equal(payload.workspacePath, workspace.workspacePath);
    assert.equal(payload.codexProjectWorkspacePath, workspace.workspacePath);
    assert.equal(payload.codexProjectKind, workspace.projectKind);
    assert.equal(payload.codexHostId, workspace.hostId);
    assert.equal(payload.taskId, task.id);
    assert.equal(payload.projectless, false);
  });
}
