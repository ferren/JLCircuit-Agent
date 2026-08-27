import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import {
  createToolRequest,
  type BridgeMessage,
  type ToolRequest,
  type ToolResponse,
} from "../../../packages/bridge/src/index.ts";
import type { ChangeOperation, ChangeSet } from "../../../packages/contracts/src/index.ts";
import { JLCIRCUIT_TOOLS, getTool } from "../../../packages/mcp/src/index.ts";
import { ContextEngine } from "./context-engine.ts";
import {
  KNOWLEDGE_TOOL_DEFINITIONS,
  KnowledgeService,
  KnowledgeServiceError,
} from "./knowledge-service.ts";
import { runAgentTurn, type AgentRunEvent } from "./llm.ts";
import { McpRegistry, McpRegistryError } from "./mcp-registry.ts";
import { SkillRegistry, SkillRegistryError } from "./skill-registry.ts";
import {
  AgentStore,
  type PersistedTask as AgentTask,
  type TaskExecution,
} from "./storage.ts";

const host = process.env.JLCIRCUIT_AGENT_HOST ?? "127.0.0.1";
const port = Number(process.env.JLCIRCUIT_AGENT_PORT ?? 49630);
const bridgeTimeoutMs = Number(process.env.JLCIRCUIT_BRIDGE_TIMEOUT_MS ?? 15_000);
const localAdminToken = process.env.JLCIRCUIT_ADMIN_TOKEN?.trim()
  || process.env.JLCIRCUIT_MCP_ADMIN_TOKEN?.trim()
  || undefined;
const localAdminAllowedOrigins = new Set([
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  `http://[::1]:${port}`,
  ...`${process.env.JLCIRCUIT_ADMIN_ALLOWED_ORIGINS ?? ""},${process.env.JLCIRCUIT_MCP_ADMIN_ALLOWED_ORIGINS ?? ""}`
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
]);

const log = (message: string, details?: unknown): void => {
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  console.log(`[${new Date().toISOString()}] ${message}${suffix}`);
};

const store = new AgentStore();
const contextEngine = new ContextEngine(store, log);
const knowledgeService = new KnowledgeService(store, log);
const builtinToolDefinitions = [...JLCIRCUIT_TOOLS, ...KNOWLEDGE_TOOL_DEFINITIONS];
const skillRegistry = new SkillRegistry(store, builtinToolDefinitions);
const mcpRegistry = new McpRegistry(store, log);

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

  public close(): void {
    this.socket?.close(1001, "agent service shutting down");
    this.socket = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Agent service is shutting down."));
    }
    this.pending.clear();
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

const startSse = (response: ServerResponse): void => {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*",
  });
  response.socket?.setNoDelay(true);
  response.flushHeaders();
};

const writeSse = (response: ServerResponse, event: string, data: unknown): boolean => {
  if (response.destroyed || response.writableEnded) return false;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return true;
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

class HttpRequestError extends Error {
  public readonly statusCode: number;

  public constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpRequestError";
    this.statusCode = statusCode;
  }
}

const isLoopbackHost = (value: string): boolean =>
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(value.trim().toLowerCase());

const isLoopbackAddress = (value: string | undefined): boolean => {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
};

const tokenMatches = (provided: string | undefined, expected: string): boolean => {
  if (!provided) return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
};

const requireLocalAdmin = (request: IncomingMessage): void => {
  if (!isLoopbackHost(host) || !isLoopbackAddress(request.socket.remoteAddress)) {
    throw new HttpRequestError(403, "Local management is only available through the loopback Agent service.");
  }
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  if (origin && !localAdminAllowedOrigins.has(origin)) {
    throw new HttpRequestError(403, `Local management origin is not allowed: ${origin}`);
  }
  const provided = request.headers["x-jlcircuit-admin-token"];
  const token = Array.isArray(provided) ? provided[0] : provided;
  if (localAdminToken && !tokenMatches(token, localAdminToken)) {
    throw new HttpRequestError(403, "Local management token is missing or invalid.");
  }
};

const callTool = async (
  toolName: string,
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<ToolResponse> => {
  log("[agent] tool call", { tool: toolName, sessionId });
  store.ensureSession(sessionId);
  if (KNOWLEDGE_TOOL_DEFINITIONS.some((definition) => definition.name === toolName)) {
    return knowledgeService.callTool(toolName, sessionId, payload);
  }
  const mcpTool = mcpRegistry.getTool(toolName);
  if (mcpTool) {
    if (mcpTool.riskLevel !== "read") {
      return {
        requestId: crypto.randomUUID(),
        ok: false,
        error: {
          code: "MCP_WRITE_NOT_EXECUTABLE",
          message: "当前阶段只允许执行只读 MCP 工具；外部写工具只能形成计划，尚不能确认执行。",
          retryable: false,
        },
      };
    }
    return mcpRegistry.callTool(toolName, sessionId, payload);
  }
  const definition = getTool(toolName);
  if (!definition || !definition.enabled) {
    return {
      requestId: crypto.randomUUID(),
      ok: false,
      error: { code: "TOOL_UNAVAILABLE", message: `Tool is unavailable: ${toolName}`, retryable: false },
    };
  }
  const payloadText = JSON.stringify(payload);
  store.appendAuditEvent({
    sessionId,
    eventType: "tool.requested",
    payload: {
      tool: toolName,
      riskLevel: definition.riskLevel,
      arguments: payloadText.length <= 8_000
        ? payload
        : { truncated: true, charLength: payloadText.length, preview: payloadText.slice(0, 2_000) },
    },
  });
  try {
    const result = await bridge.send(createToolRequest(sessionId, toolName, payload));
    const dataText = JSON.stringify(result.data ?? null);
    store.appendAuditEvent({
      sessionId,
      eventType: result.ok ? "tool.completed" : "tool.failed",
      payload: {
        tool: toolName,
        requestId: result.requestId,
        ok: result.ok,
        error: result.error,
        data: dataText.length <= 8_000
          ? result.data
          : { truncated: true, charLength: dataText.length, preview: dataText.slice(0, 2_000) },
        content: result.content?.map((item) => item.type === "image"
          ? { type: "image", mimeType: item.mimeType, byteLength: item.data.length }
          : item),
      },
    });
    return result;
  } catch (error) {
    store.appendAuditEvent({
      sessionId,
      eventType: "tool.failed",
      payload: { tool: toolName, error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
};

const runModelTurn = async (
  sessionId: string,
  instruction: string,
  mode: "chat" | "plan" = "chat",
  userInstruction = instruction,
  requestedSkillIds?: string[],
  options: { onEvent?: (event: AgentRunEvent) => void; signal?: AbortSignal } = {},
) => {
  log("[llm] turn started", { sessionId, mode, provider: process.env.JLCIRCUIT_MODEL_PROVIDER ?? "stub" });
  const resolvedSkills = skillRegistry.resolve({
    instruction: userInstruction,
    mode,
    requestedSkillIds,
  });
  const skillRefs = resolvedSkills.skills.map(({ id, name, version, reason }) => ({ id, name, version, reason }));
  const userMessage = contextEngine.beginTurn(sessionId, userInstruction, mode, { skills: skillRefs });
  const allToolDefinitions = [...builtinToolDefinitions, ...mcpRegistry.listToolDefinitions()];
  const toolDefinitions = skillRegistry
    .filterToolDefinitions(resolvedSkills.skills, allToolDefinitions)
    .filter((tool) => !tool.name.startsWith("mcp__") || tool.riskLevel === "read");
  store.appendAuditEvent({
    sessionId,
    eventType: "skills.resolved",
    payload: { mode, requestedSkillIds: requestedSkillIds ?? [], skills: skillRefs, tools: toolDefinitions.map((tool) => tool.name) },
  });
  try {
    options.onEvent?.({ type: "phase", phase: "context", message: "正在读取当前 EDA 设计和会话上下文…" });
    const preparedContext = await contextEngine.prepareTurn({
      sessionId,
      beforeSequence: userMessage.sequence,
      readDesignContext: () => callTool("easyeda_get_context", sessionId, {}),
    });
    const result = await runAgentTurn({
      instruction,
      sessionId,
      preparedContext,
      toolDefinitions,
      executeTool: callTool,
      activeSkills: resolvedSkills.skills,
      mode,
      signal: options.signal,
      onEvent: options.onEvent,
    });
    contextEngine.completeTurn({
      sessionId,
      mode,
      content: result.message,
      model: result.model,
      toolCount: result.toolTrace.length,
      plannedOperationCount: result.plannedOperations.length,
      metadata: { skills: skillRefs, status: result.status, runState: result.runState },
    });
    log("[llm] turn completed", {
      model: result.model,
      toolCount: result.toolTrace.length,
      plannedOperationCount: result.plannedOperations.length,
      status: result.status,
      stopReason: result.runState.stopReason,
      modelRequests: result.runState.modelRequests,
      skills: skillRefs.map((skill) => skill.id),
    });
    return result;
  } catch (error) {
    contextEngine.failTurn(sessionId, mode, error);
    throw error;
  }
};

const createChangeSet = (result: Awaited<ReturnType<typeof runModelTurn>>): ChangeSet => ({
  id: crypto.randomUUID(),
  projectId: (result.context as { project?: { id?: string } } | undefined)?.project?.id,
  documentId: (result.context as { activeDocument?: { id?: string } } | undefined)?.activeDocument?.id,
  summary: result.message || "待确认的设计修改",
  operations: result.plannedOperations.filter(isExecutableOperation),
  requiresConfirmation: result.plannedOperations.some(isExecutableOperation),
  createdAt: new Date().toISOString(),
  createdBy: "agent",
});

const isExecutableOperation = (operation: ChangeOperation): boolean =>
  operation.tool === "easyeda_schematic_move_component" &&
  typeof operation.args.primitiveId === "string" &&
  typeof operation.args.x === "number" && Number.isFinite(operation.args.x) &&
  typeof operation.args.y === "number" && Number.isFinite(operation.args.y);

const buildPlanInstruction = (instruction: string, forceExecutionPlan: boolean): string => {
  if (!forceExecutionPlan) return instruction;
  return [
    "这是用户明确要求生成可执行修改计划的请求。",
    "请优先生成结构化写操作，不要只返回说明。",
    "如果缺少 primitiveId，先调用 easyeda_schematic_components 查找匹配的元件。",
    "信息足够时必须调用 easyeda_schematic_move_component；参数必须包含 primitiveId、x、y，并设置 preserveConnections=true。",
    "如果即使读取元件列表后仍然缺少关键信息，请明确指出需要用户补充什么，不要猜测参数。",
    `原始用户需求：${instruction}`,
  ].join("\n");
};

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
  store.saveTask(task);
  store.appendAuditEvent({ sessionId: task.sessionId, taskId: task.taskId, eventType: "task.executing" });
  const currentContext = await callTool("easyeda_get_context", task.sessionId, {});
  if (!currentContext.ok) {
    task.status = "failed";
    task.execution = {
      operations: [],
      verification: { ok: false, error: currentContext.error?.message ?? "无法在写入前读取当前设计。" },
    };
    task.updatedAt = new Date().toISOString();
    store.saveTask(task);
    store.appendAuditEvent({
      sessionId: task.sessionId,
      taskId: task.taskId,
      eventType: "task.failed",
      payload: task.execution,
    });
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
    store.saveTask(task);
    store.appendAuditEvent({
      sessionId: task.sessionId,
      taskId: task.taskId,
      eventType: "task.failed",
      payload: task.execution,
    });
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
  store.saveTask(task);
  store.appendAuditEvent({
    sessionId: task.sessionId,
    taskId: task.taskId,
    eventType: task.status === "completed" ? "task.completed" : "task.failed",
    payload: task.execution,
  });
  return task.status === "completed";
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

    if (request.method === "OPTIONS") {
      const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      const isLocalManagement = url.pathname.startsWith("/v1/mcp/") || url.pathname.startsWith("/v1/knowledge/");
      if (isLocalManagement && origin && !localAdminAllowedOrigins.has(origin)) {
        throw new HttpRequestError(403, `Local management origin is not allowed: ${origin}`);
      }
      response.writeHead(204, {
        "access-control-allow-origin": isLocalManagement && origin ? origin : "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,x-jlcircuit-admin-token",
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
        persistence: { type: "sqlite", status: "ready" },
        mcp: {
          configured: mcpRegistry.list().length,
          connected: mcpRegistry.list().filter((server) => server.status === "connected").length,
        },
        knowledge: {
          sources: knowledgeService.listSources().length,
          documents: knowledgeService.listSources().reduce((total, source) => total + source.documentCount, 0),
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/tools") {
      json(response, 200, {
        tools: [...builtinToolDefinitions, ...mcpRegistry.listToolDefinitions()],
        bridgeConnected: bridge.connected,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/mcp/servers") {
      json(response, 200, {
        configPath: mcpRegistry.path,
        servers: mcpRegistry.list(),
        diagnostics: mcpRegistry.getDiagnostics(),
        management: {
          localOnly: true,
          tokenRequired: Boolean(localAdminToken),
        },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/mcp/config") {
      requireLocalAdmin(request);
      json(response, 200, {
        configPath: mcpRegistry.path,
        configs: mcpRegistry.listConfigs(),
        servers: mcpRegistry.list(),
        diagnostics: mcpRegistry.getDiagnostics(),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/mcp/reload") {
      requireLocalAdmin(request);
      json(response, 200, await mcpRegistry.reload());
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/mcp/servers") {
      requireLocalAdmin(request);
      json(response, 201, await mcpRegistry.createServer(await readBody(request)));
      return;
    }

    const mcpConfigActionMatch = /^\/v1\/mcp\/servers\/([^/]+)\/(update|delete)$/.exec(url.pathname);
    if (request.method === "POST" && mcpConfigActionMatch) {
      requireLocalAdmin(request);
      const serverId = decodeURIComponent(mcpConfigActionMatch[1] as string);
      const result = mcpConfigActionMatch[2] === "update"
        ? await mcpRegistry.updateServer(serverId, await readBody(request))
        : await mcpRegistry.deleteServer(serverId);
      json(response, 200, result);
      return;
    }

    const mcpActionMatch = /^\/v1\/mcp\/servers\/([^/]+)\/(enable|disable|connect|disconnect|test)$/.exec(url.pathname);
    if (request.method === "POST" && mcpActionMatch) {
      requireLocalAdmin(request);
      const serverId = decodeURIComponent(mcpActionMatch[1] as string);
      const action = mcpActionMatch[2];
      const server = action === "enable"
        ? await mcpRegistry.setEnabled(serverId, true)
        : action === "disable"
          ? await mcpRegistry.setEnabled(serverId, false)
          : action === "connect"
            ? await mcpRegistry.connect(serverId)
            : action === "disconnect"
              ? await mcpRegistry.disconnect(serverId)
              : undefined;
      json(response, 200, action === "test" ? await mcpRegistry.testConnection(serverId) : { server });
      return;
    }

    const mcpCapabilitiesMatch = /^\/v1\/mcp\/servers\/([^/]+)\/capabilities$/.exec(url.pathname);
    if (request.method === "GET" && mcpCapabilitiesMatch) {
      requireLocalAdmin(request);
      const serverId = decodeURIComponent(mcpCapabilitiesMatch[1] as string);
      json(response, 200, mcpRegistry.getCapabilities(serverId));
      return;
    }

    const mcpResourceMatch = /^\/v1\/mcp\/servers\/([^/]+)\/resources(?:\/read)?$/.exec(url.pathname);
    if (mcpResourceMatch) {
      const serverId = decodeURIComponent(mcpResourceMatch[1] as string);
      if (request.method === "GET" && url.pathname.endsWith("/resources")) {
        json(response, 200, { serverId, resources: mcpRegistry.listResources(serverId) });
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/resources/read")) {
        const body = (await readBody(request)) as { uri?: string };
        if (!body.uri) {
          json(response, 400, { error: "invalid_request", message: "uri is required." });
          return;
        }
        json(response, 200, await mcpRegistry.readResource(serverId, body.uri));
        return;
      }
    }

    const mcpPromptMatch = /^\/v1\/mcp\/servers\/([^/]+)\/prompts(?:\/get)?$/.exec(url.pathname);
    if (mcpPromptMatch) {
      const serverId = decodeURIComponent(mcpPromptMatch[1] as string);
      if (request.method === "GET" && url.pathname.endsWith("/prompts")) {
        json(response, 200, { serverId, prompts: mcpRegistry.listPrompts(serverId) });
        return;
      }
      if (request.method === "POST" && url.pathname.endsWith("/prompts/get")) {
        const body = (await readBody(request)) as { name?: string; arguments?: Record<string, string> };
        if (!body.name) {
          json(response, 400, { error: "invalid_request", message: "name is required." });
          return;
        }
        json(response, 200, await mcpRegistry.getPrompt(serverId, body.name, body.arguments));
        return;
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/knowledge/sources") {
      requireLocalAdmin(request);
      json(response, 200, {
        sources: knowledgeService.listSources(),
        management: { localOnly: true, tokenRequired: Boolean(localAdminToken) },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/knowledge/sources") {
      requireLocalAdmin(request);
      json(response, 201, { source: knowledgeService.createSource(await readBody(request)) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/knowledge/reindex") {
      requireLocalAdmin(request);
      json(response, 200, { results: await knowledgeService.scanAll() });
      return;
    }

    const knowledgeSourceActionMatch = /^\/v1\/knowledge\/sources\/([^/]+)\/(update|delete|scan)$/.exec(url.pathname);
    if (request.method === "POST" && knowledgeSourceActionMatch) {
      requireLocalAdmin(request);
      const sourceIdValue = decodeURIComponent(knowledgeSourceActionMatch[1] as string);
      const action = knowledgeSourceActionMatch[2];
      const result = action === "update"
        ? { source: knowledgeService.updateSource(sourceIdValue, await readBody(request)) }
        : action === "delete"
          ? knowledgeService.deleteSource(sourceIdValue)
          : await knowledgeService.scanSource(sourceIdValue);
      json(response, 200, result);
      return;
    }

    const knowledgeDocumentsMatch = /^\/v1\/knowledge\/sources\/([^/]+)\/documents$/.exec(url.pathname);
    if (request.method === "GET" && knowledgeDocumentsMatch) {
      requireLocalAdmin(request);
      const sourceIdValue = decodeURIComponent(knowledgeDocumentsMatch[1] as string);
      json(response, 200, { sourceId: sourceIdValue, documents: knowledgeService.listDocuments(sourceIdValue) });
      return;
    }

    if (request.method === "POST" && (url.pathname === "/v1/knowledge/search" || url.pathname === "/v1/knowledge/read")) {
      requireLocalAdmin(request);
      const body = await readBody(request);
      const result = await knowledgeService.callTool(
        url.pathname.endsWith("/search") ? "knowledge_search" : "knowledge_read",
        "knowledge-manager-ui",
        isRecord(body) ? body : {},
      );
      json(response, result.ok ? 200 : 400, result);
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/skills") {
      json(response, 200, { skills: skillRegistry.list(), diagnostics: skillRegistry.getDiagnostics() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/skills/reload") {
      const result = skillRegistry.reload();
      store.appendAuditEvent({ eventType: "skills.reloaded", payload: result });
      json(response, 200, result);
      return;
    }

    const skillStateMatch = /^\/v1\/skills\/([^/]+)\/(enable|disable)$/.exec(url.pathname);
    if (request.method === "POST" && skillStateMatch) {
      const skillId = decodeURIComponent(skillStateMatch[1] as string);
      const enabled = skillStateMatch[2] === "enable";
      const skill = skillRegistry.setEnabled(skillId, enabled);
      store.appendAuditEvent({ eventType: enabled ? "skill.enabled" : "skill.disabled", payload: { skillId } });
      json(response, 200, { skill });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/sessions") {
      const body = (await readBody(request)) as { projectId?: string };
      const session = store.createSession(body.projectId);
      store.appendAuditEvent({ sessionId: session.id, eventType: "session.created", payload: { projectId: session.projectId } });
      json(response, 201, { sessionId: session.id, projectId: session.projectId ?? null, status: "created" });
      return;
    }

    const sessionPath = url.pathname.startsWith("/v1/sessions/")
      ? url.pathname.slice("/v1/sessions/".length)
      : undefined;
    if (request.method === "GET" && sessionPath && !sessionPath.includes("/")) {
      const sessionId = decodeURIComponent(sessionPath);
      const session = store.getSession(sessionId) ?? store.ensureSession(sessionId);
      json(response, 200, {
        session,
        messages: store.listMessages(sessionId, 100),
        tasks: store.listTasksForSession(sessionId, 20),
      });
      return;
    }
    if (request.method === "GET" && sessionPath?.endsWith("/audit")) {
      const sessionId = decodeURIComponent(sessionPath.slice(0, -"/audit".length));
      store.ensureSession(sessionId);
      json(response, 200, { sessionId, events: store.listAuditEvents(sessionId, 200) });
      return;
    }
    if (request.method === "POST" && sessionPath?.endsWith("/clear")) {
      const sessionId = decodeURIComponent(sessionPath.slice(0, -"/clear".length));
      store.ensureSession(sessionId);
      store.clearConversation(sessionId);
      store.appendAuditEvent({ sessionId, eventType: "session.conversation_cleared" });
      json(response, 200, { sessionId, status: "cleared" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/stream") {
      const body = (await readBody(request)) as { sessionId?: string; instruction?: string; skillIds?: string[] };
      const sessionId = body.sessionId ?? "default";
      const instruction = body.instruction?.trim();
      log(`[http] POST ${url.pathname}`, { sessionId, instructionLength: instruction?.length ?? 0 });
      if (!instruction) {
        json(response, 400, { error: "invalid_request", message: "instruction is required." });
        return;
      }

      startSse(response);
      const abortController = new AbortController();
      const heartbeat = setInterval(() => {
        if (!response.destroyed && !response.writableEnded) response.write(": jlcircuit heartbeat\n\n");
      }, 15_000);
      response.on("close", () => {
        if (!response.writableEnded) abortController.abort(new Error("EDA client disconnected from the Agent stream."));
      });
      writeSse(response, "connected", { sessionId, status: "running", startedAt: new Date().toISOString() });
      try {
        const result = await runModelTurn(
          sessionId,
          instruction,
          "chat",
          instruction,
          body.skillIds,
          {
            signal: abortController.signal,
            onEvent: (event) => writeSse(response, event.type, event),
          },
        );
        writeSse(response, "result", { sessionId, ...result });
        writeSse(response, "done", { sessionId, status: result.status });
      } catch (error) {
        if (!abortController.signal.aborted) {
          writeSse(response, "error", {
            error: "agent_stream_failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        clearInterval(heartbeat);
        if (!response.writableEnded) response.end();
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/chat") {
      const body = (await readBody(request)) as { sessionId?: string; instruction?: string; skillIds?: string[] };
      const sessionId = body.sessionId ?? "default";
      const instruction = body.instruction?.trim();
      log(`[http] POST ${url.pathname}`, { sessionId, instructionLength: instruction?.length ?? 0 });
      if (!instruction) {
        json(response, 400, { error: "invalid_request", message: "instruction is required." });
        return;
      }
      const result = await runModelTurn(sessionId, instruction, "chat", instruction, body.skillIds);
      json(response, 200, { sessionId, ...result });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/plan") {
      const body = (await readBody(request)) as { sessionId?: string; instruction?: string; forceExecutionPlan?: boolean; skillIds?: string[] };
      const sessionId = body.sessionId ?? "default";
      const instruction = body.instruction?.trim();
      const forceExecutionPlan = body.forceExecutionPlan === true;
      log(`[http] POST ${url.pathname}`, { sessionId, instructionLength: instruction?.length ?? 0, forceExecutionPlan });
      if (!instruction) {
        json(response, 400, { error: "invalid_request", message: "instruction is required." });
        return;
      }
      const result = await runModelTurn(
        sessionId,
        buildPlanInstruction(instruction, forceExecutionPlan),
        "plan",
        instruction,
        body.skillIds,
      );
      const changeSet = createChangeSet(result);
      const now = new Date().toISOString();
      const taskStatus: AgentTask["status"] = changeSet.operations.length > 0
        ? "waiting_confirmation"
        : result.status === "awaiting_user" || result.status === "incomplete"
          ? "awaiting_user"
          : result.status === "blocked"
            ? "failed"
            : "completed";
      const task: AgentTask = {
        taskId: crypto.randomUUID(),
        sessionId,
        instruction,
        status: taskStatus,
        model: result.model,
        message: result.message,
        context: result.context,
        toolTrace: result.toolTrace,
        changeSet,
        confirmationToken: changeSet.operations.length > 0 ? crypto.randomUUID() : undefined,
        skills: result.skills.map(({ id, name, version, reason }) => ({ id, name, version, reason })),
        createdAt: now,
        updatedAt: now,
      };
      store.saveTask(task);
      store.appendAuditEvent({
        sessionId,
        taskId: task.taskId,
        eventType: "task.created",
        payload: { status: task.status, operationCount: task.changeSet.operations.length },
      });
      json(response, 200, taskView(task));
      return;
    }

    const taskIdForGet = request.method === "GET" && url.pathname.startsWith("/v1/tasks/")
      ? url.pathname.slice("/v1/tasks/".length)
      : undefined;
    if (taskIdForGet) {
      const task = store.getTask(taskIdForGet);
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
      const task = store.getTask(taskIdForConfirm);
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
      task.updatedAt = new Date().toISOString();
      store.saveTask(task);
      store.appendAuditEvent({ sessionId: task.sessionId, taskId: task.taskId, eventType: "task.confirmed" });
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
        store.saveTask(task);
        store.appendAuditEvent({
          sessionId: task.sessionId,
          taskId: task.taskId,
          eventType: "task.failed",
          payload: task.execution,
        });
      }
      json(response, succeeded ? 200 : 502, taskView(task));
      return;
    }

    const taskIdForCancel = request.method === "POST"
      ? getTaskIdFromPath(url.pathname, "/cancel")
      : undefined;
    if (taskIdForCancel) {
      const task = store.getTask(taskIdForCancel);
      if (!task) {
        json(response, 404, { error: "not_found", message: "task not found" });
        return;
      }
      if (task.status === "waiting_confirmation") {
        task.confirmationToken = undefined;
        task.status = "cancelled";
        task.updatedAt = new Date().toISOString();
        store.saveTask(task);
        store.appendAuditEvent({ sessionId: task.sessionId, taskId: task.taskId, eventType: "task.cancelled" });
      }
      json(response, 200, taskView(task));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/context") {
      const body = (await readBody(request)) as { sessionId?: string };
      log("[http] POST /v1/context", { sessionId: body.sessionId ?? "default" });
      const sessionId = body.sessionId ?? "default";
      const result = await contextEngine.captureDesignContext(
        sessionId,
        () => callTool("easyeda_get_context", sessionId, {}),
      );
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
    if (error instanceof HttpRequestError) {
      json(response, error.statusCode, { error: "request_forbidden", message: error.message });
      return;
    }
    if (error instanceof SkillRegistryError) {
      json(response, error.code === "SKILL_NOT_FOUND" ? 404 : 400, {
        error: error.code.toLowerCase(),
        message: error.message,
      });
      return;
    }
    if (error instanceof McpRegistryError) {
      json(response, error.code.endsWith("NOT_FOUND")
        ? 404
        : error.code === "MCP_SERVER_EXISTS"
          ? 409
          : error.code === "MCP_CONNECTION_FAILED"
            ? 502
            : 400, {
        error: error.code.toLowerCase(),
        message: error.message,
      });
      return;
    }
    if (error instanceof KnowledgeServiceError) {
      json(response, error.code.endsWith("NOT_FOUND")
        ? 404
        : error.code === "KNOWLEDGE_SOURCE_EXISTS"
          ? 409
          : 400, {
        error: error.code.toLowerCase(),
        message: error.message,
      });
      return;
    }
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
  console.log(`Session database: ${store.path}`);
  console.log(`MCP config: ${mcpRegistry.path}`);
  console.log(`Local management: loopback only, admin token ${localAdminToken ? "required" : "not configured"}`);
  void mcpRegistry.start().catch((error) => log("[mcp] startup failed", {
    error: error instanceof Error ? error.message : String(error),
  }));
});

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  log("[service] shutting down", { signal });
  bridge.close();
  server.close(async () => {
    bridgeServer.close();
    await mcpRegistry.close();
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
