---
name: task-session-orchestration
description: Orchestrate Taskboard parent and child sessions when runtime session context identifies a parent or child role. Use for Jira task analysis, worker dispatch, execution packets, result reporting, and parent-child coordination.
invocation: model-invoked
---

# Task Session Orchestration

This is a model-invoked workflow skill. Trigger it when the runtime context identifies a Taskboard orchestration parent or child; do not wait for the user to restate the protocol.

Use `orchestration` as the routing boundary. Resolve the current session context first; use its IDs for every operation.

## Start

1. Run `taskctl session context --json`.
   Completion: the response contains `role`, `taskId`, `orchestrationId`, and the matching parent or child binding.
2. Load [the protocol reference](references/protocol.md) when a command or result schema is needed.
   Completion: the command arguments and expected state transition are known before writing data.
3. If context cannot be resolved, report the missing context and stop. Do not infer a parent from task text or thread titles.

## Parent

1. Use [manage-taskboard](../manage-taskboard/SKILL.md) to read the issue body, all comments, task attachments, and comment attachments.
   Completion: the current Jira snapshot and its useful evidence are available.
2. Produce `task-intent.v1` with the problem, execution scope, acceptance criteria, relevant evidence, and open questions.
   Completion: a worker can execute from the packet without reinterpreting Jira.
3. After the execution scope is confirmed, run `taskctl session create-child` with the analysis and concise execution instruction.
   Completion: the command returns the child binding and `orchestrationId`.
4. Read `taskctl session timeline --json` until a child result is present. Run `taskctl session report-ack --result-revision N`, then `taskctl session review --decision approved|needs_rework|blocked --result-revision N`.
   Completion: the result has an explicit review decision and the next parent action is recorded.

## Child

1. Run `taskctl session packet --json` after context resolution and treat the returned packet as the execution contract.
   Completion: the task, intent revision, instruction, worktree, and report target agree. If packet loading fails, stop without modifying files.
2. Implement the confirmed scope in the bound workspace and run focused verification.
   Completion: the requested path passes, or the result contains a concrete blocker and the next action needed from the parent.
3. Write a `task-result.v1` JSON object and run `taskctl session report --result-file RESULT.json`.
   Completion: the service accepts a `resultRevision` and the timeline contains a `child_to_parent` result.

## Routing rules

- The `orchestrationId` is the single parent-child routing key. Thread IDs authenticate each side; natural-language prompts do not establish ownership.
- Keep Jira reads and Jira writes parent-owned. The child works from the forwarded packet and reports structured results.
- Use the current context for idempotency and revisions. A retry must reuse the same `orchestrationId:resultRevision` key and identical payload.
- Preserve `waiting_for_user` and `blocked` as visible orchestration states. Record the reason and requested parent action in the timeline.
- Never infer parent/child identity from a prompt, thread title, Jira text, or project name; only the session context and packet bindings establish ownership.
