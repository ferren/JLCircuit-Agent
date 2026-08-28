import assert from "node:assert/strict";
import test from "node:test";
import { JlcEdaAdapter, type JlcEdaApi } from "./eda-adapter.ts";

type Line = Array<number> | Array<Array<number>>;

const cloneLine = (line: Line): Line => JSON.parse(JSON.stringify(line)) as Line;

const createFixture = (options: { failCreateAt?: number; hideCreatedFromReads?: boolean } = {}) => {
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
      return wire(id);
    },
    delete: async (id: string) => {
      if (!(id in lines)) return false;
      delete lines[id];
      return true;
    },
  };
  const api = {
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
