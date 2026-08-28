import type {
  ChangeSet,
  DesignContext,
  DesignReference,
  EdaCapabilities,
  ToolContent,
  VisualEvidence,
} from "../../../packages/contracts/src/index.ts";

type UnknownRecord = Record<string, unknown>;
type PrimitiveApi = UnknownRecord;

type Viewport = { left: number; right: number; top: number; bottom: number };

export interface ToolExecutionResult {
  data: unknown;
  content?: ToolContent[];
}

export interface JlcEdaApi {
  sys_IFrame?: {
    openIFrame?: (
      htmlFileName: string,
      width?: number,
      height?: number,
      id?: string,
      props?: {
        maximizeButton?: boolean;
        minimizeButton?: boolean;
        minimizeStyle?: "collapsed" | "constricted";
        title?: string;
        grayscaleMask?: boolean;
        x?: number;
        y?: number;
      },
    ) => Promise<boolean>;
    closeIFrame?: (id?: string) => Promise<boolean>;
  };
  sys_Dialog?: {
    showInformationMessage?: (content: string, title?: string, buttonTitle?: string) => void;
  };
  sys_Message?: {
    showToastMessage?: (message: string, messageType?: string) => void;
  };
  sys_WebSocket?: {
    register?: (
      id: string,
      serviceUri: string,
      receiveMessageCallFn?: (event: { data?: unknown }) => void | Promise<void>,
      connectedCallFn?: () => void | Promise<void>,
      protocols?: string | string[],
    ) => void;
    send?: (id: string, data: string | ArrayBuffer | Blob | ArrayBufferView, extensionUuid?: string) => void;
    close?: (id: string, code?: number, reason?: string, extensionUuid?: string) => void;
  };
  dmt_Project?: { getCurrentProjectInfo?: () => Promise<unknown> };
  dmt_SelectControl?: { getCurrentDocumentInfo?: () => Promise<unknown> };
  dmt_EditorControl?: PrimitiveApi;
  sch_SelectControl?: { getAllSelectedPrimitives?: () => Promise<unknown> };
  pcb_SelectControl?: { getAllSelectedPrimitives?: () => Promise<unknown> };
  sch_PrimitiveComponent?: PrimitiveApi;
  sch_PrimitiveWire?: PrimitiveApi;
  sch_Document?: PrimitiveApi;
  sch_Drc?: PrimitiveApi;
  pcb_Drc?: PrimitiveApi;
}

export interface SchematicComponentSummary {
  primitiveId: string;
  reference?: string;
  name?: string;
  x?: number;
  y?: number;
  rotation?: number;
  raw?: unknown;
}

export interface SchematicWireSummary {
  primitiveId: string;
  line: Array<number> | Array<Array<number>>;
  net?: string;
  raw?: unknown;
}

export interface MoveComponentResult {
  primitiveId: string;
  requestedPosition: { x: number; y: number };
  createdWireIds: string[];
  movedWireIds: string[];
  unresolvedWireIds: string[];
  connectionCheck: "passed" | "inconclusive" | "failed";
  warning?: string;
  saved: boolean;
}

export class JlcEdaAdapter {
  private readonly eda: JlcEdaApi;

  public constructor(eda: JlcEdaApi) {
    this.eda = eda;
  }

  public async getContext(): Promise<DesignContext> {
    const project = await this.eda.dmt_Project?.getCurrentProjectInfo?.();
    const activeDocument = await this.eda.dmt_SelectControl?.getCurrentDocumentInfo?.();
    const documentType = normalizeDocument(activeDocument)?.type;
    const isSchematic = documentType === "schematic" || documentType === "schematic-page";
    const selected = isSchematic
      ? normalizeSelected(await callMethodSafely(this.eda.sch_SelectControl, "getAllSelectedPrimitives"), "schematic")
      : normalizeSelected(await callMethodSafely(this.eda.pcb_SelectControl, "getAllSelectedPrimitives"), "pcb");
    const summary: Record<string, unknown> = {
      api: "official-pro-api",
      primitiveReadModel: "best-effort",
    };
    if (isSchematic) {
      summary.components = (await this.getSchematicComponents()).map(({ raw: _raw, ...component }) => component);
      summary.wires = (await this.getSchematicWires()).map(({ raw: _raw, ...wire }) => wire);
    }
    return {
      project: normalizeProject(project),
      activeDocument: normalizeDocument(activeDocument),
      selected,
      summary,
      drc: [],
      capturedAt: new Date().toISOString(),
      source: "jlcircuit-eda",
    };
  }

  public async getSchematicComponents(): Promise<SchematicComponentSummary[]> {
    const primitives = await readAll(this.eda.sch_PrimitiveComponent, "getAll");
    return Promise.all(primitives.map((primitive) => normalizeComponent(primitive)));
  }

  public async getSchematicWires(): Promise<SchematicWireSummary[]> {
    const primitives = await readAll(this.eda.sch_PrimitiveWire, "getAll");
    const wires: SchematicWireSummary[] = [];
    for (const primitive of primitives) {
      const primitiveId = await readString(primitive, ["getState_PrimitiveId", "getState_primitiveId", "primitiveId", "id"]);
      const line = await readLine(primitive);
      if (!primitiveId || !line) continue;
      wires.push({
        primitiveId,
        line,
        net: await readString(primitive, ["getState_Net", "getState_net", "net"]),
        raw: primitive,
      });
    }
    return wires;
  }

  public async runDrc(): Promise<DesignContext["drc"]> {
    const document = await this.eda.dmt_SelectControl?.getCurrentDocumentInfo?.();
    const documentType = String((document as UnknownRecord | undefined)?.documentType ?? "");
    const drcApi = documentType.toLowerCase().includes("pcb") ? this.eda.pcb_Drc : this.eda.sch_Drc;
    return normalizeDrc(await callMethod(drcApi, "check", true, false, true));
  }

  public async getCapabilities(): Promise<EdaCapabilities> {
    const canReadComponents = Boolean(getMethod(this.eda.sch_PrimitiveComponent, "getAll"));
    const canReadWires = Boolean(getMethod(this.eda.sch_PrimitiveWire, "getAll"));
    const canModifyComponent = Boolean(getMethod(this.eda.sch_PrimitiveComponent, "modify"));
    const canCreateWire = Boolean(getMethod(this.eda.sch_PrimitiveWire, "create"));
    const canDeleteWire = Boolean(getMethod(this.eda.sch_PrimitiveWire, "delete"));
    const canCaptureCanvas = Boolean(getMethod(this.eda.dmt_EditorControl, "getCurrentRenderedAreaImage"));
    const canLocateCanvas = Boolean(
      getMethod(this.eda.dmt_EditorControl, "zoomTo") || getMethod(this.eda.dmt_EditorControl, "zoomToRegion"),
    );
    return {
      adapter: "jlcircuit-eda",
      capabilities: [
        { name: "read_context", enabled: true, riskLevel: "read" },
        { name: "read_schematic_components", enabled: canReadComponents, riskLevel: "read", beta: true },
        { name: "read_schematic_wires", enabled: canReadWires, riskLevel: "read", beta: true },
        {
          name: "run_drc",
          enabled: Boolean(getMethod(this.eda.sch_Drc, "check") || getMethod(this.eda.pcb_Drc, "check")),
          riskLevel: "read",
          beta: true,
        },
        {
          name: "move_component_with_wires",
          enabled: canModifyComponent,
          riskLevel: "high",
          beta: true,
          reason: canCreateWire && canDeleteWire
            ? "保留原导线并创建正交桥接线；创建失败时删除新线并回滚元件。复杂总线仍需人工确认。"
            : "原理图导线 create/delete API 不完整；为避免断线，保持连接模式将拒绝移动。",
        },
        { name: "canvas_capture", enabled: canCaptureCanvas, riskLevel: "read", beta: true },
        { name: "canvas_locate", enabled: canLocateCanvas, riskLevel: "read", beta: true },
        {
          name: "post_write_visual_verify",
          enabled: canCaptureCanvas,
          riskLevel: "read",
          beta: true,
          reason: canCaptureCanvas ? "返回当前画布截图；视觉可读性仍需模型或人工复核。" : "DMT_EditorControl.getCurrentRenderedAreaImage 不可用。",
        },
      ],
      checkedAt: new Date().toISOString(),
    };
  }

  public async callTool(tool: string, payload: UnknownRecord): Promise<ToolExecutionResult> {
    switch (tool) {
      case "easyeda_health_check":
        return { data: { status: "ok", capabilities: await this.getCapabilities() } };
      case "easyeda_get_context":
        return { data: await this.getContext() };
      case "easyeda_schematic_components":
        return { data: await this.getSchematicComponents() };
      case "easyeda_schematic_wires":
        return { data: await this.getSchematicWires() };
      case "easyeda_run_drc":
        return { data: await this.runDrc() };
      case "easyeda_canvas_locate":
        return { data: await this.locateCanvas(payload) };
      case "easyeda_canvas_capture": {
        const evidence = await this.captureCanvas(payload);
        return { data: evidence.metadata, content: evidence.content };
      }
      case "easyeda_canvas_capture_region": {
        const evidence = await this.captureCanvasRegion(payload);
        return { data: evidence.metadata, content: evidence.content };
      }
      case "easyeda_post_write_verify":
        return this.postWriteVerify(payload);
      case "easyeda_schematic_move_component": {
        const data = await this.moveComponent(payload);
        if (payload.verifyVisual === false) return { data };
        const evidence = await this.captureCanvas({
          tabId: typeof payload.tabId === "string" ? payload.tabId : undefined,
          x: data.requestedPosition.x,
          y: data.requestedPosition.y,
          scaleRatio: 200,
        });
        return {
          data: { ...data, visual: evidence.metadata },
          content: evidence.content,
        };
      }
      default:
        throw new Error(`Unsupported EDA tool: ${tool}`);
    }
  }

  private async locateCanvas(payload: UnknownRecord): Promise<{ located: boolean; viewport?: Viewport; tabId?: string }> {
    const editor = this.eda.dmt_EditorControl;
    const tabId = typeof payload.tabId === "string" ? payload.tabId : undefined;
    const left = optionalNumber(payload.left);
    const right = optionalNumber(payload.right);
    const top = optionalNumber(payload.top);
    const bottom = optionalNumber(payload.bottom);
    if ([left, right, top, bottom].every((value) => value !== undefined)) {
      const result = await callMethod(editor, "zoomToRegion", left, right, top, bottom, tabId);
      return { located: result === true, tabId };
    }
    const x = optionalNumber(payload.x);
    const y = optionalNumber(payload.y);
    const scaleRatio = optionalNumber(payload.scaleRatio);
    const result = await callMethod(editor, "zoomTo", x, y, scaleRatio, tabId);
    return { located: Boolean(result), viewport: isViewport(result) ? result : undefined, tabId };
  }

  private async captureCanvas(payload: UnknownRecord): Promise<{ metadata: VisualEvidence; content?: ToolContent[] }> {
    const editor = this.eda.dmt_EditorControl;
    const tabId = typeof payload.tabId === "string" ? payload.tabId : undefined;
    let viewport: Viewport | undefined;
    if (optionalNumber(payload.x) !== undefined || optionalNumber(payload.y) !== undefined || optionalNumber(payload.scaleRatio) !== undefined) {
      const located = await this.locateCanvas(payload);
      viewport = located.viewport;
    }
    const blob = await callMethod(editor, "getCurrentRenderedAreaImage", tabId);
    return createImageEvidence(blob, { tabId, viewport });
  }

  private async captureCanvasRegion(payload: UnknownRecord): Promise<{ metadata: VisualEvidence; content?: ToolContent[] }> {
    const left = requireNumber(payload.left, "left");
    const right = requireNumber(payload.right, "right");
    const top = requireNumber(payload.top, "top");
    const bottom = requireNumber(payload.bottom, "bottom");
    const tabId = typeof payload.tabId === "string" ? payload.tabId : undefined;
    const located = await callMethod(this.eda.dmt_EditorControl, "zoomToRegion", left, right, top, bottom, tabId);
    if (located !== true) {
      return createImageEvidence(undefined, { tabId, viewport: { left, right, top, bottom } });
    }
    const blob = await callMethod(this.eda.dmt_EditorControl, "getCurrentRenderedAreaImage", tabId);
    return createImageEvidence(blob, { tabId, viewport: { left, right, top, bottom } });
  }

  private async postWriteVerify(payload: UnknownRecord): Promise<ToolExecutionResult> {
    const context = await this.getContext();
    const drc = payload.runDrc === false ? [] : await this.runDrc();
    const capture = payload.capture !== false;
    let visual: VisualEvidence | undefined;
    let content: ToolContent[] | undefined;
    if (capture) {
      const evidence = hasRegion(payload)
        ? await this.captureCanvasRegion(payload)
        : await this.captureCanvas({ tabId: payload.tabId });
      visual = evidence.metadata;
      content = evidence.content;
    }
    return {
      data: {
        semantic: {
          contextCaptured: true,
          drcChecked: payload.runDrc !== false,
          drcIssueCount: drc.length,
          drc,
        },
        visual,
        readability: {
          status: visual?.captured ? "visual_capture_only" : "inconclusive",
          reviewRequired: true,
          note: "当前版本返回真实画布截图，尚未自动判断重叠、交叉和标签碰撞。",
        },
        context,
      },
      content,
    };
  }

  public async applyChangeSet(_changeSet: ChangeSet): Promise<never> {
    throw new Error("Use explicit capability-gated tools; generic ChangeSet execution is not enabled yet.");
  }

  private async moveComponent(payload: UnknownRecord): Promise<MoveComponentResult> {
    if (payload.confirmWrite !== true) throw new Error("Moving a component requires confirmWrite=true.");
    const primitiveId = requireString(payload.primitiveId, "primitiveId");
    const x = requireNumber(payload.x, "x");
    const y = requireNumber(payload.y, "y");
    const preserveConnections = payload.preserveConnections !== false;
    const componentApi = this.eda.sch_PrimitiveComponent;
    const wireApi = this.eda.sch_PrimitiveWire;
    const modifyComponent = getMethod(componentApi, "modify");
    if (!modifyComponent) throw new Error("SCH_PrimitiveComponent.modify is unavailable.");
    const component = await findPrimitive(componentApi, primitiveId);
    if (!component) throw new Error(`Schematic component not found: ${primitiveId}`);
    const oldX = await readNumber(component, ["getState_X", "getState_x", "x"]);
    const oldY = await readNumber(component, ["getState_Y", "getState_y", "y"]);
    if (oldX === undefined || oldY === undefined) {
      throw new Error(`Cannot read the current position of schematic component: ${primitiveId}`);
    }
    const oldPins = await readPins(componentApi, primitiveId);
    const beforeWires = await this.getSchematicWires();
    const pinMoves = oldPins.map((from) => ({
      from,
      to: { ...from, x: from.x + x - oldX, y: from.y + y - oldY },
    }));
    const createWire = getMethod(wireApi, "create");
    const deleteWire = getMethod(wireApi, "delete");
    if (preserveConnections && oldPins.length === 0) {
      throw new Error("Cannot preserve connections because the component pin positions are unavailable. The component was not moved.");
    }
    if (preserveConnections && (!createWire || !deleteWire)) {
      throw new Error("Cannot preserve connections because SCH_PrimitiveWire.create/delete is unavailable. The component was not moved.");
    }
    const bridgePlans = preserveConnections
      ? pinMoves.flatMap((move) => {
          const attachedWires = beforeWires.filter((wire) =>
            linePoints(wire.line).some((point) => samePoint(point, move.from)));
          if (attachedWires.length === 0) return [];
          const namedNets = [...new Set(attachedWires.map((wire) => wire.net).filter((net): net is string => Boolean(net)))];
          if (namedNets.length > 1) {
            throw new Error(
              `Cannot preserve pin at (${move.from.x}, ${move.from.y}) because it touches multiple nets: ${namedNets.join(", ")}. ` +
              "The component was not moved.",
            );
          }
          return [{
            move,
            net: namedNets[0],
            line: createOrthogonalBridgeLine(move.from, move.to),
          }];
        })
      : [];
    if (preserveConnections && bridgePlans.length === 0) {
      throw new Error(
        "Cannot preserve connections because no wire endpoints matched the component pins. The component was not moved. " +
        "Use preserveConnections=false only after confirming that the component is intentionally unconnected.",
      );
    }
    const createdWires: Array<{ primitiveId: string; move: { from: PinPosition; to: PinPosition } }> = [];
    let componentMoved = false;
    try {
      const modifiedComponent = await modifyComponent.call(componentApi, primitiveId, { x, y });
      componentMoved = true;
      if (!modifiedComponent) throw new Error("SCH_PrimitiveComponent.modify returned no updated component.");
      for (const plan of bridgePlans) {
        const createdWire = await createWire?.call(wireApi, plan.line, plan.net);
        if (!createdWire) {
          throw new Error(`SCH_PrimitiveWire.create failed for pin at (${plan.move.to.x}, ${plan.move.to.y}).`);
        }
        const createdWireId = await readString(createdWire, ["getState_PrimitiveId", "getState_primitiveId", "primitiveId", "id"]);
        const createdLine = await readLine(createdWire);
        if (!createdWireId || !createdLine || !linePoints(createdLine).some((point) => samePoint(point, plan.move.to))) {
          throw new Error(`SCH_PrimitiveWire.create returned an unverifiable bridge for pin at (${plan.move.to.x}, ${plan.move.to.y}).`);
        }
        createdWires.push({ primitiveId: createdWireId, move: plan.move });
      }
      const currentComponent = await findPrimitive(componentApi, primitiveId);
      const currentX = await readNumber(currentComponent, ["getState_X", "getState_x", "x"]);
      const currentY = await readNumber(currentComponent, ["getState_Y", "getState_y", "y"]);
      if (currentX === undefined || currentY === undefined || !samePoint({ x: currentX, y: currentY }, { x, y })) {
        throw new Error("Component position verification failed after modify.");
      }
      let unresolvedWireIds = createdWires.map((wire) => wire.primitiveId);
      for (const settleMs of [0, 50, 150, 300, 500]) {
        if (settleMs > 0) await waitFor(settleMs);
        const verificationResults = await Promise.all(createdWires.map(async (created) => {
          const currentWire = await findPrimitive(wireApi, created.primitiveId);
          const currentLine = await readLine(currentWire);
          return currentLine && linePoints(currentLine).some((point) => samePoint(point, created.move.to))
            ? undefined
            : created.primitiveId;
        }));
        unresolvedWireIds = verificationResults.filter((wireId): wireId is string => typeof wireId === "string");
        if (unresolvedWireIds.length === 0) break;
      }
      const save = payload.save === true;
      if (save) await callMethod(this.eda.sch_Document, "save");
      const connectionCheck = preserveConnections && unresolvedWireIds.length === 0 ? "passed" : "inconclusive";
      const createdWireIds = createdWires.map((wire) => wire.primitiveId);
      return {
        primitiveId,
        requestedPosition: { x, y },
        createdWireIds,
        movedWireIds: createdWireIds,
        unresolvedWireIds,
        connectionCheck,
        warning:
          connectionCheck === "passed"
            ? "已保留原导线、创建正交桥接线并复核新引脚端点；复杂总线和网络标签仍需运行 DRC/ERC。"
            : unresolvedWireIds.length > 0
              ? `桥接线创建调用已成功，但 EDA 读模型暂未返回 ${unresolvedWireIds.join(", ")}；未自动回滚，请立即执行 DRC/ERC 和画布检查。`
              : "没有检测到落在器件引脚上的导线端点；元件可能未接线，仍需人工检查。",
        saved: save,
      };
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const created of [...createdWires].reverse()) {
        try {
          const deleted = await deleteWire?.call(wireApi, created.primitiveId);
          if (deleted !== true) rollbackErrors.push(`created wire rollback returned no success: ${created.primitiveId}`);
        } catch (rollbackError) {
          rollbackErrors.push(`created wire rollback failed for ${created.primitiveId}: ${String(rollbackError)}`);
        }
      }
      if (componentMoved) {
        try {
          const rolledBackComponent = await modifyComponent.call(componentApi, primitiveId, { x: oldX, y: oldY });
          if (!rolledBackComponent) rollbackErrors.push("component rollback returned no result");
        } catch (rollbackError) {
          rollbackErrors.push(`component rollback failed: ${String(rollbackError)}`);
        }
      }
      if (payload.save === true && rollbackErrors.length === 0) {
        try { await callMethod(this.eda.sch_Document, "save"); } catch (saveError) {
          rollbackErrors.push(`saving rollback failed: ${String(saveError)}`);
        }
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(rollbackErrors.length === 0
        ? `${reason} The component and created bridge wires were rolled back.`
        : `${reason} Automatic rollback was incomplete: ${rollbackErrors.join("; ")}`);
    }
  }
}

const getMethod = (target: unknown, name: string): ((...args: unknown[]) => Promise<unknown>) | undefined => {
  if (!target || typeof target !== "object") return undefined;
  const member = (target as UnknownRecord)[name];
  return typeof member === "function" ? (member as (...args: unknown[]) => Promise<unknown>) : undefined;
};

const callMethod = async (target: unknown, name: string, ...args: unknown[]): Promise<unknown> => {
  const method = getMethod(target, name);
  return method ? method.call(target, ...args) : undefined;
};

const callMethodSafely = async (target: unknown, name: string, ...args: unknown[]): Promise<unknown> => {
  try {
    return await callMethod(target, name, ...args);
  } catch {
    return undefined;
  }
};

const readAll = async (target: unknown, name: string): Promise<unknown[]> => {
  const value = await callMethodSafely(target, name);
  return Array.isArray(value) ? value : [];
};

const readField = async (value: unknown, names: string[]): Promise<unknown> => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as UnknownRecord;
  for (const name of names) {
    const member = record[name];
    if (typeof member === "function") {
      try {
        return await (member as (...args: unknown[]) => Promise<unknown>).call(value);
      } catch {
        continue;
      }
    }
    if (member !== undefined) return member;
  }
  return undefined;
};

const readString = async (value: unknown, names: string[]): Promise<string | undefined> => {
  const result = await readField(value, names);
  return result === undefined || result === null ? undefined : String(result);
};

const readNumber = async (value: unknown, names: string[]): Promise<number | undefined> => {
  const result = await readField(value, names);
  return typeof result === "number" && Number.isFinite(result) ? result : undefined;
};

const normalizeComponent = async (primitive: unknown): Promise<SchematicComponentSummary> => ({
  primitiveId:
    (await readString(primitive, ["getState_PrimitiveId", "getState_primitiveId", "primitiveId", "id"])) ??
    "unknown",
  reference: await readString(primitive, ["getState_Designator", "getState_designator", "designator", "reference"]),
  name: await readString(primitive, ["getState_Name", "getState_name", "name"]),
  x: await readNumber(primitive, ["getState_X", "getState_x", "x"]),
  y: await readNumber(primitive, ["getState_Y", "getState_y", "y"]),
  rotation: await readNumber(primitive, ["getState_Rotation", "getState_rotation", "rotation"]),
  raw: primitive,
});

const normalizeProject = (value: unknown): DesignContext["project"] => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as UnknownRecord;
  return { id: String(record.uuid ?? record.id ?? "unknown"), name: typeof record.name === "string" ? record.name : undefined };
};

const normalizeDocument = (value: unknown): DesignContext["activeDocument"] => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as UnknownRecord;
  const rawType = record.documentType ?? record.type ?? "unknown";
  const numericType = typeof rawType === "number" ? rawType : Number(rawType);
  const type = numericType === 1
    ? "schematic-page"
    : numericType === 3
      ? "pcb"
      : numericType === 5
        ? "project"
        : String(rawType).toLowerCase().includes("pcb")
          ? "pcb"
          : String(rawType).toLowerCase().includes("schematic")
            ? String(rawType).toLowerCase().includes("page")
              ? "schematic-page"
              : "schematic"
            : "project";
  return { id: String(record.uuid ?? record.id ?? "unknown"), type, name: typeof record.name === "string" ? record.name : undefined };
};

const normalizeSelected = (value: unknown, documentType: "schematic" | "pcb"): DesignReference[] => {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = (item && typeof item === "object" ? item : {}) as UnknownRecord;
    return {
      id: String(record.uuid ?? record.id ?? `selected-${index + 1}`),
      kind: "unknown",
      documentType,
      name: typeof record.name === "string" ? record.name : undefined,
      reference: typeof record.designator === "string" ? record.designator : undefined,
    };
  });
};

const normalizeDrc = (value: unknown): DesignContext["drc"] => {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => ({
    id: `drc-${index + 1}`,
    severity: "unknown" as const,
    message: typeof item === "string" ? item : JSON.stringify(item),
    documentType: "project" as const,
    references: [],
    raw: item,
  }));
};

const findPrimitive = async (api: unknown, primitiveId: string): Promise<unknown> => {
  const direct = await callMethod(api, "get", primitiveId);
  if (direct) return direct;
  const all = await readAll(api, "getAll");
  for (const primitive of all) {
    const id = await readString(primitive, ["getState_PrimitiveId", "getState_primitiveId", "primitiveId", "id"]);
    if (id === primitiveId) return primitive;
  }
  return undefined;
};

type PinPosition = { x: number; y: number };

const readPins = async (api: unknown, primitiveId: string): Promise<PinPosition[]> => {
  const pins = await callMethod(api, "getAllPinsByPrimitiveId", primitiveId);
  if (!Array.isArray(pins)) return [];
  const result: PinPosition[] = [];
  for (const pin of pins) {
    const x = await readNumber(pin, ["getState_X", "getState_x", "x"]);
    const y = await readNumber(pin, ["getState_Y", "getState_y", "y"]);
    if (x !== undefined && y !== undefined) result.push({ x, y });
  }
  return result;
};

const readLine = async (wire: unknown): Promise<Array<number> | Array<Array<number>> | undefined> => {
  const value = await readField(wire, ["getState_Line", "getState_line", "line"]);
  if (!Array.isArray(value)) return undefined;
  if (value.every((item) => typeof item === "number")) return value as Array<number>;
  if (value.every((item) => Array.isArray(item) && item.length >= 2)) return value as Array<Array<number>>;
  return undefined;
};

const flatLinePoints = (line: Array<number>): PinPosition[] =>
  line.reduce<PinPosition[]>((points, value, index, values) => {
    if (index % 2 === 0 && typeof values[index + 1] === "number") points.push({ x: value, y: values[index + 1] });
    return points;
  }, []);

const linePoints = (line: Array<number> | Array<Array<number>>): PinPosition[] =>
  line.length === 0
    ? []
    : typeof line[0] === "number"
      ? flatLinePoints(line as Array<number>)
      : (line as Array<Array<number>>).flatMap((segment) => flatLinePoints(segment));

const createOrthogonalBridgeLine = (from: PinPosition, to: PinPosition): Array<number> =>
  sameCoordinate(from.x, to.x) || sameCoordinate(from.y, to.y)
    ? [from.x, from.y, to.x, to.y]
    : [from.x, from.y, to.x, from.y, to.x, to.y];

const sameCoordinate = (left: number, right: number): boolean => Math.abs(left - right) < 1e-6;

const samePoint = (left: PinPosition, right: PinPosition): boolean =>
  sameCoordinate(left.x, right.x) && sameCoordinate(left.y, right.y);

const waitFor = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string.`);
  return value;
};

const requireNumber = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
};

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const hasRegion = (payload: UnknownRecord): boolean =>
  [payload.left, payload.right, payload.top, payload.bottom].every((value) => optionalNumber(value) !== undefined);

const isViewport = (value: unknown): value is Viewport => {
  if (!value || typeof value !== "object") return false;
  const record = value as UnknownRecord;
  return [record.left, record.right, record.top, record.bottom].every((item) => typeof item === "number");
};

const createImageEvidence = async (
  value: unknown,
  options: { tabId?: string; viewport?: Viewport },
): Promise<{ metadata: VisualEvidence; content?: ToolContent[] }> => {
  const capturedAt = new Date().toISOString();
  if (!isBlob(value)) {
    return {
      metadata: {
        captured: false,
        tabId: options.tabId,
        viewport: options.viewport,
        capturedAt,
        notAvailable: "DMT_EditorControl.getCurrentRenderedAreaImage 未返回 Blob。",
      },
    };
  }
  const data = await blobToBase64(value);
  return {
    metadata: {
      captured: true,
      mimeType: value.type || "image/png",
      byteLength: value.size,
      tabId: options.tabId,
      viewport: options.viewport,
      capturedAt,
    },
    content: [{ type: "image", data, mimeType: value.type || "image/png" }],
  };
};

const isBlob = (value: unknown): value is Blob =>
  typeof Blob !== "undefined" && value instanceof Blob;

const blobToBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return btoa(binary);
};
