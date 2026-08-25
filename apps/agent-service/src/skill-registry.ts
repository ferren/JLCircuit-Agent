import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, delimiter as pathDelimiter } from "node:path";
import type { EdaToolDefinition, RiskLevel } from "../../../packages/contracts/src/index.ts";
import type { AgentStore } from "./storage.ts";

export type SkillMode = "chat" | "plan";

export type SkillManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  entry: string;
  enabledByDefault: boolean;
  riskLevel: RiskLevel;
  priority: number;
  activation: {
    always: boolean;
    keywords: string[];
    modes: SkillMode[];
  };
  tools: {
    allowed: string[];
    required: string[];
  };
};

export type LoadedSkill = {
  manifest: SkillManifest;
  instructions: string;
  directory: string;
  manifestPath: string;
  entryPath: string;
};

export type SkillDiagnostic = {
  level: "warning" | "error";
  path: string;
  message: string;
};

export type SkillListItem = {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  enabledByDefault: boolean;
  riskLevel: RiskLevel;
  priority: number;
  activation: SkillManifest["activation"];
  tools: SkillManifest["tools"];
  source: string;
};

export type ResolvedSkill = {
  id: string;
  name: string;
  version: string;
  description: string;
  instructions: string;
  reason: "always" | "keyword" | "requested";
  matchedKeywords: string[];
  allowedTools: string[];
};

export type ResolvedSkillSet = {
  skills: ResolvedSkill[];
  allowedToolNames: Set<string>;
};

export class SkillRegistryError extends Error {
  public readonly code: "SKILL_NOT_FOUND" | "SKILL_DISABLED" | "SKILL_MODE_UNSUPPORTED";

  public constructor(code: SkillRegistryError["code"], message: string) {
    super(message);
    this.name = "SkillRegistryError";
    this.code = code;
  }
}

type RegistryOptions = {
  roots?: string[];
  maxInstructionChars?: number;
  maxActiveSkills?: number;
  autoActivate?: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0)
    ? [...new Set(value.map((item) => item.trim()))]
    : undefined;

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const booleanValue = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

const defaultRoots = (): string[] => {
  const roots = [resolve("skills/builtin")];
  const configured = process.env.JLCIRCUIT_SKILL_ROOTS?.trim();
  if (configured) {
    roots.push(...configured.split(pathDelimiter).map((item) => resolve(item.trim())).filter(Boolean));
  }
  return [...new Set(roots)];
};

const parseManifest = (value: unknown, manifestPath: string): SkillManifest => {
  if (!isRecord(value)) throw new Error("skill.json must contain a JSON object.");
  const activation = isRecord(value.activation) ? value.activation : {};
  const tools = isRecord(value.tools) ? value.tools : {};
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) {
    throw new Error("id must match ^[a-z][a-z0-9-]{1,63}$.");
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const version = typeof value.version === "string" ? value.version.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (!name || !version || !description) throw new Error("name, version and description are required.");
  if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1.");
  const entry = typeof value.entry === "string" && value.entry.trim() ? value.entry.trim() : "SKILL.md";
  const riskLevel = ["read", "low", "medium", "high"].includes(String(value.riskLevel))
    ? String(value.riskLevel) as RiskLevel
    : "read";
  const priority = Number.isInteger(value.priority) ? Number(value.priority) : 0;
  const keywords = stringArray(activation.keywords) ?? [];
  const modesValue = stringArray(activation.modes) ?? ["chat", "plan"];
  if (modesValue.some((mode) => mode !== "chat" && mode !== "plan")) {
    throw new Error("activation.modes only supports chat and plan.");
  }
  const allowed = stringArray(tools.allowed);
  if (!allowed) throw new Error("tools.allowed must be a non-empty string array.");
  const required = stringArray(tools.required) ?? [];
  if (required.some((tool) => !allowed.includes(tool))) {
    throw new Error("Every tools.required entry must also appear in tools.allowed.");
  }
  if (isAbsolute(entry)) throw new Error(`entry must be relative: ${manifestPath}`);
  return {
    schemaVersion: 1,
    id,
    name,
    version,
    description,
    entry,
    enabledByDefault: value.enabledByDefault !== false,
    riskLevel,
    priority,
    activation: {
      always: activation.always === true,
      keywords,
      modes: modesValue as SkillMode[],
    },
    tools: { allowed, required },
  };
};

const pathIsInside = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path.length === 0 || (!path.startsWith("..") && !isAbsolute(path));
};

export class SkillRegistry {
  private readonly store: AgentStore;
  private readonly availableTools: Map<string, EdaToolDefinition>;
  private readonly roots: string[];
  private readonly maxInstructionChars: number;
  private readonly maxActiveSkills: number;
  private readonly autoActivate: boolean;
  private readonly skills = new Map<string, LoadedSkill>();
  private diagnostics: SkillDiagnostic[] = [];

  public constructor(
    store: AgentStore,
    toolDefinitions: EdaToolDefinition[],
    options: RegistryOptions = {},
  ) {
    this.store = store;
    this.availableTools = new Map(toolDefinitions.filter((tool) => tool.enabled).map((tool) => [tool.name, tool]));
    this.roots = options.roots ?? defaultRoots();
    this.maxInstructionChars = options.maxInstructionChars ??
      positiveInteger(process.env.JLCIRCUIT_SKILL_MAX_INSTRUCTION_CHARS, 20_000);
    this.maxActiveSkills = options.maxActiveSkills ??
      positiveInteger(process.env.JLCIRCUIT_SKILL_MAX_ACTIVE, 3);
    this.autoActivate = options.autoActivate ??
      booleanValue(process.env.JLCIRCUIT_SKILL_AUTO_ACTIVATE, true);
    this.reload();
  }

  public reload(): { skills: SkillListItem[]; diagnostics: SkillDiagnostic[] } {
    this.skills.clear();
    this.diagnostics = [];
    for (const root of this.roots) this.scanRoot(root);
    return { skills: this.list(), diagnostics: this.getDiagnostics() };
  }

  private scanRoot(root: string): void {
    if (!existsSync(root)) {
      this.diagnostics.push({ level: "warning", path: root, message: "Skill root does not exist." });
      return;
    }
    let rootReal: string;
    try {
      rootReal = realpathSync(root);
    } catch (error) {
      this.diagnostics.push({ level: "error", path: root, message: String(error) });
      return;
    }
    for (const entry of readdirSync(rootReal, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDirectory = resolve(rootReal, entry.name);
      const manifestPath = resolve(skillDirectory, "skill.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")), manifestPath);
        if (this.skills.has(manifest.id)) {
          throw new Error(`Duplicate skill id: ${manifest.id}`);
        }
        const directoryReal = realpathSync(skillDirectory);
        const entryPath = realpathSync(resolve(directoryReal, manifest.entry));
        if (!pathIsInside(directoryReal, entryPath)) {
          throw new Error("Skill entry resolves outside its skill directory.");
        }
        const instructions = readFileSync(entryPath, "utf8").trim();
        if (!instructions) throw new Error("Skill instructions are empty.");
        if (instructions.length > this.maxInstructionChars) {
          throw new Error(`Skill instructions exceed ${this.maxInstructionChars} characters.`);
        }
        const unknownTools = manifest.tools.allowed.filter((tool) => !this.availableTools.has(tool));
        if (unknownTools.length > 0) throw new Error(`Unknown tools: ${unknownTools.join(", ")}`);
        const riskRank: Record<RiskLevel, number> = { read: 0, low: 1, medium: 2, high: 3 };
        const excessiveRiskTools = manifest.tools.allowed.filter((tool) => {
          const definition = this.availableTools.get(tool);
          return definition && riskRank[definition.riskLevel] > riskRank[manifest.riskLevel];
        });
        if (excessiveRiskTools.length > 0) {
          throw new Error(`Tools exceed declared riskLevel ${manifest.riskLevel}: ${excessiveRiskTools.join(", ")}`);
        }
        const missingRequired = manifest.tools.required.filter((tool) => !this.availableTools.has(tool));
        if (missingRequired.length > 0) throw new Error(`Missing required tools: ${missingRequired.join(", ")}`);
        this.skills.set(manifest.id, {
          manifest,
          instructions,
          directory: directoryReal,
          manifestPath,
          entryPath,
        });
      } catch (error) {
        this.diagnostics.push({
          level: "error",
          path: manifestPath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  public list(): SkillListItem[] {
    const states = this.store.listSkillStates();
    return [...this.skills.values()]
      .map(({ manifest, directory }) => ({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        enabled: states.get(manifest.id) ?? manifest.enabledByDefault,
        enabledByDefault: manifest.enabledByDefault,
        riskLevel: manifest.riskLevel,
        priority: manifest.priority,
        activation: manifest.activation,
        tools: manifest.tools,
        source: directory,
      }))
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  }

  public getDiagnostics(): SkillDiagnostic[] {
    return this.diagnostics.map((item) => ({ ...item }));
  }

  public setEnabled(skillId: string, enabled: boolean): SkillListItem {
    const skill = this.skills.get(skillId);
    if (!skill) throw new SkillRegistryError("SKILL_NOT_FOUND", `Skill not found: ${skillId}`);
    this.store.setSkillEnabled(skillId, enabled);
    return this.list().find((item) => item.id === skillId) as SkillListItem;
  }

  public resolve(input: {
    instruction: string;
    mode: SkillMode;
    requestedSkillIds?: string[];
  }): ResolvedSkillSet {
    const requested = [...new Set(
      Array.isArray(input.requestedSkillIds)
        ? input.requestedSkillIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
    )].map((item) => item.trim());
    const states = this.store.listSkillStates();
    const selected = new Map<string, ResolvedSkill>();
    const scores = new Map<string, number>();
    const lowerInstruction = input.instruction.toLowerCase();

    const add = (skill: LoadedSkill, reason: ResolvedSkill["reason"], matchedKeywords: string[], score: number): void => {
      const existingScore = scores.get(skill.manifest.id) ?? Number.NEGATIVE_INFINITY;
      if (score < existingScore) return;
      scores.set(skill.manifest.id, score);
      selected.set(skill.manifest.id, {
        id: skill.manifest.id,
        name: skill.manifest.name,
        version: skill.manifest.version,
        description: skill.manifest.description,
        instructions: skill.instructions,
        reason,
        matchedKeywords,
        allowedTools: skill.manifest.tools.allowed,
      });
    };

    for (const skillId of requested) {
      const skill = this.skills.get(skillId);
      if (!skill) throw new SkillRegistryError("SKILL_NOT_FOUND", `Skill not found: ${skillId}`);
      const enabled = states.get(skillId) ?? skill.manifest.enabledByDefault;
      if (!enabled) throw new SkillRegistryError("SKILL_DISABLED", `Skill is disabled: ${skillId}`);
      if (!skill.manifest.activation.modes.includes(input.mode)) {
        throw new SkillRegistryError("SKILL_MODE_UNSUPPORTED", `Skill ${skillId} does not support ${input.mode} mode.`);
      }
      add(skill, "requested", [], 1_000_000 + skill.manifest.priority);
    }

    for (const skill of this.skills.values()) {
      const enabled = states.get(skill.manifest.id) ?? skill.manifest.enabledByDefault;
      if (!enabled || !skill.manifest.activation.modes.includes(input.mode)) continue;
      if (skill.manifest.activation.always) {
        add(skill, "always", [], 500_000 + skill.manifest.priority);
        continue;
      }
      if (!this.autoActivate) continue;
      const matchedKeywords = skill.manifest.activation.keywords.filter((keyword) =>
        lowerInstruction.includes(keyword.toLowerCase()));
      if (matchedKeywords.length > 0) {
        add(skill, "keyword", matchedKeywords, 100_000 + matchedKeywords.length * 100 + skill.manifest.priority);
      }
    }

    const skills = [...selected.values()]
      .sort((left, right) => (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0) || left.id.localeCompare(right.id))
      .slice(0, this.maxActiveSkills);
    const allowedToolNames = new Set(skills.flatMap((skill) => skill.allowedTools));
    return { skills, allowedToolNames };
  }
}
