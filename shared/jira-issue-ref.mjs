const JIRA_ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]+-\d+$/;
const JIRA_BROWSE_KEY_PATTERN = /\/browse\/([A-Za-z][A-Za-z0-9]+-\d+)(?:[/?#]|$)/i;

function trimmedRef(value) {
  return typeof value === "string" ? value.trim() : "";
}

function decodedRef(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function jiraIssueKeyFromBrowseUrl(value) {
  const trimmed = trimmedRef(value);
  if (!trimmed) return null;
  const match = decodedRef(trimmed).match(JIRA_BROWSE_KEY_PATTERN)
    ?? trimmed.match(JIRA_BROWSE_KEY_PATTERN);
  return match ? match[1].toUpperCase() : null;
}

export function jiraIssueKeyFromRef(value) {
  const trimmed = trimmedRef(value);
  if (!trimmed) return null;
  if (JIRA_ISSUE_KEY_PATTERN.test(trimmed)) return trimmed.toUpperCase();
  return jiraIssueKeyFromBrowseUrl(trimmed);
}

// taskctl 只把 browse URL 收成 Key，避免长地址撞上 /api/tasks/:id 的路径长度限制。
export function canonicalTaskRef(value) {
  const trimmed = trimmedRef(value);
  return jiraIssueKeyFromBrowseUrl(trimmed) ?? trimmed;
}
