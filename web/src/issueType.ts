export function issueTypeClassName(issueType: string | null | undefined): string {
  const normalized = String(issueType ?? "").trim().toLowerCase();
  if (normalized.includes("bug") || normalized.includes("故障") || normalized.includes("缺陷")) return "issue-type-bug";
  if (normalized.includes("story") || normalized.includes("故事")) return "issue-type-story";
  if (normalized.includes("task") || normalized.includes("任务")) return "issue-type-task";
  if (normalized.includes("epic") || normalized.includes("史诗")) return "issue-type-epic";
  if (normalized.includes("feature") || normalized.includes("功能")) return "issue-type-feature";
  if (normalized.includes("improvement") || normalized.includes("改进")) return "issue-type-improvement";
  return "issue-type-default";
}
