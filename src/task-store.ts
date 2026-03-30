import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import type {
  CreateTaskInput,
  TaskDetails,
  TaskEventRecord,
  TaskListFilters,
  TaskRecord,
  TaskStatus,
} from "./types";
import { TASK_STATUSES } from "./types";

interface TaskRow {
  id: string;
  parent_task_id: string | null;
  created_by_agent_id: string;
  assigned_to_agent_id: string;
  title: string;
  body: string;
  status: TaskStatus;
  cancel_requested_at: string | null;
  claimed_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

interface TaskEventRow {
  id: number;
  task_id: string;
  actor_agent_id: string;
  kind: string;
  body_json: string;
  created_at: string;
}

export class TaskStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TaskStoreError";
    this.code = code;
  }
}

export class TaskStore {
  constructor(private readonly db: Database.Database) {}

  close(): void {
    this.db.close();
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const tx = this.db.transaction((payload: CreateTaskInput) => {
      if (payload.parentTaskId) {
        this.getTaskRowOrThrow(payload.parentTaskId);
      }

      const now = isoNow();
      const taskId = randomUUID();
      const metadataJson = JSON.stringify(payload.metadata ?? {});

      this.db
        .prepare(
          `
            INSERT INTO tasks (
              id,
              parent_task_id,
              created_by_agent_id,
              assigned_to_agent_id,
              title,
              body,
              status,
              cancel_requested_at,
              claimed_at,
              finished_at,
              created_at,
              updated_at,
              metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)
          `,
        )
        .run(
          taskId,
          payload.parentTaskId ?? null,
          payload.createdByAgentId,
          payload.assignedToAgentId,
          payload.title,
          payload.body,
          "queued",
          now,
          now,
          metadataJson,
        );

      this.insertEvent(taskId, payload.createdByAgentId, "task_created", {
        parentTaskId: payload.parentTaskId ?? null,
      });

      return this.getTaskOrThrow(taskId);
    });

    return tx.immediate(input);
  }

  createSubtask(input: CreateTaskInput & { parentTaskId: string }): TaskRecord {
    return this.createTask(input);
  }

  listTasks(filters: TaskListFilters = {}): TaskRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.assignedToAgentId) {
      clauses.push("assigned_to_agent_id = ?");
      params.push(filters.assignedToAgentId);
    }
    if (filters.createdByAgentId) {
      clauses.push("created_by_agent_id = ?");
      params.push(filters.createdByAgentId);
    }
    if (filters.status) {
      this.assertValidStatus(filters.status);
      clauses.push("status = ?");
      params.push(filters.status);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM tasks
          ${where}
          ORDER BY created_at ASC, rowid ASC
        `,
      )
      .all(...params) as TaskRow[];

    return rows.map(mapTaskRow);
  }

  showTask(taskId: string): TaskDetails {
    const task = this.getTaskOrThrow(taskId);
    const events = this.db
      .prepare(
        `
          SELECT *
          FROM task_events
          WHERE task_id = ?
          ORDER BY id ASC
        `,
      )
      .all(taskId) as TaskEventRow[];
    const childRows = this.db
      .prepare(
        `
          SELECT id
          FROM tasks
          WHERE parent_task_id = ?
          ORDER BY created_at ASC, rowid ASC
        `,
      )
      .all(taskId) as Array<{ id: string }>;

    return {
      task,
      events: events.map(mapTaskEventRow),
      childTaskIds: childRows.map((row) => row.id),
    };
  }

  claimTask(agentId: string, taskId: string): TaskRecord {
    const tx = this.db.transaction((assignee: string, id: string) => {
      const row = this.getTaskRowOrThrow(id);
      this.assertAssignedAgent(row, assignee);

      if (row.status !== "queued") {
        throw new TaskStoreError(
          "INVALID_STATE",
          `Task ${id} cannot be claimed from status ${row.status}`,
        );
      }

      const now = isoNow();
      const result = this.db
        .prepare(
          `
            UPDATE tasks
            SET status = 'in_progress',
                claimed_at = ?,
                updated_at = ?
            WHERE id = ?
              AND assigned_to_agent_id = ?
              AND status = 'queued'
          `,
        )
        .run(now, now, id, assignee);

      if (result.changes !== 1) {
        throw new TaskStoreError("CLAIM_CONFLICT", `Task ${id} is no longer claimable`);
      }

      this.insertEvent(id, assignee, "task_claimed", { mode: "explicit" });
      return this.getTaskOrThrow(id);
    });

    return tx.immediate(agentId, taskId);
  }

  claimNext(agentId: string): TaskRecord | null {
    const tx = this.db.transaction((assignee: string) => {
      const candidate = this.db
        .prepare(
          `
            SELECT id
            FROM tasks
            WHERE assigned_to_agent_id = ?
              AND status = 'queued'
            ORDER BY created_at ASC, rowid ASC
            LIMIT 1
          `,
        )
        .get(assignee) as { id: string } | undefined;

      if (!candidate) {
        return null;
      }

      const now = isoNow();
      const result = this.db
        .prepare(
          `
            UPDATE tasks
            SET status = 'in_progress',
                claimed_at = ?,
                updated_at = ?
            WHERE id = ?
              AND assigned_to_agent_id = ?
              AND status = 'queued'
          `,
        )
        .run(now, now, candidate.id, assignee);

      if (result.changes !== 1) {
        throw new TaskStoreError("CLAIM_CONFLICT", "Queued task claim raced with another client");
      }

      this.insertEvent(candidate.id, assignee, "task_claimed", { mode: "next" });
      return this.getTaskOrThrow(candidate.id);
    });

    return tx.immediate(agentId);
  }

  setStatus(agentId: string, taskId: string, nextStatus: TaskStatus): TaskRecord {
    this.assertValidStatus(nextStatus);

    const tx = this.db.transaction((assignee: string, id: string, desiredStatus: TaskStatus) => {
      const row = this.getTaskRowOrThrow(id);
      this.assertAssignedAgent(row, assignee);
      this.assertTransitionAllowed(row.status, desiredStatus);

      const now = isoNow();
      const finishedAt = isTerminalStatus(desiredStatus) ? now : null;

      this.db
        .prepare(
          `
            UPDATE tasks
            SET status = ?,
                finished_at = ?,
                updated_at = ?
            WHERE id = ?
          `,
        )
        .run(desiredStatus, finishedAt, now, id);

      this.insertEvent(id, assignee, "task_status_changed", {
        from: row.status,
        to: desiredStatus,
      });

      return this.getTaskOrThrow(id);
    });

    return tx.immediate(agentId, taskId, nextStatus);
  }

  cancelTask(agentId: string, taskId: string): TaskRecord {
    const tx = this.db.transaction((creator: string, id: string) => {
      const row = this.getTaskRowOrThrow(id);
      this.assertCreatorAgent(row, creator);

      if (row.status === "queued") {
        const now = isoNow();
        this.db
          .prepare(
            `
              UPDATE tasks
              SET status = 'canceled',
                  finished_at = ?,
                  updated_at = ?
              WHERE id = ?
            `,
          )
          .run(now, now, id);

        this.insertEvent(id, creator, "task_canceled", { mode: "queued" });
        return this.getTaskOrThrow(id);
      }

      if (row.status === "in_progress") {
        if (row.cancel_requested_at === null) {
          const now = isoNow();
          this.db
            .prepare(
              `
                UPDATE tasks
                SET cancel_requested_at = ?,
                    updated_at = ?
                WHERE id = ?
              `,
            )
            .run(now, now, id);

          this.insertEvent(id, creator, "task_cancel_requested", {});
        }

        return this.getTaskOrThrow(id);
      }

      return this.getTaskOrThrow(id);
    });

    return tx.immediate(agentId, taskId);
  }

  addEvent(agentId: string, taskId: string, kind: string, body: unknown): TaskEventRecord {
    const tx = this.db.transaction((actor: string, id: string, eventKind: string, payload: unknown) => {
      this.getTaskRowOrThrow(id);
      const eventId = this.insertEvent(id, actor, eventKind, payload);

      const row = this.db
        .prepare("SELECT * FROM task_events WHERE id = ?")
        .get(eventId) as TaskEventRow | undefined;

      if (!row) {
        throw new TaskStoreError("EVENT_NOT_FOUND", `Event ${eventId} was not persisted`);
      }

      return mapTaskEventRow(row);
    });

    return tx.immediate(agentId, taskId, kind, body);
  }

  private insertEvent(taskId: string, actorAgentId: string, kind: string, body: unknown): number {
    const now = isoNow();
    const bodyJson = JSON.stringify(body ?? {});
    const result = this.db
      .prepare(
        `
          INSERT INTO task_events (
            task_id,
            actor_agent_id,
            kind,
            body_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(taskId, actorAgentId, kind, bodyJson, now);

    this.db
      .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
      .run(now, taskId);

    return Number(result.lastInsertRowid);
  }

  private getTaskOrThrow(taskId: string): TaskRecord {
    return mapTaskRow(this.getTaskRowOrThrow(taskId));
  }

  private getTaskRowOrThrow(taskId: string): TaskRow {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(taskId) as TaskRow | undefined;

    if (!row) {
      throw new TaskStoreError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
    }

    return row;
  }

  private assertAssignedAgent(row: TaskRow, agentId: string): void {
    if (row.assigned_to_agent_id !== agentId) {
      throw new TaskStoreError(
        "UNAUTHORIZED",
        `Agent ${agentId} is not allowed to operate on task ${row.id} as assignee`,
      );
    }
  }

  private assertCreatorAgent(row: TaskRow, agentId: string): void {
    if (row.created_by_agent_id !== agentId) {
      throw new TaskStoreError(
        "UNAUTHORIZED",
        `Agent ${agentId} is not allowed to cancel task ${row.id} as creator`,
      );
    }
  }

  private assertValidStatus(status: string): asserts status is TaskStatus {
    if (!TASK_STATUSES.includes(status as TaskStatus)) {
      throw new TaskStoreError("INVALID_STATUS", `Unknown task status: ${status}`);
    }
  }

  private assertTransitionAllowed(current: TaskStatus, next: TaskStatus): void {
    if (current === "queued") {
      throw new TaskStoreError(
        "INVALID_TRANSITION",
        "Queued tasks must be claimed before assignee status updates",
      );
    }

    if (isTerminalStatus(current)) {
      throw new TaskStoreError(
        "INVALID_TRANSITION",
        `Task cannot transition from terminal status ${current}`,
      );
    }

    if (next === "queued") {
      throw new TaskStoreError(
        "INVALID_TRANSITION",
        "Tasks cannot be returned to queued in v0",
      );
    }
  }
}

function mapTaskRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    parentTaskId: row.parent_task_id,
    createdByAgentId: row.created_by_agent_id,
    assignedToAgentId: row.assigned_to_agent_id,
    title: row.title,
    body: row.body,
    status: row.status,
    cancelRequestedAt: row.cancel_requested_at,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJsonObject(row.metadata_json),
  };
}

function mapTaskEventRow(row: TaskEventRow): TaskEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    actorAgentId: row.actor_agent_id,
    kind: row.kind,
    body: parseJson(row.body_json),
    createdAt: row.created_at,
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const value = parseJson(raw);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function isoNow(): string {
  return new Date().toISOString();
}

function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
