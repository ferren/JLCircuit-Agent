import readline from "node:readline";

const reply = (id, result) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const fail = (id, code, message) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
};

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "server/discover") {
    fail(message.id, -32601, "Legacy fixture");
    return;
  }
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: message.params?.protocolVersion || "2025-11-25",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "jlcircuit-mcp-fixture", version: "1.0.0" },
      instructions: "Fixture server for JLCircuit Agent tests.",
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    reply(message.id, {
      tools: [{
        name: "echo",
        description: "Echo test input.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      }],
    });
    return;
  }
  if (message.method === "tools/call") {
    const text = String(message.params?.arguments?.text || "");
    reply(message.id, {
      content: [{ type: "text", text: `echo:${text}` }],
      structuredContent: { echoed: text },
    });
    return;
  }
  if (message.method === "resources/list") {
    reply(message.id, {
      resources: [{ uri: "fixture://datasheet", name: "Fixture datasheet", mimeType: "text/plain" }],
    });
    return;
  }
  if (message.method === "resources/read") {
    reply(message.id, {
      contents: [{ uri: message.params?.uri, mimeType: "text/plain", text: "fixture resource" }],
    });
    return;
  }
  if (message.method === "prompts/list") {
    reply(message.id, {
      prompts: [{ name: "review", description: "Fixture review prompt" }],
    });
    return;
  }
  if (message.method === "prompts/get") {
    reply(message.id, {
      description: "Fixture review prompt",
      messages: [{ role: "user", content: { type: "text", text: "Review the fixture." } }],
    });
    return;
  }
  if (message.method === "ping") {
    reply(message.id, {});
    return;
  }
  if (message.id !== undefined) fail(message.id, -32601, `Unknown method: ${message.method}`);
});
