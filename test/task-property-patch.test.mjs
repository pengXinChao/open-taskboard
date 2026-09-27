import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import { transformWithOxc } from "vite";
import { ApiError } from "../shared/api-fields.mjs";
import { parseTaskPatch } from "../shared/task-input.mjs";
import { createJiraIntegration } from "../server/jira-integration.mjs";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex);
  return source.slice(startIndex, endIndex);
}

// 运行真实属性更新、请求序列化和 Jira 校验逻辑；只替换网络与 UI 状态，不接触用户任务。
const { code } = await transformWithOxc([
  between(appSource, "function taskToDraft(", "interface LocalRealtimeSyncProps"),
  between(appSource, "  async function updateTaskProperties(", "  async function persistProjectLabel("),
  between(apiSource, "export async function updateTask(", "export async function moveTask(")
    .replace("export async function updateTask(", "async function updateTaskRequest("),
].join("\n"), "task-property-patch.ts");

for (const changes of [{ status: "in_progress" }, { title: "Updated title" }]) {
  test(`Jira detail ${Object.keys(changes)[0]} update sends only changed fields`, async () => {
    const originId = createHash("sha256").update("patch-fixture").digest("hex");
    const task = {
      id: "fixture-1", version: 3, title: "Original title", description: "Original description\n \n  ",
      status: "todo", priority: "medium", labels: [], developmentContext: null,
      startDate: null, dueDate: null, recurrence: null,
      externalOrigin: originId, externalKey: "FIXTURE-1", assignee: null, participants: [],
    };
    const jiraWrites = [];
    const jira = createJiraIntegration({
      configStore: { read: async () => ({
        baseUrl: "https://example.invalid", username: "fixture", password: "fixture", originId,
      }) },
      database: {},
      fetch: async (url, init = {}) => {
        const pathname = new URL(url).pathname;
        if (pathname.endsWith("/manifest")) return Response.json({ id: "patch-fixture" });
        if (pathname.endsWith("/transitions") && !init.method) {
          return Response.json({ transitions: [{
            id: "21", to: { name: "In Progress", statusCategory: { key: "indeterminate" } },
          }] });
        }
        if (init.method === "POST" || init.method === "PUT") {
          jiraWrites.push({ method: init.method, body: JSON.parse(init.body) });
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected fixture request: ${pathname}`);
      },
    });
    const requests = [];
    let tasks = [task];
    const sandbox = {
      ApiError, currentUser: {}, taskScopeProjectId: "jira",
      assigneeTargetForActor: () => null,
      setActionError() {},
      setTasks: (update) => { tasks = update(tasks); },
      sortTasks: (current) => current,
      pushUndo() {}, refreshTasks() {},
      errorMessage: (error) => error.message,
      text: (zh) => zh,
      request: async (url, options) => {
        const body = JSON.parse(options.body);
        requests.push({ url, method: options.method, body });
        const patch = parseTaskPatch(body, (value) => value);
        await jira.updateTask(task, patch.changes);
        return { task: { ...task, ...patch.changes, version: task.version + 1 } };
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    const updated = await sandbox.updateTaskProperties(task, changes);

    assert.deepEqual(requests, [{
      url: "/api/tasks/fixture-1", method: "PATCH", body: { version: task.version, ...changes },
    }]);
    assert.equal(updated.description, task.description);
    assert.equal(tasks[0].description, task.description);
    assert.equal(updated.version, task.version + 1);
    if (changes.status) {
      assert.equal(updated.status, "in_progress");
      assert.deepEqual(jiraWrites, [{ method: "POST", body: { transition: { id: "21" } } }]);
    } else {
      assert.equal(updated.title, changes.title);
      assert.deepEqual(jiraWrites, [{ method: "PUT", body: { fields: { summary: changes.title } } }]);
    }
  });
}
