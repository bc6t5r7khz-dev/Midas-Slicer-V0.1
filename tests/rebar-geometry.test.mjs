import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadRebarGeometry() {
  const source = await readFile(
    new URL("../app/lib/rebarGeometry.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  Function("exports", "module", compiled)(module.exports, module);
  return module.exports;
}

function hollowBoxModel() {
  const nodes = [];
  const elements = [];
  let nextNodeId = 1;
  const addBox = (x0, x1, y0, y1) => {
    const corners = [
      [x0, y0, 0],
      [x1, y0, 0],
      [x1, y1, 0],
      [x0, y1, 0],
      [x0, y0, 1],
      [x1, y0, 1],
      [x1, y1, 1],
      [x0, y1, 1],
    ];
    const nodeIds = corners.map(([x, y, z]) => {
      const id = nextNodeId++;
      nodes.push({ id, global: { x, y, z }, local: null });
      return id;
    });
    elements.push({
      id: elements.length + 1,
      type: "SOLID",
      nodeIds,
    });
  };
  const coordinates = [-5, -2, 2, 5];
  for (let xIndex = 0; xIndex < 3; xIndex += 1) {
    for (let yIndex = 0; yIndex < 3; yIndex += 1) {
      if (xIndex === 1 && yIndex === 1) continue;
      addBox(
        coordinates[xIndex],
        coordinates[xIndex + 1],
        coordinates[yIndex],
        coordinates[yIndex + 1],
      );
    }
  }
  return { nodes, elements };
}

test("keeps outer and hollow-face cover guides inside concrete", async () => {
  const { createPlaneCoverOutlines } = await loadRebarGeometry();
  const { nodes, elements } = hollowBoxModel();
  const outlines = createPlaneCoverOutlines(
    nodes,
    elements,
    { x: 0, y: 0, z: 0.5 },
    { x: 0, y: 0, z: 1 },
    1,
  );

  assert.equal(outlines.length, 2);
  for (const outline of outlines) {
    for (const point of outline) {
      const insideOuter = Math.abs(point.x) <= 5 && Math.abs(point.y) <= 5;
      const outsideHole = Math.abs(point.x) >= 2 || Math.abs(point.y) >= 2;
      assert.ok(
        insideOuter && outsideHole,
        `guide point (${point.x}, ${point.y}) must remain in concrete`,
      );
    }
  }
});

test("bevels concave cover corners without crossing into the void", async () => {
  const { createPlaneCoverOutlines } = await loadRebarGeometry();
  const nodes = [];
  const elements = [];
  let nextNodeId = 1;
  const addBox = (x0, x1, y0, y1) => {
    const nodeIds = [
      [x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0],
      [x0, y0, 1], [x1, y0, 1], [x1, y1, 1], [x0, y1, 1],
    ].map(([x, y, z]) => {
      const id = nextNodeId++;
      nodes.push({ id, global: { x, y, z }, local: null });
      return id;
    });
    elements.push({ id: elements.length + 1, type: "SOLID", nodeIds });
  };
  addBox(0, 2, 0, 2);
  addBox(2, 4, 0, 2);
  addBox(0, 2, 2, 4);

  const [outline] = createPlaneCoverOutlines(
    nodes,
    elements,
    { x: 0, y: 0, z: 0.5 },
    { x: 0, y: 0, z: 1 },
    0.5,
  );
  assert.ok(outline.length >= 7, "the re-entrant corner should be beveled");
  for (const point of outline) {
    const inHorizontalLeg =
      point.x >= 0 && point.x <= 4 && point.y >= 0 && point.y <= 2;
    const inVerticalLeg =
      point.x >= 0 && point.x <= 2 && point.y >= 2 && point.y <= 4;
    assert.ok(
      inHorizontalLeg || inVerticalLeg,
      `concave guide point (${point.x}, ${point.y}) must remain in concrete`,
    );
  }
});
