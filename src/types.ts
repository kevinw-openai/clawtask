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

export type AgentLane =
  | "command"
  | "planning"
  | "research"
  | "execution"
  | "quality";

export type AgentStatus =
  | "idle"
  | "thinking"
  | "delegating"
  | "blocked"
  | "delivering";

export interface SnapshotProjectInfo {
  name: string;
  description?: string;
  projectDir?: string;
  openclawHome?: string;
}

export interface SnapshotTaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  createdByAgentId: string;
  assignedToAgentId: string;
  updatedAt: string;
  cancelRequested: boolean;
}

export interface SnapshotAgent {
  id: string;
  name: string;
  role: string;
  managerId: string | null;
  lane: AgentLane;
  status: AgentStatus;
  workload: number;
  summary: string;
  workspace: string | null;
  agentDir: string | null;
  subagents: string[];
  stats: {
    queued: number;
    inProgress: number;
    completed: number;
    failed: number;
    canceled: number;
    activeTaskIds: string[];
  };
  activeTasks: SnapshotTaskSummary[];
}

export interface SnapshotCollaboration {
  sourceId: string;
  targetId: string;
  strength: number;
  reason: string;
}

export interface SnapshotTask {
  id: string;
  parentTaskId: string | null;
  title: string;
  status: TaskStatus;
  createdByAgentId: string;
  assignedToAgentId: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  cancelRequested: boolean;
}

export interface ClawcoSnapshot {
  generatedAt: string;
  team: SnapshotProjectInfo;
  agents: SnapshotAgent[];
  collaborations: SnapshotCollaboration[];
  tasks: SnapshotTask[];
}

export interface ListenerOptions {
  agentId: string;
  projectDir?: string;
  once?: boolean;
  pollMs?: number;
  maxTasks?: number;
  thinking?: string;
  timeoutSeconds?: number;
  resumeWaitMs?: number;
  clawtaskCommand?: string;
}

export interface ListenerRunResult {
  taskId: string;
  finalStatus: TaskStatus;
  openclawOutput?: unknown;
  note?: string;
}

export interface ListenerSummary {
  agentId: string;
  idle: boolean;
  processed: number;
  results: ListenerRunResult[];
}
