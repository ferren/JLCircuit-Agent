import { createHash } from "node:crypto";
import type { ToolResponse } from "../../../packages/contracts/src/index.ts";
import {
  AgentStore,
  type ConversationMessage,
  type ConversationMode,
  type PersistedTask,
} from "./storage.ts";

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const stringifyForModel = (value: unknown): string => {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "function") return undefined;
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    });
  } catch (error) {
    return JSON.stringify({ serializationError: String(error) });
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const compactArray = (value: unknown, limit: number): unknown => {
  if (!Array.isArray(value)) return value;
  return {
    total: value.length,
    included: Math.min(value.length, limit),
    truncated: value.length > limit,
    items: value.slice(0, limit),
  };
};

const compactDesignContext = (
  context: Record<string, unknown>,
  itemLimit: number,
): Record<string, unknown> => {
  const summary = isRecord(context.summary) ? context.summary : {};
  return {
    project: context.project,
    activeDocument: context.activeDocument,
    selected: compactArray(context.selected, Math.min(itemLimit, 50)),
    summary: {
      api: summary.api,
      primitiveReadModel: summary.primitiveReadModel,
      components: compactArray(summary.components, itemLimit),
      wires: compactArray(summary.wires, itemLimit),
    },
    drc: Array.isArray(context.drc)
      ? compactArray(context.drc, Math.min(itemLimit, 50))
      : context.drc,
    capturedAt: context.capturedAt,
    source: context.source,
  };
};

const truncateText = (value: string, limit: number, marker = "\n[内容已按上下文预算截断]"): string => {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - marker.length))}${marker}`;
};

const selectMessagesByBudget = (
  messages: ConversationMessage[],
  maxChars: number,
): ConversationMessage[] => {
  const selected: ConversationMessage[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const cost = message.content.length + 32;
    if (selected.length > 0 && used + cost > maxChars) break;
    selected.push(
      cost > maxChars
        ? { ...message, content: truncateText(message.content, maxChars) }
        : message,
    );
    used += Math.min(cost, maxChars);
  }
  return selected.reverse();
};

const taskForContext = (task: PersistedTask) => ({
  taskId: task.taskId,
  status: task.status,
  instruction: task.instruction,
  assistantMessage: task.message,
  operations: task.changeSet.operations.map((operation) => ({
    tool: operation.tool,
    args: operation.args,
    description: operation.description,
  })),
  updatedAt: task.updatedAt,
});

export type PreparedAgentContext = {
  sessionId: string;
  designContext: unknown;
  designContextText: string;
  sessionSummary: string;
  recentMessages: ConversationMessage[];
  activeTasksText: string;
  diagnostics: {
    designOriginalChars: number;
    designModelChars: number;
    designCompacted: boolean;
    historyMessageCount: number;
    historyChars: number;
    summaryChars: number;
    activeTaskCount: number;
    totalPreparedChars: number;
  };
};

export type ContextEngineLogger = (message: string, details?: unknown) => void;

export class ContextEngine {
  private readonly store: AgentStore;
  private readonly log: ContextEngineLogger;
  private readonly recentMessageLimit: number;
  private readonly historyMaxChars: number;
  private readonly summaryMaxChars: number;
  private readonly activeTaskLimit: number;
  private readonly activeTaskMaxChars: number;
  private readonly designMaxChars: number;
  private readonly designMaxItems: number;

  public constructor(store: AgentStore, log: ContextEngineLogger = () => undefined) {
    this.store = store;
    this.log = log;
    this.recentMessageLimit = positiveInteger(process.env.JLCIRCUIT_CONTEXT_RECENT_MESSAGES, 12);
    this.historyMaxChars = positiveInteger(process.env.JLCIRCUIT_CONTEXT_HISTORY_MAX_CHARS, 12_000);
    this.summaryMaxChars = positiveInteger(process.env.JLCIRCUIT_CONTEXT_SUMMARY_MAX_CHARS, 6_000);
    this.activeTaskLimit = positiveInteger(process.env.JLCIRCUIT_CONTEXT_ACTIVE_TASKS, 5);
    this.activeTaskMaxChars = positiveInteger(process.env.JLCIRCUIT_CONTEXT_TASK_MAX_CHARS, 6_000);
    this.designMaxChars = positiveInteger(process.env.JLCIRCUIT_LLM_CONTEXT_MAX_CHARS, 40_000);
    this.designMaxItems = positiveInteger(process.env.JLCIRCUIT_LLM_CONTEXT_MAX_ITEMS, 200);
  }

  public beginTurn(
    sessionId: string,
    content: string,
    mode: ConversationMode,
    metadata?: Record<string, unknown>,
  ): ConversationMessage {
    this.store.ensureSession(sessionId);
    const message = this.store.appendMessage({ sessionId, role: "user", mode, content, metadata });
    this.store.appendAuditEvent({
      sessionId,
      eventType: "turn.started",
      payload: { messageId: message.id, mode, instructionLength: content.length },
    });
    return message;
  }

  public completeTurn(input: {
    sessionId: string;
    mode: ConversationMode;
    content: string;
    model: string;
    toolCount: number;
    plannedOperationCount: number;
    metadata?: Record<string, unknown>;
  }): ConversationMessage {
    const message = this.store.appendMessage({
      sessionId: input.sessionId,
      role: "assistant",
      mode: input.mode,
      content: input.content,
      model: input.model,
      metadata: input.metadata,
    });
    this.store.refreshSessionSummary(
      input.sessionId,
      this.recentMessageLimit,
      this.summaryMaxChars,
    );
    this.store.appendAuditEvent({
      sessionId: input.sessionId,
      eventType: "turn.completed",
      payload: {
        messageId: message.id,
        mode: input.mode,
        model: input.model,
        toolCount: input.toolCount,
        plannedOperationCount: input.plannedOperationCount,
      },
    });
    return message;
  }

  public failTurn(sessionId: string, mode: ConversationMode, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.store.appendMessage({
      sessionId,
      role: "assistant",
      mode,
      content: `上一轮请求未完成：${message}`,
      metadata: { failed: true },
    });
    this.store.refreshSessionSummary(sessionId, this.recentMessageLimit, this.summaryMaxChars);
    this.store.appendAuditEvent({
      sessionId,
      eventType: "turn.failed",
      payload: { mode, error: message },
    });
  }

  public async captureDesignContext(
    sessionId: string,
    readDesignContext: () => Promise<ToolResponse>,
    enforceProjectBinding = false,
  ): Promise<ToolResponse> {
    const existingSession = this.store.getSession(sessionId) ?? this.store.ensureSession(sessionId);
    const response = await readDesignContext();
    if (!response.ok) return response;
    const context = response.data;
    const record = isRecord(context) ? context : {};
    const project = isRecord(record.project) ? record.project : {};
    const document = isRecord(record.activeDocument) ? record.activeDocument : {};
    const projectId = typeof project.id === "string" ? project.id : undefined;
    const projectName = typeof project.name === "string" ? project.name : undefined;
    const documentId = typeof document.id === "string" ? document.id : undefined;
    const capturedAt = typeof record.capturedAt === "string" ? record.capturedAt : new Date().toISOString();
    if (
      enforceProjectBinding &&
      existingSession.projectId &&
      projectId &&
      existingSession.projectId !== projectId
    ) {
      this.store.appendAuditEvent({
        sessionId,
        eventType: "session.project_mismatch",
        payload: { expectedProjectId: existingSession.projectId, currentProjectId: projectId },
      });
      return {
        requestId: response.requestId,
        ok: false,
        error: {
          code: "SESSION_PROJECT_MISMATCH",
          message: "当前会话属于另一个 EDA 项目。请为当前项目使用新的 sessionId，已阻止混入旧项目对话。",
          retryable: false,
        },
      };
    }
    const serialized = stringifyForModel(context);
    this.store.ensureSession(sessionId, { projectId, projectName });
    this.store.upsertContextSnapshot({
      sessionId,
      projectId,
      documentId,
      contentHash: createHash("sha256").update(serialized).digest("hex"),
      context,
      capturedAt,
    });
    return response;
  }

  public async prepareTurn(input: {
    sessionId: string;
    beforeSequence: number;
    readDesignContext: () => Promise<ToolResponse>;
  }): Promise<PreparedAgentContext> {
    const response = await this.captureDesignContext(input.sessionId, input.readDesignContext, true);
    if (!response.ok) {
      throw new Error(response.error?.message ?? "Unable to read EDA context.");
    }
    const designContext = response.data;
    const designOriginal = stringifyForModel(designContext);
    let designText = designOriginal;
    let designCompacted = false;
    if (isRecord(designContext) && designOriginal.length > this.designMaxChars) {
      let itemLimit = this.designMaxItems;
      let compacted = compactDesignContext(designContext, itemLimit);
      designText = stringifyForModel(compacted);
      while (designText.length > this.designMaxChars && itemLimit > 1) {
        itemLimit = Math.max(1, Math.floor(itemLimit / 2));
        compacted = compactDesignContext(designContext, itemLimit);
        designText = stringifyForModel(compacted);
      }
      designText = truncateText(designText, this.designMaxChars);
      designCompacted = true;
    }

    const session = this.store.getSession(input.sessionId) ?? this.store.ensureSession(input.sessionId);
    const recentCandidates = this.store.listRecentMessagesBefore(
      input.sessionId,
      input.beforeSequence,
      this.recentMessageLimit,
    );
    const recentMessages = selectMessagesByBudget(recentCandidates, this.historyMaxChars);
    const sessionSummary = truncateText(session.summary, this.summaryMaxChars);
    const activeTasks = this.store
      .listTasksForSession(input.sessionId, 20)
      .filter((task) => ["planning", "awaiting_user", "waiting_confirmation", "executing"].includes(task.status))
      .slice(0, this.activeTaskLimit)
      .map(taskForContext);
    const activeTasksText = truncateText(stringifyForModel(activeTasks), this.activeTaskMaxChars);
    const historyChars = recentMessages.reduce((total, message) => total + message.content.length, 0);
    const diagnostics = {
      designOriginalChars: designOriginal.length,
      designModelChars: designText.length,
      designCompacted,
      historyMessageCount: recentMessages.length,
      historyChars,
      summaryChars: sessionSummary.length,
      activeTaskCount: activeTasks.length,
      totalPreparedChars: designText.length + historyChars + sessionSummary.length + activeTasksText.length,
    };
    this.log("[context] prepared", { sessionId: input.sessionId, ...diagnostics });
    this.store.appendAuditEvent({
      sessionId: input.sessionId,
      eventType: "context.prepared",
      payload: diagnostics,
    });
    return {
      sessionId: input.sessionId,
      designContext,
      designContextText: designText,
      sessionSummary,
      recentMessages,
      activeTasksText,
      diagnostics,
    };
  }
}
