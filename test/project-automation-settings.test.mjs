import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const menuSource = await readFile(
  new URL("../web/src/components/ProjectAutomationMenu.tsx", import.meta.url),
  "utf8",
);
const iconSource = await readFile(
  new URL("../web/src/components/TaskboardIcon.tsx", import.meta.url),
  "utf8",
);
const playIcon = await readFile(
  new URL("../web/src/assets/figma-taskboard/automation-play.svg", import.meta.url),
  "utf8",
);
const pauseIcon = await readFile(
  new URL("../web/src/assets/figma-taskboard/automation-pause.svg", import.meta.url),
  "utf8",
);
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("Jira parent sessions open a projectless conversation", () => {
  const openTaskSource = appSource.slice(
    appSource.indexOf("function codexProjectContextForTaskProject"),
    appSource.indexOf("function changeProject"),
  );
  assert.match(
    openTaskSource,
    /if \(taskboardProjectId === GLOBAL_PROJECT_ID\) return null/,
  );
  assert.match(
    openTaskSource,
    /const projectless = conversationRole === "parent" \|\| jiraEntry/,
  );
  assert.match(openTaskSource, /codexProjectId: codexProject\.id,\s*codexProjectKind: codexProject\.projectKind/);
  assert.match(openTaskSource, /const savedRemoteIdentity = !projectless\s*&& projectCodexIdentities\[task\.projectId\]/);
  assert.match(openTaskSource, /codexProjectContextForTaskProject\(task\.projectId\)/);
  assert.match(openTaskSource, /project\.hostId === baseIdentity\.codexHostId/);
  assert.match(openTaskSource, /project\.workspacePath === worktreePath/);
  assert.match(openTaskSource, /if \(matches\.length !== 1\) return null/);
  assert.match(openTaskSource, /codexProjectId: codexProjectContext\?\.codexProjectId/);
});
