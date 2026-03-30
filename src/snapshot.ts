import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { TaskStore } from "./task-store";
import type {
  AgentLane,
  AgentStatus,
  ClawcoSnapshot,
  SnapshotAgent,
  SnapshotCollaboration,
  SnapshotProjectInfo,
  SnapshotTask,
  SnapshotTaskSummary,
  TaskRecord,
  TaskStatus,
} from "./types";

const TOPOLOGY_PATH = path.join(".clawsquad", "runtime", "topology.json");

interface LoadedProjectAgent {
  id: string;
  name: string;
  role: string;
  managerId: string | null;
  lane: AgentLane;
  summary: string;
  workspace: string | null;
  agentDir: string | null;
  subagents: string[];
}

export interface LoadedProjectContext {
  team: SnapshotProjectInfo;
  agents: LoadedProjectAgent[];
}

interface ClawsquadManifest {
  name?: unknown;
  description?: unknown;
  openclawHome?: unknown;
  roles?: unknown;
}

interface ClawsquadRole {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  lane?: unknown;
  workspaceDir?: unknown;
  agentDir?: unknown;
  subagents?: unknown;
}

interface TopologyFile {
  team?: {
    name?: unknown;
    description?: unknown;
    projectDir?: unknown;
    openclawHome?: unknown;
  };
  agents?: unknown;
}

interface TopologyAgentFile {
  id?: unknown;
  name?: unknown;
  role?: unknown;
  summary?: unknown;
  managerId?: unknown;
  lane?: unknown;
  workspace?: unknown;
  agentDir?: unknown;
  subagents?: unknown;
}

export async function buildSnapshot(
  store: TaskStore,
  options: { projectDir?: string } = {},
): Promise<ClawcoSnapshot> {
  const tasks = store
    .listTasks()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const project = options.projectDir == null ? undefined : await loadProjectContext(options.projectDir);
  const agents = buildSnapshotAgents(project, tasks);

  return {
    generatedAt: new Date().toISOString(),
    team:
      project?.team ?? {
        name: "clawtask",
        description: "Runtime-only task graph",
      },
    agents,
    collaborations: buildCollaborations(tasks),
    tasks: tasks.map(mapTaskRecordToSnapshotTask),
  };
}

export async function loadProjectContext(projectDirInput: string): Promise<LoadedProjectContext> {
  const projectDir = path.resolve(projectDirInput);
  const topologyPath = path.join(projectDir, TOPOLOGY_PATH);
  if (await pathExists(topologyPath)) {
    return loadProjectContextFromTopology(projectDir, topologyPath);
  }

  return loadProjectContextFromManifest(projectDir);
}

async function loadProjectContextFromTopology(
  projectDir: string,
  topologyPath: string,
): Promise<LoadedProjectContext> {
  const raw = await readJson(topologyPath);
  const topology = isRecord(raw) ? (raw as TopologyFile) : {};
  const teamInput = isRecord(topology.team) ? topology.team : {};
  const agentsInput = Array.isArray(topology.agents) ? topology.agents : [];

  return {
    team: {
      name: stringOr(teamInput.name, path.basename(projectDir)),
      description: optionalString(teamInput.description),
      projectDir: stringOr(teamInput.projectDir, projectDir),
      openclawHome: optionalString(teamInput.openclawHome),
    },
    agents: agentsInput
      .filter(isRecord)
      .map((entry) => mapTopologyAgent(entry as TopologyAgentFile))
      .sort(byAgentId),
  };
}

async function loadProjectContextFromManifest(projectDir: string): Promise<LoadedProjectContext> {
  const manifestPath = path.join(projectDir, "clawsquad.json");
  const raw = await readJson(manifestPath);
  if (!isRecord(raw)) {
    throw new Error(`Expected clawsquad.json to contain an object: ${manifestPath}`);
  }

  const manifest = raw as ClawsquadManifest;
  const openclawHome = resolveOpenclawHome(projectDir, manifest.openclawHome);
  const roles = Array.isArray(manifest.roles) ? manifest.roles.filter(isRecord) : [];
  const managerByRole = new Map<string, string>();

  for (const role of roles) {
    const roleSubagents = Array.isArray(role.subagents)
      ? role.subagents.filter((value): value is string => typeof value === "string")
      : [];
    const roleId = optionalString(role.id);
    if (roleId == null) {
      continue;
    }
    for (const subagentId of roleSubagents) {
      managerByRole.set(subagentId, roleId);
    }
  }

  return {
    team: {
      name: stringOr(manifest.name, path.basename(projectDir)),
      description: optionalString(manifest.description),
      projectDir,
      openclawHome,
    },
    agents: roles.map((role) => {
      const roleId = stringOr(role.id, "unknown");
      const roleName = optionalString(role.name) ?? roleId;
      const lane = parseLane(role.lane) ?? resolveLane(roleId, roleName, managerByRole.get(roleId));
      const workspaceRel = optionalString(role.workspaceDir) ?? defaultWorkspaceDir(roleId);
      const agentDirValue = role.agentDir;
      const agentDirRel =
        agentDirValue === null
          ? null
          : optionalString(agentDirValue) ?? defaultAgentDir(roleId);

      return {
        id: roleId,
        name: roleName,
        role: roleName,
        managerId: managerByRole.get(roleId) ?? null,
        lane,
        summary: optionalString(role.description) ?? `${roleName} in ${stringOr(manifest.name, roleId)}`,
        workspace: path.join(openclawHome, workspaceRel),
        agentDir: agentDirRel == null ? null : path.join(openclawHome, agentDirRel),
        subagents: Array.isArray(role.subagents)
          ? role.subagents.filter((value): value is string => typeof value === "string")
          : [],
      };
    }),
  };
}

function mapTopologyAgent(input: TopologyAgentFile): LoadedProjectAgent {
  const id = stringOr(input.id, "unknown");
  const name = optionalString(input.name) ?? id;

  return {
    id,
    name,
    role: optionalString(input.role) ?? name,
    managerId: optionalString(input.managerId) ?? null,
    lane: parseLane(input.lane) ?? resolveLane(id, name, optionalString(input.managerId) ?? undefined),
    summary: optionalString(input.summary) ?? `${name} runtime agent`,
    workspace: optionalString(input.workspace) ?? null,
    agentDir: optionalString(input.agentDir) ?? null,
    subagents: Array.isArray(input.subagents)
      ? input.subagents.filter((value): value is string => typeof value === "string")
      : [],
  };
}

function buildSnapshotAgents(
  project: LoadedProjectContext | undefined,
  tasks: TaskRecord[],
): SnapshotAgent[] {
  const agentMap = new Map<string, LoadedProjectAgent>();

  for (const agent of project?.agents ?? []) {
    agentMap.set(agent.id, agent);
  }

  for (const task of tasks) {
    ensureDerivedAgent(agentMap, task.createdByAgentId);
    ensureDerivedAgent(agentMap, task.assignedToAgentId);
  }

  return [...agentMap.values()]
    .sort(byAgentId)
    .map((agent) => buildSnapshotAgent(agent, tasks));
}

function buildSnapshotAgent(agent: LoadedProjectAgent, tasks: TaskRecord[]): SnapshotAgent {
  const assignedTasks = tasks.filter((task) => task.assignedToAgentId === agent.id);
  const activeTasks = assignedTasks
    .filter((task) => task.status === "queued" || task.status === "in_progress")
    .sort(compareTaskRecency)
    .map(mapTaskRecordToSummary);
  const latestTerminalTask = assignedTasks
    .filter(
      (task) =>
        task.status === "completed" || task.status === "failed" || task.status === "canceled",
    )
    .sort(compareTaskRecency)[0];
  const stats = {
    queued: assignedTasks.filter((task) => task.status === "queued").length,
    inProgress: assignedTasks.filter((task) => task.status === "in_progress").length,
    completed: assignedTasks.filter((task) => task.status === "completed").length,
    failed: assignedTasks.filter((task) => task.status === "failed").length,
    canceled: assignedTasks.filter((task) => task.status === "canceled").length,
    activeTaskIds: activeTasks.map((task) => task.id),
  };

  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    managerId: agent.managerId,
    lane: agent.lane,
    status: resolveAgentStatus(agent.lane, activeTasks, latestTerminalTask?.status),
    workload: resolveWorkload(activeTasks, stats, latestTerminalTask?.status),
    summary: agent.summary,
    workspace: agent.workspace,
    agentDir: agent.agentDir,
    subagents: [...agent.subagents],
    stats,
    activeTasks,
  };
}

function buildCollaborations(tasks: TaskRecord[]): SnapshotCollaboration[] {
  const counts = new Map<string, { sourceId: string; targetId: string; count: number }>();

  for (const task of tasks) {
    if (task.createdByAgentId === task.assignedToAgentId) {
      continue;
    }

    const key = `${task.createdByAgentId}->${task.assignedToAgentId}`;
    const current = counts.get(key) ?? {
      sourceId: task.createdByAgentId,
      targetId: task.assignedToAgentId,
      count: 0,
    };
    current.count += 1;
    counts.set(key, current);
  }

  const edges = [...counts.values()].sort((left, right) => right.count - left.count);
  const strongest = edges[0]?.count ?? 1;

  return edges.map((edge) => ({
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    strength: roundTo(Math.min(1, 0.35 + edge.count / strongest), 2),
    reason: `Task handoffs (${edge.count})`,
  }));
}

function mapTaskRecordToSummary(task: TaskRecord): SnapshotTaskSummary {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    createdByAgentId: task.createdByAgentId,
    assignedToAgentId: task.assignedToAgentId,
    updatedAt: task.updatedAt,
    cancelRequested: task.cancelRequestedAt != null,
  };
}

function mapTaskRecordToSnapshotTask(task: TaskRecord): SnapshotTask {
  return {
    id: task.id,
    parentTaskId: task.parentTaskId,
    title: task.title,
    status: task.status,
    createdByAgentId: task.createdByAgentId,
    assignedToAgentId: task.assignedToAgentId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
    cancelRequested: task.cancelRequestedAt != null,
  };
}

function ensureDerivedAgent(agentMap: Map<string, LoadedProjectAgent>, agentId: string): void {
  if (agentMap.has(agentId)) {
    return;
  }

  agentMap.set(agentId, {
    id: agentId,
    name: agentId,
    role: agentId,
    managerId: null,
    lane: resolveLane(agentId, agentId, undefined),
    summary: `Observed in clawtask as ${agentId}`,
    workspace: null,
    agentDir: null,
    subagents: [],
  });
}

function resolveAgentStatus(
  lane: AgentLane,
  activeTasks: SnapshotTaskSummary[],
  latestTerminalStatus: TaskRecord["status"] | undefined,
): AgentStatus {
  if (activeTasks.some((task) => task.cancelRequested)) {
    return "blocked";
  }

  const inProgressCount = activeTasks.filter((task) => task.status === "in_progress").length;
  const queuedCount = activeTasks.filter((task) => task.status === "queued").length;

  if (inProgressCount > 0) {
    if (lane === "command" || lane === "planning") {
      return "delegating";
    }
    if (lane === "research" || lane === "quality") {
      return "thinking";
    }
    return "delivering";
  }

  if (queuedCount > 0) {
    if (lane === "command" || lane === "planning") {
      return "delegating";
    }
    return "thinking";
  }

  if (latestTerminalStatus === "failed" || latestTerminalStatus === "canceled") {
    return "blocked";
  }

  return "idle";
}

function resolveWorkload(
  activeTasks: SnapshotTaskSummary[],
  stats: SnapshotAgent["stats"],
  latestTerminalStatus: TaskRecord["status"] | undefined,
): number {
  const cancelPenalty = activeTasks.some((task) => task.cancelRequested) ? 0.15 : 0;
  const inProgressWeight = stats.inProgress * 0.55;
  const queuedWeight = stats.queued * 0.2;
  const failureWeight =
    latestTerminalStatus === "failed" || latestTerminalStatus === "canceled" ? 0.08 : 0;

  return roundTo(Math.min(1, inProgressWeight + queuedWeight + cancelPenalty + failureWeight), 2);
}

function compareTaskRecency(left: TaskRecord, right: TaskRecord): number {
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    compareNullableIso(right.finishedAt, left.finishedAt) ||
    right.createdAt.localeCompare(left.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

function compareNullableIso(left: string | null, right: string | null): number {
  if (left != null && right != null) {
    return left.localeCompare(right);
  }
  if (left != null) {
    return 1;
  }
  if (right != null) {
    return -1;
  }
  return 0;
}

function resolveOpenclawHome(projectDir: string, value: unknown): string {
  const input = typeof value === "string" && value.length > 0 ? value : "~/.openclaw";
  return path.resolve(projectDir, expandHome(input));
}

function defaultWorkspaceDir(roleId: string): string {
  return roleId === "main" ? "workspace" : `workspace-${roleId}`;
}

function defaultAgentDir(roleId: string): string {
  return `agents/${roleId}/agent`;
}

function resolveLane(
  roleId: string,
  roleName: string,
  managerId: string | undefined,
): AgentLane {
  if (managerId == null && roleId === "main") {
    return "command";
  }

  const label = `${roleId} ${roleName}`.toLowerCase();

  if (/(review|qa|test|audit|verify|quality)/.test(label)) {
    return "quality";
  }
  if (/(research|analysis|investigate|discover)/.test(label)) {
    return "research";
  }
  if (/(plan|lead|coord|manage|orchestr|triage)/.test(label)) {
    return "planning";
  }
  if (/(main|build|code|develop|engineer|implement|deliver)/.test(label)) {
    return managerId == null ? "command" : "execution";
  }

  return managerId == null ? "command" : "execution";
}

function parseLane(value: unknown): AgentLane | undefined {
  return value === "command" ||
    value === "planning" ||
    value === "research" ||
    value === "execution" ||
    value === "quality"
    ? value
    : undefined;
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") {
    return homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(homedir(), inputPath.slice(2));
  }

  return inputPath;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return optionalString(value) ?? fallback;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function byAgentId(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}
