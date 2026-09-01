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
    const userMessage = first.appendMessage({
      sessionId: "session-1",
      role: "user",
      mode: "chat",
      content: "请检查 U1 的供电。",
    });
    const assistantMessage = first.appendMessage({
      sessionId: "session-1",
      role: "assistant",
      mode: "chat",
      content: "需要继续检查电源网络。",
      model: "test-model",
    });
    const task: PersistedTask = {
      taskId: "task-1",
      sessionId: "session-1",
      parentTaskId: "task-0",
      attempt: 2,
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
    first.saveTask(task, {
      setCurrent: true,
      messageIds: [userMessage.id, assistantMessage.id],
    });
    first.appendAuditEvent({ sessionId: "session-1", taskId: "task-1", eventType: "task.created" });
    first.setSkillEnabled("eda-core", false);
    first.setMcpServerEnabled("fixture", true);
    first.upsertCodexThread({
      sessionId: "session-1",
      providerId: "openrouter",
      threadId: "thread-1",
      model: "test-model",
      toolSignature: "tools-v1",
    });
    first.close();

    const reopened = new AgentStore(databasePath);
    assert.equal(reopened.getSession("session-1")?.projectName, "Demo");
    assert.deepEqual(reopened.listMessages("session-1").map((message) => message.content), [
      "请检查 U1 的供电。",
      "需要继续检查电源网络。",
    ]);
    assert.equal(reopened.getTask("task-1")?.confirmationToken, "confirm-1");
    assert.equal(reopened.getTask("task-1")?.skills?.[0]?.id, "eda-core");
    assert.equal(reopened.getTask("task-1")?.parentTaskId, "task-0");
    assert.equal(reopened.getTask("task-1")?.attempt, 2);
    assert.equal(reopened.getSession("session-1")?.currentTaskId, "task-1");
    assert.deepEqual(reopened.listMessages("session-1").map((message) => message.taskId), ["task-1", "task-1"]);
    assert.equal(reopened.listSkillStates().get("eda-core"), false);
    assert.equal(reopened.listMcpServerStates().get("fixture"), true);
    assert.deepEqual(reopened.getCodexThread("session-1", "openrouter"), {
      sessionId: "session-1",
      providerId: "openrouter",
      threadId: "thread-1",
      model: "test-model",
      toolSignature: "tools-v1",
      createdAt: reopened.getCodexThread("session-1", "openrouter")?.createdAt,
      updatedAt: reopened.getCodexThread("session-1", "openrouter")?.updatedAt,
    });
    reopened.deleteMcpServerState("fixture");
    assert.equal(reopened.listMcpServerStates().has("fixture"), false);
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

test("persisted summaries do not carry stale assistant tool-availability claims forward", () => {
  const store = new AgentStore(":memory:");
  try {
    store.ensureSession("safe-summary");
    for (let index = 1; index <= 6; index += 1) {
      store.appendMessage({
        sessionId: "safe-summary",
        role: index === 2 ? "assistant" : "user",
        mode: "chat",
        content: index === 2 ? "本回合不可调用工具，只能下一轮继续。" : `message-${index}`,
      });
    }
    const summary = store.refreshSessionSummary("safe-summary", 4, 1_000);
    assert.doesNotMatch(summary, /本回合不可调用工具/);
    assert.match(summary, /过期工具状态已忽略/);
  } finally {
    store.close();
  }
});

test("clearing a conversation detaches the current task but preserves task history", () => {
  const store = new AgentStore(":memory:");
  try {
    store.ensureSession("clear-session");
    const message = store.appendMessage({
      sessionId: "clear-session",
      role: "user",
      mode: "chat",
      content: "重试",
    });
    store.saveTask({
      taskId: "failed-task",
      sessionId: "clear-session",
      instruction: "移动 U1",
      status: "failed",
      model: "test-model",
      message: "执行失败",
      context: {},
      toolTrace: [],
      changeSet: {
        id: "failed-changeset",
        projectId: "project-1",
        summary: "移动 U1",
        operations: [],
        requiresConfirmation: true,
        createdAt: "2026-08-25T00:00:00.000Z",
        createdBy: "agent",
      },
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    }, { setCurrent: true, messageIds: [message.id] });
    store.upsertCodexThread({
      sessionId: "clear-session",
      providerId: "openrouter",
      threadId: "thread-clear",
      model: "test-model",
      toolSignature: "tools-v1",
    });

    store.clearConversation("clear-session");

    assert.equal(store.getSession("clear-session")?.currentTaskId, undefined);
    assert.deepEqual(store.listMessages("clear-session"), []);
    assert.equal(store.getTask("failed-task")?.status, "failed");
    assert.equal(store.getCodexThread("clear-session", "openrouter"), undefined);
  } finally {
    store.close();
  }
});

test("version 1 task databases are upgraded with task lineage, skill, MCP and knowledge persistence", () => {
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
    const sessionColumns = inspector.prepare("PRAGMA table_info(sessions)").all();
    const schemaVersion = Number((inspector.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    const knowledgeTable = inspector.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_sources'
    `).get();
    const codexThreadsTable = inspector.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_threads'
    `).get();
    inspector.close();
    assert.equal(columns.some((column) => column.name === "skills_json"), true);
    assert.equal(columns.some((column) => column.name === "parent_task_id"), true);
    assert.equal(columns.some((column) => column.name === "attempt"), true);
    assert.equal(sessionColumns.some((column) => column.name === "current_task_id"), true);
    assert.equal(schemaVersion, 6);
    assert.ok(knowledgeTable);
    assert.ok(codexThreadsTable);
    upgraded.setSkillEnabled("eda-core", true);
    assert.equal(upgraded.listSkillStates().get("eda-core"), true);
    upgraded.setMcpServerEnabled("fixture", true);
    assert.equal(upgraded.listMcpServerStates().get("fixture"), true);
    upgraded.close();
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
