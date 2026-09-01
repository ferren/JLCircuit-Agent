import crypto from "node:crypto";
import type { PersistedTask } from "./storage.ts";

const normalizeActionText = (value: string): string =>
  value.trim().toLowerCase().replace(/[\s“”‘’"'。！？.!?：:，,、]+/g, "");

export const isRetryInstruction = (instruction: string): boolean => {
  const normalized = normalizeActionText(instruction);
  return /^(?:重试|再试一次|重新执行|按原计划重试|按原方案重试)(?:u\d+(?:移动|修改)?)?$/.test(normalized);
};

export const shouldForceExecutionPlanFromHistory = (
  instruction: string,
  previousAssistantMessage?: string,
): boolean => {
  if (!previousAssistantMessage) return false;
  const normalizedInstruction = normalizeActionText(instruction);
  if (!normalizedInstruction || normalizedInstruction.length > 80) return false;
  const normalizedPrevious = normalizeActionText(previousAssistantMessage);
  const deferredAction = /(?:新开|再开|下一)(?:一轮|回合)|(?:发送|发一句|回复).{0,40}(?:登记|重试|执行|移动)/i
    .test(previousAssistantMessage);
  const actionableInstruction = /(?:登记|重试|执行|移动|生成修改计划|生成执行计划)/i.test(instruction);
  return deferredAction && actionableInstruction && normalizedPrevious.includes(normalizedInstruction);
};

export const createRetryTask = (
  source: PersistedTask,
  options: {
    now?: string;
    idFactory?: () => string;
  } = {},
): PersistedTask => {
  if (source.status !== "failed") {
    throw new Error(`任务当前状态为 ${source.status}，只有失败任务可以按原计划重试。`);
  }
  if (source.changeSet.operations.length === 0) {
    throw new Error("失败任务没有可重试的写操作，请重新生成执行计划。");
  }
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const now = options.now ?? new Date().toISOString();
  const attempt = (source.attempt ?? 1) + 1;
  const primaryFailure = source.execution?.operations.find((operation) =>
    !operation.ok && !String(operation.error ?? "").startsWith("前序写操作失败"));
  const failure = primaryFailure?.error ?? source.execution?.verification?.error;
  const succeededOperationIds = new Set(
    (source.execution?.operations ?? [])
      .filter((operation) => operation.ok)
      .map((operation) => operation.operationId),
  );
  const retriableOperations = source.changeSet.operations.filter((operation) =>
    !succeededOperationIds.has(operation.id));
  if (retriableOperations.length === 0) {
    throw new Error("所有写操作都已成功执行，没有需要重试的操作；失败发生在写后验证阶段，请重新运行 DRC/ERC。");
  }
  return {
    taskId: idFactory(),
    sessionId: source.sessionId,
    parentTaskId: source.taskId,
    attempt,
    instruction: source.instruction,
    status: "waiting_confirmation",
    model: source.model,
    message: [
      `已从失败任务恢复 ${retriableOperations.length} 条未成功的原始操作（共 ${source.changeSet.operations.length} 条，已成功的 ${succeededOperationIds.size} 条不再重复执行），作为第 ${attempt} 次执行尝试。`,
      failure ? `上次失败原因：${failure}` : undefined,
      "本次未重新调用模型或改变坐标；确认前仍会保留原项目和文档前置校验。",
    ].filter(Boolean).join("\n\n"),
    context: source.context,
    toolTrace: [],
    changeSet: {
      ...source.changeSet,
      id: idFactory(),
      summary: `按原计划重试：${source.changeSet.summary}`,
      operations: retriableOperations.map((operation) => ({
        ...operation,
        id: idFactory(),
        args: { ...operation.args },
        targets: [...operation.targets],
      })),
      requiresConfirmation: true,
      createdAt: now,
      createdBy: "agent",
    },
    confirmationToken: idFactory(),
    skills: source.skills?.map((skill) => ({ ...skill })),
    createdAt: now,
    updatedAt: now,
  };
};
