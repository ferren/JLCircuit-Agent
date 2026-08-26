import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { EdaToolDefinition, ToolResponse } from "../../../packages/contracts/src/index.ts";
import type {
  AgentStore,
  KnowledgeChunkRecord,
  KnowledgeDocumentRecord,
  KnowledgeSourceRecord,
} from "./storage.ts";

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf", ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".yaml", ".yml",
  ".html", ".htm", ".xml", ".net", ".netlist", ".bom", ".log",
]);
const DEFAULT_EXTENSIONS = [...SUPPORTED_EXTENSIONS];
const SKIPPED_DIRECTORIES = new Set([".git", ".svn", "node_modules", "dist", "build", ".jlcircuit-data"]);
const PDF_STANDARD_FONT_DATA_URL = `${resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../node_modules/pdfjs-dist/standard_fonts",
).replaceAll("\\", "/")}/`;

export const KNOWLEDGE_TOOL_DEFINITIONS: EdaToolDefinition[] = [
  {
    name: "knowledge_sources",
    description: "列出当前已授权并建立索引的本地资料源及文档统计，不返回本机绝对路径。",
    riskLevel: "read",
    inputSchema: { type: "object", additionalProperties: false },
    enabled: true,
  },
  {
    name: "knowledge_search",
    description: "在已授权的芯片手册、PDF、BOM、网表和参考资料中全文检索，返回带文件、页码或行号及哈希的引用。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        sourceIds: { type: "array", items: { type: "string" }, maxItems: 16 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
      },
    },
    enabled: true,
  },
  {
    name: "knowledge_read",
    description: "按检索结果中的 documentId 或 chunkId 读取已索引资料内容；不能读取任意文件路径。",
    riskLevel: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        documentId: { type: "string" },
        chunkId: { type: "string" },
        maxChars: { type: "integer", minimum: 1000, maximum: 50000, default: 16000 },
      },
      anyOf: [{ required: ["documentId"] }, { required: ["chunkId"] }],
    },
    enabled: true,
  },
];

export type KnowledgeScanResult = {
  sourceId: string;
  discovered: number;
  indexed: number;
  unchanged: number;
  removed: number;
  errors: number;
  errorFiles: Array<{ path: string; message: string }>;
  completedAt: string;
};

export class KnowledgeServiceError extends Error {
  public readonly code:
    | "KNOWLEDGE_SOURCE_INVALID"
    | "KNOWLEDGE_SOURCE_EXISTS"
    | "KNOWLEDGE_SOURCE_NOT_FOUND"
    | "KNOWLEDGE_DOCUMENT_NOT_FOUND"
    | "KNOWLEDGE_SCAN_FAILED"
    | "KNOWLEDGE_QUERY_INVALID";

  public constructor(code: KnowledgeServiceError["code"], message: string) {
    super(message);
    this.name = "KnowledgeServiceError";
    this.code = code;
  }
}

type ParsedSection = { text: string; locator: Record<string, unknown> };
type ParsedDocument = { title: string; pageCount?: number; sections: ParsedSection[] };

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sourceId = (value: unknown): string => {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z][a-z0-9-]{1,47}$/.test(id)) {
    throw new KnowledgeServiceError(
      "KNOWLEDGE_SOURCE_INVALID",
      "Knowledge source id must match ^[a-z][a-z0-9-]{1,47}$.",
    );
  }
  return id;
};

const normalizeExtensions = (value: unknown): string[] => {
  const requested = Array.isArray(value) && value.length > 0 ? value : DEFAULT_EXTENSIONS;
  if (!requested.every((item) => typeof item === "string")) {
    throw new KnowledgeServiceError("KNOWLEDGE_SOURCE_INVALID", "extensions must be a string array.");
  }
  const normalized = [...new Set(requested.map((item) => {
    const extension = item.trim().toLowerCase();
    return extension.startsWith(".") ? extension : `.${extension}`;
  }))];
  const unsupported = normalized.filter((item) => !SUPPORTED_EXTENSIONS.has(item));
  if (unsupported.length > 0) {
    throw new KnowledgeServiceError(
      "KNOWLEDGE_SOURCE_INVALID",
      `Unsupported knowledge file extensions: ${unsupported.join(", ")}`,
    );
  }
  return normalized.sort();
};

const normalizeText = (value: string): string =>
  value.replaceAll("\u0000", "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();

const stripHtml = (value: string): string => normalizeText(
  value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n"),
);

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const pathWithin = (root: string, candidate: string): boolean => {
  const pathRelative = relative(root, candidate);
  return pathRelative === "" || (!pathRelative.startsWith(`..${sep}`) && pathRelative !== ".." && !isAbsolute(pathRelative));
};

const excerpt = (content: string, query: string, maxChars = 1_200): string => {
  if (content.length <= maxChars) return content;
  const index = content.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, (index >= 0 ? index : 0) - Math.floor(maxChars / 3));
  const end = Math.min(content.length, start + maxChars);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
};

export class KnowledgeService {
  private readonly store: AgentStore;
  private readonly log: (message: string, details?: unknown) => void;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly maxPdfPages: number;
  private readonly maxDepth: number;
  private readonly chunkChars: number;
  private readonly chunkOverlap: number;
  private readonly scans = new Map<string, Promise<KnowledgeScanResult>>();

  public constructor(
    store: AgentStore,
    log: (message: string, details?: unknown) => void = () => undefined,
  ) {
    this.store = store;
    this.log = log;
    this.maxFiles = positiveInteger(process.env.JLCIRCUIT_KNOWLEDGE_MAX_FILES, 5_000);
    this.maxFileBytes = positiveInteger(process.env.JLCIRCUIT_KNOWLEDGE_MAX_FILE_BYTES, 25 * 1024 * 1024);
    this.maxPdfPages = positiveInteger(process.env.JLCIRCUIT_KNOWLEDGE_MAX_PDF_PAGES, 1_000);
    this.maxDepth = positiveInteger(process.env.JLCIRCUIT_KNOWLEDGE_MAX_DEPTH, 12);
    this.chunkChars = positiveInteger(process.env.JLCIRCUIT_KNOWLEDGE_CHUNK_CHARS, 4_000);
    this.chunkOverlap = Math.min(
      positiveInteger(process.env.JLCIRCUIT_KNOWLEDGE_CHUNK_OVERLAP, 300),
      Math.floor(this.chunkChars / 2),
    );
  }

  public listSources(): KnowledgeSourceRecord[] {
    return this.store.listKnowledgeSources();
  }

  public createSource(input: unknown): KnowledgeSourceRecord {
    const config = this.parseSource(input);
    if (this.store.getKnowledgeSource(config.id)) {
      throw new KnowledgeServiceError("KNOWLEDGE_SOURCE_EXISTS", `Knowledge source already exists: ${config.id}`);
    }
    if (this.store.listKnowledgeSources().some((item) => item.rootPath.toLowerCase() === config.rootPath.toLowerCase())) {
      throw new KnowledgeServiceError("KNOWLEDGE_SOURCE_EXISTS", `Knowledge directory is already authorized: ${config.rootPath}`);
    }
    const source = this.store.upsertKnowledgeSource(config);
    this.store.appendAuditEvent({
      eventType: "knowledge.source_created",
      payload: { sourceId: source.id, rootPath: source.rootPath, extensions: source.extensions },
    });
    return source;
  }

  public updateSource(id: string, input: unknown): KnowledgeSourceRecord {
    const existing = this.requireSource(id);
    const config = this.parseSource(input);
    if (config.id !== id) {
      throw new KnowledgeServiceError("KNOWLEDGE_SOURCE_INVALID", "Knowledge source id cannot be changed.");
    }
    if (this.store.listKnowledgeSources().some((item) =>
      item.id !== id && item.rootPath.toLowerCase() === config.rootPath.toLowerCase())) {
      throw new KnowledgeServiceError("KNOWLEDGE_SOURCE_EXISTS", `Knowledge directory is already authorized: ${config.rootPath}`);
    }
    const rootChanged = existing.rootPath !== config.rootPath;
    if (rootChanged) {
      for (const document of this.store.listKnowledgeDocuments(id)) this.store.deleteKnowledgeDocument(document.id);
    }
    const source = this.store.upsertKnowledgeSource(config);
    this.store.appendAuditEvent({
      eventType: "knowledge.source_updated",
      payload: { sourceId: id, rootChanged, extensions: source.extensions },
    });
    return source;
  }

  public deleteSource(id: string): { deleted: true; sourceId: string } {
    this.requireSource(id);
    this.store.deleteKnowledgeSource(id);
    this.store.appendAuditEvent({ eventType: "knowledge.source_deleted", payload: { sourceId: id } });
    return { deleted: true, sourceId: id };
  }

  public listDocuments(sourceIdValue?: string): KnowledgeDocumentRecord[] {
    if (sourceIdValue) this.requireSource(sourceIdValue);
    return this.store.listKnowledgeDocuments(sourceIdValue);
  }

  public scanSource(id: string): Promise<KnowledgeScanResult> {
    const existing = this.scans.get(id);
    if (existing) return existing;
    const promise = this.scanSourceInternal(id).finally(() => this.scans.delete(id));
    this.scans.set(id, promise);
    return promise;
  }

  public async scanAll(): Promise<KnowledgeScanResult[]> {
    const enabled = this.listSources().filter((source) => source.enabled);
    const results: KnowledgeScanResult[] = [];
    for (const source of enabled) results.push(await this.scanSource(source.id));
    return results;
  }

  public async callTool(
    toolName: string,
    sessionId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResponse> {
    const requestId = randomUUID();
    try {
      if (toolName === "knowledge_sources") {
        const sources = this.modelSourceViews();
        return { requestId, ok: true, data: { sources }, content: [{ type: "text", text: JSON.stringify({ sources }, null, 2) }] };
      }
      if (toolName === "knowledge_search") {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) throw new KnowledgeServiceError("KNOWLEDGE_QUERY_INVALID", "knowledge_search requires query.");
        if (query.length > 500) throw new KnowledgeServiceError("KNOWLEDGE_QUERY_INVALID", "knowledge_search query exceeds 500 characters.");
        const sourceIds = Array.isArray(args.sourceIds)
          ? [...new Set(args.sourceIds.filter((item): item is string => typeof item === "string"))].slice(0, 16)
          : [];
        for (const id of sourceIds) this.requireSource(id);
        const limit = Math.max(1, Math.min(Number(args.limit) || 8, 20));
        const results = this.search(query, sourceIds, limit);
        this.store.appendAuditEvent({
          sessionId,
          eventType: "knowledge.searched",
          payload: { query: query.slice(0, 500), sourceIds, resultCount: results.length },
        });
        return { requestId, ok: true, data: { query, results }, content: [{ type: "text", text: JSON.stringify({ query, results }, null, 2) }] };
      }
      if (toolName === "knowledge_read") {
        const maxChars = Math.max(1_000, Math.min(Number(args.maxChars) || 16_000, 50_000));
        const result = this.readIndexedContent(
          typeof args.documentId === "string" ? args.documentId : undefined,
          typeof args.chunkId === "string" ? args.chunkId : undefined,
          maxChars,
        );
        this.store.appendAuditEvent({
          sessionId,
          eventType: "knowledge.read",
          payload: { documentId: result.document.id, chunkId: args.chunkId, chars: result.content.length },
        });
        return { requestId, ok: true, data: result, content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      throw new KnowledgeServiceError("KNOWLEDGE_QUERY_INVALID", `Unknown knowledge tool: ${toolName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { requestId, ok: false, error: { code: error instanceof KnowledgeServiceError ? error.code : "KNOWLEDGE_ERROR", message, retryable: false } };
    }
  }

  public search(query: string, sourceIds: string[] = [], limit = 8): unknown[] {
    return this.store.searchKnowledge(query, sourceIds, limit).map((row) => ({
      chunkId: row.id,
      documentId: row.documentId,
      sourceId: row.sourceId,
      sourceName: row.sourceName,
      title: row.title,
      path: row.relativePath,
      fileType: row.fileType,
      locator: row.locator,
      excerpt: excerpt(row.content, query),
      score: row.score,
      citation: {
        sourceId: row.sourceId,
        documentId: row.documentId,
        path: row.relativePath,
        title: row.title,
        page: row.locator.page,
        lineStart: row.locator.lineStart,
        lineEnd: row.locator.lineEnd,
        sha256: row.documentSha256,
      },
    }));
  }

  private modelSourceViews(): unknown[] {
    return this.listSources().filter((source) => source.enabled).map((source) => ({
      id: source.id,
      name: source.name,
      extensions: source.extensions,
      documentCount: source.documentCount,
      chunkCount: source.chunkCount,
      errorCount: source.errorCount,
      lastIndexedAt: source.lastIndexedAt,
    }));
  }

  private parseSource(input: unknown): {
    id: string;
    name: string;
    rootPath: string;
    enabled: boolean;
    extensions: string[];
  } {
    if (!isRecord(input)) throw new KnowledgeServiceError("KNOWLEDGE_SOURCE_INVALID", "Source must be an object.");
    const id = sourceId(input.id);
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : id;
    const requestedRoot = typeof input.rootPath === "string" ? input.rootPath.trim() : "";
    if (!requestedRoot || !isAbsolute(requestedRoot)) {
      throw new KnowledgeServiceError("KNOWLEDGE_SOURCE_INVALID", "Knowledge rootPath must be an absolute directory path.");
    }
    const resolved = resolve(requestedRoot);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new KnowledgeServiceError("KNOWLEDGE_SOURCE_INVALID", `Knowledge directory does not exist: ${resolved}`);
    }
    const rootPath = realpathSync.native(resolved);
    return {
      id,
      name,
      rootPath,
      enabled: input.enabled !== false,
      extensions: normalizeExtensions(input.extensions),
    };
  }

  private requireSource(id: string): KnowledgeSourceRecord {
    const source = this.store.getKnowledgeSource(id);
    if (!source) throw new KnowledgeServiceError("KNOWLEDGE_SOURCE_NOT_FOUND", `Knowledge source not found: ${id}`);
    return source;
  }

  private discoverFiles(source: KnowledgeSourceRecord): string[] {
    const root = realpathSync.native(source.rootPath);
    const files: string[] = [];
    const walk = (directory: string, depth: number): void => {
      if (depth > this.maxDepth || files.length >= this.maxFiles) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (files.length >= this.maxFiles) break;
        if (entry.isSymbolicLink()) continue;
        const candidate = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) walk(candidate, depth + 1);
          continue;
        }
        if (!entry.isFile() || !source.extensions.includes(extname(entry.name).toLowerCase())) continue;
        const candidateReal = realpathSync.native(candidate);
        if (pathWithin(root, candidateReal)) files.push(candidateReal);
      }
    };
    walk(root, 0);
    return files.sort((left, right) => left.localeCompare(right));
  }

  private async scanSourceInternal(id: string): Promise<KnowledgeScanResult> {
    const source = this.requireSource(id);
    if (!source.enabled) {
      throw new KnowledgeServiceError("KNOWLEDGE_SCAN_FAILED", `Knowledge source is disabled: ${id}`);
    }
    const startedAt = Date.now();
    this.log("[knowledge] scan started", { sourceId: id, rootPath: source.rootPath });
    const files = this.discoverFiles(source);
    const existing = new Map(this.store.listKnowledgeDocuments(id).map((document) => [document.relativePath, document]));
    const seen = new Set<string>();
    let indexed = 0;
    let unchanged = 0;
    let errors = 0;
    const errorFiles: Array<{ path: string; message: string }> = [];
    for (const absolutePath of files) {
      const relativePath = relative(source.rootPath, absolutePath).replaceAll("\\", "/");
      seen.add(relativePath);
      const stats = statSync(absolutePath);
      const previous = existing.get(relativePath);
      if (previous?.status === "indexed" && previous.sizeBytes === stats.size && previous.mtimeMs === stats.mtimeMs) {
        unchanged += 1;
        continue;
      }
      try {
        if (stats.size > this.maxFileBytes) {
          throw new Error(`File exceeds ${this.maxFileBytes} byte limit.`);
        }
        const bytes = readFileSync(absolutePath);
        const parsed = await this.parseDocument(absolutePath, bytes);
        const documentId = sha256(`${id}:${relativePath}`);
        const indexedAt = new Date().toISOString();
        const chunks = this.buildChunks(documentId, id, parsed.sections);
        if (chunks.length === 0) throw new Error("No readable text was extracted.");
        this.store.replaceKnowledgeDocument({
          id: documentId,
          sourceId: id,
          relativePath,
          absolutePath,
          fileType: extname(absolutePath).slice(1).toLowerCase(),
          title: parsed.title,
          sizeBytes: stats.size,
          mtimeMs: stats.mtimeMs,
          sha256: sha256(bytes),
          pageCount: parsed.pageCount,
          status: "indexed",
          indexedAt,
        }, chunks);
        indexed += 1;
      } catch (error) {
        errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        errorFiles.push({ path: relativePath, message });
        const documentId = sha256(`${id}:${relativePath}`);
        this.store.replaceKnowledgeDocument({
          id: documentId,
          sourceId: id,
          relativePath,
          absolutePath,
          fileType: extname(absolutePath).slice(1).toLowerCase(),
          title: relativePath.split("/").at(-1) || relativePath,
          sizeBytes: stats.size,
          mtimeMs: stats.mtimeMs,
          sha256: "",
          status: "error",
          error: message,
          indexedAt: new Date().toISOString(),
        }, []);
      }
    }
    let removed = 0;
    for (const [relativePath, document] of existing) {
      if (!seen.has(relativePath)) {
        this.store.deleteKnowledgeDocument(document.id);
        removed += 1;
      }
    }
    const completedAt = new Date().toISOString();
    this.store.setKnowledgeSourceIndexed(id, completedAt);
    const result = { sourceId: id, discovered: files.length, indexed, unchanged, removed, errors, errorFiles, completedAt };
    this.store.appendAuditEvent({ eventType: "knowledge.source_scanned", payload: result });
    this.log("[knowledge] scan completed", { ...result, elapsedMs: Date.now() - startedAt });
    return result;
  }

  private async parseDocument(path: string, bytes: Buffer): Promise<ParsedDocument> {
    const extension = extname(path).toLowerCase();
    const filename = path.split(/[\\/]/).at(-1) || path;
    if (extension === ".pdf") return this.parsePdf(filename, bytes);
    const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
    if (sample.includes(0)) throw new Error("Binary content is not supported for this file type.");
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const text = extension === ".html" || extension === ".htm" ? stripHtml(decoded) : normalizeText(decoded);
    return { title: filename, sections: [{ text, locator: {} }] };
  }

  private async parsePdf(filename: string, bytes: Buffer): Promise<ParsedDocument> {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = getDocument({
      data: new Uint8Array(bytes),
      standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
    });
    const pdf = await loadingTask.promise;
    try {
      if (pdf.numPages > this.maxPdfPages) throw new Error(`PDF exceeds ${this.maxPdfPages} page limit.`);
      const metadata = await pdf.getMetadata().catch(() => undefined);
      const info = metadata?.info as Record<string, unknown> | undefined;
      const title = typeof info?.Title === "string" && info.Title.trim() ? info.Title.trim() : filename;
      const sections: ParsedSection[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const text = normalizeText(textContent.items.flatMap((item) =>
          typeof item === "object" && item && "str" in item ? [String(item.str)] : []).join(" "));
        if (text) sections.push({ text, locator: { page: pageNumber } });
        page.cleanup();
      }
      return { title, pageCount: pdf.numPages, sections };
    } finally {
      await loadingTask.destroy();
    }
  }

  private buildChunks(documentId: string, sourceIdValue: string, sections: ParsedSection[]): KnowledgeChunkRecord[] {
    const chunks: KnowledgeChunkRecord[] = [];
    for (const section of sections) {
      const text = normalizeText(section.text);
      if (!text) continue;
      const lineBreaks: number[] = [];
      for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10) lineBreaks.push(index);
      }
      const lineAt = (position: number): number => {
        let low = 0;
        let high = lineBreaks.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if ((lineBreaks[middle] as number) < position) low = middle + 1;
          else high = middle;
        }
        return low + 1;
      };
      let offset = 0;
      let part = 1;
      while (offset < text.length) {
        let end = Math.min(text.length, offset + this.chunkChars);
        if (end < text.length) {
          const boundary = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf("。", end), text.lastIndexOf(". ", end));
          if (boundary > offset + Math.floor(this.chunkChars / 2)) end = boundary + 1;
        }
        const content = text.slice(offset, end).trim();
        if (content) {
          const ordinal = chunks.length;
          const locator = {
            ...section.locator,
            ...("page" in section.locator ? {} : {
              lineStart: lineAt(offset),
              lineEnd: lineAt(Math.max(offset, end - 1)),
            }),
            ...(text.length > this.chunkChars ? { part } : {}),
          };
          chunks.push({
            id: sha256(`${documentId}:${ordinal}:${content}`),
            documentId,
            sourceId: sourceIdValue,
            ordinal,
            content,
            locator,
            contentHash: sha256(content),
          });
          part += 1;
        }
        if (end >= text.length) break;
        offset = Math.max(offset + 1, end - this.chunkOverlap);
      }
    }
    return chunks;
  }

  private readIndexedContent(documentIdValue: string | undefined, chunkId: string | undefined, maxChars: number): {
    document: Omit<KnowledgeDocumentRecord, "absolutePath">;
    content: string;
    chunks: Array<{ id: string; ordinal: number; locator: Record<string, unknown> }>;
    citation: Record<string, unknown>;
    truncated: boolean;
  } {
    const selectedChunk = chunkId ? this.store.getKnowledgeChunk(chunkId) : undefined;
    const resolvedDocumentId = selectedChunk?.documentId || documentIdValue;
    if (!resolvedDocumentId) {
      throw new KnowledgeServiceError("KNOWLEDGE_QUERY_INVALID", "knowledge_read requires documentId or chunkId.");
    }
    const document = this.store.getKnowledgeDocument(resolvedDocumentId);
    if (!document || document.status !== "indexed") {
      throw new KnowledgeServiceError("KNOWLEDGE_DOCUMENT_NOT_FOUND", `Indexed document not found: ${resolvedDocumentId}`);
    }
    const source = this.requireSource(document.sourceId);
    if (!source.enabled) {
      throw new KnowledgeServiceError("KNOWLEDGE_DOCUMENT_NOT_FOUND", `Indexed document not found: ${resolvedDocumentId}`);
    }
    const allChunks = selectedChunk ? [selectedChunk] : this.store.listKnowledgeChunks(document.id, 1_000);
    let content = "";
    const included: KnowledgeChunkRecord[] = [];
    for (const chunk of allChunks) {
      const separator = content ? "\n\n" : "";
      if (content.length + separator.length + chunk.content.length > maxChars) {
        const remaining = maxChars - content.length - separator.length;
        if (remaining > 0) content += `${separator}${chunk.content.slice(0, remaining)}`;
        break;
      }
      content += `${separator}${chunk.content}`;
      included.push(chunk);
    }
    const { absolutePath: _absolutePath, ...publicDocument } = document;
    return {
      document: publicDocument,
      content,
      chunks: included.map((chunk) => ({ id: chunk.id, ordinal: chunk.ordinal, locator: chunk.locator })),
      citation: {
        sourceId: document.sourceId,
        documentId: document.id,
        path: document.relativePath,
        title: document.title,
        sha256: document.sha256,
        locator: selectedChunk?.locator,
      },
      truncated: included.length < allChunks.length,
    };
  }
}
