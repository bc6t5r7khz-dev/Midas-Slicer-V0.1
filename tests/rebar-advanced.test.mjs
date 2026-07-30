import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../app/lib/rebarAdvanced.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, {
  module,
  exports: module.exports,
  require: () => ({}),
});
const {
  generateRebarInstances,
  rebarInstanceLength,
} = module.exports;

const baseRun = {
  id: "run",
  name: "Run",
  lines: [{ id: "line", points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] }],
  start: 0,
  end: 10,
  spacing: 5,
  positions: [0, 5, 10],
  pathPoints: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 0 }],
  axis: "Y",
  quantity: 3,
  nominalSpacing: 5,
  color: "#f00",
  barNumber: "5",
  planeId: "source",
};

test("splay keeps the selected anchor on its path while rotating bars into a fan", () => {
  const run = {
    ...baseRun,
    pathPoints: [
      { x: 0, y: 0, z: 0 },
      { x: 6, y: 8, z: 0 },
    ],
    advanced: {
      splay: { targetPlaneId: "target", scope: "all" },
    },
  };
  const instances = generateRebarInstances(run, {
    sourceNormal: { x: 0, y: 0, z: 1 },
    sourceOrigin: { x: 0, y: 0, z: 0 },
    targetNormal: { x: 1, y: 0, z: 1 },
    targetOrigin: { x: 0, y: 0, z: 6 },
  });
  assert.equal(instances.length, 3);
  assert.equal(
    JSON.stringify(instances.map((instance) => instance[0].points[0])),
    JSON.stringify(
    [
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 4, z: 0 },
      { x: 6, y: 8, z: 0 },
    ],
    ),
  );
  assert.notEqual(
    JSON.stringify(instances[1][0].points[1]),
    JSON.stringify({ x: 4, y: 4, z: 0 }),
  );
  for (const point of instances[2][0].points) {
    assert.ok(Math.abs(point.x + point.z - 6) < 1e-9);
  }
});

test("splay anchors follow every segment of a multipoint path", () => {
  const finalDistance = 5 + Math.hypot(6, 3);
  const run = {
    ...baseRun,
    positions: [0, 5, finalDistance],
    pathPoints: [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 5, z: 0 },
      { x: 6, y: 8, z: 0 },
    ],
    advanced: {
      splay: { targetPlaneId: "target", scope: "all" },
    },
  };
  const instances = generateRebarInstances(run, {
    sourceNormal: { x: 0, y: 0, z: 1 },
    sourceOrigin: { x: 0, y: 0, z: 0 },
    targetNormal: { x: 1, y: 0, z: 1 },
    targetOrigin: { x: 0, y: 0, z: 6 },
  });
  assert.equal(
    JSON.stringify(instances.map((instance) => instance[0].points[0])),
    JSON.stringify(
    [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 5, z: 0 },
      { x: 6, y: 8, z: 0 },
    ],
    ),
  );
});

test("opposite target normal uses the equivalent short fan angle", () => {
  const run = {
    ...baseRun,
    pathPoints: [
      { x: 0, y: 0, z: 0 },
      { x: 6, y: 8, z: 0 },
    ],
    advanced: {
      splay: { targetPlaneId: "target", scope: "all" },
    },
  };
  const instances = generateRebarInstances(run, {
    sourceNormal: { x: 0, y: 0, z: 1 },
    sourceOrigin: { x: 0, y: 0, z: 0 },
    targetNormal: { x: -1, y: 0, z: -1 },
    targetOrigin: { x: 0, y: 0, z: 6 },
  });
  const anchor = instances.at(-1)[0].points[0];
  const endpoint = instances.at(-1)[0].points[1];
  assert.ok(endpoint.x > anchor.x);
  assert.ok(endpoint.z < anchor.z);
  assert.ok(Math.abs(endpoint.x + endpoint.z - 6) < 1e-9);
});

test("endpoint anchors interpolate bar length along a run", () => {
  const run = {
    ...baseRun,
    advanced: {
      variableLength: {
        endpointAnchors: [
          { id: "start", fraction: 0, point: { x: 1, y: 0, z: 0 } },
          { id: "end", fraction: 1, point: { x: 3, y: 10, z: 0 } },
        ],
      },
    },
  };
  const instances = generateRebarInstances(run);
  assert.equal(
    JSON.stringify(instances.map((instance) => instance[0].points.at(-1))),
    JSON.stringify([
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 5, z: 0 },
      { x: 3, y: 10, z: 0 },
    ]),
  );
  assert.equal(JSON.stringify(instances.map(rebarInstanceLength)), "[1,2,3]");
});
