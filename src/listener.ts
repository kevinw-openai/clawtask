import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { TaskStore } from "./task-store";
import { loadProjectContext, type LoadedProjectContext } from "./snapshot";
import type {
  ListenerOptions,
  ListenerRunResult,
  ListenerSummary,
  TaskRecord,
} from "./types";

const execFileAsync = promisify(execFile);
const DEFAULT_RESUME_WAIT_MS = 30_000;
const DEFAULT_RESUME_POLL_MS = 5_000;
const DEFAULT_OPENCLAW_TIMEOUT_SECONDS = 300;

export interface OpenClawInvoker {
  invoke(
    task: TaskRecord,
    prompt: string,
    options: ListenerOptions,
    sessionId?: string,
  ): Promise<unknown>;
}

export async function listenForTasks(
  store: TaskStore,
  options: ListenerOptions,
  invoker: OpenClawInvoker = createOpenClawInvoker(),
): Promise<ListenerSummary> {
  const project = options.projectDir == null ? undefined : await loadProjectContext(options.projectDir);
  const results: ListenerRunResult[] = [];
  const once = options.once ?? false;
  const pollMs = options.pollMs ?? 5000;
  const resumeWaitMs = options.resumeWaitMs ?? DEFAULT_RESUME_WAIT_MS;

  while (true) {
    const task = store.resumeNext(options.agentId) ?? store.claimNext(options.agentId);
    if (task == null) {
      if (once || reachedTaskLimit(results.length, options.maxTasks)) {
        return {
          agentId: options.agentId,
          idle: results.length === 0,
          processed: results.length,
          results,
        };
      }

      await sleep(pollMs);
      continue;
    }

    results.push(await processTask(store, task, options, invoker, project, resumeWaitMs));
    if (once || reachedTaskLimit(results.length, options.maxTasks)) {
      return {
        agentId: options.agentId,
        idle: false,
        processed: results.length,
        results,
      };
    }
  }
}

function reachedTaskLimit(processed: number, maxTasks: number | undefined): boolean {
  return maxTasks != null && processed >= maxTasks;
}

async function processTask(
  store: TaskStore,
  task: TaskRecord,
  options: ListenerOptions,
  invoker: OpenClawInvoker,
  project: LoadedProjectContext | undefined,
  resumeWaitMs: number,
): Promise<ListenerRunResult> {
  const prompt = buildAgentPrompt(task, options, project);

  store.addEvent(options.agentId, task.id, "listener_dispatch_started", {
    mode: "openclaw-agent",
    projectDir: options.projectDir ?? null,
  });

  try {
    const output = await invoker.invoke(task, prompt, options);
    store.addEvent(options.agentId, task.id, "listener_dispatch_completed", {
      output,
    });

    const finalTask = store.showTask(task.id).task;
    if (isTerminalStatus(finalTask.status)) {
      return {
        taskId: task.id,
        finalStatus: finalTask.status,
        openclawOutput: output,
      };
    }

    store.addEvent(options.agentId, task.id, "listener_terminal_status_missing", {
      message:
        "OpenClaw turn returned without the assignee recording a terminal clawtask status; attempting session continuation.",
    });

    const resumed = await resumeUntilTerminalStatus(
      store,
      task,
      options,
      invoker,
      project,
      extractSessionId(output),
      resumeWaitMs,
    );

    if (resumed != null && isTerminalStatus(resumed.task.status)) {
      store.addEvent(options.agentId, task.id, "listener_terminal_status_observed", {
        status: resumed.task.status,
      });

      return {
        taskId: task.id,
        finalStatus: resumed.task.status,
        openclawOutput: resumed.output,
        note:
          resumed.task.status === "completed"
            ? "Task completed after the agent continued the yielded session."
            : "Task reached a terminal status after the agent continued the yielded session.",
      };
    }

    store.addEvent(options.agentId, task.id, "listener_terminal_status_timeout", {
      message:
        "OpenClaw turn ended without a terminal clawtask status before the listener resume wait expired.",
      resumeWaitMs,
    });
    const failedTask = store.setStatus(options.agentId, task.id, "failed");

    return {
      taskId: task.id,
      finalStatus: failedTask.status,
      openclawOutput: output,
      note: "Task failed because the agent turn ended without a terminal status update.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.addEvent(options.agentId, task.id, "listener_dispatch_failed", {
      message,
    });
    const currentTask = store.showTask(task.id).task;
    const finalTask =
      isTerminalStatus(currentTask.status) ? currentTask : store.setStatus(options.agentId, task.id, "failed");

    return {
      taskId: task.id,
      finalStatus: finalTask.status,
      note: message,
    };
  }
}

async function resumeUntilTerminalStatus(
  store: TaskStore,
  task: TaskRecord,
  options: ListenerOptions,
  invoker: OpenClawInvoker,
  project: LoadedProjectContext | undefined,
  initialSessionId: string | undefined,
  resumeWaitMs: number,
): Promise<{ task: TaskRecord; output: unknown } | null> {
  if (resumeWaitMs <= 0) {
    return null;
  }

  const deadline = Date.now() + resumeWaitMs;
  const intervalMs = Math.max(250, Math.min(options.pollMs ?? DEFAULT_RESUME_POLL_MS, 2_000));
  let attempt = 0;
  let sessionId = initialSessionId;
  let lastOutput: unknown = {
    note: "OpenClaw turn ended without a terminal clawtask status.",
  };

  while (Date.now() <= deadline) {
    const currentTask = store.showTask(task.id).task;
    if (isTerminalStatus(currentTask.status)) {
      return {
        task: currentTask,
        output: lastOutput,
      };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await sleep(Math.min(intervalMs, remainingMs));
    const afterSleep = store.showTask(task.id).task;
    if (isTerminalStatus(afterSleep.status)) {
      return {
        task: afterSleep,
        output: lastOutput,
      };
    }
    if (Date.now() >= deadline) {
      break;
    }

    attempt += 1;
    const prompt = buildResumePrompt(task, options, project, attempt);
    store.addEvent(options.agentId, task.id, "listener_resume_dispatch_started", {
      attempt,
      sessionId: sessionId ?? null,
    });

    try {
      lastOutput = await invoker.invoke(task, prompt, options, sessionId);
      store.addEvent(options.agentId, task.id, "listener_resume_dispatch_completed", {
        attempt,
        output: lastOutput,
      });
      sessionId = extractSessionId(lastOutput) ?? sessionId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.addEvent(options.agentId, task.id, "listener_resume_dispatch_failed", {
        attempt,
        message,
      });
    }
  }

  return null;
}

function buildResumePrompt(
  task: TaskRecord,
  options: ListenerOptions,
  project: LoadedProjectContext | undefined,
  attempt: number,
): string {
  const projectSummary = project == null
    ? ""
    : [
        `Team: ${project.team.name}`,
        project.team.description ? `Team description: ${project.team.description}` : undefined,
        options.projectDir != null ? `Project directory: ${options.projectDir}` : undefined,
        buildAgentContextLine(project, task.assignedToAgentId),
      ]
        .filter((line): line is string => line != null && line.length > 0)
        .join("\n");

  const clawtaskCommand = buildPromptClawtaskCommand(options.clawtaskCommand ?? "clawtask");

  return [
    `Continue clawtask task ${task.id} in the same OpenClaw session.`,
    "",
    `Task title: ${task.title}`,
    `Task body: ${task.body}`,
    "",
    projectSummary,
    projectSummary.length > 0 ? "" : undefined,
    `This is continuation attempt ${attempt} after a yielded or incomplete turn.`,
    "- Continue from the existing session context instead of restarting from scratch.",
    "- If you previously launched Codex through ACP or another async worker, check whether that work already finished and reuse its artifacts.",
    "- If direct child-session inspection is blocked, inspect the project filesystem and requested outputs instead.",
    "- If ACP / Codex is doing the implementation work, ensure it also runs the required clawtask progress and terminal-status commands before it stops.",
    `- Record progress with: ${clawtaskCommand} event --agent ${task.assignedToAgentId} --task ${task.id} --kind progress --data '{"message":"..."}'`,
    `- Mark completion with: ${clawtaskCommand} status --agent ${task.assignedToAgentId} --task ${task.id} --set completed`,
    `- Or fail with: ${clawtaskCommand} status --agent ${task.assignedToAgentId} --task ${task.id} --set failed`,
    "- Do not end this turn without recording a terminal clawtask status unless the session must yield again for genuinely unfinished async work.",
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}

function buildAgentPrompt(
  task: TaskRecord,
  options: ListenerOptions,
  project: LoadedProjectContext | undefined,
): string {
  const projectSummary = project == null
    ? ""
    : [
        `Team: ${project.team.name}`,
        project.team.description ? `Team description: ${project.team.description}` : undefined,
        options.projectDir != null ? `Project directory: ${options.projectDir}` : undefined,
        buildAgentContextLine(project, task.assignedToAgentId),
      ]
        .filter((line): line is string => line != null && line.length > 0)
        .join("\n");

  const clawtaskCommand = buildPromptClawtaskCommand(
    options.clawtaskCommand ?? "clawtask",
    options.projectDir,
  );
  const metadataText =
    Object.keys(task.metadata).length === 0 ? "{}" : JSON.stringify(task.metadata, null, 2);

  return [
    `You are working clawtask task ${task.id}.`,
    "",
    "Task details:",
    `- Title: ${task.title}`,
    `- Created by: ${task.createdByAgentId}`,
    `- Assigned to: ${task.assignedToAgentId}`,
    `- Body: ${task.body}`,
    "",
    "Task metadata:",
    metadataText,
    "",
    projectSummary,
    projectSummary.length > 0 ? "" : undefined,
    "Execution requirements:",
    "- Treat this clawtask entry as the source of truth for scope.",
    "- When coding is required, use Codex through ACP.",
    "- If ACP / Codex will do the file work, include the exact clawtask progress and terminal-status commands below in that ACP request so Codex records them before it finishes.",
    "- Do not assume the parent turn will regain control after ACP in time to close the task for you.",
    options.projectDir == null
      ? undefined
      : `- Use the shared squad runtime DB by keeping --project ${shellQuote(options.projectDir)} on every clawtask command.`,
    `- Log progress with: ${clawtaskCommand} event --agent ${task.assignedToAgentId} --task ${task.id} --kind progress --data '{\"message\":\"...\"}'`,
    `- Finish with one of: ${clawtaskCommand} status --agent ${task.assignedToAgentId} --task ${task.id} --set completed`,
    `  or ${clawtaskCommand} status --agent ${task.assignedToAgentId} --task ${task.id} --set failed`,
    "- If you cannot complete the work, record why and fail the task instead of leaving it hanging.",
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}

function buildPromptClawtaskCommand(baseCommand: string, projectDir?: string): string {
  if (projectDir != null && projectDir.length > 0) {
    return `${baseCommand} --project ${shellQuote(projectDir)}`;
  }

  const dbPath = process.env.CLAWTASK_DB;
  if (dbPath == null || dbPath.length === 0) {
    return baseCommand;
  }

  return `CLAWTASK_DB=${shellQuote(dbPath)} ${baseCommand}`;
}

function buildAgentContextLine(project: LoadedProjectContext, agentId: string): string | undefined {
  const agent = project.agents.find((entry) => entry.id === agentId);
  if (agent == null) {
    return undefined;
  }

  return `Agent context: ${agent.name} (${agent.role}) in lane ${agent.lane}. ${agent.summary}`;
}

function createOpenClawInvoker(): OpenClawInvoker {
  return {
    async invoke(
      task: TaskRecord,
      prompt: string,
      options: ListenerOptions,
      sessionId?: string,
    ): Promise<unknown> {
      const command = process.env.CLAWTASK_OPENCLAW_BIN ?? "openclaw";
      const args = ["agent", "--agent", task.assignedToAgentId, "--message", prompt, "--json"];

      if (sessionId != null && sessionId.length > 0) {
        args.push("--session-id", sessionId);
      }
      if (options.thinking != null) {
        args.push("--thinking", options.thinking);
      }
      args.push("--timeout", String(options.timeoutSeconds ?? DEFAULT_OPENCLAW_TIMEOUT_SECONDS));

      try {
        const { stdout } = await execFileAsync(command, args, {
          cwd: options.projectDir,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        });
        return parseOpenClawOutput(stdout);
      } catch (error) {
        if (isExecFileError(error)) {
          const stdout = typeof error.stdout === "string" ? error.stdout : "";
          const stderr = typeof error.stderr === "string" ? error.stderr : "";
          throw new Error(
            [
              `openclaw agent exited with code ${error.code ?? "unknown"}`,
              stdout.length > 0 ? `stdout: ${stdout.trim()}` : undefined,
              stderr.length > 0 ? `stderr: ${stderr.trim()}` : undefined,
            ]
              .filter((line): line is string => line != null)
              .join("\n"),
          );
        }

        throw error;
      }
    },
  };
}

function parseOpenClawOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { raw: "" };
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
}

function extractSessionId(output: unknown): string | undefined {
  if (output == null || typeof output !== "object") {
    return undefined;
  }

  const record = output as Record<string, unknown>;
  const topLevel = record.sessionId;
  if (typeof topLevel === "string" && topLevel.length > 0) {
    return topLevel;
  }

  const result = record.result;
  if (result != null && typeof result === "object") {
    const meta = (result as Record<string, unknown>).meta;
    if (meta != null && typeof meta === "object") {
      const agentMeta = (meta as Record<string, unknown>).agentMeta;
      if (agentMeta != null && typeof agentMeta === "object") {
        const sessionId = (agentMeta as Record<string, unknown>).sessionId;
        if (typeof sessionId === "string" && sessionId.length > 0) {
          return sessionId;
        }
      }

      const systemPromptReport = (meta as Record<string, unknown>).systemPromptReport;
      if (systemPromptReport != null && typeof systemPromptReport === "object") {
        const sessionId = (systemPromptReport as Record<string, unknown>).sessionId;
        if (typeof sessionId === "string" && sessionId.length > 0) {
          return sessionId;
        }
      }
    }
  }

  return undefined;
}

function isTerminalStatus(status: TaskRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function isExecFileError(
  value: unknown,
): value is Error & { code?: number | string; stdout?: string; stderr?: string } {
  return value instanceof Error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
