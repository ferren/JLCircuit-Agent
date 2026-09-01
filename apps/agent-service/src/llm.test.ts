import assert from "node:assert/strict";
import test from "node:test";
import type { EdaToolDefinition, ToolResponse } from "../../../packages/contracts/src/index.ts";
import type { PreparedAgentContext } from "./context-engine.ts";
import { runAgentTurn } from "./llm.ts";

const preparedContext: PreparedAgentContext = {
  sessionId: "llm-test",
  designContext: {
    project: { id: "project-1" },
    activeDocument: { id: "sheet-1" },
    capturedAt: "2026-08-27T00:00:00.000Z",
  },
  designContextText: "{}",
  sessionSummary: "",
  recentMessages: [],
  activeTasksText: "[]",
  diagnostics: {
    designOriginalChars: 2,
    designModelChars: 2,
    designCompacted: false,
    historyMessageCount: 0,
    historyChars: 0,
    summaryChars: 0,
    activeTaskCount: 0,
    totalPreparedChars: 4,
  },
};

const readTool: EdaToolDefinition = {
  name: "test_read",
  description: "Read test evidence",
  riskLevel: "read",
  enabled: true,
  inputSchema: {
    type: "object",
    properties: { index: { type: "number" } },
  },
};

const writeTool: EdaToolDefinition = {
  name: "test_write",
  description: "Write test operation",
  riskLevel: "high",
  enabled: true,
  inputSchema: {
    type: "object",
    required: ["target", "confirmWrite"],
    properties: {
      target: { type: "string" },
      confirmWrite: { const: true },
    },
  },
};

type MockAssistant = {
  content?: string | null;
  reasoning?: string | null;
  finishReason?: string;
  usage?: Record<string, unknown>;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

const toolCall = (index: number): MockAssistant => ({
  content: null,
  tool_calls: [{
    id: `call-${index}`,
    type: "function",
    function: { name: "test_read", arguments: JSON.stringify({ index }) },
  }],
});

const withMockModel = async (
  assistants: MockAssistant[],
  run: (requests: Array<Record<string, unknown>>) => Promise<void>,
  options: { sse?: boolean; provider?: string } = {},
): Promise<void> => {
  const originalFetch = globalThis.fetch;
  const envKeys = [
    "JLCIRCUIT_MODEL_PROVIDER",
    "JLCIRCUIT_LLM_BASE_URL",
    "JLCIRCUIT_LLM_API_KEY",
    "JLCIRCUIT_LLM_MODEL",
    "JLCIRCUIT_LLM_STREAMING",
    "JLCIRCUIT_LLM_TOOL_STREAM",
    "JLCIRCUIT_LLM_MAX_LENGTH_RECOVERIES",
    "JLCIRCUIT_LLM_REASONING_EFFORT",
    "JLCIRCUIT_LLM_FINAL_REASONING_EFFORT",
    "JLCIRCUIT_LLM_TOOL_RESULT_MAX_CHARS",
    "JLCIRCUIT_AGENT_MAX_TOOL_CALLS",
    "JLCIRCUIT_AGENT_MAX_ELAPSED_MS",
    "JLCIRCUIT_AGENT_MAX_NO_PROGRESS",
    "JLCIRCUIT_AGENT_MAX_RETRIES_PER_ACTION",
    "JLCIRCUIT_AGENT_FINALIZE_TIMEOUT_MS",
  ] as const;
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const requests: Array<Record<string, unknown>> = [];
  process.env.JLCIRCUIT_MODEL_PROVIDER = options.provider ?? "test";
  process.env.JLCIRCUIT_LLM_BASE_URL = "http://model.test/v1";
  process.env.JLCIRCUIT_LLM_API_KEY = "test-key";
  process.env.JLCIRCUIT_LLM_MODEL = "test-model";
  process.env.JLCIRCUIT_LLM_STREAMING = "true";
  process.env.JLCIRCUIT_LLM_MAX_LENGTH_RECOVERIES = "1";
  process.env.JLCIRCUIT_AGENT_MAX_ELAPSED_MS = "60000";
  process.env.JLCIRCUIT_AGENT_MAX_NO_PROGRESS = "2";
  process.env.JLCIRCUIT_AGENT_MAX_RETRIES_PER_ACTION = "2";
  process.env.JLCIRCUIT_AGENT_FINALIZE_TIMEOUT_MS = "1000";
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const assistant = assistants.shift();
    assert.ok(assistant, "mock model response queue was exhausted");
    const finishReason = assistant.finishReason ?? (assistant.tool_calls ? "tool_calls" : "stop");
    if (options.sse) {
      const chunks: string[] = [];
      if (assistant.reasoning) {
        chunks.push(`data: ${JSON.stringify({ model: "test-model", choices: [{ delta: { reasoning: assistant.reasoning }, finish_reason: null }] })}\n\n`);
      }
      if (assistant.content) {
        chunks.push(`data: ${JSON.stringify({ model: "test-model", choices: [{ delta: { content: assistant.content }, finish_reason: null }] })}\n\n`);
      }
      if (assistant.tool_calls) {
        chunks.push(`data: ${JSON.stringify({
          model: "test-model",
          choices: [{
            delta: {
              tool_calls: assistant.tool_calls.map((call, index) => ({ index, id: call.id, type: call.type, function: call.function })),
            },
            finish_reason: null,
          }],
        })}\n\n`);
      }
      chunks.push(`data: ${JSON.stringify({ model: "test-model", choices: [{ delta: {}, finish_reason: finishReason }], usage: assistant.usage })}\n\n`);
      chunks.push("data: [DONE]\n\n");
      return new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({
      model: "test-model",
      usage: assistant.usage,
      choices: [{ finish_reason: finishReason, message: { role: "assistant", content: assistant.content, reasoning: assistant.reasoning, tool_calls: assistant.tool_calls } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await run(requests);
    assert.equal(assistants.length, 0, "not all mock model responses were consumed");
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("agent continues past three tool requests until the model completes", { concurrency: false }, async () => {
  await withMockModel(
    [toolCall(1), toolCall(2), toolCall(3), toolCall(4), { content: "已完成四步检查。" }],
    async () => {
      process.env.JLCIRCUIT_AGENT_MAX_TOOL_CALLS = "10";
      const executed: number[] = [];
      const result = await runAgentTurn({
        instruction: "完成多步检查",
        sessionId: "llm-test",
        preparedContext,
        toolDefinitions: [readTool],
        activeSkills: [],
        executeTool: async (_tool, _sessionId, payload): Promise<ToolResponse> => {
          executed.push(Number(payload.index));
          return { requestId: crypto.randomUUID(), ok: true, data: { evidence: payload.index } };
        },
      });

      assert.deepEqual(executed, [1, 2, 3, 4]);
      assert.equal(result.status, "completed");
      assert.equal(result.message, "已完成四步检查。");
      assert.equal(result.runState.modelRequests, 5);
      assert.equal(result.runState.toolCalls, 4);
      assert.equal(result.runState.stopReason, "model_completed");
    },
  );
});

test("ordinary chat records write tool calls as confirmation-required operations", { concurrency: false }, async () => {
  await withMockModel(
    [
      {
        content: null,
        tool_calls: [{
          id: "write-call-1",
          type: "function",
          function: { name: "test_write", arguments: JSON.stringify({ target: "U1" }) },
        }],
      },
      { content: "已生成待确认修改。" },
    ],
    async (requests) => {
      let executed = false;
      const result = await runAgentTurn({
        instruction: "修改 U1",
        sessionId: "llm-test",
        preparedContext,
        toolDefinitions: [writeTool],
        activeSkills: [],
        mode: "chat",
        executeTool: async (): Promise<ToolResponse> => {
          executed = true;
          return { requestId: crypto.randomUUID(), ok: true };
        },
      });

      assert.equal(executed, false);
      assert.equal(result.plannedOperations.length, 1);
      assert.equal(result.plannedOperations[0]?.tool, "test_write");
      assert.deepEqual(result.plannedOperations[0]?.args, { target: "U1" });
      assert.equal(result.message, "已生成待确认修改。");
      const tools = requests[0]?.tools as Array<{ function?: { description?: string; parameters?: Record<string, unknown> } }>;
      const modelTool = tools[0]?.function;
      assert.match(modelTool?.description ?? "", /不要在调用前要求用户回复确认或登记/);
      assert.deepEqual(modelTool?.parameters?.required, ["target"]);
      assert.equal(Object.hasOwn(modelTool?.parameters?.properties as object, "confirmWrite"), false);
    },
  );
});

test("premature confirmation requests are corrected within the same turn", { concurrency: false }, async () => {
  await withMockModel(
    [
      { content: "请先回复确认，确认后我才能登记并执行修改。" },
      {
        content: null,
        tool_calls: [{
          id: "write-call-after-recovery",
          type: "function",
          function: { name: "test_write", arguments: JSON.stringify({ target: "U2" }) },
        }],
      },
      { content: "已登记 U2 修改，请使用界面的确认执行按钮。" },
    ],
    async (requests) => {
      const result = await runAgentTurn({
        instruction: "修改 U2",
        sessionId: "llm-test",
        preparedContext,
        toolDefinitions: [writeTool],
        activeSkills: [],
        mode: "chat",
        executeTool: async (): Promise<ToolResponse> => {
          assert.fail("write tools must not execute before UI confirmation");
        },
      });

      assert.equal(requests.length, 3);
      assert.equal(result.status, "awaiting_approval");
      assert.equal(result.plannedOperations.length, 1);
      assert.deepEqual(result.plannedOperations[0]?.args, { target: "U2" });
      assert.equal(result.message, "已登记 U2 修改，请使用界面的确认执行按钮。");
      const recoveryMessages = requests[1]?.messages as Array<{ role?: string; content?: string }>;
      assert.match(recoveryMessages.at(-1)?.content ?? "", /不要向用户索要口头确认/);
    },
  );
});

test("future-turn registration instructions are corrected instead of creating a user loop", { concurrency: false }, async () => {
  await withMockModel(
    [
      { content: "新开一轮发一句‘登记 U013 移动’，我下一轮再登记操作。" },
      {
        content: null,
        tool_calls: [{
          id: "write-call-after-deferral-recovery",
          type: "function",
          function: { name: "test_write", arguments: JSON.stringify({ target: "U013" }) },
        }],
      },
      { content: "已在本轮登记 U013 修改。" },
    ],
    async (requests) => {
      const result = await runAgentTurn({
        instruction: "重试 U013 移动",
        sessionId: "llm-test",
        preparedContext,
        toolDefinitions: [writeTool],
        activeSkills: [],
        mode: "chat",
        executeTool: async (): Promise<ToolResponse> => {
          assert.fail("write tools must not execute before UI confirmation");
        },
      });

      assert.equal(result.status, "awaiting_approval");
      assert.equal(result.plannedOperations.length, 1);
      const recoveryMessages = requests[1]?.messages as Array<{ role?: string; content?: string }>;
      assert.match(recoveryMessages.at(-1)?.content ?? "", /不要向用户索要口头确认/);
    },
  );
});

test("oversized tool results are capped before the next model request", { concurrency: false }, async () => {
  await withMockModel(
    [toolCall(1), { content: "已基于截断摘要完成检查。" }],
    async (requests) => {
      process.env.JLCIRCUIT_LLM_TOOL_RESULT_MAX_CHARS = "100";
      const result = await runAgentTurn({
        instruction: "读取大型结果",
        sessionId: "llm-test",
        preparedContext,
        toolDefinitions: [readTool],
        activeSkills: [],
        executeTool: async (): Promise<ToolResponse> => ({
          requestId: crypto.randomUUID(),
          ok: true,
          data: { payload: "x".repeat(1_000) },
        }),
      });

      const secondMessages = requests[1]?.messages as Array<{ role?: string; content?: string }>;
      const toolMessage = [...secondMessages].reverse().find((message) => message.role === "tool");
      assert.match(toolMessage?.content ?? "", /\"truncated\":true/);
      assert.match(toolMessage?.content ?? "", /不要重复无参数全量调用/);
      assert.equal(result.status, "completed");
    },
  );
});

test("false tool restriction claims are corrected using the current tool list", { concurrency: false }, async () => {
  await withMockModel(
    [
      { content: "本轮被禁止调用工具，无法登记修改。" },
      {
        content: null,
        tool_calls: [{
          id: "write-call-after-tool-availability-recovery",
          type: "function",
          function: { name: "test_write", arguments: JSON.stringify({ target: "U3" }) },
        }],
      },
      { content: "已登记 U3 修改，请点击确认执行。" },
    ],
    async (requests) => {
      const result = await runAgentTurn({
        instruction: "继续登记 U3 修改",
        sessionId: "llm-test",
        preparedContext,
        toolDefinitions: [writeTool],
        activeSkills: [],
        mode: "chat",
        executeTool: async (): Promise<ToolResponse> => {
          assert.fail("write tools must not execute before UI confirmation");
        },
      });

      assert.equal(requests.length, 3);
      assert.equal(result.status, "awaiting_approval");
      assert.equal(result.plannedOperations.length, 1);
      assert.deepEqual(result.plannedOperations[0]?.args, { target: "U3" });
      const recoveryMessages = requests[1]?.messages as Array<{ role?: string; content?: string }>;
      assert.match(recoveryMessages.at(-1)?.content ?? "", /实际已经提供写工具：test_write/);
      assert.match(recoveryMessages.at(-1)?.content ?? "", /历史消息.*过期状态/);
    },
  );
});

test("model can explicitly pause for required user input without leaking the status marker", { concurrency: false }, async () => {
  await withMockModel(
    [{ content: "请补充 U1 的完整型号。\n[[JLCIRCUIT_STATUS:awaiting_user]]" }],
    async () => {
      process.env.JLCIRCUIT_AGENT_MAX_TOOL_CALLS = "10";
      const result = await runAgentTurn({
        instruction: "检查 U1",
        sessionId: "llm-test",
        preparedContext,
        toolDefinitions: [readTool],
        activeSkills: [],
        executeTool: async (): Promise<ToolResponse> => ({ requestId: crypto.randomUUID(), ok: true }),
      });

      assert.equal(result.status, "awaiting_user");
      assert.equal(result.message, "请补充 U1 的完整型号。");
      assert.equal(result.runState.checkpoint.resumable, true);
    },
  );
});

test("SSE model responses stream reasoning, content and exact token usage", { concurrency: false }, async () => {
  await withMockModel(
    [{
      reasoning: "正在核对证据。",
      content: "检查完成。",
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        completion_tokens_details: { reasoning_tokens: 18 },
      },
    }],
    async (requests) => {
      process.env.JLCIRCUIT_AGENT_MAX_TOOL_CALLS = "10";
      const events: Array<{ type: string; delta?: string }> = [];
      const result = await runAgentTurn({
        instruction: "流式检查",
        sessionId: "llm-test",
        preparedContext,
        toolDefinitions: [readTool],
        activeSkills: [],
        onEvent: (event) => events.push(event),
        executeTool: async (): Promise<ToolResponse> => ({ requestId: crypto.randomUUID(), ok: true }),
      });

      assert.equal(requests[0]?.stream, true);
      assert.equal(requests[0]?.tool_stream, true);
      assert.equal(events.some((event) => event.type === "reasoning_delta" && event.delta === "正在核对证据。"), true);
      assert.equal(events.some((event) => event.type === "content_delta" && event.delta === "检查完成。"), true);
      assert.equal(events.some((event) => event.type === "usage"), true);
      assert.deepEqual(result.runState.usage, {
        promptTokens: 120,
        completionTokens: 30,
        reasoningTokens: 18,
        totalTokens: 150,
      });
      assert.equal(result.message, "检查完成。");
    },
    { sse: true, provider: "zai" },
  );
});

test("reasoning-only length responses are automatically continued as a tool-free final answer", { concurrency: false }, async () => {
  await withMockModel(
    [
      { content: null, reasoning: "很长的分析过程", finishReason: "length" },
      { content: "基于现有证据，设计检查完成。", finishReason: "stop" },
    ],
    async (requests) => {
      process.env.JLCIRCUIT_AGENT_MAX_TOOL_CALLS = "10";
      const phases: string[] = [];
      const result = await runAgentTurn({
        instruction: "避免只输出思考",
        sessionId: "llm-test",
        preparedContext,
        toolDefinitions: [readTool],
        activeSkills: [],
        onEvent: (event) => {
          if (event.type === "phase") phases.push(event.phase);
        },
        executeTool: async (): Promise<ToolResponse> => ({ requestId: crypto.randomUUID(), ok: true }),
      });

      assert.equal(result.status, "completed");
      assert.equal(result.message, "基于现有证据，设计检查完成。");
      assert.equal(result.runState.modelRequests, 2);
      assert.equal(phases.includes("recovery"), true);
      assert.equal("tools" in requests[1]!, false);
    },
  );
});

test("tool budget triggers a tool-free final synthesis with a resumable checkpoint", { concurrency: false }, async () => {
  await withMockModel(
    [toolCall(1), toolCall(2), { content: "已检查两项；其余项目可在下一轮继续。" }],
    async (requests) => {
      process.env.JLCIRCUIT_AGENT_MAX_TOOL_CALLS = "2";
      let executionCount = 0;
      const result = await runAgentTurn({
        instruction: "检查所有项目",
        sessionId: "llm-test",
        preparedContext,
        toolDefinitions: [readTool],
        activeSkills: [],
        executeTool: async (_tool, _sessionId, payload): Promise<ToolResponse> => {
          executionCount += 1;
          return { requestId: crypto.randomUUID(), ok: true, data: { evidence: payload.index } };
        },
      });

      assert.equal(executionCount, 2);
      assert.equal(result.status, "incomplete");
      assert.equal(result.runState.stopReason, "tool_call_budget");
      assert.equal(result.runState.checkpoint.resumable, true);
      assert.equal(result.message, "已检查两项；其余项目可在下一轮继续。");
      assert.equal(requests.length, 3);
      assert.equal("tools" in requests[2]!, false);
      assert.equal("tool_choice" in requests[2]!, false);
    },
  );
});

test("repeated failures get one recovery chance before stopping as no progress", { concurrency: false }, async () => {
  await withMockModel(
    [toolCall(1), toolCall(2), toolCall(3), toolCall(4), { content: "读取工具持续失败，需要检查 EDA 连接。" }],
    async () => {
      process.env.JLCIRCUIT_AGENT_MAX_TOOL_CALLS = "10";
      process.env.JLCIRCUIT_AGENT_MAX_NO_PROGRESS = "2";
      const result = await runAgentTurn({
        instruction: "读取设计证据",
        sessionId: "llm-test",
        preparedContext,
        toolDefinitions: [readTool],
        activeSkills: [],
        executeTool: async (): Promise<ToolResponse> => ({
          requestId: crypto.randomUUID(),
          ok: false,
          error: { code: "BRIDGE_ERROR", message: "bridge unavailable", retryable: true },
        }),
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.runState.stopReason, "no_progress");
      assert.equal(result.runState.toolCalls, 4);
      assert.equal(result.message, "读取工具持续失败，需要检查 EDA 连接。");
    },
  );
});

test("request ids do not make an unchanged tool result look like progress", { concurrency: false }, async () => {
  await withMockModel(
    [toolCall(1), toolCall(1), toolCall(1), { content: "工具结果没有变化。" }],
    async () => {
      process.env.JLCIRCUIT_AGENT_MAX_TOOL_CALLS = "10";
      process.env.JLCIRCUIT_AGENT_MAX_NO_PROGRESS = "1";
      const result = await runAgentTurn({
        instruction: "持续检查状态",
        sessionId: "llm-test",
        preparedContext,
        toolDefinitions: [readTool],
        activeSkills: [],
        executeTool: async (): Promise<ToolResponse> => ({
          requestId: crypto.randomUUID(),
          ok: true,
          data: { unchanged: true },
        }),
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.runState.stopReason, "no_progress");
      assert.equal(result.runState.toolCalls, 3);
    },
  );
});
