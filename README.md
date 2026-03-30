# clawtask

`clawtask` is a lightweight local task inbox for peer agents running on the same host.

It now covers three layers of the local multi-agent loop:

- durable task storage in SQLite
- an OpenClaw listener bridge that claims tasks and dispatches agent turns
- a runtime snapshot export for `clawco`

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

When you pass `--project /path/to/squad`, `clawtask` uses that squad's shared runtime DB instead:

```text
/path/to/squad/runtime-tasks.db
```

For integrated ClawSquad deployments, prefer `--project` over bare `clawtask` so humans, `lead`, listeners, and Clawco all read the same task store.

## Commands

Create a task:

```bash
clawtask create \
  --project /path/to/squad \
  --from lead \
  --to developer \
  --title "Build prettymd" \
  --body "Create the initial markdown formatting project." \
  --metadata '{"projectPath":"~/Documents/demo/prettymd","acceptance":["working app","tests passing"]}'
```

Claim the next queued task for an assignee:

```bash
clawtask claim --project /path/to/squad --agent agent-b --next
```

Mark a claimed task complete:

```bash
clawtask status --project /path/to/squad --agent agent-b --task <task-id> --set completed
```

Request cancellation from the creator side:

```bash
clawtask cancel --project /path/to/squad --agent agent-a --task <task-id>
```

Attach a freeform event:

```bash
clawtask event --project /path/to/squad --agent agent-b --task <task-id> --kind progress --data '{"message":"halfway done"}'
```

Create a subtask:

```bash
clawtask subtask create \
  --project /path/to/squad \
  --parent <task-id> \
  --from lead \
  --to reviewer \
  --title "Review prettymd" \
  --body "Check the implementation for regressions." \
  --metadata '{"parentGoal":"ship prettymd"}'
```

Listen for queued work and dispatch it into OpenClaw:

```bash
node dist/cli.js listen \
  --agent developer \
  --project /path/to/squad \
  --once \
  --thinking medium \
  --timeout 300 \
  --resume-wait-ms 30000 \
  --clawtask-command "node /Users/claw/Documents/clawtask/dist/cli.js"
```

The listener:

- resumes any already-claimed in-progress task for that assignee before claiming new queue work
- claims the next queued task for the assignee
- invokes `openclaw agent --agent <id> --json ...`
- records listener lifecycle events
- waits briefly for a resumed terminal `clawtask` status if the turn yields before finishing
- fails the task only after the resume wait expires without a terminal status

Export a Clawco-ready runtime snapshot:

```bash
node dist/cli.js snapshot --project /path/to/squad > /tmp/clawco-snapshot.json
```

## Output

Every command prints exactly one JSON payload to stdout.

Success shape:

```json
{"ok":true}
```

`snapshot` is the exception: it prints the raw snapshot object so `clawco` can fetch it directly.

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

## OpenClaw Integration Notes

`listen` assumes:

- `openclaw` is installed and reachable on `PATH`
- the target agent already exists in your OpenClaw config
- the agent can run the `clawtask` command you reference in the prompt

If `openclaw` is not on `PATH`, set `CLAWTASK_OPENCLAW_BIN` to the executable you want the listener to use.

The prompt sent through OpenClaw tells the assignee to:

- treat the `clawtask` task id as the source of truth
- use Codex through ACP when coding work is required
- keep `--project /path/to/squad` on `clawtask` commands so the squad stays on one runtime DB
- log progress with `clawtask event`
- finish with `clawtask status --set completed|failed`

## Clawco Snapshot

`clawtask snapshot` can read a ClawSquad project directory. When `apply` has already written `.clawsquad/runtime/topology.json`, the snapshot uses that topology directly. Otherwise it falls back to parsing `clawsquad.json`.

The exported model includes:

- team metadata
- agent hierarchy and live status
- active-task and queue counts per agent
- collaboration edges derived from task handoffs
- normalized task records for visualization
