import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
      skills: [{ id: "eda-core", name: "EDA 核心分析", version: "1.0.0", reason: "always" }],
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    };
    first.saveTask(task);
    first.appendAuditEvent({ sessionId: "session-1", taskId: "task-1", eventType: "task.created" });
    first.setSkillEnabled("eda-core", false);
    first.close();

    const reopened = new AgentStore(databasePath);
    assert.equal(reopened.getSession("session-1")?.projectName, "Demo");
    assert.deepEqual(reopened.listMessages("session-1").map((message) => message.content), [
      "请检查 U1 的供电。",
      "需要继续检查电源网络。",
    ]);
    assert.equal(reopened.getTask("task-1")?.confirmationToken, "confirm-1");
    assert.equal(reopened.getTask("task-1")?.skills?.[0]?.id, "eda-core");
    assert.equal(reopened.listSkillStates().get("eda-core"), false);
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

test("version 1 task databases are upgraded with skill persistence", () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "jlcircuit-agent-migration-"));
  const databasePath = join(tempDirectory, "state.sqlite");
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, instruction TEXT NOT NULL,
        status TEXT NOT NULL, model TEXT NOT NULL, message TEXT NOT NULL,
        context_json TEXT NOT NULL, tool_trace_json TEXT NOT NULL, change_set_json TEXT NOT NULL,
        confirmation_token TEXT, execution_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();
    const upgraded = new AgentStore(databasePath);
    const inspector = new DatabaseSync(databasePath);
    const columns = inspector.prepare("PRAGMA table_info(tasks)").all();
    inspector.close();
    assert.equal(columns.some((column) => column.name === "skills_json"), true);
    upgraded.setSkillEnabled("eda-core", true);
    assert.equal(upgraded.listSkillStates().get("eda-core"), true);
    upgraded.close();
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
