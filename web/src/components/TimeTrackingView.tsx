import { useEffect, useMemo, useState } from "react";
import { ApiError, getDailyTaskTime } from "../api";
import { taskStatusLabel, useTaskboardI18n } from "../i18n";
import { formatTaskDuration, localDateKey } from "../timeTracking";
import type { DailyTaskTimeItem, DailyTaskTimeSummary } from "../types";
import "./TimeTrackingView.css";

interface TimeTrackingViewProps {
  projectId?: string;
  refreshToken: string;
}

function shiftDate(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  return localDateKey(new Date(year, month - 1, day + days));
}

function medianDuration(values: number[]) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  // 偶数个任务取中间两项的均值，保持中位数在不同任务量下的常见统计口径。
  return ordered.length % 2 === 0
    ? Math.floor((ordered[middle - 1] + ordered[middle]) / 2)
    : ordered[middle];
}

function displayDuration(seconds: number) {
  return seconds > 0 ? formatTaskDuration(seconds) : "0m";
}

export function TimeTrackingView({ projectId, refreshToken }: TimeTrackingViewProps) {
  const { language, locale, text } = useTaskboardI18n();
  const [date, setDate] = useState(() => localDateKey());
  const [summary, setSummary] = useState<DailyTaskTimeSummary | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void getDailyTaskTime(date, projectId, controller.signal)
      .then(setSummary)
      .catch((failure) => {
        if (failure instanceof Error && failure.name === "AbortError") return;
        setError(failure instanceof ApiError
          ? failure.message
          : text("无法读取任务处理耗时。", "Unable to load task processing time."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [date, projectId, refreshToken, text]);

  useEffect(() => setSelectedProjectId(null), [date, projectId]);

  const hasActiveTask = summary?.projects.some((project) => (
    project.tasks.some((task) => task.active)
  )) ?? false;
  useEffect(() => {
    setNow(Date.now());
    if (!hasActiveTask || date !== localDateKey()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [date, hasActiveTask]);

  const elapsedSinceSnapshot = summary && date === localDateKey(now)
    ? Math.max(0, Math.floor((now - new Date(summary.asOf).getTime()) / 1000))
    : 0;
  const taskSeconds = (task: DailyTaskTimeItem) => (
    task.totalSeconds + (task.active ? elapsedSinceSnapshot : 0)
  );
  const projects = useMemo(() => summary?.projects.map((project) => ({
    ...project,
    liveTotalSeconds: project.tasks.reduce((total, task) => total + taskSeconds(task), 0),
  })) ?? [], [elapsedSinceSnapshot, summary]);
  const liveTotalSeconds = projects.reduce((total, project) => total + project.liveTotalSeconds, 0);
  const taskRows = projects.flatMap((project) => project.tasks.map((task) => ({
    projectId: project.projectId,
    projectName: project.projectName,
    task,
    seconds: taskSeconds(task),
  }))).sort((left, right) => (
    right.seconds - left.seconds
    || left.task.identifier.localeCompare(right.task.identifier)
  ));
  const selectedProject = projects.find((project) => project.projectId === selectedProjectId) ?? null;
  const visibleTaskRows = selectedProject
    ? taskRows.filter((row) => row.projectId === selectedProject.projectId)
    : taskRows;
  const medianSeconds = medianDuration(taskRows.map((row) => row.seconds));
  const maxProjectSeconds = Math.max(...projects.map((project) => project.liveTotalSeconds), 1);
  const runningTaskCount = taskRows.filter((row) => row.task.active).length;
  const pausedTaskCount = taskRows.filter((row) => (
    row.task.paused && row.task.status === "in_progress" && !row.task.archivedAt
  )).length;
  const isToday = date === localDateKey(now);
  const selectedDateLabel = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${date}T12:00:00`));

  return (
    <section className="time-tracking-view">
      <div className="time-tracking-content">
        <header className="time-tracking-header">
          <div className="time-tracking-heading">
            <h1>{text("任务处理耗时", "Task processing time")}</h1>
            <p>{text("项目分布与当天任务明细", "Project distribution and daily task details")}</p>
            {isToday && (
              <div className="time-tracking-live-status">
                <span><i />{runningTaskCount} {text("个任务计时中", "tasks running")}</span>
                <span>{pausedTaskCount} {text("个任务已暂停", "tasks paused")}</span>
              </div>
            )}
          </div>
          <div className="time-tracking-date-controls">
            <button
              type="button"
              aria-label={text("前一天", "Previous day")}
              onClick={() => setDate((current) => shiftDate(current, -1))}
            >‹</button>
            {!isToday && (
              <button type="button" onClick={() => setDate(localDateKey())}>
                {text("今天", "Today")}
              </button>
            )}
            <label>
              <span>{selectedDateLabel}{isToday ? text(" · 今天", " · Today") : ""}</span>
              <input
                type="date"
                aria-label={text("选择日期", "Choose date")}
                value={date}
                onChange={(event) => setDate(event.target.value || localDateKey())}
              />
            </label>
            <button
              type="button"
              aria-label={text("后一天", "Next day")}
              onClick={() => setDate((current) => shiftDate(current, 1))}
            >›</button>
          </div>
        </header>

        <section className="time-tracking-kpis" aria-label={text("当日关键指标", "Daily key metrics")}>
          <article>
            <span>{text("当日累计处理", "Daily cumulative time")}</span>
            <strong>{summary ? displayDuration(liveTotalSeconds) : "—"}</strong>
            <small>{text("按任务累计，包含并行处理", "Cumulative by task, including parallel work")}</small>
          </article>
          <article>
            <span>{text("有耗时任务", "Tasks with time")}</span>
            <strong>{summary ? taskRows.length : "—"}</strong>
            <small>{text("去重任务数，含已完成与已归档", "Distinct tasks, including completed and archived")}</small>
          </article>
          <article>
            <span>{text("任务耗时中位数", "Median task time")}</span>
            <strong>{medianSeconds === null ? "—" : displayDuration(medianSeconds)}</strong>
            <small>{text("比平均值更不易受超长任务影响", "Less affected by unusually long tasks")}</small>
          </article>
          <article>
            <span>{text("今日结束处理", "Tasks ended today")}</span>
            <strong>{summary ? summary.endedTaskCount : "—"}</strong>
            <small>{text("离开处理中且非本地暂停", "Left in progress, excluding local pauses")}</small>
          </article>
        </section>

        {error && <div className="time-tracking-message is-error">{error}</div>}
        {loading && !summary ? (
          <div className="time-tracking-message">{text("正在读取耗时…", "Loading processing time…")}</div>
        ) : (
          <div className="time-tracking-dashboard">
            <section className="time-tracking-panel time-tracking-project-panel">
              <header>
                <div>
                  <h2>{text("项目耗时分布", "Project time distribution")}</h2>
                  <p>{projects.length} {text("个有耗时项目 · 按处理耗时排序", "projects with time · sorted by duration")}</p>
                </div>
                {selectedProject && (
                  <button type="button" onClick={() => setSelectedProjectId(null)}>
                    {text("查看全部", "View all")}
                  </button>
                )}
              </header>
              {projects.length === 0 ? (
                <div className="time-tracking-panel-empty">
                  {text("这一天还没有任务处理记录。", "No task processing time was recorded on this day.")}
                </div>
              ) : (
                <div className="time-tracking-project-bars">
                  {projects.map((project) => {
                    const share = liveTotalSeconds > 0
                      ? Math.round((project.liveTotalSeconds / liveTotalSeconds) * 100)
                      : 0;
                    const barWidth = Math.max(2, Math.round(
                      (project.liveTotalSeconds / maxProjectSeconds) * 100,
                    ));
                    return (
                      <button
                        className="time-tracking-project-row"
                        type="button"
                        key={project.projectId}
                        aria-pressed={selectedProject?.projectId === project.projectId}
                        onClick={() => setSelectedProjectId((current) => (
                          current === project.projectId ? null : project.projectId
                        ))}
                      >
                        <span className="time-tracking-project-name">
                          <strong>{project.projectName}</strong>
                          <small>{project.tasks.length} {text("个任务", "tasks")}</small>
                        </span>
                        <span className="time-tracking-project-track">
                          <i style={{ width: `${barWidth}%` }} />
                        </span>
                        <span className="time-tracking-project-value">
                          <strong>{displayDuration(project.liveTotalSeconds)}</strong>
                          <small>{share}%</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <footer>{text(
                "占比基于当天累计任务处理耗时；并行任务分别累计。",
                "Shares use cumulative daily task time; parallel tasks are counted separately.",
              )}</footer>
            </section>

            <section className="time-tracking-panel time-tracking-task-panel">
              <header>
                <div>
                  <h2>{text("当天任务耗时明细", "Daily task time details")}</h2>
                  <p>
                    {selectedProject?.projectName ?? text("全部项目", "All projects")}
                    {text(" · 按耗时从高到低", " · sorted by duration")}
                  </p>
                </div>
              </header>
              {visibleTaskRows.length === 0 ? (
                <div className="time-tracking-panel-empty">
                  {text("这一天还没有任务处理记录。", "No task processing time was recorded on this day.")}
                </div>
              ) : (
                <div className="time-tracking-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{text("任务", "Task")}</th>
                        <th>{text("项目", "Project")}</th>
                        <th>{text("当前状态", "Current status")}</th>
                        <th>{text("今日处理", "Time today")}</th>
                        <th>{text("计时", "Timer")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTaskRows.map(({ projectName, task, seconds }) => {
                        const isPaused = task.paused && task.status === "in_progress" && !task.archivedAt;
                        const timerLabel = task.active
                          ? text("计时中", "Running")
                          : isPaused
                            ? text("已暂停", "Paused")
                            : text("已停止", "Stopped");
                        return (
                          <tr key={task.taskId}>
                            <td className="time-tracking-task-cell">
                              <small>{task.identifier}</small>
                              <strong>{task.title}</strong>
                            </td>
                            <td><span className="time-tracking-tag">{projectName}</span></td>
                            <td><span className="time-tracking-tag">
                              {task.archivedAt
                                ? text("已归档", "Archived")
                                : taskStatusLabel(language, task.status)}
                            </span></td>
                            <td className="time-tracking-duration-cell">{displayDuration(seconds)}</td>
                            <td><span className={`time-tracking-timer is-${task.active ? "running" : isPaused ? "paused" : "stopped"}`}>
                              {timerLabel}
                            </span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </section>
  );
}
