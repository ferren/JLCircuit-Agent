import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { EdaToolDefinition, ToolResponse } from "../../../packages/contracts/src/index.ts";
import type { PreparedAgentContext } from "./context-engine.ts";
import {
  CodexProviderPool,
  loadCodexProviderPoolConfig,
  providerConfigArgs,
  providerModelCatalog,
  resolveCodexCommand,
  type CodexProviderPoolConfig,
} from "./codex-provider-pool.ts";
import { AgentStore } from "./storage.ts";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "codex-app-server-fixture.mjs",
);

const preparedContext: PreparedAgentContext = {
  sessionId: "codex-test",
  designContext: { project: { id: "project-1" }, activeDocument: { id: "sheet-1" } },
  designContextText: "{\"project\":{\"id\":\"project-1\"}}",
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
  description: "Read evidence",
  riskLevel: "read",
  enabled: true,
  inputSchema: { type: "object", properties: { index: { type: "number" } } },
};

const writeTool: EdaToolDefinition = {
  name: "test_write",
  description: "Plan a write",
  riskLevel: "high",
  enabled: true,
  inputSchema: {
    type: "object",
    required: ["target", "confirmWrite"],
    properties: { target: { type: "string" }, confirmWrite: { const: true } },
  },
};

const poolConfig = (): CodexProviderPoolConfig => ({
  defaultProviderId: "fixture",
  providers: new Map([[
    "fixture",
    {
      name: "Fixture",
      baseUrl: "http://fixture.invalid/v1",
      model: "fixture-model",
      apiKeyEnv: "JLCIRCUIT_FIXTURE_KEY",
      apiKeyValue: "fixture-secret",
      enabled: true,
      wireApi: "responses",
    },
  ]]),
});

test("Windows Codex command resolution prefers native exe and supports npm wrappers", () => {
  const directory = mkdtempSync(join(tmpdir(), "jlcircuit-codex-command-"));
  try {
    const npmBin = join(directory, "npm-bin");
    const desktopBin = join(directory, "desktop-bin");
    const npmScript = join(npmBin, "node_modules", "@openai", "codex", "bin", "codex.js");
    mkdirSync(dirname(npmScript), { recursive: true });
    mkdirSync(desktopBin, { recursive: true });
    writeFileSync(join(npmBin, "codex.cmd"), "@echo off\r\n");
    writeFileSync(npmScript, "// fixture\n");
    writeFileSync(join(desktopBin, "codex.exe"), "fixture");

    const native = resolveCodexCommand("codex", {
      platform: "win32",
      pathValue: `${npmBin};${desktopBin}`,
      localAppData: join(directory, "missing-local-app-data"),
      nodeCommand: "fixture-node.exe",
    });
    assert.equal(native.command, join(desktopBin, "codex.exe"));
    assert.deepEqual(native.prefixArgs, []);
    assert.equal(native.source, "path-exe");

    const npm = resolveCodexCommand("codex", {
      platform: "win32",
      pathValue: npmBin,
      localAppData: join(directory, "missing-local-app-data"),
      nodeCommand: "fixture-node.exe",
    });
    assert.equal(npm.command, "fixture-node.exe");
    assert.deepEqual(npm.prefixArgs, [npmScript]);
    assert.equal(npm.source, "npm-wrapper");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider config is loaded without storing API keys and rejects Chat Completions wire mode", () => {
  const directory = mkdtempSync(join(tmpdir(), "jlcircuit-codex-config-"));
  try {
    const validPath = join(directory, "providers.json");
    writeFileSync(validPath, JSON.stringify({
      defaultProvider: "openrouter",
      providers: {
        openrouter: {
          name: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1/",
        model: "example/model",
        apiKeyEnv: "OPENROUTER_API_KEY",
        wireApi: "responses",
        modelMetadata: {
          contextWindow: 262144,
          maxOutputTokens: 32768,
          inputModalities: ["text", "image"],
          reasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "high",
        },
        },
      },
    }));
    const loaded = loadCodexProviderPoolConfig(validPath);
    assert.equal(loaded.defaultProviderId, "openrouter");
    assert.equal(loaded.providers.get("openrouter")?.baseUrl, "https://openrouter.ai/api/v1");
    assert.equal(loaded.providers.get("openrouter")?.apiKeyEnv, "OPENROUTER_API_KEY");
    assert.equal(loaded.providers.get("openrouter")?.apiKeyValue, undefined);
    assert.equal(loaded.providers.get("openrouter")?.modelMetadata?.contextWindow, 262144);

    const invalidPath = join(directory, "invalid.json");
    writeFileSync(invalidPath, JSON.stringify({
      providers: {
        legacy: {
          baseUrl: "https://example.invalid/v1",
          model: "legacy-model",
          apiKeyEnv: "LEGACY_KEY",
          wireApi: "chat_completions",
        },
      },
    }));
    assert.throws(() => loadCodexProviderPoolConfig(invalidPath), /only responses is supported/);

    const secretHeaderPath = join(directory, "secret-header.json");
    writeFileSync(secretHeaderPath, JSON.stringify({
      providers: {
        unsafe: {
          baseUrl: "https://example.invalid/v1",
          model: "unsafe-model",
          apiKeyEnv: "UNSAFE_KEY",
          wireApi: "responses",
          httpHeaders: { Authorization: "Bearer committed-secret" },
        },
      },
    }));
    assert.throws(() => loadCodexProviderPoolConfig(secretHeaderPath), /must not store secret headers/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider model metadata generates an isolated Codex catalog and startup override", () => {
  const provider = {
    ...poolConfig().providers.get("fixture")!,
    modelMetadata: {
      contextWindow: 262144,
      maxOutputTokens: 32768,
      inputModalities: ["text", "image"] as Array<"text" | "image">,
      reasoningEfforts: ["low", "max"],
      defaultReasoningEffort: "max",
    },
  };
  const catalog = providerModelCatalog(provider);
  assert.equal(catalog?.models[0]?.slug, "fixture-model");
  assert.equal(typeof catalog?.models[0]?.base_instructions, "string");
  assert.equal(catalog?.models[0]?.context_window, 262144);
  assert.deepEqual(catalog?.models[0]?.input_modalities, ["text", "image"]);
  const args = providerConfigArgs("fixture", provider, "C:/runtime/jlcircuit-model-catalog.json");
  assert.ok(args.includes('model_catalog_json="C:/runtime/jlcircuit-model-catalog.json"'));
});

test("provider process pool streams events, executes reads and only plans writes", async () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "jlcircuit-codex-runtime-"));
  const previousUnrelatedSecret = process.env.JLCIRCUIT_UNRELATED_SECRET;
  process.env.JLCIRCUIT_UNRELATED_SECRET = "must-not-reach-provider";
  const store = new AgentStore(":memory:");
  const pool = new CodexProviderPool(store, () => undefined, {
    command: process.execPath,
    commandPrefixArgs: [fixturePath],
    config: poolConfig(),
    requestTimeoutMs: 5_000,
    maxProcesses: 2,
    cwd: runtimeDirectory,
    codexHomeRoot: join(runtimeDirectory, "codex-home"),
  });
  try {
    let readCalls = 0;
    const events: string[] = [];
    const executeTool = async (tool: string): Promise<ToolResponse> => {
      assert.equal(tool, "test_read");
      readCalls += 1;
      return {
        requestId: crypto.randomUUID(),
        ok: true,
        data: { evidence: "ok" },
        content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
      };
    };
    const first = await pool.runTurn({
      instruction: "读取设计",
      sessionId: "codex-test",
      preparedContext,
      toolDefinitions: [readTool, writeTool],
      executeTool,
      activeSkills: [],
      onEvent: (event) => events.push(event.type),
    });
    assert.equal(first.status, "completed");
    assert.equal(first.message, "读取检查完成。");
    assert.equal(readCalls, 1);
    assert.equal(first.toolTrace[0]?.tool, "test_read");
    assert.equal(first.runState.usage.totalTokens, 30);
    assert.equal(first.runState.modelRequests, 1);
    assert.ok(events.includes("reasoning_delta"));
    assert.ok(events.includes("content_delta"));
    assert.ok(events.includes("usage"));
    const persisted = store.getCodexThread("codex-test", "fixture");
    assert.ok(persisted?.threadId);

    const second = await pool.runTurn({
      instruction: "登记写操作",
      sessionId: "codex-test",
      preparedContext,
      toolDefinitions: [readTool, writeTool],
      executeTool,
      activeSkills: [],
    });
    assert.equal(readCalls, 1, "write tools must not reach the EDA executor before confirmation");
    assert.equal(second.status, "awaiting_approval");
    assert.equal(second.plannedOperations.length, 1);
    assert.equal(second.plannedOperations[0]?.tool, "test_write");
    assert.deepEqual(second.plannedOperations[0]?.args, { target: "U1" });
    assert.equal(store.getCodexThread("codex-test", "fixture")?.threadId, persisted?.threadId);
    assert.equal(pool.list()[0]?.process, "ready");

    const repeated = await pool.runTurn({
      instruction: "登记写操作并重复登记",
      sessionId: "codex-test-repeat",
      preparedContext,
      toolDefinitions: [readTool, writeTool],
      executeTool,
      activeSkills: [],
    });
    assert.equal(repeated.status, "awaiting_approval");
    assert.equal(repeated.plannedOperations.length, 1, "a duplicate write must not create a second ChangeSet operation");
    assert.equal(repeated.toolTrace.length, 2);
    assert.equal(repeated.toolTrace[0]?.status, "completed");
    assert.equal(repeated.toolTrace[1]?.status, "blocked");
    assert.match(repeated.toolTrace[1]?.error ?? "", /已登记/);
    assert.equal(repeated.runState.stopReason, "no_progress");
  } finally {
    await pool.close();
    store.close();
    if (previousUnrelatedSecret === undefined) delete process.env.JLCIRCUIT_UNRELATED_SECRET;
    else process.env.JLCIRCUIT_UNRELATED_SECRET = previousUnrelatedSecret;
    try {
      rmSync(runtimeDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      // Some Windows Node builds retain the child cwd until the parent test
      // process exits. This is cleanup-only; the behavioral assertions above
      // have already completed and the OS will remove the temporary profile.
      if (!(error && typeof error === "object" && "code" in error && error.code === "EPERM")) throw error;
    }
  }
});
