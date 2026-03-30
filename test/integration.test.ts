import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { openDatabase } from "../src/db";
import { listenForTasks, type OpenClawInvoker } from "../src/listener";
import { buildSnapshot } from "../src/snapshot";
import { TaskStore } from "../src/task-store";

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "clawtask-integration-"));
  const dbPath = join(root, "tasks.db");
  const db = openDatabase(dbPath);
  const store = new TaskStore(db);

  return {
    root,
    dbPath,
    store,
    cleanup() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("listener completes a task when the invoked agent records terminal status", async () => {
  const fixture = createFixture();
  const previousDbPath = process.env.CLAWTASK_DB;
  process.env.CLAWTASK_DB = fixture.dbPath;

  try {
    const projectDir = join(fixture.root, "project");
    mkdirSync(join(projectDir, ".clawsquad", "runtime"), { recursive: true });
    writeFileSync(
      join(projectDir, ".clawsquad", "runtime", "topology.json"),
      JSON.stringify(
        {
          team: {
            name: "Task Squad",
            projectDir,
          },
          agents: [
            {
              id: "developer",
              name: "developer",
              role: "Developer",
              managerId: "lead",
              lane: "execution",
              summary: "Builds the code",
              workspace: null,
              agentDir: null,
              subagents: [],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const task = fixture.store.createTask({
      createdByAgentId: "lead",
      assignedToAgentId: "developer",
      title: "Build feature",
      body: "Ship the implementation.",
      metadata: {
        workspace: "/tmp/demo",
      },
    });

    let capturedPrompt = "";
    const invoker: OpenClawInvoker = {
      async invoke(currentTask, prompt) {
        capturedPrompt = prompt;
        fixture.store.addEvent("developer", currentTask.id, "progress", {
          message: "started",
        });
        fixture.store.setStatus("developer", currentTask.id, "completed");
        return { ok: true };
      },
    };

    const summary = await listenForTasks(
      fixture.store,
      {
        agentId: "developer",
        once: true,
        projectDir,
      },
      invoker,
    );

    assert.equal(summary.processed, 1);
    assert.equal(summary.results[0]?.finalStatus, "completed");
    assert.match(capturedPrompt, /Codex through ACP/i);
    assert.match(capturedPrompt, /clawtask task/i);
    assert.match(capturedPrompt, /clawtask --project/i);
    assert.match(capturedPrompt, new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    if (previousDbPath == null) {
      delete process.env.CLAWTASK_DB;
    } else {
      process.env.CLAWTASK_DB = previousDbPath;
    }
    fixture.cleanup();
  }
});

test("listener resumes an already claimed task after a restart", async () => {
  const fixture = createFixture();

  try {
    const task = fixture.store.createTask({
      createdByAgentId: "lead",
      assignedToAgentId: "developer",
      title: "Resume after restart",
      body: "Pick back up from an interrupted listener.",
    });
    fixture.store.claimTask("developer", task.id);

    let invokeCount = 0;
    const invoker: OpenClawInvoker = {
      async invoke(currentTask) {
        invokeCount += 1;
        fixture.store.addEvent("developer", currentTask.id, "progress", {
          message: "resumed after listener restart",
        });
        fixture.store.setStatus("developer", currentTask.id, "completed");
        return { ok: true };
      },
    };

    const summary = await listenForTasks(
      fixture.store,
      {
        agentId: "developer",
        once: true,
      },
      invoker,
    );

    const shown = fixture.store.showTask(task.id);
    assert.equal(invokeCount, 1);
    assert.equal(summary.results[0]?.finalStatus, "completed");
    assert.deepEqual(
      shown.events.map((event) => event.kind),
      [
        "task_created",
        "task_claimed",
        "task_resumed",
        "listener_dispatch_started",
        "progress",
        "task_status_changed",
        "listener_dispatch_completed",
      ],
    );
  } finally {
    fixture.cleanup();
  }
});

test("listener resumes the same OpenClaw session after a yielded turn", async () => {
  const fixture = createFixture();

  try {
    const task = fixture.store.createTask({
      createdByAgentId: "lead",
      assignedToAgentId: "developer",
      title: "Yield then complete",
      body: "Finish after a delayed resume.",
    });

    let invokeCount = 0;
    const invoker: OpenClawInvoker = {
      async invoke(currentTask, _prompt, _options, sessionId) {
        invokeCount += 1;
        if (invokeCount === 1) {
          fixture.store.addEvent("developer", currentTask.id, "progress", {
            message: "yielding for child ACP work",
          });
          return {
            result: {
              meta: {
                agentMeta: {
                  sessionId: "session-developer-1",
                },
              },
              payloads: [
                {
                  text: "Waiting on an ACP child before I can close out the task.",
                },
              ],
            },
          };
        }

        assert.equal(sessionId, "session-developer-1");
        fixture.store.addEvent("developer", currentTask.id, "progress", {
          message: "resumed after ACP child completion",
        });
        fixture.store.addEvent("developer", currentTask.id, "progress", {
          message: "verified artifacts and closing out",
        });
        fixture.store.setStatus("developer", currentTask.id, "completed");
        return {
          result: {
            meta: {
              agentMeta: {
                sessionId: "session-developer-1",
              },
            },
          },
        };
      },
    };

    const summary = await listenForTasks(
      fixture.store,
      {
        agentId: "developer",
        once: true,
        pollMs: 10,
        resumeWaitMs: 1000,
      },
      invoker,
    );

    const shown = fixture.store.showTask(task.id);
    assert.equal(invokeCount, 2);
    assert.equal(summary.results[0]?.finalStatus, "completed");
    assert.equal(shown.task.status, "completed");
    assert.deepEqual(
      shown.events.map((event) => event.kind),
      [
        "task_created",
        "task_claimed",
        "listener_dispatch_started",
        "progress",
        "listener_dispatch_completed",
        "listener_terminal_status_missing",
        "listener_resume_dispatch_started",
        "progress",
        "progress",
        "task_status_changed",
        "listener_resume_dispatch_completed",
        "listener_terminal_status_observed",
      ],
    );
  } finally {
    fixture.cleanup();
  }
});

test("listener observes a delayed terminal status without forcing a second turn", async () => {
  const fixture = createFixture();

  try {
    const task = fixture.store.createTask({
      createdByAgentId: "lead",
      assignedToAgentId: "developer",
      title: "Yield then complete",
      body: "Finish after a delayed resume.",
    });

    let invokeCount = 0;
    const invoker: OpenClawInvoker = {
      async invoke(currentTask) {
        invokeCount += 1;
        fixture.store.addEvent("developer", currentTask.id, "progress", {
          message: "yielding for child ACP work",
        });

        setTimeout(() => {
          fixture.store.setStatus("developer", currentTask.id, "completed");
        }, 25);

        return {
          result: {
            payloads: [
              {
                text: "Waiting on a child ACP run before closing out.",
              },
            ],
          },
        };
      },
    };

    const summary = await listenForTasks(
      fixture.store,
      {
        agentId: "developer",
        once: true,
        pollMs: 10,
        resumeWaitMs: 1000,
      },
      invoker,
    );

    const shown = fixture.store.showTask(task.id);
    assert.equal(invokeCount, 1);
    assert.equal(summary.results[0]?.finalStatus, "completed");
    assert.equal(shown.task.status, "completed");
    assert.deepEqual(
      shown.events.map((event) => event.kind),
      [
        "task_created",
        "task_claimed",
        "listener_dispatch_started",
        "progress",
        "listener_dispatch_completed",
        "listener_terminal_status_missing",
        "task_status_changed",
        "listener_terminal_status_observed",
      ],
    );
  } finally {
    fixture.cleanup();
  }
});

test("listener fails a task after the resume wait expires", async () => {
  const fixture = createFixture();

  try {
    const task = fixture.store.createTask({
      createdByAgentId: "lead",
      assignedToAgentId: "developer",
      title: "Incomplete turn",
      body: "Return without finishing.",
    });

    const invoker: OpenClawInvoker = {
      async invoke() {
        return { ok: true };
      },
    };

    const summary = await listenForTasks(
      fixture.store,
      {
        agentId: "developer",
        once: true,
        pollMs: 10,
        resumeWaitMs: 25,
      },
      invoker,
    );

    const shown = fixture.store.showTask(task.id);
    assert.equal(summary.results[0]?.finalStatus, "failed");
    assert.equal(shown.task.status, "failed");
    assert.deepEqual(
      shown.events.map((event) => event.kind),
      [
        "task_created",
        "task_claimed",
        "listener_dispatch_started",
        "listener_dispatch_completed",
        "listener_terminal_status_missing",
        "listener_terminal_status_timeout",
        "task_status_changed",
      ],
    );
  } finally {
    fixture.cleanup();
  }
});

test("snapshot uses clawsquad topology when available", async () => {
  const fixture = createFixture();

  try {
    fixture.store.createTask({
      createdByAgentId: "lead",
      assignedToAgentId: "developer",
      title: "Implement",
      body: "Write the feature.",
    });
    const reviewTask = fixture.store.createTask({
      createdByAgentId: "lead",
      assignedToAgentId: "reviewer",
      title: "Review",
      body: "Check the feature.",
    });
    fixture.store.claimTask("reviewer", reviewTask.id);

    const projectDir = join(fixture.root, "project");
    mkdirSync(join(projectDir, ".clawsquad", "runtime"), { recursive: true });
    writeFileSync(
      join(projectDir, ".clawsquad", "runtime", "topology.json"),
      JSON.stringify(
        {
          team: {
            name: "Task Squad",
            description: "Integrated stack",
            projectDir,
            openclawHome: join(fixture.root, ".openclaw"),
          },
          agents: [
            {
              id: "lead",
              name: "lead",
              role: "Coordinator",
              managerId: null,
              lane: "command",
              summary: "Coordinates the team",
              workspace: join(fixture.root, ".openclaw", "workspace-lead"),
              agentDir: join(fixture.root, ".openclaw", "agents", "lead", "agent"),
              subagents: ["developer", "reviewer"],
            },
            {
              id: "developer",
              name: "developer",
              role: "Developer",
              managerId: "lead",
              lane: "execution",
              summary: "Builds the code",
              workspace: join(fixture.root, ".openclaw", "workspace-developer"),
              agentDir: join(fixture.root, ".openclaw", "agents", "developer", "agent"),
              subagents: [],
            },
            {
              id: "reviewer",
              name: "reviewer",
              role: "Reviewer",
              managerId: "lead",
              lane: "quality",
              summary: "Reviews the changes",
              workspace: join(fixture.root, ".openclaw", "workspace-reviewer"),
              agentDir: join(fixture.root, ".openclaw", "agents", "reviewer", "agent"),
              subagents: [],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const snapshot = await buildSnapshot(fixture.store, { projectDir });

    assert.equal(snapshot.team.name, "Task Squad");
    assert.equal(snapshot.agents.find((agent) => agent.id === "developer")?.managerId, "lead");
    assert.equal(snapshot.agents.find((agent) => agent.id === "reviewer")?.status, "thinking");
    assert.ok(
      snapshot.collaborations.some(
        (edge) => edge.sourceId === "lead" && edge.targetId === "developer",
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test("snapshot marks an idle agent as idle after a later success overrides an older failure", async () => {
  const fixture = createFixture();

  try {
    const failedTask = fixture.store.createTask({
      createdByAgentId: "lead",
      assignedToAgentId: "developer",
      title: "Broken attempt",
      body: "This one fails first.",
    });
    fixture.store.claimTask("developer", failedTask.id);
    fixture.store.setStatus("developer", failedTask.id, "failed");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const recoveredTask = fixture.store.createTask({
      createdByAgentId: "lead",
      assignedToAgentId: "developer",
      title: "Recovered attempt",
      body: "This one succeeds later.",
    });
    fixture.store.claimTask("developer", recoveredTask.id);
    fixture.store.setStatus("developer", recoveredTask.id, "completed");

    const snapshot = await buildSnapshot(fixture.store);
    const developer = snapshot.agents.find((agent) => agent.id === "developer");

    assert.ok(developer);
    assert.equal(developer.status, "idle");
    assert.equal(developer.workload, 0);
    assert.equal(developer.stats.failed, 1);
    assert.equal(developer.stats.completed, 1);
  } finally {
    fixture.cleanup();
  }
});

test("snapshot marks an idle agent as blocked when its latest terminal task failed", async () => {
  const fixture = createFixture();

  try {
    const failedTask = fixture.store.createTask({
      createdByAgentId: "lead",
      assignedToAgentId: "developer",
      title: "Latest failure",
      body: "The most recent task fails.",
    });
    fixture.store.claimTask("developer", failedTask.id);
    fixture.store.setStatus("developer", failedTask.id, "failed");

    const snapshot = await buildSnapshot(fixture.store);
    const developer = snapshot.agents.find((agent) => agent.id === "developer");

    assert.ok(developer);
    assert.equal(developer.status, "blocked");
    assert.equal(developer.workload, 0.08);
  } finally {
    fixture.cleanup();
  }
});

test("CLI create accepts metadata JSON", () => {
  const fixture = createFixture();

  try {
    const cliPath = join("/Users/claw/Documents/clawtask", "src", "cli.ts");
    const createResult = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        cliPath,
        "create",
        "--from",
        "lead",
        "--to",
        "developer",
        "--title",
        "Metadata task",
        "--body",
        "Body",
        "--metadata",
        '{"workspace":"/tmp/demo"}',
      ],
      {
        cwd: "/Users/claw/Documents/clawtask",
        env: {
          ...process.env,
          CLAWTASK_DB: fixture.dbPath,
        },
        encoding: "utf8",
      },
    );

    assert.equal(createResult.status, 0, createResult.stderr);
    const created = JSON.parse(createResult.stdout) as {
      task: { id: string };
    };
    const shown = fixture.store.showTask(created.task.id);

    assert.deepEqual(shown.task.metadata, {
      workspace: "/tmp/demo",
    });
  } finally {
    fixture.cleanup();
  }
});

test("CLI create and list use the squad runtime db when --project is provided", () => {
  const fixture = createFixture();

  try {
    const cliPath = join("/Users/claw/Documents/clawtask", "src", "cli.ts");
    const projectDir = join(fixture.root, "project");
    mkdirSync(projectDir, { recursive: true });

    const createResult = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        cliPath,
        "create",
        "--project",
        projectDir,
        "--from",
        "lead",
        "--to",
        "developer",
        "--title",
        "Project scoped task",
        "--body",
        "Body",
      ],
      {
        cwd: "/Users/claw/Documents/clawtask",
        env: process.env,
        encoding: "utf8",
      },
    );

    assert.equal(createResult.status, 0, createResult.stderr);

    const listResult = spawnSync(
      process.execPath,
      ["--import", "tsx", cliPath, "list", "--project", projectDir],
      {
        cwd: "/Users/claw/Documents/clawtask",
        env: process.env,
        encoding: "utf8",
      },
    );

    assert.equal(listResult.status, 0, listResult.stderr);
    const listed = JSON.parse(listResult.stdout) as {
      tasks: Array<{ title: string }>;
    };

    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0]?.title, "Project scoped task");
    assert.equal(readFileSync(join(projectDir, "runtime-tasks.db")).length > 0, true);
  } finally {
    fixture.cleanup();
  }
});

test("CLI snapshot prints the clawco snapshot shape", () => {
  const fixture = createFixture();

  try {
    fixture.store.createTask({
      createdByAgentId: "lead",
      assignedToAgentId: "developer",
      title: "Build feature",
      body: "Body",
    });

    const cliPath = join("/Users/claw/Documents/clawtask", "src", "cli.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", cliPath, "snapshot"],
      {
        cwd: "/Users/claw/Documents/clawtask",
        env: {
          ...process.env,
          CLAWTASK_DB: fixture.dbPath,
        },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout) as {
      team: { name: string };
      agents: Array<{ id: string }>;
      tasks: Array<{ title: string }>;
    };
    assert.equal(snapshot.team.name, "clawtask");
    assert.ok(snapshot.agents.some((agent) => agent.id === "lead"));
    assert.equal(snapshot.tasks[0]?.title, "Build feature");
  } finally {
    fixture.cleanup();
  }
});
