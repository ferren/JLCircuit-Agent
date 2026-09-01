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
  lib_Device?: PrimitiveApi;
  sch_PrimitiveComponent?: PrimitiveApi;
  sch_PrimitiveWire?: PrimitiveApi;
  sch_PrimitiveBus?: PrimitiveApi;
  sch_PrimitiveRectangle?: PrimitiveApi;
  sch_PrimitivePolygon?: PrimitiveApi;
  sch_PrimitiveText?: PrimitiveApi;
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

export interface CreateSchematicPrimitiveResult {
  primitiveType: "component" | "wire" | "bus" | "rectangle" | "polygon" | "text";
  primitiveId?: string;
  created: true;
  readbackStatus: "verified" | "inconclusive";
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
    const canSearchDevices = Boolean(
      getMethod(this.eda.lib_Device, "search") || getMethod(this.eda.lib_Device, "getByLcscIds"),
    );
    const canModifyComponent = Boolean(getMethod(this.eda.sch_PrimitiveComponent, "modify"));
    const canPlaceComponent = Boolean(getMethod(this.eda.sch_PrimitiveComponent, "create"));
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
        { name: "search_library_devices", enabled: canSearchDevices, riskLevel: "read", beta: true },
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
        { name: "place_schematic_component", enabled: canPlaceComponent, riskLevel: "high", beta: true },
        { name: "create_schematic_wire", enabled: canCreateWire, riskLevel: "high", beta: true },
        {
          name: "create_schematic_bus",
          enabled: Boolean(getMethod(this.eda.sch_PrimitiveBus, "create")),
          riskLevel: "high",
          beta: true,
        },
        {
          name: "create_schematic_rectangle",
          enabled: Boolean(getMethod(this.eda.sch_PrimitiveRectangle, "create")),
          riskLevel: "high",
          beta: true,
        },
        {
          name: "create_schematic_polygon",
          enabled: Boolean(getMethod(this.eda.sch_PrimitivePolygon, "create")),
          riskLevel: "high",
          beta: true,
        },
        {
          name: "create_schematic_text",
          enabled: Boolean(getMethod(this.eda.sch_PrimitiveText, "create")),
          riskLevel: "high",
          beta: true,
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
        return { data: await this.querySchematicComponents(payload) };
      case "easyeda_schematic_wires":
        return { data: await this.getSchematicWires() };
      case "easyeda_library_search_devices":
        return { data: await this.searchLibraryDevices(payload) };
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
      case "easyeda_schematic_place_component":
        return { data: await this.placeComponent(payload) };
      case "easyeda_schematic_create_wire":
        return { data: await this.createWire(payload) };
      case "easyeda_schematic_create_bus":
        return { data: await this.createBus(payload) };
      case "easyeda_schematic_create_rectangle":
        return { data: await this.createRectangle(payload) };
      case "easyeda_schematic_create_polygon":
        return { data: await this.createPolygon(payload) };
      case "easyeda_schematic_create_text":
        return { data: await this.createText(payload) };
      default:
        throw new Error(`Unsupported EDA tool: ${tool}`);
    }
  }

  private async querySchematicComponents(payload: UnknownRecord): Promise<{
    total: number;
    matched: number;
    returned: number;
    truncated: boolean;
    components: Array<Omit<SchematicComponentSummary, "raw">>;
  }> {
    const components = await this.getSchematicComponents();
    const references = new Set([
      typeof payload.reference === "string" ? payload.reference : undefined,
      ...(Array.isArray(payload.references) ? payload.references.filter((item): item is string => typeof item === "string") : []),
    ].filter((item): item is string => Boolean(item)).map((item) => item.toLowerCase()));
    const primitiveIds = new Set([
      typeof payload.primitiveId === "string" ? payload.primitiveId : undefined,
      ...(Array.isArray(payload.primitiveIds) ? payload.primitiveIds.filter((item): item is string => typeof item === "string") : []),
    ].filter((item): item is string => Boolean(item)));
    const query = typeof payload.query === "string" ? payload.query.trim().toLowerCase() : "";
    const left = optionalNumber(payload.left);
    const right = optionalNumber(payload.right);
    const top = optionalNumber(payload.top);
    const bottom = optionalNumber(payload.bottom);
    const hasRegionFilter = [left, right, top, bottom].every((value) => value !== undefined);
    const requestedLimit = optionalNumber(payload.limit);
    const limit = Math.max(1, Math.min(500, Math.floor(requestedLimit ?? 200)));
    const matched = components.filter((component) => {
      if (references.size > 0 && !references.has((component.reference ?? "").toLowerCase())) return false;
      if (primitiveIds.size > 0 && !primitiveIds.has(component.primitiveId)) return false;
      if (query) {
        const searchable = [component.primitiveId, component.reference, component.name]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!searchable.includes(query)) return false;
      }
      if (hasRegionFilter) {
        if (component.x === undefined || component.y === undefined) return false;
        if (component.x < (left as number) || component.x > (right as number) ||
            component.y < (top as number) || component.y > (bottom as number)) return false;
      }
      return true;
    });
    return {
      total: components.length,
      matched: matched.length,
      returned: Math.min(matched.length, limit),
      truncated: matched.length > limit,
      components: matched.slice(0, limit).map(({ raw: _raw, ...component }) => component),
    };
  }

  private async searchLibraryDevices(payload: UnknownRecord): Promise<{
    query?: string;
    lcscIds?: string[];
    returned: number;
    page: number;
    devices: Array<Record<string, unknown>>;
  }> {
    const query = optionalString(payload.query);
    const lcscIds = Array.isArray(payload.lcscIds)
      ? payload.lcscIds.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 20)
      : [];
    if (!query && lcscIds.length === 0) throw new Error("query or lcscIds is required for device library search.");
    const libraryUuid = optionalString(payload.libraryUuid);
    const limit = Math.max(1, Math.min(50, Math.floor(optionalNumber(payload.limit) ?? 10)));
    const page = Math.max(1, Math.floor(optionalNumber(payload.page) ?? 1));
    let rawResults: unknown;
    if (lcscIds.length > 0) {
      const getByLcscIds = getMethod(this.eda.lib_Device, "getByLcscIds");
      if (!getByLcscIds) throw new Error("LIB_Device.getByLcscIds is unavailable.");
      rawResults = await getByLcscIds.call(this.eda.lib_Device, lcscIds, libraryUuid, false);
    } else {
      const search = getMethod(this.eda.lib_Device, "search");
      if (!search) throw new Error("LIB_Device.search is unavailable.");
      rawResults = await search.call(this.eda.lib_Device, query, libraryUuid, undefined, undefined, limit, page);
    }
    const results = (Array.isArray(rawResults) ? rawResults : rawResults ? [rawResults] : [])
      .slice(0, limit)
      .map(normalizeDeviceSearchItem)
      .filter((item): item is Record<string, unknown> => Boolean(item));
    return {
      query,
      lcscIds: lcscIds.length > 0 ? lcscIds : undefined,
      returned: results.length,
      page,
      devices: results,
    };
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

  private async placeComponent(payload: UnknownRecord): Promise<CreateSchematicPrimitiveResult> {
    const libraryUuid = requireString(payload.libraryUuid, "libraryUuid");
    const uuid = requireString(payload.uuid, "uuid");
    return this.createSchematicPrimitive(
      payload,
      this.eda.sch_PrimitiveComponent,
      "component",
      [
        { libraryUuid, uuid },
        requireNumber(payload.x, "x"),
        requireNumber(payload.y, "y"),
        optionalString(payload.subPartName),
        optionalNumber(payload.rotation) ?? 0,
        payload.mirror === true,
        payload.addIntoBom !== false,
        payload.addIntoPcb !== false,
      ],
    );
  }

  private async createWire(payload: UnknownRecord): Promise<CreateSchematicPrimitiveResult> {
    return this.createSchematicPrimitive(payload, this.eda.sch_PrimitiveWire, "wire", [
      requireLine(payload.line, "line", 2, true),
      optionalString(payload.net),
      optionalNullableString(payload.color),
      optionalNullableNumber(payload.lineWidth),
      optionalNullableNumber(payload.lineType),
    ]);
  }

  private async createBus(payload: UnknownRecord): Promise<CreateSchematicPrimitiveResult> {
    return this.createSchematicPrimitive(payload, this.eda.sch_PrimitiveBus, "bus", [
      requireString(payload.busName, "busName"),
      requireLine(payload.line, "line", 2, true),
      optionalNullableString(payload.color),
      optionalNullableNumber(payload.lineWidth),
      optionalNullableNumber(payload.lineType),
    ]);
  }

  private async createRectangle(payload: UnknownRecord): Promise<CreateSchematicPrimitiveResult> {
    const width = requirePositiveNumber(payload.width, "width");
    const height = requirePositiveNumber(payload.height, "height");
    return this.createSchematicPrimitive(payload, this.eda.sch_PrimitiveRectangle, "rectangle", [
      requireNumber(payload.topLeftX, "topLeftX"),
      requireNumber(payload.topLeftY, "topLeftY"),
      width,
      height,
      optionalNumber(payload.cornerRadius) ?? 0,
      optionalNumber(payload.rotation) ?? 0,
      optionalNullableString(payload.color),
      optionalNullableString(payload.fillColor),
      optionalNullableNumber(payload.lineWidth),
      optionalNullableNumber(payload.lineType),
      optionalNullableString(payload.fillStyle),
    ]);
  }

  private async createPolygon(payload: UnknownRecord): Promise<CreateSchematicPrimitiveResult> {
    return this.createSchematicPrimitive(payload, this.eda.sch_PrimitivePolygon, "polygon", [
      requireLine(payload.line, "line", 3, false) as number[],
      optionalNullableString(payload.color),
      optionalNullableString(payload.fillColor),
      optionalNullableNumber(payload.lineWidth),
      optionalNullableNumber(payload.lineType),
    ]);
  }

  private async createText(payload: UnknownRecord): Promise<CreateSchematicPrimitiveResult> {
    return this.createSchematicPrimitive(payload, this.eda.sch_PrimitiveText, "text", [
      requireNumber(payload.x, "x"),
      requireNumber(payload.y, "y"),
      requireString(payload.content, "content"),
      optionalNumber(payload.rotation) ?? 0,
      optionalNullableString(payload.textColor),
      optionalNullableString(payload.fontName),
      optionalNullableNumber(payload.fontSize),
      payload.bold === true,
      payload.italic === true,
      payload.underLine === true,
      optionalNumber(payload.alignMode) ?? 1,
    ]);
  }

  private async createSchematicPrimitive(
    payload: UnknownRecord,
    api: unknown,
    primitiveType: CreateSchematicPrimitiveResult["primitiveType"],
    args: unknown[],
  ): Promise<CreateSchematicPrimitiveResult> {
    if (payload.confirmWrite !== true) throw new Error(`Creating schematic ${primitiveType} requires confirmWrite=true.`);
    await this.assertSchematicDocument();
    const create = getMethod(api, "create");
    if (!create) throw new Error(`SCH_Primitive${capitalize(primitiveType)}.create is unavailable.`);
    const beforeIds = new Set(await readPrimitiveIds(api));
    const primitive = await create.call(api, ...args);
    if (!primitive) throw new Error(`SCH_Primitive${capitalize(primitiveType)}.create returned no primitive.`);
    let primitiveId = await readString(
      primitive,
      ["getState_PrimitiveId", "getState_primitiveId", "primitiveId", "id"],
    );
    for (const settleMs of [0, 50, 150, 300]) {
      if (primitiveId) break;
      if (settleMs > 0) await waitFor(settleMs);
      primitiveId = await readString(
        primitive,
        ["getState_PrimitiveId", "getState_primitiveId", "primitiveId", "id"],
      );
      if (!primitiveId) {
        const addedIds = (await readPrimitiveIds(api)).filter((id) => !beforeIds.has(id));
        if (addedIds.length === 1) primitiveId = addedIds[0];
      }
    }
    const save = payload.save === true;
    if (save) await callMethod(this.eda.sch_Document, "save");
    return {
      primitiveType,
      primitiveId,
      created: true,
      readbackStatus: primitiveId ? "verified" : "inconclusive",
      warning: primitiveId
        ? undefined
        : "EDA 已确认 create 调用，但异步读取模型尚未返回图元 ID；请使用截图和 DRC/ERC 复核。",
      saved: save,
    };
  }

  private async assertSchematicDocument(): Promise<void> {
    const document = normalizeDocument(await this.eda.dmt_SelectControl?.getCurrentDocumentInfo?.());
    if (document?.type !== "schematic" && document?.type !== "schematic-page") {
      throw new Error("The active document is not a schematic page.");
    }
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
            lineContainsPoint(wire.line, move.from));
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
    const createdWires: Array<{
      primitiveId?: string;
      primitive: unknown;
      move: { from: PinPosition; to: PinPosition };
    }> = [];
    const knownWireIds = new Set(beforeWires.map((wire) => wire.primitiveId));
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
        let createdWireId: string | undefined;
        // Some EDA builds acknowledge create() before the returned proxy has an
        // ID. First retry the proxy, then identify the newly persisted wire by
        // diffing getAll() and matching both bridge endpoints.
        for (const settleMs of [0, 50, 150, 300, 500]) {
          if (settleMs > 0) await waitFor(settleMs);
          createdWireId = await readString(
            createdWire,
            ["getState_PrimitiveId", "getState_primitiveId", "primitiveId", "id"],
          );
          if (!createdWireId) {
            const candidates = (await this.getSchematicWires()).filter((wire) =>
              !knownWireIds.has(wire.primitiveId)
              && lineContainsPoint(wire.line, plan.move.from)
              && lineContainsPoint(wire.line, plan.move.to));
            if (candidates.length === 1) createdWireId = candidates[0]?.primitiveId;
          }
          if (createdWireId) break;
        }
        createdWires.push({ primitiveId: createdWireId, primitive: createdWire, move: plan.move });
        if (createdWireId) knownWireIds.add(createdWireId);
      }
      const currentComponent = await findPrimitive(componentApi, primitiveId);
      const currentX = await readNumber(currentComponent, ["getState_X", "getState_x", "x"]);
      const currentY = await readNumber(currentComponent, ["getState_Y", "getState_y", "y"]);
      if (currentX === undefined || currentY === undefined || !samePoint({ x: currentX, y: currentY }, { x, y })) {
        throw new Error("Component position verification failed after modify.");
      }
      let unresolvedWireIds = createdWires.map((wire) =>
        wire.primitiveId ?? `unresolved-pin@(${wire.move.to.x},${wire.move.to.y})`);
      for (const settleMs of [0, 50, 150, 300, 500]) {
        if (settleMs > 0) await waitFor(settleMs);
        const verificationResults = await Promise.all(createdWires.map(async (created) => {
          if (!created.primitiveId) return `unresolved-pin@(${created.move.to.x},${created.move.to.y})`;
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
      const createdWireIds = createdWires
        .map((wire) => wire.primitiveId)
        .filter((wireId): wireId is string => typeof wireId === "string");
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
          const deleteTarget = created.primitiveId ?? created.primitive;
          const deleted = await deleteWire?.call(wireApi, deleteTarget);
          if (deleted !== true) rollbackErrors.push(`created wire rollback returned no success: ${created.primitiveId ?? "unknown"}`);
        } catch (rollbackError) {
          rollbackErrors.push(`created wire rollback failed for ${created.primitiveId ?? "unknown"}: ${String(rollbackError)}`);
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

const readPrimitiveIds = async (api: unknown): Promise<string[]> => {
  const ids: string[] = [];
  for (const primitive of await readAll(api, "getAll")) {
    const id = await readString(primitive, ["getState_PrimitiveId", "getState_primitiveId", "primitiveId", "id"]);
    if (id) ids.push(id);
  }
  return ids;
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

const normalizeDeviceSearchItem = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const item = value as UnknownRecord;
  if (typeof item.uuid !== "string" || typeof item.libraryUuid !== "string") return undefined;
  const compactAssociation = (association: unknown): Record<string, unknown> | undefined => {
    if (!association || typeof association !== "object") return undefined;
    const record = association as UnknownRecord;
    return {
      name: typeof record.name === "string" ? record.name : undefined,
      uuid: typeof record.uuid === "string" ? record.uuid : undefined,
      libraryUuid: typeof record.libraryUuid === "string" ? record.libraryUuid : undefined,
    };
  };
  return {
    uuid: item.uuid,
    libraryUuid: item.libraryUuid,
    name: typeof item.name === "string" ? item.name : undefined,
    description: typeof item.description === "string" ? item.description : undefined,
    classification: item.classification,
    symbol: compactAssociation(item.symbol),
    footprint: compactAssociation(item.footprint),
    otherProperty: item.otherProperty && typeof item.otherProperty === "object" ? item.otherProperty : undefined,
  };
};

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

const lineContainsPoint = (line: Array<number> | Array<Array<number>>, point: PinPosition): boolean =>
  linePoints(line).some((candidate) => samePoint(candidate, point));

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

const requirePositiveNumber = (value: unknown, name: string): number => {
  const result = requireNumber(value, name);
  if (result <= 0) throw new Error(`${name} must be greater than zero.`);
  return result;
};

const requireLine = (
  value: unknown,
  name: string,
  minimumPoints: number,
  allowSegments: boolean,
): Array<number> | Array<Array<number>> => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a coordinate array.`);
  const validFlat = (line: unknown[]): line is number[] =>
    line.length >= minimumPoints * 2
    && line.length % 2 === 0
    && line.every((item) => typeof item === "number" && Number.isFinite(item));
  if (validFlat(value)) return [...value];
  if (
    allowSegments
    && value.every((segment) => Array.isArray(segment) && validFlat(segment))
  ) {
    return value.map((segment) => [...segment]) as number[][];
  }
  throw new Error(
    `${name} must contain at least ${minimumPoints} finite x/y points${allowSegments ? " in a flat line or valid segments" : " in one flat line"}.`,
  );
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const optionalNullableString = (value: unknown): string | null | undefined =>
  value === null ? null : optionalString(value);

const optionalNullableNumber = (value: unknown): number | null | undefined =>
  value === null ? null : optionalNumber(value);

const capitalize = (value: string): string => value.length > 0
  ? `${value[0]?.toUpperCase()}${value.slice(1)}`
  : value;

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
