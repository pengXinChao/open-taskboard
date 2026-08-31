import { useEffect, useMemo, useState } from "react";
import { ApiError, getTaskSessionForTask, type TaskSessionView } from "../api";
import { useTaskboardI18n } from "../i18n";
import type { CodexThreadBinding, OrchestrationState, Task } from "../types";
import { ConversationIcon } from "./SemanticIcons";
import { LinearIcon } from "./LinearIcon";

type ThreadBinding = CodexThreadBinding | { threadId: string };

interface TaskSessionOrchestrationPanelProps {
  task: Task;
  orchestrationRevision: number;
  onOpenThread: (binding: ThreadBinding) => void;
  onError: (error: unknown) => void;
}

type SessionTone = "active" | "waiting" | "blocked" | "done" | "muted";
interface SessionStatus { label: string; tone: SessionTone; }

function parentStatus(state: OrchestrationState | null, text: (chinese: string, english: string) => string): SessionStatus {
  if (state === "blocked") return { label: text("阻塞", "Blocked"), tone: "blocked" };
  if (state === "done" || state === "synced" || state === "integrated") return { label: text("已完成", "Completed"), tone: "done" };
  if (!state) return { label: text("未创建", "Not created"), tone: "muted" };
  if (state === "dispatched" || state === "executing" || state === "waiting_for_user" || state === "reporting" || state === "result_ready" || state === "reviewing" || state === "writeback_pending") {
    return { label: text("检查中", "Supervising"), tone: state === "waiting_for_user" ? "waiting" : "active" };
  }
  return { label: text("分析中", "Analyzing"), tone: "active" };
}

function childStatus(state: OrchestrationState | null, text: (chinese: string, english: string) => string): SessionStatus {
  if (!state) return { label: text("未创建", "Not created"), tone: "muted" };
  if (state === "blocked") return { label: text("阻塞", "Blocked"), tone: "blocked" };
  if (state === "waiting_for_user") return { label: text("等待用户", "Waiting for user"), tone: "waiting" };
  if (state === "reporting" || state === "result_ready" || state === "reviewing") return { label: text("待检查", "Ready for review"), tone: "waiting" };
  if (state === "done" || state === "synced" || state === "integrated") return { label: text("已完成", "Completed"), tone: "done" };
  return { label: text("执行中", "Executing"), tone: "active" };
}

function overallStatus(state: OrchestrationState | null, hasParent: boolean, text: (chinese: string, english: string) => string): SessionStatus {
  if (!hasParent && !state) return { label: text("未创建", "Not created"), tone: "muted" };
  if (state === "blocked") return { label: text("阻塞", "Blocked"), tone: "blocked" };
  if (state === "waiting_for_user") return { label: text("等待用户", "Waiting for user"), tone: "waiting" };
  if (state === "reporting" || state === "result_ready" || state === "reviewing") return { label: text("待检查", "Ready for review"), tone: "waiting" };
  if (state === "done" || state === "synced" || state === "integrated") return { label: text("已完成", "Completed"), tone: "done" };
  return { label: text("执行中", "In progress"), tone: "active" };
}

function contextForBinding(binding: ThreadBinding | null, fallback: string, text: (chinese: string, english: string) => string): string {
  if (!binding || !("codexProjectKind" in binding)) return fallback;
  const project = binding.codexProjectId || text("未选择项目", "No project selected");
  const workspace = binding.workspacePath || text("未映射目录", "Workspace not mapped");
  return `${project} · ${workspace}`;
}

function relativeSyncTime(value: string | null, text: (chinese: string, english: string) => string): string {
  if (!value) return text("尚未同步", "Not synced yet");
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return text("刚刚同步", "Synced just now");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return text(`${minutes} 分钟前同步`, `Synced ${minutes}m ago`);
  return text(`${Math.round(minutes / 60)} 小时前同步`, `Synced ${Math.round(minutes / 60)}h ago`);
}

function SessionRow({ label, status, context, binding, onOpen, enterLabel }: {
  label: string;
  status: SessionStatus;
  context: string;
  binding: ThreadBinding | null;
  onOpen: (binding: ThreadBinding) => void;
  enterLabel: string;
}) {
  const content = (
    <>
      <span className="task-session-row-icon" aria-hidden="true"><ConversationIcon size={15} /></span>
      <span className="task-session-row-copy">
        <span className="task-session-row-title">
          <strong>{label}</strong>
          <span className={`task-session-row-status is-${status.tone}`}><span className="task-session-status-dot" aria-hidden="true" />{status.label}</span>
        </span>
        <span className="task-session-row-context"><LinearIcon name="folder" /><span>{context}</span></span>
      </span>
      {binding && <span className="task-session-row-enter">{enterLabel}<LinearIcon name="chevronRight" /></span>}
    </>
  );
  if (!binding) return <div className="task-session-row is-disabled">{content}</div>;
  return <button type="button" className="task-session-row" title={enterLabel} onClick={() => onOpen(binding)}>{content}</button>;
}

export function TaskSessionOrchestrationPanel({ task, orchestrationRevision, onOpenThread, onError }: TaskSessionOrchestrationPanelProps) {
  const { text } = useTaskboardI18n();
  const [view, setView] = useState<TaskSessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const parentFallback = task.threadBinding;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void getTaskSessionForTask(task.id, controller.signal).then(
      (next) => { if (!controller.signal.aborted) { setView(next); setLoading(false); } },
      (error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) { setView(null); setLoading(false); return; }
        setLoading(false);
        onError(error);
      },
    );
    return () => controller.abort();
  }, [onError, orchestrationRevision, task.id]);

  const orchestration = view?.orchestration ?? null;
  const parentBinding = orchestration?.parentThreadBinding ?? parentFallback;
  const childBinding = orchestration?.childThreadBinding ?? null;
  const parent = useMemo(() => parentStatus(orchestration?.state ?? null, text), [orchestration?.state, text]);
  const child = useMemo(() => childStatus(orchestration?.state ?? null, text), [orchestration?.state, text]);
  const overall = useMemo(() => overallStatus(orchestration?.state ?? null, Boolean(parentBinding), text), [orchestration?.state, parentBinding, text]);
  const parentContext = contextForBinding(parentBinding, text("无项目 · Codex 原生会话", "No project · Native Codex session"), text);
  const childContext = contextForBinding(childBinding, text("未创建 · 等待主会话创建", "Not created · Waiting for the main session"), text);
  const sessionCount = (parentBinding ? 1 : 0) + (childBinding ? 1 : 0);

  return (
    <section className="task-session-panel" aria-labelledby="task-session-heading">
      <div className="task-session-panel-heading"><h2 id="task-session-heading">{text("会话编排", "Session orchestration")}</h2><span className={`task-session-overall-status is-${overall.tone}`}><span className="task-session-status-dot" aria-hidden="true" />{overall.label}</span></div>
      {loading ? <div className="task-session-loading" aria-busy="true">{text("正在读取…", "Loading…")}</div> : (
        <div className="task-session-list">
          <SessionRow label={text("主会话", "Main session")} status={parent} context={parentContext} binding={parentBinding} onOpen={onOpenThread} enterLabel={text("进入", "Enter")} />
          <SessionRow label={text("任务会话", "Worker session")} status={child} context={childContext} binding={childBinding} onOpen={onOpenThread} enterLabel={text("进入", "Enter")} />
        </div>
      )}
      <div className="task-session-footer"><span><LinearIcon name="check" />{relativeSyncTime(orchestration?.updatedAt ?? null, text)}</span><span>{text(`${sessionCount} 个会话`, `${sessionCount} session${sessionCount === 1 ? "" : "s"}`)}</span></div>
    </section>
  );
}
