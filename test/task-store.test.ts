import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { openDatabase } from "../src/db";
import { TaskStore, TaskStoreError } from "../src/task-store";

function createStorePair() {
  const root = mkdtempSync(join(tmpdir(), "clawtask-"));
  const dbPath = join(root, "tasks.db");
  const dbA = openDatabase(dbPath);
  const dbB = openDatabase(dbPath);
  const storeA = new TaskStore(dbA);
  const storeB = new TaskStore(dbB);

  return {
    root,
    dbPath,
    storeA,
    storeB,
    cleanup() {
      storeA.close();
      storeB.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("create task preserves creator, assignee, and initial event", () => {
  const fixture = createStorePair();

  try {
    const task = fixture.storeA.createTask({
      createdByAgentId: "agent-a",
      assignedToAgentId: "agent-b",
      title: "Review patch",
      body: "Check the OAuth change.",
    });

    assert.equal(task.createdByAgentId, "agent-a");
    assert.equal(task.assignedToAgentId, "agent-b");
    assert.equal(task.status, "queued");

    const shown = fixture.storeB.showTask(task.id);
    assert.equal(shown.events.length, 1);
    assert.equal(shown.events[0]?.kind, "task_created");
  } finally {
    fixture.cleanup();
  }
});

test("explicit claim only allows the assignee", () => {
  const fixture = createStorePair();

  try {
    const task = fixture.storeA.createTask({
      createdByAgentId: "agent-a",
      assignedToAgentId: "agent-b",
      title: "Claim me",
      body: "Task body",
    });

    assert.throws(
      () => fixture.storeA.claimTask("agent-a", task.id),
      (error: unknown) =>
        error instanceof TaskStoreError && error.code === "UNAUTHORIZED",
    );

    const claimed = fixture.storeB.claimTask("agent-b", task.id);
    assert.equal(claimed.status, "in_progress");
    assert.equal(claimed.claimedAt !== null, true);
  } finally {
    fixture.cleanup();
  }
});

test("claim next selects the oldest queued task for the assignee", () => {
  const fixture = createStorePair();

  try {
    const first = fixture.storeA.createTask({
      createdByAgentId: "agent-a",
      assignedToAgentId: "agent-b",
      title: "First",
      body: "One",
    });
    const second = fixture.storeA.createTask({
      createdByAgentId: "agent-a",
      assignedToAgentId: "agent-b",
      title: "Second",
      body: "Two",
    });

    const claimed = fixture.storeB.claimNext("agent-b");
    assert.equal(claimed?.id, first.id);

    const next = fixture.storeB.claimNext("agent-b");
    assert.equal(next?.id, second.id);
  } finally {
    fixture.cleanup();
  }
});

test("resume next returns the oldest in-progress task for the assignee", () => {
  const fixture = createStorePair();

  try {
    const first = fixture.storeA.createTask({
      createdByAgentId: "agent-a",
      assignedToAgentId: "agent-b",
      title: "First",
      body: "One",
    });
    const second = fixture.storeA.createTask({
      createdByAgentId: "agent-a",
      assignedToAgentId: "agent-b",
      title: "Second",
      body: "Two",
    });

    fixture.storeA.claimTask("agent-b", first.id);
    fixture.storeA.claimTask("agent-b", second.id);

    const resumed = fixture.storeB.resumeNext("agent-b");
    assert.equal(resumed?.id, first.id);

    const shown = fixture.storeA.showTask(first.id);
    assert.equal(shown.events.at(-1)?.kind, "task_resumed");
  } finally {
    fixture.cleanup();
  }
});

test("cancel queued task transitions directly to canceled", () => {
  const fixture = createStorePair();

  try {
    const task = fixture.storeA.createTask({
      createdByAgentId: "agent-a",
      assignedToAgentId: "agent-b",
      title: "Cancel me",
      body: "Queue cancel",
    });

    const canceled = fixture.storeA.cancelTask("agent-a", task.id);
    assert.equal(canceled.status, "canceled");
    assert.equal(canceled.finishedAt !== null, true);
  } finally {
    fixture.cleanup();
  }
});

test("cancel in-progress task sets cancelRequestedAt and keeps status in_progress", () => {
  const fixture = createStorePair();

  try {
    const task = fixture.storeA.createTask({
      createdByAgentId: "agent-a",
      assignedToAgentId: "agent-b",
      title: "Run then stop",
      body: "Cancel later",
    });

    fixture.storeB.claimTask("agent-b", task.id);
    const canceled = fixture.storeA.cancelTask("agent-a", task.id);

    assert.equal(canceled.status, "in_progress");
    assert.equal(canceled.cancelRequestedAt !== null, true);
  } finally {
    fixture.cleanup();
  }
});

test("status updates are limited to the assignee", () => {
  const fixture = createStorePair();

  try {
    const task = fixture.storeA.createTask({
      createdByAgentId: "agent-a",
      assignedToAgentId: "agent-b",
      title: "Update status",
      body: "Body",
    });

    fixture.storeB.claimTask("agent-b", task.id);

    assert.throws(
      () => fixture.storeA.setStatus("agent-a", task.id, "completed"),
      (error: unknown) =>
        error instanceof TaskStoreError && error.code === "UNAUTHORIZED",
    );

    const completed = fixture.storeB.setStatus("agent-b", task.id, "completed");
    assert.equal(completed.status, "completed");
    assert.equal(completed.finishedAt !== null, true);
  } finally {
    fixture.cleanup();
  }
});

test("subtasks preserve parent linkage", () => {
  const fixture = createStorePair();

  try {
    const parent = fixture.storeA.createTask({
      createdByAgentId: "agent-a",
      assignedToAgentId: "agent-b",
      title: "Parent",
      body: "Parent body",
    });

    const child = fixture.storeB.createSubtask({
      parentTaskId: parent.id,
      createdByAgentId: "agent-b",
      assignedToAgentId: "agent-c",
      title: "Child",
      body: "Child body",
    });

    assert.equal(child.parentTaskId, parent.id);
  } finally {
    fixture.cleanup();
  }
});

test("show returns ordered events and immediate child task ids", () => {
  const fixture = createStorePair();

  try {
    const parent = fixture.storeA.createTask({
      createdByAgentId: "agent-a",
      assignedToAgentId: "agent-b",
      title: "Parent",
      body: "Parent body",
    });
    fixture.storeB.claimTask("agent-b", parent.id);
    fixture.storeB.addEvent("agent-b", parent.id, "progress", { percent: 50 });
    const child = fixture.storeB.createSubtask({
      parentTaskId: parent.id,
      createdByAgentId: "agent-b",
      assignedToAgentId: "agent-c",
      title: "Child",
      body: "Child body",
    });

    const shown = fixture.storeA.showTask(parent.id);

    assert.deepEqual(
      shown.events.map((event) => event.kind),
      ["task_created", "task_claimed", "progress"],
    );
    assert.deepEqual(shown.childTaskIds, [child.id]);
  } finally {
    fixture.cleanup();
  }
});

test("two database connections only allow one claimNext winner", () => {
  const fixture = createStorePair();

  try {
    fixture.storeA.createTask({
      createdByAgentId: "agent-a",
      assignedToAgentId: "agent-b",
      title: "Only once",
      body: "Body",
    });

    const firstClaim = fixture.storeA.claimNext("agent-b");
    const secondClaim = fixture.storeB.claimNext("agent-b");

    assert.ok(firstClaim);
    assert.equal(secondClaim, null);
  } finally {
    fixture.cleanup();
  }
});
