import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Prompt,
  type Resource,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import type { EdaToolDefinition, RiskLevel, ToolContent, ToolResponse } from "../../../packages/contracts/src/index.ts";
import type { AgentStore } from "./storage.ts";

export type McpTransportConfig =
  | {
      type: "stdio";
      command: string;
      args: string[];
      cwd?: string;
      env: string[];
    }
  | {
      type: "http";
      url: string;
      bearerTokenEnv?: string;
    };

export type McpServerConfig = {
  id: string;
  name: string;
  enabledByDefault: boolean;
  transport: McpTransportConfig;
  allowedTools: string[];
  defaultRiskLevel: RiskLevel;
  toolRiskLevels: Record<string, RiskLevel>;
  allowResources: boolean;
  allowPrompts: boolean;
};

export type McpDiagnostic = {
  level: "warning" | "error";
  serverId?: string;
  message: string;
};

export type McpServerStatus = "disabled" | "disconnected" | "connecting" | "connected" | "error";

export type McpServerView = {
  id: string;
  name: string;
  enabled: boolean;
  status: McpServerStatus;
  transport: { type: "stdio"; command: string } | { type: "http"; url: string };
  serverInfo?: { name: string; version: string };
  protocolEra?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  connectedAt?: string;
  error?: string;
};

export type McpToolRecord = {
  publicName: string;
  serverId: string;
  remoteName: string;
  riskLevel: RiskLevel;
  definition: EdaToolDefinition;
};

type McpRuntime = {
  config: McpServerConfig;
  status: McpServerStatus;
  client?: Client;
  transport?: Transport;
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
  serverInfo?: { name: string; version: string };
  protocolEra?: string;
  connectedAt?: string;
  error?: string;
};

type RegistryOptions = {
  configPath?: string;
  autoConnect?: boolean;
  requestTimeoutMs?: number;
  maxServers?: number;
  maxToolsPerServer?: number;
  maxToolSchemaChars?: number;
  maxResultChars?: number;
};

export class McpRegistryError extends Error {
  public readonly code:
    | "MCP_SERVER_NOT_FOUND"
    | "MCP_SERVER_DISABLED"
    | "MCP_SERVER_NOT_CONNECTED"
    | "MCP_CONNECTION_FAILED"
    | "MCP_TOOL_NOT_FOUND"
    | "MCP_RESOURCE_FORBIDDEN"
    | "MCP_PROMPT_FORBIDDEN"
    | "MCP_CONFIG_INVALID";

  public constructor(code: McpRegistryError["code"], message: string) {
    super(message);
    this.name = "McpRegistryError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isEnabled = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const asStringArray = (value: unknown, fallback: string[] = []): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...new Set(value.map((item) => item.trim()).filter(Boolean))]
    : fallback;

const riskLevel = (value: unknown, fallback: RiskLevel = "high"): RiskLevel =>
  ["read", "low", "medium", "high"].includes(String(value)) ? String(value) as RiskLevel : fallback;

const safeServerId = (value: unknown): string => {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z][a-z0-9-]{1,47}$/.test(id)) {
    throw new Error("server id must match ^[a-z][a-z0-9-]{1,47}$.");
  }
  return id;
};

const validateHttpUrl = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error("HTTP transport requires url.");
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("MCP HTTP URL must use HTTPS, except loopback HTTP endpoints.");
  }
  return url.toString();
};

const parseServerConfig = (value: unknown, configDirectory: string): McpServerConfig => {
  if (!isRecord(value)) throw new Error("server entry must be an object.");
  const id = safeServerId(value.id);
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : id;
  if (!isRecord(value.transport)) throw new Error(`MCP server ${id} requires transport.`);
  let transport: McpTransportConfig;
  if (value.transport.type === "stdio") {
    const command = typeof value.transport.command === "string" ? value.transport.command.trim() : "";
    if (!command) throw new Error(`MCP stdio server ${id} requires command.`);
    const cwdValue = typeof value.transport.cwd === "string" && value.transport.cwd.trim()
      ? value.transport.cwd.trim()
      : undefined;
    if (value.transport.args !== undefined &&
        (!Array.isArray(value.transport.args) || value.transport.args.some((item) => typeof item !== "string"))) {
      throw new Error(`MCP stdio server ${id} args must be a string array.`);
    }
    const args = Array.isArray(value.transport.args) ? [...value.transport.args] as string[] : [];
    if (value.transport.env !== undefined &&
        (!Array.isArray(value.transport.env) || value.transport.env.some((item) => typeof item !== "string"))) {
      throw new Error(`MCP stdio server ${id} env must be a string array.`);
    }
    const env = asStringArray(value.transport.env);
    if (env.some((item) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item))) {
      throw new Error(`MCP stdio server ${id} contains an invalid environment variable name.`);
    }
    transport = {
      type: "stdio",
      command,
      args,
      cwd: cwdValue ? (isAbsolute(cwdValue) ? cwdValue : resolve(configDirectory, cwdValue)) : undefined,
      env,
    };
  } else if (value.transport.type === "http") {
    const bearerTokenEnv = typeof value.transport.bearerTokenEnv === "string"
      ? value.transport.bearerTokenEnv.trim()
      : undefined;
    if (bearerTokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerTokenEnv)) {
      throw new Error(`MCP HTTP server ${id} contains an invalid bearerTokenEnv.`);
    }
    transport = { type: "http", url: validateHttpUrl(value.transport.url), bearerTokenEnv };
  } else {
    throw new Error(`MCP server ${id} transport.type must be stdio or http.`);
  }

  const toolRiskLevels: Record<string, RiskLevel> = {};
  if (value.toolRiskLevels !== undefined) {
    if (!isRecord(value.toolRiskLevels)) throw new Error(`MCP server ${id} toolRiskLevels must be an object.`);
    for (const [tool, level] of Object.entries(value.toolRiskLevels)) {
      if (!tool.trim()) throw new Error(`MCP server ${id} has an empty toolRiskLevels key.`);
      toolRiskLevels[tool] = riskLevel(level);
    }
  }
  return {
    id,
    name,
    enabledByDefault: value.enabledByDefault === true,
    transport,
    allowedTools: asStringArray(value.allowedTools),
    defaultRiskLevel: riskLevel(value.defaultRiskLevel, "high"),
    toolRiskLevels,
    allowResources: value.allowResources === true,
    allowPrompts: value.allowPrompts === true,
  };
};

const toolAllowedByServer = (config: McpServerConfig, toolName: string): boolean =>
  config.allowedTools.includes("*") || config.allowedTools.includes(toolName);

const namespacePart = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "tool";

const publicToolName = (serverId: string, remoteName: string): string => {
  const base = `mcp__${namespacePart(serverId)}__${namespacePart(remoteName)}`;
  if (base.length <= 64) return base;
  const hash = createHash("sha256").update(`${serverId}:${remoteName}`).digest("hex").slice(0, 8);
  return `${base.slice(0, 55)}_${hash}`;
};

const transportView = (config: McpServerConfig): McpServerView["transport"] =>
  config.transport.type === "stdio"
    ? { type: "stdio", command: config.transport.command }
    : { type: "http", url: config.transport.url };

const normalizeToolSchema = (schema: unknown): Record<string, unknown> =>
  isRecord(schema) ? schema : { type: "object", additionalProperties: true };

const truncatedText = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[MCP result truncated]`;

const boundedValue = (value: unknown, maxChars: number): unknown => {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return value;
    if (serialized.length <= maxChars) return value;
    return { truncated: true, charLength: serialized.length, preview: serialized.slice(0, maxChars) };
  } catch (error) {
    return { serializationError: error instanceof Error ? error.message : String(error) };
  }
};

const redactSensitive = (value: unknown, depth = 0): unknown => {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    /(authorization|password|secret|token|api[_-]?key)/i.test(key)
      ? "[REDACTED]"
      : redactSensitive(item, depth + 1),
  ]));
};

const resultContent = (result: CallToolResult, maxChars: number): ToolContent[] => {
  const output: ToolContent[] = [];
  let remaining = maxChars;
  for (const item of result.content ?? []) {
    if (!isRecord(item) || remaining <= 0) break;
    if (item.type === "text" && typeof item.text === "string") {
      const text = truncatedText(item.text, remaining);
      output.push({ type: "text", text });
      remaining -= text.length;
      continue;
    }
    if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      if (item.data.length > remaining) {
        output.push({ type: "text", text: `[MCP image omitted: ${item.data.length} Base64 characters exceeds result budget]` });
      } else {
        output.push({ type: "image", data: item.data, mimeType: item.mimeType });
        remaining -= item.data.length;
      }
      continue;
    }
    const serialized = truncatedText(JSON.stringify(item), remaining);
    output.push({ type: "text", text: serialized });
    remaining -= serialized.length;
  }
  return output;
};

export class McpRegistry {
  private readonly store: AgentStore;
  private readonly log: (message: string, details?: unknown) => void;
  private readonly configPath: string;
  private readonly autoConnect: boolean;
  private readonly requestTimeoutMs: number;
  private readonly maxServers: number;
  private readonly maxToolsPerServer: number;
  private readonly maxToolSchemaChars: number;
  private readonly maxResultChars: number;
  private runtimes = new Map<string, McpRuntime>();
  private tools = new Map<string, McpToolRecord>();
  private diagnostics: McpDiagnostic[] = [];
  private readonly connecting = new Map<string, Promise<McpServerView>>();

  public get path(): string {
    return this.configPath;
  }

  public constructor(
    store: AgentStore,
    log: (message: string, details?: unknown) => void = () => undefined,
    options: RegistryOptions = {},
  ) {
    this.store = store;
    this.log = log;
    this.configPath = resolve(
      options.configPath ?? (process.env.JLCIRCUIT_MCP_CONFIG?.trim() || ".jlcircuit-data/mcp-servers.json"),
    );
    this.autoConnect = options.autoConnect ?? isEnabled(process.env.JLCIRCUIT_MCP_AUTO_CONNECT, true);
    this.requestTimeoutMs = options.requestTimeoutMs ??
      positiveInteger(process.env.JLCIRCUIT_MCP_REQUEST_TIMEOUT_MS, 15_000);
    this.maxServers = options.maxServers ?? positiveInteger(process.env.JLCIRCUIT_MCP_MAX_SERVERS, 16);
    this.maxToolsPerServer = options.maxToolsPerServer ??
      positiveInteger(process.env.JLCIRCUIT_MCP_MAX_TOOLS_PER_SERVER, 100);
    this.maxToolSchemaChars = options.maxToolSchemaChars ??
      positiveInteger(process.env.JLCIRCUIT_MCP_MAX_TOOL_SCHEMA_CHARS, 20_000);
    this.maxResultChars = options.maxResultChars ??
      positiveInteger(process.env.JLCIRCUIT_MCP_MAX_RESULT_CHARS, 1_000_000);
    this.loadInitialConfig();
  }

  private readConfig(): { configs: McpServerConfig[]; diagnostics: McpDiagnostic[] } {
    if (!existsSync(this.configPath)) return { configs: [], diagnostics: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.configPath, "utf8"));
    } catch (error) {
      throw new McpRegistryError("MCP_CONFIG_INVALID", `Cannot parse MCP config: ${String(error)}`);
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.servers)) {
      throw new McpRegistryError("MCP_CONFIG_INVALID", "MCP config requires schemaVersion=1 and servers[].");
    }
    if (parsed.servers.length > this.maxServers) {
      throw new McpRegistryError("MCP_CONFIG_INVALID", `MCP config exceeds ${this.maxServers} servers.`);
    }
    const configs: McpServerConfig[] = [];
    const diagnostics: McpDiagnostic[] = [];
    const ids = new Set<string>();
    for (const item of parsed.servers) {
      try {
        const config = parseServerConfig(item, dirname(this.configPath));
        if (ids.has(config.id)) throw new Error(`Duplicate MCP server id: ${config.id}`);
        ids.add(config.id);
        configs.push(config);
      } catch (error) {
        diagnostics.push({ level: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { configs, diagnostics };
  }

  private loadInitialConfig(): void {
    try {
      const loaded = this.readConfig();
      this.diagnostics = loaded.diagnostics;
      this.applyConfigs(loaded.configs);
    } catch (error) {
      this.diagnostics = [{ level: "error", message: error instanceof Error ? error.message : String(error) }];
    }
  }

  private applyConfigs(configs: McpServerConfig[]): void {
    const states = this.store.listMcpServerStates();
    this.runtimes = new Map(configs.map((config) => {
      const enabled = states.get(config.id) ?? config.enabledByDefault;
      return [config.id, {
        config,
        status: enabled ? "disconnected" : "disabled",
        tools: [],
        resources: [],
        prompts: [],
      } satisfies McpRuntime];
    }));
    this.rebuildTools();
  }

  public async start(): Promise<void> {
    if (!this.autoConnect) return;
    await Promise.allSettled(
      [...this.runtimes.values()]
        .filter((runtime) => this.isRuntimeEnabled(runtime))
        .map((runtime) => this.connect(runtime.config.id)),
    );
  }

  public async close(): Promise<void> {
    await Promise.allSettled([...this.runtimes.keys()].map((serverId) => this.disconnect(serverId)));
  }

  public async reload(): Promise<{ servers: McpServerView[]; diagnostics: McpDiagnostic[] }> {
    const loaded = this.readConfig();
    await this.close();
    this.diagnostics = loaded.diagnostics;
    this.applyConfigs(loaded.configs);
    await this.start();
    this.store.appendAuditEvent({ eventType: "mcp.registry_reloaded", payload: { serverCount: loaded.configs.length } });
    return { servers: this.list(), diagnostics: this.getDiagnostics() };
  }

  private isRuntimeEnabled(runtime: McpRuntime): boolean {
    return this.store.listMcpServerStates().get(runtime.config.id) ?? runtime.config.enabledByDefault;
  }

  public list(): McpServerView[] {
    return [...this.runtimes.values()].map((runtime) => ({
      id: runtime.config.id,
      name: runtime.config.name,
      enabled: this.isRuntimeEnabled(runtime),
      status: runtime.status,
      transport: transportView(runtime.config),
      serverInfo: runtime.serverInfo,
      protocolEra: runtime.protocolEra,
      toolCount: runtime.tools.filter((tool) => toolAllowedByServer(runtime.config, tool.name)).length,
      resourceCount: runtime.resources.length,
      promptCount: runtime.prompts.length,
      connectedAt: runtime.connectedAt,
      error: runtime.error,
    })).sort((left, right) => left.id.localeCompare(right.id));
  }

  public getDiagnostics(): McpDiagnostic[] {
    return this.diagnostics.map((item) => ({ ...item }));
  }

  public async setEnabled(serverId: string, enabled: boolean): Promise<McpServerView> {
    const runtime = this.getRuntime(serverId);
    this.store.setMcpServerEnabled(serverId, enabled);
    this.store.appendAuditEvent({ eventType: enabled ? "mcp.server_enabled" : "mcp.server_disabled", payload: { serverId } });
    if (!enabled) {
      await this.disconnect(serverId);
      runtime.status = "disabled";
    } else if (this.autoConnect) {
      return this.connect(serverId);
    } else {
      runtime.status = "disconnected";
    }
    return this.view(serverId);
  }

  public async connect(serverId: string): Promise<McpServerView> {
    const existing = this.connecting.get(serverId);
    if (existing) return existing;
    const promise = this.connectInternal(serverId).finally(() => this.connecting.delete(serverId));
    this.connecting.set(serverId, promise);
    return promise;
  }

  private async connectInternal(serverId: string): Promise<McpServerView> {
    const runtime = this.getRuntime(serverId);
    if (!this.isRuntimeEnabled(runtime)) {
      throw new McpRegistryError("MCP_SERVER_DISABLED", `MCP server is disabled: ${serverId}`);
    }
    if (runtime.status === "connected" && runtime.client) return this.view(serverId);
    if (runtime.client) await this.disconnect(serverId);
    runtime.status = "connecting";
    runtime.error = undefined;
    this.log("[mcp] connection started", { serverId, transport: runtime.config.transport.type });
    const client = new Client(
      { name: "jlcircuit-agent", version: "0.1.0" },
      { versionNegotiation: { mode: "auto", probe: { timeoutMs: Math.min(this.requestTimeoutMs, 5_000) } } },
    );
    let transport: Transport;
    if (runtime.config.transport.type === "stdio") {
      const inherited = getDefaultEnvironment();
      const requested = Object.fromEntries(runtime.config.transport.env.flatMap((name) => {
        const value = process.env[name];
        return value === undefined ? [] : [[name, value]];
      }));
      transport = new StdioClientTransport({
        command: runtime.config.transport.command,
        args: runtime.config.transport.args,
        cwd: runtime.config.transport.cwd,
        env: { ...inherited, ...requested },
        stderr: "ignore",
      });
    } else {
      const tokenEnv = runtime.config.transport.bearerTokenEnv;
      transport = new StreamableHTTPClientTransport(new URL(runtime.config.transport.url), {
        authProvider: tokenEnv ? {
          token: async () => {
            const token = process.env[tokenEnv];
            if (!token) throw new Error(`MCP bearer token environment variable is not set: ${tokenEnv}`);
            return token;
          },
        } : undefined,
        onInsufficientScope: "throw",
      });
    }
    try {
      await client.connect(transport, { timeout: this.requestTimeoutMs });
      const [toolResult, resourceResult, promptResult] = await Promise.all([
        client.listTools(undefined, { timeout: this.requestTimeoutMs }),
        client.listResources(undefined, { timeout: this.requestTimeoutMs }),
        client.listPrompts(undefined, { timeout: this.requestTimeoutMs }),
      ]);
      if (toolResult.tools.length > this.maxToolsPerServer) {
        throw new Error(`MCP server ${serverId} exposes more than ${this.maxToolsPerServer} tools.`);
      }
      runtime.client = client;
      runtime.transport = transport;
      runtime.tools = toolResult.tools;
      runtime.resources = resourceResult.resources;
      runtime.prompts = promptResult.prompts;
      const serverInfo = client.getServerVersion();
      runtime.serverInfo = serverInfo ? { name: serverInfo.name, version: serverInfo.version } : undefined;
      runtime.protocolEra = client.getProtocolEra();
      runtime.connectedAt = new Date().toISOString();
      runtime.status = "connected";
      this.rebuildTools();
      this.store.appendAuditEvent({
        eventType: "mcp.server_connected",
        payload: {
          serverId,
          serverInfo: runtime.serverInfo,
          toolCount: runtime.tools.length,
          resourceCount: runtime.resources.length,
          promptCount: runtime.prompts.length,
        },
      });
      this.log("[mcp] connection ready", { serverId, tools: runtime.tools.length });
      return this.view(serverId);
    } catch (error) {
      await client.close().catch(() => undefined);
      runtime.client = undefined;
      runtime.transport = undefined;
      runtime.tools = [];
      runtime.resources = [];
      runtime.prompts = [];
      runtime.status = "error";
      runtime.error = error instanceof Error ? error.message : String(error);
      this.rebuildTools();
      this.store.appendAuditEvent({ eventType: "mcp.server_failed", payload: { serverId, error: runtime.error } });
      this.log("[mcp] connection failed", { serverId, error: runtime.error });
      throw new McpRegistryError("MCP_CONNECTION_FAILED", `MCP connection failed for ${serverId}: ${runtime.error}`);
    }
  }

  public async disconnect(serverId: string): Promise<McpServerView> {
    const runtime = this.getRuntime(serverId);
    const transport = runtime.transport as (Transport & { terminateSession?: () => Promise<void> }) | undefined;
    if (transport?.terminateSession) await transport.terminateSession().catch(() => undefined);
    if (runtime.client) await runtime.client.close().catch(() => undefined);
    runtime.client = undefined;
    runtime.transport = undefined;
    runtime.tools = [];
    runtime.resources = [];
    runtime.prompts = [];
    runtime.serverInfo = undefined;
    runtime.protocolEra = undefined;
    runtime.connectedAt = undefined;
    runtime.error = undefined;
    runtime.status = this.isRuntimeEnabled(runtime) ? "disconnected" : "disabled";
    this.rebuildTools();
    return this.view(serverId);
  }

  private rebuildTools(): void {
    const tools = new Map<string, McpToolRecord>();
    for (const runtime of this.runtimes.values()) {
      if (runtime.status !== "connected") continue;
      for (const tool of runtime.tools) {
        if (!toolAllowedByServer(runtime.config, tool.name)) continue;
        const publicName = publicToolName(runtime.config.id, tool.name);
        if (tools.has(publicName)) {
          this.diagnostics.push({
            level: "error",
            serverId: runtime.config.id,
            message: `MCP tool namespace collision: ${publicName}`,
          });
          continue;
        }
        const level = runtime.config.toolRiskLevels[tool.name] ?? runtime.config.defaultRiskLevel;
        const schema = normalizeToolSchema(tool.inputSchema);
        if (JSON.stringify(schema).length > this.maxToolSchemaChars) {
          const message = `MCP tool schema exceeds ${this.maxToolSchemaChars} characters: ${runtime.config.id}/${tool.name}`;
          if (!this.diagnostics.some((item) => item.serverId === runtime.config.id && item.message === message)) {
            this.diagnostics.push({ level: "error", serverId: runtime.config.id, message });
          }
          continue;
        }
        tools.set(publicName, {
          publicName,
          serverId: runtime.config.id,
          remoteName: tool.name,
          riskLevel: level,
          definition: {
            name: publicName,
            description: `[MCP:${runtime.config.name}] ${String(tool.description || tool.name).slice(0, 2_000)}`,
            riskLevel: level,
            beta: true,
            inputSchema: schema,
            enabled: true,
          },
        });
      }
    }
    this.tools = tools;
  }

  public listToolDefinitions(): EdaToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({ ...tool.definition }));
  }

  public getTool(publicName: string): McpToolRecord | undefined {
    return this.tools.get(publicName);
  }

  public async callTool(
    publicName: string,
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResponse> {
    const tool = this.tools.get(publicName);
    if (!tool) throw new McpRegistryError("MCP_TOOL_NOT_FOUND", `MCP tool not found: ${publicName}`);
    const runtime = this.requireConnected(tool.serverId);
    const requestId = crypto.randomUUID();
    this.store.appendAuditEvent({
      sessionId,
      eventType: "mcp.tool_requested",
      payload: {
        serverId: tool.serverId,
        publicName,
        remoteName: tool.remoteName,
        riskLevel: tool.riskLevel,
        arguments: boundedValue(redactSensitive(args), 8_000),
      },
    });
    try {
      const result = await runtime.client.callTool(
        { name: tool.remoteName, arguments: args },
        { timeout: this.requestTimeoutMs },
      );
      const response: ToolResponse = {
        requestId,
        ok: result.isError !== true,
        data: {
          serverId: tool.serverId,
          remoteTool: tool.remoteName,
          structuredContent: boundedValue(result.structuredContent, this.maxResultChars),
        },
        content: resultContent(result, this.maxResultChars),
        error: result.isError === true
          ? { code: "MCP_TOOL_ERROR", message: "MCP tool reported an error.", retryable: false }
          : undefined,
      };
      this.store.appendAuditEvent({
        sessionId,
        eventType: response.ok ? "mcp.tool_completed" : "mcp.tool_failed",
        payload: { serverId: tool.serverId, publicName, remoteName: tool.remoteName, ok: response.ok },
      });
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.appendAuditEvent({
        sessionId,
        eventType: "mcp.tool_failed",
        payload: { serverId: tool.serverId, publicName, remoteName: tool.remoteName, error: message },
      });
      return { requestId, ok: false, error: { code: "MCP_PROTOCOL_ERROR", message, retryable: true } };
    }
  }

  public listResources(serverId: string): Resource[] {
    const runtime = this.requireConnected(serverId);
    if (!runtime.config.allowResources) {
      throw new McpRegistryError("MCP_RESOURCE_FORBIDDEN", `MCP resources are not allowed for server: ${serverId}`);
    }
    return runtime.resources.map((resource) => ({ ...resource }));
  }

  public async readResource(serverId: string, uri: string): Promise<unknown> {
    const runtime = this.requireConnected(serverId);
    if (!runtime.config.allowResources) {
      throw new McpRegistryError("MCP_RESOURCE_FORBIDDEN", `MCP resources are not allowed for server: ${serverId}`);
    }
    if (!runtime.resources.some((resource) => resource.uri === uri)) {
      throw new McpRegistryError("MCP_RESOURCE_FORBIDDEN", `MCP resource was not discovered or allowlisted: ${uri}`);
    }
    const result = await runtime.client.readResource({ uri }, { timeout: this.requestTimeoutMs });
    return boundedValue(result, this.maxResultChars);
  }

  public listPrompts(serverId: string): Prompt[] {
    const runtime = this.requireConnected(serverId);
    if (!runtime.config.allowPrompts) {
      throw new McpRegistryError("MCP_PROMPT_FORBIDDEN", `MCP prompts are not allowed for server: ${serverId}`);
    }
    return runtime.prompts.map((prompt) => ({ ...prompt }));
  }

  public async getPrompt(serverId: string, name: string, args?: Record<string, string>): Promise<unknown> {
    const runtime = this.requireConnected(serverId);
    if (!runtime.config.allowPrompts) {
      throw new McpRegistryError("MCP_PROMPT_FORBIDDEN", `MCP prompts are not allowed for server: ${serverId}`);
    }
    if (!runtime.prompts.some((prompt) => prompt.name === name)) {
      throw new McpRegistryError("MCP_PROMPT_FORBIDDEN", `MCP prompt was not discovered or allowlisted: ${name}`);
    }
    const result = await runtime.client.getPrompt({ name, arguments: args }, { timeout: this.requestTimeoutMs });
    return boundedValue(result, this.maxResultChars);
  }

  private getRuntime(serverId: string): McpRuntime {
    const runtime = this.runtimes.get(serverId);
    if (!runtime) throw new McpRegistryError("MCP_SERVER_NOT_FOUND", `MCP server not found: ${serverId}`);
    return runtime;
  }

  private requireConnected(serverId: string): McpRuntime & { client: Client } {
    const runtime = this.getRuntime(serverId);
    if (runtime.status !== "connected" || !runtime.client) {
      throw new McpRegistryError("MCP_SERVER_NOT_CONNECTED", `MCP server is not connected: ${serverId}`);
    }
    return runtime as McpRuntime & { client: Client };
  }

  private view(serverId: string): McpServerView {
    const view = this.list().find((item) => item.id === serverId);
    if (!view) throw new McpRegistryError("MCP_SERVER_NOT_FOUND", `MCP server not found: ${serverId}`);
    return view;
  }
}
