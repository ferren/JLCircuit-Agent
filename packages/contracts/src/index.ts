export type DesignDocumentType = "project" | "schematic" | "schematic-page" | "pcb";

export type RiskLevel = "read" | "low" | "medium" | "high";

export type PrimitiveKind =
  | "component"
  | "pin"
  | "wire"
  | "net"
  | "pad"
  | "line"
  | "via"
  | "pour"
  | "fill"
  | "region"
  | "text"
  | "unknown";

export interface DesignReference {
  id: string;
  kind: PrimitiveKind;
  documentType: DesignDocumentType;
  name?: string;
  reference?: string;
}

export interface DesignContext {
  project?: {
    id: string;
    name?: string;
  };
  activeDocument?: {
    id: string;
    type: DesignDocumentType;
    name?: string;
  };
  selected: DesignReference[];
  summary: Record<string, unknown>;
  drc: DrcIssue[];
  capturedAt: string;
  source: "jlcircuit-eda" | "fixture";
}

export interface DrcIssue {
  id: string;
  severity: "error" | "warning" | "info" | "unknown";
  message: string;
  documentType: DesignDocumentType;
  references: DesignReference[];
  raw?: unknown;
}

export interface ChangeOperation {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  targets: DesignReference[];
  riskLevel: RiskLevel;
  description: string;
  expectedBefore?: Record<string, unknown>;
}

export interface ChangeSet {
  id: string;
  projectId?: string;
  documentId?: string;
  summary: string;
  operations: ChangeOperation[];
  requiresConfirmation: boolean;
  createdAt: string;
  createdBy: "agent" | "user" | "system";
}

export interface ToolRequest {
  requestId: string;
  sessionId: string;
  operation:
    | "get_context"
    | "run_drc"
    | "preview_changeset"
    | "apply_changeset"
    | "get_capabilities"
    | "tool_call";
  tool?: string;
  payload: Record<string, unknown>;
  confirmationToken?: string;
}

export interface ToolResponse<T = unknown> {
  requestId: string;
  ok: boolean;
  data?: T;
  content?: ToolContent[];
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  auditId?: string;
}

export type ToolContent =
  | {
      type: "image";
      data: string;
      mimeType: string;
    }
  | {
      type: "text";
      text: string;
    };

export interface VisualEvidence {
  captured: boolean;
  mimeType?: string;
  byteLength?: number;
  tabId?: string;
  viewport?: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
  capturedAt: string;
  notAvailable?: string;
}

export interface EdaCapability {
  name: string;
  enabled: boolean;
  riskLevel: RiskLevel;
  beta?: boolean;
  reason?: string;
}

export interface EdaCapabilities {
  adapter: "jlcircuit-eda";
  apiVersion?: string;
  capabilities: EdaCapability[];
  checkedAt: string;
}

export interface EdaToolDefinition {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  beta?: boolean;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
}
