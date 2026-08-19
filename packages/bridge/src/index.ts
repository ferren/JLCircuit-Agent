import type {
  ChangeSet,
  DesignContext,
  EdaCapabilities,
  ToolRequest,
  ToolResponse,
} from "../../contracts/src/index.ts";

export const BRIDGE_PROTOCOL_VERSION = 1;

export type BridgeHello = {
  type: "hello";
  protocolVersion: number;
  client: "jlcircuit-eda-extension";
  extensionVersion?: string;
  capabilities?: EdaCapabilities;
};

export type BridgeRequestMessage = {
  type: "request";
  request: ToolRequest;
};

export type BridgeResponseMessage = {
  type: "response";
  response: ToolResponse;
};

export type BridgeMessage =
  | BridgeHello
  | BridgeRequestMessage
  | BridgeResponseMessage
  | { type: "hello_ack"; protocolVersion: number; server: "jlcircuit-agent" };

export const createBridgeHello = (
  extensionVersion: string,
  capabilities?: EdaCapabilities,
): BridgeHello => ({
  type: "hello",
  protocolVersion: BRIDGE_PROTOCOL_VERSION,
  client: "jlcircuit-eda-extension",
  extensionVersion,
  capabilities,
});

export const createToolRequest = (
  sessionId: string,
  tool: string,
  payload: Record<string, unknown> = {},
): ToolRequest => ({
  requestId: crypto.randomUUID(),
  sessionId,
  operation: "tool_call",
  tool,
  payload,
});

export interface EdaRuntime {
  getContext(): Promise<DesignContext>;
  runDrc(): Promise<DesignContext["drc"]>;
  applyChangeSet(changeSet: ChangeSet): Promise<{
    appliedOperationIds: string[];
    validationRequired: boolean;
  }>;
  getCapabilities(): Promise<EdaCapabilities>;
}

export interface BridgeTransport {
  send<T = unknown>(request: ToolRequest): Promise<ToolResponse<T>>;
}

export type { ToolRequest, ToolResponse } from "../../contracts/src/index.ts";

export class TypedEdaBridge {
  private readonly transport: BridgeTransport;

  public constructor(transport: BridgeTransport) {
    this.transport = transport;
  }

  public getContext(sessionId: string): Promise<ToolResponse<DesignContext>> {
    return this.transport.send<DesignContext>({
      requestId: crypto.randomUUID(),
      sessionId,
      operation: "get_context",
      payload: {},
    });
  }

  public runDrc(sessionId: string): Promise<ToolResponse<DesignContext["drc"]>> {
    return this.transport.send<DesignContext["drc"]>({
      requestId: crypto.randomUUID(),
      sessionId,
      operation: "run_drc",
      payload: {},
    });
  }

  public previewChangeSet(
    sessionId: string,
    changeSet: ChangeSet,
  ): Promise<ToolResponse<ChangeSet>> {
    return this.transport.send<ChangeSet>({
      requestId: crypto.randomUUID(),
      sessionId,
      operation: "preview_changeset",
      payload: { changeSet },
    });
  }

  public applyChangeSet(
    sessionId: string,
    changeSet: ChangeSet,
    confirmationToken: string,
  ): Promise<ToolResponse> {
    return this.transport.send({
      requestId: crypto.randomUUID(),
      sessionId,
      operation: "apply_changeset",
      payload: { changeSet },
      confirmationToken,
    });
  }
}
