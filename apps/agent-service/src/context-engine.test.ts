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
