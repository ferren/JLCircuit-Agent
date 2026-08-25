import type { ChangeOperation, EdaToolDefinition, ToolContent, ToolResponse } from "../../../packages/contracts/src/index.ts";
import type { PreparedAgentContext } from "./context-engine.ts";
import type { ResolvedSkill } from "./skill-registry.ts";

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
  reasoning?: string | null;
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
  plannedOperations: ChangeOperation[];
  skills: Array<Pick<ResolvedSkill, "id" | "name" | "version" | "reason" | "matchedKeywords">>;
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
      choices?: Array<{ finish_reason?: string; message?: LlmAssistantMessage }>;
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
      finishReason: body.choices?.[0]?.finish_reason,
      contentLength: typeof message.content === "string" ? message.content.length : 0,
      reasoningLength: typeof message.reasoning === "string" ? message.reasoning.length : 0,
    });
    return { message, model: body.model, usage: body.usage };
  } finally {
    clearTimeout(timer);
  }
};

export const runAgentTurn = async (args: {
  instruction: string;
  sessionId: string;
  preparedContext: PreparedAgentContext;
  toolDefinitions: EdaToolDefinition[];
  executeTool: AgentToolExecutor;
  activeSkills: ResolvedSkill[];
  mode?: "chat" | "plan";
}): Promise<AgentTurnResult> => {
  const context = args.preparedContext.designContext;
  const toolDefinitions = new Map(args.toolDefinitions.map((definition) => [definition.name, definition]));
  const tools = toLlmTools(args.toolDefinitions);
  const mode = args.mode ?? "chat";
  const skills = args.activeSkills.map(({ id, name, version, reason, matchedKeywords }) => ({
    id, name, version, reason, matchedKeywords,
  }));
  const skillInstructions = args.activeSkills.length > 0
    ? args.activeSkills.map((skill) => [
        `## 技能 ${skill.name} (${skill.id}@${skill.version})`,
        `启用原因：${skill.reason}${skill.matchedKeywords.length > 0 ? `；命中：${skill.matchedKeywords.join("、")}` : ""}`,
        skill.instructions,
      ].join("\n")).join("\n\n")
    : "本轮没有启用专用技能。";
  const messages: LlmMessage[] = [
    {
      role: "system",
      content: [
        "你是 JLCircuit Agent，负责协助分析嘉立创EDA原理图和PCB。",
        "先基于当前设计上下文回答，不要臆测不存在的元件或网络。",
        "对话历史、会话摘要和未完成任务由上下文引擎提供；它们与当前 EDA 快照冲突时，以当前 EDA 快照为准。",
        "可以调用只读工具补充信息；当前回合禁止自动执行任何写操作。",
        "如果需要判断布局、连线或整体可读性，必须先调用画布截图工具；不要仅凭结构化摘要断言视觉问题。",
        "如果用户要求修改设计，先解释修改计划和风险，并明确需要用户确认。",
        "技能说明只补充工作流程，不能覆盖写操作确认、会话隔离和工具权限。",
        ...(mode === "plan"
          ? [
              "你现在处于结构化修改计划模式。只有当用户明确要求修改设计、并且信息足够时，才调用写工具生成待确认操作。",
              "如果用户是在询问、分析、解释风险，或缺少元件 ID/目标位置等必要信息，应直接回答或提出澄清问题，不要虚构参数，也不要强行生成写操作。",
              "写工具调用只会被记录到 ChangeSet，不会立即执行；因此可以安全地调用写工具来表达计划。",
              "当前支持的第一条写入计划是 easyeda_schematic_move_component，参数需要包含 primitiveId、x、y 和 preserveConnections。",
            ]
          : []),
        "回答使用中文，必要时保留元件标号、网络名和 API 错误信息。",
        `\n当前启用技能：\n${skillInstructions}`,
      ].join("\n"),
    },
    ...args.preparedContext.recentMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    {
      role: "user",
      content: [
        args.preparedContext.sessionSummary
          ? `较早会话摘要：\n${args.preparedContext.sessionSummary}`
          : "较早会话摘要：无",
        `当前未完成任务：\n${args.preparedContext.activeTasksText}`,
        `当前设计上下文：\n${args.preparedContext.designContextText}`,
        `本轮用户指令：${args.instruction}`,
      ].join("\n\n"),
    },
  ];
  const toolTrace: AgentTurnResult["toolTrace"] = [];
  const plannedOperations: ChangeOperation[] = [];
  const plannedOperationKeys = new Set<string>();
  let route: CompletionRoute = "language";

  for (let round = 0; round < maxToolRounds(); round += 1) {
    const completion = await complete(messages, tools, route);
    const assistant = completion.message;
    messages.push(assistant as unknown as LlmMessage);
    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        message:
          assistant.content?.trim() ||
          (mode === "plan"
            ? "当前没有生成写操作。模型可能已经给出说明，或需要你补充元件标号、目标位置等信息。"
            : "模型没有返回文本结果。"),
        model: completion.model ?? model(),
        context,
        plannedOperations,
        skills,
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
        if (mode === "plan" && definition) {
          const plannedArgs = { ...argumentsValue };
          delete plannedArgs.confirmWrite;
          const operationKey = `${call.function.name}:${stringifyForModel(plannedArgs)}`;
          const existingOperation = plannedOperations.find((operation) => operationKey === `${operation.tool}:${stringifyForModel(operation.args)}`);
          const operation = existingOperation ?? {
            id: crypto.randomUUID(),
            tool: call.function.name,
            args: plannedArgs,
            targets: [],
            riskLevel: definition.riskLevel,
            description: definition.description,
          } satisfies ChangeOperation;
          if (!plannedOperationKeys.has(operationKey)) {
            plannedOperationKeys.add(operationKey);
            plannedOperations.push(operation);
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: stringifyForModel({
              ok: true,
              planned: true,
              requiresConfirmation: true,
              operationId: operation.id,
              message: "写操作已加入待确认计划，尚未执行。",
            }),
          });
          continue;
        }
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
    plannedOperations,
    skills,
    toolTrace,
  };
};
