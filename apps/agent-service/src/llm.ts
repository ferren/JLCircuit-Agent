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
  reasoning_details?: unknown[];
  tool_calls?: LlmToolCall[];
};

export type AgentTokenUsage = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost?: number;
};

type LlmCompletion = {
  message: LlmAssistantMessage;
  model?: string;
  usage?: AgentTokenUsage;
  finishReason?: string;
};

type AgentToolExecutor = (
  toolName: string,
  sessionId: string,
  payload: Record<string, unknown>,
) => Promise<ToolResponse>;

type CompletionRoute = "language" | "vision";

export type AgentRunEvent =
  | { type: "phase"; phase: "context" | "model" | "tool" | "recovery" | "finalizing"; message: string }
  | { type: "model_start"; request: number; route: CompletionRoute; model: string }
  | { type: "reasoning_delta"; request: number; delta: string }
  | { type: "content_delta"; request: number; delta: string }
  | { type: "usage"; request: number; usage: AgentTokenUsage; cumulative: AgentTokenUsage }
  | { type: "tool_start"; tool: string; call: number; arguments: Record<string, unknown> }
  | { type: "tool_complete"; tool: string; call: number; status: "completed" | "blocked" | "failed"; error?: string };

export type AgentTurnResult = {
  status: "completed" | "awaiting_user" | "awaiting_approval" | "blocked" | "incomplete";
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
  runState: {
    goal: string;
    acceptanceCriteria: string[];
    stopReason: "model_completed" | "tool_call_budget" | "elapsed_time_budget" | "no_progress" | "empty_response" | "output_length";
    modelRequests: number;
    toolCalls: number;
    elapsedMs: number;
    usage: AgentTokenUsage;
    limits: {
      maxToolCalls: number;
      maxElapsedMs: number;
      maxNoProgress: number;
      maxRetriesPerAction: number;
    };
    checkpoint: {
      completedTools: string[];
      failedTools: string[];
      plannedOperationCount: number;
      evidenceCount: number;
      resumable: boolean;
    };
    evidence: Array<{
      source: string;
      summary: string;
    }>;
  };
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

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const nonNegativeInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

// Keep enough headroom for a concise answer, tool arguments, and reasoning.
// Providers may count reasoning tokens against this same output budget.
const maxTokens = (): number => positiveInteger(process.env.JLCIRCUIT_LLM_MAX_TOKENS, 4_096);

const streamingEnabled = (): boolean => isEnabled(process.env.JLCIRCUIT_LLM_STREAMING, true);

const reasoningEffort = (): string | undefined =>
  process.env.JLCIRCUIT_LLM_REASONING_EFFORT?.trim() || undefined;

const finalReasoningEffort = (): string | undefined =>
  process.env.JLCIRCUIT_LLM_FINAL_REASONING_EFFORT?.trim()
  || (provider() === "openrouter" ? "minimal" : undefined);

const maxLengthRecoveries = (): number =>
  nonNegativeInteger(process.env.JLCIRCUIT_LLM_MAX_LENGTH_RECOVERIES, 1);

const maxToolCalls = (): number => positiveInteger(process.env.JLCIRCUIT_AGENT_MAX_TOOL_CALLS, 40);

const maxElapsedMs = (): number => positiveInteger(process.env.JLCIRCUIT_AGENT_MAX_ELAPSED_MS, 300_000);

const maxNoProgress = (): number => positiveInteger(process.env.JLCIRCUIT_AGENT_MAX_NO_PROGRESS, 2);

const maxRetriesPerAction = (): number =>
  nonNegativeInteger(process.env.JLCIRCUIT_AGENT_MAX_RETRIES_PER_ACTION, 2);

const finalizeTimeoutMs = (): number =>
  positiveInteger(process.env.JLCIRCUIT_AGENT_FINALIZE_TIMEOUT_MS, 60_000);

const llmLog = (message: string, details?: unknown): void => {
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  console.log(`[${new Date().toISOString()}] [llm] ${message}${suffix}`);
};

const emptyUsage = (): AgentTokenUsage => ({
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

const numberValue = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const normalizeUsage = (value: unknown): AgentTokenUsage | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const completionDetails = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
    ? usage.completion_tokens_details as Record<string, unknown>
    : {};
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === "object"
    ? usage.output_tokens_details as Record<string, unknown>
    : {};
  const promptTokens = numberValue(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = numberValue(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = numberValue(usage.total_tokens) || promptTokens + completionTokens;
  const reasoningTokens = numberValue(
    completionDetails.reasoning_tokens
    ?? outputDetails.reasoning_tokens
    ?? usage.reasoning_tokens,
  );
  const cost = numberValue(usage.cost);
  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    totalTokens,
    ...(cost > 0 ? { cost } : {}),
  };
};

const addUsage = (target: AgentTokenUsage, usage: AgentTokenUsage | undefined): void => {
  if (!usage) return;
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
  target.reasoningTokens += usage.reasoningTokens;
  target.totalTokens += usage.totalTokens;
  if (usage.cost !== undefined) target.cost = (target.cost ?? 0) + usage.cost;
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

const stableStringify = (value: unknown): string => {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return item;
  };
  return stringifyForModel(normalize(value));
};

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

const resultFingerprintForProgress = (result: ToolResponse): string => {
  const modelResult = resultForModel(result);
  delete modelResult.requestId;
  return stableStringify(modelResult);
};

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
  options: {
    forceFinal?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    request?: number;
    onEvent?: (event: AgentRunEvent) => void;
  } = {},
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
  const requestTimeoutMs = options.timeoutMs ?? (useVision
    ? Number(process.env.JLCIRCUIT_VISION_LLM_TIMEOUT_MS ?? timeoutMs())
    : timeoutMs());
  const requestNumber = options.request ?? 1;
  const useStreaming = streamingEnabled();

  llmLog("request started", {
    provider: provider(),
    route,
    baseUrl: selectedBaseUrl,
    model: selectedModel ?? model(),
    messageCount: messages.length,
    toolCount: tools.length,
    forceFinal: options.forceFinal === true,
    streaming: useStreaming,
    maxTokens: maxTokens(),
    timeoutMs: requestTimeoutMs,
  });

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetTimeout = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`LLM stream was idle for ${requestTimeoutMs}ms.`)), requestTimeoutMs);
  };
  const abortFromParent = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  resetTimeout();
  try {
    let response: Response;
    try {
      const requestBody: Record<string, unknown> = {
        model: selectedModel ?? model(),
        messages,
        temperature: 0.2,
        max_tokens: maxTokens(),
        stream: useStreaming,
      };
      const selectedReasoningEffort = options.forceFinal ? finalReasoningEffort() : reasoningEffort();
      if (selectedReasoningEffort) requestBody.reasoning = { effort: selectedReasoningEffort };
      if (tools.length > 0 && !options.forceFinal) {
        requestBody.tools = tools;
        requestBody.tool_choice = "auto";
      }
      response = await fetch(`${selectedBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
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
    if (!response.ok) {
      const rawBody = await response.text();
      let errorMessage = rawBody.slice(0, 300);
      try {
        errorMessage = (JSON.parse(rawBody) as { error?: { message?: string } }).error?.message ?? errorMessage;
      } catch { /* use raw body */ }
      llmLog("request failed", { status: response.status, error: errorMessage });
      throw new Error(errorMessage || `LLM request failed with HTTP ${response.status}.`);
    }

    let completion: LlmCompletion;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (useStreaming && contentType.includes("text/event-stream")) {
      if (!response.body) throw new Error("LLM streaming response did not contain a readable body.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let reasoning = "";
      let streamedModel: string | undefined;
      let finishReason: string | undefined;
      let usage: AgentTokenUsage | undefined;
      const reasoningDetails: unknown[] = [];
      const toolCalls = new Map<number, { id: string; type: "function"; name: string; arguments: string }>();

      const consumeData = (data: string): void => {
        if (!data || data === "[DONE]") return;
        let chunk: {
          error?: { message?: string };
          model?: string;
          usage?: unknown;
          choices?: Array<{
            finish_reason?: string | null;
            delta?: {
              content?: unknown;
              reasoning?: unknown;
              reasoning_content?: unknown;
              reasoning_details?: unknown[];
              tool_calls?: Array<{
                index?: number;
                id?: string;
                type?: "function";
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        try {
          chunk = JSON.parse(data) as typeof chunk;
        } catch {
          llmLog("invalid SSE data ignored", { preview: data.slice(0, 200) });
          return;
        }
        if (chunk.error) throw new Error(chunk.error.message ?? "LLM stream returned an error.");
        streamedModel = chunk.model ?? streamedModel;
        const normalizedUsage = normalizeUsage(chunk.usage);
        if (normalizedUsage) usage = normalizedUsage;
        const choice = chunk.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) return;
        const contentDelta = typeof delta.content === "string"
          ? delta.content
          : Array.isArray(delta.content)
            ? delta.content
              .map((item) => item && typeof item === "object" && "text" in item ? String((item as { text?: unknown }).text ?? "") : "")
              .join("")
            : "";
        if (contentDelta) {
          content += contentDelta;
          options.onEvent?.({ type: "content_delta", request: requestNumber, delta: contentDelta });
        }
        const directReasoning = typeof delta.reasoning === "string"
          ? delta.reasoning
          : typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : "";
        if (directReasoning) {
          reasoning += directReasoning;
          options.onEvent?.({ type: "reasoning_delta", request: requestNumber, delta: directReasoning });
        }
        if (Array.isArray(delta.reasoning_details)) {
          reasoningDetails.push(...delta.reasoning_details);
          if (!directReasoning) {
            const detailText = delta.reasoning_details
              .map((item) => {
                if (!item || typeof item !== "object") return "";
                const detail = item as Record<string, unknown>;
                return typeof detail.text === "string"
                  ? detail.text
                  : typeof detail.summary === "string" ? detail.summary : "";
              })
              .join("");
            if (detailText) {
              reasoning += detailText;
              options.onEvent?.({ type: "reasoning_delta", request: requestNumber, delta: detailText });
            }
          }
        }
        for (const toolDelta of delta.tool_calls ?? []) {
          const index = toolDelta.index ?? 0;
          const current = toolCalls.get(index) ?? { id: "", type: "function" as const, name: "", arguments: "" };
          if (toolDelta.id) current.id += toolDelta.id;
          if (toolDelta.function?.name) current.name += toolDelta.function.name;
          if (toolDelta.function?.arguments) current.arguments += toolDelta.function.arguments;
          toolCalls.set(index, current);
        }
      };

      const consumeLines = (flush = false): void => {
        const lines = buffer.split(/\r?\n/);
        buffer = flush ? "" : lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          consumeData(line.slice(5).trimStart());
        }
        if (flush && buffer.startsWith("data:")) consumeData(buffer.slice(5).trimStart());
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetTimeout();
        buffer += decoder.decode(value, { stream: true });
        consumeLines();
      }
      buffer += decoder.decode();
      consumeLines(true);
      completion = {
        model: streamedModel ?? selectedModel ?? model(),
        finishReason,
        usage,
        message: {
          role: "assistant",
          content: content || null,
          reasoning: reasoning || null,
          ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
          ...(toolCalls.size > 0
            ? {
                tool_calls: [...toolCalls.entries()]
                  .sort(([left], [right]) => left - right)
                  .map(([index, call]) => ({
                    id: call.id || `stream-tool-${requestNumber}-${index}`,
                    type: "function" as const,
                    function: { name: call.name, arguments: call.arguments },
                  })),
              }
            : {}),
        },
      };
    } else {
      const rawBody = await response.text();
      let body: {
        error?: { message?: string };
        model?: string;
        usage?: unknown;
        choices?: Array<{ finish_reason?: string; message?: LlmAssistantMessage & { reasoning_content?: string } }>;
      };
      try {
        body = JSON.parse(rawBody) as typeof body;
      } catch {
        llmLog("response was not JSON", { status: response.status, body: rawBody.slice(0, 500) });
        throw new Error(`LLM returned non-JSON HTTP ${response.status}.`);
      }
      const message = body.choices?.[0]?.message;
      if (!message) throw new Error("LLM response did not contain choices[0].message.");
      if (!message.reasoning && message.reasoning_content) message.reasoning = message.reasoning_content;
      if (message.reasoning) options.onEvent?.({ type: "reasoning_delta", request: requestNumber, delta: message.reasoning });
      if (message.content) options.onEvent?.({ type: "content_delta", request: requestNumber, delta: message.content });
      completion = {
        message,
        model: body.model,
        usage: normalizeUsage(body.usage),
        finishReason: body.choices?.[0]?.finish_reason,
      };
    }

    const message = completion.message;
    llmLog("response received", {
      route,
      model: completion.model ?? selectedModel ?? model(),
      hasToolCalls: Boolean(message.tool_calls?.length),
      toolCallCount: message.tool_calls?.length ?? 0,
      finishReason: completion.finishReason,
      contentLength: typeof message.content === "string" ? message.content.length : 0,
      reasoningLength: typeof message.reasoning === "string" ? message.reasoning.length : 0,
      usage: completion.usage,
    });
    return completion;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromParent);
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
  signal?: AbortSignal;
  onEvent?: (event: AgentRunEvent) => void;
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
        "持续推进当前目标，直到已有足够证据回答、需要用户补充关键资料、需要用户确认写操作，或工具明确阻塞。不要因为调用了固定次数的工具而停止。",
        "不要重复已经完成且结果未变化的工具调用；遇到失败时应改用其他证据来源、缩小查询范围，或清楚说明阻塞点。",
        "完成前检查：用户要求是否逐项回应、关键结论是否有 EDA/截图/资料证据、无法确认的内容是否明确标出。",
        "最终答复末尾必须附状态标记：正常答复用 [[JLCIRCUIT_STATUS:completed]]；必须等待用户补充关键输入时用 [[JLCIRCUIT_STATUS:awaiting_user]]；外部工具明确阻塞时用 [[JLCIRCUIT_STATUS:blocked]]。状态标记不会显示给用户。",
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
  const limits = {
    maxToolCalls: maxToolCalls(),
    maxElapsedMs: maxElapsedMs(),
    maxNoProgress: maxNoProgress(),
    maxRetriesPerAction: maxRetriesPerAction(),
  };
  const emit = (event: AgentRunEvent): void => {
    try {
      args.onEvent?.(event);
    } catch (error) {
      llmLog("progress event handler failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  const startedAt = Date.now();
  const contextRecord = context && typeof context === "object" && !Array.isArray(context)
    ? context as Record<string, unknown>
    : {};
  const contextProject = contextRecord.project && typeof contextRecord.project === "object"
    ? contextRecord.project as Record<string, unknown>
    : {};
  const contextDocument = contextRecord.activeDocument && typeof contextRecord.activeDocument === "object"
    ? contextRecord.activeDocument as Record<string, unknown>
    : {};
  const contextVersion = stableStringify({
    projectId: contextProject.id,
    documentId: contextDocument.id,
    capturedAt: contextRecord.capturedAt,
  });
  const actionRecords = new Map<string, {
    attempts: number;
    noProgressAttempts: number;
    lastResult?: string;
  }>();
  let modelRequests = 0;
  let toolCalls = 0;
  let consecutiveNoProgress = 0;
  let recoveryAttempted = false;
  let lengthRecoveries = 0;
  let latestModel = model();
  let route: CompletionRoute = "language";
  const cumulativeUsage = emptyUsage();

  const requestCompletion = async (
    requestTools: LlmTool[],
    requestRoute: CompletionRoute,
    options: { forceFinal?: boolean; timeoutMs?: number } = {},
  ): Promise<LlmCompletion> => {
    modelRequests += 1;
    const request = modelRequests;
    const selectedModel = requestRoute === "vision" ? visionModel() ?? model() : model();
    emit({ type: "model_start", request, route: requestRoute, model: selectedModel });
    const completion = await complete(messages, requestTools, requestRoute, {
      ...options,
      request,
      signal: args.signal,
      onEvent: emit,
    });
    addUsage(cumulativeUsage, completion.usage);
    if (completion.usage) {
      emit({ type: "usage", request, usage: completion.usage, cumulative: { ...cumulativeUsage } });
    }
    return completion;
  };

  const buildResult = (
    status: AgentTurnResult["status"],
    stopReason: AgentTurnResult["runState"]["stopReason"],
    message: string,
  ): AgentTurnResult => {
    const evidence = toolTrace
      .filter((item) => item.status === "completed")
      .map((item) => ({
        source: item.tool,
        summary: stableStringify(item.result).slice(0, 500),
      }));
    return {
      status,
      message,
      model: latestModel,
      context,
      plannedOperations,
      skills,
      toolTrace,
      runState: {
        goal: args.instruction,
        acceptanceCriteria: [
          "逐项回应用户本轮要求",
          "关键结论具有 EDA、截图或资料工具证据",
          "无法确认的内容和下一步已明确说明",
        ],
        stopReason,
        modelRequests,
        toolCalls,
        elapsedMs: Date.now() - startedAt,
        usage: { ...cumulativeUsage },
        limits,
        checkpoint: {
          completedTools: [...new Set(toolTrace.filter((item) => item.status === "completed").map((item) => item.tool))],
          failedTools: [...new Set(toolTrace.filter((item) => item.status !== "completed").map((item) => item.tool))],
          plannedOperationCount: plannedOperations.length,
          evidenceCount: evidence.length,
          resumable: status === "blocked" || status === "incomplete" || status === "awaiting_user",
        },
        evidence,
      },
    };
  };

  const finalize = async (
    status: "blocked" | "incomplete",
    stopReason: "tool_call_budget" | "elapsed_time_budget" | "no_progress",
    detail: string,
  ): Promise<AgentTurnResult> => {
    messages.push({
      role: "user",
      content: [
        "系统已停止继续调用工具。请不要再请求任何工具，直接给用户一个可继续的阶段性答复。",
        `停止原因：${detail}`,
        `已执行工具调用：${toolCalls}；已生成待确认操作：${plannedOperations.length}。`,
        "答复必须说明：已经完成什么、依据是什么、还缺什么、为何停止，以及用户下一步如何继续。",
        "如果现有证据已经足以回答问题，仍应给出结论，但要明确这是基于当前证据的最终总结。",
      ].join("\n"),
    });
    try {
      emit({ type: "phase", phase: "finalizing", message: "正在整理阶段结果…" });
      const completion = await requestCompletion([], route, {
        forceFinal: true,
        timeoutMs: finalizeTimeoutMs(),
      });
      latestModel = completion.model ?? latestModel;
      const content = completion.message.content?.trim();
      const finalAnswer = content ? parseFinalAnswer(content).content : "";
      return buildResult(
        status,
        stopReason,
        finalAnswer || `本轮已停止继续调用工具：${detail}。当前结果已保存，可以在下一条消息中继续。`,
      );
    } catch (error) {
      llmLog("final synthesis failed", {
        stopReason,
        error: error instanceof Error ? error.message : String(error),
      });
      return buildResult(
        status,
        stopReason,
        `本轮已停止继续调用工具：${detail}。最终总结请求也未成功：${error instanceof Error ? error.message : String(error)}。当前结果已保存，可以继续重试。`,
      );
    }
  };

  while (true) {
    if (args.signal?.aborted) throw args.signal.reason ?? new Error("Agent turn was cancelled.");
    if (Date.now() - startedAt >= limits.maxElapsedMs) {
      return finalize("incomplete", "elapsed_time_budget", `已达到 ${limits.maxElapsedMs}ms 的运行时间预算`);
    }
    if (toolCalls >= limits.maxToolCalls) {
      return finalize("incomplete", "tool_call_budget", `已达到 ${limits.maxToolCalls} 次工具调用预算`);
    }

    emit({ type: "phase", phase: "model", message: `模型正在处理第 ${modelRequests + 1} 步…` });
    const completion = await requestCompletion(tools, route);
    latestModel = completion.model ?? latestModel;
    const assistant = completion.message;
    messages.push(assistant as unknown as LlmMessage);
    const calls = assistant.tool_calls ?? [];
    if (calls.length === 0) {
      let content = assistant.content?.trim() ?? "";
      let lastCompletion = completion;
      while (lastCompletion.finishReason === "length" && lengthRecoveries < maxLengthRecoveries()) {
        lengthRecoveries += 1;
        emit({
          type: "phase",
          phase: "recovery",
          message: "模型思考达到输出上限，正在要求它基于现有信息直接给出结论…",
        });
        messages.push({
          role: "user",
          content: [
            "上一条响应因为输出长度上限而中止。",
            "不要重复前面的推理，也不要调用工具。请使用已经得到的证据，立即输出简洁、完整的用户可见结论。",
            "优先保留结论、依据、缺口和下一步；最后附 JLCIRCUIT 状态标记。",
          ].join("\n"),
        });
        const continuation = await requestCompletion([], route, {
          forceFinal: true,
          timeoutMs: finalizeTimeoutMs(),
        });
        latestModel = continuation.model ?? latestModel;
        messages.push(continuation.message as unknown as LlmMessage);
        const continuationContent = continuation.message.content?.trim();
        if (continuationContent) content = [content, continuationContent].filter(Boolean).join("\n");
        lastCompletion = continuation;
      }
      if (!content) {
        if (lastCompletion.finishReason === "length") {
          return buildResult(
            "incomplete",
            "output_length",
            "模型的输出预算被推理内容耗尽，自动总结后仍未生成正文。已保留本轮工具结果，请降低 reasoning 强度或提高输出 token 后继续。",
          );
        }
        return buildResult(
          "blocked",
          "empty_response",
          mode === "plan"
            ? "模型没有返回文本或写操作。请补充元件标号、目标位置等信息后继续。"
            : "模型没有返回文本结果。当前上下文和工具记录已保留，可以继续重试。",
        );
      }
      const finalAnswer = parseFinalAnswer(content);
      const outputWasTruncated = lastCompletion.finishReason === "length";
      return buildResult(
        outputWasTruncated
          ? "incomplete"
          : plannedOperations.length > 0
            ? "awaiting_approval"
            : (finalAnswer.status ?? "completed"),
        outputWasTruncated ? "output_length" : "model_completed",
        finalAnswer.content,
      );
    }

    const visualResults: ToolResponse[] = [];
    let batchMadeProgress = false;
    let budgetStop: "tool_call_budget" | "elapsed_time_budget" | undefined;
    const recordProgress = (madeProgress: boolean): void => {
      if (madeProgress) {
        batchMadeProgress = true;
        consecutiveNoProgress = 0;
      } else {
        consecutiveNoProgress += 1;
      }
    };
    for (const call of calls) {
      if (Date.now() - startedAt >= limits.maxElapsedMs) {
        const error = `未执行：已达到 ${limits.maxElapsedMs}ms 的运行时间预算。`;
        budgetStop = "elapsed_time_budget";
        toolTrace.push({ tool: call.function.name, arguments: {}, status: "blocked", error });
        emit({ type: "tool_complete", tool: call.function.name, call: toolCalls, status: "blocked", error });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: stringifyForModel({ ok: false, error }),
        });
        continue;
      }
      if (toolCalls >= limits.maxToolCalls) {
        const error = `未执行：已达到 ${limits.maxToolCalls} 次工具调用预算。`;
        budgetStop = "tool_call_budget";
        toolTrace.push({ tool: call.function.name, arguments: {}, status: "blocked", error });
        emit({ type: "tool_complete", tool: call.function.name, call: toolCalls, status: "blocked", error });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: stringifyForModel({ ok: false, error }),
        });
        continue;
      }

      toolCalls += 1;
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
        emit({
          type: "tool_complete",
          tool: call.function.name,
          call: toolCalls,
          status: "failed",
          error: "工具参数不是合法 JSON。",
        });
        recordProgress(false);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: stringifyForModel({ ok: false, error: "工具参数不是合法 JSON。" }),
        });
        continue;
      }

      emit({ type: "phase", phase: "tool", message: `正在执行工具：${call.function.name}` });
      emit({ type: "tool_start", tool: call.function.name, call: toolCalls, arguments: argumentsValue });

      const actionKey = `${call.function.name}:${stableStringify(argumentsValue)}:${contextVersion}`;
      const actionRecord = actionRecords.get(actionKey) ?? { attempts: 0, noProgressAttempts: 0 };
      if (actionRecord.noProgressAttempts >= 1 + limits.maxRetriesPerAction) {
        const error = `相同工具和参数已连续 ${actionRecord.noProgressAttempts} 次没有形成新的结果，已阻止继续重复。`;
        toolTrace.push({ tool: call.function.name, arguments: argumentsValue, status: "blocked", error });
        emit({ type: "tool_complete", tool: call.function.name, call: toolCalls, status: "blocked", error });
        recordProgress(false);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: stringifyForModel({ ok: false, error, retryable: false }),
        });
        continue;
      }
      actionRecord.attempts += 1;
      actionRecords.set(actionKey, actionRecord);

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
          const resultFingerprint = `planned:${operationKey}`;
          const madeProgress = actionRecord.lastResult !== resultFingerprint;
          actionRecord.noProgressAttempts = madeProgress ? 0 : actionRecord.noProgressAttempts + 1;
          recordProgress(madeProgress);
          actionRecord.lastResult = resultFingerprint;
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
          emit({ type: "tool_complete", tool: call.function.name, call: toolCalls, status: "completed" });
          continue;
        }
        const error = "当前模型回合只允许只读工具；写操作需要单独的用户确认流程。";
        actionRecord.noProgressAttempts += 1;
        toolTrace.push({ tool: call.function.name, arguments: argumentsValue, status: "blocked", error });
        emit({ type: "tool_complete", tool: call.function.name, call: toolCalls, status: "blocked", error });
        recordProgress(false);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: stringifyForModel({ ok: false, error }),
        });
        continue;
      }

      const result = await args.executeTool(call.function.name, args.sessionId, argumentsValue);
      const resultFingerprint = resultFingerprintForProgress(result);
      const madeProgress = result.ok && actionRecord.lastResult !== resultFingerprint;
      actionRecord.noProgressAttempts = madeProgress ? 0 : actionRecord.noProgressAttempts + 1;
      actionRecord.lastResult = resultFingerprint;
      recordProgress(madeProgress);
      toolTrace.push({
        tool: call.function.name,
        arguments: argumentsValue,
        status: result.ok ? "completed" : "failed",
        result: result.ok ? result.data : undefined,
        error: result.ok ? undefined : result.error?.message,
      });
      emit({
        type: "tool_complete",
        tool: call.function.name,
        call: toolCalls,
        status: result.ok ? "completed" : "failed",
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
    if (budgetStop === "elapsed_time_budget") {
      return finalize("incomplete", budgetStop, `已达到 ${limits.maxElapsedMs}ms 的运行时间预算`);
    }
    if (budgetStop === "tool_call_budget" || toolCalls >= limits.maxToolCalls) {
      return finalize("incomplete", "tool_call_budget", `已达到 ${limits.maxToolCalls} 次工具调用预算`);
    }
    if (batchMadeProgress) recoveryAttempted = false;
    if (consecutiveNoProgress >= limits.maxNoProgress) {
      if (recoveryAttempted) {
        return finalize(
          "blocked",
          "no_progress",
          `连续两次恢复尝试都未取得新证据；最近 ${limits.maxNoProgress} 次工具操作没有进展`,
        );
      }
      recoveryAttempted = true;
      consecutiveNoProgress = 0;
      llmLog("no progress detected; requesting recovery strategy", {
        maxNoProgress: limits.maxNoProgress,
        toolCalls,
      });
      emit({ type: "phase", phase: "recovery", message: "连续操作没有获得新证据，正在切换策略…" });
      messages.push({
        role: "user",
        content: [
          "系统检测到连续工具操作没有取得新证据。",
          "不要重复相同的工具和参数。请改用其他工具、缩小查询范围，或停止工具调用并向用户说明缺少的信息和阻塞点。",
        ].join("\n"),
      });
    }
  }
};
