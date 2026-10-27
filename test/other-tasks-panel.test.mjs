import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const statusSource = await readFile(new URL("../web/src/issueBoardStatuses.ts", import.meta.url), "utf8");
const boardColumnSource = await readFile(new URL("../web/src/components/BoardColumn.tsx", import.meta.url), "utf8");
const displayMenuSource = await readFile(new URL("../web/src/components/BoardCardDisplayMenu.tsx", import.meta.url), "utf8");
const panelSource = await readFile(new URL("../web/src/components/OtherTasksPanel.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

function statusList(name) {
  const match = statusSource.match(new RegExp(`export const ${name} = \\[(.*?)\\] as const`, "s"));
  assert.ok(match, `${name} should be declared as a readonly status list`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function cssBlock(selector) {
  const marker = styles.lastIndexOf(`\n${selector} {`);
  assert.notEqual(marker, -1, `${selector} should exist`);
  const start = marker + 1;
  const end = styles.indexOf("\n}", start);
  assert.notEqual(end, -1, `${selector} should have a closing brace`);
  return styles.slice(start, end + 2);
}

test("the issue workspace projects configured statuses into adaptive main and secondary groups", () => {
  assert.deepEqual(statusList("MAIN_STATUSES"), ["todo", "in_progress", "blocked", "in_review"]);
  assert.deepEqual(statusList("SECONDARY_STATUSES"), ["backlog", "done", "canceled"]);
  assert.match(statusSource, /satisfies readonly TaskStatus\[\]/);
  assert.match(appSource, /const mainBoardItems = boardDisplaySettings\.mainStatuses;/);
  assert.doesNotMatch(appSource, /status !== "blocked"/);
  assert.doesNotMatch(displayMenuSource, /默认隐藏|hidden by default/);
  assert.match(appSource, /mainBoardItems\.map\(\(item\) => item === "archived" \? \([\s\S]*?<BoardColumn/);
  assert.match(appSource, /mainBoardItems\.map\(\(item\) => \([\s\S]*?className="loading-column"/);
  assert.match(boardColumnSource, /todo: \{ label: "等待认领", tone: "todo" \}/);
  assert.match(boardColumnSource, /in_progress: \{ label: "处理中", tone: "progress" \}/);
  assert.match(boardColumnSource, /blocked: \{ label: "遇到阻碍", tone: "blocked" \}/);
  assert.match(boardColumnSource, /in_review: \{ label: "等待验证", tone: "review" \}/);
});
