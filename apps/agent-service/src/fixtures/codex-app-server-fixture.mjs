import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
let threadCounter = 0;
let turnCounter = 0;
let dynamicTools = [];
const pendingTools = new Map();

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const finishTurn = ({ threadId, turnId, tool, toolResult }) => {
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      completedAtMs: Date.now(),
      item: {
        type: "dynamicToolCall",
        id: `tool-item-${turnId}`,
        namespace: null,
        tool,
        arguments: tool === "test_write" ? { target: "U1" } : { index: 1 },
        status: toolResult?.success ? "completed" : "failed",
        contentItems: toolResult?.contentItems ?? [],
        success: Boolean(toolResult?.success),
        durationMs: 1,
      },
    },
  });
  const message = tool === "test_write"
    ? "已登记待确认写操作。[[JLCIRCUIT_STATUS:completed]]"
    : "读取检查完成。[[JLCIRCUIT_STATUS:completed]]";
  const itemId = `answer-${turnId}`;
  send({
    method: "item/started",
    params: { threadId, turnId, item: { type: "agentMessage", id: itemId, text: "", phase: "final_answer", memoryCitation: null } },
  });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: message } });
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      completedAtMs: Date.now(),
      item: { type: "agentMessage", id: itemId, text: message, phase: "final_answer", memoryCitation: null },
    },
  });
  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId,
      turnId,
      tokenUsage: {
        total: {
          totalTokens: 30,
          inputTokens: 20,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 4,
        },
        last: {
          totalTokens: 30,
          inputTokens: 20,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 4,
        },
        modelContextWindow: 128000,
      },
    },
  });
  send({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, items: [], status: "completed", error: null } },
  });
};

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (process.env.JLCIRCUIT_UNRELATED_SECRET) {
      send({ id: message.id, error: { code: -32000, message: "Provider process inherited an unrelated secret." } });
      return;
    }
    send({ id: message.id, result: { userAgent: "fixture", platformFamily: "windows", platformOs: "windows" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    dynamicTools = message.params.dynamicTools ?? [];
    const threadId = `fixture-thread-${++threadCounter}`;
    send({
      id: message.id,
      result: {
        thread: { id: threadId, sessionId: threadId, preview: "", ephemeral: false },
        model: message.params.model,
        modelProvider: message.params.modelProvider,
        cwd: message.params.cwd,
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "read-only" },
        reasoningEffort: null,
      },
    });
    return;
  }
  if (message.method === "thread/resume") {
    const threadId = message.params.threadId;
    send({
      id: message.id,
      result: {
        thread: { id: threadId, sessionId: threadId, preview: "", ephemeral: false },
        model: message.params.model,
        modelProvider: message.params.modelProvider,
        cwd: message.params.cwd,
        instructionSources: [],
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "read-only" },
        reasoningEffort: null,
      },
    });
    return;
  }
  if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const turnId = `fixture-turn-${++turnCounter}`;
    const text = message.params.input?.find((item) => item.type === "text")?.text ?? "";
    const tool = text.includes("登记写操作") ? "test_write" : "test_read";
    if (!dynamicTools.some((item) => item.name === tool)) {
      send({ id: message.id, error: { code: -32602, message: `Missing dynamic tool: ${tool}` } });
      return;
    }
    send({ id: message.id, result: { turn: { id: turnId, items: [], status: "inProgress", error: null } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, items: [], status: "inProgress", error: null } } });
    const reasoningId = `reasoning-${turnId}`;
    send({
      method: "item/started",
      params: { threadId, turnId, item: { type: "reasoning", id: reasoningId, summary: [], content: [] } },
    });
    send({
      method: "item/reasoning/summaryTextDelta",
      params: { threadId, turnId, itemId: reasoningId, delta: "正在检查动态工具。", summaryIndex: 0 },
    });
    const requestId = 10_000 + turnCounter;
    pendingTools.set(requestId, { threadId, turnId, tool, repeatWrite: tool === "test_write" && text.includes("重复登记") });
    send({
      method: "item/tool/call",
      id: requestId,
      params: {
        threadId,
        turnId,
        callId: `call-${turnId}`,
        namespace: null,
        tool,
        arguments: tool === "test_write" ? { target: "U1" } : { index: 1 },
      },
    });
    return;
  }
  if (message.id !== undefined && pendingTools.has(message.id)) {
    const pending = pendingTools.get(message.id);
    pendingTools.delete(message.id);
    if (pending.tool === "test_read" && !message.result?.contentItems?.some((item) => item.type === "inputImage")) {
      send({
        method: "turn/completed",
        params: {
          threadId: pending.threadId,
          turn: {
            id: pending.turnId,
            items: [],
            status: "failed",
            error: { message: "Read tool did not return an inputImage item." },
          },
        },
      });
      return;
    }
    if (pending.repeatWrite && !pending.didRepeat) {
      const requestId = 20_000 + turnCounter;
      pendingTools.set(requestId, { ...pending, didRepeat: true });
      send({
        method: "item/tool/call",
        id: requestId,
        params: {
          threadId: pending.threadId,
          turnId: pending.turnId,
          callId: `repeat-call-${pending.turnId}`,
          namespace: null,
          tool: pending.tool,
          arguments: { target: "U1" },
        },
      });
      return;
    }
    finishTurn({ ...pending, toolResult: message.result });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
  }
});
