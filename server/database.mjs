import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_LABEL_NAMES, JIRA_PROJECT_ID } from "../shared/domain.mjs";

const DEFAULT_PROJECT_LABELS_JSON = JSON.stringify(DEFAULT_LABEL_NAMES);
const TASK_TREE_MAX_NODES = 1_000;

// 编排状态由 Taskboard 持久化，避免宿主窗口状态短暂变化时丢失业务阶段。
export const TASK_SESSION_STATES = Object.freeze([
  "unbound",
  "intent_draft",
  "intent_ready",
  "dispatched",
  "executing",
  "waiting_for_user",
  "reporting",
  "result_ready",
  "reviewing",
  "writeback_pending",
  "synced",
  "blocked",
  "integrated",
  "done",
]);
const TASK_SESSION_LIFECYCLE_STATES = new Set([
  "dispatched",
  "executing",
  "waiting_for_user",
  "reporting",
]);
const TASK_SESSION_DISPATCH_STATES = new Set([
  "dispatched",
  "executing",
  "waiting_for_user",
]);
const TASK_SESSION_INTENT_STATES = new Set([
  "unbound",
  "intent_draft",
  "intent_ready",
]);
const TASK_SESSION_STATE_TRANSITIONS = Object.freeze({
  unbound: new Set(["intent_draft"]),
  intent_draft: new Set(["intent_ready"]),
  intent_ready: new Set(["dispatched"]),
  dispatched: new Set(["dispatched", "executing", "waiting_for_user"]),
  executing: new Set(["executing", "waiting_for_user", "reporting"]),
  waiting_for_user: new Set(["waiting_for_user", "executing", "reporting"]),
  // 收到结果报告后由主会话自动进入检查阶段；检查结论仍通过 review API 写入。
  reporting: new Set(["reporting", "reviewing"]),
  result_ready: new Set(["result_ready", "executing", "reviewing"]),
  reviewing: new Set(["reviewing", "writeback_pending", "executing", "blocked"]),
  writeback_pending: new Set(["writeback_pending", "integrated", "synced", "blocked"]),
  integrated: new Set(["integrated", "writeback_pending", "synced", "blocked", "done"]),
  synced: new Set(["synced", "integrated", "writeback_pending", "blocked", "done"]),
  blocked: new Set(["blocked", "executing", "integrated"]),
  done: new Set(),
});
const TASK_SESSION_STATUS_ACTOR = Object.freeze({
  type: "agent",
  id: "task-session",
  name: "Task session",
  avatarUrl: null,
});

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function now() {
  return new Date().toISOString();
}

function localDateKey(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDayBounds(date) {
  const [year, month, day] = date.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month - 1, day + 1);
  return { start, end };
}

function overlapSeconds(startedAt, endedAt, rangeStart, rangeEnd) {
  const start = Math.max(new Date(startedAt).getTime(), rangeStart.getTime());
  const end = Math.min(new Date(endedAt).getTime(), rangeEnd.getTime());
  return Math.max(0, Math.floor((end - start) / 1000));
}

function commentConversationTitle(body) {
  const firstLine = String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "评论";
  const compact = firstLine.replace(/\s+/g, " ");
  return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
}

function threadBindingFromRow(row) {
  if (
    !row.thread_id
    || !row.thread_codex_project_id
    || !row.thread_codex_project_kind
    || !row.thread_codex_host_id
    || !row.thread_workspace_path
  ) return null;
  return {
    threadId: row.thread_id,
    codexProjectId: row.thread_codex_project_id,
    codexProjectKind: row.thread_codex_project_kind,
    codexHostId: row.thread_codex_host_id,
    workspacePath: row.thread_workspace_path,
  };
}

function legacyLocalThreadIdFromRow(row) {
  if (!row.thread_id) return null;
  return [
    row.thread_codex_project_id,
    row.thread_codex_project_kind,
    row.thread_codex_host_id,
    row.thread_workspace_path,
  ].every((value) => value == null)
    ? row.thread_id
    : null;
}

function storedThreadBinding(threadBinding, threadId) {
  if (threadBinding === undefined && (threadId === undefined || threadId === null)) return undefined;
  const binding = threadBinding === undefined ? { threadId } : threadBinding;
  return [
    binding?.threadId ?? null,
    binding?.codexProjectId ?? null,
    binding?.codexProjectKind ?? null,
    binding?.codexHostId ?? null,
    binding?.workspacePath ?? null,
  ];
}

function storedThreadBindingForExisting(current, threadBinding, threadId) {
  if (
    threadBinding === undefined
    && current?.threadBinding
    && current.threadBinding.threadId === threadId
  ) {
    return storedThreadBinding(current.threadBinding, threadId);
  }
  return storedThreadBinding(threadBinding, threadId);
}

function attachTaskActivity(task, comments, activities, previewImage = null) {
  const orderedComments = [...comments].sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  const orderedActivities = [...activities].sort((left, right) => (
    left.id.localeCompare(right.id)
  ));
  const participants = [];
  const participantIds = new Set();
  const addParticipant = (actor) => {
    const key = `${actor.type}:${actor.id}`;
    if (participantIds.has(key)) return;
    participantIds.add(key);
    participants.push(actor);
  };
  addParticipant({
    type: task.creatorType,
    id: task.creatorId,
    name: task.creatorName,
    avatarUrl: task.creatorAvatarUrl,
  });
  addParticipant(task.assignee);
  for (const comment of orderedComments) {
    addParticipant({
      type: comment.author_type,
      id: comment.author_id,
      name: comment.author_name,
      avatarUrl: comment.author_avatar_url,
    });
  }
  for (const activity of orderedActivities) {
    addParticipant({
      type: activity.actor_type,
      id: activity.actor_id,
      name: activity.actor_name,
      avatarUrl: activity.actor_avatar_url,
    });
  }
  const conversationRefs = [];
  if (task.threadBinding) {
    conversationRefs.push({
      ...task.threadBinding,
      source: "task",
      sourceId: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  } else if (task.legacyLocalThreadId) {
    conversationRefs.push({
      threadId: task.legacyLocalThreadId,
      legacyLocal: true,
      source: "task",
      sourceId: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  }
  for (const comment of orderedComments) {
    const threadBinding = threadBindingFromRow(comment);
    const legacyLocalThreadId = legacyLocalThreadIdFromRow(comment);
    if (threadBinding || legacyLocalThreadId) {
      conversationRefs.push({
        ...(threadBinding ?? { threadId: legacyLocalThreadId, legacyLocal: true }),
        source: "comment",
        sourceId: comment.id,
        title: commentConversationTitle(comment.body),
        updatedAt: comment.updated_at,
      });
    }
  }

  task.conversationRefs = conversationRefs;
  task.participants = participants;
  task.previewImage = previewImage;
  task.activityKey = JSON.stringify({
    version: 1,
    task: [task.id, task.version, task.updatedAt],
    comments: orderedComments.map((comment) => [comment.id, comment.version, comment.updated_at]),
    changes: orderedActivities.map((activity) => [activity.id, activity.created_at]),
  });
  task.activityUpdatedAt = [...orderedComments, ...orderedActivities].reduce(
    (latest, activity) => {
      const updatedAt = activity.updated_at ?? activity.created_at;
      return updatedAt > latest ? updatedAt : latest;
    },
    task.updatedAt,
  );
  return task;
}

function taskActivityFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorAvatarUrl: row.actor_avatar_url,
    changes: JSON.parse(row.changes),
    createdAt: row.created_at,
  };
}

function taskFieldChanges(task, changes) {
  return Object.entries(changes).flatMap(([field, after]) => {
    const before = task[field];
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [{ field, before, after }];
  });
}

function relationActivityValue(type, task) {
  return {
    type,
    identifier: task.identifier,
    externalKey: task.externalKey ?? null,
    title: task.title,
  };
}

function parseAiChatTodoProgress(row) {
  try {
    const data = row.data === null ? null : JSON.parse(row.data);
    const detail = typeof data?.detail === "string" ? JSON.parse(data.detail) : data?.detail;
    if (!Array.isArray(detail)) return null;
    const items = detail.filter((item) => (
      item && typeof item === "object" && typeof item.text === "string" && item.text.trim()
    ));
    if (items.length === 0) return null;
    return {
      completed: items.filter((item) => item.completed === true).length,
      total: items.length,
      eventId: row.id,
      updatedAt: row.created_at,
    };
  } catch {
    return null;
  }
}

function taskFromRow(row) {
  const developmentContext = row.worktree_path
    ? { type: "worktree", path: row.worktree_path, branch: row.worktree_branch }
    : row.git_branch
      ? { type: "branch", branch: row.git_branch }
      : null;
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    labels: JSON.parse(row.labels),
    sortOrder: row.sort_order,
    threadId: row.thread_id,
    threadBinding: threadBindingFromRow(row),
    legacyLocalThreadId: legacyLocalThreadIdFromRow(row),
    creatorType: row.creator_type,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    creatorAvatarUrl: row.creator_avatar_url,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    developmentContext,
    startDate: row.start_date,
    dueDate: row.due_date,
    recurrence: row.recurrence_interval && row.recurrence_unit
      ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
      : null,
    source: row.external_source === "jira" ? "jira" : "local",
    externalOrigin: row.external_origin ?? null,
    externalKey: row.external_key ?? null,
    externalUrl: row.external_url ?? null,
    jiraStatusOverride: row.jira_status_override === 1,
    timeTracking: {
      paused: row.timer_paused === 1,
      date: null,
      closedSeconds: 0,
      activeStartedAt: null,
    },
    archivedAt: row.archived_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskRelationSummaryFromRow(row) {
  return {
    id: row.id,
    identifier: row.identifier,
    externalKey: row.external_key ?? null,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    archivedAt: row.archived_at,
  };
}

function taskTreeNode(row, parentId, depth, path) {
  return {
    id: row.id,
    parentId,
    depth,
    path,
    summary: {
      identifier: row.identifier,
      title: row.title,
      status: row.status,
      priority: row.priority,
      archivedAt: row.archived_at,
    },
  };
}

function commentFromRow(row) {
  const comment = {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    threadId: row.thread_id,
    threadBinding: threadBindingFromRow(row),
    legacyLocalThreadId: legacyLocalThreadIdFromRow(row),
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    attachments: [],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  Object.defineProperty(comment, "changeRevision", { value: row.change_revision });
  return comment;
}

function attachmentFromRow(row) {
  const attachment = {
    id: row.id,
    taskId: row.task_id,
    commentId: row.comment_id,
    kind: row.kind,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
  Object.defineProperty(attachment, "changeRevision", { value: row.change_revision });
  return attachment;
}

function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    workspacePath: row.workspace_path,
    source: row.id === JIRA_PROJECT_ID ? "jira" : "local",
    labels: JSON.parse(row.labels),
    issueCount: Number(row.issue_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectSummaryFromRow(row) {
  return {
    projectId: row.project_id,
    summary: row.summary,
    generatedAt: row.generated_at,
    attemptedAt: row.attempted_at,
    error: row.error,
  };
}

function projectReadmeFromRow(row, projectId) {
  return {
    projectId: row.project_id ?? projectId,
    content: row.content,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectReadmeAttachmentFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: "inline",
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

function aiChatRunFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status,
    exitCode: row.exit_code,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function aiChatThreadFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    origin: {
      projectId: row.origin_project_id,
      projectName: row.origin_project_name,
      workspacePath: row.origin_workspace_path,
      ...(row.origin_codex_project_id ? { codexProjectId: row.origin_codex_project_id } : {}),
      ...(row.origin_codex_project_kind ? { codexProjectKind: row.origin_codex_project_kind } : {}),
      ...(row.origin_codex_host_id ? { codexHostId: row.origin_codex_host_id } : {}),
      ...(row.origin_issue_id ? { issueId: row.origin_issue_id } : {}),
      ...(row.origin_issue_identifier ? { issueIdentifier: row.origin_issue_identifier } : {}),
    },
    codexThreadId: row.codex_thread_id,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    sandbox: row.sandbox,
    currentRun: null,
    latestTodo: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function aiChatEventFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    type: row.type,
    role: row.role,
    content: row.content,
    data: row.data === null ? null : JSON.parse(row.data),
    createdAt: row.created_at,
  };
}

function parseTaskSessionJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function taskSessionArray(value) {
  const parsed = parseTaskSessionJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function taskSessionRevisionArray(value) {
  const parsed = parseTaskSessionJson(value, []);
  if (Array.isArray(parsed)) return parsed;
  return parsed && typeof parsed === "object" ? [parsed] : [];
}

function taskSessionOrchestrationFromRow(row) {
  const intentRevisions = taskSessionArray(row.intent_json);
  const resultRevisions = taskSessionArray(row.result_json);
  const currentIntent = intentRevisions.at(-1) ?? null;
  const currentResult = resultRevisions.at(-1) ?? null;
  const reviewValue = parseTaskSessionJson(row.review_json);
  const writebackValue = parseTaskSessionJson(row.writeback_json);
  const integrationValue = parseTaskSessionJson(row.integration_json);
  const reviewRevisions = Array.isArray(reviewValue)
    ? reviewValue
    : reviewValue ? [reviewValue] : [];
  const writebackRevisions = Array.isArray(writebackValue)
    ? writebackValue
    : writebackValue ? [writebackValue] : [];
  const integrationRevisions = Array.isArray(integrationValue)
    ? integrationValue
    : integrationValue ? [integrationValue] : [];
  return {
    id: row.id,
    taskId: row.task_id,
    state: row.state,
    parentThreadBinding: parseTaskSessionJson(row.parent_thread_json),
    childThreadBinding: parseTaskSessionJson(row.child_thread_json),
    childWindow: parseTaskSessionJson(row.child_window_json),
    runtime: parseTaskSessionJson(row.runtime_json),
    worktree: parseTaskSessionJson(row.worktree_json),
    sourceSnapshot: parseTaskSessionJson(row.source_snapshot_json),
    intentDigest: row.intent_digest,
    intentVersion: currentIntent?.revision ?? 0,
    confirmedIntentVersion: row.confirmed_intent_version ?? null,
    confirmedAt: row.confirmed_at ?? null,
    intent: currentIntent,
    intentRevisions,
    currentResultRevision: row.current_result_revision,
    result: currentResult,
    resultRevisions,
    review: reviewRevisions.at(-1) ?? null,
    reviewRevisions,
    writeback: writebackRevisions.at(-1) ?? null,
    writebackRevisions,
    integration: integrationRevisions.at(-1) ?? null,
    integrationRevisions,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskSessionMessageFromRow(row) {
  return {
    id: row.id,
    orchestrationId: row.orchestration_id,
    direction: row.direction,
    type: row.type,
    idempotencyKey: row.idempotency_key,
    state: row.state ?? null,
    payload: parseTaskSessionJson(row.payload_json, {}),
    deliveryState: row.delivery_state,
    sequence: row.sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskSessionDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function taskSessionSourceProjection(snapshot, { stripWorkflowFields = true } = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  const projection = { ...snapshot, fetchedAt: null };
  if (projection.task && typeof projection.task === "object" && !Array.isArray(projection.task)) {
    // 编排会自动推动本地任务状态并递增版本；这些字段不是 Jira 来源变化，不能让自身流程把意图判旧。
    projection.task = { ...projection.task };
    if (stripWorkflowFields) {
      delete projection.task.status;
      delete projection.task.version;
      delete projection.task.updatedAt;
    }
  }
  return projection;
}

function taskSessionSourceDigest(snapshot) {
  return taskSessionDigest(taskSessionSourceProjection(snapshot));
}

// 旧版本 digest 包含本地 workflow 字段；保留旧投影只用于校验已持久化的快照。
function taskSessionLegacySourceDigest(snapshot) {
  return taskSessionDigest(taskSessionSourceProjection(snapshot, { stripWorkflowFields: false }));
}

function taskSessionSourceDigestMatches(orchestration, source) {
  if (!orchestration.intentDigest || !source) return false;
  if (source.digest === orchestration.intentDigest) return true;
  if (!orchestration.sourceSnapshot) return false;
  // 旧记录以捕获时的 volatile 字段计算 digest；稳定投影一致时允许继续使用该记录。
  return taskSessionLegacySourceDigest(orchestration.sourceSnapshot) === orchestration.intentDigest
    && taskSessionSourceDigest(orchestration.sourceSnapshot) === source.digest;
}

function taskSessionPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function taskSessionSourceDigestCandidates(snapshot) {
  try {
    return new Set([
      taskSessionSourceDigest(snapshot),
      taskSessionLegacySourceDigest(snapshot),
    ]);
  } catch {
    throw new ApiError(400, "INVALID_FIELD", "sourceSnapshot cannot be serialized");
  }
}

// 保存来源快照时同时校验摘要和当前本地 Jira 投影；旧记录的 digest 仍允许读取和续接。
function taskSessionValidatedSourceCapture(snapshot, suppliedDigest, currentSource) {
  if (!taskSessionPlainObject(snapshot)) {
    throw new ApiError(400, "INVALID_FIELD", "sourceSnapshot must be an object");
  }
  const candidates = taskSessionSourceDigestCandidates(snapshot);
  const stableDigest = [...candidates][0];
  let captureDigest = stableDigest;
  if (suppliedDigest !== undefined && suppliedDigest !== null) {
    if (typeof suppliedDigest !== "string" || suppliedDigest.trim().length === 0) {
      throw new ApiError(400, "INVALID_FIELD", "captureDigest must be a non-empty string");
    }
    captureDigest = suppliedDigest.trim();
    if (!candidates.has(captureDigest)) {
      throw new ApiError(
        400,
        "INVALID_FIELD",
        "captureDigest does not match sourceSnapshot",
      );
    }
  }
  if (currentSource && stableDigest !== currentSource.digest) {
    throw new ApiError(
      409,
      "INTENT_STALE",
      "The Jira source snapshot changed; refresh and confirm the intent again",
      {
        intentDigest: captureDigest,
        currentDigest: currentSource.digest,
      },
    );
  }
  return { snapshot, digest: captureDigest, stableDigest };
}

function taskSessionValidatedCurrentCapture(currentSource, suppliedDigest) {
  if (!currentSource?.snapshot) {
    throw new ApiError(409, "INTENT_STALE", "The Jira source snapshot is unavailable");
  }
  return taskSessionValidatedSourceCapture(currentSource.snapshot, suppliedDigest, currentSource);
}

function taskSessionPayloadMatches(existing, incoming) {
  if (!existing || typeof existing !== "object" || !incoming || typeof incoming !== "object") return false;
  // 结果落库时会补齐 envelope 字段；重试时用同一 envelope 重建候选值，再比较完整 payload，避免子集重试被当成幂等成功。
  const candidate = {
    ...incoming,
    version: incoming.version ?? existing.version ?? "task-result.v1",
    intentVersion: existing.intentVersion,
    resultRevision: existing.resultRevision,
    idempotencyKey: existing.idempotencyKey,
    createdAt: existing.createdAt,
  };
  return taskSessionJsonEqual(existing, candidate);
}

function taskSessionJsonEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (typeof left !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((value, index) => taskSessionJsonEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => (
    Object.hasOwn(right, key) && taskSessionJsonEqual(left[key], right[key])
  ));
}

// 幂等重试必须复用同一消息 envelope；省略字段按原有默认值兼容，显式冲突则拒绝。
function taskSessionMessageIdempotencyMatches(existingRow, input) {
  const existing = taskSessionMessageFromRow(existingRow);
  if (input.direction !== undefined && input.direction !== existing.direction) return false;
  if (input.type !== undefined && input.type !== existing.type) return false;
  if (input.deliveryState !== undefined && input.deliveryState !== existing.deliveryState) return false;
  // 顶层 state 不在 payload 中时也必须参与幂等比较，否则同一 key 的重试
  // 可以悄悄携带另一条 lifecycle 状态并复用旧消息。
  if (input.state !== undefined && input.state !== existing.state) return false;
  return taskSessionJsonEqual(existing.payload, input.payload ?? {});
}

function taskSessionJsonThreadId(value) {
  const parsed = parseTaskSessionJson(value);
  return parsed && typeof parsed.threadId === "string" ? parsed.threadId : null;
}

const TASK_SESSION_BINDING_IDENTITY_FIELDS = Object.freeze([
  "codexProjectId",
  "codexProjectKind",
  "codexHostId",
  "workspacePath",
]);

function taskSessionBindingIdentityConflicts(stored, incoming) {
  if (!stored || typeof stored !== "object" || !incoming || typeof incoming !== "object") return [];
  return TASK_SESSION_BINDING_IDENTITY_FIELDS.filter((field) => (
    Object.hasOwn(stored, field)
    && stored[field] !== undefined
    && Object.hasOwn(incoming, field)
    && incoming[field] !== undefined
    && stored[field] !== incoming[field]
  ));
}

function taskSessionBindingWithMissingIdentity(stored, incoming) {
  if (!incoming || typeof incoming !== "object") return stored;
  if (!stored || typeof stored !== "object") return { ...incoming };
  const merged = { ...stored };
  for (const field of TASK_SESSION_BINDING_IDENTITY_FIELDS) {
    if (
      (!Object.hasOwn(merged, field) || merged[field] === undefined)
      && Object.hasOwn(incoming, field)
      && incoming[field] !== undefined
    ) {
      merged[field] = incoming[field];
    }
  }
  return merged;
}

function taskSessionObjectConflicts(stored, incoming) {
  if (incoming === undefined || incoming === null || stored === undefined || stored === null) return [];
  if (
    typeof stored !== "object"
    || Array.isArray(stored)
    || typeof incoming !== "object"
    || Array.isArray(incoming)
  ) {
    return JSON.stringify(stored) === JSON.stringify(incoming) ? [] : ["$"];
  }
  return Object.keys(incoming).filter((key) => (
    Object.hasOwn(stored, key)
    && JSON.stringify(stored[key]) !== JSON.stringify(incoming[key])
  ));
}

function taskSessionObjectWithMissingFields(stored, incoming) {
  if (incoming === undefined) return stored;
  if (stored === undefined || stored === null) return incoming;
  if (incoming === null) return stored;
  if (
    typeof stored !== "object"
    || Array.isArray(stored)
    || typeof incoming !== "object"
    || Array.isArray(incoming)
  ) return stored;
  return { ...stored, ...Object.fromEntries(Object.entries(incoming).filter(([key]) => !Object.hasOwn(stored, key))) };
}

function projectPrefix(project) {
  const idPrefix = project.id.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12) || "TASK";
  const existingPrefix = project.first_identifier?.replace(/-\d+$/, "");
  if (existingPrefix && /^[A-Z0-9]+$/i.test(existingPrefix) && existingPrefix !== idPrefix) return existingPrefix;
  if (idPrefix.length <= 5) return idPrefix;
  const namePrefix = project.name.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 3);
  return namePrefix || idPrefix.slice(0, 3);
}

export class TaskboardDatabase {
  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    this.#initializeTaskTimers();
    this.interruptAbandonedAiChatRuns();
  }

  #migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        labels TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_LABELS_JSON}',
        next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN (
          'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
        )),
        priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        thread_id TEXT,
        thread_codex_project_id TEXT,
        thread_codex_project_kind TEXT,
        thread_codex_host_id TEXT,
        thread_workspace_path TEXT,
        creator_type TEXT NOT NULL DEFAULT 'user',
        creator_id TEXT NOT NULL DEFAULT 'local-user',
        creator_name TEXT NOT NULL DEFAULT '本地用户',
        creator_avatar_url TEXT,
        assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
        assignee_id TEXT NOT NULL DEFAULT 'local-user',
        assignee_name TEXT NOT NULL DEFAULT '本地用户',
        assignee_avatar_url TEXT,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        start_date TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        external_source TEXT,
        external_origin TEXT,
        external_id TEXT,
        external_key TEXT,
        external_url TEXT,
        jira_status_override INTEGER NOT NULL DEFAULT 0 CHECK (jira_status_override IN (0, 1)),
        jira_remote_status_id TEXT,
        timer_paused INTEGER NOT NULL DEFAULT 0 CHECK (timer_paused IN (0, 1)),
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS task_time_entries (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        start_reason TEXT NOT NULL,
        end_reason TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS task_time_entries_one_active
        ON task_time_entries(task_id)
        WHERE ended_at IS NULL;

      CREATE INDEX IF NOT EXISTS task_time_entries_range
        ON task_time_entries(started_at, ended_at, task_id);

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        thread_codex_project_id TEXT,
        thread_codex_project_kind TEXT,
        thread_codex_host_id TEXT,
        thread_workspace_path TEXT,
        author_type TEXT NOT NULL DEFAULT 'user',
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        change_revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS comments_task_created
        ON comments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS task_activities (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent')),
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_avatar_url TEXT,
        changes TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_activities_task_created
        ON task_activities(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('inline', 'attachment')),
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL,
        change_revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS attachments_task_created
        ON attachments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS comment_attachment_revision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL CHECK (value >= 0)
      );

      CREATE TABLE IF NOT EXISTS project_readmes (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_readme_attachments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_summaries (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        summary TEXT,
        generated_at TEXT,
        attempted_at TEXT NOT NULL,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS ai_chat_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
        origin_project_id TEXT NOT NULL,
        origin_project_name TEXT NOT NULL,
        origin_workspace_path TEXT NOT NULL,
        origin_codex_project_id TEXT,
        origin_codex_project_kind TEXT,
        origin_codex_host_id TEXT,
        origin_issue_id TEXT,
        origin_issue_identifier TEXT,
        codex_thread_id TEXT,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        sandbox TEXT NOT NULL CHECK (sandbox IN (
          'read-only', 'workspace-write', 'danger-full-access'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_threads_updated
        ON ai_chat_threads(updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS ai_chat_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN (
          'running', 'completed', 'failed', 'interrupted'
        )),
        exit_code INTEGER,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS ai_chat_runs_thread_started
        ON ai_chat_runs(thread_id, started_at, id);

      CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_runs_one_active
        ON ai_chat_runs(thread_id)
        WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS ai_chat_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'activity', 'error')),
        content TEXT NOT NULL,
        data TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_events_thread_created
        ON ai_chat_events(thread_id, created_at, id);

      CREATE TABLE IF NOT EXISTS task_session_orchestrations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN (
          'unbound', 'intent_draft', 'intent_ready', 'dispatched', 'executing',
          'waiting_for_user', 'reporting', 'result_ready', 'reviewing',
          'writeback_pending', 'synced', 'blocked', 'integrated', 'done'
        )),
        parent_thread_json TEXT,
        child_thread_json TEXT,
        child_window_json TEXT,
        runtime_json TEXT,
        worktree_json TEXT,
        intent_json TEXT NOT NULL DEFAULT '[]',
        source_snapshot_json TEXT,
        intent_digest TEXT,
        current_result_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_result_revision >= 0),
        result_json TEXT NOT NULL DEFAULT '[]',
        review_json TEXT,
        writeback_json TEXT,
        integration_json TEXT,
        confirmed_intent_version INTEGER,
        confirmed_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS task_session_orchestrations_one_active
        ON task_session_orchestrations(task_id)
        WHERE state != 'done';

      CREATE INDEX IF NOT EXISTS task_session_orchestrations_task_updated
        ON task_session_orchestrations(task_id, updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS task_session_messages (
        id TEXT PRIMARY KEY,
        orchestration_id TEXT NOT NULL REFERENCES task_session_orchestrations(id) ON DELETE CASCADE,
        direction TEXT NOT NULL CHECK (direction IN ('parent_to_child', 'child_to_parent', 'internal')),
        type TEXT NOT NULL,
        idempotency_key TEXT,
        state TEXT,
        payload_json TEXT NOT NULL,
        delivery_state TEXT NOT NULL CHECK (
          delivery_state IN ('pending', 'sent', 'acknowledged', 'failed', 'cancelled')
        ),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS task_session_messages_orchestration_sequence
        ON task_session_messages(orchestration_id, sequence);

      CREATE UNIQUE INDEX IF NOT EXISTS task_session_messages_idempotency
        ON task_session_messages(orchestration_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE INDEX IF NOT EXISTS task_session_messages_orchestration_created
        ON task_session_messages(orchestration_id, sequence, created_at);

    `);

    const orchestrationColumns = this.database.prepare("PRAGMA table_info(task_session_orchestrations)").all();
    if (!orchestrationColumns.some((column) => column.name === "integration_json")) {
      this.database.exec("ALTER TABLE task_session_orchestrations ADD COLUMN integration_json TEXT");
    }

    // 旧版本没有保存消息顶层 lifecycle state；nullable 列让旧记录可继续读取，
    // 同时为显式状态的幂等重试保留不可歧义的 envelope 证据。
    const taskSessionMessageColumns = this.database.prepare("PRAGMA table_info(task_session_messages)").all();
    if (!taskSessionMessageColumns.some((column) => column.name === "state")) {
      this.database.exec("ALTER TABLE task_session_messages ADD COLUMN state TEXT");
    }

    const projectColumns = this.database.prepare("PRAGMA table_info(projects)").all();
    if (!projectColumns.some((column) => column.name === "workspace_path")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN workspace_path TEXT");
    }

    const aiChatThreadColumns = this.database.prepare("PRAGMA table_info(ai_chat_threads)").all();
    for (const column of [
      "origin_codex_project_id",
      "origin_codex_project_kind",
      "origin_codex_host_id",
    ]) {
      if (!aiChatThreadColumns.some((candidate) => candidate.name === column)) {
        this.database.exec(`ALTER TABLE ai_chat_threads ADD COLUMN ${column} TEXT`);
      }
    }

    const taskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const hasWorkflowId = taskColumns.some((column) => column.name === "workflow_id");
    if (hasWorkflowId) {
      this.database.exec("ALTER TABLE tasks DROP COLUMN workflow_id");
    }
    this.database.exec("DROP TABLE IF EXISTS workflow_workspaces");
    const hasThreadId = taskColumns.some((column) => column.name === "thread_id");
    const hasLinkedThreadId = taskColumns.some((column) => column.name === "linked_thread_id");
    if (!hasThreadId) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN thread_id TEXT");
    }
    for (const column of [
      "thread_codex_project_id",
      "thread_codex_project_kind",
      "thread_codex_host_id",
      "thread_workspace_path",
    ]) {
      if (!taskColumns.some((candidate) => candidate.name === column)) {
        this.database.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
      }
    }
    if (hasLinkedThreadId) {
      this.database.exec(`
        UPDATE tasks
        SET thread_id = COALESCE(thread_id, linked_thread_id)
      `);
      this.database.exec("ALTER TABLE tasks DROP COLUMN linked_thread_id");
    }
    if (!taskColumns.some((column) => column.name === "git_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN git_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_path")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "due_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT");
    }
    if (!taskColumns.some((column) => column.name === "start_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN start_date TEXT");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_interval")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_interval INTEGER");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_unit")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_unit TEXT");
    }
    if (!taskColumns.some((column) => column.name === "timer_paused")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN timer_paused INTEGER NOT NULL DEFAULT 0");
    }
    if (!taskColumns.some((column) => column.name === "jira_status_override")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN jira_status_override INTEGER NOT NULL DEFAULT 0");
    }
    if (!taskColumns.some((column) => column.name === "jira_remote_status_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN jira_remote_status_id TEXT");
    }
    this.#migrateTaskStatuses();
    const migratedTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    if (!migratedTaskColumns.some((column) => column.name === "creator_type")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_id TEXT NOT NULL DEFAULT 'local-user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_name")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_name TEXT NOT NULL DEFAULT '本地用户'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_avatar_url")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_avatar_url TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_source")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_source TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_id TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_origin")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_origin TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_key")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_key TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "external_url")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN external_url TEXT");
    }
    this.database.exec(`
      DROP INDEX IF EXISTS tasks_external_source_id;
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_external_source_origin_id
      ON tasks(external_source, external_origin, external_id)
      WHERE external_source IS NOT NULL AND external_origin IS NOT NULL AND external_id IS NOT NULL
    `);
    this.database.exec(`
      UPDATE tasks
      SET creator_type = 'agent', creator_id = 'codex-agent', creator_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND version = 1 AND creator_id = 'local-user'
    `);
    const identityTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const assigneeMigrations = [
      ["assignee_type", "TEXT CHECK (assignee_type IN ('user', 'agent'))", "creator_type"],
      ["assignee_id", "TEXT", "creator_id"],
      ["assignee_name", "TEXT", "creator_name"],
      ["assignee_avatar_url", "TEXT", "creator_avatar_url"],
    ].filter(([column]) => !identityTaskColumns.some((current) => current.name === column));
    if (assigneeMigrations.length > 0) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const [column, definition, source] of assigneeMigrations) {
          this.database.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
          this.database.exec(`UPDATE tasks SET ${column} = ${source}`);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    if (!projectColumns.some((column) => column.name === "labels")) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(`
          ALTER TABLE projects
          ADD COLUMN labels TEXT NOT NULL DEFAULT '${DEFAULT_PROJECT_LABELS_JSON}'
        `);
        const labelsByProject = new Map(
          this.database.prepare("SELECT id FROM projects").all().map((project) => (
            [project.id, [...DEFAULT_LABEL_NAMES]]
          )),
        );
        for (const task of this.database.prepare(`
          SELECT project_id, labels
          FROM tasks
          ORDER BY created_at, id
        `).all()) {
          const projectLabels = labelsByProject.get(task.project_id);
          if (!projectLabels) continue;
          for (const label of JSON.parse(task.labels)) {
            if (!projectLabels.includes(label)) projectLabels.push(label);
          }
        }
        const updateProjectLabels = this.database.prepare(`
          UPDATE projects SET labels = ? WHERE id = ?
        `);
        for (const [projectId, labels] of labelsByProject) {
          updateProjectLabels.run(JSON.stringify(labels), projectId);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at)
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_relations (
        relation_type TEXT NOT NULL CHECK (relation_type IN ('parent', 'blocks', 'related')),
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'mention')),
        created_at TEXT NOT NULL,
        CHECK (source_task_id <> target_task_id),
        CHECK (relation_type <> 'related' OR source_task_id < target_task_id),
        PRIMARY KEY (relation_type, source_task_id, target_task_id)
      );

      CREATE INDEX IF NOT EXISTS task_relations_target
        ON task_relations(relation_type, target_task_id);

      CREATE UNIQUE INDEX IF NOT EXISTS task_relations_one_parent
        ON task_relations(target_task_id)
        WHERE relation_type = 'parent';

      CREATE TRIGGER IF NOT EXISTS task_relations_require_same_project
      BEFORE INSERT ON task_relations
      BEGIN
        SELECT RAISE(ABORT, 'CROSS_PROJECT_RELATION')
        WHERE EXISTS (
          SELECT 1
          FROM tasks AS source
          JOIN tasks AS target ON target.id = NEW.target_task_id
          WHERE source.id = NEW.source_task_id
            AND source.project_id != target.project_id
        );
      END;

      CREATE TRIGGER IF NOT EXISTS task_relations_prevent_parent_cycle
      BEFORE INSERT ON task_relations
      WHEN NEW.relation_type = 'parent'
      BEGIN
        SELECT RAISE(ABORT, 'RELATION_CYCLE')
        WHERE EXISTS (
          WITH RECURSIVE ancestors(id) AS (
            SELECT source_task_id
            FROM task_relations
            WHERE relation_type = 'parent' AND target_task_id = NEW.source_task_id
            UNION
            SELECT task_relations.source_task_id
            FROM task_relations
            JOIN ancestors ON task_relations.target_task_id = ancestors.id
            WHERE task_relations.relation_type = 'parent'
          )
          SELECT 1 FROM ancestors WHERE id = NEW.target_task_id
        );
      END;
    `);

    const taskRelationColumns = this.database.prepare("PRAGMA table_info(task_relations)").all();
    if (!taskRelationColumns.some((column) => column.name === "origin")) {
      this.database.exec(`
        ALTER TABLE task_relations
        ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'
          CHECK (origin IN ('manual', 'mention'))
      `);
    }

    const commentColumns = this.database.prepare("PRAGMA table_info(comments)").all();
    if (!commentColumns.some((column) => column.name === "thread_id")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN thread_id TEXT");
    }
    for (const column of [
      "thread_codex_project_id",
      "thread_codex_project_kind",
      "thread_codex_host_id",
      "thread_workspace_path",
    ]) {
      if (!commentColumns.some((candidate) => candidate.name === column)) {
        this.database.exec(`ALTER TABLE comments ADD COLUMN ${column} TEXT`);
      }
    }
    if (!commentColumns.some((column) => column.name === "author_type")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!commentColumns.some((column) => column.name === "author_avatar_url")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_avatar_url TEXT");
    }
    if (!commentColumns.some((column) => column.name === "change_revision")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0");
    }
    this.database.exec(`
      UPDATE comments
      SET author_type = 'agent', author_id = 'codex-agent', author_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND author_id = 'local'
    `);
    this.database.exec(`
      UPDATE comments
      SET author_id = 'local-user'
      WHERE author_id = 'local'
    `);

    const hasTaskThreads = this.database.prepare(`
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_threads'
    `).get();
    if (hasTaskThreads) {
      this.database.exec(`
        UPDATE tasks AS migrated_task
        SET thread_id = COALESCE(thread_id, (
          SELECT task_threads.thread_id
          FROM task_threads
          LEFT JOIN comments
            ON comments.task_id = task_threads.task_id
            AND comments.thread_id = task_threads.thread_id
          WHERE task_threads.task_id = migrated_task.id
          ORDER BY
            CASE WHEN comments.id IS NOT NULL THEN 1 ELSE 0 END,
            task_threads.created_at DESC,
            task_threads.thread_id DESC
          LIMIT 1
        ))
        WHERE thread_id IS NULL
      `);
      this.database.exec("DROP TABLE task_threads");
    }

    const attachmentColumns = this.database.prepare("PRAGMA table_info(attachments)").all();
    if (!attachmentColumns.some((column) => column.name === "comment_id")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE");
    }
    if (!attachmentColumns.some((column) => column.name === "kind")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'attachment' CHECK (kind IN ('inline', 'attachment'))");
      this.database.exec(`
        UPDATE attachments
        SET kind = 'inline'
        WHERE content_type LIKE 'image/%'
          AND (
            (
              comment_id IS NULL
              AND EXISTS (
                SELECT 1 FROM tasks
                WHERE tasks.id = attachments.task_id
                  AND instr(tasks.description, 'api/attachments/' || attachments.id || '/content') > 0
              )
            )
            OR (
              comment_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM comments
                WHERE comments.id = attachments.comment_id
                  AND instr(comments.body, 'api/attachments/' || attachments.id || '/content') > 0
              )
            )
          )
      `);
    }
    if (!attachmentColumns.some((column) => column.name === "change_revision")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN change_revision INTEGER NOT NULL DEFAULT 0");
    }
    this.database.exec("CREATE INDEX IF NOT EXISTS comments_task_change_revision ON comments(task_id, change_revision)");
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_comment_created ON attachments(comment_id, created_at, id)");
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_task_change_revision ON attachments(task_id, change_revision) WHERE comment_id IS NULL");
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_comment_change_revision ON attachments(comment_id, change_revision) WHERE comment_id IS NOT NULL");
    const maxChangeRevision = this.database.prepare(`
      SELECT MAX(change_revision) AS value
      FROM (
        SELECT change_revision FROM comments
        UNION ALL
        SELECT change_revision FROM attachments
      )
    `).get().value ?? 0;
    this.database.prepare(`
      INSERT INTO comment_attachment_revision (id, value)
      VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET value = MAX(value, excluded.value)
    `).run(maxChangeRevision);

    const timestamp = now();
    this.database.prepare(`
      INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
      VALUES ('local', '全局', NULL, 1, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(timestamp, timestamp);
    this.database.prepare(`
      UPDATE projects
      SET name = '全局', workspace_path = NULL, updated_at = ?
      WHERE id = 'local' AND (name != '全局' OR workspace_path IS NOT NULL)
    `).run(timestamp);
  }

  #initializeTaskTimers() {
    const timestamp = now();
    const tasks = this.database.prepare(`
      SELECT tasks.id, tasks.project_id, projects.name AS project_name
      FROM tasks
      JOIN projects ON projects.id = tasks.project_id
      WHERE tasks.status = 'in_progress'
        AND tasks.archived_at IS NULL
        AND tasks.timer_paused = 0
        AND NOT EXISTS (
          SELECT 1 FROM task_time_entries
          WHERE task_time_entries.task_id = tasks.id
            AND task_time_entries.ended_at IS NULL
        )
    `).all();
    for (const task of tasks) {
      // 进行中的片段跨 App 生命周期保存；首次升级只从功能初始化时刻开始，不反推历史。
      this.#openTaskTimer(
        task.id,
        task.project_id,
        task.project_name,
        timestamp,
        "feature_initialized",
      );
    }
  }

  #openTaskTimer(taskId, projectId, projectName, timestamp, reason) {
    const active = this.database.prepare(`
      SELECT 1 FROM task_time_entries
      WHERE task_id = ? AND ended_at IS NULL
    `).get(taskId);
    if (active) return;
    this.database.prepare(`
      INSERT INTO task_time_entries (
        id, task_id, project_id, project_name, started_at, ended_at, start_reason, end_reason
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)
    `).run(randomUUID(), taskId, projectId, projectName, timestamp, reason);
  }

  #closeTaskTimer(taskId, timestamp, reason) {
    this.database.prepare(`
      UPDATE task_time_entries
      SET ended_at = ?, end_reason = ?
      WHERE task_id = ? AND ended_at IS NULL
    `).run(timestamp, reason, taskId);
  }

  #transitionTaskTimer({
    taskId,
    beforeStatus,
    afterStatus,
    beforeProjectId,
    afterProjectId,
    afterProjectName,
    paused,
    beforeArchived = false,
    afterArchived = false,
    timestamp,
    reason,
  }) {
    const wasRunning = beforeStatus === "in_progress" && !paused && !beforeArchived;
    const enteredProcessing = beforeStatus !== "in_progress" && afterStatus === "in_progress";
    const leftProcessing = beforeStatus === "in_progress" && afterStatus !== "in_progress";
    const nextPaused = enteredProcessing || leftProcessing || afterArchived ? false : paused;
    const isRunning = afterStatus === "in_progress" && !nextPaused && !afterArchived;
    const projectChanged = beforeProjectId !== afterProjectId;

    if (wasRunning && (!isRunning || projectChanged)) {
      this.#closeTaskTimer(taskId, timestamp, projectChanged ? "project_changed" : reason);
    }
    if (nextPaused !== paused) {
      this.database.prepare("UPDATE tasks SET timer_paused = ? WHERE id = ?")
        .run(nextPaused ? 1 : 0, taskId);
    }
    if (isRunning && (!wasRunning || projectChanged)) {
      // 项目归属快照写在片段上，避免任务后来移动项目时改写历史日报。
      this.#openTaskTimer(
        taskId,
        afterProjectId,
        afterProjectName,
        timestamp,
        projectChanged ? "project_changed" : reason,
      );
    }
  }

  #attachTaskTiming(tasks, reference = new Date()) {
    if (tasks.length === 0) return tasks;
    const date = localDateKey(reference);
    const { start, end } = localDayBounds(date);
    const placeholders = tasks.map(() => "?").join(", ");
    const entries = this.database.prepare(`
      SELECT task_id, started_at, ended_at
      FROM task_time_entries
      WHERE task_id IN (${placeholders})
        AND started_at < ?
        AND (ended_at IS NULL OR ended_at > ?)
      ORDER BY started_at, id
    `).all(...tasks.map((task) => task.id), end.toISOString(), start.toISOString());
    const timingByTask = new Map(tasks.map((task) => [task.id, {
      paused: task.timeTracking.paused,
      date,
      closedSeconds: 0,
      activeStartedAt: null,
    }]));
    for (const entry of entries) {
      const timing = timingByTask.get(entry.task_id);
      if (!timing) continue;
      if (entry.ended_at === null) {
        timing.activeStartedAt = entry.started_at;
      } else {
        timing.closedSeconds += overlapSeconds(entry.started_at, entry.ended_at, start, end);
      }
    }
    for (const task of tasks) task.timeTracking = timingByTask.get(task.id);
    return tasks;
  }

  close() {
    this.database.close();
  }

  #migrateTaskStatuses() {
    const tasksSql = this.database.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'
    `).get()?.sql ?? "";
    if (
      tasksSql.includes("'in_review'")
      && tasksSql.includes("'blocked'")
      && tasksSql.includes("'canceled'")
    ) {
      return;
    }

    this.database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE tasks_status_migration (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL REFERENCES projects(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN (
            'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled'
          )),
          priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
          labels TEXT NOT NULL DEFAULT '[]',
          sort_order REAL NOT NULL,
          thread_id TEXT,
          thread_codex_project_id TEXT,
          thread_codex_project_kind TEXT,
          thread_codex_host_id TEXT,
          thread_workspace_path TEXT,
          git_branch TEXT,
          worktree_path TEXT,
          worktree_branch TEXT,
          start_date TEXT,
          due_date TEXT,
          recurrence_interval INTEGER,
          recurrence_unit TEXT,
          jira_status_override INTEGER NOT NULL DEFAULT 0 CHECK (jira_status_override IN (0, 1)),
          jira_remote_status_id TEXT,
          timer_paused INTEGER NOT NULL DEFAULT 0 CHECK (timer_paused IN (0, 1)),
          archived_at TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO tasks_status_migration (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path, git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          jira_status_override, jira_remote_status_id, timer_paused,
          archived_at, version, created_at, updated_at
        )
        SELECT
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path, git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          jira_status_override, jira_remote_status_id, timer_paused,
          archived_at, version, created_at, updated_at
        FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_status_migration RENAME TO tasks;
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }

    const violation = this.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) {
      throw new Error(`Task status migration produced a foreign key violation in '${violation.table}'`);
    }
  }

  listProjects() {
    return this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at
      ORDER BY projects.created_at, projects.id
    `).all().map(projectFromRow);
  }

  createProject(input) {
    const timestamp = now();
    try {
      this.database.prepare(`
        INSERT INTO projects (
          id, name, workspace_path, labels, next_task_number, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(
        input.id,
        input.name,
        input.workspacePath,
        DEFAULT_PROJECT_LABELS_JSON,
        timestamp,
        timestamp,
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        throw new ApiError(409, "PROJECT_EXISTS", `Project '${input.id}' already exists`);
      }
      throw error;
    }
    return this.getProject(input.id);
  }

  ensureJiraProject(name) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
      VALUES (?, ?, NULL, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
    `).run(JIRA_PROJECT_ID, name, timestamp, timestamp);
    return this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks ON tasks.project_id = projects.id AND tasks.archived_at IS NULL
      WHERE projects.id = ?
      GROUP BY projects.id
    `).get(JIRA_PROJECT_ID);
  }

  syncJiraTasks(issues, { archiveMissing = true, projectName, legacyIdentity = null } = {}) {
    const timestamp = now();
    const seenTaskIds = new Set();
    const projectLabels = JSON.stringify([
      ...new Set(issues.flatMap((issue) => issue.labels)),
    ]);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO projects (id, name, workspace_path, labels, next_task_number, created_at, updated_at)
        VALUES (?, ?, NULL, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          labels = excluded.labels,
          updated_at = excluded.updated_at
      `).run(JIRA_PROJECT_ID, projectName, projectLabels, timestamp, timestamp);
      const findExisting = this.database.prepare(`
        SELECT * FROM tasks
        WHERE external_source = 'jira' AND external_origin = ? AND external_id = ?
      `);
      // 新版数据库会拒绝没有 execution_target 的 todo；旧版 schema 没有该列，保持原有 Jira 状态语义。
      const supportsExecutionTarget = this.database
        .prepare("PRAGMA table_info(tasks)")
        .all()
        .some((column) => column.name === "execution_target");
      const migrateLegacyIdentity = this.database.prepare(`
        UPDATE tasks SET
          identifier = ?, external_origin = ?, external_id = ?, external_key = ?
        WHERE id = ?
      `);
      if (legacyIdentity) {
        const legacyTasks = this.database.prepare(`
          SELECT id, identifier, external_id
          FROM tasks
          WHERE project_id = ?
            AND external_source = 'jira'
            AND external_origin IS NULL
            AND substr(external_id, 1, 17) = ?
            AND id = 'jira:' || external_id
        `).all(JIRA_PROJECT_ID, `${legacyIdentity.urlHash}:`);
        for (const legacyTask of legacyTasks) {
          const externalId = legacyTask.external_id.slice(17);
          migrateLegacyIdentity.run(
            `JIRA:${legacyIdentity.originId.toUpperCase()}:${externalId}`,
            legacyIdentity.originId,
            externalId,
            legacyTask.identifier,
            legacyTask.id,
          );
        }
      }
      const insertTask = this.database.prepare(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          external_source, external_origin, external_id, external_key, external_url,
          jira_status_override, jira_remote_status_id,
          archived_at, version, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, NULL, NULL, NULL, NULL, NULL,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          NULL, NULL, NULL,
          NULL, ?, NULL, NULL,
          'jira', ?, ?, ?, ?,
          0, ?,
          NULL, 1, ?, ?
        )
      `);
      const updateTask = this.database.prepare(`
        UPDATE tasks SET
          identifier = ?, title = ?, description = ?, status = ?, priority = ?, labels = ?,
          sort_order = ?, creator_type = ?, creator_id = ?, creator_name = ?, creator_avatar_url = ?,
          assignee_type = ?, assignee_id = ?, assignee_name = ?, assignee_avatar_url = ?,
          due_date = ?, external_origin = ?, external_id = ?, external_key = ?, external_url = ?,
          jira_status_override = ?, jira_remote_status_id = ?,
          archived_at = NULL,
          version = version + 1, updated_at = ?
        WHERE id = ?
      `);

      for (const issue of issues) {
        const existing = findExisting.get(issue.externalOrigin, issue.externalId);
        const persistedStatus = supportsExecutionTarget
          && issue.status === "todo"
          && existing?.execution_target == null
          ? "backlog"
          : issue.status;
        seenTaskIds.add(existing?.id ?? issue.id);
        const labels = JSON.stringify(issue.labels);
        if (!existing) {
          insertTask.run(
            issue.id,
            issue.identifier,
            JIRA_PROJECT_ID,
            issue.title,
            issue.description,
            persistedStatus,
            issue.priority,
            labels,
            issue.sortOrder,
            issue.creator.type,
            issue.creator.id,
            issue.creator.name,
            issue.creator.avatarUrl,
            issue.assignee.type,
            issue.assignee.id,
            issue.assignee.name,
            issue.assignee.avatarUrl,
            issue.dueDate,
            issue.externalOrigin,
            issue.externalId,
            issue.externalKey,
            issue.externalUrl,
            issue.externalStatusId,
            issue.createdAt,
            issue.updatedAt,
          );
          if (issue.status === "in_progress") {
            this.#openTaskTimer(
              issue.id,
              JIRA_PROJECT_ID,
              projectName,
              timestamp,
              "jira_sync",
            );
          }
          continue;
        }

        const remoteStatusChanged = existing.jira_remote_status_id !== issue.externalStatusId;
        // 本地覆盖只在远端状态未变化时有效；Jira 上的人工流转会恢复远端权威。
        const preserveStatusOverride = existing.jira_status_override === 1 && !remoteStatusChanged;
        const nextStatus = preserveStatusOverride ? existing.status : persistedStatus;
        const nextStatusOverride = preserveStatusOverride ? 1 : 0;
        const changed = existing.identifier !== issue.identifier
          || existing.title !== issue.title
          || existing.description !== issue.description
          || existing.status !== nextStatus
          || existing.priority !== issue.priority
          || existing.labels !== labels
          || existing.sort_order !== issue.sortOrder
          || existing.creator_type !== issue.creator.type
          || existing.creator_id !== issue.creator.id
          || existing.creator_name !== issue.creator.name
          || existing.creator_avatar_url !== issue.creator.avatarUrl
          || existing.assignee_type !== issue.assignee.type
          || existing.assignee_id !== issue.assignee.id
          || existing.assignee_name !== issue.assignee.name
          || existing.assignee_avatar_url !== issue.assignee.avatarUrl
          || existing.due_date !== issue.dueDate
          || existing.external_origin !== issue.externalOrigin
          || existing.external_id !== issue.externalId
          || existing.external_key !== issue.externalKey
          || existing.external_url !== issue.externalUrl
          || existing.jira_status_override !== nextStatusOverride
          || existing.jira_remote_status_id !== issue.externalStatusId
          || existing.archived_at !== null;
        if (!changed) continue;
        updateTask.run(
          issue.identifier,
          issue.title,
          issue.description,
          nextStatus,
          issue.priority,
          labels,
          issue.sortOrder,
          issue.creator.type,
          issue.creator.id,
          issue.creator.name,
          issue.creator.avatarUrl,
          issue.assignee.type,
          issue.assignee.id,
          issue.assignee.name,
          issue.assignee.avatarUrl,
          issue.dueDate,
          issue.externalOrigin,
          issue.externalId,
          issue.externalKey,
          issue.externalUrl,
          nextStatusOverride,
          issue.externalStatusId,
          issue.updatedAt,
          existing.id,
        );
        this.#transitionTaskTimer({
          taskId: existing.id,
          beforeStatus: existing.status,
          afterStatus: nextStatus,
          beforeProjectId: JIRA_PROJECT_ID,
          afterProjectId: JIRA_PROJECT_ID,
          afterProjectName: projectName,
          paused: existing.timer_paused === 1,
          beforeArchived: existing.archived_at !== null,
          afterArchived: false,
          timestamp,
          reason: "jira_sync",
        });
      }

      if (archiveMissing) {
        const existingTasks = this.database.prepare(`
          SELECT id, status, timer_paused FROM tasks
          WHERE project_id = ? AND external_source = 'jira' AND archived_at IS NULL
        `).all(JIRA_PROJECT_ID);
        const archiveTask = this.database.prepare(`
          UPDATE tasks
          SET archived_at = ?, version = version + 1, updated_at = ?
          WHERE id = ?
        `);
        for (const task of existingTasks) {
          if (!seenTaskIds.has(task.id)) {
            archiveTask.run(timestamp, timestamp, task.id);
            this.#transitionTaskTimer({
              taskId: task.id,
              beforeStatus: task.status,
              afterStatus: task.status,
              beforeProjectId: JIRA_PROJECT_ID,
              afterProjectId: JIRA_PROJECT_ID,
              afterProjectName: projectName,
              paused: task.timer_paused === 1,
              beforeArchived: false,
              afterArchived: true,
              timestamp,
              reason: "jira_archived",
            });
          }
        }
      }
      this.database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
        .run(timestamp, JIRA_PROJECT_ID);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  deleteProject(id) {
    const project = this.getProject(id);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
    }
    if (!id.startsWith("temp-")) {
      throw new ApiError(403, "PROJECT_DELETE_FORBIDDEN", "Only manually created projects can be deleted");
    }
    const result = this.database.prepare(`
      DELETE FROM projects
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE project_id = ?)
    `).run(id, id);
    if (result.changes !== 1) {
      const issueCount = Number(this.database.prepare(`
        SELECT COUNT(*) AS issue_count FROM tasks WHERE project_id = ?
      `).get(id).issue_count);
      throw new ApiError(409, "PROJECT_NOT_EMPTY", "Project still contains issues", { issueCount });
    }
    return project;
  }

  getProject(id) {
    const row = this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      WHERE projects.id = ?
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.labels,
        projects.created_at,
        projects.updated_at
    `).get(id);
    return row ? projectFromRow(row) : null;
  }

  addProjectLabel(projectId, label) {
    const project = this.database.prepare("SELECT labels FROM projects WHERE id = ?").get(projectId);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const labels = JSON.parse(project.labels);
    if (!labels.includes(label)) {
      this.database.prepare(`
        UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify([...labels, label]), now(), projectId);
    }
    return this.getProject(projectId);
  }

  deleteProjectLabel(projectId, label) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.database.prepare("SELECT labels FROM projects WHERE id = ?").get(projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const timestamp = now();
      const labels = JSON.parse(project.labels);
      if (labels.includes(label)) {
        this.database.prepare(`
          UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(labels.filter((current) => current !== label)), timestamp, projectId);
      }
      const updateTask = this.database.prepare(`
        UPDATE tasks
        SET labels = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `);
      for (const task of this.database.prepare(`
        SELECT id, labels FROM tasks WHERE project_id = ?
      `).all(projectId)) {
        const taskLabels = JSON.parse(task.labels);
        if (taskLabels.includes(label)) {
          updateTask.run(
            JSON.stringify(taskLabels.filter((current) => current !== label)),
            timestamp,
            task.id,
          );
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getProject(projectId);
  }

  getProjectSummary(projectId) {
    const row = this.database.prepare(`
      SELECT project_id, summary, generated_at, attempted_at, error
      FROM project_summaries
      WHERE project_id = ?
    `).get(projectId);
    return row ? projectSummaryFromRow(row) : {
      projectId,
      summary: null,
      generatedAt: null,
      attemptedAt: null,
      error: null,
    };
  }

  listProjectSummaries() {
    return this.database.prepare(`
      SELECT project_id, summary, generated_at, attempted_at, error
      FROM project_summaries
      ORDER BY project_id
    `).all().map(projectSummaryFromRow);
  }

  saveProjectSummary(projectId, summary) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO project_summaries (
        project_id, summary, generated_at, attempted_at, error
      ) VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(project_id) DO UPDATE SET
        summary = excluded.summary,
        generated_at = excluded.generated_at,
        attempted_at = excluded.attempted_at,
        error = NULL
    `).run(projectId, summary, timestamp, timestamp);
    return this.getProjectSummary(projectId);
  }

  saveProjectSummaryError(projectId, error) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO project_summaries (
        project_id, summary, generated_at, attempted_at, error
      ) VALUES (?, NULL, NULL, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        attempted_at = excluded.attempted_at,
        error = excluded.error
    `).run(projectId, timestamp, error);
    return this.getProjectSummary(projectId);
  }

  getProjectReadme(projectId) {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const row = this.database.prepare(`
      SELECT project_id, content, version, created_at, updated_at
      FROM project_readmes
      WHERE project_id = ?
    `).get(projectId);
    return row
      ? projectReadmeFromRow(row, projectId)
      : { projectId, content: "", version: 0, createdAt: null, updatedAt: null };
  }

  saveProjectReadme(projectId, content, expectedVersion) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const current = this.database.prepare(`
        SELECT version FROM project_readmes WHERE project_id = ?
      `).get(projectId);
      if (expectedVersion !== undefined) {
        const actualVersion = current?.version ?? 0;
        if (actualVersion !== expectedVersion) {
          throw new ApiError(409, "VERSION_CONFLICT", "Project README changed since it was last read", {
            expectedVersion,
            actualVersion,
          });
        }
      }
      if (current) {
        const versionCondition = expectedVersion !== undefined ? " AND version = ?" : "";
        const params = expectedVersion !== undefined
          ? [content, timestamp, projectId, expectedVersion]
          : [content, timestamp, projectId];
        this.database.prepare(`
          UPDATE project_readmes
          SET content = ?, version = version + 1, updated_at = ?
          WHERE project_id = ?${versionCondition}
        `).run(...params);
      } else {
        this.database.prepare(`
          INSERT INTO project_readmes (project_id, content, version, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?)
        `).run(projectId, content, timestamp, timestamp);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getProjectReadme(projectId);
  }

  createProjectReadmeAttachment(projectId, input) {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    this.database.prepare(`
      INSERT INTO project_readme_attachments (
        id, project_id, filename, content_type, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      projectId,
      input.filename,
      input.contentType,
      input.size,
      now(),
    );
    return this.getProjectReadmeAttachment(input.id);
  }

  getProjectReadmeAttachment(id) {
    const row = this.database.prepare(`
      SELECT * FROM project_readme_attachments WHERE id = ?
    `).get(id);
    return row ? projectReadmeAttachmentFromRow(row) : null;
  }

  listAiChatThreads() {
    const rows = this.database.prepare(`
      SELECT * FROM ai_chat_threads
      ORDER BY updated_at DESC, id
    `).all();
    if (rows.length === 0) return [];

    const currentRuns = new Map();
    for (const row of this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE status = 'running'
      ORDER BY thread_id, started_at DESC, id DESC
    `).all()) {
      if (!currentRuns.has(row.thread_id)) currentRuns.set(row.thread_id, aiChatRunFromRow(row));
    }

    const latestTodos = new Map();
    for (const row of this.database.prepare(`
      SELECT id, thread_id, run_id, data, created_at
      FROM ai_chat_events
      WHERE type = 'todo_list'
      ORDER BY thread_id, created_at DESC, rowid DESC
    `).all()) {
      if (latestTodos.has(row.thread_id)) continue;
      const currentRun = currentRuns.get(row.thread_id);
      if (currentRun && row.run_id !== currentRun.id) continue;
      const progress = parseAiChatTodoProgress(row);
      if (progress) latestTodos.set(row.thread_id, progress);
    }

    return rows.map((row) => {
      const thread = aiChatThreadFromRow(row);
      thread.currentRun = currentRuns.get(thread.id) ?? null;
      thread.latestTodo = latestTodos.get(thread.id) ?? null;
      return thread;
    });
  }

  getAiChatThread(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_threads WHERE id = ?").get(id);
    return row ? this.#aiChatThreadWithCurrentRun(row) : null;
  }

  hasAiChatThreadProjectConflict(issueRef, projectId) {
    return Boolean(this.database.prepare(`
      SELECT 1
      FROM ai_chat_threads
      WHERE (origin_issue_id = ? OR origin_issue_identifier = ?)
        AND origin_project_id != ?
      LIMIT 1
    `).get(issueRef, issueRef, projectId));
  }

  createAiChatThread(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.database.prepare(`
      INSERT INTO ai_chat_threads (
        id, title, status,
        origin_project_id, origin_project_name, origin_workspace_path,
        origin_codex_project_id, origin_codex_project_kind, origin_codex_host_id,
        origin_issue_id, origin_issue_identifier,
        codex_thread_id, model, reasoning_effort, sandbox,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.status ?? "idle",
      input.origin.projectId,
      input.origin.projectName,
      input.origin.workspacePath,
      input.origin.codexProjectId ?? null,
      input.origin.codexProjectKind ?? null,
      input.origin.codexHostId ?? null,
      input.origin.issueId ?? null,
      input.origin.issueIdentifier ?? null,
      input.codexThreadId ?? null,
      input.model,
      input.reasoningEffort,
      input.sandbox,
      timestamp,
      input.updatedAt ?? timestamp,
    );
    return this.getAiChatThread(id);
  }

  updateAiChatThread(id, changes) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    const columns = {
      title: "title",
      status: "status",
      codexThreadId: "codex_thread_id",
      model: "model",
      reasoningEffort: "reasoning_effort",
      sandbox: "sandbox",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;
    assignments.push("updated_at = ?");
    values.push(changes.updatedAt ?? now(), id);
    this.database.prepare(`
      UPDATE ai_chat_threads SET ${assignments.join(", ")} WHERE id = ?
    `).run(...values);
    return this.getAiChatThread(id);
  }

  deleteAiChatThread(id) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    this.database.prepare("DELETE FROM ai_chat_threads WHERE id = ?").run(id);
    return current;
  }

  listAiChatRuns(threadId) {
    return this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ?
      ORDER BY started_at, id
    `).all(threadId).map(aiChatRunFromRow);
  }

  getAiChatRun(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_runs WHERE id = ?").get(id);
    return row ? aiChatRunFromRow(row) : null;
  }

  createAiChatRun(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.startedAt ?? now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO ai_chat_runs (
          id, thread_id, status, exit_code, error, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.threadId,
        input.status ?? "running",
        input.exitCode ?? null,
        input.error ?? null,
        timestamp,
        input.finishedAt ?? null,
      );
      if ((input.status ?? "running") === "running") {
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = 'running', updated_at = ?
          WHERE id = ?
        `).run(timestamp, input.threadId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
  }

  updateAiChatRun(id, changes) {
    const current = this.getAiChatRun(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${id}' does not exist`);
    }
    const columns = {
      status: "status",
      exitCode: "exit_code",
      error: "error",
      finishedAt: "finished_at",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      values.push(id);
      this.database.prepare(`
        UPDATE ai_chat_runs SET ${assignments.join(", ")} WHERE id = ?
      `).run(...values);
      const status = changes.status ?? current.status;
      if (status !== "running") {
        const threadStatus = status === "failed" ? "failed" : "idle";
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = ?, updated_at = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE thread_id = ? AND status = 'running'
            )
        `).run(threadStatus, changes.finishedAt ?? now(), current.threadId, current.threadId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
  }

  insertAiChatEvent(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.database.prepare(`
      INSERT INTO ai_chat_events (
        id, thread_id, run_id, type, role, content, data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.threadId,
      input.runId ?? null,
      input.type,
      input.role,
      input.content,
      input.data === undefined || input.data === null ? null : JSON.stringify(input.data),
      timestamp,
    );
    const row = this.database.prepare("SELECT * FROM ai_chat_events WHERE id = ?").get(id);
    return aiChatEventFromRow(row);
  }

  listAiChatEvents(threadId) {
    return this.database.prepare(`
      SELECT * FROM ai_chat_events
      WHERE thread_id = ?
      ORDER BY created_at, rowid
    `).all(threadId).map(aiChatEventFromRow);
  }

  interruptAbandonedAiChatRuns() {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE ai_chat_runs
        SET
          status = 'interrupted',
          error = COALESCE(error, 'Taskboard service restarted'),
          finished_at = COALESCE(finished_at, ?)
        WHERE status = 'running'
      `).run(timestamp);
      if (result.changes > 0) {
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = 'idle', updated_at = ?
          WHERE status = 'running'
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE ai_chat_runs.thread_id = ai_chat_threads.id
                AND ai_chat_runs.status = 'running'
            )
        `).run(timestamp);
      }
      this.database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 编排记录是主子会话关系的持久主键，窗口关闭后仍可据此恢复。
  getTaskSessionOrchestration(id) {
    const row = this.database.prepare(`
      SELECT * FROM task_session_orchestrations WHERE id = ?
    `).get(id);
    return row ? taskSessionOrchestrationFromRow(row) : null;
  }

  // 读取任务当前唯一可继续的编排；done 记录保留作审计但不阻塞新编排。
  getActiveTaskSessionOrchestration(taskId) {
    const row = this.database.prepare(`
      SELECT * FROM task_session_orchestrations
      WHERE task_id = ? AND state != 'done'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(taskId);
    return row ? taskSessionOrchestrationFromRow(row) : null;
  }

  // 返回本地已同步的任务、评论和附件快照；digest 不包含抓取时间，便于稳定比较。
  getTaskSessionSourceSnapshot(taskId) {
    const task = this.getTask(taskId);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
    }
    const sourceRow = this.database.prepare(`
      SELECT jira_remote_status_id FROM tasks WHERE id = ?
    `).get(task.id);
    const comments = this.listComments(task.id).map((comment) => ({
      id: comment.id,
      body: comment.body,
      authorId: comment.authorId,
      authorName: comment.authorName,
      version: comment.version,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      attachmentIds: comment.attachments.map((attachment) => attachment.id),
    }));
    const attachments = this.listAttachments(task.id).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      commentId: attachment.commentId,
      createdAt: attachment.createdAt,
    }));
    const snapshot = {
      originId: task.externalOrigin,
      issueKey: task.externalKey ?? task.identifier,
      taskId: task.id,
      fetchedAt: now(),
      task: {
        identifier: task.identifier,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        labels: task.labels,
        version: task.version,
        updatedAt: task.updatedAt,
        jiraRemoteStatusId: sourceRow?.jira_remote_status_id ?? null,
      },
      comments,
      attachments,
    };
    return { snapshot, digest: taskSessionSourceDigest(snapshot) };
  }

  // 创建或复用任务的 active 编排，并在同一事务中记录初始快照事件。
  createTaskSessionOrchestration(taskId, input = {}) {
    const task = this.#requireTask(taskId);
    const timestamp = input.createdAt ?? now();
    const suppliedSourceSnapshot = input.sourceSnapshot;
    const suppliedCaptureDigest = input.intentDigest ?? input.captureDigest;
    const sourceAtStart = this.getTaskSessionSourceSnapshot(task.id);
    const source = suppliedSourceSnapshot === undefined || suppliedSourceSnapshot === null
      ? taskSessionValidatedCurrentCapture(sourceAtStart, suppliedCaptureDigest)
      : taskSessionValidatedSourceCapture(
        suppliedSourceSnapshot,
        suppliedCaptureDigest,
        sourceAtStart,
      );
    const parentBinding = input.parentThreadBinding ?? input.parentBinding ?? null;
    const state = input.state
      ?? (parentBinding ? "intent_draft" : "unbound");
    this.#assertTaskSessionState(state);
    if (!(state === "unbound" || state === "intent_draft")) {
      throw new ApiError(
        409,
        "INVALID_STATE_TRANSITION",
        "A new orchestration must start unbound or with an intent draft",
        { state },
      );
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(`
        SELECT * FROM task_session_orchestrations
        WHERE task_id = ? AND state != 'done'
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `).get(task.id);
      if (existing) {
        if (
          existing.parent_thread_json
          && parentBinding?.threadId
          && taskSessionJsonThreadId(existing.parent_thread_json) !== parentBinding.threadId
        ) {
          throw new ApiError(
            409,
            "PARENT_THREAD_MISMATCH",
            "This task orchestration is already bound to a different parent thread",
            { parentThreadId: taskSessionJsonThreadId(existing.parent_thread_json) },
          );
        }
        if (
          existing.parent_thread_json
          && parentBinding?.threadId
          && taskSessionJsonThreadId(existing.parent_thread_json) === parentBinding.threadId
        ) {
          // 同一 thread 的重试可只带 ID；完整身份只补齐存量缺失字段，已存在字段仍按冲突校验。
          const existingOrchestration = taskSessionOrchestrationFromRow(existing);
          this.#assertTaskSessionBinding(
            existingOrchestration,
            { parentThreadBinding: parentBinding },
          );
          const mergedParentBinding = taskSessionBindingWithMissingIdentity(
            existingOrchestration.parentThreadBinding,
            parentBinding,
          );
          const parentBindingEnriched = JSON.stringify(mergedParentBinding)
            !== JSON.stringify(existingOrchestration.parentThreadBinding);
          if (parentBindingEnriched) {
            const updatedAt = input.updatedAt ?? timestamp;
            this.database.prepare(`
              UPDATE task_session_orchestrations
              SET parent_thread_json = ?, version = version + 1, updated_at = ?
              WHERE id = ?
            `).run(JSON.stringify(mergedParentBinding), updatedAt, existing.id);
            this.#appendTaskSessionMessageInTransaction({
              id: existing.id,
              direction: "internal",
              type: "parent_bound",
              idempotencyKey: `parent-bound:${existing.id}:${existing.version + 1}`,
              payload: {
                parentThreadBinding: mergedParentBinding,
                state: existing.state,
              },
              deliveryState: "acknowledged",
              createdAt: timestamp,
            });
            this.database.exec("COMMIT");
            return this.getTaskSessionOrchestration(existing.id);
          }
        }
        // 首次请求可能先落下 unbound 记录，等宿主完成主 thread handshake 后再补绑；
        // 绑定与状态变更必须和 parent_bound 审计事件处于同一事务，避免留下半条关系。
        if (!existing.parent_thread_json && parentBinding) {
          const parentConflict = this.database.prepare(`
            SELECT id FROM task_session_orchestrations
            WHERE state != 'done'
              AND json_extract(parent_thread_json, '$.threadId') = ?
              AND id != ?
            LIMIT 1
          `).get(parentBinding.threadId, existing.id);
          if (parentConflict) {
            throw new ApiError(
              409,
              "PARENT_THREAD_ALREADY_BOUND",
              "A parent thread can only manage one active task orchestration",
              { orchestrationId: parentConflict.id },
            );
          }
          const existingIntent = taskSessionArray(existing.intent_json);
          const nextState = existing.state === "unbound" && existingIntent.length > 0
            ? "intent_draft"
            : existing.state;
          const updatedAt = input.updatedAt ?? timestamp;
          this.database.prepare(`
            UPDATE task_session_orchestrations
            SET state = ?, parent_thread_json = ?, version = version + 1, updated_at = ?
            WHERE id = ?
          `).run(nextState, JSON.stringify(parentBinding), updatedAt, existing.id);
          this.#appendTaskSessionMessageInTransaction({
            id: existing.id,
            direction: "internal",
            type: "parent_bound",
            idempotencyKey: `parent-bound:${existing.id}:${existing.version + 1}`,
            payload: { parentThreadBinding: parentBinding, state: nextState },
            deliveryState: "acknowledged",
            createdAt: timestamp,
          });
          this.database.exec("COMMIT");
          return this.getTaskSessionOrchestration(existing.id);
        }
        this.database.exec("COMMIT");
        return taskSessionOrchestrationFromRow(existing);
      }
      if (parentBinding?.threadId) {
        const parentConflict = this.database.prepare(`
          SELECT id FROM task_session_orchestrations
          WHERE state != 'done'
            AND json_extract(parent_thread_json, '$.threadId') = ?
          LIMIT 1
        `).get(parentBinding.threadId);
        if (parentConflict) {
          throw new ApiError(
            409,
            "PARENT_THREAD_ALREADY_BOUND",
            "A parent thread can only manage one active task orchestration",
            { orchestrationId: parentConflict.id },
          );
        }
      }
      // 创建前的快照可能在等待事务期间变化；只把锁内重新验证过的投影写入 active 记录。
      const sourceAtCommit = this.getTaskSessionSourceSnapshot(task.id);
      const committedSource = suppliedSourceSnapshot === undefined || suppliedSourceSnapshot === null
        ? taskSessionValidatedCurrentCapture(sourceAtCommit, suppliedCaptureDigest)
        : taskSessionValidatedSourceCapture(
          suppliedSourceSnapshot,
          suppliedCaptureDigest,
          sourceAtCommit,
        );
      const intent = input.intent
        ? this.#taskSessionIntentRevision(input.intent, 1, committedSource.digest, timestamp)
        : null;
      const id = input.id ?? randomUUID();
      this.database.prepare(`
        INSERT INTO task_session_orchestrations (
          id, task_id, state, parent_thread_json, child_thread_json, child_window_json,
          runtime_json, worktree_json, intent_json, source_snapshot_json, intent_digest,
          current_result_revision, result_json, review_json, writeback_json,
          confirmed_intent_version, confirmed_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 0, '[]', NULL, NULL, NULL, NULL, 1, ?, ?)
      `).run(
        id,
        task.id,
        state,
        parentBinding ? JSON.stringify(parentBinding) : null,
        input.runtime === undefined ? null : JSON.stringify(input.runtime),
        input.worktree === undefined ? null : JSON.stringify(input.worktree),
        intent ? JSON.stringify([intent]) : "[]",
        JSON.stringify(committedSource.snapshot),
        committedSource.digest,
        timestamp,
        input.updatedAt ?? timestamp,
      );
      this.#appendTaskSessionMessageInTransaction({
        id,
        direction: "internal",
        type: "orchestration_created",
        idempotencyKey: `orchestration:${id}`,
        payload: {
          state,
          parentThreadBinding: parentBinding,
          intentVersion: intent?.revision ?? 0,
          captureDigest: committedSource.digest,
        },
        deliveryState: "acknowledged",
        createdAt: timestamp,
      });
      if (intent) {
        this.#appendTaskSessionMessageInTransaction({
          id,
          direction: "internal",
          type: "snapshot_captured",
          idempotencyKey: `snapshot:${id}:${committedSource.digest}`,
          payload: { captureDigest: committedSource.digest, fetchedAt: committedSource.snapshot.fetchedAt },
          deliveryState: "acknowledged",
          createdAt: timestamp,
        });
      }
      this.database.exec("COMMIT");
      return this.getTaskSessionOrchestration(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (
        String(error?.message).includes("task_session_orchestrations_one_active")
        || /UNIQUE constraint failed: task_session_orchestrations\.task_id/.test(String(error?.message))
      ) {
        const active = this.getActiveTaskSessionOrchestration(task.id);
        if (!active) throw error;
        if (parentBinding?.threadId && active.parentThreadBinding?.threadId) {
          if (active.parentThreadBinding.threadId !== parentBinding.threadId) {
            throw new ApiError(
              409,
              "PARENT_THREAD_MISMATCH",
              "This task orchestration is already bound to a different parent thread",
              { parentThreadId: active.parentThreadBinding.threadId },
            );
          }
          // 唯一索引冲突后的重试重新走 active 分支，才能补齐竞争请求遗漏的
          // project/host/workspace 身份；父 thread 不一致时不能借此覆盖已有关系。
          this.#assertTaskSessionBinding(active, { parentThreadBinding: parentBinding });
          return this.createTaskSessionOrchestration(task.id, input);
        } else if (parentBinding?.threadId && !active.parentThreadBinding) {
          // 竞争请求可能先提交 unbound 记录；重新走 active 分支以原子补绑 parent。
          return this.createTaskSessionOrchestration(task.id, input);
        }
        return active;
      }
      throw error;
    }
  }

  // 保存新的不可变意图版本；旧版本仍保留，便于结果与来源快照审计。
  saveTaskSessionIntent(id, input = {}) {
    const current = this.#requireTaskSessionOrchestration(id);
    this.#assertTaskSessionMutable(current);
    // 已绑定编排只能由对应主会话修改；尚未完成 handshake 的 unbound 记录保留无参兼容。
    this.#assertTaskSessionBinding(current, input, {
      requireParent: Boolean(current.parentThreadBinding?.threadId),
    });
    if (!TASK_SESSION_INTENT_STATES.has(current.state)) {
      throw new ApiError(
        409,
        "INVALID_STATE_TRANSITION",
        "An intent can only be saved before the task session is dispatched",
        { state: current.state },
      );
    }
    const timestamp = input.createdAt ?? now();
    const suppliedSourceSnapshot = input.sourceSnapshot;
    const hasSuppliedSourceSnapshot = suppliedSourceSnapshot !== undefined && suppliedSourceSnapshot !== null;
    const suppliedCaptureDigest = input.captureDigest ?? input.intentDigest;
    // 尽早拒绝明显格式错误；事务内还会基于锁内读取再次校验摘要和来源新鲜度。
    if (hasSuppliedSourceSnapshot && !taskSessionPlainObject(suppliedSourceSnapshot)) {
      throw new ApiError(400, "INVALID_FIELD", "sourceSnapshot must be an object");
    }
    if (
      suppliedCaptureDigest !== undefined
      && suppliedCaptureDigest !== null
      && (typeof suppliedCaptureDigest !== "string" || suppliedCaptureDigest.trim().length === 0)
    ) {
      throw new ApiError(400, "INVALID_FIELD", "captureDigest must be a non-empty string");
    }
    const revisions = current.intentRevisions;
    const requestedRevision = input.revision ?? input.intentVersion;
    const nextRevision = revisions.length + 1;
    if (requestedRevision !== undefined && requestedRevision !== nextRevision) {
      throw new ApiError(
        409,
        "INTENT_VERSION_CONFLICT",
        "Intent revisions must be appended in order",
        { expectedVersion: nextRevision, actualVersion: requestedRevision },
      );
    }
    const intentInput = input.intent ?? input;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#requireTaskSessionRow(id);
      const storedRevisions = taskSessionArray(row.intent_json);
      const rowOrchestration = taskSessionOrchestrationFromRow(row);
      this.#assertTaskSessionBinding(rowOrchestration, input, {
        requireParent: Boolean(rowOrchestration.parentThreadBinding?.threadId),
      });
      if (!TASK_SESSION_INTENT_STATES.has(row.state)) {
        throw new ApiError(
          409,
          "INVALID_STATE_TRANSITION",
          "An intent can only be saved before the task session is dispatched",
          { state: row.state },
        );
      }
      if (row.version !== current.version) {
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          "Orchestration changed by another client",
          { expectedVersion: current.version, actualVersion: row.version },
        );
      }
      if (storedRevisions.length + 1 !== nextRevision) {
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          "Orchestration changed by another client",
          { expectedVersion: current.version, actualVersion: row.version },
        );
      }
      // 在同一写锁内重新抓取来源，避免快照校验与意图落库之间出现 TOCTOU 窗口。
      const currentSource = this.getTaskSessionSourceSnapshot(row.task_id);
      const capturedSource = hasSuppliedSourceSnapshot
        ? taskSessionValidatedSourceCapture(
          suppliedSourceSnapshot,
          suppliedCaptureDigest,
          currentSource,
        )
        : taskSessionValidatedCurrentCapture(currentSource, suppliedCaptureDigest);
      const revision = this.#taskSessionIntentRevision(
        intentInput,
        nextRevision,
        capturedSource.digest,
        timestamp,
      );
      storedRevisions.push(revision);
      const updatedAt = input.updatedAt ?? timestamp;
      this.database.prepare(`
        UPDATE task_session_orchestrations
        SET state = 'intent_draft', intent_json = ?, source_snapshot_json = ?, intent_digest = ?,
            confirmed_intent_version = NULL, confirmed_at = NULL,
            version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify(storedRevisions),
        JSON.stringify(capturedSource.snapshot),
        capturedSource.digest,
        updatedAt,
        id,
      );
      this.#appendTaskSessionMessageInTransaction({
        id,
        direction: "parent_to_child",
        type: "intent_revision",
        idempotencyKey: `intent:${id}:${nextRevision}`,
        payload: { intentVersion: nextRevision, captureDigest: capturedSource.digest, intent: revision },
        deliveryState: "acknowledged",
        createdAt: timestamp,
      });
      this.database.exec("COMMIT");
      return this.getTaskSessionOrchestration(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 在重新比较本地快照后确认意图，防止基于过期 Jira 内容派发任务。
  confirmTaskSessionIntent(id, input = {}) {
    const current = this.#requireTaskSessionOrchestration(id);
    this.#assertTaskSessionMutable(current);
    // 确认是主会话权限动作；仅未绑定的握手记录允许暂时省略 caller identity。
    this.#assertTaskSessionBinding(current, input, {
      requireParent: Boolean(current.parentThreadBinding?.threadId),
    });
    if (!(current.state === "unbound" || current.state === "intent_draft" || current.state === "intent_ready")) {
      throw new ApiError(
        409,
        "INVALID_STATE_TRANSITION",
        "Only an unbound or draft intent can be confirmed",
        { state: current.state },
      );
    }
    const expectedRevision = input.intentVersion ?? input.revision ?? current.intentVersion;
    if (current.intentVersion < 1 || !current.intent) {
      throw new ApiError(409, "INTENT_NOT_READY", "Save an intent before confirming it");
    }
    if (expectedRevision !== current.intentVersion) {
      throw new ApiError(
        409,
        "INTENT_VERSION_CONFLICT",
        "The requested intent revision is not current",
        { expectedVersion: current.intentVersion, actualVersion: expectedRevision },
      );
    }
    const source = this.getTaskSessionSourceSnapshot(current.taskId);
    const expectedDigest = input.captureDigest ?? input.intentDigest ?? current.intentDigest;
    if (!expectedDigest || expectedDigest !== current.intentDigest || !taskSessionSourceDigestMatches(current, source)) {
      throw new ApiError(
        409,
        "INTENT_STALE",
        "The Jira source snapshot changed; refresh and confirm the intent again",
        {
          intentDigest: current.intentDigest,
          currentDigest: source.digest,
          intentVersion: current.intentVersion,
        },
      );
    }
    const openQuestions = Array.isArray(current.intent?.openQuestions)
      ? current.intent.openQuestions.filter((question) => String(question).trim())
      : [];
    // 未解决的问题必须回到主会话处理；任何调用参数都不能跳过意图确认边界。
    if (openQuestions.length > 0) {
      throw new ApiError(
        409,
        "INTENT_OPEN_QUESTIONS",
        "Resolve open questions before dispatching the task session",
        { openQuestions },
      );
    }

    const timestamp = input.confirmedAt ?? now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#requireTaskSessionRow(id);
      const rowOrchestration = taskSessionOrchestrationFromRow(row);
      this.#assertTaskSessionBinding(rowOrchestration, input, {
        requireParent: Boolean(rowOrchestration.parentThreadBinding?.threadId),
      });
      if (row.state === "done") {
        throw new ApiError(409, "ORCHESTRATION_COMPLETED", "Completed orchestrations are immutable");
      }
      if (!(row.state === "unbound" || row.state === "intent_draft" || row.state === "intent_ready")) {
        throw new ApiError(
          409,
          "INVALID_STATE_TRANSITION",
          "Only an unbound or draft intent can be confirmed",
          { state: row.state },
        );
      }
      if (row.version !== current.version) {
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          "Orchestration changed by another client",
          { expectedVersion: current.version, actualVersion: row.version },
        );
      }
      // 锁内再次读取 Jira 投影，防止来源在预检查后变更再被确认。
      const lockedSource = this.getTaskSessionSourceSnapshot(row.task_id);
      if (!expectedDigest || expectedDigest !== row.intent_digest || !taskSessionSourceDigestMatches(rowOrchestration, lockedSource)) {
        throw new ApiError(
          409,
          "INTENT_STALE",
          "The Jira source snapshot changed; refresh and confirm the intent again",
          {
            intentDigest: row.intent_digest,
            currentDigest: lockedSource.digest,
            intentVersion: rowOrchestration.intentVersion,
          },
        );
      }
      // 即使确认消息已存在，也必须先通过来源新鲜度校验，避免过期重试被幂等短路放行。
      const confirmationKey = `intent-confirmed:${id}:${expectedRevision}`;
      const existingConfirmation = this.database.prepare(`
        SELECT * FROM task_session_messages
        WHERE orchestration_id = ? AND idempotency_key = ?
      `).get(id, confirmationKey);
      if (existingConfirmation) {
        this.database.exec("COMMIT");
        return taskSessionOrchestrationFromRow(row);
      }
      this.database.prepare(`
        UPDATE task_session_orchestrations
        SET state = 'intent_ready', confirmed_intent_version = ?, confirmed_at = ?,
            version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(expectedRevision, timestamp, timestamp, id);
      this.#appendTaskSessionMessageInTransaction({
        id,
        direction: "internal",
        type: "intent_confirmed",
        idempotencyKey: confirmationKey,
        payload: { intentVersion: expectedRevision, captureDigest: expectedDigest },
        deliveryState: "acknowledged",
        createdAt: timestamp,
      });
      this.database.exec("COMMIT");
      return this.getTaskSessionOrchestration(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 保存宿主回传的 child/window/runtime binding；未回传 child 时保留 dispatched 握手状态。
  dispatchTaskSessionOrchestration(id, input = {}) {
    const current = this.#requireTaskSessionOrchestration(id);
    this.#assertTaskSessionMutable(current);
    // 派发请求里的 childThreadBinding 是待写入的新绑定，不应被当成调用者身份校验。
    this.#assertTaskSessionBinding(current, {
      parentThreadId: input.parentThreadId,
      parentThreadBinding: input.parentThreadBinding ?? input.parentBinding,
    }, { requireParent: true });
    if (!(current.state === "intent_ready" || TASK_SESSION_DISPATCH_STATES.has(current.state))) {
      throw new ApiError(
        409,
        "ORCHESTRATION_NOT_READY",
        "The orchestration intent is not ready for dispatch",
        { state: current.state },
      );
    }
    if (current.confirmedIntentVersion !== current.intentVersion) {
      throw new ApiError(409, "INTENT_NOT_CONFIRMED", "Confirm the current intent before dispatching");
    }
    // 派发是执行会话实际读取意图的边界；来源变化后不得让旧确认通过重试继续执行。
    this.#assertTaskSessionSourceCurrent(current);
    if (input.intentVersion !== undefined && input.intentVersion !== current.intentVersion) {
      throw new ApiError(
        409,
        "INTENT_VERSION_CONFLICT",
        "The requested intent revision is not current",
        { expectedVersion: current.intentVersion, actualVersion: input.intentVersion },
      );
    }
    const childBinding = input.childThreadBinding
      ?? input.childThread
      ?? (input.childThreadId ? { threadId: input.childThreadId } : null);
    const existingChild = current.childThreadBinding;
    if (
      existingChild?.threadId
      && childBinding?.threadId
      && existingChild.threadId !== childBinding.threadId
    ) {
      throw new ApiError(
        409,
        "CHILD_THREAD_ALREADY_BOUND",
        "This orchestration already has a different child thread",
        { childThreadId: existingChild.threadId },
      );
    }
    if (childBinding?.threadId === existingChild?.threadId) {
      // 重试可只带 child ID；若同时带完整身份，不能切换到另一个项目或工作目录。
      this.#assertTaskSessionBinding(current, { childThreadBinding: childBinding });
    }
    const child = childBinding ?? existingChild;
    const childWindow = input.childWindow === undefined ? current.childWindow : input.childWindow;
    const runtime = input.runtime === undefined ? current.runtime : input.runtime;
    const worktree = input.worktree === undefined ? current.worktree : input.worktree;
    const state = input.state ?? (current.state === "intent_ready" ? "dispatched" : current.state);
    this.#assertTaskSessionState(state);
    if (!TASK_SESSION_DISPATCH_STATES.has(state)) {
      throw new ApiError(
        409,
        "INVALID_STATE_TRANSITION",
        "Dispatch can only set an execution lifecycle state",
        { state },
      );
    }
    this.#assertTaskSessionStateTransition(current.state, state);
    const timestamp = input.updatedAt ?? now();

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#requireTaskSessionRow(id);
      if (row.state === "done") {
        throw new ApiError(409, "ORCHESTRATION_COMPLETED", "Completed orchestrations are immutable");
      }
      if (!(row.state === "intent_ready" || TASK_SESSION_DISPATCH_STATES.has(row.state))) {
        throw new ApiError(
          409,
          "ORCHESTRATION_NOT_READY",
          "The orchestration intent is not ready for dispatch",
          { state: row.state },
        );
      }
      if (row.confirmed_intent_version !== current.confirmedIntentVersion) {
        throw new ApiError(409, "VERSION_CONFLICT", "Orchestration changed by another client");
      }
      this.#assertTaskSessionStateTransition(row.state, state);
      const rowOrchestration = taskSessionOrchestrationFromRow(row);
      // 事务锁内再次读取来源，覆盖预检查与写入之间的 TOCTOU 窗口；必须早于
      // dispatch 幂等短路，否则旧请求仍可能返回成功。
      this.#assertTaskSessionSourceCurrent(rowOrchestration);
      this.#assertTaskSessionBinding(rowOrchestration, {
        parentThreadId: input.parentThreadId,
        parentThreadBinding: input.parentThreadBinding ?? input.parentBinding,
        // 首次 dispatch 允许写入尚未绑定的 child；已有 child 才需要校验重试身份。
        childThreadBinding: rowOrchestration.childThreadBinding ? child : undefined,
      });
      if (child?.threadId) {
        // 一个 child thread 只能归属一个 active 编排，否则它可以跨任务伪造结果回传。
        const childConflict = this.database.prepare(`
          SELECT id FROM task_session_orchestrations
          WHERE state != 'done'
            AND id != ?
            AND json_extract(child_thread_json, '$.threadId') = ?
          LIMIT 1
        `).get(id, child.threadId);
        if (childConflict) {
          throw new ApiError(
            409,
            "CHILD_THREAD_ALREADY_BOUND",
            "This child thread is already bound to another active orchestration",
            { orchestrationId: childConflict.id },
          );
        }
      }
      const dispatchKey = `dispatch:${id}:${current.intentVersion}:${child?.threadId ?? "pending"}`;
      const existingDispatch = this.database.prepare(`
        SELECT * FROM task_session_messages
        WHERE orchestration_id = ? AND idempotency_key = ?
      `).get(id, dispatchKey);
      if (existingDispatch) {
        const storedChild = rowOrchestration.childThreadBinding;
        const childIdentityConflicts = taskSessionBindingIdentityConflicts(storedChild, child);
        if (childIdentityConflicts.length > 0) {
          throw new ApiError(
            409,
            "CHILD_THREAD_MISMATCH",
            "The child thread identity is not bound to this orchestration",
            { mismatchedFields: childIdentityConflicts },
          );
        }
        const mergedChild = taskSessionBindingWithMissingIdentity(storedChild, child);
        const metadata = [
          ["childWindow", rowOrchestration.childWindow, input.childWindow],
          ["runtime", rowOrchestration.runtime, input.runtime],
          ["worktree", rowOrchestration.worktree, input.worktree],
        ];
        const metadataConflicts = metadata.flatMap(([field, stored, incoming]) => (
          taskSessionObjectConflicts(stored, incoming).map((key) => `${field}.${key}`)
        ));
        if (metadataConflicts.length > 0) {
          throw new ApiError(
            409,
            "DISPATCH_IDEMPOTENCY_CONFLICT",
            "The dispatch key is already associated with different binding metadata",
            { mismatchedFields: metadataConflicts },
          );
        }
        const mergedChildWindow = taskSessionObjectWithMissingFields(
          rowOrchestration.childWindow,
          input.childWindow,
        );
        const mergedRuntime = taskSessionObjectWithMissingFields(rowOrchestration.runtime, input.runtime);
        const mergedWorktree = taskSessionObjectWithMissingFields(rowOrchestration.worktree, input.worktree);
        const hasEnrichment = JSON.stringify(mergedChild) !== JSON.stringify(storedChild)
          || JSON.stringify(mergedChildWindow) !== JSON.stringify(rowOrchestration.childWindow)
          || JSON.stringify(mergedRuntime) !== JSON.stringify(rowOrchestration.runtime)
          || JSON.stringify(mergedWorktree) !== JSON.stringify(rowOrchestration.worktree);
        if (!hasEnrichment) {
          this.database.exec("COMMIT");
          return rowOrchestration;
        }

        // 首次握手可能只带 thread ID；收到宿主完整身份后追加一条审计消息并补齐空字段。
        const enrichmentPayload = {
          intentVersion: current.intentVersion,
          childThreadBinding: mergedChild,
          childWindow: mergedChildWindow,
          runtime: mergedRuntime,
          worktree: mergedWorktree,
          handshakePending: !mergedChild,
        };
        const enrichmentKey = `${dispatchKey}:enriched:${taskSessionDigest(enrichmentPayload)}`;
        const existingEnrichment = this.database.prepare(`
          SELECT * FROM task_session_messages
          WHERE orchestration_id = ? AND idempotency_key = ?
        `).get(id, enrichmentKey);
        if (existingEnrichment) {
          this.database.exec("COMMIT");
          return rowOrchestration;
        }
        this.database.prepare(`
          UPDATE task_session_orchestrations
          SET child_thread_json = ?, child_window_json = ?, runtime_json = ?,
              worktree_json = ?, version = version + 1, updated_at = ?
          WHERE id = ?
        `).run(
          mergedChild ? JSON.stringify(mergedChild) : null,
          mergedChildWindow === null || mergedChildWindow === undefined ? null : JSON.stringify(mergedChildWindow),
          mergedRuntime === null || mergedRuntime === undefined ? null : JSON.stringify(mergedRuntime),
          mergedWorktree === null || mergedWorktree === undefined ? null : JSON.stringify(mergedWorktree),
          timestamp,
          id,
        );
        this.#appendTaskSessionMessageInTransaction({
          id,
          direction: "parent_to_child",
          type: "child_binding_enriched",
          idempotencyKey: enrichmentKey,
          payload: enrichmentPayload,
          deliveryState: mergedChild ? "sent" : "pending",
          createdAt: timestamp,
        });
        this.database.exec("COMMIT");
        return this.getTaskSessionOrchestration(id);
      }
      this.database.prepare(`
        UPDATE task_session_orchestrations
        SET state = ?, child_thread_json = ?, child_window_json = ?, runtime_json = ?,
            worktree_json = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(
        state,
        child ? JSON.stringify(child) : row.child_thread_json,
        childWindow === null ? null : JSON.stringify(childWindow),
        runtime === null ? null : JSON.stringify(runtime),
        worktree === null ? null : JSON.stringify(worktree),
        timestamp,
        id,
      );
      // 即使 child thread 尚未完成首个 turn，任务也已经进入执行编排；状态不能
      // 依赖宿主握手是否及时返回。
      this.#syncTaskSessionTaskStatus(
        current.taskId,
        "in_progress",
        timestamp,
        "task_session_dispatched",
        new Set(["backlog", "todo"]),
      );
      this.#appendTaskSessionMessageInTransaction({
        id,
        direction: "parent_to_child",
        type: "child_dispatched",
        idempotencyKey: dispatchKey,
        payload: {
          intentVersion: current.intentVersion,
          childThreadBinding: child,
          childWindow,
          runtime,
          worktree,
          handshakePending: !child,
        },
        deliveryState: child ? "sent" : "pending",
        createdAt: timestamp,
      });
      this.database.exec("COMMIT");
      return this.getTaskSessionOrchestration(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 追加主子通信消息并分配编排内单调序列；重复幂等键只返回原消息。
  appendTaskSessionMessage(id, input = {}) {
    const current = this.#requireTaskSessionOrchestration(id);
    this.#assertTaskSessionMutable(current);
    const direction = input.direction ?? "internal";
    this.#assertTaskSessionBinding(current, input, {
      requireParent: direction === "parent_to_child",
      requireChild: direction === "child_to_parent",
    });
    if (direction !== "internal" && input.intentVersion !== current.intentVersion) {
      throw new ApiError(
        409,
        "INTENT_VERSION_CONFLICT",
        "The message intent version is not current",
        { expectedVersion: current.intentVersion, actualVersion: input.intentVersion },
      );
    }
    if (direction === "internal" && input.intentVersion !== undefined && input.intentVersion !== current.intentVersion) {
      throw new ApiError(
        409,
        "INTENT_VERSION_CONFLICT",
        "The message intent version is not current",
        { expectedVersion: current.intentVersion, actualVersion: input.intentVersion },
      );
    }
    const nextState = input.state ?? input.payload?.state;
    if (nextState !== undefined && nextState !== null) {
      this.#assertTaskSessionState(nextState);
      if (nextState === "done") {
        throw new ApiError(
          409,
          "EXPLICIT_COMPLETION_REQUIRED",
          "Only the explicit completion endpoint can move an orchestration to done",
        );
      }
      if (!TASK_SESSION_LIFECYCLE_STATES.has(nextState)) {
        throw new ApiError(
          409,
          "INVALID_STATE_TRANSITION",
          "Generic messages may only update execution lifecycle state",
          { state: nextState },
        );
      }
      if (direction === "internal") {
        const hasParentIdentity = input.parentThreadId !== undefined;
        const hasChildIdentity = input.childThreadId !== undefined;
        if (!hasParentIdentity && !hasChildIdentity) {
          throw new ApiError(
            403,
            "INTERNAL_ACTOR_REQUIRED",
            "A lifecycle message must identify its parent or child thread",
          );
        }
        this.#assertTaskSessionBinding(current, input, {
          requireParent: hasParentIdentity,
          requireChild: hasChildIdentity,
        });
      }
    }
    const timestamp = input.createdAt ?? now();
    const idempotencyKey = input.idempotencyKey ?? null;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#requireTaskSessionRow(id);
      if (row.state === "done") {
        throw new ApiError(409, "ORCHESTRATION_COMPLETED", "Completed orchestrations are immutable");
      }
      const rowOrchestration = taskSessionOrchestrationFromRow(row);
      this.#assertTaskSessionBinding(rowOrchestration, input, {
        requireParent: direction === "parent_to_child",
        requireChild: direction === "child_to_parent",
      });
      if (direction !== "internal" && input.intentVersion !== rowOrchestration.intentVersion) {
        throw new ApiError(
          409,
          "INTENT_VERSION_CONFLICT",
          "The message intent version is not current",
          { expectedVersion: rowOrchestration.intentVersion, actualVersion: input.intentVersion },
        );
      }
      if (direction === "internal" && input.intentVersion !== undefined && input.intentVersion !== rowOrchestration.intentVersion) {
        throw new ApiError(
          409,
          "INTENT_VERSION_CONFLICT",
          "The message intent version is not current",
          { expectedVersion: rowOrchestration.intentVersion, actualVersion: input.intentVersion },
        );
      }
      if (idempotencyKey) {
        const existing = this.database.prepare(`
          SELECT * FROM task_session_messages
          WHERE orchestration_id = ? AND idempotency_key = ?
        `).get(id, idempotencyKey);
        if (existing) {
          if (!taskSessionMessageIdempotencyMatches(existing, input)) {
            throw new ApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "The idempotency key is already associated with a different message",
            );
          }
          this.database.exec("COMMIT");
          return taskSessionMessageFromRow(existing);
        }
      }
      // 历史消息重试先按 envelope 幂等短路；只有首次写入才重新执行当前状态迁移。
      if (nextState !== undefined && nextState !== null) {
        this.#assertTaskSessionLifecycleMessageAction(rowOrchestration, direction, input, nextState);
        this.#assertTaskSessionStateTransition(row.state, nextState);
        if (direction === "internal") {
          const hasParentIdentity = input.parentThreadId !== undefined;
          const hasChildIdentity = input.childThreadId !== undefined;
          if (!hasParentIdentity && !hasChildIdentity) {
            throw new ApiError(
              403,
              "INTERNAL_ACTOR_REQUIRED",
              "A lifecycle message must identify its parent or child thread",
            );
          }
          this.#assertTaskSessionBinding(rowOrchestration, input, {
            requireParent: hasParentIdentity,
            requireChild: hasChildIdentity,
          });
        }
      }
      const message = this.#appendTaskSessionMessageInTransaction({
        id,
        direction: input.direction ?? "internal",
        type: input.type ?? "message",
        idempotencyKey,
        payload: input.payload ?? {},
        state: input.state ?? null,
        deliveryState: input.deliveryState ?? "pending",
        createdAt: timestamp,
      });
      if (nextState && nextState !== row.state) {
        this.database.prepare(`
          UPDATE task_session_orchestrations SET state = ?, version = version + 1, updated_at = ? WHERE id = ?
        `).run(nextState, timestamp, id);
      }
      this.database.exec("COMMIT");
      return message;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 保存不可变结果版本并以 orchestrationId:resultRevision 作为投递幂等键。
  createTaskSessionReport(id, input = {}) {
    const current = this.#requireTaskSessionOrchestration(id);
    this.#assertTaskSessionMutable(current);
    this.#assertTaskSessionBinding(current, input, { requireParent: true, requireChild: true });
    const intentVersion = input.intentVersion ?? current.confirmedIntentVersion ?? current.intentVersion;
    if (intentVersion !== current.intentVersion) {
      throw new ApiError(
        409,
        "INTENT_VERSION_CONFLICT",
        "The report was created from a stale intent revision",
        { expectedVersion: current.intentVersion, actualVersion: intentVersion },
      );
    }
    if (current.confirmedIntentVersion !== current.intentVersion) {
      throw new ApiError(409, "INTENT_NOT_CONFIRMED", "The intent is not confirmed");
    }
    // 报告必须对应仍然有效的 Jira 快照；重试也不能绕过来源检查。
    this.#assertTaskSessionSourceCurrent(current);
    const payload = input.payload ?? input.result ?? input.report;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ApiError(400, "INVALID_FIELD", "Report payload must be an object");
    }
    const requestedRevision = input.resultRevision;
    if (requestedRevision === undefined) {
      throw new ApiError(400, "INVALID_FIELD", "resultRevision is required for a report");
    }
    const nextRevision = requestedRevision;
    if (!Number.isSafeInteger(nextRevision) || nextRevision < 1) {
      throw new ApiError(400, "INVALID_FIELD", "resultRevision must be a positive integer");
    }
    if (requestedRevision > current.currentResultRevision + 1) {
      throw new ApiError(
        409,
        "RESULT_REVISION_CONFLICT",
        "Result revisions must be appended in order",
        { expectedRevision: current.currentResultRevision + 1, actualRevision: requestedRevision },
      );
    }
    if (input.idempotencyKey === undefined) {
      throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "Report idempotencyKey is required");
    }
    const idempotencyKey = input.idempotencyKey;
    if (idempotencyKey !== `${id}:${nextRevision}`) {
      throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "Report idempotencyKey must be orchestrationId:resultRevision");
    }
    const timestamp = input.createdAt ?? now();
    const result = {
      ...payload,
      version: payload.version ?? "task-result.v1",
      intentVersion,
      resultRevision: nextRevision,
      idempotencyKey,
      createdAt: timestamp,
    };

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#requireTaskSessionRow(id);
      const rowOrchestration = taskSessionOrchestrationFromRow(row);
      // 锁内复核必须放在 existingMessage 幂等分支之前，避免旧报告被当成成功重试。
      this.#assertTaskSessionSourceCurrent(rowOrchestration);
      this.#assertTaskSessionBinding(rowOrchestration, input, { requireParent: true, requireChild: true });
      if (
        rowOrchestration.intentVersion !== intentVersion
        || rowOrchestration.confirmedIntentVersion !== rowOrchestration.intentVersion
      ) {
        throw new ApiError(409, "INTENT_VERSION_CONFLICT", "The report intent is no longer current");
      }
      const existingMessage = this.database.prepare(`
        SELECT * FROM task_session_messages
        WHERE orchestration_id = ? AND idempotency_key = ?
      `).get(id, idempotencyKey);
      if (existingMessage) {
        const existingOrchestration = taskSessionOrchestrationFromRow(row);
        const existingResult = existingOrchestration.resultRevisions.find(
          (candidate) => candidate.resultRevision === nextRevision,
        ) ?? existingOrchestration.result;
        if (!taskSessionPayloadMatches(existingResult, payload)) {
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "The report idempotency key is already associated with a different result",
          );
        }
        this.database.exec("COMMIT");
        return {
          orchestration: existingOrchestration,
          result: existingResult,
          message: taskSessionMessageFromRow(existingMessage),
          duplicate: true,
        };
      }
      if (!TASK_SESSION_LIFECYCLE_STATES.has(row.state)) {
        throw new ApiError(
          409,
          "ORCHESTRATION_NOT_READY",
          "The task session is not accepting a new result report",
          { state: row.state },
        );
      }
      const results = taskSessionArray(row.result_json);
      const expectedRevision = Number(row.current_result_revision) + 1;
      if (nextRevision !== expectedRevision) {
        throw new ApiError(
          409,
          "RESULT_REVISION_CONFLICT",
          "Result revisions must be appended in order",
          { expectedRevision, actualRevision: nextRevision },
        );
      }
      results.push(result);
      this.database.prepare(`
        UPDATE task_session_orchestrations
        SET state = 'reporting', result_json = ?, current_result_revision = ?,
            version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(results), nextRevision, timestamp, id);
      this.#syncTaskSessionTaskStatus(
        current.taskId,
        "in_review",
        timestamp,
        "task_session_reported",
        new Set(["backlog", "todo", "in_progress"]),
      );
      const message = this.#appendTaskSessionMessageInTransaction({
        id,
        direction: "child_to_parent",
        type: "result",
        idempotencyKey,
        payload: result,
        deliveryState: input.deliveryState ?? "sent",
        createdAt: timestamp,
      });
      this.database.exec("COMMIT");
      return {
        orchestration: this.getTaskSessionOrchestration(id),
        result,
        message,
        duplicate: false,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 主会话确认收到指定结果版本；ack 本身也写入时间线，且可安全重复调用。
  acknowledgeTaskSessionReport(id, revision, input = {}) {
    const current = this.#requireTaskSessionOrchestration(id);
    this.#assertTaskSessionMutable(current);
    this.#assertTaskSessionBinding(current, input, { requireParent: true });
    // 主会话只接收当前 Jira 来源上的结果；过期报告不能通过 ACK 进入检查。
    this.#assertTaskSessionSourceCurrent(current);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new ApiError(400, "INVALID_PATH", "Result revision is invalid");
    }
    const key = `${id}:${revision}`;
    const timestamp = input.acknowledgedAt ?? now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#requireTaskSessionRow(id);
      const rowOrchestration = taskSessionOrchestrationFromRow(row);
      // 与报告创建一致，锁内检查必须先于 ACK 幂等短路。
      this.#assertTaskSessionSourceCurrent(rowOrchestration);
      this.#assertTaskSessionBinding(rowOrchestration, input, { requireParent: true });
      const resultRevisions = taskSessionArray(row.result_json);
      const result = resultRevisions.find((candidate) => candidate.resultRevision === revision);
      if (!result) {
        throw new ApiError(404, "RESULT_NOT_FOUND", `Result revision '${revision}' does not exist`);
      }
      if (Number(row.current_result_revision) !== revision) {
        throw new ApiError(
          409,
          "RESULT_NOT_CURRENT",
          "Only the current result revision can be acknowledged",
          { currentRevision: Number(row.current_result_revision), actualRevision: revision },
        );
      }
      const messageRow = this.database.prepare(`
        SELECT * FROM task_session_messages
        WHERE orchestration_id = ? AND idempotency_key = ?
      `).get(id, key);
      if (!messageRow) {
        throw new ApiError(404, "REPORT_NOT_FOUND", `Report '${key}' does not exist`);
      }
      const existingAck = this.database.prepare(`
        SELECT * FROM task_session_messages
        WHERE orchestration_id = ? AND idempotency_key = ?
      `).get(id, `${key}:ack`);
      if (existingAck) {
        const ackMessage = taskSessionMessageFromRow(existingAck);
        if (
          ackMessage.direction !== "parent_to_child"
          || ackMessage.type !== "report_ack"
          || ackMessage.deliveryState !== "acknowledged"
          || ackMessage.payload?.resultRevision !== revision
        ) {
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "The report acknowledgement key is associated with a different message",
          );
        }
        this.database.exec("COMMIT");
        return {
          orchestration: taskSessionOrchestrationFromRow(row),
          result,
          message: taskSessionMessageFromRow(messageRow),
          ack: ackMessage,
          duplicate: true,
        };
      }
      if (row.state !== "reporting") {
        throw new ApiError(
          409,
          "ORCHESTRATION_NOT_READY",
          "The result report is not awaiting acknowledgement",
          { state: row.state },
        );
      }
      if (messageRow.type !== "result") {
        throw new ApiError(409, "REPORT_NOT_FOUND", `Message '${key}' is not a result report`);
      }
      this.database.prepare(`
        UPDATE task_session_messages SET delivery_state = 'acknowledged', updated_at = ?
        WHERE id = ?
      `).run(timestamp, messageRow.id);
      this.#assertTaskSessionStateTransition(row.state, "reviewing");
      this.database.prepare(`
        UPDATE task_session_orchestrations
        SET state = 'reviewing', version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(timestamp, id);
      this.#syncTaskSessionTaskStatus(
        current.taskId,
        "in_review",
        timestamp,
        "task_session_report_acknowledged",
        new Set(["backlog", "todo", "in_progress"]),
      );
      const ack = this.#appendTaskSessionMessageInTransaction({
        id,
        direction: "parent_to_child",
        type: "report_ack",
        idempotencyKey: `${key}:ack`,
        payload: { resultRevision: revision, receivedAt: timestamp },
        deliveryState: "acknowledged",
        createdAt: timestamp,
      });
      const reviewStarted = this.#appendTaskSessionMessageInTransaction({
        id,
        direction: "internal",
        type: "review_started",
        idempotencyKey: `${key}:review-started`,
        payload: { resultRevision: revision, startedAt: timestamp },
        deliveryState: "acknowledged",
        createdAt: timestamp,
      });
      this.database.exec("COMMIT");
      return {
        orchestration: this.getTaskSessionOrchestration(id),
        result,
        message: taskSessionMessageFromRow(
          this.database.prepare("SELECT * FROM task_session_messages WHERE id = ?").get(messageRow.id),
        ),
        ack,
        reviewStarted,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 按编排内 sequence 增量读取时间线，支持 Taskboard 刷新后的断点恢复。
  listTaskSessionMessages(id, after = 0) {
    this.#requireTaskSessionOrchestration(id);
    return this.database.prepare(`
      SELECT * FROM task_session_messages
      WHERE orchestration_id = ? AND sequence > ?
      ORDER BY sequence
    `).all(id, after).map(taskSessionMessageFromRow);
  }

  // 保存主会话的检查结论；结论绑定到具体结果版本，不覆盖历史判断。
  saveTaskSessionReview(id, input = {}) {
    const current = this.#requireTaskSessionOrchestration(id);
    this.#assertTaskSessionMutable(current);
    this.#assertTaskSessionBinding(current, input, { requireParent: true });
    if (!(current.state === "result_ready" || current.state === "reviewing")) {
      throw new ApiError(
        409,
        "ORCHESTRATION_NOT_READY",
        "Result review requires an acknowledged result",
        { state: current.state },
      );
    }
    const decision = input.decision ?? input.status;
    if (!["approved", "needs_rework", "blocked"].includes(decision)) {
      throw new ApiError(400, "INVALID_FIELD", "Review decision must be approved, needs_rework, or blocked");
    }
    const resultRevision = input.resultRevision ?? current.currentResultRevision;
    if (
      !Number.isSafeInteger(resultRevision)
      || resultRevision < 1
      || resultRevision !== current.currentResultRevision
      || !current.resultRevisions.some((result) => result.resultRevision === resultRevision)
    ) {
      throw new ApiError(
        409,
        "RESULT_NOT_READY",
        "Review requires the current result revision",
        { currentRevision: current.currentResultRevision, actualRevision: resultRevision },
      );
    }
    this.#assertTaskSessionSourceCurrent(current);
    const timestamp = input.createdAt ?? now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#requireTaskSessionRow(id);
      const rowOrchestration = taskSessionOrchestrationFromRow(row);
      this.#assertTaskSessionBinding(rowOrchestration, input, { requireParent: true });
      if (row.state === "done") {
        throw new ApiError(409, "ORCHESTRATION_COMPLETED", "Completed orchestrations are immutable");
      }
      if (!(row.state === "result_ready" || row.state === "reviewing")) {
        throw new ApiError(
          409,
          "ORCHESTRATION_NOT_READY",
          "Result review requires an acknowledged result",
          { state: row.state },
        );
      }
      if (Number(row.current_result_revision) !== resultRevision) {
        throw new ApiError(
          409,
          "RESULT_NOT_CURRENT",
          "Review must target the current result revision",
          { currentRevision: Number(row.current_result_revision), actualRevision: resultRevision },
        );
      }
      // 结果检查也必须基于锁内的最新 Jira 投影，避免预检查后发生 TOCTOU。
      this.#assertTaskSessionSourceCurrent(rowOrchestration);
      const resultMessage = this.database.prepare(`
        SELECT * FROM task_session_messages
        WHERE orchestration_id = ? AND idempotency_key = ? AND type = 'result'
      `).get(id, `${id}:${resultRevision}`);
      if (!resultMessage || resultMessage.delivery_state !== "acknowledged") {
        throw new ApiError(
          409,
          "RESULT_NOT_READY",
          "Review requires the current result report to be acknowledged",
        );
      }
      const revisions = taskSessionRevisionArray(row.review_json);
      const review = {
        revision: revisions.length + 1,
        resultRevision,
        decision,
        feedback: input.feedback ?? input.reason ?? null,
        evidence: input.evidence ?? null,
        createdAt: timestamp,
      };
      revisions.push(review);
      const nextState = decision === "approved"
        ? "writeback_pending"
        : decision === "needs_rework" ? "executing" : "blocked";
      this.database.prepare(`
        UPDATE task_session_orchestrations
        SET state = ?, review_json = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(nextState, JSON.stringify(revisions), timestamp, id);
      if (decision === "needs_rework") {
        // 返工是显式主会话动作；任务状态同步回 in_progress，避免面板继续显示
        // in_review 而执行会话已经重新开始。
        this.#syncTaskSessionTaskStatus(
          current.taskId,
          "in_progress",
          timestamp,
          "task_session_rework_requested",
          new Set(["in_review", "blocked"]),
        );
      }
      const message = this.#appendTaskSessionMessageInTransaction({
        id,
        direction: "parent_to_child",
        type: "review_decision",
        idempotencyKey: `review:${id}:${review.revision}`,
        payload: review,
        deliveryState: "acknowledged",
        createdAt: timestamp,
      });
      this.database.exec("COMMIT");
      return { orchestration: this.getTaskSessionOrchestration(id), review, message };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 记录用户选择的本地集成证据；实际 merge/cherry-pick 由后续 host 能力负责。
  saveTaskSessionIntegration(id, input = {}) {
    const current = this.#requireTaskSessionOrchestration(id);
    this.#assertTaskSessionMutable(current);
    this.#assertTaskSessionBinding(current, input, { requireParent: true });
    if (
      current.review?.decision !== "approved"
      || current.review.resultRevision !== current.currentResultRevision
    ) {
      throw new ApiError(409, "REVIEW_NOT_APPROVED", "Integration requires an approved review");
    }
    const canRetryConflict = current.state === "blocked" && current.integration?.conflict === true;
    if (!(current.state === "writeback_pending" || current.state === "integrated" || current.state === "synced" || canRetryConflict)) {
      throw new ApiError(
        409,
        "ORCHESTRATION_NOT_READY",
        "Integration requires an approved result awaiting integration",
        { state: current.state },
      );
    }
    const mode = input.mode ?? "merge";
    if (!["merge", "cherry-pick"].includes(mode)) {
      throw new ApiError(400, "INVALID_FIELD", "Integration mode must be merge or cherry-pick");
    }
    const timestamp = input.createdAt ?? now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#requireTaskSessionRow(id);
      const rowOrchestration = taskSessionOrchestrationFromRow(row);
      this.#assertTaskSessionBinding(rowOrchestration, input, { requireParent: true });
      if (row.state === "done") {
        throw new ApiError(409, "ORCHESTRATION_COMPLETED", "Completed orchestrations are immutable");
      }
      const rowIntegrations = taskSessionRevisionArray(row.integration_json);
      const canRetryRowConflict = row.state === "blocked" && rowIntegrations.at(-1)?.conflict === true;
      if (!(row.state === "writeback_pending" || row.state === "integrated" || row.state === "synced" || canRetryRowConflict)) {
        throw new ApiError(
          409,
          "ORCHESTRATION_NOT_READY",
          "Integration requires an approved result awaiting integration",
          { state: row.state },
        );
      }
      const rowReviews = taskSessionRevisionArray(row.review_json);
      const rowReview = rowReviews.at(-1);
      if (
        rowReview?.decision !== "approved"
        || rowReview.resultRevision !== Number(row.current_result_revision)
      ) {
        throw new ApiError(409, "REVIEW_NOT_APPROVED", "Integration requires an approved current result");
      }
      // Jira 来源在检查通过后仍可能变化；集成前重新确认快照，避免把过期结论带入主工作区。
      this.#assertTaskSessionSourceCurrent(taskSessionOrchestrationFromRow(row));
      const revisions = taskSessionRevisionArray(row.integration_json);
      const integration = {
        revision: revisions.length + 1,
        mode,
        commit: input.commit ?? input.commitSha ?? null,
        conflict: input.conflict === true,
        verification: input.verification ?? null,
        createdAt: timestamp,
      };
      revisions.push(integration);
      const nextState = integration.conflict ? "blocked" : "integrated";
      this.#assertTaskSessionStateTransition(row.state, nextState);
      this.database.prepare(`
        UPDATE task_session_orchestrations
        SET state = ?, integration_json = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(nextState, JSON.stringify(revisions), timestamp, id);
      const message = this.#appendTaskSessionMessageInTransaction({
        id,
        direction: "internal",
        type: "integration_recorded",
        idempotencyKey: `integration:${id}:${integration.revision}`,
        payload: integration,
        deliveryState: "acknowledged",
        createdAt: timestamp,
      });
      this.database.exec("COMMIT");
      return { orchestration: this.getTaskSessionOrchestration(id), integration, message };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 保存 Jira 写回预览及用户选择，P1 只记录审计，不直接调用远端 Jira。
  saveTaskSessionWriteback(id, input = {}) {
    const current = this.#requireTaskSessionOrchestration(id);
    this.#assertTaskSessionMutable(current);
    this.#assertTaskSessionBinding(current, input, { requireParent: true });
    if (
      current.review?.decision !== "approved"
      || current.review.resultRevision !== current.currentResultRevision
    ) {
      throw new ApiError(409, "REVIEW_NOT_APPROVED", "Jira writeback requires an approved review");
    }
    if (!(current.state === "writeback_pending" || current.state === "integrated" || current.state === "synced")) {
      throw new ApiError(
        409,
        "ORCHESTRATION_NOT_READY",
        "Jira writeback requires an approved result awaiting writeback",
        { state: current.state },
      );
    }
    this.#assertTaskSessionSourceCurrent(current);
    const timestamp = input.createdAt ?? now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#requireTaskSessionRow(id);
      const rowOrchestration = taskSessionOrchestrationFromRow(row);
      this.#assertTaskSessionBinding(rowOrchestration, input, { requireParent: true });
      if (row.state === "done") {
        throw new ApiError(409, "ORCHESTRATION_COMPLETED", "Completed orchestrations are immutable");
      }
      if (!(row.state === "writeback_pending" || row.state === "integrated" || row.state === "synced")) {
        throw new ApiError(
          409,
          "ORCHESTRATION_NOT_READY",
          "Jira writeback requires an approved result awaiting writeback",
          { state: row.state },
        );
      }
      const rowReviews = taskSessionRevisionArray(row.review_json);
      const rowReview = rowReviews.at(-1);
      if (
        rowReview?.decision !== "approved"
        || rowReview.resultRevision !== Number(row.current_result_revision)
      ) {
        throw new ApiError(409, "REVIEW_NOT_APPROVED", "Jira writeback requires an approved current result");
      }
      // 写回预览不能绕过锁内来源复核，即使当前只记录本地预览。
      this.#assertTaskSessionSourceCurrent(rowOrchestration);
      const revisions = taskSessionRevisionArray(row.writeback_json);
      const writeback = {
        revision: revisions.length + 1,
        comment: input.comment ?? null,
        fields: input.fields ?? null,
        status: input.status ?? null,
        confirmed: input.confirmed === true,
        createdAt: timestamp,
      };
      revisions.push(writeback);
      const latestIntegration = taskSessionRevisionArray(row.integration_json).at(-1);
      // P1 只保存 Jira 预览；已有成功集成时保留 integrated，避免用户点击顺序导致状态倒退。
      const nextState = writeback.confirmed && latestIntegration?.conflict === false
        ? row.state === "synced" ? "synced" : "integrated"
        : "writeback_pending";
      this.#assertTaskSessionStateTransition(row.state, nextState);
      this.database.prepare(`
        UPDATE task_session_orchestrations
        SET state = ?, writeback_json = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(nextState, JSON.stringify(revisions), timestamp, id);
      const message = this.#appendTaskSessionMessageInTransaction({
        id,
        direction: "parent_to_child",
        type: "jira_writeback_preview",
        idempotencyKey: `writeback:${id}:${writeback.revision}`,
        payload: writeback,
        deliveryState: "acknowledged",
        createdAt: timestamp,
      });
      this.database.exec("COMMIT");
      return { orchestration: this.getTaskSessionOrchestration(id), writeback, message };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 只有用户明确确认整个闭环后才进入 done，避免把同步或集成成功当成完成。
  completeTaskSessionOrchestration(id, input = {}) {
    const current = this.#requireTaskSessionOrchestration(id);
    this.#assertTaskSessionBinding(current, input, { requireParent: true });
    // 即使是重复完成请求，也必须先验证调用者仍是绑定的主会话。
    if (current.state === "done") return { orchestration: current, message: null, duplicate: true };
    if (input.confirmed !== true && input.complete !== true) {
      throw new ApiError(400, "CONFIRMATION_REQUIRED", "Explicit completion confirmation is required");
    }
    if (!["synced", "integrated"].includes(current.state)) {
      throw new ApiError(409, "ORCHESTRATION_NOT_READY", "The orchestration is not ready to complete");
    }
    if (current.writeback?.confirmed !== true) {
      throw new ApiError(
        409,
        "WRITEBACK_NOT_CONFIRMED",
        "Confirm the Jira writeback preview before completing the orchestration",
      );
    }
    if (!current.integration || current.integration.conflict !== false) {
      throw new ApiError(
        409,
        "INTEGRATION_NOT_COMPLETE",
        "A successful code integration is required before completing the orchestration",
      );
    }
    const timestamp = input.completedAt ?? now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#requireTaskSessionRow(id);
      if (row.state === "done") {
        throw new ApiError(409, "ORCHESTRATION_COMPLETED", "Completed orchestrations are immutable");
      }
      if (row.state !== current.state || row.version !== current.version) {
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          "Orchestration changed by another client",
          { expectedVersion: current.version, actualVersion: row.version },
        );
      }
      const rowWriteback = taskSessionRevisionArray(row.writeback_json).at(-1);
      if (rowWriteback?.confirmed !== true) {
        throw new ApiError(
          409,
          "WRITEBACK_NOT_CONFIRMED",
          "Confirm the Jira writeback preview before completing the orchestration",
        );
      }
      const rowIntegration = taskSessionRevisionArray(row.integration_json).at(-1);
      if (!rowIntegration || rowIntegration.conflict !== false) {
        throw new ApiError(
          409,
          "INTEGRATION_NOT_COMPLETE",
          "A successful code integration is required before completing the orchestration",
        );
      }
      // 完成确认必须绑定锁内最新的 Jira 来源，避免检查/写回之后的需求变化沿用旧结论进入 done。
      this.#assertTaskSessionSourceCurrent(taskSessionOrchestrationFromRow(row));
      this.database.prepare(`
        UPDATE task_session_orchestrations
        SET state = 'done', version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(timestamp, id);
      this.#syncTaskSessionTaskStatus(
        current.taskId,
        "done",
        timestamp,
        "task_session_completed",
        new Set(["backlog", "todo", "in_progress", "in_review"]),
      );
      const message = this.#appendTaskSessionMessageInTransaction({
        id,
        direction: "internal",
        type: "completed",
        idempotencyKey: `completed:${id}:${row.version + 1}`,
        payload: { completedAt: timestamp },
        deliveryState: "acknowledged",
        createdAt: timestamp,
      });
      this.database.exec("COMMIT");
      return { orchestration: this.getTaskSessionOrchestration(id), message };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // 编排阶段只推动仍由本地工作流管理的任务状态；已完成、取消或阻塞的用户终态不被自动覆盖。
  #syncTaskSessionTaskStatus(taskId, nextStatus, timestamp, reason, allowedStatuses) {
    const task = this.#requireTask(taskId);
    if (task.archivedAt !== null || !allowedStatuses.has(task.status) || task.status === nextStatus) {
      return task;
    }
    const project = this.database.prepare(`
      SELECT name FROM projects WHERE id = ?
    `).get(task.projectId);
    const placement = this.database.prepare(`
      SELECT MIN(sort_order) AS minimum
      FROM tasks
      WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
    `).get(task.projectId, nextStatus, task.id);
    const nextSortOrder = placement.minimum === null ? 1000 : placement.minimum - 1000;
    const changed = taskFieldChanges(task, { status: nextStatus });
    this.database.prepare(`
      UPDATE tasks
      SET status = ?, sort_order = ?,
        jira_status_override = CASE WHEN external_source = 'jira' THEN 1 ELSE jira_status_override END,
        version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(nextStatus, nextSortOrder, timestamp, task.id);
    this.#transitionTaskTimer({
      taskId: task.id,
      beforeStatus: task.status,
      afterStatus: nextStatus,
      beforeProjectId: task.projectId,
      afterProjectId: task.projectId,
      afterProjectName: project?.name ?? "",
      paused: task.timeTracking.paused,
      beforeArchived: task.archivedAt !== null,
      afterArchived: task.archivedAt !== null,
      timestamp,
      reason,
    });
    this.#recordTaskActivity(task.id, TASK_SESSION_STATUS_ACTOR, changed, timestamp);
    return this.getTask(task.id);
  }

  #assertTaskSessionState(state) {
    if (!TASK_SESSION_STATES.includes(state)) {
      throw new ApiError(400, "INVALID_FIELD", `Unknown orchestration state '${state}'`);
    }
  }

  #assertTaskSessionStateTransition(fromState, toState) {
    if (fromState === toState) return;
    const allowed = TASK_SESSION_STATE_TRANSITIONS[fromState];
    if (!allowed?.has(toState)) {
      throw new ApiError(
        409,
        "INVALID_STATE_TRANSITION",
        `Cannot move orchestration from '${fromState}' to '${toState}' through this operation`,
        { fromState, toState },
      );
    }
  }

  #assertTaskSessionLifecycleMessageAction(current, direction, input, nextState) {
    const type = input.type ?? "message";
    const parentIdentity = input.parentThreadId ?? input.parentThreadBinding?.threadId;
    const parentDirection = direction === "parent_to_child" || direction === "internal";
    if ((current.state === "result_ready" || current.state === "reviewing") && nextState === "executing") {
      throw new ApiError(
        409,
        "REVIEW_ACTION_REQUIRED",
        "A result under review can only return to execution through an explicit review decision",
      );
    }
    if (current.state === "blocked" && nextState === "executing" && (
      type !== "recovery_started" || !parentDirection || !parentIdentity
    )) {
      throw new ApiError(
        409,
        "RECOVERY_ACTION_REQUIRED",
        "A blocked orchestration requires an explicit parent recovery action",
      );
    }
    if (current.state === "result_ready" && nextState === "reviewing" && (
      type !== "review_started" || !parentDirection || !parentIdentity
    )) {
      throw new ApiError(
        409,
        "REVIEW_ACTION_REQUIRED",
        "Entering review requires an explicit parent review action",
      );
    }
  }

  #assertTaskSessionMutable(orchestration) {
    if (orchestration.state === "done") {
      throw new ApiError(409, "ORCHESTRATION_COMPLETED", "Completed orchestrations are immutable");
    }
  }

  #assertTaskSessionSourceCurrent(orchestration) {
    const source = this.getTaskSessionSourceSnapshot(orchestration.taskId);
    if (!taskSessionSourceDigestMatches(orchestration, source)) {
      throw new ApiError(
        409,
        "INTENT_STALE",
        "The Jira source snapshot changed; refresh and confirm the intent again",
        {
          intentDigest: orchestration.intentDigest,
          currentDigest: source.digest,
          intentVersion: orchestration.intentVersion,
        },
      );
    }
    return source;
  }

  #requireTaskSessionRow(id) {
    const row = this.database.prepare(`
      SELECT * FROM task_session_orchestrations WHERE id = ?
    `).get(id);
    if (!row) {
      throw new ApiError(404, "ORCHESTRATION_NOT_FOUND", `Orchestration '${id}' does not exist`);
    }
    return row;
  }

  #requireTaskSessionOrchestration(id) {
    const row = this.#requireTaskSessionRow(id);
    return taskSessionOrchestrationFromRow(row);
  }

  #assertTaskSessionBinding(current, input, { requireParent = false, requireChild = false } = {}) {
    const parentBinding = input.parentThreadBinding
      ?? input.parentBinding
      ?? input.threadBinding;
    const childBinding = input.childThreadBinding
      ?? input.childThread
      ?? (input.identity && typeof input.identity === "object" ? input.identity : undefined);
    const parentThreadId = input.parentThreadId
      ?? parentBinding?.threadId;
    const childThreadId = input.childThreadId
      ?? childBinding?.threadId;
    const storedParentThreadId = current.parentThreadBinding?.threadId;
    const storedChildThreadId = current.childThreadBinding?.threadId;
    if (requireParent && !storedParentThreadId) {
      throw new ApiError(409, "PARENT_THREAD_UNBOUND", "This orchestration has no parent thread binding");
    }
    if (requireChild && !storedChildThreadId) {
      throw new ApiError(409, "CHILD_THREAD_UNBOUND", "This orchestration has no child thread binding");
    }
    if (requireParent && !parentThreadId) {
      throw new ApiError(403, "PARENT_THREAD_REQUIRED", "The bound parent thread must identify this request");
    }
    if (requireChild && !childThreadId) {
      throw new ApiError(403, "CHILD_THREAD_REQUIRED", "The bound child thread must identify this request");
    }
    if (parentThreadId && parentThreadId !== storedParentThreadId) {
      throw new ApiError(403, "PARENT_THREAD_MISMATCH", "The parent thread is not bound to this orchestration");
    }
    if (childThreadId && childThreadId !== storedChildThreadId) {
      throw new ApiError(403, "CHILD_THREAD_MISMATCH", "The child thread is not bound to this orchestration");
    }
    if (parentBinding && parentThreadId === storedParentThreadId) {
      const conflicts = taskSessionBindingIdentityConflicts(current.parentThreadBinding, parentBinding);
      if (conflicts.length > 0) {
        throw new ApiError(
          403,
          "PARENT_THREAD_MISMATCH",
          "The parent thread identity is not bound to this orchestration",
          { mismatchedFields: conflicts },
        );
      }
    }
    if (childBinding && childThreadId === storedChildThreadId) {
      const conflicts = taskSessionBindingIdentityConflicts(current.childThreadBinding, childBinding);
      if (conflicts.length > 0) {
        throw new ApiError(
          403,
          "CHILD_THREAD_MISMATCH",
          "The child thread identity is not bound to this orchestration",
          { mismatchedFields: conflicts },
        );
      }
    }
  }

  #taskSessionIntentRevision(input, revision, captureDigest, createdAt) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ApiError(400, "INVALID_FIELD", "Intent must be an object");
    }
    const intent = { ...input };
    delete intent.intent;
    delete intent.intentVersion;
    delete intent.revision;
    delete intent.captureDigest;
    delete intent.intentDigest;
    return {
      ...intent,
      version: "task-intent.v1",
      revision,
      captureDigest: captureDigest ?? null,
      createdAt,
    };
  }

  #appendTaskSessionMessageInTransaction({
    id,
    direction,
    type,
    idempotencyKey = null,
    state = null,
    payload = {},
    deliveryState = "pending",
    createdAt = now(),
  }) {
    if (!["parent_to_child", "child_to_parent", "internal"].includes(direction)) {
      throw new ApiError(400, "INVALID_FIELD", "Message direction is invalid");
    }
    if (!["pending", "sent", "acknowledged", "failed", "cancelled"].includes(deliveryState)) {
      throw new ApiError(400, "INVALID_FIELD", "Message deliveryState is invalid");
    }
    if (state !== null && !TASK_SESSION_STATES.includes(state)) {
      throw new ApiError(400, "INVALID_FIELD", "Message state is invalid");
    }
    const sequence = Number(this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS value
      FROM task_session_messages
      WHERE orchestration_id = ?
    `).get(id).value);
    const messageId = randomUUID();
    this.database.prepare(`
      INSERT INTO task_session_messages (
        id, orchestration_id, direction, type, idempotency_key, state,
        payload_json, delivery_state, sequence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      id,
      direction,
      type,
      idempotencyKey,
      state,
      JSON.stringify(payload),
      deliveryState,
      sequence,
      createdAt,
      createdAt,
    );
    return taskSessionMessageFromRow(
      this.database.prepare("SELECT * FROM task_session_messages WHERE id = ?").get(messageId),
    );
  }

  listTasks(filters) {
    const where = [];
    const values = [];
    if (filters.projectId) {
      where.push("project_id = ?");
      values.push(filters.projectId);
    }
    if (filters.status) {
      where.push("status = ?");
      values.push(filters.status);
    }
    if (filters.archived === "false") {
      where.push("archived_at IS NULL");
    } else if (filters.archived === "true") {
      where.push("archived_at IS NOT NULL");
    }

    const sql = `
      SELECT * FROM tasks
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE status
          WHEN 'backlog' THEN 1
          WHEN 'todo' THEN 2
          WHEN 'in_progress' THEN 3
          WHEN 'in_review' THEN 4
          WHEN 'blocked' THEN 5
          WHEN 'done' THEN 6
          WHEN 'canceled' THEN 7
        END,
        sort_order,
        created_at,
        id
    `;
    const rows = this.database.prepare(sql).all(...values);
    const commentsByTask = this.#commentsForTaskActivity(rows.map((row) => row.id));
    const activitiesByTask = this.#activitiesForTasks(rows.map((row) => row.id));
    const previewImagesByTask = this.#taskPreviewImages(rows.map((row) => row.id));
    return this.#attachTaskTiming(rows.map((row) => attachTaskActivity(
      this.#taskWithRelations(row),
      commentsByTask.get(row.id) ?? [],
      activitiesByTask.get(row.id) ?? [],
      previewImagesByTask.get(row.id) ?? null,
    )));
  }

  getTask(id) {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ? OR identifier = ?").get(id, id);
    if (!row) return null;
    const task = this.#taskWithRelations(row);
    const comments = this.#commentsForTaskActivity([task.id]).get(task.id) ?? [];
    const activities = this.#activitiesForTasks([task.id]).get(task.id) ?? [];
    const previewImage = this.#taskPreviewImages([task.id]).get(task.id) ?? null;
    return this.#attachTaskTiming([
      attachTaskActivity(task, comments, activities, previewImage),
    ])[0];
  }

  getDailyTaskTime(date, projectId) {
    const reference = new Date();
    const { start, end } = localDayBounds(date);
    const where = [
      "task_time_entries.started_at < ?",
      "(task_time_entries.ended_at IS NULL OR task_time_entries.ended_at > ?)",
    ];
    const values = [end.toISOString(), start.toISOString()];
    if (projectId) {
      where.push("task_time_entries.project_id = ?");
      values.push(projectId);
    }
    const rows = this.database.prepare(`
      SELECT
        task_time_entries.task_id,
        task_time_entries.project_id,
        task_time_entries.project_name,
        task_time_entries.started_at,
        task_time_entries.ended_at,
        task_time_entries.end_reason,
        tasks.identifier,
        tasks.external_key,
        tasks.title,
        tasks.status,
        tasks.archived_at,
        tasks.timer_paused
      FROM task_time_entries
      JOIN tasks ON tasks.id = task_time_entries.task_id
      WHERE ${where.join(" AND ")}
      ORDER BY task_time_entries.started_at, task_time_entries.id
    `).all(...values);
    const projects = new Map();
    const endedTaskIds = new Set();
    for (const row of rows) {
      const endedAt = row.ended_at ?? reference.toISOString();
      // 日报按片段与自然日的交集累计，跨午夜时不会把整段归到开始日。
      const seconds = overlapSeconds(row.started_at, endedAt, start, end);
      if (seconds <= 0) continue;
      if (
        row.ended_at !== null
        && new Date(row.ended_at) >= start
        && new Date(row.ended_at) < end
        && row.end_reason !== "manual_pause"
        && row.end_reason !== "project_changed"
      ) {
        // 结束处理只统计离开处理中的任务；暂停和项目迁移都会关闭片段，但不代表处理结束。
        endedTaskIds.add(row.task_id);
      }
      let project = projects.get(row.project_id);
      if (!project) {
        project = {
          projectId: row.project_id,
          projectName: row.project_name,
          totalSeconds: 0,
          tasks: new Map(),
        };
        projects.set(row.project_id, project);
      }
      let task = project.tasks.get(row.task_id);
      if (!task) {
        task = {
          taskId: row.task_id,
          identifier: row.external_key ?? row.identifier,
          title: row.title,
          status: row.status,
          archivedAt: row.archived_at,
          totalSeconds: 0,
          active: false,
          paused: row.timer_paused === 1,
        };
        project.tasks.set(row.task_id, task);
      }
      task.totalSeconds += seconds;
      task.active ||= row.ended_at === null && date === localDateKey(reference);
      project.totalSeconds += seconds;
    }
    const resultProjects = [...projects.values()].map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      totalSeconds: project.totalSeconds,
      tasks: [...project.tasks.values()].sort((left, right) => (
        right.totalSeconds - left.totalSeconds
        || left.identifier.localeCompare(right.identifier)
      )),
    })).sort((left, right) => (
      right.totalSeconds - left.totalSeconds
      || left.projectName.localeCompare(right.projectName)
      || left.projectId.localeCompare(right.projectId)
    ));
    return {
      date,
      asOf: reference.toISOString(),
      totalSeconds: resultProjects.reduce((total, project) => total + project.totalSeconds, 0),
      endedTaskCount: endedTaskIds.size,
      projects: resultProjects,
    };
  }

  setTaskTimerPaused(id, version, paused) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.archivedAt !== null || current.status !== "in_progress") {
      throw new ApiError(409, "TASK_TIMER_UNAVAILABLE", "Only active in-progress tasks can be paused or resumed");
    }
    if (current.timeTracking.paused === paused) return current;
    const timestamp = now();
    const project = this.database.prepare("SELECT name FROM projects WHERE id = ?")
      .get(current.projectId);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET timer_paused = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(paused ? 1 : 0, timestamp, current.id, version);
      if (result.changes !== 1) this.#throwMissingOrConflict(id, version);
      if (paused) {
        this.#closeTaskTimer(current.id, timestamp, "manual_pause");
      } else {
        this.#openTaskTimer(current.id, current.projectId, project.name, timestamp, "manual_resume");
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  getTaskTree(id, direction, depth) {
    const root = this.database.prepare(
      "SELECT * FROM tasks WHERE id = ? OR identifier = ?",
    ).get(id, id);
    if (!root) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);

    const nodes = [taskTreeNode(root, null, 0, [root.id])];
    const seen = new Set([root.id]);
    let frontier = [nodes[0]];
    const relationJoin = direction === "descendants"
      ? `
        FROM task_relations
        JOIN tasks ON tasks.id = task_relations.target_task_id
        WHERE task_relations.relation_type = 'parent'
          AND task_relations.source_task_id IN (%PLACEHOLDERS%)
      `
      : `
        FROM task_relations
        JOIN tasks ON tasks.id = task_relations.source_task_id
        WHERE task_relations.relation_type = 'parent'
          AND task_relations.target_task_id IN (%PLACEHOLDERS%)
      `;
    const parentColumn = direction === "descendants"
      ? "task_relations.source_task_id"
      : "task_relations.target_task_id";

    for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
      const placeholders = frontier.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT tasks.*, ${parentColumn} AS tree_parent_id
        ${relationJoin.replace("%PLACEHOLDERS%", placeholders)}
        ORDER BY tasks.sort_order, tasks.created_at, tasks.id
      `).all(...frontier.map((node) => node.id));
      const rowsByParent = new Map();
      for (const row of rows) {
        const siblings = rowsByParent.get(row.tree_parent_id) ?? [];
        siblings.push(row);
        rowsByParent.set(row.tree_parent_id, siblings);
      }
      const next = [];
      for (const parent of frontier) {
        for (const row of rowsByParent.get(parent.id) ?? []) {
          if (seen.has(row.id)) continue;
          if (nodes.length >= TASK_TREE_MAX_NODES) {
            throw new ApiError(413, "TREE_TOO_LARGE", `Task tree cannot exceed ${TASK_TREE_MAX_NODES} nodes`);
          }
          const node = taskTreeNode(row, parent.id, level, [...parent.path, row.id]);
          nodes.push(node);
          next.push(node);
          seen.add(row.id);
        }
      }
      frontier = next;
    }

    return {
      rootId: root.id,
      direction,
      depth,
      nodeCount: nodes.length,
      nodes,
    };
  }

  createTask(input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.database.prepare(`
        SELECT
          projects.id,
          projects.name,
          projects.labels,
          projects.next_task_number,
          (
            SELECT tasks.identifier
            FROM tasks
            WHERE tasks.project_id = projects.id
            ORDER BY tasks.created_at, tasks.id
            LIMIT 1
          ) AS first_identifier
        FROM projects
        WHERE projects.id = ?
      `).get(input.projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${input.projectId}' does not exist`);
      }

      const prefix = projectPrefix(project);
      const maximum = this.database.prepare(`
        SELECT MAX(CAST(substr(identifier, ?) AS INTEGER)) AS number
        FROM tasks
        WHERE identifier GLOB ?
      `).get(prefix.length + 2, `${prefix}-[0-9]*`).number;
      const number = Math.max(project.next_task_number, maximum === null ? 1 : maximum + 1);
      const identifier = `${prefix}-${number}`;
      const id = randomUUID();
      const timestamp = now();
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const row = this.database.prepare(`
          SELECT MIN(sort_order) AS minimum
          FROM tasks
          WHERE project_id = ? AND status = ? AND archived_at IS NULL
        `).get(input.projectId, input.status);
        sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
      }

      this.database.prepare(`
        UPDATE projects SET next_task_number = ?, labels = ?, updated_at = ? WHERE id = ?
      `).run(
        number + 1,
        JSON.stringify([...new Set([...JSON.parse(project.labels), ...input.labels])]),
        timestamp,
        input.projectId,
      );
      this.database.prepare(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels,
          sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          git_branch, worktree_path, worktree_branch,
          start_date, due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
      `).run(
        id,
        identifier,
        input.projectId,
        input.title,
        input.description,
        input.status,
        input.priority,
        JSON.stringify(input.labels),
        sortOrder,
        ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        input.assignee.type,
        input.assignee.id,
        input.assignee.name,
        input.assignee.avatarUrl,
        input.developmentContext?.type === "branch" ? input.developmentContext.branch : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.path : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.branch : null,
        input.startDate,
        input.dueDate,
        input.recurrence?.interval ?? null,
        input.recurrence?.unit ?? null,
        timestamp,
        timestamp,
      );
      if (input.status === "in_progress") {
        this.#openTaskTimer(id, input.projectId, project.name, timestamp, "task_created");
      }
      this.database.exec("COMMIT");
      return this.getTask(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  updateTask(id, version, changes, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const activityChanges = taskFieldChanges(current, changes);
    const targetProject = Object.hasOwn(changes, "projectId")
      ? this.database.prepare("SELECT id, name, workspace_path, labels FROM projects WHERE id = ?").get(changes.projectId)
      : null;
    const currentProject = this.database.prepare("SELECT name FROM projects WHERE id = ?")
      .get(current.projectId);
    if (Object.hasOwn(changes, "projectId") && !targetProject) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${changes.projectId}' does not exist`);
    }
    const projectChanged = Boolean(targetProject && targetProject.id !== current.projectId);
    if (projectChanged) {
      const relation = this.database.prepare(`
        SELECT 1
        FROM task_relations
        WHERE source_task_id = ? OR target_task_id = ?
        LIMIT 1
      `).get(current.id, current.id);
      if (relation) {
        throw new ApiError(
          409,
          "CROSS_PROJECT_RELATION",
          "Remove issue relations before moving the issue to another project",
        );
      }
      if (this.hasAiChatThreadProjectConflict(current.id, targetProject.id)) {
        throw new ApiError(
          409,
          "AI_CHAT_PROJECT_MOVE_BLOCKED",
          "Delete issue-linked AI conversations before moving the issue to another project",
        );
      }
    }
    const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
    const recurrence = Object.hasOwn(changes, "recurrence") ? changes.recurrence : current.recurrence;
    if (recurrence && !dueDate) {
      throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
    }

    const columns = {
      projectId: "project_id",
      title: "title",
      description: "description",
      status: "status",
      priority: "priority",
      labels: "labels",
      startDate: "start_date",
      dueDate: "due_date",
    };
    const assignments = [];
    const values = [];
    for (const [key, value] of Object.entries(changes)) {
      if (key === "developmentContext") {
        assignments.push("git_branch = ?", "worktree_path = ?", "worktree_branch = ?");
        values.push(
          value?.type === "branch" ? value.branch : null,
          value?.type === "worktree" ? value.path : null,
          value?.type === "worktree" ? value.branch : null,
        );
        continue;
      }
      if (key === "recurrence") {
        assignments.push("recurrence_interval = ?", "recurrence_unit = ?");
        values.push(value?.interval ?? null, value?.unit ?? null);
        continue;
      }
      if (key === "assignee") {
        assignments.push(
          "assignee_type = ?",
          "assignee_id = ?",
          "assignee_name = ?",
          "assignee_avatar_url = ?",
        );
        values.push(value.type, value.id, value.name, value.avatarUrl);
        continue;
      }
      assignments.push(`${columns[key]} = ?`);
      values.push(key === "labels" ? JSON.stringify(value) : value);
    }
    if (Object.hasOwn(changes, "status") && changes.status !== current.status) {
      const placementProjectId = projectChanged ? targetProject.id : current.projectId;
      const row = this.database.prepare(`
        SELECT MIN(sort_order) AS minimum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(placementProjectId, changes.status, current.id);
      assignments.push("sort_order = ?");
      values.push(row.minimum === null ? 1000 : row.minimum - 1000);
    }
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    if (storedBinding && !Object.hasOwn(changes, "projectId")) {
      assignments.push(
        "thread_id = ?",
        "thread_codex_project_id = ?",
        "thread_codex_project_kind = ?",
        "thread_codex_host_id = ?",
        "thread_workspace_path = ?",
      );
      values.push(...storedBinding);
    }
    assignments.push("version = version + 1", "updated_at = ?");
    const timestamp = now();
    values.push(timestamp, current.id, version);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks SET ${assignments.join(", ")} WHERE id = ? AND version = ?
      `).run(...values);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      if (projectChanged) {
        this.database.prepare(`
          UPDATE projects SET updated_at = ? WHERE id IN (?, ?)
        `).run(timestamp, current.projectId, targetProject.id);
      }
      const destinationProjectId = projectChanged ? targetProject.id : current.projectId;
      const destinationProject = this.database.prepare(`
        SELECT labels FROM projects WHERE id = ?
      `).get(destinationProjectId);
      const taskLabels = Object.hasOwn(changes, "labels") ? changes.labels : current.labels;
      const projectLabels = JSON.parse(destinationProject.labels);
      const mergedLabels = [...new Set([...projectLabels, ...taskLabels])];
      if (mergedLabels.length !== projectLabels.length) {
        this.database.prepare(`
          UPDATE projects SET labels = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify(mergedLabels), timestamp, destinationProjectId);
      }
      this.#transitionTaskTimer({
        taskId: current.id,
        beforeStatus: current.status,
        afterStatus: changes.status ?? current.status,
        beforeProjectId: current.projectId,
        afterProjectId: destinationProjectId,
        afterProjectName: projectChanged ? targetProject.name : currentProject.name,
        paused: current.timeTracking.paused,
        beforeArchived: current.archivedAt !== null,
        afterArchived: current.archivedAt !== null,
        timestamp,
        reason: "task_updated",
      });
      this.#recordTaskActivity(current.id, actor, activityChanges, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  /**
   * 移动任务并原子记录 Jira 本地状态覆盖；`jiraStatusOverride` 只由 Jira 路由决策。
   */
  moveTask(id, version, status, sortOrder, threadId, threadBinding, actor, jiraStatusOverride = false) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.archivedAt !== null) {
      throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
    }
    if (status !== current.status && sortOrder === undefined) {
      const row = this.database.prepare(`
        SELECT MIN(sort_order) AS minimum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(current.projectId, status, current.id);
      sortOrder = row.minimum === null ? 1000 : row.minimum - 1000;
    } else if (sortOrder === undefined) {
      const row = this.database.prepare(`
        SELECT COALESCE(MAX(sort_order), 0) AS maximum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(current.projectId, status, current.id);
      sortOrder = row.maximum + 1000;
    }

    const timestamp = now();
    const project = this.database.prepare("SELECT name FROM projects WHERE id = ?")
      .get(current.projectId);
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = ?, sort_order = ?, jira_status_override = ?,
          ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(
        status,
        sortOrder,
        jiraStatusOverride ? 1 : 0,
        ...(storedBinding ?? []),
        timestamp,
        current.id,
        version,
      );
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#transitionTaskTimer({
        taskId: current.id,
        beforeStatus: current.status,
        afterStatus: status,
        beforeProjectId: current.projectId,
        afterProjectId: current.projectId,
        afterProjectName: project.name,
        paused: current.timeTracking.paused,
        beforeArchived: current.archivedAt !== null,
        afterArchived: current.archivedAt !== null,
        timestamp,
        reason: "task_moved",
      });
      this.#recordTaskActivity(
        current.id,
        actor,
        taskFieldChanges(current, { status }),
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  archiveTask(id, version, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const timestamp = now();
    const project = this.database.prepare("SELECT name FROM projects WHERE id = ?")
      .get(current.projectId);
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = ?, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(timestamp, ...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#transitionTaskTimer({
        taskId: current.id,
        beforeStatus: current.status,
        afterStatus: current.status,
        beforeProjectId: current.projectId,
        afterProjectId: current.projectId,
        afterProjectName: project.name,
        paused: current.timeTracking.paused,
        beforeArchived: current.archivedAt !== null,
        afterArchived: true,
        timestamp,
        reason: "task_archived",
      });
      this.#recordTaskActivity(
        current.id,
        actor,
        [{ field: "archivedAt", before: current.archivedAt, after: timestamp }],
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  restoreTask(id, version, threadId, threadBinding, actor) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.archivedAt === null) {
      throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be restored");
    }
    const timestamp = now();
    const project = this.database.prepare("SELECT name FROM projects WHERE id = ?")
      .get(current.projectId);
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = NULL, ${threadAssignment} version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(...(storedBinding ?? []), timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.#transitionTaskTimer({
        taskId: current.id,
        beforeStatus: current.status,
        afterStatus: current.status,
        beforeProjectId: current.projectId,
        afterProjectId: current.projectId,
        afterProjectName: project.name,
        paused: current.timeTracking.paused,
        beforeArchived: true,
        afterArchived: false,
        timestamp,
        reason: "task_restored",
      });
      this.#recordTaskActivity(
        current.id,
        actor,
        [{ field: "archivedAt", before: current.archivedAt, after: null }],
        timestamp,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  deleteArchivedTask(id, version) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireTask(id);
      this.#requireVersion(current, version);
      if (current.archivedAt === null) {
        throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be deleted");
      }
      const attachmentIds = this.database.prepare(
        "SELECT id FROM attachments WHERE task_id = ? ORDER BY created_at, id",
      ).all(current.id).map((attachment) => attachment.id);
      const result = this.database.prepare(
        "DELETE FROM tasks WHERE id = ? AND version = ? AND archived_at IS NOT NULL",
      ).run(current.id, version);
      if (result.changes !== 1) this.#throwMissingOrConflict(id, version);
      this.database.exec("COMMIT");
      return { task: current, attachmentIds };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  addTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor, origin = "manual") {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);

      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      if (relationType === "parent") {
        this.#assertNoParentCycle(task.id, relatedTask.id);
        const existing = this.database.prepare(`
          SELECT source_task_id
          FROM task_relations
          WHERE relation_type = 'parent' AND target_task_id = ?
        `).get(task.id);
        if (existing?.source_task_id === relatedTask.id) {
          throw new ApiError(409, "RELATION_EXISTS", "This parent relation already exists");
        }
        if (existing) {
          this.database.prepare(`
            DELETE FROM task_relations
            WHERE relation_type = 'parent' AND target_task_id = ?
          `).run(task.id);
        }
      } else {
        const existing = this.database.prepare(`
          SELECT 1
          FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        `).get(relationType, sourceTaskId, targetTaskId);
        if (existing) {
          throw new ApiError(409, "RELATION_EXISTS", "This issue relation already exists");
        }
      }

      const timestamp = now();
      const previousRelation = type === "parent" && task.relations.parent
        ? relationActivityValue(type, task.relations.parent)
        : null;
      this.database.prepare(`
        INSERT INTO task_relations (
          relation_type, source_task_id, target_task_id, origin, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(relationType, sourceTaskId, targetTaskId, origin, timestamp);
      this.#touchTask(task.id, version, threadId, threadBinding, timestamp);
      this.#recordTaskActivity(task.id, actor, [{
        field: "relation",
        before: previousRelation,
        after: relationActivityValue(type, relatedTask),
      }], timestamp);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  removeTaskRelation(id, version, type, relatedId, threadId, threadBinding, actor, origin) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);
      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      const relation = this.database.prepare(`
        SELECT origin
        FROM task_relations
        WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
      `).get(relationType, sourceTaskId, targetTaskId);
      if (!relation) {
        throw new ApiError(404, "RELATION_NOT_FOUND", "This issue relation does not exist");
      }
      if (origin && relation.origin !== origin) {
        this.database.exec("COMMIT");
        return {
          task: this.getTask(task.id),
          relatedTask: this.getTask(relatedTask.id),
        };
      }
      let deleted;
      if (origin === "mention" && relationType === "related") {
        const taskReference = `](?${new URLSearchParams({
          project: task.projectId,
          issue: relatedTask.identifier,
        })})`;
        const relatedTaskReference = `](?${new URLSearchParams({
          project: task.projectId,
          issue: task.identifier,
        })})`;
        deleted = this.database.prepare(`
          DELETE FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
            AND origin = 'mention'
            AND NOT EXISTS (
              SELECT 1
              FROM tasks
              WHERE (id = ? AND instr(description, ?) > 0)
                OR (id = ? AND instr(description, ?) > 0)
            )
            AND NOT EXISTS (
              SELECT 1
              FROM comments
              WHERE (task_id = ? AND instr(body, ?) > 0)
                OR (task_id = ? AND instr(body, ?) > 0)
            )
        `).run(
          relationType,
          sourceTaskId,
          targetTaskId,
          task.id,
          taskReference,
          relatedTask.id,
          relatedTaskReference,
          task.id,
          taskReference,
          relatedTask.id,
          relatedTaskReference,
        );
      } else {
        deleted = this.database.prepare(`
          DELETE FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        `).run(relationType, sourceTaskId, targetTaskId);
      }
      if (origin === "mention" && relationType === "related" && deleted.changes === 0) {
        this.database.exec("COMMIT");
        return {
          task: this.getTask(task.id),
          relatedTask: this.getTask(relatedTask.id),
        };
      }
      const timestamp = now();
      this.#touchTask(task.id, version, threadId, threadBinding, timestamp);
      this.#recordTaskActivity(task.id, actor, [{
        field: "relation",
        before: relationActivityValue(type, relatedTask),
        after: null,
      }], timestamp);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listTaskActivities(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM task_activities
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map(taskActivityFromRow);
  }

  listComments(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM comments
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map((row) => this.#commentWithAttachments(row));
  }

  listCommentsAfter(taskId, after) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM comments
      WHERE task_id = ?
        AND change_revision > ?
      ORDER BY change_revision
    `).all(task.id, after.revision)
      .map((row) => this.#commentWithAttachments(row));
  }

  createComment(taskId, input) {
    const id = randomUUID();
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(taskId);
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.database.prepare(`
        INSERT INTO comments (
          id, task_id, body, thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          author_type, author_id, author_name, author_avatar_url,
          version, created_at, updated_at, change_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        id,
        task.id,
        input.body,
        ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        timestamp,
        timestamp,
        changeRevision,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getComment(id);
  }

  getComment(id) {
    const row = this.database.prepare("SELECT * FROM comments WHERE id = ?").get(id);
    return row ? this.#commentWithAttachments(row) : null;
  }

  updateComment(id, version, body, threadId, threadBinding) {
    const storedBinding = storedThreadBinding(threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireComment(id);
      this.#requireCommentVersion(current, version);
      const changeRevision = this.#nextCommentAttachmentRevision();
      const result = this.database.prepare(`
        UPDATE comments
        SET body = ?, ${threadAssignment} version = version + 1, updated_at = ?,
          change_revision = ?
        WHERE id = ? AND version = ?
      `).run(body, ...(storedBinding ?? []), now(), changeRevision, id, version);
      if (result.changes !== 1) {
        this.#throwMissingCommentOrConflict(id, version);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getComment(id);
  }

  deleteComment(id, version) {
    const current = this.#requireComment(id);
    this.#requireCommentVersion(current, version);
    const result = this.database.prepare(`
      DELETE FROM comments WHERE id = ? AND version = ?
    `).run(id, version);
    if (result.changes !== 1) {
      this.#throwMissingCommentOrConflict(id, version);
    }
    return current;
  }

  listAttachments(taskId, after = null) {
    const task = this.#requireTask(taskId);
    if (after) {
      return this.database.prepare(`
        SELECT * FROM attachments
        WHERE task_id = ? AND comment_id IS NULL
          AND change_revision > ?
        ORDER BY change_revision
      `).all(task.id, after.revision).map(attachmentFromRow);
    }
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE task_id = ? AND comment_id IS NULL
      ORDER BY created_at, id
    `).all(task.id).map(attachmentFromRow);
  }

  createAttachment(taskId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(taskId);
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.database.prepare(`
        INSERT INTO attachments (
          id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        task.id,
        input.kind,
        input.filename,
        input.contentType,
        input.size,
        now(),
        changeRevision,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAttachment(input.id);
  }

  listCommentAttachments(commentId, after = null) {
    const comment = this.database.prepare("SELECT id FROM comments WHERE id = ?").get(commentId);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
    }
    return this.#attachmentsForComment(commentId, after);
  }

  createCommentAttachment(commentId, input) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const comment = this.#requireComment(commentId);
      const changeRevision = this.#nextCommentAttachmentRevision();
      this.database.prepare(`
        INSERT INTO attachments (
          id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        comment.taskId,
        comment.id,
        input.kind,
        input.filename,
        input.contentType,
        input.size,
        now(),
        changeRevision,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAttachment(input.id);
  }

  getAttachment(id) {
    const row = this.database.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
    return row ? attachmentFromRow(row) : null;
  }

  deleteAttachment(id) {
    const attachment = this.getAttachment(id);
    if (!attachment) {
      throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
    }
    this.database.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    return attachment;
  }

  #commentWithAttachments(row) {
    const comment = commentFromRow(row);
    comment.attachments = this.#attachmentsForComment(comment.id);
    return comment;
  }

  #aiChatThreadWithCurrentRun(row) {
    const thread = aiChatThreadFromRow(row);
    const currentRun = this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ? AND status = 'running'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get(thread.id);
    thread.currentRun = currentRun ? aiChatRunFromRow(currentRun) : null;
    const todoRows = this.database.prepare(`
      SELECT id, thread_id, run_id, data, created_at
      FROM ai_chat_events
      WHERE thread_id = ? AND type = 'todo_list'
      ORDER BY created_at DESC, rowid DESC
    `).all(thread.id);
    thread.latestTodo = todoRows
      .filter((row) => !thread.currentRun || row.run_id === thread.currentRun.id)
      .map(parseAiChatTodoProgress)
      .find(Boolean) ?? null;
    return thread;
  }

  #commentsForTaskActivity(taskIds) {
    const commentsByTask = new Map(taskIds.map((taskId) => [taskId, []]));
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT
          id, task_id,
          CASE WHEN thread_id IS NULL THEN NULL ELSE substr(body, 1, 512) END AS body,
          thread_id, thread_codex_project_id, thread_codex_project_kind,
          thread_codex_host_id, thread_workspace_path,
          author_type, author_id, author_name,
          author_avatar_url, version, updated_at
        FROM comments
        WHERE task_id IN (${placeholders})
        ORDER BY task_id, id
      `).all(...chunk);
      for (const row of rows) commentsByTask.get(row.task_id)?.push(row);
    }
    return commentsByTask;
  }

  #activitiesForTasks(taskIds) {
    const activitiesByTask = new Map(taskIds.map((taskId) => [taskId, []]));
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT
          id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, created_at
        FROM task_activities
        WHERE task_id IN (${placeholders})
        ORDER BY task_id, created_at, id
      `).all(...chunk);
      for (const row of rows) activitiesByTask.get(row.task_id)?.push(row);
    }
    return activitiesByTask;
  }

  #taskPreviewImages(taskIds) {
    const imagesByTask = new Map();
    for (let offset = 0; offset < taskIds.length; offset += 400) {
      const chunk = taskIds.slice(offset, offset + 400);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT attachments.*
        FROM attachments
        JOIN tasks ON tasks.id = attachments.task_id
        WHERE attachments.task_id IN (${placeholders})
          AND attachments.comment_id IS NULL
          AND attachments.content_type LIKE 'image/%'
          AND instr(tasks.description, 'api/attachments/' || attachments.id || '/content') > 0
        ORDER BY attachments.task_id, attachments.created_at, attachments.id
      `).all(...chunk);
      for (const row of rows) {
        if (!imagesByTask.has(row.task_id)) imagesByTask.set(row.task_id, attachmentFromRow(row));
      }
    }
    return imagesByTask;
  }

  #attachmentsForComment(commentId, after = null) {
    if (after) {
      return this.database.prepare(`
        SELECT * FROM attachments
        WHERE comment_id = ?
          AND change_revision > ?
        ORDER BY change_revision
      `).all(commentId, after.revision).map(attachmentFromRow);
    }
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE comment_id = ?
      ORDER BY created_at, id
    `).all(commentId).map(attachmentFromRow);
  }

  #nextCommentAttachmentRevision() {
    return this.database.prepare(`
      UPDATE comment_attachment_revision
      SET value = value + 1
      WHERE id = 1
      RETURNING value
    `).get().value;
  }

  #taskWithRelations(row) {
    const task = taskFromRow(row);
    const parent = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.target_task_id = ?
    `).get(task.id);
    const subIssues = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blockedBy = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blocks = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const related = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = CASE
        WHEN task_relations.source_task_id = ? THEN task_relations.target_task_id
        ELSE task_relations.source_task_id
      END
      WHERE task_relations.relation_type = 'related'
        AND (
          task_relations.source_task_id = ?
          OR task_relations.target_task_id = ?
        )
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id, task.id, task.id);
    task.relations = {
      parent: parent ? taskRelationSummaryFromRow(parent) : null,
      subIssues: subIssues.map(taskRelationSummaryFromRow),
      blockedBy: blockedBy.map(taskRelationSummaryFromRow),
      blocks: blocks.map(taskRelationSummaryFromRow),
      related: related.map(taskRelationSummaryFromRow),
    };
    return task;
  }

  #validateRelationTasks(task, relatedTask) {
    if (task.id === relatedTask.id) {
      throw new ApiError(400, "SELF_RELATION", "An issue cannot be related to itself");
    }
    if (task.projectId !== relatedTask.projectId) {
      throw new ApiError(400, "CROSS_PROJECT_RELATION", "Issue relations must stay within one project");
    }
  }

  #relationEndpoints(type, taskId, relatedTaskId) {
    if (type === "parent") {
      return {
        relationType: "parent",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    if (type === "blocks") {
      return {
        relationType: "blocks",
        sourceTaskId: taskId,
        targetTaskId: relatedTaskId,
      };
    }
    if (type === "blocked_by") {
      return {
        relationType: "blocks",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    const [sourceTaskId, targetTaskId] = [taskId, relatedTaskId].sort();
    return { relationType: "related", sourceTaskId, targetTaskId };
  }

  #assertNoParentCycle(childId, parentId) {
    const cycle = this.database.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT source_task_id
        FROM task_relations
        WHERE relation_type = 'parent' AND target_task_id = ?
        UNION
        SELECT task_relations.source_task_id
        FROM task_relations
        JOIN ancestors ON task_relations.target_task_id = ancestors.id
        WHERE task_relations.relation_type = 'parent'
      )
      SELECT 1 FROM ancestors WHERE id = ?
    `).get(parentId, childId);
    if (cycle) {
      throw new ApiError(409, "RELATION_CYCLE", "This parent would create a cycle");
    }
  }

  #recordTaskActivity(taskId, actor, changes, timestamp) {
    if (changes.length === 0) return;
    this.database.prepare(`
      INSERT INTO task_activities (
        id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      taskId,
      actor.type,
      actor.id,
      actor.name,
      actor.avatarUrl,
      JSON.stringify(changes),
      timestamp,
    );
  }

  #touchTask(id, version, threadId, threadBinding, timestamp) {
    const current = this.#requireTask(id);
    const storedBinding = storedThreadBindingForExisting(current, threadBinding, threadId);
    const threadAssignment = storedBinding
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    const result = this.database.prepare(`
      UPDATE tasks
      SET ${threadAssignment} version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(...(storedBinding ?? []), timestamp, id, version);
    if (result.changes !== 1) {
      this.#throwMissingOrConflict(id, version);
    }
  }

  #requireTask(id) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    return task;
  }

  #requireComment(id) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    return comment;
  }

  #requireVersion(task, expectedVersion) {
    if (task.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
        expectedVersion,
        actualVersion: task.version,
      });
    }
  }

  #requireCommentVersion(comment, expectedVersion) {
    if (comment.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
        expectedVersion,
        actualVersion: comment.version,
      });
    }
  }

  #throwMissingOrConflict(id, expectedVersion) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
      expectedVersion,
      actualVersion: task.version,
    });
  }

  #throwMissingCommentOrConflict(id, expectedVersion) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
      expectedVersion,
      actualVersion: comment.version,
    });
  }
}
