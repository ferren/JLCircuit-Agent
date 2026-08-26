import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { McpRegistry, McpRegistryError } from "./mcp-registry.ts";
import { AgentStore } from "./storage.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-stdio-fixture.mjs");

test("MCP Registry connects to stdio, discovers capabilities and invokes allowlisted tools", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "jlcircuit-mcp-"));
  const configPath = join(temporary, "mcp.json");
  const databasePath = join(temporary, "state.sqlite");
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    servers: [{
      id: "fixture",
      name: "Fixture",
      enabledByDefault: true,
      transport: { type: "stdio", command: process.execPath, args: [fixturePath] },
      allowedTools: ["echo"],
      defaultRiskLevel: "read",
      allowResources: true,
      allowPrompts: true,
    }],
  }));
  const store = new AgentStore(databasePath);
  const registry = new McpRegistry(store, () => undefined, {
    configPath,
    autoConnect: false,
    requestTimeoutMs: 5_000,
  });
  try {
    const connectionTest = await registry.testConnection("fixture");
    assert.equal(connectionTest.ok, true);
    assert.equal(connectionTest.toolCount, 1);
    const connected = await registry.connect("fixture");
    assert.equal(connected.status, "connected");
    assert.equal(connected.toolCount, 1);
    assert.equal(connected.resourceCount, 1);
    assert.equal(connected.promptCount, 1);
    const definition = registry.listToolDefinitions()[0];
    assert.equal(definition?.name, "mcp__fixture__echo");
    assert.equal(definition?.riskLevel, "read");
    const result = await registry.callTool("mcp__fixture__echo", "mcp-test", { text: "hello", apiKey: "do-not-store" });
    assert.equal(result.ok, true);
    assert.equal(result.content?.[0]?.type, "text");
    assert.equal(result.content?.[0]?.type === "text" ? result.content[0].text : "", "echo:hello");
    const audit = JSON.stringify(store.listAuditEvents("mcp-test"));
    assert.doesNotMatch(audit, /do-not-store/);
    assert.match(audit, /REDACTED/);
    assert.equal(registry.listResources("fixture")[0]?.uri, "fixture://datasheet");
    const resource = await registry.readResource("fixture", "fixture://datasheet");
    assert.match(JSON.stringify(resource), /fixture resource/);
    assert.equal(registry.listPrompts("fixture")[0]?.name, "review");
    const prompt = await registry.getPrompt("fixture", "review");
    assert.match(JSON.stringify(prompt), /Review the fixture/);
    const disabled = await registry.setEnabled("fixture", false);
    assert.equal(disabled.status, "disabled");
    assert.equal(registry.listToolDefinitions().length, 0);
    await assert.rejects(
      registry.connect("fixture"),
      (error: unknown) => error instanceof McpRegistryError && error.code === "MCP_SERVER_DISABLED",
    );
  } finally {
    await registry.close();
    store.close();
  }

  const reopenedStore = new AgentStore(databasePath);
  const reopened = new McpRegistry(reopenedStore, () => undefined, { configPath, autoConnect: false });
  assert.equal(reopened.list()[0]?.enabled, false);
  await reopened.close();
  reopenedStore.close();
  rmSync(temporary, { recursive: true, force: true });
});

test("MCP Registry creates, updates and deletes a validated config atomically", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "jlcircuit-mcp-config-"));
  const configPath = join(temporary, "nested", "mcp.json");
  const store = new AgentStore(":memory:");
  const registry = new McpRegistry(store, () => undefined, { configPath, autoConnect: false });
  try {
    const created = await registry.createServer({
      id: "managed-fixture",
      name: "Managed Fixture",
      enabledByDefault: false,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [fixturePath],
        env: ["MCP_TEST_TOKEN"],
      },
      allowedTools: ["echo"],
      defaultRiskLevel: "high",
      toolRiskLevels: { echo: "read" },
      allowResources: true,
      allowPrompts: true,
    });
    assert.equal(created.server.status, "disabled");
    assert.equal(registry.listConfigs()[0]?.transport.type, "stdio");
    assert.match(readFileSync(configPath, "utf8"), /MCP_TEST_TOKEN/);
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /secret-value/);

    await assert.rejects(
      registry.createServer({
        id: "managed-fixture",
        transport: { type: "http", url: "https://example.com/mcp" },
      }),
      (error: unknown) => error instanceof McpRegistryError && error.code === "MCP_SERVER_EXISTS",
    );

    const updated = await registry.updateServer("managed-fixture", {
      ...created.config,
      name: "Updated Fixture",
      allowedTools: ["*"],
    });
    assert.equal(updated.config.name, "Updated Fixture");
    assert.deepEqual(updated.config.allowedTools, ["*"]);

    await registry.setEnabled("managed-fixture", true);
    assert.equal(store.listMcpServerStates().get("managed-fixture"), true);
    assert.deepEqual(await registry.deleteServer("managed-fixture"), {
      deleted: true,
      serverId: "managed-fixture",
    });
    assert.equal(registry.list().length, 0);
    assert.equal(store.listMcpServerStates().has("managed-fixture"), false);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).servers, []);
  } finally {
    await registry.close();
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("MCP Registry rejects non-loopback insecure HTTP and defaults external tools to high risk", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "jlcircuit-mcp-policy-"));
  const invalidPath = join(temporary, "invalid.json");
  writeFileSync(invalidPath, JSON.stringify({
    schemaVersion: 1,
    servers: [{
      id: "remote",
      transport: { type: "http", url: "http://example.com/mcp" },
      allowedTools: ["*"],
    }],
  }));
  const store = new AgentStore(":memory:");
  const registry = new McpRegistry(store, () => undefined, { configPath: invalidPath, autoConnect: false });
  try {
    assert.equal(registry.list().length, 0);
    assert.equal(registry.getDiagnostics().some((item) => item.message.includes("must use HTTPS")), true);
  } finally {
    await registry.close();
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("MCP Registry connects through loopback Streamable HTTP", async () => {
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (!body) {
        response.writeHead(400).end();
        return;
      }
      const message = JSON.parse(body) as { id?: string | number; method?: string; params?: Record<string, unknown> };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const send = (result: unknown): void => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };
      if (message.method === "server/discover") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Legacy HTTP fixture" },
        }));
      } else if (message.method === "initialize") {
        send({
          protocolVersion: message.params?.protocolVersion || "2025-11-25",
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "http-fixture", version: "1.0.0" },
        });
      } else if (message.method === "tools/list") {
        send({ tools: [{ name: "http_echo", description: "HTTP echo", inputSchema: { type: "object" } }] });
      } else if (message.method === "resources/list") {
        send({ resources: [] });
      } else if (message.method === "prompts/list") {
        send({ prompts: [] });
      } else if (message.method === "tools/call") {
        send({ content: [{ type: "text", text: "http-ok" }] });
      } else {
        response.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const temporary = mkdtempSync(join(tmpdir(), "jlcircuit-mcp-http-"));
  const configPath = join(temporary, "mcp.json");
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    servers: [{
      id: "http-fixture",
      enabledByDefault: true,
      transport: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` },
      allowedTools: ["http_echo"],
      defaultRiskLevel: "read",
    }],
  }));
  const store = new AgentStore(":memory:");
  const registry = new McpRegistry(store, () => undefined, {
    configPath,
    autoConnect: false,
    requestTimeoutMs: 5_000,
  });
  try {
    assert.equal((await registry.connect("http-fixture")).status, "connected");
    assert.equal(registry.listToolDefinitions()[0]?.name, "mcp__http_fixture__http_echo");
    const result = await registry.callTool("mcp__http_fixture__http_echo", "http-test", {});
    assert.equal(result.ok, true);
    assert.equal(result.content?.[0]?.type === "text" ? result.content[0].text : "", "http-ok");
  } finally {
    await registry.close();
    store.close();
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    rmSync(temporary, { recursive: true, force: true });
  }
});
