import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore, type PersistedTask } from "./storage.ts";

test("SQLite store restores sessions, messages, tasks and audit events after reopen", () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "jlcircuit-agent-store-"));
  const databasePath = join(tempDirectory, "state.sqlite");
  try {
    const first = new AgentStore(databasePath);
    first.ensureSession("session-1", { projectId: "project-1", projectName: "Demo" });
    first.appendMessage({
      sessionId: "session-1",
      role: "user",
      mode: "chat",
      content: "请检查 U1 的供电。",
    });
    first.appendMessage({
      sessionId: "session-1",
      role: "assistant",
      mode: "chat",
      content: "需要继续检查电源网络。",
      model: "test-model",
    });
    const task: PersistedTask = {
      taskId: "task-1",
      sessionId: "session-1",
      instruction: "移动 R1",
      status: "waiting_confirmation",
      model: "test-model",
      message: "等待确认",
      context: { project: { id: "project-1" } },
      toolTrace: [],
      changeSet: {
        id: "changeset-1",
        projectId: "project-1",
        summary: "移动 R1",
        operations: [],
        requiresConfirmation: true,
        createdAt: "2026-08-25T00:00:00.000Z",
        createdBy: "agent",
      },
      confirmationToken: "confirm-1",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    };
    first.saveTask(task);
    first.appendAuditEvent({ sessionId: "session-1", taskId: "task-1", eventType: "task.created" });
    first.close();

    const reopened = new AgentStore(databasePath);
    assert.equal(reopened.getSession("session-1")?.projectName, "Demo");
    assert.deepEqual(reopened.listMessages("session-1").map((message) => message.content), [
      "请检查 U1 的供电。",
      "需要继续检查电源网络。",
    ]);
    assert.equal(reopened.getTask("task-1")?.confirmationToken, "confirm-1");
    assert.equal(reopened.countAuditEvents("session-1"), 1);
    reopened.close();
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test("older messages are rolled into the persisted session summary", () => {
  const store = new AgentStore(":memory:");
  try {
    store.ensureSession("summary-session");
    for (let index = 1; index <= 8; index += 1) {
      store.appendMessage({
        sessionId: "summary-session",
        role: index % 2 === 0 ? "assistant" : "user",
        mode: "chat",
        content: `message-${index}`,
      });
    }
    const summary = store.refreshSessionSummary("summary-session", 4, 1_000);
    assert.match(summary, /message-1/);
    assert.match(summary, /message-4/);
    assert.doesNotMatch(summary, /message-8/);
    assert.ok((store.getSession("summary-session")?.summaryThroughSequence ?? 0) > 0);
  } finally {
    store.close();
  }
});
