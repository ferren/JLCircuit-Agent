import {
  BRIDGE_PROTOCOL_VERSION,
  createBridgeHello,
  type BridgeMessage,
  type ToolRequest,
  type ToolResponse,
} from "../../../packages/bridge/src/index.ts";
import { JlcEdaAdapter, type JlcEdaApi } from "./eda-adapter.ts";

export interface EdaBridgeClientOptions {
  url?: string;
  extensionVersion?: string;
  connectionId?: string;
  connectTimeoutMs?: number;
}

export class EdaBridgeClient {
  private readonly eda: JlcEdaApi;
  private readonly options: EdaBridgeClientOptions;
  private readonly adapter: JlcEdaAdapter;
  private connected = false;
  private connectionPromise?: Promise<void>;

  public constructor(eda: JlcEdaApi, options: EdaBridgeClientOptions = {}) {
    this.eda = eda;
    this.options = options;
    this.adapter = new JlcEdaAdapter(eda);
  }

  public connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    this.connectionPromise ??= this.openConnection().finally(() => {
      this.connectionPromise = undefined;
    });
    return this.connectionPromise;
  }

  public disconnect(): void {
    const connectionId = this.options.connectionId ?? "jlcircuit-agent-bridge";
    this.eda.sys_WebSocket?.close?.(connectionId, 1000, "extension disconnected");
    this.connected = false;
  }

  private openConnection(): Promise<void> {
    const socket = this.eda.sys_WebSocket;
    const url = this.options.url ?? "ws://127.0.0.1:49630/bridge";
    const connectionId = this.options.connectionId ?? "jlcircuit-agent-bridge";
    if (!socket?.register || !socket.send) {
      return Promise.reject(new Error("eda.sys_WebSocket is unavailable in the EDA runtime."));
    }
    const register = socket.register;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Unable to connect to JLCircuit Agent bridge within ${this.options.connectTimeoutMs ?? 10000}ms.`));
      }, this.options.connectTimeoutMs ?? 10_000);

      const connectedCallFn = async () => {
        try {
          const capabilities = await this.adapter.getCapabilities();
          socket.send?.(
            connectionId,
            JSON.stringify(createBridgeHello(this.options.extensionVersion ?? "0.1.0", capabilities)),
          );
          this.connected = true;
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve();
          }
        } catch (error) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(error);
          }
        }
      };

      try {
        register.call(
          socket,
          connectionId,
          url,
          (event) => void this.handleMessage(String(event.data ?? event)),
          connectedCallFn,
        );
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  private send(message: unknown): void {
    const connectionId = this.options.connectionId ?? "jlcircuit-agent-bridge";
    this.eda.sys_WebSocket?.send?.(connectionId, JSON.stringify(message));
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: BridgeMessage;
    try {
      message = JSON.parse(raw) as BridgeMessage;
    } catch {
      return;
    }
    if (message.type === "hello_ack" && message.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
      this.disconnect();
      return;
    }
    if (message.type !== "request") return;
    const response = await this.dispatch(message.request);
    this.send({ type: "response", response });
  }

  private async dispatch(request: ToolRequest): Promise<ToolResponse> {
    try {
      let data: unknown;
      let content: ToolResponse["content"];
      if (request.operation === "get_context") data = await this.adapter.getContext();
      else if (request.operation === "run_drc") data = await this.adapter.runDrc();
      else if (request.operation === "get_capabilities") data = await this.adapter.getCapabilities();
      else if (request.operation === "tool_call" && request.tool) {
        const result = await this.adapter.callTool(request.tool, request.payload);
        data = result.data;
        content = result.content;
      } else {
        throw new Error(`Unsupported bridge operation: ${request.operation}`);
      }
      return { requestId: request.requestId, ok: true, data, content };
    } catch (error) {
      return {
        requestId: request.requestId,
        ok: false,
        error: {
          code: "EDA_TOOL_ERROR",
          message: error instanceof Error ? error.message : "Unknown EDA tool error",
          retryable: false,
        },
      };
    }
  }
}
