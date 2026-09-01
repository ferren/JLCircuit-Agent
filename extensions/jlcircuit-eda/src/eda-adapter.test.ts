import assert from "node:assert/strict";
import test from "node:test";
import { JlcEdaAdapter, type JlcEdaApi } from "./eda-adapter.ts";

type Line = Array<number> | Array<Array<number>>;

const cloneLine = (line: Line): Line => JSON.parse(JSON.stringify(line)) as Line;

const createFixture = (options: {
  failCreateAt?: number;
  hideCreatedFromReads?: boolean;
  deferCreatedState?: boolean;
  omitCreatedId?: boolean;
} = {}) => {
  const componentState = { x: 10, y: 10 };
  const pinOffsets = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
  const component = {
    getState_PrimitiveId: async () => "U1",
    getState_X: async () => componentState.x,
    getState_Y: async () => componentState.y,
  };
  const componentApi = {
    get: async (id: string) => id === "U1" ? component : undefined,
    getAll: async () => [component],
    getAllPinsByPrimitiveId: async () => pinOffsets.map((offset) => ({
      getState_X: async () => componentState.x + offset.x,
      getState_Y: async () => componentState.y + offset.y,
    })),
    modify: async (_id: string, property: { x?: number; y?: number }) => {
      if (property.x !== undefined) componentState.x = property.x;
      if (property.y !== undefined) componentState.y = property.y;
      return component;
    },
  };
  const originalLines: Record<string, Line> = {
    W1: [[10, 10, 5, 10, 0, 10], [20, 10, 25, 10]],
    W2: [10, 10, 10, 5],
  };
  const lines: Record<string, Line> = Object.fromEntries(
    Object.entries(originalLines).map(([id, line]) => [id, cloneLine(line)]),
  );
  const wire = (id: string) => ({
    getState_PrimitiveId: async () => id,
    getState_Line: async () => cloneLine(lines[id]),
    getState_Net: async () => "NET",
  });
  let createCalls = 0;
  const wireApi = {
    get: async (id: string) => id in lines && !(options.hideCreatedFromReads && id.startsWith("B")) ? wire(id) : undefined,
    getAll: async () => Object.keys(lines)
      .filter((id) => !(options.hideCreatedFromReads && id.startsWith("B")))
      .map(wire),
    create: async (line: Line) => {
      createCalls += 1;
      if (createCalls === options.failCreateAt) throw new Error(`simulated create failure: ${createCalls}`);
      const id = `B${createCalls}`;
      lines[id] = cloneLine(line);
      return options.omitCreatedId ? {} : options.deferCreatedState ? {
        getState_PrimitiveId: async () => id,
      } : wire(id);
    },
    delete: async (id: string) => {
      if (!(id in lines)) return false;
      delete lines[id];
      return true;
    },
  };
  const api = {
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ id: "sheet-1", documentType: 1 }) },
    sch_PrimitiveComponent: componentApi,
    sch_PrimitiveWire: wireApi,
  } as unknown as JlcEdaApi;
  return { adapter: new JlcEdaAdapter(api), componentState, lines, originalLines };
};

test("component move preserves existing wires and creates orthogonal bridge wires", async () => {
  const fixture = createFixture();
  const result = await fixture.adapter.callTool("easyeda_schematic_move_component", {
    confirmWrite: true,
    primitiveId: "U1",
    x: 30,
    y: 40,
    preserveConnections: true,
    verifyVisual: false,
  });

  assert.deepEqual(fixture.componentState, { x: 30, y: 40 });
  assert.deepEqual(fixture.lines.W1, fixture.originalLines.W1);
  assert.deepEqual(fixture.lines.W2, fixture.originalLines.W2);
  assert.deepEqual(fixture.lines.B1, [10, 10, 30, 10, 30, 40]);
  assert.deepEqual(fixture.lines.B2, [20, 10, 40, 10, 40, 40]);
  assert.deepEqual((result.data as { createdWireIds: string[] }).createdWireIds, ["B1", "B2"]);
  assert.deepEqual((result.data as { movedWireIds: string[] }).movedWireIds, ["B1", "B2"]);
  assert.equal((result.data as { connectionCheck: string }).connectionCheck, "passed");
});

test("schematic component reads support scoped primitive queries without raw payloads", async () => {
  const fixture = createFixture();
  const result = await fixture.adapter.callTool("easyeda_schematic_components", {
    primitiveId: "U1",
    limit: 10,
  });
  const data = result.data as {
    matched: number;
    returned: number;
    components: Array<{ primitiveId: string; raw?: unknown }>;
  };
  assert.equal(data.matched, 1);
  assert.equal(data.returned, 1);
  assert.equal(data.components[0]?.primitiveId, "U1");
  assert.equal("raw" in (data.components[0] ?? {}), false);
});

test("component move accepts an asynchronously refreshed create result", async () => {
  const fixture = createFixture({ deferCreatedState: true });
  const result = await fixture.adapter.callTool("easyeda_schematic_move_component", {
    confirmWrite: true,
    primitiveId: "U1",
    x: 30,
    y: 40,
    preserveConnections: true,
    verifyVisual: false,
  });

  assert.deepEqual((result.data as { createdWireIds: string[] }).createdWireIds, ["B1", "B2"]);
  assert.equal((result.data as { connectionCheck: string }).connectionCheck, "passed");
});

test("component move discovers a bridge ID from the persisted read model when create omits it", async () => {
  const fixture = createFixture({ omitCreatedId: true });
  const result = await fixture.adapter.callTool("easyeda_schematic_move_component", {
    confirmWrite: true,
    primitiveId: "U1",
    x: 30,
    y: 40,
    preserveConnections: true,
    verifyVisual: false,
  });

  assert.deepEqual((result.data as { createdWireIds: string[] }).createdWireIds, ["B1", "B2"]);
  assert.equal((result.data as { connectionCheck: string }).connectionCheck, "passed");
});

test("component move keeps acknowledged bridges when neither create nor reads expose an ID", async () => {
  const fixture = createFixture({ omitCreatedId: true, hideCreatedFromReads: true });
  const result = await fixture.adapter.callTool("easyeda_schematic_move_component", {
    confirmWrite: true,
    primitiveId: "U1",
    x: 30,
    y: 40,
    preserveConnections: true,
    verifyVisual: false,
  });

  assert.deepEqual(fixture.componentState, { x: 30, y: 40 });
  assert.deepEqual((result.data as { createdWireIds: string[] }).createdWireIds, []);
  assert.deepEqual((result.data as { unresolvedWireIds: string[] }).unresolvedWireIds, [
    "unresolved-pin@(30,40)",
    "unresolved-pin@(40,40)",
  ]);
  assert.equal((result.data as { connectionCheck: string }).connectionCheck, "inconclusive");
});

test("component move deletes bridge wires and rolls back the component when creation fails", async () => {
  const fixture = createFixture({ failCreateAt: 2 });
  await assert.rejects(
    fixture.adapter.callTool("easyeda_schematic_move_component", {
      confirmWrite: true,
      primitiveId: "U1",
      x: 30,
      y: 40,
      preserveConnections: true,
      verifyVisual: false,
    }),
    /rolled back/,
  );

  assert.deepEqual(fixture.componentState, { x: 10, y: 10 });
  assert.deepEqual(fixture.lines.W1, fixture.originalLines.W1);
  assert.deepEqual(fixture.lines.W2, fixture.originalLines.W2);
  assert.equal("B1" in fixture.lines, false);
});

test("component move remains applied when the EDA read model has not exposed acknowledged bridge wires yet", async () => {
  const fixture = createFixture({ hideCreatedFromReads: true });
  const result = await fixture.adapter.callTool("easyeda_schematic_move_component", {
    confirmWrite: true,
    primitiveId: "U1",
    x: 30,
    y: 40,
    preserveConnections: true,
    verifyVisual: false,
  });

  assert.deepEqual(fixture.componentState, { x: 30, y: 40 });
  assert.deepEqual((result.data as { unresolvedWireIds: string[] }).unresolvedWireIds, ["B1", "B2"]);
  assert.equal((result.data as { connectionCheck: string }).connectionCheck, "inconclusive");
});

test("component move is refused before mutation when no wire endpoint matches a pin", async () => {
  const fixture = createFixture();
  fixture.lines.W1 = [[100, 100, 105, 100]];
  fixture.lines.W2 = [110, 100, 110, 105];

  await assert.rejects(
    fixture.adapter.callTool("easyeda_schematic_move_component", {
      confirmWrite: true,
      primitiveId: "U1",
      x: 30,
      y: 40,
      preserveConnections: true,
      verifyVisual: false,
    }),
    /no wire endpoints matched/,
  );

  assert.deepEqual(fixture.componentState, { x: 10, y: 10 });
  assert.deepEqual(fixture.lines.W1, [[100, 100, 105, 100]]);
  assert.deepEqual(fixture.lines.W2, [110, 100, 110, 105]);
});

test("schematic create tools call the official primitive APIs with validated arguments", async () => {
  const calls = new Map<string, unknown[]>();
  const primitiveApi = (name: string) => {
    const primitives: unknown[] = [];
    return {
      getAll: async () => primitives,
      create: async (...args: unknown[]) => {
        calls.set(name, args);
        const primitive = { getState_PrimitiveId: async () => `${name}-1` };
        primitives.push(primitive);
        return primitive;
      },
    };
  };
  const adapter = new JlcEdaAdapter({
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ id: "sheet-1", documentType: 1 }) },
    sch_PrimitiveComponent: primitiveApi("component"),
    sch_PrimitiveWire: primitiveApi("wire"),
    sch_PrimitiveBus: primitiveApi("bus"),
    sch_PrimitiveRectangle: primitiveApi("rectangle"),
    sch_PrimitivePolygon: primitiveApi("polygon"),
    sch_PrimitiveText: primitiveApi("text"),
  });

  const component = await adapter.callTool("easyeda_schematic_place_component", {
    confirmWrite: true,
    libraryUuid: "library-1",
    uuid: "device-1",
    x: 100,
    y: 200,
    rotation: 90,
  });
  await adapter.callTool("easyeda_schematic_create_wire", {
    confirmWrite: true,
    line: [0, 0, 10, 0, 10, 10],
    net: "VCC",
  });
  await adapter.callTool("easyeda_schematic_create_bus", {
    confirmWrite: true,
    busName: "DATA[0..7]",
    line: [[0, 20, 30, 20]],
  });
  await adapter.callTool("easyeda_schematic_create_rectangle", {
    confirmWrite: true,
    topLeftX: 5,
    topLeftY: 6,
    width: 100,
    height: 50,
  });
  await adapter.callTool("easyeda_schematic_create_polygon", {
    confirmWrite: true,
    line: [0, 0, 20, 0, 10, 10],
  });
  await adapter.callTool("easyeda_schematic_create_text", {
    confirmWrite: true,
    x: 8,
    y: 9,
    content: "Power",
    fontSize: 12,
  });

  assert.deepEqual(calls.get("component")?.slice(0, 5), [
    { libraryUuid: "library-1", uuid: "device-1" }, 100, 200, undefined, 90,
  ]);
  assert.deepEqual(calls.get("wire")?.slice(0, 2), [[0, 0, 10, 0, 10, 10], "VCC"]);
  assert.deepEqual(calls.get("bus")?.slice(0, 2), ["DATA[0..7]", [[0, 20, 30, 20]]]);
  assert.deepEqual(calls.get("rectangle")?.slice(0, 6), [5, 6, 100, 50, 0, 0]);
  assert.deepEqual(calls.get("polygon")?.[0], [0, 0, 20, 0, 10, 10]);
  assert.deepEqual(calls.get("text")?.slice(0, 7), [8, 9, "Power", 0, undefined, undefined, 12]);
  assert.equal((component.data as { primitiveId?: string }).primitiveId, "component-1");
  assert.equal((component.data as { readbackStatus: string }).readbackStatus, "verified");
});

test("schematic create tools reject unconfirmed writes and invalid geometry before calling EDA", async () => {
  let createCalls = 0;
  const adapter = new JlcEdaAdapter({
    dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ id: "sheet-1", documentType: 1 }) },
    sch_PrimitiveRectangle: {
      getAll: async () => [],
      create: async () => {
        createCalls += 1;
        return { getState_PrimitiveId: async () => "R1" };
      },
    },
  });

  await assert.rejects(
    adapter.callTool("easyeda_schematic_create_rectangle", {
      topLeftX: 0,
      topLeftY: 0,
      width: 10,
      height: 10,
    }),
    /confirmWrite=true/,
  );
  await assert.rejects(
    adapter.callTool("easyeda_schematic_create_rectangle", {
      confirmWrite: true,
      topLeftX: 0,
      topLeftY: 0,
      width: 0,
      height: 10,
    }),
    /greater than zero/,
  );
  assert.equal(createCalls, 0);
});

test("device library search returns placement-safe UUID pairs and compact associations", async () => {
  const searchCalls: unknown[][] = [];
  const adapter = new JlcEdaAdapter({
    lib_Device: {
      search: async (...args: unknown[]) => {
        searchCalls.push(args);
        return [{
          uuid: "device-10k",
          libraryUuid: "system-library",
          name: "R_10K_0603",
          description: "10k resistor",
          symbol: { name: "R", uuid: "symbol-r", libraryUuid: "system-library" },
          footprint: { name: "R0603", uuid: "fp-0603", libraryUuid: "system-library" },
          otherProperty: { value: "10k", supplierId: "C25804" },
        }];
      },
    },
  });

  const result = await adapter.callTool("easyeda_library_search_devices", {
    query: "10k 0603",
    limit: 5,
    page: 2,
  });
  const data = result.data as { returned: number; devices: Array<Record<string, unknown>> };
  assert.deepEqual(searchCalls[0], ["10k 0603", undefined, undefined, undefined, 5, 2]);
  assert.equal(data.returned, 1);
  assert.deepEqual(data.devices[0], {
    uuid: "device-10k",
    libraryUuid: "system-library",
    name: "R_10K_0603",
    description: "10k resistor",
    classification: undefined,
    symbol: { name: "R", uuid: "symbol-r", libraryUuid: "system-library" },
    footprint: { name: "R0603", uuid: "fp-0603", libraryUuid: "system-library" },
    otherProperty: { value: "10k", supplierId: "C25804" },
  });
});

test("device library search supports exact LCSC identifiers", async () => {
  const lcscCalls: unknown[][] = [];
  const adapter = new JlcEdaAdapter({
    lib_Device: {
      getByLcscIds: async (...args: unknown[]) => {
        lcscCalls.push(args);
        return [{ uuid: "device-c25804", libraryUuid: "system-library", name: "C25804" }];
      },
    },
  });
  const result = await adapter.callTool("easyeda_library_search_devices", { lcscIds: ["C25804"] });
  assert.deepEqual(lcscCalls[0], [["C25804"], undefined, false]);
  assert.equal((result.data as { devices: unknown[] }).devices.length, 1);
});
