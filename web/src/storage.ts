const memoryStorage = new Map<string, string>();
export const PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX = "taskboard.project-board-display-settings.v3.";
const RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;
let localStorageBackend: Storage | null = null;
let serverBacked = false;
let storageWrite = Promise.resolve();
let storageRefresh = Promise.resolve();

function isProjectBoardDisplaySettingsKey(key: string) {
  return key.startsWith(PROJECT_BOARD_DISPLAY_SETTINGS_KEY_PREFIX);
}

async function readServerStorage() {
  const response = await fetch(new URL("api/client-storage", document.baseURI));
  if (!response.ok) throw new Error(`Taskboard storage returned ${response.status}`);
  const payload = await response.json() as { entries: Record<string, string> };
  if (localStorageBackend) {
    for (const key of memoryStorage.keys()) {
      if (isProjectBoardDisplaySettingsKey(key)) memoryStorage.delete(key);
    }
    for (const [key, value] of Object.entries(payload.entries)) {
      if (isProjectBoardDisplaySettingsKey(key)) memoryStorage.set(key, value);
    }
    return;
  }
  memoryStorage.clear();
  for (const [key, value] of Object.entries(payload.entries)) {
    memoryStorage.set(key, value);
  }
  serverBacked = true;
}

async function refreshServerStorage() {
  storageRefresh = storageRefresh.catch(() => {}).then(readServerStorage);
  await storageRefresh;
}

function persist(key: string, value: string | null) {
  storageWrite = storageWrite.then(async () => {
    const body = JSON.stringify({ key, value });
    const keepalive = new TextEncoder().encode(body).byteLength <= 64 * 1024;
    let retryDelay = RETRY_DELAY_MS;
    while (true) {
      try {
        const response = await fetch(new URL("api/client-storage", document.baseURI), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body,
          keepalive,
        });
        if (response.ok) return;
        const error = new Error(`Taskboard storage returned ${response.status}`);
        if (response.status >= 400 && response.status < 500) {
          console.error(error);
          return;
        }
        throw error;
      } catch (error) {
        console.error(error);
        await new Promise((resolve) => window.setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
      }
    }
  });
}

export async function initializeTaskboardStorage() {
  try {
    localStorageBackend = window.localStorage;
  } catch {
    localStorageBackend = null;
  }
  await refreshServerStorage();
}

export async function refreshProjectBoardDisplaySettingsStorage() {
  await storageWrite;
  await refreshServerStorage();
}

export function projectBoardDisplaySettingsStorageEntries() {
  return [...memoryStorage.entries()].filter(([key]) => isProjectBoardDisplaySettingsKey(key));
}

export const taskboardStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem(key) {
    if (isProjectBoardDisplaySettingsKey(key)) return memoryStorage.get(key) ?? null;
    return localStorageBackend?.getItem(key) ?? memoryStorage.get(key) ?? null;
  },
  setItem(key, value) {
    if (isProjectBoardDisplaySettingsKey(key)) {
      memoryStorage.set(key, value);
      persist(key, value);
      return;
    }
    if (localStorageBackend) {
      localStorageBackend.setItem(key, value);
      return;
    }
    memoryStorage.set(key, value);
    if (serverBacked) persist(key, value);
  },
  removeItem(key) {
    if (isProjectBoardDisplaySettingsKey(key)) {
      memoryStorage.delete(key);
      persist(key, null);
      return;
    }
    if (localStorageBackend) {
      localStorageBackend.removeItem(key);
      return;
    }
    memoryStorage.delete(key);
    if (serverBacked) persist(key, null);
  },
};

export const TASK_SESSION_HANDSHAKES_KEY = "taskboard.task-session-handshakes.v1";

export type TaskSessionHandshakeRole = "parent" | "child";

export interface PendingTaskSessionHandshake {
  taskId: string;
  orchestrationId: string;
  conversationRole: TaskSessionHandshakeRole;
  openingRequestId: string;
  expiresAt: number;
}

function sessionStorageBackend(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function validTaskSessionHandshake(value: unknown, now = Date.now()): value is PendingTaskSessionHandshake {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const expiresAt = candidate.expiresAt;
  return typeof candidate.taskId === "string"
    && candidate.taskId.length > 0
    && typeof candidate.orchestrationId === "string"
    && candidate.orchestrationId.length > 0
    && (candidate.conversationRole === "parent" || candidate.conversationRole === "child")
    && typeof candidate.openingRequestId === "string"
    && candidate.openingRequestId.length > 0
    && typeof expiresAt === "number"
    && Number.isSafeInteger(expiresAt)
    && expiresAt > now;
}

/** 只在当前浏览器 tab 保留握手关联，避免跨 tab 复用旧的宿主回包。 */
export function readPendingTaskSessionHandshakes(now = Date.now()): PendingTaskSessionHandshake[] {
  const storage = sessionStorageBackend();
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(TASK_SESSION_HANDSHAKES_KEY) ?? "[]");
    const values = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
    return values.filter((value): value is PendingTaskSessionHandshake => validTaskSessionHandshake(value, now));
  } catch {
    return [];
  }
}

export function rememberPendingTaskSessionHandshake(entry: PendingTaskSessionHandshake): void {
  if (!validTaskSessionHandshake(entry)) return;
  const storage = sessionStorageBackend();
  if (!storage) return;
  try {
    const next = readPendingTaskSessionHandshakes().filter((candidate) => (
      candidate.openingRequestId !== entry.openingRequestId
      && !(
        candidate.taskId === entry.taskId
        && candidate.orchestrationId === entry.orchestrationId
        && candidate.conversationRole === entry.conversationRole
      )
    ));
    next.push(entry);
    storage.setItem(TASK_SESSION_HANDSHAKES_KEY, JSON.stringify(next.slice(-32)));
  } catch {
    // sessionStorage 可能因隐私模式或 opaque origin 不可写，内存握手仍可继续工作。
  }
}

export function clearPendingTaskSessionHandshake(match: Partial<PendingTaskSessionHandshake>): void {
  const storage = sessionStorageBackend();
  if (!storage) return;
  try {
    const current = readPendingTaskSessionHandshakes();
    const next = current.filter((candidate) => (
      (match.taskId === undefined || candidate.taskId !== match.taskId)
      || (match.orchestrationId === undefined || candidate.orchestrationId !== match.orchestrationId)
      || (match.conversationRole === undefined || candidate.conversationRole !== match.conversationRole)
      || (match.openingRequestId === undefined || candidate.openingRequestId !== match.openingRequestId)
    ));
    if (next.length === 0) storage.removeItem(TASK_SESSION_HANDSHAKES_KEY);
    else if (next.length !== current.length) storage.setItem(TASK_SESSION_HANDSHAKES_KEY, JSON.stringify(next));
  } catch {
    // 清理失败不会影响数据库中的绑定结果，下一次读取会按过期时间过滤。
  }
}
