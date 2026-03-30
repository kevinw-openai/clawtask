#!/usr/bin/env node

import type { ErrorPayload, TaskStatus } from "./types";
import { TASK_STATUSES } from "./types";
import { openDatabase } from "./db";
import { TaskStore, TaskStoreError } from "./task-store";

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function main(): number {
  const parsed = parseArgs(process.argv.slice(2));
  const db = openDatabase();
  const store = new TaskStore(db);

  try {
    if (parsed.positionals.length === 0 || parsed.positionals[0] === "help") {
      throw new CliUsageError(
        "USAGE_ERROR",
        "Missing command. Use create, list, show, claim, status, cancel, event, or subtask create.",
      );
    }

    const command = parsed.positionals[0];
    let result: unknown;

    switch (command) {
      case "create":
        result = {
          ok: true,
          task: store.createTask({
            createdByAgentId: requiredString(parsed.flags, "from"),
            assignedToAgentId: requiredString(parsed.flags, "to"),
            title: requiredString(parsed.flags, "title"),
            body: requiredString(parsed.flags, "body"),
          }),
        };
        break;
      case "list":
        result = {
          ok: true,
          tasks: store.listTasks({
            assignedToAgentId: optionalString(parsed.flags, "assigned-to"),
            createdByAgentId: optionalString(parsed.flags, "created-by"),
            status: optionalStatus(parsed.flags, "status"),
          }),
        };
        break;
      case "show":
        result = {
          ok: true,
          ...store.showTask(requiredString(parsed.flags, "task")),
        };
        break;
      case "claim":
        result = {
          ok: true,
          task: handleClaim(store, parsed),
        };
        break;
      case "status":
        result = {
          ok: true,
          task: store.setStatus(
            requiredString(parsed.flags, "agent"),
            requiredString(parsed.flags, "task"),
            requiredStatus(parsed.flags, "set"),
          ),
        };
        break;
      case "cancel":
        result = {
          ok: true,
          task: store.cancelTask(
            requiredString(parsed.flags, "agent"),
            requiredString(parsed.flags, "task"),
          ),
        };
        break;
      case "event":
        result = {
          ok: true,
          event: store.addEvent(
            requiredString(parsed.flags, "agent"),
            requiredString(parsed.flags, "task"),
            requiredString(parsed.flags, "kind"),
            parseJsonFlag(parsed.flags, "data"),
          ),
        };
        break;
      case "subtask":
        result = {
          ok: true,
          task: handleSubtask(store, parsed),
        };
        break;
      default:
        throw new CliUsageError("USAGE_ERROR", `Unknown command: ${command}`);
    }

    writeJson(result);
    return 0;
  } catch (error) {
    writeJson({
      ok: false,
      error: toErrorPayload(error),
    });
    return 1;
  } finally {
    store.close();
  }
}

function handleClaim(store: TaskStore, parsed: ParsedArgs): unknown {
  const agentId = requiredString(parsed.flags, "agent");
  const taskId = optionalString(parsed.flags, "task");
  const useNext = parsed.flags.get("next") === true;

  if ((taskId ? 1 : 0) + (useNext ? 1 : 0) !== 1) {
    throw new CliUsageError(
      "USAGE_ERROR",
      "claim requires exactly one of --task <id> or --next",
    );
  }

  if (taskId) {
    return store.claimTask(agentId, taskId);
  }

  return store.claimNext(agentId);
}

function handleSubtask(store: TaskStore, parsed: ParsedArgs): unknown {
  if (parsed.positionals[1] !== "create") {
    throw new CliUsageError(
      "USAGE_ERROR",
      "subtask currently only supports: subtask create",
    );
  }

  return store.createSubtask({
    parentTaskId: requiredString(parsed.flags, "parent"),
    createdByAgentId: requiredString(parsed.flags, "from"),
    assignedToAgentId: requiredString(parsed.flags, "to"),
    title: requiredString(parsed.flags, "title"),
    body: requiredString(parsed.flags, "body"),
  });
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, true);
      continue;
    }

    flags.set(key, next);
    index += 1;
  }

  return { positionals, flags };
}

function requiredString(flags: Map<string, string | boolean>, key: string): string {
  const value = flags.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new CliUsageError("USAGE_ERROR", `Missing required flag --${key}`);
  }
  return value;
}

function optionalString(flags: Map<string, string | boolean>, key: string): string | undefined {
  const value = flags.get(key);
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

function requiredStatus(flags: Map<string, string | boolean>, key: string): TaskStatus {
  const value = requiredString(flags, key);
  return parseStatus(value);
}

function optionalStatus(
  flags: Map<string, string | boolean>,
  key: string,
): TaskStatus | undefined {
  const value = optionalString(flags, key);
  return value ? parseStatus(value) : undefined;
}

function parseStatus(value: string): TaskStatus {
  if (!TASK_STATUSES.includes(value as TaskStatus)) {
    throw new CliUsageError("INVALID_STATUS", `Unknown task status: ${value}`);
  }
  return value as TaskStatus;
}

function parseJsonFlag(flags: Map<string, string | boolean>, key: string): unknown {
  const value = optionalString(flags, key);
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    throw new CliUsageError("INVALID_JSON", `Failed to parse --${key}: ${message}`);
  }
}

function writeJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof CliUsageError || error instanceof TaskStoreError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: error.message,
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "Unknown error",
  };
}

class CliUsageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CliUsageError";
    this.code = code;
  }
}

process.exitCode = main();
