import { createHash } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { JIRA_PROJECT_ID } from "../shared/domain.mjs";
import { ApiError } from "./database.mjs";

const JIRA_FIELDS = [
  "summary",
  "description",
  "status",
  "priority",
  "labels",
  "issuetype",
  "attachment",
  "duedate",
  "assignee",
  "reporter",
  "created",
  "updated",
];
const SYNC_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const JIRA_IMAGE_ATTACHMENT_LIMIT = 25 * 1024 * 1024;
const JIRA_IMAGE_REDIRECT_LIMIT = 3;

function quoteJqlString(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildJiraJql(projects = []) {
  const projectFilter = projects.length > 0
    ? ` AND project in (${projects.map(quoteJqlString).join(", ")})`
    : "";
  return `assignee = currentUser()${projectFilter} AND (statusCategory != Done OR updated >= -30d) ORDER BY updated DESC`;
}

function includesAny(value, terms) {
  const normalized = String(value ?? "").toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function limitedString(value, fallback, maxLength) {
  const result = String(value ?? fallback).trim();
  return (result || fallback).slice(0, maxLength);
}

export function taskStatusFromJira(status) {
  const name = status?.name ?? "";
  const category = status?.statusCategory?.key;
  if (category === "done") {
    return includesAny(name, ["cancel", "reject", "取消", "拒绝"]) ? "canceled" : "done";
  }
  if (category === "new") {
    return includesAny(name, ["backlog", "待立项", "需求池"]) ? "backlog" : "todo";
  }
  if (includesAny(name, ["review", "verify", "test", "验收", "评审", "测试"])) {
    return "in_review";
  }
  if (includesAny(name, ["block", "hold", "阻塞", "挂起"])) return "blocked";
  return "in_progress";
}

export function taskPriorityFromJira(priority) {
  const name = priority?.name ?? "";
  if (includesAny(name, ["highest", "critical", "blocker", "urgent", "紧急", "最高"])) {
    return "urgent";
  }
  if (includesAny(name, ["high", "major", "高"])) return "high";
  if (includesAny(name, ["medium", "normal", "中"])) return "medium";
  if (includesAny(name, ["low", "minor", "trivial", "低"])) return "low";
  return "none";
}

function actorFromJira(user, fallback) {
  const id = limitedString(user?.key ?? user?.name ?? user?.accountId, fallback, 240);
  return {
    type: "user",
    id: `jira:${id}`,
    name: limitedString(user?.displayName ?? user?.name, fallback, 120),
    avatarUrl: user?.avatarUrls?.["48x48"] ?? user?.avatarUrls?.["32x32"] ?? null,
  };
}

function jiraOriginId(manifest) {
  const applicationId = typeof manifest?.id === "string" ? manifest.id.trim() : "";
  if (!applicationId) {
    throw new ApiError(502, "INVALID_JIRA_ORIGIN", "Jira 未返回稳定的实例身份");
  }
  return createHash("sha256").update(applicationId).digest("hex");
}

function legacyJiraOriginId(baseUrl) {
  return createHash("sha256").update(baseUrl).digest("hex").slice(0, 16);
}

function issueTypeFromJira(fields) {
  // 存 Jira 类型显示名（故障/任务/故事），打开对话和列表标签都按名称分支，不使用易变的数字 id。
  const name = typeof fields?.issuetype?.name === "string" ? fields.issuetype.name.trim() : "";
  return name ? name.slice(0, 64) : null;
}

function jiraImageContentType(value) {
  const contentType = String(value ?? "").split(";", 1)[0].trim().toLowerCase();
  return contentType.startsWith("image/") && contentType.length <= 200 ? contentType : null;
}

function jiraAttachmentFilename(value) {
  const filename = String(value ?? "image").trim().slice(0, 240) || "image";
  const safe = filename.replace(/[\u0000-\u001f\u007f/\\]/g, "_");
  return safe === "." || safe === ".." ? "image" : safe;
}

function jiraImageAttachmentId(originId, jiraAttachmentId) {
  // 同一 Jira 附件始终映射到同一本地 id，手动删除后下次同步会按原 URL 重建。
  const digest = createHash("sha256")
    .update(`${originId}:${jiraAttachmentId}`)
    .digest("hex")
    .slice(0, 32);
  return `jimg-${digest}`;
}

function markdownAlt(value) {
  return String(value ?? "image").replace(/[[\]]/g, "");
}

export function rewriteJiraWikiImages(description, images) {
  const attachments = Array.isArray(images) ? images.filter(Boolean) : [];
  const text = String(description ?? "");
  if (attachments.length === 0) return text.slice(0, 100_000);

  const byName = new Map();
  for (const image of attachments) {
    if (!byName.has(image.filename)) byName.set(image.filename, image);
  }
  const used = new Set();
  let rewritten = text.replace(/!([^!\n|]+)(?:\|[^!\n]*)?!/g, (match, rawName) => {
    const name = String(rawName ?? "").trim();
    const image = byName.get(name);
    if (!image) return match;
    used.add(image.id);
    return `![${markdownAlt(name)}](api/attachments/${image.id}/content)`;
  });
  const extras = attachments.filter((image) => !used.has(image.id));
  if (extras.length > 0) {
    const block = extras
      .map((image) => `![${markdownAlt(image.filename)}](api/attachments/${image.id}/content)`)
      .join("\n");
    rewritten = rewritten.trimEnd() ? `${rewritten.trimEnd()}\n\n${block}` : block;
  }
  return rewritten.slice(0, 100_000);
}

export function restoreJiraWikiImages(description) {
  return String(description ?? "").replace(
    /!\[([^\]]*)\]\(api\/attachments\/(jimg-[a-f0-9]{32})\/content\)/g,
    (_match, alt) => `!${alt || "image"}!`,
  );
}

function normalizeIssue(issue, config, index = 0) {
  const fields = issue?.fields ?? {};
  const externalId = String(issue.id);
  const externalKey = limitedString(issue.key, "JIRA", 128);
  const internalId = `JIRA:${config.originId.toUpperCase()}:${externalId}`;
  const assignee = actorFromJira(fields.assignee, config.displayName);
  const reporter = actorFromJira(fields.reporter, config.displayName);
  const labels = Array.isArray(fields.labels)
    ? [...new Set(fields.labels.flatMap((label) => {
      if (typeof label !== "string") return [];
      const normalized = label.trim().slice(0, 64);
      return normalized ? [normalized] : [];
    }))].slice(0, 20)
    : [];
  return {
    id: internalId,
    identifier: internalId,
    title: limitedString(fields.summary, externalKey, 240),
    description: typeof fields.description === "string" ? fields.description.slice(0, 100_000) : "",
    status: taskStatusFromJira(fields.status),
    priority: taskPriorityFromJira(fields.priority),
    issueType: issueTypeFromJira(fields),
    labels,
    sortOrder: (index + 1) * 1024,
    creator: reporter,
    assignee,
    dueDate: typeof fields.duedate === "string" ? fields.duedate : null,
    externalOrigin: config.originId,
    externalId,
    externalKey,
    externalUrl: `${config.baseUrl}/browse/${encodeURIComponent(externalKey)}`,
    createdAt: typeof fields.created === "string" ? fields.created : new Date().toISOString(),
    updatedAt: typeof fields.updated === "string" ? fields.updated : new Date().toISOString(),
  };
}

function safeConfig(config, lastSyncedAt = null) {
  return config
    ? {
      configured: true,
      baseUrl: config.baseUrl,
      username: null,
      displayName: config.displayName,
      projects: config.projects,
      projectId: JIRA_PROJECT_ID,
      lastSyncedAt,
      insecureHttp: config.baseUrl.startsWith("http:"),
    }
    : {
      configured: false,
      baseUrl: null,
      username: null,
      displayName: null,
      projects: [],
      projectId: JIRA_PROJECT_ID,
      lastSyncedAt: null,
      insecureHttp: false,
    };
}

export function createJiraIntegration({
  configStore,
  database,
  attachmentsDirectory = null,
  fetch: fetchImplementation = globalThis.fetch,
}) {
  let lastSyncedAt = null;
  let pendingSync = null;

  function authorizationHeader(config) {
    return `Basic ${Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64")}`;
  }

  async function request(config, pathname, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    let response;
    try {
      response = await fetchImplementation(`${config.baseUrl}${pathname}`, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: authorizationHeader(config),
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw new ApiError(
        502,
        timedOut ? "JIRA_TIMEOUT" : "JIRA_UNAVAILABLE",
        timedOut ? "连接 Jira 超时" : "无法连接 Jira，请检查地址和内网连接",
      );
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(
        401,
        "JIRA_AUTH_FAILED",
        "Jira 登录失败，请检查用户名、密码、Basic Auth 或 CAPTCHA 状态",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ApiError(400, "JIRA_REDIRECT", "Jira 地址发生重定向，请填写最终访问地址");
    }
    if (!response.ok) {
      throw new ApiError(
        response.status >= 500 ? 502 : 409,
        "JIRA_REQUEST_FAILED",
        `Jira 请求失败（HTTP ${response.status}）`,
      );
    }
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new ApiError(502, "INVALID_JIRA_RESPONSE", "Jira 返回了无效的 JSON 数据");
    }
  }

  function sameOriginUrl(config, target) {
    try {
      const base = new URL(config.baseUrl);
      const url = new URL(target, config.baseUrl);
      return url.origin === base.origin ? url : null;
    } catch {
      return null;
    }
  }

  async function downloadJiraAttachment(config, attachment) {
    const contentType = jiraImageContentType(attachment?.mimeType);
    if (!contentType) return null;
    const size = Number(attachment?.size);
    if (Number.isFinite(size) && size > JIRA_IMAGE_ATTACHMENT_LIMIT) return null;
    let url = sameOriginUrl(config, attachment?.content ?? "");
    if (!url) return null;

    for (let hop = 0; hop <= JIRA_IMAGE_REDIRECT_LIMIT; hop += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      let response;
      try {
        response = await fetchImplementation(url.href, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "image/*,application/octet-stream;q=0.8,*/*;q=0.1",
            authorization: authorizationHeader(config),
          },
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        throw new ApiError(
          502,
          timedOut ? "JIRA_TIMEOUT" : "JIRA_UNAVAILABLE",
          timedOut ? "连接 Jira 超时" : "无法连接 Jira，请检查地址和内网连接",
        );
      } finally {
        clearTimeout(timeout);
      }
      if (response.status === 401 || response.status === 403) {
        throw new ApiError(
          401,
          "JIRA_AUTH_FAILED",
          "Jira 登录失败，请检查用户名、密码、Basic Auth 或 CAPTCHA 状态",
        );
      }
      if (response.status >= 300 && response.status < 400) {
        const next = sameOriginUrl(config, response.headers.get("location") ?? "");
        if (!next || hop === JIRA_IMAGE_REDIRECT_LIMIT) return null;
        url = next;
        continue;
      }
      if (response.status === 404) return null;
      if (!response.ok) return null;
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length === 0 || body.length > JIRA_IMAGE_ATTACHMENT_LIMIT) return null;
      const headerType = response.headers.get("content-type");
      const responseType = headerType ? jiraImageContentType(headerType) : contentType;
      if (!responseType) return null;
      return { body, contentType: responseType };
    }
    return null;
  }

  async function ensureJiraImageAttachments(config, task, jiraAttachments) {
    if (!attachmentsDirectory || !task) return [];
    const images = [];
    const list = Array.isArray(jiraAttachments) ? jiraAttachments : [];
    for (const attachment of list) {
      const contentType = jiraImageContentType(attachment?.mimeType);
      const jiraId = attachment?.id == null ? "" : String(attachment.id).trim();
      if (!contentType || !jiraId) continue;
      const id = jiraImageAttachmentId(config.originId, jiraId);
      const filename = jiraAttachmentFilename(attachment.filename);
      const existing = database.getAttachment(id);
      const storagePath = path.join(attachmentsDirectory, id);
      let fileOk = false;
      try {
        const file = await stat(storagePath);
        fileOk = file.isFile() && file.size > 0 && (!existing || file.size === existing.size);
      } catch {
        fileOk = false;
      }
      if (existing?.taskId === task.id && fileOk) {
        images.push(existing);
        continue;
      }
      let downloaded;
      try {
        downloaded = await downloadJiraAttachment(config, attachment);
      } catch (error) {
        if (
          error instanceof ApiError
          && (error.code === "JIRA_AUTH_FAILED" || error.code === "JIRA_TIMEOUT" || error.code === "JIRA_UNAVAILABLE")
        ) {
          throw error;
        }
        continue;
      }
      if (!downloaded) continue;
      await mkdir(attachmentsDirectory, { recursive: true });
      const tempPath = `${storagePath}.${process.pid}.tmp`;
      try {
        await writeFile(tempPath, downloaded.body);
        await rename(tempPath, storagePath);
      } catch (error) {
        try {
          await unlink(tempPath);
        } catch {
          // 临时文件可能尚未写出。
        }
        throw error;
      }
      if (!existing) {
        try {
          database.createAttachment(task.id, {
            id,
            kind: "inline",
            filename,
            contentType: downloaded.contentType,
            size: downloaded.body.length,
          });
        } catch {
          const storedAfterConflict = database.getAttachment(id);
          if (!storedAfterConflict) {
            try {
              await unlink(storagePath);
            } catch {
              // 回滚文件失败时留给下次同步覆盖。
            }
            continue;
          }
        }
      }
      const stored = database.getAttachment(id);
      if (stored) images.push(stored);
    }
    return images;
  }

  async function persistAssignedIssues(config, rawIssues, { archiveMissing, projectName, legacyIdentity }) {
    const items = rawIssues.map((raw, index) => ({
      raw,
      wikiDescription: typeof raw?.fields?.description === "string"
        ? raw.fields.description.slice(0, 100_000)
        : "",
      issue: normalizeIssue(raw, config, index),
    }));

    for (const item of items) {
      const existing = database.getTask(item.issue.id) ?? database.getTask(item.issue.externalKey);
      if (!existing) continue;
      const images = await ensureJiraImageAttachments(config, existing, item.raw.fields?.attachment);
      item.issue.description = rewriteJiraWikiImages(item.wikiDescription, images);
    }

    database.syncJiraTasks(items.map((item) => item.issue), {
      archiveMissing,
      projectName,
      legacyIdentity,
    });

    for (const item of items) {
      const task = database.getTask(item.issue.id) ?? database.getTask(item.issue.externalKey);
      if (!task) continue;
      const images = await ensureJiraImageAttachments(config, task, item.raw.fields?.attachment);
      item.issue.description = rewriteJiraWikiImages(item.wikiDescription, images);
    }
    database.syncJiraTasks(items.map((item) => item.issue), {
      archiveMissing: false,
      projectName,
      legacyIdentity,
    });
  }

  async function fetchAssignedIssues(config) {
    const issues = [];
    let startAt = 0;
    while (true) {
      const page = await request(config, "/rest/api/2/search", {
        method: "POST",
        body: JSON.stringify({
          jql: buildJiraJql(config.projects),
          startAt,
          maxResults: 100,
          fields: JIRA_FIELDS,
        }),
      });
      const pageIssues = Array.isArray(page?.issues) ? page.issues : [];
      issues.push(...pageIssues);
      startAt += pageIssues.length;
      if (pageIssues.length === 0 || startAt >= Number(page?.total ?? 0)) break;
    }
    return issues;
  }

  async function fetchOriginId(config) {
    return jiraOriginId(await request(config, "/rest/applinks/1.0/manifest"));
  }

  async function assertLiveOrigin(config) {
    if (await fetchOriginId(config) !== config.originId) {
      throw new ApiError(
        409,
        "JIRA_ORIGIN_MISMATCH",
        "当前 Jira 地址指向了另一个实例，请重新连接后再操作",
      );
    }
  }

  async function validateConnection(candidate) {
    const originId = await fetchOriginId(candidate);
    const myself = await request(candidate, "/rest/api/2/myself");
    const displayName = String(myself?.displayName ?? myself?.name ?? candidate.username).trim();
    const config = { ...candidate, originId, displayName };
    const issues = await fetchAssignedIssues(config);
    return { config, issues };
  }

  async function syncWithConfig(storedConfig, { archiveMissing = true } = {}) {
    let config = storedConfig;
    let issues;
    let legacyIdentity = null;
    if (storedConfig.version === 1) {
      ({ config, issues } = await validateConnection(storedConfig));
      legacyIdentity = {
        urlHash: legacyJiraOriginId(storedConfig.baseUrl),
        originId: config.originId,
      };
    } else {
      await assertLiveOrigin(config);
      issues = await fetchAssignedIssues(config);
    }
    await persistAssignedIssues(config, issues, {
      archiveMissing,
      projectName: `Jira · ${config.displayName}`,
      legacyIdentity,
    });
    if (storedConfig.version === 1) config = await configStore.save(config);
    lastSyncedAt = new Date().toISOString();
    return safeConfig(config, lastSyncedAt);
  }

  async function sync({ force = false } = {}) {
    const config = await configStore.read();
    if (!config) return safeConfig(null);
    if (!force && lastSyncedAt && Date.now() - new Date(lastSyncedAt).getTime() < SYNC_INTERVAL_MS) {
      return safeConfig(config, lastSyncedAt);
    }
    if (pendingSync) return pendingSync;
    pendingSync = syncWithConfig(config).finally(() => {
      pendingSync = null;
    });
    return pendingSync;
  }

  async function resolveTransition(config, issueKey, targetStatus) {
    const payload = await request(
      config,
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions?expand=transitions.fields`,
    );
    const transitions = Array.isArray(payload?.transitions) ? payload.transitions : [];
    const matches = transitions.filter((candidate) => taskStatusFromJira(candidate.to) === targetStatus);
    const availableStatuses = transitions.map((candidate) => ({
      id: String(candidate.id),
      name: String(candidate.name ?? candidate.to?.name ?? ""),
      taskboardStatus: taskStatusFromJira(candidate.to),
    }));
    if (matches.length === 0) {
      throw new ApiError(
        409,
        "JIRA_TRANSITION_UNAVAILABLE",
        `Jira 当前工作流不能将 ${issueKey} 移到目标状态`,
        { availableStatuses },
      );
    }
    if (matches.length > 1) {
      throw new ApiError(
        409,
        "JIRA_TRANSITION_AMBIGUOUS",
        `Jira 有多个工作流操作可将 ${issueKey} 移到目标状态，请在 Jira 中选择`,
        {
          availableStatuses: availableStatuses.filter(
            (candidate) => candidate.taskboardStatus === targetStatus,
          ),
        },
      );
    }
    return matches[0];
  }

  async function applyTransition(config, issueKey, transition) {
    await request(config, `/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: String(transition.id) } }),
    });
  }

  async function resolveJiraPriority(config, targetPriority) {
    if (targetPriority === "none") return null;
    const priorities = await request(config, "/rest/api/2/priority");
    const match = Array.isArray(priorities)
      ? priorities.find((priority) => taskPriorityFromJira(priority) === targetPriority)
      : null;
    if (!match) {
      throw new ApiError(
        409,
        "JIRA_PRIORITY_UNAVAILABLE",
        "Jira 中没有可映射到该优先级的选项",
      );
    }
    return { id: String(match.id) };
  }

  return {
    async status() {
      return safeConfig(await configStore.read(), lastSyncedAt);
    },
    async configure(input) {
      const current = await configStore.read();
      const username = input.username || current?.username;
      const password = input.password || current?.password;
      const candidate = configStore.validate({ ...input, username, password });
      if (current?.version === 1 && candidate.baseUrl !== current.baseUrl) {
        throw new ApiError(
          409,
          "JIRA_LEGACY_URL_CHANGE_UNAVAILABLE",
          "请先使用原 Jira 地址完成配置升级，再修改地址",
        );
      }
      if (
        !input.password
        && (
          !current
          || candidate.baseUrl !== current.baseUrl
          || candidate.username !== current.username
        )
      ) {
        throw new ApiError(
          400,
          "JIRA_PASSWORD_REQUIRED",
          "修改 Jira 地址或用户名时必须重新输入密码",
        );
      }
      const { config, issues } = await validateConnection(candidate);
      const legacyIdentity = current?.version === 1
        ? { urlHash: legacyJiraOriginId(current.baseUrl), originId: config.originId }
        : null;
      await persistAssignedIssues(config, issues, {
        archiveMissing: true,
        projectName: `Jira · ${config.displayName}`,
        legacyIdentity,
      });
      const savedConfig = await configStore.save(config);
      lastSyncedAt = new Date().toISOString();
      return safeConfig(savedConfig, lastSyncedAt);
    },
    sync,
    async reconcile() {
      const config = await configStore.read();
      if (!config || config.version !== 2) {
        throw new ApiError(409, "JIRA_NOT_CONFIGURED", "Jira 尚未完成稳定身份配置");
      }
      return syncWithConfig(config, { archiveMissing: false });
    },
    async updateTask(task, changes) {
      const config = await configStore.read();
      if (!config) throw new ApiError(409, "JIRA_NOT_CONFIGURED", "Jira 尚未配置");
      if (task.externalOrigin !== config.originId || !task.externalKey) {
        throw new ApiError(
          409,
          "JIRA_ORIGIN_MISMATCH",
          "此任务不属于当前 Jira 连接，请重新同步后再操作",
        );
      }
      await assertLiveOrigin(config);
      const statusChanged = Object.hasOwn(changes, "status") && changes.status !== task.status;
      const priorityChanged = Object.hasOwn(changes, "priority") && changes.priority !== task.priority;
      const fields = {};
      if (Object.hasOwn(changes, "title") && changes.title !== task.title) fields.summary = changes.title;
      if (Object.hasOwn(changes, "description") && changes.description !== task.description) {
        // 回写 Jira 时把本地 Markdown 图还原成 wiki，避免把 Taskboard 附件 URL 写进 Jira。
        fields.description = restoreJiraWikiImages(changes.description);
      }
      if (Object.hasOwn(changes, "labels") && JSON.stringify(changes.labels) !== JSON.stringify(task.labels)) {
        fields.labels = changes.labels;
      }
      if (Object.hasOwn(changes, "dueDate") && changes.dueDate !== task.dueDate) {
        fields.duedate = changes.dueDate;
      }
      const fieldsChanged = Object.keys(fields).length > 0 || priorityChanged;
      if (statusChanged && fieldsChanged) {
        throw new ApiError(
          409,
          "JIRA_MULTI_STEP_UPDATE_UNAVAILABLE",
          "请分开修改 Jira 状态和其他字段",
        );
      }
      if (priorityChanged) {
        fields.priority = await resolveJiraPriority(config, changes.priority);
      }
      const transition = statusChanged
        ? await resolveTransition(config, task.externalKey, changes.status)
        : null;
      if (transition) {
        await applyTransition(config, task.externalKey, transition);
        return true;
      }
      if (fieldsChanged) {
        await request(config, `/rest/api/2/issue/${encodeURIComponent(task.externalKey)}`, {
          method: "PUT",
          body: JSON.stringify({ fields }),
        });
        return true;
      }
      return false;
    },
    async moveTask(task, status) {
      if (status === task.status) return;
      const config = await configStore.read();
      if (!config) throw new ApiError(409, "JIRA_NOT_CONFIGURED", "Jira 尚未配置");
      if (task.externalOrigin !== config.originId || !task.externalKey) {
        throw new ApiError(
          409,
          "JIRA_ORIGIN_MISMATCH",
          "此任务不属于当前 Jira 连接，请重新同步后再操作",
        );
      }
      await assertLiveOrigin(config);
      const transition = await resolveTransition(config, task.externalKey, status);
      await applyTransition(config, task.externalKey, transition);
    },
  };
}
