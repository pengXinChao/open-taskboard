const CODEX_THREAD_NAME_MAX = 240;

function collapseText(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function optimizeJiraThreadTitle(title: string, externalKey: string) {
  let text = collapseText(title);
  if (!text) return "";
  // 会话名已带 [KEY]，去掉标题里重复的编号，保留【缺陷】等类型标签。
  if (externalKey) {
    const key = escapeRegExp(externalKey);
    text = text
      .replace(new RegExp(`^\\[?${key}\\]?\\s*[:：\\-–—]?\\s*`, "i"), "")
      .replace(new RegExp(`\\s*[\\[\\(]?${key}[\\]\\)]?\\s*$`, "i"), "")
      .trim();
  }
  return text.replace(/^["“「『]+|["”」』]+$/g, "").trim();
}

export function codexThreadNameForTask(task: {
  source?: string | null;
  title: string;
  externalKey?: string | null;
}) {
  if (task.source !== "jira") return collapseText(task.title) || task.title;
  const key = String(task.externalKey ?? "").trim() || "JIRA";
  const cleaned = optimizeJiraThreadTitle(task.title, key) || collapseText(task.title) || key;
  const prefix = `[${key}]`;
  const budget = CODEX_THREAD_NAME_MAX - prefix.length;
  if (budget <= 0) return prefix.slice(0, CODEX_THREAD_NAME_MAX);
  if (cleaned.length <= budget) return `${prefix}${cleaned}`;
  if (budget === 1) return `${prefix}${cleaned.slice(0, 1)}`;
  return `${prefix}${cleaned.slice(0, budget - 1)}…`;
}
