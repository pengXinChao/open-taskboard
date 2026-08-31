import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

const actor = {
  type: "user",
  id: "orchestration-tester",
  name: "Orchestration Tester",
  avatarUrl: null,
};

function binding(threadId, workspacePath = `/tmp/${threadId}`) {
  return {
    threadId,
    codexProjectId: "orchestration-project",
    codexProjectKind: "local",
    codexHostId: "local",
    workspacePath,
  };
}

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-orchestration-test-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  database.createProject({
    id: "orchestration-project",
    name: "Orchestration Project",
    workspacePath: "/tmp/orchestration-project",
  });
  return {
    database,
    async createTask(overrides = {}) {
      return database.createTask({
        projectId: "orchestration-project",
        title: "Orchestration task",
        description: "Task description",
        status: "todo",
        priority: "none",
        labels: [],
        threadId: null,
        actor,
        assignee: actor,
        developmentContext: null,
        startDate: null,
        dueDate: null,
        recurrence: null,
        ...overrides,
      });
    },
    async close() {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function createOrchestration(database, task, intent = { goal: "Implement the task", why: "Needed", acceptanceCriteria: ["Works"] }) {
  return database.createTaskSessionOrchestration(task.id, {
    parentThreadBinding: binding("parent-thread"),
    intent,
  });
}

function dispatch(database, orchestration) {
  return database.dispatchTaskSessionOrchestration(orchestration.id, {
    parentThreadId: "parent-thread",
    intentVersion: orchestration.intentVersion,
    childThreadBinding: binding("child-thread", "/tmp/child-worktree"),
  });
}

function approveResult(database, orchestration) {
  orchestration = database.confirmTaskSessionIntent(orchestration.id, {
    parentThreadId: "parent-thread",
    intentVersion: orchestration.intentVersion,
    captureDigest: orchestration.intentDigest,
  });
  const dispatched = dispatch(database, orchestration);
  database.createTaskSessionReport(dispatched.id, {
    parentThreadId: "parent-thread",
    childThreadId: "child-thread",
    intentVersion: dispatched.intentVersion,
    resultRevision: 1,
    idempotencyKey: `${dispatched.id}:1`,
    payload: { summary: "Implemented", rationale: "Required change" },
  });
  database.acknowledgeTaskSessionReport(dispatched.id, 1, { parentThreadId: "parent-thread" });
  return database.saveTaskSessionReview(dispatched.id, {
    parentThreadId: "parent-thread",
    decision: "approved",
    resultRevision: 1,
  }).orchestration;
}

test("intent revisions are limited to the draft phase and clear prior confirmation", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    let orchestration = createOrchestration(fixture.database, task);
    orchestration = fixture.database.confirmTaskSessionIntent(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: 1,
      captureDigest: orchestration.intentDigest,
    });

    orchestration = fixture.database.saveTaskSessionIntent(orchestration.id, {
      parentThreadId: "parent-thread",
      intent: { goal: "Updated goal" },
      revision: 2,
    });
    assert.equal(orchestration.state, "intent_draft");
    assert.equal(orchestration.intentVersion, 2);
    assert.equal(orchestration.confirmedIntentVersion, null);
    assert.equal(orchestration.confirmedAt, null);

    orchestration = fixture.database.confirmTaskSessionIntent(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: 2,
      captureDigest: orchestration.intentDigest,
    });
    orchestration = dispatch(fixture.database, orchestration);
    assert.throws(
      () => fixture.database.saveTaskSessionIntent(orchestration.id, {
        parentThreadId: "parent-thread",
        intent: { goal: "Too late" },
      }),
      (error) => error?.code === "INVALID_STATE_TRANSITION",
    );
  } finally {
    await fixture.close();
  }
});

test("integration conflicts can recover and completion requires confirmed writeback plus integration", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    const approved = approveResult(fixture.database, createOrchestration(fixture.database, task));
    let integration = fixture.database.saveTaskSessionIntegration(approved.id, {
      parentThreadId: "parent-thread",
      conflict: true,
    });
    assert.equal(integration.orchestration.state, "blocked");

    integration = fixture.database.saveTaskSessionIntegration(approved.id, {
      parentThreadId: "parent-thread",
      conflict: false,
    });
    assert.equal(integration.orchestration.state, "integrated");
    assert.throws(
      () => fixture.database.completeTaskSessionOrchestration(approved.id, {
        parentThreadId: "parent-thread",
        confirmed: true,
      }),
      (error) => error?.code === "WRITEBACK_NOT_CONFIRMED",
    );

    const writeback = fixture.database.saveTaskSessionWriteback(approved.id, {
      parentThreadId: "parent-thread",
      confirmed: true,
    });
    assert.equal(writeback.orchestration.state, "integrated");
    const completed = fixture.database.completeTaskSessionOrchestration(approved.id, {
      parentThreadId: "parent-thread",
      confirmed: true,
    });
    assert.equal(completed.orchestration.state, "done");
    assert.throws(
      () => fixture.database.completeTaskSessionOrchestration(approved.id, {
        parentThreadId: "other-parent-thread",
        confirmed: true,
      }),
      (error) => error?.code === "PARENT_THREAD_MISMATCH",
    );
    const duplicate = fixture.database.completeTaskSessionOrchestration(approved.id, {
      parentThreadId: "parent-thread",
      confirmed: true,
    });
    assert.equal(duplicate.duplicate, true);
  } finally {
    await fixture.close();
  }
});

test("completion rejects a source change after integration and writeback confirmation", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    const approved = approveResult(fixture.database, createOrchestration(fixture.database, task));
    const integrated = fixture.database.saveTaskSessionIntegration(approved.id, {
      parentThreadId: "parent-thread",
      conflict: false,
    });
    fixture.database.saveTaskSessionWriteback(integrated.orchestration.id, {
      parentThreadId: "parent-thread",
      confirmed: true,
    });

    const changedTask = fixture.database.getTask(task.id);
    fixture.database.updateTask(
      task.id,
      changedTask.version,
      { title: "Changed before completion" },
      undefined,
      undefined,
      actor,
    );

    assert.throws(
      () => fixture.database.completeTaskSessionOrchestration(approved.id, {
        parentThreadId: "parent-thread",
        confirmed: true,
      }),
      (error) => error?.code === "INTENT_STALE",
    );
    assert.equal(fixture.database.getTaskSessionOrchestration(approved.id).state, "integrated");
  } finally {
    await fixture.close();
  }
});

test("open intent questions cannot be bypassed during confirmation", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    const orchestration = createOrchestration(fixture.database, task, {
      goal: "Implement the task",
      why: "Needed",
      acceptanceCriteria: ["Works"],
      openQuestions: ["Which API should be used?"],
    });
    assert.throws(
      () => fixture.database.confirmTaskSessionIntent(orchestration.id, {
        parentThreadId: "parent-thread",
        intentVersion: orchestration.intentVersion,
        captureDigest: orchestration.intentDigest,
        allowOpenQuestions: true,
      }),
      (error) => error?.code === "INTENT_OPEN_QUESTIONS",
    );
    assert.equal(
      fixture.database.getTaskSessionOrchestration(orchestration.id).state,
      "intent_draft",
    );
  } finally {
    await fixture.close();
  }
});

test("a child thread cannot be bound to two active orchestrations", async () => {
  const fixture = await createFixture();
  try {
    const firstTask = await fixture.createTask();
    const secondTask = await fixture.createTask({ title: "Second orchestration task" });
    const first = fixture.database.confirmTaskSessionIntent(
      createOrchestration(fixture.database, firstTask).id,
      { parentThreadId: "parent-thread", intentVersion: 1 },
    );
    const firstDispatched = dispatch(fixture.database, first);
    let second = fixture.database.createTaskSessionOrchestration(secondTask.id, {
      parentThreadBinding: binding("parent-thread-2"),
      intent: { goal: "Implement the task", why: "Needed", acceptanceCriteria: ["Works"] },
    });
    second = fixture.database.confirmTaskSessionIntent(second.id, {
      parentThreadId: "parent-thread-2",
      intentVersion: second.intentVersion,
      captureDigest: second.intentDigest,
    });
    assert.throws(
      () => fixture.database.dispatchTaskSessionOrchestration(second.id, {
        parentThreadId: "parent-thread-2",
        intentVersion: second.intentVersion,
        childThreadBinding: binding(firstDispatched.childThreadBinding.threadId, "/tmp/other-worktree"),
      }),
      (error) => error?.code === "CHILD_THREAD_ALREADY_BOUND",
    );
  } finally {
    await fixture.close();
  }
});

test("public messages require the current intent and lifecycle actor identity", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    let orchestration = createOrchestration(fixture.database, task);
    orchestration = fixture.database.confirmTaskSessionIntent(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: orchestration.intentVersion,
      captureDigest: orchestration.intentDigest,
    });
    orchestration = dispatch(fixture.database, orchestration);

    assert.throws(
      () => fixture.database.appendTaskSessionMessage(orchestration.id, {
        direction: "parent_to_child",
        parentThreadId: "parent-thread",
        payload: { note: "stale" },
      }),
      (error) => error?.code === "INTENT_VERSION_CONFLICT",
    );
    assert.throws(
      () => fixture.database.appendTaskSessionMessage(orchestration.id, {
        direction: "internal",
        state: "waiting_for_user",
        payload: { state: "waiting_for_user" },
      }),
      (error) => error?.code === "INTERNAL_ACTOR_REQUIRED",
    );

    const message = fixture.database.appendTaskSessionMessage(orchestration.id, {
      direction: "internal",
      state: "waiting_for_user",
      childThreadId: "child-thread",
      intentVersion: orchestration.intentVersion,
      payload: { state: "waiting_for_user" },
    });
    assert.equal(message.direction, "internal");
    assert.equal(fixture.database.getTaskSessionOrchestration(orchestration.id).state, "waiting_for_user");
  } finally {
    await fixture.close();
  }
});

test("legacy source digests remain valid after local orchestration status changes", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    let orchestration = createOrchestration(fixture.database, task);
    const legacyProjection = { ...orchestration.sourceSnapshot, fetchedAt: null };
    const legacyDigest = createHash("sha256")
      .update(JSON.stringify(legacyProjection))
      .digest("hex");
    fixture.database.database.prepare(
      "UPDATE task_session_orchestrations SET intent_digest = ? WHERE id = ?",
    ).run(legacyDigest, orchestration.id);
    orchestration = fixture.database.getTaskSessionOrchestration(orchestration.id);
    orchestration = fixture.database.confirmTaskSessionIntent(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: 1,
      captureDigest: legacyDigest,
    });

    orchestration = dispatch(fixture.database, orchestration);
    fixture.database.createTaskSessionReport(orchestration.id, {
      parentThreadId: "parent-thread",
      childThreadId: "child-thread",
      intentVersion: 1,
      resultRevision: 1,
      idempotencyKey: `${orchestration.id}:1`,
      payload: { summary: "Legacy digest still valid", rationale: "Compatibility" },
    });
    fixture.database.acknowledgeTaskSessionReport(orchestration.id, 1, { parentThreadId: "parent-thread" });
    const review = fixture.database.saveTaskSessionReview(orchestration.id, {
      parentThreadId: "parent-thread",
      decision: "approved",
      resultRevision: 1,
    });
    assert.equal(review.orchestration.state, "writeback_pending");

    const changedTask = fixture.database.getTask(task.id);
    fixture.database.updateTask(
      task.id,
      changedTask.version,
      { title: "Changed after capture" },
      undefined,
      undefined,
      actor,
    );
    assert.throws(
      () => fixture.database.saveTaskSessionWriteback(orchestration.id, {
        parentThreadId: "parent-thread",
        confirmed: true,
      }),
      (error) => error?.code === "INTENT_STALE",
    );
  } finally {
    await fixture.close();
  }
});

test("orchestration-driven Jira status changes retain local override until remote status changes", async () => {
  const fixture = await createFixture();
  try {
    const issue = {
      id: "jira-orchestration-1",
      identifier: "JIRA:ORCHESTRATION:jira-orchestration-1",
      title: "Jira orchestration task",
      description: "Jira task",
      status: "todo",
      priority: "none",
      labels: [],
      sortOrder: 1,
      creator: actor,
      assignee: actor,
      dueDate: null,
      externalOrigin: "jira-orchestration-origin",
      externalId: "jira-orchestration-1",
      externalKey: "ORCH-1",
      externalUrl: "https://jira.example.test/browse/ORCH-1",
      externalStatusId: "100",
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    };
    fixture.database.syncJiraTasks([issue], { projectName: "Jira" });
    const task = fixture.database.getTask(issue.id);
    let orchestration = createOrchestration(fixture.database, task);
    orchestration = fixture.database.confirmTaskSessionIntent(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: 1,
      captureDigest: orchestration.intentDigest,
    });
    dispatch(fixture.database, orchestration);
    assert.equal(fixture.database.getTask(task.id).status, "in_progress");
    assert.equal(fixture.database.getTask(task.id).jiraStatusOverride, true);

    fixture.database.syncJiraTasks([issue], { projectName: "Jira" });
    assert.equal(fixture.database.getTask(task.id).status, "in_progress");
    assert.equal(fixture.database.getTask(task.id).jiraStatusOverride, true);

    fixture.database.syncJiraTasks([{ ...issue, status: "todo", externalStatusId: "200" }], {
      projectName: "Jira",
    });
    assert.equal(fixture.database.getTask(task.id).status, "todo");
    assert.equal(fixture.database.getTask(task.id).jiraStatusOverride, false);
  } finally {
    await fixture.close();
  }
});

test("Jira sync maps targetless todo to backlog in newer databases", async () => {
  const fixture = await createFixture();
  try {
    fixture.database.database.exec(`
      ALTER TABLE tasks ADD COLUMN execution_target TEXT;
      CREATE TRIGGER tasks_todo_execution_target_update
      BEFORE UPDATE OF status, execution_target ON tasks
      WHEN NEW.status = 'todo' AND NEW.execution_target IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'todo requires an execution target');
      END;
      CREATE TRIGGER tasks_todo_execution_target_insert
      BEFORE INSERT ON tasks
      WHEN NEW.status = 'todo' AND NEW.execution_target IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'todo requires an execution target');
      END;
    `);
    const issue = {
      id: "jira-targetless-todo",
      identifier: "JIRA:ORCHESTRATION:jira-targetless-todo",
      title: "Jira targetless todo",
      description: "Jira task",
      status: "todo",
      priority: "none",
      labels: [],
      sortOrder: 1,
      creator: actor,
      assignee: actor,
      dueDate: null,
      externalOrigin: "jira-orchestration-origin",
      externalId: "jira-targetless-todo",
      externalKey: "ORCH-2",
      externalUrl: "https://jira.example.test/browse/ORCH-2",
      externalStatusId: "100",
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    };

    fixture.database.syncJiraTasks([issue], { projectName: "Jira" });
    assert.equal(fixture.database.getTask(issue.id).status, "backlog");
  } finally {
    await fixture.close();
  }
});

test("reports require an explicit result revision and preserve idempotency", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    let orchestration = createOrchestration(fixture.database, task);
    orchestration = fixture.database.confirmTaskSessionIntent(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: orchestration.intentVersion,
      captureDigest: orchestration.intentDigest,
    });
    orchestration = fixture.database.dispatchTaskSessionOrchestration(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: orchestration.intentVersion,
      childThreadBinding: binding("child-thread", "/tmp/child-worktree"),
    });

    assert.throws(
      () => fixture.database.createTaskSessionReport(orchestration.id, {
        parentThreadId: "parent-thread",
        childThreadId: "child-thread",
        intentVersion: orchestration.intentVersion,
        idempotencyKey: `${orchestration.id}:1`,
        payload: { summary: "Missing revision" },
      }),
      (error) => error?.code === "INVALID_FIELD",
    );
    assert.equal(fixture.database.getTaskSessionOrchestration(orchestration.id).currentResultRevision, 0);

    const first = fixture.database.createTaskSessionReport(orchestration.id, {
      parentThreadId: "parent-thread",
      childThreadId: "child-thread",
      intentVersion: orchestration.intentVersion,
      resultRevision: 1,
      idempotencyKey: `${orchestration.id}:1`,
      payload: { summary: "Implemented", rationale: "Required change" },
    });
    const duplicate = fixture.database.createTaskSessionReport(orchestration.id, {
      parentThreadId: "parent-thread",
      childThreadId: "child-thread",
      intentVersion: orchestration.intentVersion,
      resultRevision: 1,
      idempotencyKey: `${orchestration.id}:1`,
      payload: { summary: "Implemented", rationale: "Required change" },
    });
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.throws(
      () => fixture.database.createTaskSessionReport(orchestration.id, {
        parentThreadId: "parent-thread",
        childThreadId: "child-thread",
        intentVersion: orchestration.intentVersion,
        resultRevision: 1,
        idempotencyKey: `${orchestration.id}:1`,
        payload: { summary: "Implemented" },
      }),
      (error) => error?.code === "IDEMPOTENCY_CONFLICT",
    );
    assert.equal(fixture.database.getTaskSessionOrchestration(orchestration.id).currentResultRevision, 1);
  } finally {
    await fixture.close();
  }
});

test("integration is rejected when the Jira source changes after review", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    const approved = approveResult(fixture.database, createOrchestration(fixture.database, task));
    const changedTask = fixture.database.getTask(task.id);
    fixture.database.updateTask(
      task.id,
      changedTask.version,
      { title: "Changed after review" },
      undefined,
      undefined,
      actor,
    );

    assert.throws(
      () => fixture.database.saveTaskSessionIntegration(approved.id, {
        parentThreadId: "parent-thread",
        conflict: false,
      }),
      (error) => error?.code === "INTENT_STALE",
    );
    const current = fixture.database.getTaskSessionOrchestration(approved.id);
    assert.equal(current.state, "writeback_pending");
    assert.equal(current.integrationRevisions.length, 0);
  } finally {
    await fixture.close();
  }
});

test("dispatch retries enrich an id-only child binding exactly once", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    let orchestration = createOrchestration(fixture.database, task);
    orchestration = fixture.database.confirmTaskSessionIntent(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: orchestration.intentVersion,
      captureDigest: orchestration.intentDigest,
    });
    orchestration = fixture.database.dispatchTaskSessionOrchestration(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: orchestration.intentVersion,
      childThreadId: "child-thread",
    });
    const fullBinding = binding("child-thread", "/tmp/enriched-worktree");
    const enriched = fixture.database.dispatchTaskSessionOrchestration(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: orchestration.intentVersion,
      childThreadBinding: fullBinding,
      childWindow: { targetId: "window-1" },
      runtime: { host: "local" },
      worktree: { path: "/tmp/enriched-worktree" },
    });
    assert.deepEqual(enriched.childThreadBinding, fullBinding);
    assert.deepEqual(enriched.childWindow, { targetId: "window-1" });
    assert.deepEqual(enriched.runtime, { host: "local" });
    assert.deepEqual(enriched.worktree, { path: "/tmp/enriched-worktree" });
    const enrichedMessages = fixture.database.listTaskSessionMessages(orchestration.id);
    assert.equal(enrichedMessages.filter((message) => message.type === "child_binding_enriched").length, 1);
    const version = enriched.version;

    const retried = fixture.database.dispatchTaskSessionOrchestration(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: orchestration.intentVersion,
      childThreadBinding: fullBinding,
      childWindow: { targetId: "window-1" },
      runtime: { host: "local" },
      worktree: { path: "/tmp/enriched-worktree" },
    });
    assert.equal(retried.version, version);
    assert.equal(
      fixture.database.listTaskSessionMessages(orchestration.id)
        .filter((message) => message.type === "child_binding_enriched").length,
      1,
    );
    assert.throws(
      () => fixture.database.dispatchTaskSessionOrchestration(orchestration.id, {
        parentThreadId: "parent-thread",
        intentVersion: orchestration.intentVersion,
        childThreadBinding: binding("child-thread", "/tmp/other-worktree"),
      }),
      (error) => error?.code === "CHILD_THREAD_MISMATCH",
    );
  } finally {
    await fixture.close();
  }
});

test("full parent and child binding identities must remain stable", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    const parent = binding("parent-thread", "/tmp/parent-worktree");
    const orchestration = fixture.database.createTaskSessionOrchestration(task.id, {
      parentThreadBinding: parent,
      intent: { goal: "Implement the task" },
    });
    for (const [field, value] of [
      ["codexProjectId", "other-project"],
      ["codexProjectKind", "remote"],
      ["codexHostId", "other-host"],
      ["workspacePath", "/tmp/other-worktree"],
    ]) {
      assert.throws(
        () => fixture.database.createTaskSessionOrchestration(task.id, {
          parentThreadBinding: { ...parent, [field]: value },
        }),
        (error) => error?.code === "PARENT_THREAD_MISMATCH",
      );
    }
    let confirmed = fixture.database.confirmTaskSessionIntent(orchestration.id, {
      parentThreadId: parent.threadId,
      intentVersion: orchestration.intentVersion,
      captureDigest: orchestration.intentDigest,
    });
    confirmed = fixture.database.dispatchTaskSessionOrchestration(confirmed.id, {
      parentThreadId: parent.threadId,
      intentVersion: confirmed.intentVersion,
      childThreadBinding: binding("child-thread", "/tmp/child-worktree"),
    });
    assert.throws(
      () => fixture.database.appendTaskSessionMessage(confirmed.id, {
        direction: "parent_to_child",
        parentThreadBinding: { ...parent, workspacePath: "/tmp/other-worktree" },
        intentVersion: confirmed.intentVersion,
        payload: { note: "wrong environment" },
      }),
      (error) => error?.code === "PARENT_THREAD_MISMATCH",
    );
  } finally {
    await fixture.close();
  }
});

test("bound intent mutations require the parent identity while unbound drafts remain compatible", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    const orchestration = createOrchestration(fixture.database, task);
    assert.throws(
      () => fixture.database.saveTaskSessionIntent(orchestration.id, {
        intent: { goal: "Without parent" },
      }),
      (error) => error?.code === "PARENT_THREAD_REQUIRED",
    );
    assert.throws(
      () => fixture.database.confirmTaskSessionIntent(orchestration.id, {
        intentVersion: orchestration.intentVersion,
        captureDigest: orchestration.intentDigest,
        parentThreadId: "other-parent",
      }),
      (error) => error?.code === "PARENT_THREAD_MISMATCH",
    );

    const secondTask = await fixture.createTask({ title: "Unbound intent task" });
    const unbound = fixture.database.createTaskSessionOrchestration(secondTask.id, {
      id: "unbound-intent-auth-test",
      intent: { goal: "placeholder" },
    });
    const saved = fixture.database.saveTaskSessionIntent(unbound.id, {
      intent: { goal: "Unbound save remains compatible" },
      revision: 2,
    });
    assert.equal(saved.state, "intent_draft");
    const confirmed = fixture.database.confirmTaskSessionIntent(unbound.id, {
      intentVersion: saved.intentVersion,
      captureDigest: saved.intentDigest,
    });
    assert.equal(confirmed.state, "intent_ready");
  } finally {
    await fixture.close();
  }
});

test("source snapshots and capture digests must describe the current source", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    const source = fixture.database.getTaskSessionSourceSnapshot(task.id);
    assert.throws(
      () => fixture.database.createTaskSessionOrchestration(task.id, {
        sourceSnapshot: source.snapshot,
        intentDigest: "forged-digest",
        intent: { goal: "Reject forged digest" },
      }),
      (error) => error?.code === "INVALID_FIELD",
    );

    const staleSnapshot = {
      ...source.snapshot,
      task: { ...source.snapshot.task, title: "Stale source" },
    };
    assert.throws(
      () => fixture.database.createTaskSessionOrchestration(task.id, {
        sourceSnapshot: staleSnapshot,
        intent: { goal: "Reject stale source" },
      }),
      (error) => error?.code === "INTENT_STALE",
    );

    const orchestration = createOrchestration(fixture.database, task);
    assert.throws(
      () => fixture.database.saveTaskSessionIntent(orchestration.id, {
        parentThreadId: "parent-thread",
        sourceSnapshot: source.snapshot,
        captureDigest: "forged-digest",
        intent: { goal: "Reject forged digest" },
        revision: 2,
      }),
      (error) => error?.code === "INVALID_FIELD",
    );
    assert.throws(
      () => fixture.database.saveTaskSessionIntent(orchestration.id, {
        parentThreadId: "parent-thread",
        sourceSnapshot: staleSnapshot,
        intent: { goal: "Reject stale source" },
        revision: 2,
      }),
      (error) => error?.code === "INTENT_STALE",
    );
    const saved = fixture.database.saveTaskSessionIntent(orchestration.id, {
      parentThreadId: "parent-thread",
      sourceSnapshot: source.snapshot,
      captureDigest: source.digest,
      intent: { goal: "Accept current source" },
      revision: 2,
    });
    assert.equal(saved.intentDigest, source.digest);
  } finally {
    await fixture.close();
  }
});

test("message idempotency compares explicit envelope fields and deeply compares payloads", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    let orchestration = createOrchestration(fixture.database, task);
    orchestration = fixture.database.confirmTaskSessionIntent(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: orchestration.intentVersion,
      captureDigest: orchestration.intentDigest,
    });
    orchestration = dispatch(fixture.database, orchestration);
    const input = {
      direction: "parent_to_child",
      type: "progress_summary",
      idempotencyKey: "message-envelope-1",
      state: "executing",
      payload: { nested: { first: 1, second: ["same"] } },
      deliveryState: "sent",
      parentThreadId: "parent-thread",
      intentVersion: orchestration.intentVersion,
    };
    const first = fixture.database.appendTaskSessionMessage(orchestration.id, input);
    assert.equal(first.state, "executing");
    assert.equal(
      fixture.database.database.prepare(
        "SELECT state FROM task_session_messages WHERE id = ?",
      ).get(first.id).state,
      "executing",
    );
    const omittedEnvelope = fixture.database.appendTaskSessionMessage(orchestration.id, {
      idempotencyKey: input.idempotencyKey,
      payload: { nested: { second: ["same"], first: 1 } },
      parentThreadId: "parent-thread",
      intentVersion: orchestration.intentVersion,
    });
    assert.equal(omittedEnvelope.id, first.id);
    const sameState = fixture.database.appendTaskSessionMessage(orchestration.id, {
      ...input,
      state: "executing",
    });
    assert.equal(sameState.id, first.id);
    fixture.database.createTaskSessionReport(orchestration.id, {
      parentThreadId: "parent-thread",
      childThreadId: "child-thread",
      intentVersion: orchestration.intentVersion,
      resultRevision: 1,
      idempotencyKey: `${orchestration.id}:1`,
      payload: { summary: "Implemented", rationale: "Required change" },
    });
    const historicalRetry = fixture.database.appendTaskSessionMessage(orchestration.id, input);
    assert.equal(historicalRetry.id, first.id);
    for (const change of [
      { direction: "internal" },
      { type: "different_type" },
      { deliveryState: "acknowledged" },
      { state: "waiting_for_user" },
      { payload: { nested: { first: 2, second: ["same"] } } },
    ]) {
      assert.throws(
        () => fixture.database.appendTaskSessionMessage(orchestration.id, {
          ...input,
          ...change,
        }),
        (error) => error?.code === "IDEMPOTENCY_CONFLICT",
      );
    }
  } finally {
    await fixture.close();
  }
});

test("a reserved report acknowledgement key cannot impersonate an ack", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    let orchestration = createOrchestration(fixture.database, task);
    orchestration = fixture.database.confirmTaskSessionIntent(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: orchestration.intentVersion,
      captureDigest: orchestration.intentDigest,
    });
    orchestration = dispatch(fixture.database, orchestration);
    fixture.database.appendTaskSessionMessage(orchestration.id, {
      direction: "parent_to_child",
      type: "spoofed_ack",
      idempotencyKey: `${orchestration.id}:1:ack`,
      payload: { resultRevision: 1 },
      deliveryState: "acknowledged",
      parentThreadId: "parent-thread",
      intentVersion: orchestration.intentVersion,
    });
    fixture.database.createTaskSessionReport(orchestration.id, {
      parentThreadId: "parent-thread",
      childThreadId: "child-thread",
      intentVersion: orchestration.intentVersion,
      resultRevision: 1,
      idempotencyKey: `${orchestration.id}:1`,
      payload: { summary: "Implemented", rationale: "Required change" },
    });

    assert.throws(
      () => fixture.database.acknowledgeTaskSessionReport(
        orchestration.id,
        1,
        { parentThreadId: "parent-thread" },
      ),
      (error) => error?.code === "IDEMPOTENCY_CONFLICT",
    );
    const after = fixture.database.getTaskSessionOrchestration(orchestration.id);
    assert.equal(after.state, "reporting");
    assert.equal(
      fixture.database.listTaskSessionMessages(orchestration.id)
        .find((message) => message.type === "result")?.deliveryState,
      "sent",
    );
  } finally {
    await fixture.close();
  }
});

test("parent binding retries enrich missing identity once and preserve conflicts", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    const legacyParent = { threadId: "parent-thread" };
    const fullParent = binding("parent-thread", "/tmp/parent-worktree");
    const orchestration = fixture.database.createTaskSessionOrchestration(task.id, {
      parentThreadBinding: legacyParent,
      intent: { goal: "Enrich the parent binding" },
    });
    const initialVersion = orchestration.version;
    const initialParentBoundCount = fixture.database.listTaskSessionMessages(orchestration.id)
      .filter((message) => message.type === "parent_bound").length;

    const enriched = fixture.database.createTaskSessionOrchestration(task.id, {
      parentThreadBinding: fullParent,
    });
    assert.deepEqual(enriched.parentThreadBinding, fullParent);
    assert.equal(enriched.version, initialVersion + 1);
    const parentBoundMessages = fixture.database.listTaskSessionMessages(orchestration.id)
      .filter((message) => message.type === "parent_bound");
    assert.equal(parentBoundMessages.length, initialParentBoundCount + 1);
    assert.deepEqual(parentBoundMessages.at(-1).payload, {
      parentThreadBinding: fullParent,
      state: orchestration.state,
    });

    const retried = fixture.database.createTaskSessionOrchestration(task.id, {
      parentThreadBinding: fullParent,
    });
    assert.equal(retried.version, enriched.version);
    assert.equal(
      fixture.database.listTaskSessionMessages(orchestration.id)
        .filter((message) => message.type === "parent_bound").length,
      parentBoundMessages.length,
    );

    assert.throws(
      () => fixture.database.createTaskSessionOrchestration(task.id, {
        parentThreadBinding: { ...fullParent, workspacePath: "/tmp/other-worktree" },
      }),
      (error) => error?.code === "PARENT_THREAD_MISMATCH",
    );
    const afterConflict = fixture.database.getTaskSessionOrchestration(orchestration.id);
    assert.deepEqual(afterConflict.parentThreadBinding, fullParent);
    assert.equal(afterConflict.version, enriched.version);
    assert.equal(
      fixture.database.listTaskSessionMessages(orchestration.id)
        .filter((message) => message.type === "parent_bound").length,
      parentBoundMessages.length,
    );
  } finally {
    await fixture.close();
  }
});

test("dispatch rejects a confirmed intent after the Jira source changes", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    let orchestration = createOrchestration(fixture.database, task);
    orchestration = fixture.database.confirmTaskSessionIntent(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: orchestration.intentVersion,
      captureDigest: orchestration.intentDigest,
    });
    const currentTask = fixture.database.getTask(task.id);
    fixture.database.updateTask(
      task.id,
      currentTask.version,
      { title: "Changed after confirmation" },
      undefined,
      undefined,
      actor,
    );

    assert.throws(
      () => dispatch(fixture.database, orchestration),
      (error) => error?.code === "INTENT_STALE",
    );
    const after = fixture.database.getTaskSessionOrchestration(orchestration.id);
    assert.equal(after.state, "intent_ready");
    assert.equal(after.childThreadBinding, null);
    assert.equal(fixture.database.getTask(task.id).status, "todo");
  } finally {
    await fixture.close();
  }
});

test("report rejects a dispatched result after the Jira source changes", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    let orchestration = createOrchestration(fixture.database, task);
    orchestration = fixture.database.confirmTaskSessionIntent(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: orchestration.intentVersion,
      captureDigest: orchestration.intentDigest,
    });
    orchestration = dispatch(fixture.database, orchestration);
    const currentTask = fixture.database.getTask(task.id);
    fixture.database.updateTask(
      task.id,
      currentTask.version,
      { title: "Changed before report" },
      undefined,
      undefined,
      actor,
    );

    assert.throws(
      () => fixture.database.createTaskSessionReport(orchestration.id, {
        parentThreadId: "parent-thread",
        childThreadId: "child-thread",
        intentVersion: orchestration.intentVersion,
        resultRevision: 1,
        idempotencyKey: `${orchestration.id}:1`,
        payload: { summary: "Should not be accepted", rationale: "Stale source" },
      }),
      (error) => error?.code === "INTENT_STALE",
    );
    const after = fixture.database.getTaskSessionOrchestration(orchestration.id);
    assert.equal(after.state, "dispatched");
    assert.equal(after.currentResultRevision, 0);
  } finally {
    await fixture.close();
  }
});

test("generic lifecycle messages cannot bypass review or blocked recovery actions", async () => {
  const fixture = await createFixture();
  try {
    const task = await fixture.createTask();
    let orchestration = createOrchestration(fixture.database, task);
    orchestration = fixture.database.confirmTaskSessionIntent(orchestration.id, {
      parentThreadId: "parent-thread",
      intentVersion: orchestration.intentVersion,
      captureDigest: orchestration.intentDigest,
    });
    orchestration = dispatch(fixture.database, orchestration);
    fixture.database.createTaskSessionReport(orchestration.id, {
      parentThreadId: "parent-thread",
      childThreadId: "child-thread",
      intentVersion: orchestration.intentVersion,
      resultRevision: 1,
      idempotencyKey: `${orchestration.id}:1`,
      payload: { summary: "Implemented", rationale: "Required change" },
    });
    const acknowledged = fixture.database.acknowledgeTaskSessionReport(
      orchestration.id,
      1,
      { parentThreadId: "parent-thread" },
    );
    assert.equal(acknowledged.orchestration.state, "reviewing");
    assert.equal(acknowledged.message.deliveryState, "acknowledged");
    const timeline = fixture.database.listTaskSessionMessages(orchestration.id);
    const reportMessage = timeline.find((message) => message.type === "result");
    const reviewStarted = timeline.find((message) => message.type === "review_started");
    assert.equal(reportMessage?.deliveryState, "acknowledged");
    assert.equal(reviewStarted?.type, "review_started");
    assert.equal(reviewStarted?.deliveryState, "acknowledged");
    assert.throws(
      () => fixture.database.appendTaskSessionMessage(orchestration.id, {
        direction: "child_to_parent",
        childThreadId: "child-thread",
        intentVersion: acknowledged.orchestration.intentVersion,
        type: "state_update",
        state: "executing",
        payload: { state: "executing" },
      }),
      (error) => error?.code === "REVIEW_ACTION_REQUIRED",
    );
    const reviewed = fixture.database.saveTaskSessionReview(orchestration.id, {
      parentThreadId: "parent-thread",
      decision: "blocked",
      resultRevision: 1,
    }).orchestration;
    assert.equal(reviewed.state, "blocked");
    assert.throws(
      () => fixture.database.appendTaskSessionMessage(reviewed.id, {
        direction: "child_to_parent",
        childThreadId: "child-thread",
        intentVersion: reviewed.intentVersion,
        type: "state_update",
        state: "executing",
        payload: { state: "executing" },
      }),
      (error) => error?.code === "RECOVERY_ACTION_REQUIRED",
    );
    assert.equal(fixture.database.getTaskSessionOrchestration(reviewed.id).state, "blocked");
  } finally {
    await fixture.close();
  }
});
