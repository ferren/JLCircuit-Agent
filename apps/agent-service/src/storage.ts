import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChangeSet } from "../../../packages/contracts/src/index.ts";

export type ConversationRole = "user" | "assistant";
export type ConversationMode = "chat" | "plan";
export type PersistedTaskStatus =
  | "planning"
  | "awaiting_user"
  | "waiting_confirmation"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskExecution = {
  operations: Array<{ operationId: string; tool: string; ok: boolean; data?: unknown; error?: string }>;
  verification?: { ok: boolean; data?: unknown; error?: string };
};

export type PersistedSkillRef = {
  id: string;
  name: string;
  version: string;
  reason: "always" | "keyword" | "requested";
};

export type PersistedTask = {
  taskId: string;
  sessionId: string;
  instruction: string;
  status: PersistedTaskStatus;
  model: string;
  message: string;
  context: unknown;
  toolTrace: unknown[];
  changeSet: ChangeSet;
  confirmationToken?: string;
  execution?: TaskExecution;
  skills?: PersistedSkillRef[];
  createdAt: string;
  updatedAt: string;
};

export type SessionRecord = {
  id: string;
  projectId?: string;
  projectName?: string;
  summary: string;
  summaryThroughSequence: number;
  createdAt: string;
  updatedAt: string;
};

export type ConversationMessage = {
  sequence: number;
  id: string;
  sessionId: string;
  role: ConversationRole;
  mode: ConversationMode;
  content: string;
  model?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type AuditEventInput = {
  sessionId?: string;
  taskId?: string;
  eventType: string;
  payload?: unknown;
};

export type AuditEvent = {
  sequence: number;
  id: string;
  sessionId?: string;
  taskId?: string;
  eventType: string;
  payload?: unknown;
  createdAt: string;
};

type SqlRow = Record<string, string | number | bigint | null>;

const jsonStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? null);
  } catch (error) {
    return JSON.stringify({ serializationError: error instanceof Error ? error.message : String(error) });
  }
};

const jsonParse = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const rowToSession = (row: SqlRow): SessionRecord => ({
  id: String(row.id),
  projectId: optionalString(row.project_id),
  projectName: optionalString(row.project_name),
  summary: typeof row.summary === "string" ? row.summary : "",
  summaryThroughSequence: Number(row.summary_through_sequence ?? 0),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

const rowToMessage = (row: SqlRow): ConversationMessage => ({
  sequence: Number(row.sequence),
  id: String(row.id),
  sessionId: String(row.session_id),
  role: row.role === "assistant" ? "assistant" : "user",
  mode: row.mode === "plan" ? "plan" : "chat",
  content: String(row.content),
  model: optionalString(row.model),
  taskId: optionalString(row.task_id),
  metadata: jsonParse<Record<string, unknown> | undefined>(row.metadata_json, undefined),
  createdAt: String(row.created_at),
});

const rowToTask = (row: SqlRow): PersistedTask => ({
  taskId: String(row.task_id),
  sessionId: String(row.session_id),
  instruction: String(row.instruction),
  status: String(row.status) as PersistedTaskStatus,
  model: String(row.model),
  message: String(row.message),
  context: jsonParse(row.context_json, null),
  toolTrace: jsonParse<unknown[]>(row.tool_trace_json, []),
  changeSet: jsonParse<ChangeSet>(row.change_set_json, {
    id: "invalid",
    summary: "无法恢复的修改计划",
    operations: [],
    requiresConfirmation: false,
    createdAt: String(row.created_at),
    createdBy: "system",
  }),
  confirmationToken: optionalString(row.confirmation_token),
  execution: jsonParse<TaskExecution | undefined>(row.execution_json, undefined),
  skills: jsonParse<PersistedSkillRef[]>(row.skills_json, []),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

export const defaultDatabasePath = (): string =>
  process.env.JLCIRCUIT_DB_PATH?.trim() || ".jlcircuit-data/jlcircuit-agent.sqlite";

export class AgentStore {
  private readonly database: DatabaseSync;
  public readonly path: string;

  public constructor(databasePath = defaultDatabasePath()) {
    this.path = databasePath === ":memory:" ? databasePath : resolve(databasePath);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.database = new DatabaseSync(this.path, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  public close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        project_name TEXT,
        summary TEXT NOT NULL DEFAULT '',
        summary_through_sequence INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        mode TEXT NOT NULL CHECK (mode IN ('chat', 'plan')),
        content TEXT NOT NULL,
        model TEXT,
        task_id TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_sequence
        ON messages(session_id, sequence);

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        instruction TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        message TEXT NOT NULL,
        context_json TEXT NOT NULL,
        tool_trace_json TEXT NOT NULL,
        change_set_json TEXT NOT NULL,
        confirmation_token TEXT,
        execution_json TEXT,
        skills_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_session_updated
        ON tasks(session_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS context_snapshots (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        project_id TEXT,
        document_id TEXT,
        content_hash TEXT NOT NULL,
        context_json TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT,
        task_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_session_sequence
        ON audit_events(session_id, sequence);

      CREATE TABLE IF NOT EXISTS skill_states (
        skill_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_server_states (
        server_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL
      );

      PRAGMA user_version = 3;
    `);
    const taskColumns = this.database.prepare("PRAGMA table_info(tasks)").all() as SqlRow[];
    if (!taskColumns.some((column) => column.name === "skills_json")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]';");
    }
  }

  public ensureSession(
    sessionId: string,
    details: { projectId?: string; projectName?: string } = {},
  ): SessionRecord {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO sessions (id, project_id, project_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = COALESCE(excluded.project_id, sessions.project_id),
        project_name = COALESCE(excluded.project_name, sessions.project_name),
        updated_at = excluded.updated_at
    `).run(sessionId, details.projectId ?? null, details.projectName ?? null, now, now);
    return this.getSession(sessionId) as SessionRecord;
  }

  public createSession(projectId?: string): SessionRecord {
    return this.ensureSession(crypto.randomUUID(), { projectId });
  }

  public getSession(sessionId: string): SessionRecord | undefined {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SqlRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  public appendMessage(input: {
    sessionId: string;
    role: ConversationRole;
    mode: ConversationMode;
    content: string;
    model?: string;
    taskId?: string;
    metadata?: Record<string, unknown>;
  }): ConversationMessage {
    this.ensureSession(input.sessionId);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO messages (id, session_id, role, mode, content, model, task_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.sessionId,
      input.role,
      input.mode,
      input.content,
      input.model ?? null,
      input.taskId ?? null,
      input.metadata ? jsonStringify(input.metadata) : null,
      now,
    );
    this.database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, input.sessionId);
    const row = this.database.prepare("SELECT * FROM messages WHERE id = ?").get(id) as SqlRow;
    return rowToMessage(row);
  }

  public listMessages(sessionId: string, limit = 100): ConversationMessage[] {
    const safeLimit = Math.max(1, Math.min(limit, 1_000));
    const rows = this.database.prepare(`
      SELECT * FROM (
        SELECT * FROM messages WHERE session_id = ? ORDER BY sequence DESC LIMIT ?
      ) ORDER BY sequence ASC
    `).all(sessionId, safeLimit) as SqlRow[];
    return rows.map(rowToMessage);
  }

  public listRecentMessagesBefore(
    sessionId: string,
    beforeSequence: number,
    limit: number,
  ): ConversationMessage[] {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const rows = this.database.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE session_id = ? AND sequence < ?
        ORDER BY sequence DESC LIMIT ?
      ) ORDER BY sequence ASC
    `).all(sessionId, beforeSequence, safeLimit) as SqlRow[];
    return rows.map(rowToMessage);
  }

  public clearConversation(sessionId: string): void {
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
      this.database.prepare(`
        UPDATE sessions
        SET summary = '', summary_through_sequence = 0, updated_at = ?
        WHERE id = ?
      `).run(now, sessionId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public refreshSessionSummary(sessionId: string, keepRecent: number, maxChars: number): string {
    const session = this.getSession(sessionId);
    if (!session) return "";
    const recent = this.listMessages(sessionId, Math.max(1, keepRecent));
    if (recent.length < keepRecent) return session.summary;
    const cutoffSequence = recent[0]?.sequence ?? Number.MAX_SAFE_INTEGER;
    const rows = this.database.prepare(`
      SELECT * FROM messages
      WHERE session_id = ? AND sequence > ? AND sequence < ?
      ORDER BY sequence ASC
    `).all(sessionId, session.summaryThroughSequence, cutoffSequence) as SqlRow[];
    if (rows.length === 0) return session.summary;

    const additions = rows.map((row) => {
      const message = rowToMessage(row);
      const label = message.role === "user" ? "用户" : "助手";
      const compact = message.content.replace(/\s+/g, " ").trim().slice(0, 1_200);
      return `${label}：${compact}`;
    });
    let summary = [session.summary, ...additions].filter(Boolean).join("\n");
    if (summary.length > maxChars) {
      summary = `[较早内容已压缩]\n${summary.slice(-Math.max(0, maxChars - 12))}`;
    }
    const throughSequence = Number(rows.at(-1)?.sequence ?? session.summaryThroughSequence);
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE sessions SET summary = ?, summary_through_sequence = ?, updated_at = ? WHERE id = ?
    `).run(summary, throughSequence, now, sessionId);
    return summary;
  }

  public saveTask(task: PersistedTask): void {
    this.ensureSession(task.sessionId);
    this.database.prepare(`
      INSERT INTO tasks (
        task_id, session_id, instruction, status, model, message,
        context_json, tool_trace_json, change_set_json, confirmation_token,
        execution_json, skills_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        status = excluded.status,
        model = excluded.model,
        message = excluded.message,
        context_json = excluded.context_json,
        tool_trace_json = excluded.tool_trace_json,
        change_set_json = excluded.change_set_json,
        confirmation_token = excluded.confirmation_token,
        execution_json = excluded.execution_json,
        skills_json = excluded.skills_json,
        updated_at = excluded.updated_at
    `).run(
      task.taskId,
      task.sessionId,
      task.instruction,
      task.status,
      task.model,
      task.message,
      jsonStringify(task.context),
      jsonStringify(task.toolTrace),
      jsonStringify(task.changeSet),
      task.confirmationToken ?? null,
      task.execution ? jsonStringify(task.execution) : null,
      jsonStringify(task.skills ?? []),
      task.createdAt,
      task.updatedAt,
    );
  }

  public getTask(taskId: string): PersistedTask | undefined {
    const row = this.database.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as SqlRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  public listTasksForSession(sessionId: string, limit = 20): PersistedTask[] {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const rows = this.database.prepare(`
      SELECT * FROM tasks WHERE session_id = ? ORDER BY updated_at DESC LIMIT ?
    `).all(sessionId, safeLimit) as SqlRow[];
    return rows.map(rowToTask);
  }

  public listSkillStates(): Map<string, boolean> {
    const rows = this.database.prepare("SELECT skill_id, enabled FROM skill_states").all() as SqlRow[];
    return new Map(rows.map((row) => [String(row.skill_id), Number(row.enabled) === 1]));
  }

  public setSkillEnabled(skillId: string, enabled: boolean): void {
    this.database.prepare(`
      INSERT INTO skill_states (skill_id, enabled, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(skill_id) DO UPDATE SET
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(skillId, enabled ? 1 : 0, new Date().toISOString());
  }

  public listMcpServerStates(): Map<string, boolean> {
    const rows = this.database.prepare("SELECT server_id, enabled FROM mcp_server_states").all() as SqlRow[];
    return new Map(rows.map((row) => [String(row.server_id), Number(row.enabled) === 1]));
  }

  public setMcpServerEnabled(serverId: string, enabled: boolean): void {
    this.database.prepare(`
      INSERT INTO mcp_server_states (server_id, enabled, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(serverId, enabled ? 1 : 0, new Date().toISOString());
  }

  public upsertContextSnapshot(input: {
    sessionId: string;
    projectId?: string;
    documentId?: string;
    contentHash: string;
    context: unknown;
    capturedAt: string;
  }): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO context_snapshots (
        session_id, project_id, document_id, content_hash, context_json, captured_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        project_id = excluded.project_id,
        document_id = excluded.document_id,
        content_hash = excluded.content_hash,
        context_json = excluded.context_json,
        captured_at = excluded.captured_at,
        updated_at = excluded.updated_at
    `).run(
      input.sessionId,
      input.projectId ?? null,
      input.documentId ?? null,
      input.contentHash,
      jsonStringify(input.context),
      input.capturedAt,
      now,
    );
  }

  public appendAuditEvent(input: AuditEventInput): void {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO audit_events (id, session_id, task_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      input.sessionId ?? null,
      input.taskId ?? null,
      input.eventType,
      input.payload === undefined ? null : jsonStringify(input.payload),
      now,
    );
  }

  public countAuditEvents(sessionId?: string): number {
    const row = sessionId
      ? this.database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE session_id = ?").get(sessionId)
      : this.database.prepare("SELECT COUNT(*) AS count FROM audit_events").get();
    return Number((row as SqlRow | undefined)?.count ?? 0);
  }

  public listAuditEvents(sessionId: string, limit = 100): AuditEvent[] {
    const safeLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.database.prepare(`
      SELECT * FROM (
        SELECT * FROM audit_events WHERE session_id = ? ORDER BY sequence DESC LIMIT ?
      ) ORDER BY sequence ASC
    `).all(sessionId, safeLimit) as SqlRow[];
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      id: String(row.id),
      sessionId: optionalString(row.session_id),
      taskId: optionalString(row.task_id),
      eventType: String(row.event_type),
      payload: jsonParse(row.payload_json, undefined),
      createdAt: String(row.created_at),
    }));
  }
}
