import type { TaskTimeTracking } from "./types";

export function localDateKey(value: Date | number = new Date()) {
  const date = typeof value === "number" ? new Date(value) : value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function taskTodaySeconds(tracking: TaskTimeTracking | undefined, now: number) {
  if (!tracking) return 0;
  const today = localDateKey(now);
  const closedSeconds = tracking.date === today ? tracking.closedSeconds : 0;
  if (!tracking.activeStartedAt) return closedSeconds;
  const current = new Date(now);
  const dayStart = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const activeStart = Math.max(new Date(tracking.activeStartedAt).getTime(), dayStart);
  return closedSeconds + Math.max(0, Math.floor((now - activeStart) / 1000));
}

export function formatTaskDuration(seconds: number) {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  if (wholeSeconds < 60) return "<1m";
  const minutes = Math.floor(wholeSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}
