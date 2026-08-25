import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EdaToolDefinition } from "../../../packages/contracts/src/index.ts";
import { SkillRegistry, SkillRegistryError } from "./skill-registry.ts";
import { AgentStore } from "./storage.ts";

const tools: EdaToolDefinition[] = [
  { name: "read_context", description: "read", riskLevel: "read", inputSchema: {}, enabled: true },
  { name: "move_component", description: "move", riskLevel: "high", inputSchema: {}, enabled: true },
];

const writeSkill = (
  root: string,
  directory: string,
  overrides: Record<string, unknown> = {},
): void => {
  const path = join(root, directory);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "skill.json"), JSON.stringify({
    schemaVersion: 1,
    id: directory,
    name: directory,
    version: "1.0.0",
    description: "test skill",
    entry: "SKILL.md",
    enabledByDefault: true,
    riskLevel: "read",
    priority: 10,
    activation: { always: false, keywords: ["布局"], modes: ["chat", "plan"] },
    tools: { allowed: ["read_context"], required: ["read_context"] },
    ...overrides,
  }));
  writeFileSync(join(path, "SKILL.md"), "# Test\nFollow this workflow.");
};

test("Skill Registry activates always, keyword and explicitly requested skills with tool union", () => {
  const root = mkdtempSync(join(tmpdir(), "jlcircuit-skills-"));
  const store = new AgentStore(":memory:");
  try {
    writeSkill(root, "core", {
      priority: 100,
      activation: { always: true, keywords: [], modes: ["chat", "plan"] },
    });
    writeSkill(root, "layout", {
      riskLevel: "high",
      tools: { allowed: ["read_context", "move_component"], required: ["read_context"] },
    });
    writeSkill(root, "plugins", {
      riskLevel: "read",
      activation: { always: false, keywords: ["插件"], modes: ["chat", "plan"] },
      tools: { allowed: ["mcp__*"], required: [] },
    });
    const registry = new SkillRegistry(store, tools, { roots: [root] });
    const automatic = registry.resolve({ instruction: "检查布局", mode: "plan" });
    assert.deepEqual(automatic.skills.map((skill) => skill.id), ["core", "layout"]);
    assert.equal(automatic.allowedToolNames.has("move_component"), true);
    const explicit = registry.resolve({ instruction: "普通问题", mode: "chat", requestedSkillIds: ["layout"] });
    assert.equal(explicit.skills.find((skill) => skill.id === "layout")?.reason, "requested");
    const pluginSkills = registry.resolve({ instruction: "使用插件", mode: "chat" }).skills;
    const filtered = registry.filterToolDefinitions(pluginSkills, [
      ...tools,
      { name: "mcp__fixture__read", description: "external", riskLevel: "read", inputSchema: {}, enabled: true },
      { name: "mcp__fixture__write", description: "external write", riskLevel: "high", inputSchema: {}, enabled: true },
    ]);
    assert.equal(filtered.some((tool) => tool.name === "mcp__fixture__read"), true);
    assert.equal(filtered.some((tool) => tool.name === "mcp__fixture__write"), false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Skill Registry persists enable state and reports invalid manifests", () => {
  const root = mkdtempSync(join(tmpdir(), "jlcircuit-skills-invalid-"));
  const databasePath = join(root, "state.sqlite");
  try {
    writeSkill(root, "valid");
    writeSkill(root, "invalid", { tools: { allowed: ["unknown_tool"], required: [] } });
    const firstStore = new AgentStore(databasePath);
    const first = new SkillRegistry(firstStore, tools, { roots: [root] });
    assert.equal(first.getDiagnostics().some((item) => item.message.includes("Unknown tools")), true);
    first.setEnabled("valid", false);
    assert.throws(
      () => first.resolve({ instruction: "x", mode: "chat", requestedSkillIds: ["valid"] }),
      (error: unknown) => error instanceof SkillRegistryError && error.code === "SKILL_DISABLED",
    );
    firstStore.close();

    const reopenedStore = new AgentStore(databasePath);
    const reopened = new SkillRegistry(reopenedStore, tools, { roots: [root] });
    assert.equal(reopened.list().find((skill) => skill.id === "valid")?.enabled, false);
    reopenedStore.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
