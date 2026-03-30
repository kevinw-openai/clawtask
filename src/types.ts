export const TASK_STATUSES = [
  "queued",
  "in_progress",
  "completed",
  "failed",
  "canceled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskRecord {
  id: string;
  parentTaskId: string | null;
  createdByAgentId: string;
  assignedToAgentId: string;
  title: string;
  body: string;
  status: TaskStatus;
  cancelRequestedAt: string | null;
  claimedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface TaskEventRecord {
  id: number;
  taskId: string;
  actorAgentId: string;
  kind: string;
  body: unknown;
  createdAt: string;
}

export interface TaskDetails {
  task: TaskRecord;
  events: TaskEventRecord[];
  childTaskIds: string[];
}

export interface CreateTaskInput {
  createdByAgentId: string;
  assignedToAgentId: string;
  title: string;
  body: string;
  parentTaskId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TaskListFilters {
  assignedToAgentId?: string;
  createdByAgentId?: string;
  status?: TaskStatus;
}

export interface ErrorPayload {
  code: string;
  message: string;
}
