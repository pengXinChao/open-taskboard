# Task Session Protocol

## Context

`taskctl session context --json` resolves the active orchestration from `CODEX_THREAD_ID` (or `--thread-id`) and returns:

```json
{
  "role": "parent | child",
  "taskId": "...",
  "orchestrationId": "...",
  "parentThreadId": "...",
  "childThreadId": "...",
  "intentVersion": 1,
  "currentResultRevision": 0,
  "state": "executing"
}
```

The service rejects a missing binding, a thread mismatch, and a child reused by another active orchestration.

## Parent commands

```bash
taskctl session create-child ISSUE_ID \
  --analysis-file ANALYSIS.json \
  --instruction-file INSTRUCTION.txt
taskctl session timeline --json
taskctl session report-ack --result-revision N
```

`create-child` is the only operation that creates a child. Repeating it with the same parent and idempotency key is safe.

## Child result

```json
{
  "version": "task-result.v1",
  "summary": "完成了什么以及结论是什么",
  "changedFiles": ["path/to/file"],
  "verification": ["npm run typecheck"],
  "blockers": []
}
```

Submit it with:

```bash
taskctl session report --result-file RESULT.json
```

The command derives `orchestrationId`, parent/child thread IDs, intent version, and the next result revision from the current context. The report endpoint stores an immutable result revision and appends a `child_to_parent` timeline message.

## Execution packet

Child sessions read `taskctl session packet --json`. The endpoint resolves the current thread first and only permits the bound child role. It combines the current intent with the newest `analysis_forwarded` message and returns `task-session-packet.v1`; a missing child, missing forwarded message, missing instruction, or mismatched binding is an error and must stop execution.

## Review

Only the parent may acknowledge and review a result:

```bash
taskctl session report-ack --result-revision N
taskctl session review --decision approved|needs_rework|blocked --result-revision N
```

`approved` advances to integration/writeback, `needs_rework` returns to execution while retaining the result revision, and `blocked` preserves the blocking state and reason. `waiting_for_user` and `blocked` are never hidden from the timeline or management panel.
