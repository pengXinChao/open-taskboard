import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  acknowledgeTaskSessionReport,
  completeTaskSession,
  confirmTaskSessionIntent,
  createTaskSessionOrchestration,
  dispatchTaskSession,
  getTaskSessionOrchestration,
  getTaskSessionForTask,
  integrateTaskSession,
  reportTaskSessionResult,
  reviewTaskSession,
  saveTaskSessionIntent,
  saveTaskSessionWriteback,
  type TaskSessionView,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import type {
  CodexThreadBinding,
  Task,
  TaskIntentRevision,
  TaskResultRevision,
  TaskSessionOrchestration,
} from "../types";
import {
  clearPendingTaskSessionHandshake,
  readPendingTaskSessionHandshakes,
  type PendingTaskSessionHandshake,
} from "../storage";
import { postEmbeddedHostMessage } from "../embeddedHost.mjs";

interface TaskSessionOrchestrationPanelProps {
  task: Task;
  parentThreadBinding: CodexThreadBinding | { threadId: string } | null;
  orchestrationRevision: number;
  onCreateParent: (task: Task, orchestration: TaskSessionOrchestration) => Promise<string>;
  onDispatch: (task: Task, orchestration: TaskSessionOrchestration, intent: TaskIntentRevision) => Promise<string>;
  onOpenChild: (binding: CodexThreadBinding | { threadId: string }) => void;
  onThreadSettled: (orchestrationId: string, openingRequestId?: string) => void;
  onError: (error: unknown) => void;
}

interface PendingDispatch {
  orchestrationId: string;
  openingRequestId?: string;
  handled: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
  timeoutId: number;
}

interface PendingParentCreation {
  orchestrationId: string;
  openingRequestId?: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  timeoutId: number;
}

const THREAD_HANDSHAKE_TIMEOUT_MS = 90_000;

function defaultIntent(task: Task): Partial<TaskIntentRevision> {
  return {
    goal: task.title,
    why: task.description || task.title,
    scope: { in: [task.identifier], out: [] },
    acceptanceCriteria: ["完成任务目标并提供实际验证证据"],
    constraints: ["只按确认后的任务意图执行，不直接写回 Jira"],
    implementationHints: [],
    openQuestions: [],
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function childBindingFromIdentity(identity: unknown, threadId: string): CodexThreadBinding | { threadId: string } {
  if (!identity || typeof identity !== "object") return { threadId };
  const value = identity as Record<string, unknown>;
  if (
    nonEmptyString(value.codexProjectId)
    && (value.codexProjectKind === "local" || value.codexProjectKind === "remote")
    && nonEmptyString(value.codexHostId)
    && nonEmptyString(value.workspacePath)
  ) {
    return {
      threadId,
      codexProjectId: value.codexProjectId,
      codexProjectKind: value.codexProjectKind,
      codexHostId: value.codexHostId,
      workspacePath: value.workspacePath,
    };
  }
  if (
    nonEmptyString(value.projectId)
    && (value.projectKind === "local" || value.projectKind === "remote")
    && nonEmptyString(value.hostId)
    && nonEmptyString(value.workspacePath)
  ) {
    return {
      threadId,
      codexProjectId: value.projectId,
      codexProjectKind: value.projectKind,
      codexHostId: value.hostId,
      workspacePath: value.workspacePath,
    };
  }
  return { threadId };
}

function projectlessIdentityMetadata(identity: unknown): Record<string, null> | undefined {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return undefined;
  const value = identity as Record<string, unknown>;
  const projectId = value.codexProjectId ?? value.projectId;
  const projectKind = value.codexProjectKind ?? value.projectKind;
  if (projectId === null && projectKind === null && value.workspacePath === null) {
    // projectless 任务只保留可判断其来源的空值标记，不传输窗口或路径身份。
    return { projectId: null, projectKind: null, workspacePath: null };
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function resultForPreview(orchestration: TaskSessionOrchestration): TaskResultRevision | null {
  return orchestration.result;
}

export function TaskSessionOrchestrationPanel({
  task,
  parentThreadBinding,
  orchestrationRevision,
  onCreateParent,
  onDispatch,
  onOpenChild,
  onThreadSettled,
  onError,
}: TaskSessionOrchestrationPanelProps) {
  const { text } = useTaskboardI18n();
  const [view, setView] = useState<TaskSessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [why, setWhy] = useState("");
  const [criteria, setCriteria] = useState("");
  const [reportSummary, setReportSummary] = useState("");
  const [reportRationale, setReportRationale] = useState("");
  const [reportRisks, setReportRisks] = useState("");
  const [reportPreview, setReportPreview] = useState<TaskResultRevision | null>(null);
  const [parentCreationPending, setParentCreationPending] = useState(false);
  const pendingParentOrchestrationId = useRef<string | null>(null);
  const pendingParentCreationRef = useRef<PendingParentCreation | null>(null);
  const orchestrationRef = useRef<TaskSessionOrchestration | null>(null);
  const pendingDispatchRef = useRef<PendingDispatch | null>(null);
  const pendingHandshakeProcessingRef = useRef(new Set<string>());
  const busyRef = useRef<string | null>(null);
  const loadedTaskIdRef = useRef<string | null>(null);

  function settleParentCreation(pending: PendingParentCreation, error?: unknown) {
    if (pendingParentCreationRef.current !== pending) return;
    window.clearTimeout(pending.timeoutId);
    pendingParentCreationRef.current = null;
    pendingParentOrchestrationId.current = null;
    onThreadSettled(pending.orchestrationId, pending.openingRequestId);
    if (error === undefined) pending.resolve();
    else pending.reject(error);
  }

  function settleDispatch(pending: PendingDispatch, error?: unknown) {
    if (pendingDispatchRef.current !== pending) return;
    window.clearTimeout(pending.timeoutId);
    pendingDispatchRef.current = null;
    onThreadSettled(pending.orchestrationId, pending.openingRequestId);
    if (error === undefined) pending.resolve();
    else pending.reject(error);
  }

  function clearBusy() {
    busyRef.current = null;
    setBusy(null);
  }

  function acknowledgeHostHandshake(
    messageType: string,
    conversationRole: PendingTaskSessionHandshake["conversationRole"],
    orchestrationId: string,
    openingRequestId?: string,
  ) {
    postEmbeddedHostMessage({
      type: "taskboard:thread-handshake-ack",
      payload: {
        taskId: task.id,
        orchestrationId,
        conversationRole,
        ...(openingRequestId ? { openingRequestId } : {}),
        messageType,
      },
    });
  }

  const orchestration = view?.orchestration ?? null;
  const intent = orchestration?.intent ?? null;
  const report = resultForPreview(orchestration ?? ({} as TaskSessionOrchestration));
  const parentThreadId = orchestration?.parentThreadBinding?.threadId ?? parentThreadBinding?.threadId;
  const hasChild = Boolean(orchestration?.childThreadBinding?.threadId);

  useEffect(() => {
    orchestrationRef.current = orchestration;
  }, [orchestration]);

  useEffect(() => {
    const pending = readPendingTaskSessionHandshakes().find((candidate) => candidate.taskId === task.id);
    if (!pending) return;
    if (pending.conversationRole === "parent") {
      pendingParentOrchestrationId.current = pending.orchestrationId;
      setParentCreationPending(true);
    }
  }, [task.id]);

  useEffect(() => {
    // 宿主可能在编排创建后才补齐当前 thread；此时无需继续显示“创建中”。
    if (parentCreationPending && parentThreadBinding?.threadId) {
      const pending = pendingParentCreationRef.current;
      if (pending) settleParentCreation(pending);
      setParentCreationPending(false);
      pendingParentOrchestrationId.current = null;
    }
  }, [parentCreationPending, parentThreadBinding?.threadId]);

  // child ID 只能采用宿主在首个 turn 后回传的握手结果，不能从导航 URL 推断。
  useEffect(() => {
    const controller = new AbortController();
    const initialLoad = loadedTaskIdRef.current !== task.id;
    if (initialLoad) setLoading(true);
    void getTaskSessionForTask(task.id, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setView(next);
        const pendingHandshake = readPendingTaskSessionHandshakes().find((candidate) => (
          candidate.taskId === task.id && candidate.orchestrationId === next.orchestration.id
        ));
        if (
          pendingHandshake
          && ((pendingHandshake.conversationRole === "parent" && next.orchestration.parentThreadBinding?.threadId)
            || (pendingHandshake.conversationRole === "child" && next.orchestration.childThreadBinding?.threadId))
        ) {
          clearPendingTaskSessionHandshake(pendingHandshake);
          if (pendingHandshake.conversationRole === "parent") {
            pendingParentOrchestrationId.current = null;
            setParentCreationPending(false);
          }
        }
        // 实时事件触发的重读只更新状态；保留用户尚未保存的意图/报告草稿。
        if (initialLoad) {
          const nextIntent = next.orchestration.intent;
          setGoal(typeof nextIntent?.goal === "string" ? nextIntent.goal : "");
          setWhy(typeof nextIntent?.why === "string" ? nextIntent.why : "");
          setCriteria(stringList(nextIntent?.acceptanceCriteria).join("\n"));
          const nextResult = next.orchestration.result;
          setReportSummary(typeof nextResult?.summary === "string" ? nextResult.summary : "");
          setReportRationale(typeof nextResult?.rationale === "string" ? nextResult.rationale : "");
          setReportRisks(stringList(nextResult?.risks).join("\n"));
          setLoading(false);
        }
        loadedTaskIdRef.current = task.id;
      },
      (error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) {
          setView(null);
          if (initialLoad) setLoading(false);
          return;
        }
        if (initialLoad) setLoading(false);
        onError(error);
      },
    );
    return () => controller.abort();
  }, [onError, orchestrationRevision, task.id]);

  useEffect(() => {
    function receiveHostMessage(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      const message = event.data as { type?: string; payload?: unknown };
      if (
        message.type !== "taskboard:parent-thread-ready"
        && message.type !== "taskboard:child-thread-ready"
        && message.type !== "taskboard:thread-create-error"
      ) return;
      if (!message.payload) return;
      const payload = message.payload as {
        taskId?: unknown;
        orchestrationId?: unknown;
        conversationRole?: unknown;
        childThreadId?: unknown;
        threadId?: unknown;
        identity?: unknown;
        error?: unknown;
        openingRequestId?: unknown;
      };
      const responseRequestId = typeof payload.openingRequestId === "string"
        ? payload.openingRequestId.trim()
        : undefined;
      if (payload.taskId !== task.id) return;

      const storedHandshakes = readPendingTaskSessionHandshakes()
        .filter((candidate) => candidate.taskId === task.id);
      const payloadOrchestrationId = typeof payload.orchestrationId === "string"
        ? payload.orchestrationId
        : undefined;
      const pendingDispatch = pendingDispatchRef.current;
      const pendingParent = pendingParentCreationRef.current;
      const parentStored = storedHandshakes.find((candidate) => (
        candidate.conversationRole === "parent"
        && (payloadOrchestrationId === undefined || candidate.orchestrationId === payloadOrchestrationId)
        && (responseRequestId === undefined || candidate.openingRequestId === responseRequestId)
      ));
      const childStored = storedHandshakes.find((candidate) => (
        candidate.conversationRole === "child"
        && (payloadOrchestrationId === undefined || candidate.orchestrationId === payloadOrchestrationId)
        && (responseRequestId === undefined || candidate.openingRequestId === responseRequestId)
      ));
      const messageRole = payload.conversationRole === "parent" || payload.conversationRole === "child"
        ? payload.conversationRole
        : message.type === "taskboard:parent-thread-ready"
          ? "parent"
          : message.type === "taskboard:child-thread-ready" ? "child" : undefined;
      const pendingForRole = messageRole === "parent"
        ? pendingParent
        : messageRole === "child" ? pendingDispatch : null;
      const storedForRole = messageRole === "parent" ? parentStored : messageRole === "child" ? childStored : null;
      const currentForPayload = payloadOrchestrationId
        && orchestrationRef.current?.id === payloadOrchestrationId
        ? orchestrationRef.current
        : null;
      const expectedOrchestrationId = pendingForRole?.orchestrationId
        ?? storedForRole?.orchestrationId
        ?? currentForPayload?.id;
      if (!messageRole && !pendingParent && !pendingDispatch && storedHandshakes.length === 0) return;
      if (payloadOrchestrationId !== undefined && payloadOrchestrationId !== expectedOrchestrationId) return;
      if (messageRole && !pendingForRole && !storedForRole && !currentForPayload) return;
      const expectedRequestId = pendingForRole?.openingRequestId
        ?? storedForRole?.openingRequestId
        ?? (currentForPayload ? responseRequestId : undefined);
      // 新版握手必须精确匹配 tab-local request ID；只有旧注入脚本的无 ID 回包走内存兼容路径。
      if (expectedRequestId && responseRequestId !== expectedRequestId) return;
      if (!expectedRequestId && responseRequestId !== undefined) return;
      const orchestrationId = expectedOrchestrationId
        ?? (typeof payload.orchestrationId === "string" ? payload.orchestrationId : null);
      if (!orchestrationId || !messageRole) return;
      // Promise 回调执行时仍沿用本次已校验的编排身份，避免后续渲染状态参与匹配。
      const confirmedOrchestrationId: string = orchestrationId;
      const processingKey = `${messageRole}:${orchestrationId}:${responseRequestId ?? "legacy"}`;
      if (pendingHandshakeProcessingRef.current.has(processingKey)) return;
      pendingHandshakeProcessingRef.current.add(processingKey);

      if (message.type === "taskboard:thread-create-error") {
        const error = new Error(typeof payload.error === "string"
          ? payload.error
          : text("无法创建 Codex 对话。", "Could not create the Codex conversation."));
        clearPendingTaskSessionHandshake({
          taskId: task.id,
          orchestrationId,
          conversationRole: messageRole,
          ...(responseRequestId ? { openingRequestId: responseRequestId } : {}),
        });
        if (messageRole === "child" && pendingDispatch?.orchestrationId === orchestrationId) {
          if (responseRequestId && !pendingDispatch.openingRequestId) pendingDispatch.openingRequestId = responseRequestId;
          settleDispatch(pendingDispatch, error);
        } else if (messageRole === "parent" && pendingParent?.orchestrationId === orchestrationId) {
          if (responseRequestId && !pendingParent.openingRequestId) pendingParent.openingRequestId = responseRequestId;
          settleParentCreation(pendingParent, error);
          setParentCreationPending(false);
          pendingParentOrchestrationId.current = null;
        } else {
          onThreadSettled(orchestrationId, responseRequestId);
        }
        if (!pendingForRole) onError(error);
        clearBusy();
        pendingHandshakeProcessingRef.current.delete(processingKey);
        acknowledgeHostHandshake(message.type, messageRole, orchestrationId, responseRequestId);
        return;
      }

      const threadId = typeof payload.childThreadId === "string"
        ? payload.childThreadId
        : typeof payload.threadId === "string" ? payload.threadId : "";
      if (!threadId) {
        const error = new Error(text(
          "Codex 握手没有返回 thread ID。",
          "The Codex handshake did not return a thread ID.",
        ));
        pendingHandshakeProcessingRef.current.delete(processingKey);
        if (pendingForRole) {
          if (messageRole === "parent" && pendingParent) settleParentCreation(pendingParent, error);
          if (messageRole === "child" && pendingDispatch) settleDispatch(pendingDispatch, error);
        } else {
          onError(error);
        }
        acknowledgeHostHandshake(message.type, messageRole, orchestrationId, responseRequestId);
        return;
      }
      const childThreadBinding = childBindingFromIdentity(payload.identity, threadId);
      if (message.type === "taskboard:parent-thread-ready") {
        // 主会话 thread 由宿主首个 turn 后确认；收到后补绑此前创建的 unbound 编排。
        if (pendingParent && responseRequestId && !pendingParent.openingRequestId) {
          pendingParent.openingRequestId = responseRequestId;
        }
        void createTaskSessionOrchestration(task.id, {
          parentThreadBinding: childThreadBinding,
        }).then((next) => {
          if (next.orchestration.id !== orchestrationId) {
            throw new Error(text("主会话握手返回了错误的编排。", "The main-session handshake returned the wrong orchestration."));
          }
          if (pendingParent?.orchestrationId === orchestrationId) settleParentCreation(pendingParent);
          else onThreadSettled(orchestrationId, responseRequestId);
          clearPendingTaskSessionHandshake({
            taskId: task.id,
            orchestrationId,
            conversationRole: "parent",
            ...(responseRequestId ? { openingRequestId: responseRequestId } : {}),
          });
          setParentCreationPending(false);
          pendingParentOrchestrationId.current = null;
          setView(next);
          const nextIntent = next.orchestration.intent;
          if (nextIntent) {
            setGoal(nextIntent.goal);
            setWhy(nextIntent.why);
            setCriteria(stringList(nextIntent.acceptanceCriteria).join("\n"));
          }
          acknowledgeHostHandshake("taskboard:parent-thread-ready", "parent", confirmedOrchestrationId, responseRequestId);
        }).catch((error) => {
          if (pendingParent?.orchestrationId === orchestrationId) settleParentCreation(pendingParent, error);
          else onThreadSettled(orchestrationId, responseRequestId);
          if (!pendingParent) onError(error);
        }).finally(() => {
          pendingHandshakeProcessingRef.current.delete(processingKey);
        });
        return;
      }
      if (message.type !== "taskboard:child-thread-ready" || (pendingDispatch?.handled ?? false)) {
        // 未知角色或已处理的回包不能影响当前编排。
        pendingHandshakeProcessingRef.current.delete(processingKey);
        return;
      }
      if (pendingDispatch) {
        pendingDispatch.handled = true;
        if (responseRequestId && !pendingDispatch.openingRequestId) pendingDispatch.openingRequestId = responseRequestId;
      }
      const identity = projectlessIdentityMetadata(payload.identity);
      const loadOrchestration = orchestrationRef.current?.id === orchestrationId
        ? Promise.resolve(orchestrationRef.current)
        : getTaskSessionOrchestration(orchestrationId).then((loaded) => loaded.orchestration);
      void loadOrchestration.then((current) => {
        if (!current || current.id !== orchestrationId) {
          throw new Error(text("任务会话握手返回了错误的编排。", "The worker-session handshake returned the wrong orchestration."));
        }
        return dispatchTaskSession(current.id, {
          intentVersion: current.intentVersion,
          parentThreadId: current.parentThreadBinding?.threadId ?? parentThreadId ?? undefined,
          childThreadId: threadId,
          childThreadBinding,
          ...(identity ? { identity } : {}),
          childWindow: payload.identity && typeof payload.identity === "object"
            ? ((payload.identity as Record<string, unknown>).window as Record<string, unknown> | undefined) ?? null
            : null,
          state: "dispatched",
        });
      }).then((next) => {
        if (pendingDispatch?.orchestrationId === orchestrationId) settleDispatch(pendingDispatch);
        else onThreadSettled(orchestrationId, responseRequestId);
        clearPendingTaskSessionHandshake({
          taskId: task.id,
          orchestrationId,
          conversationRole: "child",
          ...(responseRequestId ? { openingRequestId: responseRequestId } : {}),
        });
        setView(next);
        acknowledgeHostHandshake("taskboard:child-thread-ready", "child", confirmedOrchestrationId, responseRequestId);
      }).catch((error) => {
        if (pendingDispatch) pendingDispatch.handled = false;
        if (pendingDispatch?.orchestrationId === orchestrationId) settleDispatch(pendingDispatch, error);
        else onThreadSettled(orchestrationId, responseRequestId);
        if (!pendingDispatch) onError(error);
      }).finally(() => {
        pendingHandshakeProcessingRef.current.delete(processingKey);
      });
    }
    window.addEventListener("message", receiveHostMessage);
    return () => window.removeEventListener("message", receiveHostMessage);
  }, [onError, onThreadSettled, parentThreadId, task.id, text]);

  useEffect(() => () => {
    // 导航到新 Codex thread 会卸载 iframe；保留 tab-local handshake，待面板恢复后继续补绑。
    pendingHandshakeProcessingRef.current.clear();
  }, []);

  const intentDraft = useMemo<Partial<TaskIntentRevision>>(() => ({
    goal: goal.trim(),
    why: why.trim(),
    scope: intent?.scope ?? { in: [task.identifier], out: [] },
    acceptanceCriteria: criteria.split("\n").map((item) => item.trim()).filter(Boolean),
    constraints: intent?.constraints ?? [],
    implementationHints: intent?.implementationHints ?? [],
    openQuestions: intent?.openQuestions ?? [],
  }), [criteria, goal, intent, task.identifier, why]);

  const intentHasChanges = Boolean(intent && JSON.stringify({
    goal: intent.goal,
    why: intent.why,
    scope: intent.scope,
    acceptanceCriteria: intent.acceptanceCriteria,
    constraints: intent.constraints,
    implementationHints: intent.implementationHints,
    openQuestions: intent.openQuestions,
  }) !== JSON.stringify({
    goal: intentDraft.goal,
    why: intentDraft.why,
    scope: intentDraft.scope,
    acceptanceCriteria: intentDraft.acceptanceCriteria,
    constraints: intentDraft.constraints,
    implementationHints: intentDraft.implementationHints,
    openQuestions: intentDraft.openQuestions,
  }));

  async function runAction(name: string, action: () => Promise<void>) {
    if (busyRef.current !== null) return;
    busyRef.current = name;
    setBusy(name);
    try {
      await action();
    } catch (error) {
      onError(error);
    } finally {
      if (busyRef.current === name) clearBusy();
    }
  }

  async function startOrchestration() {
    await runAction("start", async () => {
      const created = await createTaskSessionOrchestration(task.id, {
        parentThreadBinding,
        intent: defaultIntent(task),
      });
      setView(created);
      const nextIntent = created.orchestration.intent;
      setGoal(nextIntent?.goal ?? task.title);
      setWhy(nextIntent?.why ?? task.description);
      setCriteria(stringList(nextIntent?.acceptanceCriteria).join("\n"));
      if (!created.orchestration.parentThreadBinding) {
        pendingParentOrchestrationId.current = created.orchestration.id;
        setParentCreationPending(true);
        let resolveParent!: () => void;
        let rejectParent!: (error: unknown) => void;
        const pendingParent: PendingParentCreation = {
          orchestrationId: created.orchestration.id,
          resolve: resolveParent = () => {},
          reject: rejectParent = () => {},
          timeoutId: 0,
        };
        const persisted = new Promise<void>((resolve, reject) => {
          resolveParent = resolve;
          rejectParent = reject;
        });
        pendingParent.resolve = resolveParent;
        pendingParent.reject = rejectParent;
        pendingParent.timeoutId = window.setTimeout(() => {
          if (pendingParentCreationRef.current !== pendingParent) return;
          settleParentCreation(pendingParent, new Error(text(
            "Codex 创建主会话没有响应，请稍后重试。",
            "Codex did not respond while creating the main session. Try again.",
          )));
        }, THREAD_HANDSHAKE_TIMEOUT_MS);
        pendingParentCreationRef.current = pendingParent;
        try {
          pendingParent.openingRequestId = await onCreateParent(task, created.orchestration);
          await persisted;
        } catch (error) {
          if (pendingParentCreationRef.current === pendingParent) {
            settleParentCreation(pendingParent, error);
          }
          setParentCreationPending(false);
          pendingParentOrchestrationId.current = null;
          throw error;
        }
      }
    });
  }

  async function saveIntent() {
    if (!orchestration) return;
    await runAction("intent", async () => {
      const next = await saveTaskSessionIntent(orchestration.id, {
        intent: intentDraft,
        parentThreadId: parentThreadId ?? undefined,
      });
      setView(next);
    });
  }

  async function confirmIntent() {
    if (!orchestration) return;
    await runAction("confirm", async () => {
      let current = orchestration;
      if (intentHasChanges) {
        const saved = await saveTaskSessionIntent(orchestration.id, {
          intent: intentDraft,
          parentThreadId: parentThreadId ?? undefined,
        });
        current = saved.orchestration;
        setView(saved);
      }
      const next = await confirmTaskSessionIntent(current.id, {
        intentVersion: current.intentVersion,
        captureDigest: current.intentDigest,
        parentThreadId: current.parentThreadBinding?.threadId ?? parentThreadId ?? undefined,
      });
      setView(next);
    });
  }

  async function dispatch() {
    if (!orchestration?.intent) return;
    await runAction("dispatch", async () => {
      let current = orchestration;
      if (!current.parentThreadBinding && parentThreadBinding) {
        // 未绑定记录可能早于宿主 thread identity 创建；派发前原子补绑同一 active orchestration。
        const bound = await createTaskSessionOrchestration(task.id, { parentThreadBinding });
        current = bound.orchestration;
        setView(bound);
      }
      if (!current.intent) return;
      let resolveDispatch!: () => void;
      let rejectDispatch!: (error: unknown) => void;
      const persisted = new Promise<void>((resolve, reject) => {
        resolveDispatch = resolve;
        rejectDispatch = reject;
      });
      let pendingDispatch!: PendingDispatch;
      pendingDispatch = {
        orchestrationId: current.id,
        handled: false,
        resolve: resolveDispatch,
        reject: rejectDispatch,
        timeoutId: window.setTimeout(() => {
          if (pendingDispatchRef.current !== pendingDispatch) return;
          settleDispatch(pendingDispatch, new Error(text(
            "Codex 创建任务会话没有响应，请稍后重试。",
            "Codex did not respond while creating the worker session. Try again.",
          )));
        }, THREAD_HANDSHAKE_TIMEOUT_MS),
      };
      pendingDispatchRef.current = pendingDispatch;
      try {
        pendingDispatch.openingRequestId = await onDispatch(task, current, current.intent);
        // onDispatch 只负责发起宿主请求；握手和 dispatch API 写入都完成后才能解锁。
        await persisted;
      } catch (error) {
        if (pendingDispatchRef.current === pendingDispatch) {
          settleDispatch(pendingDispatch, error);
        }
        throw error;
      }
    });
  }

  async function sendReport() {
    if (!orchestration || !reportPreview) return;
    await runAction("report", async () => {
      const sent = await reportTaskSessionResult(orchestration.id, {
        parentThreadId: parentThreadId ?? undefined,
        childThreadId: orchestration.childThreadBinding?.threadId ?? undefined,
        intentVersion: orchestration.intentVersion,
        resultRevision: reportPreview.resultRevision,
        idempotencyKey: reportPreview.idempotencyKey,
        payload: reportPreview,
      });
      const ack = await acknowledgeTaskSessionReport(orchestration.id, reportPreview.resultRevision, {
        parentThreadId,
        childThreadId: orchestration.childThreadBinding?.threadId ?? undefined,
      });
      setView({
        orchestration: ack.orchestration,
        intent: ack.orchestration.intent,
        intentRevisions: ack.orchestration.intentRevisions,
        result: ack.orchestration.result,
        results: ack.orchestration.resultRevisions,
        messages: [],
        timeline: [],
      });
      setReportPreview(null);
      void sent;
    });
  }

  function makeReportPreview() {
    if (!orchestration || !reportSummary.trim() || !reportRationale.trim()) return;
    const revision = orchestration.currentResultRevision + 1;
    setReportPreview({
      version: "task-result.v1",
      outcome: "completed",
      summary: reportSummary.trim(),
      rationale: reportRationale.trim(),
      changedFiles: [],
      verification: [],
      ...(reportRisks.trim() ? { risks: reportRisks.split("\n").map((item) => item.trim()).filter(Boolean) } : {}),
      intentVersion: orchestration.intentVersion,
      resultRevision: revision,
      idempotencyKey: `${orchestration.id}:${revision}`,
      createdAt: new Date().toISOString(),
    });
  }

  async function review(decision: "approved" | "needs_rework" | "blocked") {
    if (!orchestration) return;
    await runAction(`review-${decision}`, async () => {
      const next = await reviewTaskSession(orchestration.id, {
        decision,
        resultRevision: orchestration.currentResultRevision,
        parentThreadId,
        feedback: decision === "needs_rework" ? text("请根据检查意见继续修正。", "Please continue with the review feedback.") : undefined,
      });
      setView((current) => current ? { ...current, orchestration: next.orchestration } : current);
    });
  }

  async function integrate() {
    if (!orchestration) return;
    await runAction("integrate", async () => {
      const next = await integrateTaskSession(orchestration.id, { mode: "merge", parentThreadId });
      setView((current) => current ? { ...current, orchestration: next.orchestration } : current);
    });
  }

  async function writeback() {
    if (!orchestration) return;
    await runAction("writeback", async () => {
      const next = await saveTaskSessionWriteback(orchestration.id, {
        comment: orchestration.result?.summary ?? null,
        confirmed: true,
        parentThreadId,
      });
      setView((current) => current ? { ...current, orchestration: next.orchestration } : current);
    });
  }

  async function complete() {
    if (!orchestration) return;
    await runAction("complete", async () => {
      const next = await completeTaskSession(orchestration.id, { confirmed: true, parentThreadId });
      setView((current) => current ? { ...current, orchestration: next.orchestration } : current);
    });
  }

  if (loading) {
    return <section className="task-session-panel" aria-busy="true"><span className="task-session-muted">{text("正在读取编排…", "Loading orchestration…")}</span></section>;
  }

  if (!orchestration) {
    return (
      <section className="task-session-panel" aria-labelledby="task-session-heading">
        <div className="task-session-panel-heading"><h2 id="task-session-heading">{text("任务会话", "Task session")}</h2></div>
        <button type="button" className="button primary task-session-action" disabled={busy !== null} onClick={() => void startOrchestration()}>
          {busy === "start" ? text("正在准备…", "Preparing…") : text("发起任务会话", "Start task session")}
        </button>
      </section>
    );
  }

  return (
    <section className="task-session-panel" aria-labelledby="task-session-heading">
      <div className="task-session-panel-heading">
        <h2 id="task-session-heading">{text("任务编排", "Task orchestration")}</h2>
        <span className={`task-session-state is-${orchestration.state}`}>{orchestration.state}</span>
      </div>

      <div className="task-session-section">
        <div className="task-session-section-heading"><strong>{text("主会话", "Main session")}</strong><span>{parentThreadId ? text("已绑定", "Bound") : parentCreationPending ? text("创建中", "Creating") : text("未绑定", "Unbound")}</span></div>
        {!parentThreadId && <span className="task-session-muted">{parentCreationPending
          ? text("正在等待宿主确认主会话 thread。", "Waiting for the host to confirm the main session thread.")
          : text("当前页面没有可识别的主会话。", "No main session is available on this page.")}</span>}
      </div>

      <div className="task-session-section">
        <div className="task-session-section-heading"><strong>{text("任务意图", "Task intent")}</strong><span>v{orchestration.intentVersion}</span></div>
        <label className="task-session-field"><span>{text("目标", "Goal")}</span><input value={goal} onChange={(event) => setGoal(event.target.value)} disabled={busy !== null} /></label>
        <label className="task-session-field"><span>{text("原因", "Why")}</span><textarea value={why} onChange={(event) => setWhy(event.target.value)} disabled={busy !== null} rows={2} /></label>
        <label className="task-session-field"><span>{text("验收标准", "Acceptance criteria")}</span><textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} disabled={busy !== null} rows={3} /></label>
        <div className="task-session-actions">
          <button type="button" className="button secondary" onClick={() => void saveIntent()} disabled={busy !== null || !goal.trim()}>{text("保存意图", "Save intent")}</button>
          <button type="button" className="button primary" onClick={() => void confirmIntent()} disabled={busy !== null || orchestration.state !== "intent_draft"}>{text("确认意图", "Confirm intent")}</button>
        </div>
      </div>

      <div className="task-session-section">
        <div className="task-session-section-heading"><strong>{text("任务会话", "Worker session")}</strong><span>{hasChild ? text("已创建", "Created") : text("待派发", "Not dispatched")}</span></div>
        {hasChild && orchestration.childThreadBinding && (
          <button type="button" className="button secondary task-session-action" onClick={() => onOpenChild(orchestration.childThreadBinding!)}>{text("打开任务窗口", "Open task window")}</button>
        )}
        {!hasChild && (
          <button type="button" className="button primary task-session-action" onClick={() => void dispatch()} disabled={busy !== null || orchestration.state !== "intent_ready" || intentHasChanges}>
            {busy === "dispatch" ? text("正在派发…", "Dispatching…") : text("派发到任务会话", "Dispatch to task session")}
          </button>
        )}
      </div>

      {(orchestration.state === "dispatched" || orchestration.state === "executing" || orchestration.state === "waiting_for_user") && (
        <div className="task-session-section"><span className="task-session-muted">{text("任务会话可继续多轮执行；完成后生成结果报告。", "The worker can continue multiple turns; generate a result report when ready.")}</span></div>
      )}

      {(orchestration.state === "dispatched" || orchestration.state === "executing" || orchestration.state === "waiting_for_user" || orchestration.state === "result_ready" || orchestration.state === "reviewing" || orchestration.state === "reporting") && (
        <div className="task-session-section">
          <div className="task-session-section-heading"><strong>{text("结果报告", "Result report")}</strong><span>{orchestration.currentResultRevision > 0 ? `r${orchestration.currentResultRevision}` : text("草稿", "Draft")}</span></div>
          <label className="task-session-field"><span>{text("做了什么", "What changed")}</span><textarea value={reportSummary} onChange={(event) => setReportSummary(event.target.value)} rows={2} disabled={busy !== null} /></label>
          <label className="task-session-field"><span>{text("为什么这样做", "Why")}</span><textarea value={reportRationale} onChange={(event) => setReportRationale(event.target.value)} rows={2} disabled={busy !== null} /></label>
          <label className="task-session-field"><span>{text("风险（可选）", "Risks (optional)")}</span><textarea value={reportRisks} onChange={(event) => setReportRisks(event.target.value)} rows={2} disabled={busy !== null} /></label>
          {!reportPreview ? (
            <button type="button" className="button secondary" onClick={makeReportPreview} disabled={!reportSummary.trim() || !reportRationale.trim()}>{text("生成报告预览", "Preview report")}</button>
          ) : (
            <div className="task-session-report-preview">
              <strong>{reportPreview.summary}</strong>
              <p>{reportPreview.rationale}</p>
              {reportPreview.risks && reportPreview.risks.length > 0 && <p className="task-session-risk">{reportPreview.risks.join(" · ")}</p>}
              <button type="button" className="button primary" onClick={() => void sendReport()} disabled={busy !== null}>{text("确认发送给主会话", "Send to main session")}</button>
            </div>
          )}
        </div>
      )}

      {(orchestration.state === "result_ready" || orchestration.state === "reviewing") && report && (
        <div className="task-session-section">
          <div className="task-session-section-heading"><strong>{text("结果检查", "Result review")}</strong><span>{orchestration.review?.decision ?? (orchestration.state === "reviewing" ? text("检查中", "Reviewing") : text("待检查", "Pending"))}</span></div>
          <p className="task-session-result-summary">{report.summary}</p>
          <div className="task-session-actions">
            <button type="button" className="button primary" onClick={() => void review("approved")} disabled={busy !== null}>{text("通过检查", "Approve")}</button>
            <button type="button" className="button secondary" onClick={() => void review("needs_rework")} disabled={busy !== null}>{text("要求返工", "Request rework")}</button>
            <button type="button" className="button danger" onClick={() => void review("blocked")} disabled={busy !== null}>{text("标记阻塞", "Block")}</button>
          </div>
        </div>
      )}

      {(orchestration.state === "writeback_pending"
        || orchestration.state === "integrated"
        || orchestration.state === "synced") && (
        <div className="task-session-section">
          <div className="task-session-section-heading"><strong>{text("集成与 Jira", "Integration and Jira")}</strong><span>{orchestration.integration ? text("已集成", "Integrated") : text("待确认", "Pending")}</span></div>
          {!orchestration.integration && <button type="button" className="button secondary task-session-action" onClick={() => void integrate()} disabled={busy !== null}>{text("记录合并集成", "Record merge integration")}</button>}
          {!orchestration.writeback && <button type="button" className="button secondary task-session-action" onClick={() => void writeback()} disabled={busy !== null}>{text("保存 Jira 写回预览", "Save Jira writeback preview")}</button>}
          {orchestration.writeback && <span className="task-session-muted">{text("Jira 写回预览已保存。", "Jira writeback preview saved.")}</span>}
        </div>
      )}

      {(orchestration.state === "integrated" || orchestration.state === "synced") && (
        <div className="task-session-section"><button type="button" className="button primary task-session-action" onClick={() => void complete()} disabled={busy !== null}>{text("确认完成", "Confirm complete")}</button></div>
      )}
    </section>
  );
}
