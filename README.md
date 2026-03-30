# clawtask

`clawtask` is a lightweight local task inbox for peer agents running on the same host.

This v0 is intentionally small:

- one standalone TypeScript CLI
- one SQLite database file
- no daemon
- no HTTP API
- no background worker

## Install

```bash
npm install
npm run build
```

## Database location

By default `clawtask` stores data in:

```text
~/.clawtask/tasks.db
```

Override it with `CLAWTASK_DB`:

```bash
CLAWTASK_DB=/tmp/clawtask.db clawtask list
```

## Commands

Create a task:

```bash
clawtask create --from agent-a --to agent-b --title "Review patch" --body "Check the OAuth fix."
```

Claim the next queued task for an assignee:

```bash
clawtask claim --agent agent-b --next
```

Mark a claimed task complete:

```bash
clawtask status --agent agent-b --task <task-id> --set completed
```

Request cancellation from the creator side:

```bash
clawtask cancel --agent agent-a --task <task-id>
```

Attach a freeform event:

```bash
clawtask event --agent agent-b --task <task-id> --kind progress --data '{"message":"halfway done"}'
```

Create a subtask:

```bash
clawtask subtask create --parent <task-id> --from agent-b --to agent-c --title "Investigate" --body "Check the failing test."
```

## Output

Every command prints exactly one JSON object to stdout.

Success shape:

```json
{"ok":true}
```

Failure shape:

```json
{
  "ok": false,
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "Task not found: task-123"
  }
}
```
