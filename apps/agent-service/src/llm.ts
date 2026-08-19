import type { EdaToolDefinition, ToolContent, ToolResponse } from "../../../packages/contracts/src/index.ts";

type LlmMessage = Record<string, unknown>;

type LlmTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type LlmToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type LlmAssistantMessage = {
  role: "assistant";
  content?: string | null;
  tool_calls?: LlmToolCall[];
};

type LlmCompletion = {
  message: LlmAssistantMessage;
  model?: string;
  usage?: unknown;
};

type AgentToolExecutor = (
  toolName: string,
  sessionId: string,
  payload: Record<string, unknown>,
) => Promise<ToolResponse>;

type CompletionRoute = "language" | "vision";

export type AgentTurnResult = {
  message: string;
  model: string;
  context: unknown;
  toolTrace: Array<{
    tool: string;
    arguments: Record<string, unknown>;
    status: "completed" | "blocked" | "failed";
    result?: unknown;
    error?: string;
  }>;
};

const provider = (): string => (process.env.JLCIRCUIT_MODEL_PROVIDER ?? "stub").toLowerCase();

const isEnabled = (value: string | undefined, fallback = false): boolean => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

const model = (): string =>
  process.env.JLCIRCUIT_LLM_MODEL ??
  (provider() === "deepseek" ? "deepseek-chat" : "gpt-4o-mini");

const baseUrl = (): string => {
  const configured = process.env.JLCIRCUIT_LLM_BASE_URL;
  if (configured) return normalizeBaseUrl(configured);
  if (provider() === "deepseek") return "https://api.deepseek.com/v1";
  return "https://api.openai.com/v1";
};

const normalizeBaseUrl = (configured: string): string => {
  const normalized = configured.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized.slice(0, -"/chat/completions".length)
    : normalized;
};

const visionEnabledOnLanguageModel = (): boolean =>
  isEnabled(process.env.JLCIRCUIT_LLM_SUPPORTS_VISION);

const visionBaseUrl = (): string => {
  const configured = process.env.JLCIRCUIT_VISION_LLM_BASE_URL;
  return configured ? normalizeBaseUrl(configured) : baseUrl();
};

const visionModel = (): string | undefined => process.env.JLCIRCUIT_VISION_LLM_MODEL?.trim() || undefined;

const visionApiKey = (): string | undefined =>
  process.env.JLCIRCUIT_VISION_LLM_API_KEY?.trim() || apiKey();

const apiKey = (): string | undefined =>
  process.env.JLCIRCUIT_LLM_API_KEY ?? process.env.OPENAI_API_KEY;

const timeoutMs = (): number => Number(process.env.JLCIRCUIT_LLM_TIMEOUT_MS ?? 60_000);

const maxToolRounds = (): number => Number(process.env.JLCIRCUIT_LLM_MAX_TOOL_ROUNDS ?? 3);

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const maxTokens = (): number => positiveInteger(process.env.JLCIRCUIT_LLM_MAX_TOKENS, 1_024);

const maxContextChars = (): number =>
  positiveInteger(process.env.JLCIRCUIT_LLM_CONTEXT_MAX_CHARS, 40_000);

const maxContextItems = (): number =>
  positiveInteger(process.env.JLCIRCUIT_LLM_CONTEXT_MAX_ITEMS, 200);

const llmLog = (message: string, details?: unknown): void => {
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  console.log(`[${new Date().toISOString()}] [llm] ${message}${suffix}`);
};

const toLlmTools = (definitions: EdaToolDefinition[]): LlmTool[] =>
  definitions
    .filter((definition) => definition.enabled)
    .map((definition) => ({
      type: "function",
      function: {
        name: definition.name,
        description: definition.description,
        parameters: definition.inputSchema,
      },
    }));

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

const compactContextCandidate = (context: Record<string, unknown>, itemLimit: number): Record<string, unknown> => {
  const summary = isRecord(context.summary) ? context.summary : {};
  const drc = Array.isArray(context.drc) ? compactArray(context.drc, Math.min(itemLimit, 50)) : context.drc;
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
    drc,
    capturedAt: context.capturedAt,
    source: context.source,
  };
};

const contextForModel = (context: unknown): string => {
  const original = stringifyForModel(context);
  if (!isRecord(context) || original.length <= maxContextChars()) {
    llmLog("context prepared", {
      originalChars: original.length,
      modelChars: original.length,
      compacted: false,
    });
    return original;
  }

  let itemLimit = maxContextItems();
  let compacted = compactContextCandidate(context, itemLimit);
  let serialized = stringifyForModel(compacted);
  while (serialized.length > maxContextChars() && itemLimit > 1) {
    itemLimit = Math.max(1, Math.floor(itemLimit / 2));
    compacted = compactContextCandidate(context, itemLimit);
    serialized = stringifyForModel(compacted);
  }

  llmLog("context prepared", {
    originalChars: original.length,
    modelChars: serialized.length,
    compacted: true,
    itemLimit,
    maxChars: maxContextChars(),
  });
  return serialized;
};

const resultForModel = (result: ToolResponse): Record<string, unknown> => ({
  requestId: result.requestId,
  ok: result.ok,
  data: result.data,
  error: result.error,
  // Do not put Base64 screenshots into the next text request. This can exceed
  // the provider context window; visual evidence will be handled separately.
  content: result.content?.map((item) =>
    item.type === "image"
      ? { type: "image", mimeType: item.mimeType, byteLength: item.data.length, note: "image captured locally; not included in text prompt" }
      : item,
  ),
});

const hasImage = (result: ToolResponse): boolean =>
  Boolean(result.content?.some((item) => item.type === "image" && item.data));

const addVisualEvidenceMessage = (messages: LlmMessage[], result: ToolResponse): void => {
  const images =
    result.content?.filter(
      (item): item is Extract<ToolContent, { type: "image" }> => item.type === "image" && Boolean(item.data),
    ) ?? [];
  if (images.length === 0) return;
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "这是刚刚从嘉立创EDA画布截取的视觉证据，请检查当前设计的实际可读性。",
          "重点检查：元件和网络标签是否清晰、导线是否断开或悬空、导线与文字/元件是否重叠、布局是否存在明显拥挤或不合理交叉。",
          "只报告从截图中能确认的事实；无法确认的内容标记为需要进一步检查。",
        ].join("\n"),
      },
      ...images.map((item) => ({
        type: "image_url",
        image_url: { url: `data:${item.mimeType};base64,${item.data}` },
      })),
    ],
  });
};

const complete = async (
  messages: LlmMessage[],
  tools: LlmTool[],
  route: CompletionRoute,
): Promise<LlmCompletion> => {
  if (provider() === "stub") {
    return {
      model: "stub",
      message: {
        role: "assistant",
        content: "模型尚未配置。请设置 JLCIRCUIT_MODEL_PROVIDER、JLCIRCUIT_LLM_API_KEY 和 JLCIRCUIT_LLM_MODEL。",
      },
    };
  }

  const useVision = route === "vision";
  const selectedModel = useVision ? visionModel() : model();
  if (useVision && visionEnabledOnLanguageModel()) {
    throw new Error("视觉路由配置错误：当前语言模型已声明支持图像，不应切换到独立视觉模型。");
  }
  if (useVision && !selectedModel) {
    throw new Error(
      "当前语言模型不支持图像识别，且未配置 JLCIRCUIT_VISION_LLM_MODEL。请配置独立视觉模型，或将 JLCIRCUIT_LLM_SUPPORTS_VISION 设为 true。",
    );
  }
  const selectedBaseUrl = useVision ? visionBaseUrl() : baseUrl();
  const key = useVision ? visionApiKey() : apiKey();
  if (!key) throw new Error("LLM API key is not configured.");
  const requestTimeoutMs = useVision
    ? Number(process.env.JLCIRCUIT_VISION_LLM_TIMEOUT_MS ?? timeoutMs())
    : timeoutMs();

  llmLog("request started", {
    provider: provider(),
    route,
    baseUrl: selectedBaseUrl,
    model: selectedModel ?? model(),
    messageCount: messages.length,
    toolCount: tools.length,
    maxTokens: maxTokens(),
    timeoutMs: requestTimeoutMs,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    let response: Response;
    let rawBody: string;
    try {
      response = await fetch(`${selectedBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: selectedModel ?? model(),
          messages,
          tools,
          tool_choice: "auto",
          temperature: 0.2,
          max_tokens: maxTokens(),
        }),
        signal: controller.signal,
      });
      rawBody = await response.text();
    } catch (error) {
      llmLog("request failed", {
        route,
        model: selectedModel ?? model(),
        timeoutMs: requestTimeoutMs,
        aborted: controller.signal.aborted,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      throw error;
    }
    let body: {
      error?: { message?: string };
      model?: string;
      usage?: unknown;
      choices?: Array<{ message?: LlmAssistantMessage }>;
    };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      llmLog("response was not JSON", { status: response.status, body: rawBody.slice(0, 500) });
      throw new Error(`LLM returned non-JSON HTTP ${response.status}.`);
    }
    if (!response.ok) {
      llmLog("request failed", { status: response.status, error: body.error?.message ?? rawBody.slice(0, 300) });
      throw new Error(body.error?.message ?? `LLM request failed with HTTP ${response.status}.`);
    }
    const message = body.choices?.[0]?.message;
    if (!message) throw new Error("LLM response did not contain choices[0].message.");
    llmLog("response received", {
      route,
      model: body.model ?? selectedModel ?? model(),
      hasToolCalls: Boolean(message.tool_calls?.length),
      toolCallCount: message.tool_calls?.length ?? 0,
    });
    return { message, model: body.model, usage: body.usage };
  } finally {
    clearTimeout(timer);
  }
};

export const runAgentTurn = async (args: {
  instruction: string;
  sessionId: string;
  toolDefinitions: EdaToolDefinition[];
  executeTool: AgentToolExecutor;
}): Promise<AgentTurnResult> => {
  const contextResponse = await args.executeTool("easyeda_get_context", args.sessionId, {});
  if (!contextResponse.ok) {
    throw new Error(contextResponse.error?.message ?? "Unable to read EDA context.");
  }

  const context = contextResponse.data;
  const toolDefinitions = new Map(args.toolDefinitions.map((definition) => [definition.name, definition]));
  const tools = toLlmTools(args.toolDefinitions);
  const messages: LlmMessage[] = [
    {
      role: "system",
      content: [
        "你是 JLCircuit Agent，负责协助分析嘉立创EDA原理图和PCB。",
        "先基于当前设计上下文回答，不要臆测不存在的元件或网络。",
        "可以调用只读工具补充信息；当前回合禁止自动执行任何写操作。",
        "如果需要判断布局、连线或整体可读性，必须先调用画布截图工具；不要仅凭结构化摘要断言视觉问题。",
        "如果用户要求修改设计，先解释修改计划和风险，并明确需要用户确认。",
        "回答使用中文，必要时保留元件标号、网络名和 API 错误信息。",
      ].join("\n"),
    },
    {
      role: "user",
      content: `当前设计上下文：\n${contextForModel(context)}\n\n用户指令：${args.instruction}`,
    },
  ];
  const toolTrace: AgentTurnResult["toolTrace"] = [];
  let route: CompletionRoute = "language";

  for (let round = 0; round < maxToolRounds(); round += 1) {
    const completion = await complete(messages, tools, route);
    const assistant = completion.message;
    messages.push(assistant as unknown as LlmMessage);
    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        message: assistant.content ?? "模型没有返回文本结果。",
        model: completion.model ?? model(),
        context,
        toolTrace,
      };
    }

    const visualResults: ToolResponse[] = [];
    for (const call of calls) {
      const definition = toolDefinitions.get(call.function.name);
      let argumentsValue: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.function.arguments || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          argumentsValue = parsed as Record<string, unknown>;
        }
      } catch (error) {
        toolTrace.push({
          tool: call.function.name,
          arguments: {},
          status: "failed",
          error: `Invalid tool arguments: ${String(error)}`,
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: stringifyForModel({ ok: false, error: "工具参数不是合法 JSON。" }),
        });
        continue;
      }

      if (!definition || definition.riskLevel !== "read") {
        const error = "当前模型回合只允许只读工具；写操作需要单独的用户确认流程。";
        toolTrace.push({ tool: call.function.name, arguments: argumentsValue, status: "blocked", error });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: stringifyForModel({ ok: false, error }),
        });
        continue;
      }

      const result = await args.executeTool(call.function.name, args.sessionId, argumentsValue);
      toolTrace.push({
        tool: call.function.name,
        arguments: argumentsValue,
        status: result.ok ? "completed" : "failed",
        result: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error?.message,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: stringifyForModel(resultForModel(result)),
      });
      if (hasImage(result)) visualResults.push(result);
    }
    for (const result of visualResults) {
      addVisualEvidenceMessage(messages, result);
    }
    if (visualResults.length > 0) route = visionEnabledOnLanguageModel() ? "language" : "vision";
  }

  return {
    message: `模型连续请求了超过 ${maxToolRounds()} 轮工具调用，已停止本次回合，请缩小问题范围后重试。`,
    model: model(),
    context,
    toolTrace,
  };
};
