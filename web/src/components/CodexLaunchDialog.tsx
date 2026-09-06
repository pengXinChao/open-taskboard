import { useEffect, useState } from "react";
import { useTaskboardI18n } from "../i18n";
import type { DevelopmentContext, Task } from "../types";
import type { CodexWorkspaceOption } from "./TaskDetail";

interface CodexLaunchDialogProps {
  task: Task | null;
  workspaceOptions: CodexWorkspaceOption[];
  developmentOptions: DevelopmentContext[];
  developmentScanLoading: boolean;
  opening: boolean;
  onClose: () => void;
  onStart: (task: Task, context: DevelopmentContext) => void;
}

export function CodexLaunchDialog({
  task,
  workspaceOptions,
  developmentOptions,
  developmentScanLoading,
  opening,
  onClose,
  onStart,
}: CodexLaunchDialogProps) {
  const { text } = useTaskboardI18n();
  const [selectedPath, setSelectedPath] = useState("");
  useEffect(() => {
    setSelectedPath(task?.developmentContext?.type === "worktree" ? task.developmentContext.path : "");
  }, [task]);
  if (!task) return null;
  const selected = workspaceOptions.find((option) => option.workspacePath === selectedPath);
  const context = selected
    ? developmentOptions.find((option) => option.type === "worktree" && option.path === selected.workspacePath)
      ?? { type: "worktree" as const, path: selected.workspacePath, branch: null }
    : null;
  // 分支信息只在扫描结果明确表明工作空间属于 Git 上下文时展示，普通目录保持简洁。
  const currentBranch = context?.type === "worktree" && context.branch
    ? context.branch
    : context?.type === "branch"
      ? context.branch
      : null;
  const descriptionPreview = task.description
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*`_~-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (
    <dialog className="codex-launch-dialog" open aria-labelledby="codex-launch-dialog-title">
      <div className="codex-launch-card">
        <header className="codex-launch-header">
          <div>
            <span className="codex-launch-kicker">{text("开始处理任务", "Start working")}</span>
            <h2 id="codex-launch-dialog-title" title={task.title}>{task.title}</h2>
            <div className="codex-launch-meta">
              <span>{task.externalKey ?? task.identifier}</span>
              {task.issueType && <span className="codex-launch-type">{task.issueType}</span>}
              {task.externalUrl && (
                <a
                  className="codex-launch-jira-link"
                  href={task.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {text("查看 Jira", "View Jira")} ↗
                </a>
              )}
            </div>
          </div>
          <button className="icon-button dialog-close" type="button" aria-label={text("关闭", "Close")} onClick={onClose}>×</button>
        </header>
        <div className="codex-launch-body">
          {descriptionPreview && (
            <section className="codex-launch-description" aria-label={text("Jira 内容", "Jira content")}>
              <div className="codex-launch-section-label">{text("Jira 内容", "Jira content")}</div>
              <p>{descriptionPreview}</p>
            </section>
          )}
          <label className="codex-launch-field">
            <span>{text("工作空间", "Workspace")}</span>
            <select value={selectedPath} onChange={(event) => setSelectedPath(event.target.value)}>
              <option value="">{developmentScanLoading && workspaceOptions.length === 0 ? text("正在扫描…", "Scanning…") : text("请选择工作空间", "Choose a workspace")}</option>
              {workspaceOptions.map((option) => (
                <option key={option.id} value={option.workspacePath}>{option.name}</option>
              ))}
            </select>
          </label>
          {currentBranch && (
            <p className="codex-launch-hint">{text(`当前分支：${currentBranch}`, `Current branch: ${currentBranch}`)}</p>
          )}
        </div>
        <footer className="codex-launch-footer">
          <button className="button" type="button" onClick={onClose}>{text("取消", "Cancel")}</button>
          <button className="button primary" type="button" disabled={!context || opening} onClick={() => context && onStart(task, context)}>{opening ? text("正在打开…", "Opening…") : text("在新会话中开始", "Start new conversation")}</button>
        </footer>
      </div>
    </dialog>
  );
}
