import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import type {
  ChangeOperation,
  EdaToolDefinition,
  ToolResponse,
} from "../../../packages/contracts/src/index.ts";
import type { PreparedAgentContext } from "./context-engine.ts";
import type { AgentRunEvent, AgentTokenUsage, AgentTurnResult, WriteApprovalRequester } from "./llm.ts";
import type { ResolvedSkill } from "./skill-registry.ts";
import type { AgentStore } from "./storage.ts";

type Logger = (message: string, details?: unknown) => void;
type JsonRecord = Record<string, unknown>;
type ToolExecutor = (
  toolName: string,
  sessionId: string,
  payload: Record<string, unknown>,
) => Promise<ToolResponse>;

export type CodexProviderModelMetadata = {
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities: Array<"text" | "image">;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
};

export type CodexProviderDefinition = {
  name: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  enabled: boolean;
  wireApi: "responses";
  reasoningEffort?: string;
  requestMaxRetries?: number;
  streamMaxRetries?: number;
  streamIdleTimeoutMs?: number;
  httpHeaders?: Record<string, string>;
  envHttpHeaders?: Record<string, string>;
  queryParams?: Record<string, string>;
  modelMetadata?: CodexProviderModelMetadata;
  apiKeyValue?: string;
};

export type CodexProviderPoolConfig = {
  defaultProviderId: string;
  providers: Map<string, CodexProviderDefinition>;
  configPath?: string;
};

type ProviderConfigFile = {
  defaultProvider?: string;
  providers?: Record<string, Partial<Omit<CodexProviderDefinition, "enabled" | "wireApi">> & {
    enabled?: boolean;
    wireApi?: string;
  }>;
};

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: JsonRecord;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type TokenBreakdown = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type ActiveTurn = {
  sessionId: string;
  threadId: string;
  model: string;
  definitions: Map<string, EdaToolDefinition>;
  executeTool: ToolExecutor;
  onEvent?: (event: AgentRunEvent) => void;
  requestWriteApproval?: WriteApprovalRequester;
  plannedOperations: ChangeOperation[];
  plannedKeys: Set<string>;
  toolTrace: AgentTurnResult["toolTrace"];
  messagePhases: Map<string, string | undefined>;
  finalMessage: string;
  lastAgentMessage: string;
  modelRequests: number;
  toolCalls: number;
  usage: AgentTokenUsage;
  usageBaseline?: TokenBreakdown;
  latestTotal?: TokenBreakdown;
  turnId?: string;
  terminalStopReason?: "tool_call_budget" | "no_progress";
  terminalStopMessage?: string;
  interruptRequested?: boolean;
  resolve: (value: JsonRecord) => void;
  reject: (error: Error) => void;
};

export type CodexProviderStatus = {
  id: string;
  name: string;
  model: string;
  baseUrl: string;
  enabled: boolean;
  apiKeyEnv: string;
  apiKeyConfigured: boolean;
  modelMetadataConfigured: boolean;
  wireApi: "responses";
  process: "stopped" | "starting" | "ready" | "failed";
  pid?: number;
  error?: string;
};

export type CodexProviderPoolOptions = {
  command?: string;
  commandPrefixArgs?: string[];
  config?: CodexProviderPoolConfig;
  requestTimeoutMs?: number;
  maxProcesses?: number;
  cwd?: string;
  codexHomeRoot?: string;
};

export type CodexCommandResolution = {
  command: string;
  prefixArgs: string[];
  source: "configured" | "path-exe" | "npm-wrapper" | "desktop-app" | "unresolved";
};

type CodexCommandResolutionOptions = {
  platform?: NodeJS.Platform;
  pathValue?: string;
  localAppData?: string;
  nodeCommand?: string;
};

const existingFile = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
};

const npmCodexScriptForWrapper = (wrapperPath: string): string | undefined => {
  const script = join(dirname(wrapperPath), "node_modules", "@openai", "codex", "bin", "codex.js");
  return existingFile(script) ? script : undefined;
};

/**
 * Resolve the Windows Codex launcher without relying on cmd.exe. npm installs expose
 * codex.cmd, which Node cannot execute with shell:false, while the desktop app exposes
 * a native codex.exe. Keeping shell:false prevents Provider values from being interpreted
 * by a command shell.
 */
export const resolveCodexCommand = (
  configuredCommand: string,
  options: CodexCommandResolutionOptions = {},
): CodexCommandResolution => {
  const command = configuredCommand.trim() || "codex";
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, prefixArgs: [], source: "configured" };
  }

  const nodeCommand = options.nodeCommand ?? process.execPath;
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    if (/\.cmd$/i.test(command)) {
      const script = npmCodexScriptForWrapper(command);
      if (script) return { command: nodeCommand, prefixArgs: [script], source: "npm-wrapper" };
    }
    return { command, prefixArgs: [], source: "configured" };
  }

  if (command.toLowerCase() !== "codex") {
    return { command, prefixArgs: [], source: "configured" };
  }

  const pathDirectories = (options.pathValue ?? process.env.PATH ?? process.env.Path ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  // Prefer a native executable anywhere on PATH over an earlier npm .cmd wrapper.
  for (const directory of pathDirectories) {
    const executable = join(directory, "codex.exe");
    if (existingFile(executable)) {
      return { command: executable, prefixArgs: [], source: "path-exe" };
    }
  }

  for (const directory of pathDirectories) {
    const wrapper = join(directory, "codex.cmd");
    if (!existingFile(wrapper)) continue;
    const script = npmCodexScriptForWrapper(wrapper);
    if (script) return { command: nodeCommand, prefixArgs: [script], source: "npm-wrapper" };
  }

  // Codex Desktop keeps versioned native binaries here. This fallback also works when
  // Agent Service was launched before the desktop app added its bin directory to PATH.
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  const desktopBinRoot = localAppData
    ? join(localAppData, "OpenAI", "Codex", "bin")
    : undefined;
  if (desktopBinRoot && existsSync(desktopBinRoot)) {
    const candidates = readdirSync(desktopBinRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(desktopBinRoot, entry.name, "codex.exe"))
      .filter(existingFile)
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    if (candidates[0]) {
      return { command: candidates[0], prefixArgs: [], source: "desktop-app" };
    }
  }

  return { command, prefixArgs: [], source: "unresolved" };
};

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const positiveInteger = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const nonEmptyStringList = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be a non-empty array of strings.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
};

const parseModelMetadata = (value: unknown, providerId: string): CodexProviderModelMetadata | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Codex provider ${providerId} modelMetadata must be an object.`);
  const contextWindow = positiveInteger(value.contextWindow, 0);
  const maxOutputTokens = positiveInteger(value.maxOutputTokens, 0);
  if (!contextWindow || !maxOutputTokens || maxOutputTokens >= contextWindow) {
    throw new Error(`Codex provider ${providerId} modelMetadata requires contextWindow > maxOutputTokens > 0.`);
  }
  const inputModalities = nonEmptyStringList(value.inputModalities, `Codex provider ${providerId} modelMetadata.inputModalities`);
  if (inputModalities.some((modality) => modality !== "text" && modality !== "image") || !inputModalities.includes("text")) {
    throw new Error(`Codex provider ${providerId} modelMetadata.inputModalities only supports text/image and must include text.`);
  }
  const reasoningEfforts = value.reasoningEfforts === undefined
    ? undefined
    : nonEmptyStringList(value.reasoningEfforts, `Codex provider ${providerId} modelMetadata.reasoningEfforts`);
  const defaultReasoningEffort = typeof value.defaultReasoningEffort === "string"
    ? value.defaultReasoningEffort.trim()
    : undefined;
  if (value.defaultReasoningEffort !== undefined && !defaultReasoningEffort) {
    throw new Error(`Codex provider ${providerId} modelMetadata.defaultReasoningEffort must be a non-empty string.`);
  }
  if (defaultReasoningEffort && (!reasoningEfforts || !reasoningEfforts.includes(defaultReasoningEffort))) {
    throw new Error(`Codex provider ${providerId} defaultReasoningEffort must be included in reasoningEfforts.`);
  }
  return {
    contextWindow,
    maxOutputTokens,
    inputModalities: inputModalities as Array<"text" | "image">,
    reasoningEfforts,
    defaultReasoningEffort,
  };
};

const normalizeBaseUrl = (value: string): string =>
  value.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");

const safeProviderId = (value: string): string => {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) throw new Error(`Invalid Codex provider id: ${value}`);
  return normalized;
};

const tomlString = (value: string): string => JSON.stringify(value);

const tomlInlineTable = (value: Record<string, string>): string =>
  `{ ${Object.entries(value).map(([key, item]) => `${tomlString(key)} = ${tomlString(item)}`).join(", ")} }`;

const stableStringify = (value: unknown): string => {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (isRecord(item)) {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return item;
  };
  try {
    return JSON.stringify(normalize(value));
  } catch (error) {
    return JSON.stringify({ serializationError: error instanceof Error ? error.message : String(error) });
  }
};

const modelInputSchema = (definition: EdaToolDefinition): Record<string, unknown> => {
  if (definition.riskLevel === "read") return definition.inputSchema;
  const schema = { ...definition.inputSchema };
  const properties = isRecord(schema.properties) ? { ...schema.properties } : undefined;
  if (properties) {
    delete properties.confirmWrite;
    schema.properties = properties;
  }
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter((name) => name !== "confirmWrite");
  }
  return schema;
};

const toDynamicTools = (definitions: EdaToolDefinition[]): JsonRecord[] =>
  definitions.filter((definition) => definition.enabled).map((definition) => ({
    type: "function",
    name: definition.name,
    description: definition.riskLevel === "read"
      ? definition.description
      : `${definition.description} 该调用只登记待确认的 ChangeSet，不会直接修改 EDA；不要在调用前索要口头确认。`,
    inputSchema: modelInputSchema(definition),
  }));

const emptyUsage = (): AgentTokenUsage => ({
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

const numberValue = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const tokenBreakdown = (value: unknown): TokenBreakdown => {
  const record = isRecord(value) ? value : {};
  return {
    totalTokens: numberValue(record.totalTokens),
    inputTokens: numberValue(record.inputTokens),
    outputTokens: numberValue(record.outputTokens),
    reasoningOutputTokens: numberValue(record.reasoningOutputTokens),
  };
};

const subtractBreakdown = (left: TokenBreakdown, right: TokenBreakdown): TokenBreakdown => ({
  totalTokens: Math.max(0, left.totalTokens - right.totalTokens),
  inputTokens: Math.max(0, left.inputTokens - right.inputTokens),
  outputTokens: Math.max(0, left.outputTokens - right.outputTokens),
  reasoningOutputTokens: Math.max(0, left.reasoningOutputTokens - right.reasoningOutputTokens),
});

const usageFromBreakdown = (value: TokenBreakdown): AgentTokenUsage => ({
  promptTokens: value.inputTokens,
  completionTokens: value.outputTokens,
  reasoningTokens: value.reasoningOutputTokens,
  totalTokens: value.totalTokens,
});

const parseFinalAnswer = (content: string): {
  content: string;
  status?: "completed" | "awaiting_user" | "blocked";
} => {
  const marker = /\[\[JLCIRCUIT_STATUS:(completed|awaiting_user|blocked)\]\]/i;
  const match = content.match(marker);
  return {
    content: content.replace(marker, "").trim(),
    status: match?.[1]?.toLowerCase() as "completed" | "awaiting_user" | "blocked" | undefined,
  };
};

const providerFromLegacyEnvironment = (): [string, CodexProviderDefinition] => {
  const sourceId = process.env.JLCIRCUIT_MODEL_PROVIDER?.trim() || "openai";
  const id = safeProviderId(sourceId === "stub" ? "default" : sourceId);
  const apiKeyValue = process.env.JLCIRCUIT_LLM_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  return [id, {
    name: sourceId === "stub" ? "Default provider" : sourceId,
    baseUrl: normalizeBaseUrl(process.env.JLCIRCUIT_LLM_BASE_URL?.trim() || "https://api.openai.com/v1"),
    model: process.env.JLCIRCUIT_LLM_MODEL?.trim() || "gpt-5.6-terra",
    apiKeyEnv: `JLCIRCUIT_CODEX_PROVIDER_KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
    apiKeyValue,
    enabled: sourceId !== "stub" || Boolean(apiKeyValue),
    wireApi: "responses",
    reasoningEffort: process.env.JLCIRCUIT_LLM_REASONING_EFFORT?.trim() || undefined,
    streamIdleTimeoutMs: positiveInteger(process.env.JLCIRCUIT_LLM_TIMEOUT_MS, 300_000),
  }];
};

export const loadCodexProviderPoolConfig = (
  configPath = process.env.JLCIRCUIT_CODEX_PROVIDERS_CONFIG?.trim()
    || ".jlcircuit-data/codex-providers.json",
): CodexProviderPoolConfig => {
  const absolutePath = resolve(configPath);
  if (!existsSync(absolutePath)) {
    const [id, provider] = providerFromLegacyEnvironment();
    return { defaultProviderId: id, providers: new Map([[id, provider]]) };
  }
  const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as ProviderConfigFile;
  if (!isRecord(parsed.providers) || Object.keys(parsed.providers).length === 0) {
    throw new Error(`Codex provider config does not define providers: ${absolutePath}`);
  }
  const providers = new Map<string, CodexProviderDefinition>();
  for (const [rawId, candidate] of Object.entries(parsed.providers)) {
    const id = safeProviderId(rawId);
    if (!candidate || typeof candidate !== "object") throw new Error(`Invalid Codex provider: ${rawId}`);
    if (candidate.wireApi && candidate.wireApi !== "responses") {
      throw new Error(`Codex provider ${rawId} uses unsupported wireApi=${candidate.wireApi}; only responses is supported.`);
    }
    const name = candidate.name?.trim() || rawId;
    const baseUrl = candidate.baseUrl?.trim();
    const model = candidate.model?.trim();
    const apiKeyEnv = candidate.apiKeyEnv?.trim();
    if (!baseUrl || !model || !apiKeyEnv) {
      throw new Error(`Codex provider ${rawId} requires baseUrl, model and apiKeyEnv.`);
    }
    const secretHeaders = Object.keys(candidate.httpHeaders ?? {}).filter((header) =>
      ["authorization", "proxy-authorization", "api-key", "x-api-key"].includes(header.toLowerCase()));
    if (secretHeaders.length > 0) {
      throw new Error(
        `Codex provider ${rawId} must not store secret headers in httpHeaders: ${secretHeaders.join(", ")}. Use apiKeyEnv or envHttpHeaders.`,
      );
    }
    const secretQueryParams = Object.keys(candidate.queryParams ?? {}).filter((name) =>
      ["key", "api_key", "apikey", "token", "access_token"].includes(name.toLowerCase()));
    if (secretQueryParams.length > 0) {
      throw new Error(
        `Codex provider ${rawId} must not store secret query parameters: ${secretQueryParams.join(", ")}. Use apiKeyEnv.`,
      );
    }
    providers.set(id, {
      name,
      baseUrl: normalizeBaseUrl(baseUrl),
      model,
      apiKeyEnv,
      enabled: candidate.enabled !== false,
      wireApi: "responses",
      reasoningEffort: candidate.reasoningEffort?.trim() || undefined,
      requestMaxRetries: positiveInteger(candidate.requestMaxRetries, 4),
      streamMaxRetries: positiveInteger(candidate.streamMaxRetries, 5),
      streamIdleTimeoutMs: positiveInteger(candidate.streamIdleTimeoutMs, 300_000),
      httpHeaders: candidate.httpHeaders,
      envHttpHeaders: candidate.envHttpHeaders,
      queryParams: candidate.queryParams,
      modelMetadata: parseModelMetadata(candidate.modelMetadata, rawId),
    });
  }
  const defaultProviderId = safeProviderId(parsed.defaultProvider?.trim() || providers.keys().next().value || "");
  if (!providers.has(defaultProviderId)) {
    throw new Error(`Default Codex provider is not defined: ${defaultProviderId}`);
  }
  return { defaultProviderId, providers, configPath: absolutePath };
};

export const providerModelCatalog = (provider: CodexProviderDefinition): { models: JsonRecord[] } | undefined => {
  const metadata = provider.modelMetadata;
  if (!metadata) return undefined;
  return {
    models: [{
      slug: provider.model,
      display_name: provider.name,
      description: `JLCircuit compatibility metadata for ${provider.model}.`,
      base_instructions: "You are a careful JLCircuit Agent. Follow the current developer instructions, use only the available dynamic tools, and report uncertainties.",
      ...(metadata.defaultReasoningEffort ? { default_reasoning_level: metadata.defaultReasoningEffort } : {}),
      supported_reasoning_levels: (metadata.reasoningEfforts ?? []).map((effort) => ({
        effort,
        description: `${effort} reasoning effort.`,
      })),
      shell_type: "disabled",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      support_verbosity: false,
      web_search_tool_type: "text",
      truncation_policy: { mode: "tokens", limit: 10_000 },
      experimental_supported_tools: [],
      input_modalities: metadata.inputModalities,
      context_window: metadata.contextWindow,
      max_context_window: metadata.contextWindow,
      supports_reasoning_summary_parameter: false,
      use_responses_lite: false,
    }],
  };
};

const writeProviderModelCatalog = (codexHome: string, provider: CodexProviderDefinition): string | undefined => {
  const catalog = providerModelCatalog(provider);
  if (!catalog) return undefined;
  const catalogPath = join(codexHome, "jlcircuit-model-catalog.json");
  writeFileSync(catalogPath, `${JSON.stringify(catalog, undefined, 2)}\n`, "utf8");
  return catalogPath;
};

export const providerConfigArgs = (
  id: string,
  provider: CodexProviderDefinition,
  modelCatalogPath?: string,
): string[] => {
  const runtimeId = `jlcircuit_${safeProviderId(id)}`;
  const prefix = `model_providers.${runtimeId}`;
  const args = [
    "--config", `model_provider=${tomlString(runtimeId)}`,
    "--config", `model=${tomlString(provider.model)}`,
    "--config", `${prefix}.name=${tomlString(provider.name)}`,
    "--config", `${prefix}.base_url=${tomlString(provider.baseUrl)}`,
    "--config", `${prefix}.env_key=${tomlString(provider.apiKeyEnv)}`,
    "--config", `${prefix}.wire_api=${tomlString(provider.wireApi)}`,
    "--config", `${prefix}.request_max_retries=${provider.requestMaxRetries ?? 4}`,
    "--config", `${prefix}.stream_max_retries=${provider.streamMaxRetries ?? 5}`,
    "--config", `${prefix}.stream_idle_timeout_ms=${provider.streamIdleTimeoutMs ?? 300_000}`,
  ];
  if (provider.httpHeaders) args.push("--config", `${prefix}.http_headers=${tomlInlineTable(provider.httpHeaders)}`);
  if (provider.envHttpHeaders) args.push("--config", `${prefix}.env_http_headers=${tomlInlineTable(provider.envHttpHeaders)}`);
  if (provider.queryParams) args.push("--config", `${prefix}.query_params=${tomlInlineTable(provider.queryParams)}`);
  if (modelCatalogPath) args.push("--config", `model_catalog_json=${tomlString(modelCatalogPath)}`);
  return args;
};

const isolatedAppServerFeatureArgs = [
  "--disable", "plugins",
  "--disable", "remote_plugin",
  "--disable", "apps",
  "--disable", "hooks",
  "--disable", "skill_search",
  "--disable", "shell_tool",
  "--disable", "unified_exec",
  "--disable", "deferred_executor",
  "--disable", "code_mode",
  "--disable", "artifact",
  "--disable", "browser_use",
  "--disable", "browser_use_external",
  "--disable", "browser_use_full_cdp_access",
  "--disable", "computer_use",
  "--disable", "in_app_browser",
  "--disable", "in_app_chat",
  "--disable", "image_generation",
  "--disable", "multi_agent",
  "--disable", "workspace_dependencies",
  "--disable", "view_image",
];

const providerProcessEnvironment = (
  provider: CodexProviderDefinition,
  codexHome: string,
  apiKey: string,
): NodeJS.ProcessEnv => {
  const allowed = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "TEMP", "TMP", "TMPDIR", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "USERNAME",
    "USERDOMAIN", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
    "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "LANG", "LC_ALL", "TERM", "NO_COLOR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  ];
  const environment: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
  for (const name of allowed) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment[provider.apiKeyEnv] = apiKey;
  for (const envName of Object.values(provider.envHttpHeaders ?? {})) {
    if (process.env[envName] !== undefined) environment[envName] = process.env[envName];
  }
  return environment;
};

const dynamicContentItems = (result: ToolResponse, maxChars: number): JsonRecord[] => {
  const textResult = {
    requestId: result.requestId,
    ok: result.ok,
    data: result.data,
    error: result.error,
  };
  const serialized = stableStringify(textResult);
  const compact = serialized.length <= maxChars
    ? serialized
    : stableStringify({
        ok: result.ok,
        truncated: true,
        charLength: serialized.length,
        preview: serialized.slice(0, maxChars),
        instruction: "请使用位号、图元 ID、区域或 limit 参数缩小查询范围。",
      });
  const items: JsonRecord[] = [{ type: "inputText", text: compact }];
  for (const item of result.content ?? []) {
    if (item.type === "image" && item.data) {
      items.push({ type: "inputImage", imageUrl: `data:${item.mimeType};base64,${item.data}` });
    } else if (item.type === "text" && item.text) {
      items.push({ type: "inputText", text: item.text });
    }
  }
  return items;
};

class CodexAppServerProcess {
  public readonly id: string;
  public readonly provider: CodexProviderDefinition;
  private readonly command: string;
  private readonly commandPrefixArgs: string[];
  private readonly cwd: string;
  private readonly requestTimeoutMs: number;
  private readonly codexHome: string;
  private readonly log: Logger;
  private child?: ChildProcessWithoutNullStreams;
  private lines?: ReadLineInterface;
  private nextRequestId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly loadedThreads = new Set<string>();
  private startPromise?: Promise<void>;
  private state: CodexProviderStatus["process"] = "stopped";
  private lastError?: string;

  public constructor(
    id: string,
    provider: CodexProviderDefinition,
    command: string,
    commandPrefixArgs: string[],
    cwd: string,
    codexHome: string,
    requestTimeoutMs: number,
    log: Logger,
  ) {
    this.id = id;
    this.provider = provider;
    this.command = command;
    this.commandPrefixArgs = commandPrefixArgs;
    this.cwd = cwd;
    this.codexHome = codexHome;
    this.requestTimeoutMs = requestTimeoutMs;
    this.log = log;
  }

  public status(): Pick<CodexProviderStatus, "process" | "pid" | "error"> {
    return {
      process: this.state,
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  public isThreadLoaded(threadId: string): boolean {
    return this.loadedThreads.has(threadId);
  }

  public markThreadLoaded(threadId: string): void {
    this.loadedThreads.add(threadId);
  }

  public async ensureStarted(): Promise<void> {
    if (this.state === "ready" && this.child) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    if (!this.provider.enabled) throw new Error(`Codex provider is disabled: ${this.id}`);
    const apiKey = this.provider.apiKeyValue ?? process.env[this.provider.apiKeyEnv];
    if (!apiKey) throw new Error(`Codex provider ${this.id} API key environment variable is not set: ${this.provider.apiKeyEnv}`);
    this.state = "starting";
    this.lastError = undefined;
    mkdirSync(this.codexHome, { recursive: true });
    const modelCatalogPath = writeProviderModelCatalog(this.codexHome, this.provider);
    const args = [
      ...this.commandPrefixArgs,
      ...providerConfigArgs(this.id, this.provider, modelCatalogPath),
      ...isolatedAppServerFeatureArgs,
      "app-server",
    ];
    this.log("[codex-pool] starting provider", {
      providerId: this.id,
      command: this.command,
      model: this.provider.model,
      baseUrl: this.provider.baseUrl,
      modelMetadataConfigured: Boolean(this.provider.modelMetadata),
    });
    const child = spawn(this.command, args, {
      cwd: this.cwd,
      env: providerProcessEnvironment(this.provider, this.codexHome, apiKey),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (data) => {
      const message = String(data).trim();
      if (message) this.log("[codex-app-server] stderr", { providerId: this.id, message: message.slice(0, 2_000) });
    });
    child.once("error", (error) => {
      const spawnError = error as NodeJS.ErrnoException;
      this.failProcess(spawnError.code === "ENOENT"
        ? new Error(
            `Codex CLI executable was not found: ${this.command}. `
            + "Install Codex CLI or set JLCIRCUIT_CODEX_COMMAND to an absolute codex.exe path, then restart Agent Service.",
          )
        : error);
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.failProcess(new Error(`Codex App Server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`));
    });
    try {
      await this.request("initialize", {
        clientInfo: { name: "jlcircuit_agent", title: "JLCircuit Agent", version: "0.2.0" },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized", {});
      this.state = "ready";
      this.log("[codex-pool] provider ready", { providerId: this.id, pid: child.pid });
    } catch (error) {
      this.failProcess(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  public async request(method: string, params: JsonRecord): Promise<unknown> {
    if (method !== "initialize") await this.ensureStarted();
    if (!this.child || this.child.stdin.destroyed) throw new Error(`Codex provider process is not available: ${this.id}`);
    const id = this.nextRequestId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Codex App Server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child?.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  public notify(method: string, params: JsonRecord): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error(`Codex provider process is not available: ${this.id}`);
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  public registerTurn(turn: ActiveTurn): ActiveTurn {
    if (this.activeTurns.has(turn.threadId)) throw new Error(`Codex thread already has an active turn: ${turn.threadId}`);
    this.activeTurns.set(turn.threadId, turn);
    return turn;
  }

  public unregisterTurn(threadId: string): void {
    this.activeTurns.delete(threadId);
  }

  /**
   * The server waits for the dynamic-tool result, so interrupt only after the
   * JSON-RPC response has been written.  Interrupting synchronously here can
   * deadlock the App Server and host request pair.
   */
  private stopTurnAfterToolResponse(turn: ActiveTurn, reason: ActiveTurn["terminalStopReason"], message: string): void {
    turn.terminalStopReason ??= reason;
    turn.terminalStopMessage ??= message;
    if (turn.interruptRequested || !turn.turnId) return;
    turn.interruptRequested = true;
    setTimeout(() => {
      void this.request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId! }).catch((error) => {
        this.log("[codex-pool] unable to interrupt stopped turn", {
          providerId: this.id,
          threadId: turn.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 0);
  }

  public async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.lines?.close();
    this.lines = undefined;
    this.loadedThreads.clear();
    this.state = "stopped";
    if (!child) return;
    const closed = new Promise<void>((resolveClose) => {
      // On Windows, `exit` may fire before the child stdio handles release the
      // provider workspace. Wait for `close` so a replacement process/test can
      // safely reuse or remove that directory.
      if (child.exitCode !== null && child.stdout.destroyed && child.stderr.destroyed) {
        resolveClose();
        return;
      }
      const timer = setTimeout(() => resolveClose(), 2_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolveClose();
      });
    });
    child.kill();
    await closed;
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.log("[codex-app-server] invalid JSON ignored", { providerId: this.id, preview: line.slice(0, 500) });
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || `Codex App Server error ${message.error.code ?? "unknown"}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message);
      return;
    }
    if (message.method) this.handleNotification(message.method, message.params ?? {});
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    if (message.method === "item/tool/call" && message.id !== undefined) {
      const params = message.params ?? {};
      const threadId = String(params.threadId ?? "");
      const turn = this.activeTurns.get(threadId);
      if (!turn) {
        this.respond(message.id, undefined, { code: -32000, message: `No active JLCircuit turn for ${threadId}` });
        return;
      }
      try {
        const result = await this.executeDynamicTool(turn, params);
        this.respond(message.id, result);
      } catch (error) {
        this.respond(message.id, {
          contentItems: [{ type: "inputText", text: stableStringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) }],
          success: false,
        });
      }
      return;
    }
    if (message.id !== undefined) {
      this.respond(message.id, undefined, { code: -32601, message: `JLCircuit host does not permit server request: ${message.method}` });
    }
  }

  private async executeDynamicTool(turn: ActiveTurn, params: JsonRecord): Promise<JsonRecord> {
    const toolName = String(params.tool ?? "");
    const argumentsValue = isRecord(params.arguments) ? params.arguments : {};
    const definition = turn.definitions.get(toolName);
    turn.toolCalls += 1;
    const call = turn.toolCalls;
    turn.onEvent?.({ type: "phase", phase: "tool", message: `正在执行工具：${toolName}` });
    turn.onEvent?.({ type: "tool_start", tool: toolName, call, arguments: argumentsValue });
    if (!definition) {
      const error = `Tool is not registered for this turn: ${toolName}`;
      turn.toolTrace.push({ tool: toolName, arguments: argumentsValue, status: "blocked", error });
      turn.onEvent?.({ type: "tool_complete", tool: toolName, call, status: "blocked", arguments: argumentsValue, error });
      return { contentItems: [{ type: "inputText", text: stableStringify({ ok: false, error }) }], success: false };
    }
    const maxToolCalls = positiveInteger(process.env.JLCIRCUIT_AGENT_MAX_TOOL_CALLS, 120);
    if (call > maxToolCalls) {
      const error = `已达到 ${maxToolCalls} 次工具调用安全预算。`;
      turn.toolTrace.push({ tool: toolName, arguments: argumentsValue, status: "blocked", error });
      turn.onEvent?.({ type: "tool_complete", tool: toolName, call, status: "blocked", arguments: argumentsValue, error });
      this.stopTurnAfterToolResponse(turn, "tool_call_budget", error);
      return { contentItems: [{ type: "inputText", text: stableStringify({ ok: false, error }) }], success: false };
    }
    if (definition.riskLevel !== "read") {
      if (turn.requestWriteApproval) {
        const writeArgs = { ...argumentsValue };
        delete writeArgs.confirmWrite;
        const decision = await turn.requestWriteApproval({
          tool: toolName,
          arguments: writeArgs,
          riskLevel: definition.riskLevel,
          description: definition.description,
        });
        if (decision === "approved") {
          try {
            const response = await turn.executeTool(toolName, turn.sessionId, {
              ...writeArgs,
              confirmWrite: true,
            });
            turn.toolTrace.push({
              tool: toolName,
              arguments: argumentsValue,
              status: response.ok ? "completed" : "failed",
              result: response.ok ? response.data : undefined,
              error: response.ok ? undefined : response.error?.message,
            });
            turn.onEvent?.({
              type: "tool_complete",
              tool: toolName,
              call,
              status: response.ok ? "completed" : "failed",
              arguments: argumentsValue,
              error: response.ok ? undefined : response.error?.message,
            });
            return {
              contentItems: dynamicContentItems(
                response,
                positiveInteger(process.env.JLCIRCUIT_LLM_TOOL_RESULT_MAX_CHARS, 50_000),
              ),
              success: response.ok,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            turn.toolTrace.push({ tool: toolName, arguments: argumentsValue, status: "failed", error: message });
            turn.onEvent?.({ type: "tool_complete", tool: toolName, call, status: "failed", arguments: argumentsValue, error: message });
            return { contentItems: [{ type: "inputText", text: stableStringify({ ok: false, error: message }) }], success: false };
          }
        }
        if (decision === "rejected") {
          const error = "用户拒绝了本次写操作。请勿使用相同参数重试；可根据用户后续说明调整方案或直接总结。";
          turn.toolTrace.push({ tool: toolName, arguments: argumentsValue, status: "blocked", error });
          turn.onEvent?.({ type: "tool_complete", tool: toolName, call, status: "blocked", arguments: argumentsValue, error });
          return { contentItems: [{ type: "inputText", text: stableStringify({ ok: false, error, retryable: false }) }], success: false };
        }
      }
      const plannedArgs = { ...argumentsValue };
      delete plannedArgs.confirmWrite;
      const operationKey = `${toolName}:${stableStringify(plannedArgs)}`;
      let operation = turn.plannedOperations.find((candidate) =>
        `${candidate.tool}:${stableStringify(candidate.args)}` === operationKey);
      if (!operation) {
        operation = {
          id: crypto.randomUUID(),
          tool: toolName,
          args: plannedArgs,
          targets: [],
          riskLevel: definition.riskLevel,
          description: definition.description,
        };
      }
      if (turn.plannedKeys.has(operationKey)) {
        const error = "相同的写操作已登记到当前 ChangeSet；无需再次调用。请直接总结待确认操作，或调用不同参数的工具。";
        const result = {
          ok: false,
          blocked: true,
          planned: true,
          requiresConfirmation: true,
          operationId: operation.id,
          error,
        };
        turn.toolTrace.push({ tool: toolName, arguments: argumentsValue, status: "blocked", result, error });
        turn.onEvent?.({ type: "tool_complete", tool: toolName, call, status: "blocked", arguments: argumentsValue, error });
        this.stopTurnAfterToolResponse(turn, "no_progress", error);
        return { contentItems: [{ type: "inputText", text: stableStringify(result) }], success: false };
      }
      turn.plannedKeys.add(operationKey);
      turn.plannedOperations.push(operation);
      const result = {
        ok: true,
        planned: true,
        requiresConfirmation: true,
        operationId: operation.id,
        message: "写操作已加入待确认 ChangeSet，尚未执行。",
      };
      turn.toolTrace.push({ tool: toolName, arguments: argumentsValue, status: "completed", result });
      turn.onEvent?.({ type: "tool_complete", tool: toolName, call, status: "completed", arguments: argumentsValue });
      return { contentItems: [{ type: "inputText", text: stableStringify(result) }], success: true };
    }
    try {
      const response = await turn.executeTool(toolName, turn.sessionId, argumentsValue);
      turn.toolTrace.push({
        tool: toolName,
        arguments: argumentsValue,
        status: response.ok ? "completed" : "failed",
        result: response.ok ? response.data : undefined,
        error: response.ok ? undefined : response.error?.message,
      });
      turn.onEvent?.({
        type: "tool_complete",
        tool: toolName,
        call,
        status: response.ok ? "completed" : "failed",
        arguments: argumentsValue,
        error: response.ok ? undefined : response.error?.message,
      });
      return {
        contentItems: dynamicContentItems(
          response,
          positiveInteger(process.env.JLCIRCUIT_LLM_TOOL_RESULT_MAX_CHARS, 50_000),
        ),
        success: response.ok,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      turn.toolTrace.push({ tool: toolName, arguments: argumentsValue, status: "failed", error: message });
      turn.onEvent?.({ type: "tool_complete", tool: toolName, call, status: "failed", arguments: argumentsValue, error: message });
      return { contentItems: [{ type: "inputText", text: stableStringify({ ok: false, error: message }) }], success: false };
    }
  }

  private handleNotification(method: string, params: JsonRecord): void {
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const turn = threadId ? this.activeTurns.get(threadId) : undefined;
    if (method === "item/started" && turn && isRecord(params.item)) {
      const item = params.item;
      if (item.type === "agentMessage" && typeof item.id === "string") {
        turn.messagePhases.set(item.id, typeof item.phase === "string" ? item.phase : undefined);
      }
      return;
    }
    if (method === "item/agentMessage/delta" && turn) {
      const delta = typeof params.delta === "string" ? params.delta : "";
      const itemId = typeof params.itemId === "string" ? params.itemId : "";
      const phase = turn.messagePhases.get(itemId);
      if (delta) {
        turn.onEvent?.(phase === "commentary"
          ? { type: "reasoning_delta", request: Math.max(1, turn.modelRequests), delta }
          : { type: "content_delta", request: Math.max(1, turn.modelRequests), delta });
      }
      return;
    }
    if ((method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") && turn) {
      const delta = typeof params.delta === "string" ? params.delta : "";
      if (delta) turn.onEvent?.({ type: "reasoning_delta", request: Math.max(1, turn.modelRequests), delta });
      return;
    }
    if (method === "item/completed" && turn && isRecord(params.item)) {
      const item = params.item;
      if (item.type === "agentMessage" && typeof item.text === "string") {
        turn.lastAgentMessage = item.text;
        if (item.phase === "final_answer" || !item.phase) turn.finalMessage = item.text;
      }
      return;
    }
    if (method === "rawResponse/completed" && turn) {
      turn.modelRequests += 1;
      return;
    }
    if (method === "thread/tokenUsage/updated" && turn && isRecord(params.tokenUsage)) {
      const total = tokenBreakdown(params.tokenUsage.total);
      const last = tokenBreakdown(params.tokenUsage.last);
      if (!turn.usageBaseline) turn.usageBaseline = subtractBreakdown(total, last);
      const current = subtractBreakdown(total, turn.usageBaseline);
      turn.latestTotal = total;
      turn.usage = usageFromBreakdown(current);
      turn.onEvent?.({
        type: "usage",
        request: Math.max(1, turn.modelRequests),
        usage: usageFromBreakdown(last),
        cumulative: { ...turn.usage },
      });
      return;
    }
    if (method === "turn/completed" && turn && isRecord(params.turn)) {
      turn.resolve(params.turn);
      return;
    }
    if (method === "error") {
      const errorRecord = isRecord(params.error) ? params.error : params;
      const message = typeof errorRecord.message === "string" ? errorRecord.message : "Codex App Server turn failed.";
      if (turn) turn.reject(new Error(message));
      else this.log("[codex-app-server] error", { providerId: this.id, message });
      return;
    }
    if ((method === "warning" || method === "configWarning") && params.message) {
      this.log(`[codex-app-server] ${method}`, { providerId: this.id, message: params.message });
    }
  }

  private respond(id: number | string, result?: unknown, error?: { code: number; message: string }): void {
    if (!this.child || this.child.stdin.destroyed) return;
    this.child.stdin.write(`${JSON.stringify(error ? { id, error } : { id, result })}\n`);
  }

  private failProcess(error: Error): void {
    const child = this.child;
    this.state = "failed";
    this.lastError = error.message;
    this.lines?.close();
    this.lines = undefined;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    this.loadedThreads.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const turn of this.activeTurns.values()) turn.reject(error);
    this.activeTurns.clear();
    this.log("[codex-pool] provider failed", { providerId: this.id, error: error.message });
  }
}

const baseDeveloperInstructions = [
  "你是 JLCircuit Agent，负责分析和协助修改嘉立创 EDA 电路设计。",
  "当前请求提供的 JLCircuit 动态工具是 EDA 状态和工具可用性的唯一权威来源。",
  "不要使用 shell、文件读取、文件修改或 apply_patch 处理本任务；EDA 和外部资料只能通过本轮 JLCircuit 动态工具访问。",
  "写工具调用只登记待确认操作，不会立即执行；不要在调用前要求用户回复确认或登记。",
  "每个写操作在本轮只调用一次。工具返回 planned=true 后，保留 operationId 并继续登记不同操作；若返回 blocked 或提示已登记，立即停止调用该操作并总结 ChangeSet。",
  "需要判断布局和连线可读性时，必须调用画布截图工具，并仅报告截图能够支持的事实。",
  "当前 EDA 快照与历史内容冲突时，以当前快照为准。",
  "最终答复末尾必须附状态标记：正常答复 [[JLCIRCUIT_STATUS:completed]]；等待用户补充 [[JLCIRCUIT_STATUS:awaiting_user]]；工具明确阻塞 [[JLCIRCUIT_STATUS:blocked]]。",
  "默认使用中文回答，保留必要的位号、网络名和 API 错误。",
].join("\n");

const buildTurnText = (
  instruction: string,
  context: PreparedAgentContext,
  skills: ResolvedSkill[],
  includeHistory: boolean,
): string => {
  const skillText = skills.length > 0
    ? skills.map((skill) => [
        `### 技能 ${skill.name} (${skill.id}@${skill.version})`,
        `启用原因：${skill.reason}`,
        skill.instructions,
      ].join("\n")).join("\n\n")
    : "本轮没有启用专用技能。";
  const history = includeHistory
    ? [
        context.sessionSummary ? `已有会话摘要：\n${context.sessionSummary}` : undefined,
        context.recentMessages.length > 0
          ? `已有最近对话：\n${context.recentMessages.map((message) => `${message.role}: ${message.content}`).join("\n")}`
          : undefined,
      ].filter(Boolean).join("\n\n")
    : "";
  return [
    history,
    `当前未完成任务：\n${context.activeTasksText}`,
    `当前 EDA 设计快照：\n${context.designContextText}`,
    `本轮技能说明：\n${skillText}`,
    `用户请求：\n${instruction}`,
  ].filter(Boolean).join("\n\n");
};

export class CodexProviderPool {
  private readonly store: AgentStore;
  private readonly log: Logger;
  private readonly config: CodexProviderPoolConfig;
  private readonly processes = new Map<string, CodexAppServerProcess>();
  private readonly command: string;
  private readonly commandPrefixArgs: string[];
  private readonly cwd: string;
  private readonly codexHomeRoot: string;
  private readonly requestTimeoutMs: number;
  private readonly maxProcesses: number;

  public constructor(
    store: AgentStore,
    log: Logger = () => undefined,
    options: CodexProviderPoolOptions = {},
  ) {
    this.store = store;
    this.log = log;
    this.config = options.config ?? loadCodexProviderPoolConfig();
    const configuredCommand = (options.command ?? process.env.JLCIRCUIT_CODEX_COMMAND?.trim()) || "codex";
    const resolvedCommand = resolveCodexCommand(configuredCommand);
    this.command = resolvedCommand.command;
    this.commandPrefixArgs = [
      ...resolvedCommand.prefixArgs,
      ...(options.commandPrefixArgs ?? []),
    ];
    this.log("[codex-pool] command resolved", {
      configuredCommand,
      command: this.command,
      source: resolvedCommand.source,
    });
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.codexHomeRoot = resolve(
      options.codexHomeRoot
        ?? process.env.JLCIRCUIT_CODEX_HOME_ROOT?.trim()
        ?? ".jlcircuit-data/codex-home",
    );
    this.requestTimeoutMs = options.requestTimeoutMs
      ?? positiveInteger(process.env.JLCIRCUIT_CODEX_REQUEST_TIMEOUT_MS, 30_000);
    this.maxProcesses = options.maxProcesses
      ?? positiveInteger(process.env.JLCIRCUIT_CODEX_MAX_PROCESSES, 4);
  }

  public get defaultProviderId(): string {
    return this.config.defaultProviderId;
  }

  public list(): CodexProviderStatus[] {
    return [...this.config.providers.entries()].map(([id, provider]) => ({
      id,
      name: provider.name,
      model: provider.model,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      apiKeyEnv: provider.apiKeyEnv,
      apiKeyConfigured: Boolean(provider.apiKeyValue ?? process.env[provider.apiKeyEnv]),
      modelMetadataConfigured: Boolean(provider.modelMetadata),
      wireApi: provider.wireApi,
      ...(this.processes.get(id)?.status() ?? { process: "stopped" as const }),
    }));
  }

  public async restart(providerId: string): Promise<CodexProviderStatus> {
    const id = safeProviderId(providerId);
    const processHandle = this.processes.get(id);
    if (processHandle) await processHandle.close();
    this.processes.delete(id);
    const provider = this.config.providers.get(id);
    if (!provider) throw new Error(`Unknown Codex provider: ${providerId}`);
    const next = this.getProcess(id, provider);
    await next.ensureStarted();
    return this.list().find((item) => item.id === id) as CodexProviderStatus;
  }

  public async close(): Promise<void> {
    await Promise.all([...this.processes.values()].map((processHandle) => processHandle.close()));
    this.processes.clear();
  }

  public async runTurn(args: {
    providerId?: string;
    instruction: string;
    sessionId: string;
    preparedContext: PreparedAgentContext;
    toolDefinitions: EdaToolDefinition[];
    executeTool: ToolExecutor;
    activeSkills: ResolvedSkill[];
    mode?: "chat" | "plan";
    signal?: AbortSignal;
    onEvent?: (event: AgentRunEvent) => void;
    requestWriteApproval?: WriteApprovalRequester;
  }): Promise<AgentTurnResult> {
    const providerId = safeProviderId(args.providerId || this.defaultProviderId);
    const provider = this.config.providers.get(providerId);
    if (!provider) throw new Error(`Unknown Codex provider: ${providerId}`);
    const threadCwd = this.providerWorkspace(providerId);
    const processHandle = this.getProcess(providerId, provider);
    await processHandle.ensureStarted();
    const dynamicTools = toDynamicTools(args.toolDefinitions);
    const toolSignature = createHash("sha256").update(stableStringify(dynamicTools)).digest("hex");
    const persisted = this.store.getCodexThread(args.sessionId, providerId);
    let threadId: string;
    let isNewThread = false;
    if (persisted && persisted.toolSignature === toolSignature) {
      threadId = persisted.threadId;
      if (!processHandle.isThreadLoaded(threadId)) {
        try {
          await processHandle.request("thread/resume", {
            threadId,
            model: provider.model,
            modelProvider: `jlcircuit_${providerId}`,
            cwd: threadCwd,
            runtimeWorkspaceRoots: [threadCwd],
            approvalPolicy: "never",
            sandbox: "read-only",
            developerInstructions: baseDeveloperInstructions,
          });
          processHandle.markThreadLoaded(threadId);
        } catch (error) {
          this.log("[codex-pool] thread resume failed; creating a replacement", {
            providerId,
            sessionId: args.sessionId,
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
          this.store.deleteCodexThread(args.sessionId, providerId);
          threadId = "";
        }
      }
    } else {
      if (persisted) this.store.deleteCodexThread(args.sessionId, providerId);
      threadId = "";
    }
    if (!threadId) {
      const response = await processHandle.request("thread/start", {
        model: provider.model,
        modelProvider: `jlcircuit_${providerId}`,
        cwd: threadCwd,
        runtimeWorkspaceRoots: [threadCwd],
        approvalPolicy: "never",
        sandbox: "read-only",
        serviceName: "jlcircuit-agent",
        developerInstructions: baseDeveloperInstructions,
        ephemeral: false,
        dynamicTools,
      });
      const responseRecord = isRecord(response) ? response : {};
      const thread = isRecord(responseRecord.thread) ? responseRecord.thread : {};
      threadId = typeof thread.id === "string" ? thread.id : "";
      if (!threadId) throw new Error("Codex App Server thread/start did not return a thread id.");
      isNewThread = true;
      processHandle.markThreadLoaded(threadId);
      this.store.upsertCodexThread({
        sessionId: args.sessionId,
        providerId,
        threadId,
        model: provider.model,
        toolSignature,
      });
    }

    const startedAt = Date.now();
    const definitions = new Map(args.toolDefinitions.map((definition) => [definition.name, definition]));
    let resolveCompletion!: (value: JsonRecord) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<JsonRecord>((resolveTurn, rejectTurn) => {
      resolveCompletion = resolveTurn;
      rejectCompletion = rejectTurn;
    });
    const activeTurn = processHandle.registerTurn({
      sessionId: args.sessionId,
      threadId,
      model: provider.model,
      definitions,
      executeTool: args.executeTool,
      onEvent: args.onEvent,
      requestWriteApproval: args.requestWriteApproval,
      plannedOperations: [],
      plannedKeys: new Set(),
      toolTrace: [],
      messagePhases: new Map(),
      finalMessage: "",
      lastAgentMessage: "",
      modelRequests: 0,
      toolCalls: 0,
      usage: emptyUsage(),
      resolve: resolveCompletion,
      reject: rejectCompletion,
    });
    const maxElapsedMs = positiveInteger(process.env.JLCIRCUIT_AGENT_MAX_ELAPSED_MS, 300_000);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const interrupt = (): void => {
      if (activeTurn.turnId) {
        void processHandle.request("turn/interrupt", { threadId, turnId: activeTurn.turnId }).catch(() => undefined);
      }
    };
    const abort = (): void => {
      interrupt();
      activeTurn.reject(args.signal?.reason instanceof Error ? args.signal.reason : new Error("Codex turn aborted."));
    };
    args.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (args.signal?.aborted) throw args.signal.reason instanceof Error
        ? args.signal.reason
        : new Error("Codex turn aborted.");
      args.onEvent?.({ type: "phase", phase: "model", message: `正在通过 Codex App Server 调用 ${provider.name}…` });
      args.onEvent?.({ type: "model_start", request: 1, route: "language", model: provider.model });
      const startResponse = await processHandle.request("turn/start", {
        threadId,
        input: [{
          type: "text",
          text: buildTurnText(args.instruction, args.preparedContext, args.activeSkills, isNewThread),
        }],
        model: provider.model,
        ...(provider.reasoningEffort ? { effort: provider.reasoningEffort } : {}),
      });
      if (isRecord(startResponse) && isRecord(startResponse.turn) && typeof startResponse.turn.id === "string") {
        activeTurn.turnId = startResponse.turn.id;
      }
      timeout = setTimeout(() => {
        interrupt();
        activeTurn.reject(new Error(`Codex turn exceeded ${maxElapsedMs}ms.`));
      }, maxElapsedMs);
      const completedTurn = await completion;
      const turnStatus = typeof completedTurn.status === "string" ? completedTurn.status : "completed";
      if (turnStatus === "failed") {
        const error = isRecord(completedTurn.error) && typeof completedTurn.error.message === "string"
          ? completedTurn.error.message
          : "Codex App Server turn failed.";
        throw new Error(error);
      }
      const parsed = parseFinalAnswer(activeTurn.finalMessage || activeTurn.lastAgentMessage);
      const message = parsed.content || (activeTurn.plannedOperations.length > 0
        ? `已生成 ${activeTurn.plannedOperations.length} 条待确认修改操作。`
        : activeTurn.terminalStopMessage || "Codex 已完成本轮，但没有返回可显示的文本结果。");
      const status: AgentTurnResult["status"] = activeTurn.plannedOperations.length > 0
        ? "awaiting_approval"
        : turnStatus === "interrupted"
          ? "incomplete"
          : parsed.status ?? "completed";
      const skills = args.activeSkills.map(({ id, name, version, reason, matchedKeywords }) => ({
        id, name, version, reason, matchedKeywords,
      }));
      const evidence = activeTurn.toolTrace
        .filter((item) => item.status === "completed")
        .map((item) => ({ source: item.tool, summary: stableStringify(item.result).slice(0, 500) }));
      return {
        status,
        message,
        model: provider.model,
        context: args.preparedContext.designContext,
        plannedOperations: activeTurn.plannedOperations,
        skills,
        toolTrace: activeTurn.toolTrace,
        runState: {
          goal: args.instruction,
          acceptanceCriteria: [
            "逐项回应用户本轮要求",
            "关键结论具有 EDA、截图或资料工具证据",
            "写操作只进入待确认 ChangeSet",
          ],
          stopReason: activeTurn.terminalStopReason
            ?? (turnStatus === "interrupted" ? "elapsed_time_budget" : "model_completed"),
          modelRequests: Math.max(1, activeTurn.modelRequests),
          toolCalls: activeTurn.toolCalls,
          elapsedMs: Date.now() - startedAt,
          usage: { ...activeTurn.usage },
          limits: {
            maxToolCalls: positiveInteger(process.env.JLCIRCUIT_AGENT_MAX_TOOL_CALLS, 120),
            maxElapsedMs,
            maxNoProgress: positiveInteger(process.env.JLCIRCUIT_AGENT_MAX_NO_PROGRESS, 2),
            maxRetriesPerAction: positiveInteger(process.env.JLCIRCUIT_AGENT_MAX_RETRIES_PER_ACTION, 2),
          },
          checkpoint: {
            completedTools: [...new Set(activeTurn.toolTrace.filter((item) => item.status === "completed").map((item) => item.tool))],
            failedTools: [...new Set(activeTurn.toolTrace.filter((item) => item.status !== "completed").map((item) => item.tool))],
            plannedOperationCount: activeTurn.plannedOperations.length,
            evidenceCount: evidence.length,
            resumable: status === "blocked" || status === "incomplete" || status === "awaiting_user",
          },
          evidence,
        },
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      args.signal?.removeEventListener("abort", abort);
      processHandle.unregisterTurn(threadId);
    }
  }

  private getProcess(id: string, provider: CodexProviderDefinition): CodexAppServerProcess {
    const existing = this.processes.get(id);
    if (existing) return existing;
    if (this.processes.size >= this.maxProcesses) {
      throw new Error(`Codex provider process pool limit reached (${this.maxProcesses}). Restart or disable an unused provider.`);
    }
    const processHandle = new CodexAppServerProcess(
      id,
      provider,
      this.command,
      this.commandPrefixArgs,
      this.cwd,
      resolve(this.codexHomeRoot, id),
      this.requestTimeoutMs,
      this.log,
    );
    this.processes.set(id, processHandle);
    return processHandle;
  }

  private providerWorkspace(id: string): string {
    const directory = resolve(this.codexHomeRoot, safeProviderId(id), "workspace");
    mkdirSync(directory, { recursive: true });
    return directory;
  }
}
