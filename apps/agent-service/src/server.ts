import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import {
  createToolRequest,
  type BridgeMessage,
  type ToolRequest,
  type ToolResponse,
} from "../../../packages/bridge/src/index.ts";
import type { ChangeOperation, ChangeSet } from "../../../packages/contracts/src/index.ts";
import { JLCIRCUIT_TOOLS, getTool } from "../../../packages/mcp/src/index.ts";
import { runAgentTurn } from "./llm.ts";

const host = process.env.JLCIRCUIT_AGENT_HOST ?? "127.0.0.1";
const port = Number(process.env.JLCIRCUIT_AGENT_PORT ?? 49630);
const bridgeTimeoutMs = Number(process.env.JLCIRCUIT_BRIDGE_TIMEOUT_MS ?? 15_000);

const log = (message: string, details?: unknown): void => {
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  console.log(`[${new Date().toISOString()}] ${message}${suffix}`);
};

class LocalBridgeGateway {
  private socket?: WebSocket;
  private readonly pending = new Map<string, {
    resolve: (response: ToolResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  public attach(socket: WebSocket): void {
    log("[bridge] WebSocket connection accepted");
    this.socket?.close(1000, "replaced by a newer bridge connection");
    this.socket = socket;
    socket.on("message", (data) => this.handleMessage(data.toString()));
    socket.on("close", () => {
      log("[bridge] WebSocket connection closed");
      if (this.socket === socket) this.socket = undefined;
    });
    socket.on("error", (error) => {
      log("[bridge] WebSocket error", { message: error.message });
      if (this.socket === socket) this.socket = undefined;
    });
  }

  public get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  public send(request: ToolRequest): Promise<ToolResponse> {
    if (!this.connected || !this.socket) {
      log("[bridge] request rejected: bridge is not connected", { tool: request.tool });
      return Promise.reject(new Error("EDA bridge is not connected."));
    }
    log("[bridge] request sent", {
      requestId: request.requestId,
      operation: request.operation,
      tool: request.tool,
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new Error(`EDA bridge request timed out after ${bridgeTimeoutMs}ms.`));
      }, bridgeTimeoutMs);
      this.pending.set(request.requestId, { resolve, reject, timer });
      this.socket?.send(JSON.stringify({ type: "request", request }));
    });
  }

  private handleMessage(raw: string): void {
    let message: BridgeMessage;
    try {
      message = JSON.parse(raw) as BridgeMessage;
    } catch {
      return;
    }
    if (message.type === "hello") {
      log("[bridge] hello received", {
        protocolVersion: message.protocolVersion,
        extensionVersion: message.extensionVersion,
        capabilityCount: message.capabilities?.capabilities.length ?? 0,
      });
      this.socket?.send(JSON.stringify({ type: "hello_ack", protocolVersion: 1, server: "jlcircuit-agent" }));
      return;
    }
    if (message.type !== "response") return;
    log("[bridge] response received", {
      requestId: message.response.requestId,
      ok: message.response.ok,
      error: message.response.error?.message,
    });
    const pending = this.pending.get(message.response.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.response.requestId);
    pending.resolve(message.response);
  }
}

const bridge = new LocalBridgeGateway();
const bridgeServer = new WebSocketServer({ noServer: true });

const json = (response: ServerResponse, statusCode: number, body: unknown) => {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  response.end(JSON.stringify(body));
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const errorResponse = (error: unknown) => ({
  error: "bridge_error",
  message: error instanceof Error ? error.message : "Unknown bridge error",
});

const callTool = async (
  toolName: string,
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<ToolResponse> => {
  log("[agent] tool call", { tool: toolName, sessionId });
  const definition = getTool(toolName);
  if (!definition || !definition.enabled) {
    return {
      requestId: crypto.randomUUID(),
      ok: false,
      error: { code: "TOOL_UNAVAILABLE", message: `Tool is unavailable: ${toolName}`, retryable: false },
    };
  }
  return bridge.send(createToolRequest(sessionId, toolName, payload));
};

type TaskStatus = "planning" | "waiting_confirmation" | "executing" | "completed" | "failed" | "cancelled";

type TaskExecution = {
  operations: Array<{ operationId: string; tool: string; ok: boolean; data?: unknown; error?: string }>;
  verification?: { ok: boolean; data?: unknown; error?: string };
};

type AgentTask = {
  taskId: string;
  sessionId: string;
  instruction: string;
  status: TaskStatus;
  model: string;
  message: string;
  context: unknown;
  toolTrace: unknown[];
  changeSet: ChangeSet;
  confirmationToken?: string;
  execution?: TaskExecution;
  createdAt: string;
  updatedAt: string;
};

const tasks = new Map<string, AgentTask>();

const runModelTurn = async (sessionId: string, instruction: string, mode: "chat" | "plan" = "chat") => {
  log("[llm] turn started", { sessionId, mode, provider: process.env.JLCIRCUIT_MODEL_PROVIDER ?? "stub" });
  const result = await runAgentTurn({
    instruction,
    sessionId,
    toolDefinitions: JLCIRCUIT_TOOLS,
    executeTool: callTool,
    mode,
  });
  log("[llm] turn completed", {
    model: result.model,
    toolCount: result.toolTrace.length,
    plannedOperationCount: result.plannedOperations.length,
  });
  return result;
};

const createChangeSet = (result: Awaited<ReturnType<typeof runModelTurn>>): ChangeSet => ({
  id: crypto.randomUUID(),
  projectId: (result.context as { project?: { id?: string } } | undefined)?.project?.id,
  documentId: (result.context as { activeDocument?: { id?: string } } | undefined)?.activeDocument?.id,
  summary: result.message || "待确认的设计修改",
  operations: result.plannedOperations,
  requiresConfirmation: result.plannedOperations.length > 0,
  createdAt: new Date().toISOString(),
  createdBy: "agent",
});

const taskView = (task: AgentTask) => ({ ...task });

const getTaskIdFromPath = (pathname: string, suffix: string): string | undefined => {
  const prefix = "/v1/tasks/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
  const taskId = pathname.slice(prefix.length, pathname.length - suffix.length);
  return taskId || undefined;
};

const executeTask = async (task: AgentTask): Promise<boolean> => {
  task.status = "executing";
  task.updatedAt = new Date().toISOString();
  const currentContext = await callTool("easyeda_get_context", task.sessionId, {});
  if (!currentContext.ok) {
    task.status = "failed";
    task.execution = {
      operations: [],
      verification: { ok: false, error: currentContext.error?.message ?? "无法在写入前读取当前设计。" },
    };
    task.updatedAt = new Date().toISOString();
    return false;
  }
  const plannedProjectId = (task.context as { project?: { id?: string } } | undefined)?.project?.id;
  const currentProjectId = (currentContext.data as { project?: { id?: string } } | undefined)?.project?.id;
  const plannedDocumentId = (task.context as { activeDocument?: { id?: string } } | undefined)?.activeDocument?.id;
  const currentDocumentId = (currentContext.data as { activeDocument?: { id?: string } } | undefined)?.activeDocument?.id;
  if ((plannedProjectId && currentProjectId && plannedProjectId !== currentProjectId) ||
      (plannedDocumentId && currentDocumentId && plannedDocumentId !== currentDocumentId)) {
    task.status = "failed";
    task.execution = {
      operations: [],
      verification: { ok: false, error: "计划生成后当前项目或文档已发生变化，已阻止写入。请重新生成计划。" },
    };
    task.updatedAt = new Date().toISOString();
    return false;
  }
  const operations: TaskExecution["operations"] = [];
  for (const operation of task.changeSet.operations) {
    if (operation.tool !== "easyeda_schematic_move_component") {
      operations.push({
        operationId: operation.id,
        tool: operation.tool,
        ok: false,
        error: "当前阶段只允许执行原理图元件移动操作。",
      });
      continue;
    }
    const result = await callTool(operation.tool, task.sessionId, {
      ...operation.args,
      confirmWrite: true,
      verifyVisual: false,
    });
    operations.push({
      operationId: operation.id,
      tool: operation.tool,
      ok: result.ok,
      data: result.ok ? result.data : undefined,
      error: result.ok ? undefined : result.error?.message,
    });
  }

  const verification = await callTool("easyeda_post_write_verify", task.sessionId, {
    runDrc: true,
    capture: true,
  });
  task.execution = {
    operations,
    verification: {
      ok: verification.ok,
      data: verification.ok ? verification.data : undefined,
      error: verification.ok ? undefined : verification.error?.message,
    },
  };
  const operationsOk = operations.length > 0 && operations.every((operation) => operation.ok);
  task.status = operationsOk && verification.ok ? "completed" : "failed";
  task.updatedAt = new Date().toISOString();
  return task.status === "completed";
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      log("[http] GET /health", { bridge: bridge.connected });
      json(response, 200, {
        service: "jlcircuit-agent",
        status: "ok",
        bridge: bridge.connected ? "connected" : "not-connected",
        bridgeProtocolVersion: 1,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/tools") {
      json(response, 200, { tools: JLCIRCUIT_TOOLS, bridgeConnected: bridge.connected });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/sessions") {
      const body = (await readBody(request)) as { projectId?: string };
      json(response, 201, {
        sessionId: crypto.randomUUID(),
        projectId: body.projectId ?? null,
        status: "created",
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/chat") {
      const body = (await readBody(request)) as { sessionId?: string; instruction?: string };
      const sessionId = body.sessionId ?? "default";
      const instruction = body.instruction?.trim();
      log(`[http] POST ${url.pathname}`, { sessionId, instructionLength: instruction?.length ?? 0 });
      if (!instruction) {
        json(response, 400, { error: "invalid_request", message: "instruction is required." });
        return;
      }
      const result = await runModelTurn(sessionId, instruction);
      json(response, 200, { sessionId, status: "completed", ...result });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/plan") {
      const body = (await readBody(request)) as { sessionId?: string; instruction?: string };
      const sessionId = body.sessionId ?? "default";
      const instruction = body.instruction?.trim();
      log(`[http] POST ${url.pathname}`, { sessionId, instructionLength: instruction?.length ?? 0 });
      if (!instruction) {
        json(response, 400, { error: "invalid_request", message: "instruction is required." });
        return;
      }
      const result = await runModelTurn(sessionId, instruction, "plan");
      const changeSet = createChangeSet(result);
      const now = new Date().toISOString();
      const task: AgentTask = {
        taskId: crypto.randomUUID(),
        sessionId,
        instruction,
        status: changeSet.operations.length > 0 ? "waiting_confirmation" : "completed",
        model: result.model,
        message: result.message,
        context: result.context,
        toolTrace: result.toolTrace,
        changeSet,
        confirmationToken: changeSet.operations.length > 0 ? crypto.randomUUID() : undefined,
        createdAt: now,
        updatedAt: now,
      };
      tasks.set(task.taskId, task);
      json(response, 200, taskView(task));
      return;
    }

    const taskIdForGet = request.method === "GET" && url.pathname.startsWith("/v1/tasks/")
      ? url.pathname.slice("/v1/tasks/".length)
      : undefined;
    if (taskIdForGet) {
      const task = tasks.get(taskIdForGet);
      if (!task) {
        json(response, 404, { error: "not_found", message: "task not found" });
        return;
      }
      json(response, 200, taskView(task));
      return;
    }

    const taskIdForConfirm = request.method === "POST"
      ? getTaskIdFromPath(url.pathname, "/confirm")
      : undefined;
    if (taskIdForConfirm) {
      const task = tasks.get(taskIdForConfirm);
      if (!task) {
        json(response, 404, { error: "not_found", message: "task not found" });
        return;
      }
      const body = (await readBody(request)) as { confirmationToken?: string };
      if (task.status !== "waiting_confirmation") {
        json(response, 409, { error: "invalid_state", message: `任务当前状态为 ${task.status}，不能确认执行。`, task: taskView(task) });
        return;
      }
      if (!task.confirmationToken || body.confirmationToken !== task.confirmationToken) {
        json(response, 403, { error: "confirmation_required", message: "确认令牌无效。" });
        return;
      }
      task.confirmationToken = undefined;
      let succeeded = false;
      try {
        succeeded = await executeTask(task);
      } catch (error) {
        task.status = "failed";
        task.execution = {
          operations: [],
          verification: { ok: false, error: error instanceof Error ? error.message : String(error) },
        };
        task.updatedAt = new Date().toISOString();
      }
      json(response, succeeded ? 200 : 502, taskView(task));
      return;
    }

    const taskIdForCancel = request.method === "POST"
      ? getTaskIdFromPath(url.pathname, "/cancel")
      : undefined;
    if (taskIdForCancel) {
      const task = tasks.get(taskIdForCancel);
      if (!task) {
        json(response, 404, { error: "not_found", message: "task not found" });
        return;
      }
      if (task.status === "waiting_confirmation") {
        task.confirmationToken = undefined;
        task.status = "cancelled";
        task.updatedAt = new Date().toISOString();
      }
      json(response, 200, taskView(task));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/context") {
      const body = (await readBody(request)) as { sessionId?: string };
      log("[http] POST /v1/context", { sessionId: body.sessionId ?? "default" });
      const result = await callTool("easyeda_get_context", body.sessionId ?? "default", {});
      json(response, result.ok ? 200 : 502, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/drc") {
      const body = (await readBody(request)) as { sessionId?: string };
      log("[http] POST /v1/drc", { sessionId: body.sessionId ?? "default" });
      const result = await callTool("easyeda_run_drc", body.sessionId ?? "default", {});
      json(response, result.ok ? 200 : 502, result);
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/v1/tools/")) {
      const toolName = decodeURIComponent(url.pathname.slice("/v1/tools/".length));
      const body = await readBody(request);
      const bodyRecord = isRecord(body) ? body : {};
      const payload = isRecord(bodyRecord.payload) ? bodyRecord.payload : bodyRecord;
      const result = await callTool(toolName, String(bodyRecord.sessionId ?? "default"), payload);
      json(response, result.ok ? 200 : 502, result);
      return;
    }

    json(response, 404, { error: "not_found" });
  } catch (error) {
    json(response, 400, errorResponse(error));
  }
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
  if (url.pathname !== "/bridge") {
    socket.destroy();
    return;
  }
  log("[http] WebSocket upgrade /bridge");
  bridgeServer.handleUpgrade(request, socket, head, (webSocket) => bridge.attach(webSocket));
});

server.listen(port, host, () => {
  console.log(`JLCircuit Agent listening on http://${host}:${port}`);
  console.log(`EDA bridge waiting on ws://${host}:${port}/bridge`);
});
