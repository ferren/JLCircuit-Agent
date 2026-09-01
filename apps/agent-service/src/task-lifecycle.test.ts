import assert from "node:assert/strict";
import test from "node:test";
import type { PersistedTask } from "./storage.ts";
import {
  createRetryTask,
  isRetryInstruction,
  shouldForceExecutionPlanFromHistory,
} from "./task-lifecycle.ts";

const failedTask = (): PersistedTask => ({
  taskId: "task-1",
  sessionId: "session-1",
  attempt: 1,
  instruction: "移动 U013",
  status: "failed",
  model: "test-model",
  message: "执行失败",
  context: { project: { id: "project-1" }, activeDocument: { id: "sheet-1" } },
  toolTrace: [],
  changeSet: {
    id: "change-1",
    summary: "移动 U013",
    operations: [{
      id: "operation-1",
      tool: "easyeda_schematic_move_component",
      args: { primitiveId: "ie5035", x: 700, y: 520, preserveConnections: true },
      targets: [],
      riskLevel: "high",
      description: "移动原理图元件",
    }],
    requiresConfirmation: true,
    createdAt: "2026-08-28T00:00:00.000Z",
    createdBy: "agent",
  },
  execution: {
    operations: [{
      operationId: "operation-1",
      tool: "easyeda_schematic_move_component",
      ok: false,
      error: "bridge failed",
    }],
  },
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:01:00.000Z",
});

test("failed tasks are cloned as confirmation-gated retry attempts", () => {
  let nextId = 0;
  const retry = createRetryTask(failedTask(), {
    now: "2026-08-28T01:00:00.000Z",
    idFactory: () => `new-${++nextId}`,
  });
  assert.equal(retry.parentTaskId, "task-1");
  assert.equal(retry.attempt, 2);
  assert.equal(retry.status, "waiting_confirmation");
  assert.equal(retry.changeSet.operations.length, 1);
  assert.notEqual(retry.changeSet.operations[0]?.id, "operation-1");
  assert.match(retry.message, /bridge failed/);
  assert.ok(retry.confirmationToken);
});

test("retry and deferred execution-plan instructions are recognized without matching ordinary discussion", () => {
  assert.equal(isRetryInstruction("重试 U013 移动"), true);
  assert.equal(isRetryInstruction("重新规划 U013 的位置"), false);
  assert.equal(shouldForceExecutionPlanFromHistory(
    "登记 U013 移动",
    "新开一轮发一句“登记 U013 移动”，我将逐条登记操作。",
  ), true);
  assert.equal(shouldForceExecutionPlanFromHistory("为什么移动失败？", "请查看失败原因。"), false);
});
