import assert from "node:assert/strict";
import test from "node:test";
import { ContextEngine } from "./context-engine.ts";
import { AgentStore } from "./storage.ts";

test("Context Engine combines prior dialogue, active tasks and the latest EDA snapshot", async () => {
  const store = new AgentStore(":memory:");
  try {
    const engine = new ContextEngine(store);
    store.ensureSession("context-session");
    store.appendMessage({
      sessionId: "context-session",
      role: "user",
      mode: "chat",
      content: "先检查 U1。",
    });
    store.appendMessage({
      sessionId: "context-session",
      role: "assistant",
      mode: "chat",
      content: "U1 需要检查 3V3 网络。",
    });
    store.saveTask({
      taskId: "active-task",
      sessionId: "context-session",
      instruction: "检查 U1",
      status: "awaiting_user",
      model: "test-model",
      message: "请补充 U1 的具体型号。",
      context: {},
      toolTrace: [],
      changeSet: {
        id: "changeset",
        summary: "等待补充",
        operations: [],
        requiresConfirmation: false,
        createdAt: "2026-08-25T00:00:00.000Z",
        createdBy: "agent",
      },
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    const current = engine.beginTurn("context-session", "型号是 STM32G0。", "chat");
    const prepared = await engine.prepareTurn({
      sessionId: "context-session",
      beforeSequence: current.sequence,
      readDesignContext: async () => ({
        requestId: "context-request",
        ok: true,
        data: {
          project: { id: "project-1", name: "Demo" },
          activeDocument: { id: "sheet-1", type: "schematic-page" },
          selected: [],
          summary: { components: [{ reference: "U1" }], wires: [] },
          drc: [],
          capturedAt: "2026-08-25T00:00:00.000Z",
          source: "jlcircuit-eda",
        },
      }),
    });

    assert.deepEqual(prepared.recentMessages.map((message) => message.content), [
      "先检查 U1。",
      "U1 需要检查 3V3 网络。",
    ]);
    assert.doesNotMatch(prepared.recentMessages.map((message) => message.content).join("\n"), /STM32G0/);
    assert.match(prepared.activeTasksText, /active-task/);
    assert.match(prepared.designContextText, /project-1/);
    assert.equal(store.getSession("context-session")?.projectName, "Demo");

    engine.completeTurn({
      sessionId: "context-session",
      mode: "chat",
      content: "已记录型号，继续检查。",
      model: "test-model",
      toolCount: 0,
      plannedOperationCount: 0,
    });
    assert.equal(store.listMessages("context-session").at(-1)?.content, "已记录型号，继续检查。");
  } finally {
    store.close();
  }
});

test("Context Engine blocks conversation history from crossing EDA projects", async () => {
  const store = new AgentStore(":memory:");
  try {
    const engine = new ContextEngine(store);
    store.ensureSession("bound-session", { projectId: "project-a" });
    const current = engine.beginTurn("bound-session", "继续检查。", "chat");
    await assert.rejects(
      engine.prepareTurn({
        sessionId: "bound-session",
        beforeSequence: current.sequence,
        readDesignContext: async () => ({
          requestId: "different-project",
          ok: true,
          data: {
            project: { id: "project-b" },
            activeDocument: { id: "sheet-b", type: "schematic-page" },
            selected: [],
            summary: {},
            drc: [],
            capturedAt: "2026-08-25T00:00:00.000Z",
            source: "jlcircuit-eda",
          },
        }),
      }),
      /另一个 EDA 项目/,
    );
    assert.equal(store.getSession("bound-session")?.projectId, "project-a");
  } finally {
    store.close();
  }
});

test("Context Engine removes stale assistant tool-availability claims from model history", async () => {
  const store = new AgentStore(":memory:");
  try {
    const engine = new ContextEngine(store);
    store.ensureSession("sanitized-history");
    store.appendMessage({
      sessionId: "sanitized-history",
      role: "assistant",
      mode: "chat",
      content: "本轮被禁止调用工具，下一轮再登记 U1。",
    });
    const current = engine.beginTurn("sanitized-history", "继续登记", "chat");
    const prepared = await engine.prepareTurn({
      sessionId: "sanitized-history",
      beforeSequence: current.sequence,
      readDesignContext: async () => ({
        requestId: "sanitized-history-context",
        ok: true,
        data: {
          project: { id: "project-1" },
          activeDocument: { id: "sheet-1" },
          summary: {},
          capturedAt: "2026-08-28T00:00:00.000Z",
        },
      }),
    });

    assert.doesNotMatch(prepared.recentMessages[0]?.content ?? "", /被禁止调用工具/);
    assert.match(prepared.recentMessages[0]?.content ?? "", /过期工具状态已忽略/);
    assert.equal(store.listMessages("sanitized-history")[0]?.content, "本轮被禁止调用工具，下一轮再登记 U1。");
  } finally {
    store.close();
  }
});

test("Context Engine carries the current failed task and structured checkpoint into retries", async () => {
  const store = new AgentStore(":memory:");
  try {
    const engine = new ContextEngine(store);
    store.ensureSession("retry-context");
    store.saveTask({
      taskId: "failed-task",
      sessionId: "retry-context",
      attempt: 1,
      instruction: "移动 U013",
      status: "failed",
      model: "test-model",
      message: "桥接线创建失败。",
      context: {},
      toolTrace: [],
      changeSet: {
        id: "failed-change",
        summary: "移动 U013",
        operations: [{
          id: "failed-operation",
          tool: "easyeda_schematic_move_component",
          args: { primitiveId: "ie5035", x: 700, y: 520 },
          targets: [],
          riskLevel: "high",
          description: "移动元件",
        }],
        requiresConfirmation: true,
        createdAt: "2026-08-28T00:00:00.000Z",
        createdBy: "agent",
      },
      execution: {
        operations: [{
          operationId: "failed-operation",
          tool: "easyeda_schematic_move_component",
          ok: false,
          error: "unverifiable bridge",
        }],
      },
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:01:00.000Z",
    }, { setCurrent: true });
    store.appendMessage({
      sessionId: "retry-context",
      role: "assistant",
      mode: "chat",
      content: "下一轮再重试。",
      metadata: {
        status: "awaiting_user",
        runState: {
          stopReason: "model_completed",
          checkpoint: { plannedOperationCount: 0, resumable: true },
        },
      },
    });
    const current = engine.beginTurn("retry-context", "重试 U013 移动", "chat");
    const prepared = await engine.prepareTurn({
      sessionId: "retry-context",
      beforeSequence: current.sequence,
      readDesignContext: async () => ({
        requestId: "retry-context-request",
        ok: true,
        data: {
          project: { id: "project-1" },
          activeDocument: { id: "sheet-1" },
          summary: {},
          capturedAt: "2026-08-28T00:02:00.000Z",
        },
      }),
    });

    assert.match(prepared.activeTasksText, /failed-task/);
    assert.match(prepared.activeTasksText, /unverifiable bridge/);
    assert.match(prepared.recentMessages[0]?.content ?? "", /结构化回合状态/);
    assert.match(prepared.recentMessages[0]?.content ?? "", /resumable/);
  } finally {
    store.close();
  }
});
