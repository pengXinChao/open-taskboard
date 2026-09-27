import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTaskboardServer } from "../server/app.mjs";

// 只替换远端 Jira；本地 HTTP 路由、SQLite 与同步调度均使用实际实现。
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jira-comments-"));
  const remote = [1, 2].map((id) => ({
    id: String(id), body: `远程评论 ${id}\n第二行`,
    author: { key: "reader", displayName: "Jira Reader" },
    created: `2026-09-27T00:00:0${id}.000Z`, updated: `2026-09-27T00:00:0${id}.000Z`,
  }));
  const calls = [];
  let failure = null;
  const app = createTaskboardServer({
    dataDirectory: directory,
    jiraFetch: async (url, init = {}) => {
      const target = new URL(url);
      const method = init.method ?? "GET";
      calls.push({ path: target.pathname, method, body: init.body });
      let body;
      if (target.pathname.endsWith("/manifest")) body = { id: "comment-test-instance" };
      else if (target.pathname.endsWith("/myself")) body = { displayName: "Jira Reader" };
      else if (target.pathname.endsWith("/search")) body = {
        total: 1, issues: [{ id: "10001", key: "DEMO-1", fields: {
          summary: "评论同步演示", description: "隔离数据", status: { id: "1", statusCategory: { key: "new" } },
        } }],
      };
      else if (target.pathname.endsWith("/comment")) {
        if (failure === "network" && method === "POST") throw new TypeError("Connection closed");
        if (failure === "denied" && method === "POST") return Response.json({}, { status: 403 });
        if (failure === "pull" && method === "GET") return Response.json({}, { status: 503 });
        if (method === "POST") {
          body = { ...remote[0], id: String(remote.length + 1), body: JSON.parse(init.body).body };
          remote.push(body);
        } else {
          const startAt = Number(target.searchParams.get("startAt") ?? 0);
          // 模拟远端自行限制每页大小，确认不是只读取第一页。
          body = { startAt, maxResults: 1, total: remote.length, comments: remote.slice(startAt, startAt + 1) };
        }
      } else throw new Error(`Unexpected Jira request: ${url}`);
      return Response.json(body);
    },
  });
  const address = await app.listen({ port: 0 });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function request(route, body, method = body === undefined ? "GET" : "POST", headers = {}) {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
      method, headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }
  const connection = await request("/api/local/jira-connection", {
    baseUrl: "https://jira.example.test", username: "reader", password: "test-password", projects: [],
  }, "PUT");
  assert.equal(connection.status, 200, JSON.stringify(connection.body));
  const tasks = await request("/api/tasks");
  const task = tasks.body.tasks[0];
  return { directory, request, task, remote, calls, fail(value) { failure = value; } };
}

test("Jira 评论分页拉取、用户发布及远端更新形成同一条本地记录，CLI 保持本地", async (t) => {
  const { request, task, remote, calls } = await fixture(t);
  const route = `/api/tasks/${encodeURIComponent(task.id)}/comments`;
  const initial = await request(route);
  assert.equal(initial.body.comments.length, 2);
  assert.equal(initial.body.comments[0].body, remote[0].body);
  assert.equal(initial.body.comments[0].authorName, "Jira Reader");
  assert.equal(initial.body.comments[0].jira.remoteId, "1");
  const cursor = initial.body.nextCursor;
  const local = await request(route, { body: "Agent 内部记录" }, "POST", { "x-taskboard-client": "taskctl" });
  assert.equal(local.status, 201);
  assert.equal(local.body.comment.jira, null);
  const published = await request(route, { body: "界面发布\n正文", publishToJira: true });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  assert.equal(published.body.comment.jira.remoteId, "3");
  assert.equal(published.body.comment.authorName, "Jira Reader");
  remote[2].body = "远端已编辑";
  remote[2].updated = "2026-09-27T01:00:00.000Z";
  assert.equal((await request("/api/local/jira-connection/sync", undefined, "POST")).status, 200);
  const comments = (await request(route)).body.comments;
  assert.equal(comments.length, 4);
  const updated = comments.find((comment) => comment.id === published.body.comment.id);
  assert.equal(updated.body, "远端已编辑");
  assert.equal(updated.version, 2);
  const delta = (await request(`${route}?after=${encodeURIComponent(cursor)}`)).body.comments;
  assert.ok(delta.some((comment) => comment.id === updated.id));
  assert.equal(calls.filter((call) => call.method === "POST" && call.path.endsWith("/comment")).length, 1);
  assert.equal((await request(`/api/comments/${updated.id}`, { body: "不应写入", version: updated.version }, "PATCH")).status, 409);
  assert.equal((await request(`/api/comments/${updated.id}`, { version: updated.version }, "DELETE")).status, 409);
  assert.equal((await request(`/api/comments/${updated.id}/attachments`, {})).status, 409);
  assert.equal((await request(`/api/comments/${local.body.comment.id}`, { body: "本地编辑", version: 1 }, "PATCH")).status, 200);
});

test("Jira 评论发布失败不保存成功记录，超时不自动重发，拉取失败保留已有评论", async (t) => {
  const { request, task, fail, calls } = await fixture(t);
  const route = `/api/tasks/${encodeURIComponent(task.id)}/comments`;
  fail("denied");
  assert.notEqual((await request(route, { body: "发布拒绝", publishToJira: true })).status, 201);
  fail("network");
  const uncertain = await request(route, { body: "结果未知", publishToJira: true });
  assert.equal(uncertain.body.error.code, "JIRA_COMMENT_RESULT_UNKNOWN");
  assert.equal((await request(route)).body.comments.length, 2);
  assert.equal(calls.filter((call) => call.method === "POST" && call.path.endsWith("/comment")).length, 2);
  fail("pull");
  assert.notEqual((await request("/api/local/jira-connection/sync", undefined, "POST")).status, 200);
  assert.equal((await request(route)).body.comments.length, 2);
});


test("远端已发布但本地保存失败时，通过拉取补齐而不是重发", async (t) => {
  const { directory, request, task, remote, calls } = await fixture(t);
  const database = new DatabaseSync(path.join(directory, "taskboard.sqlite"));
  try {
    // 模拟本地写入故障，不改变 Jira 创建请求的成功结果。
    database.exec(`CREATE TRIGGER fail_comment_save BEFORE INSERT ON comments
      WHEN NEW.jira_comment_id = '3' BEGIN SELECT RAISE(ABORT, 'local write failed'); END`);
    const route = `/api/tasks/${encodeURIComponent(task.id)}/comments`;
    const result = await request(route, { body: "远端成功、本地失败", publishToJira: true });
    assert.equal(result.body.error.code, "JIRA_COMMENT_LOCAL_SAVE_FAILED");
    assert.equal(remote.length, 3);
    assert.equal((await request(route)).body.comments.length, 2);
    database.exec("DROP TRIGGER fail_comment_save");
    assert.equal((await request("/api/local/jira-connection/sync", undefined, "POST")).status, 200);
    assert.equal((await request(route)).body.comments.length, 3);
    assert.equal(calls.filter((call) => call.method === "POST" && call.path.endsWith("/comment")).length, 1);
  } finally {
    database.close();
  }
});

test("发布评论不外发本地附件的相对或绝对地址", async (t) => {
  const { request, task, calls } = await fixture(t);
  const route = `/api/tasks/${encodeURIComponent(task.id)}/comments`;
  for (const url of ["api/attachments/example/content", "/api/attachments/example/content"]) {
    const result = await request(route, { body: `[本地文件](${url})`, publishToJira: true });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "JIRA_COMMENT_ATTACHMENT_UNSUPPORTED");
  }
  assert.equal(calls.filter((call) => call.method === "POST" && call.path.endsWith("/comment")).length, 0);
});
