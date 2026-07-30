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
  splayArcLengthAtMidpoint,
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

test("splay rotates the last X bars onto the target plane around the plane intersection", () => {
  const run = {
    ...baseRun,
    advanced: {
      splay: { targetPlaneId: "target", scope: "last", count: 1 },
    },
  };
  const instances = generateRebarInstances(run, {
    sourceNormal: { x: 0, y: 0, z: 1 },
    sourceOrigin: { x: 0, y: 0, z: 0 },
    targetNormal: { x: 1, y: 0, z: 1 },
    targetOrigin: { x: 0, y: 0, z: 7 },
  });
  assert.equal(instances.length, 3);
  assert.equal(JSON.stringify(instances[0][0].points[1]), '{"x":1,"y":0,"z":0}');
  assert.equal(JSON.stringify(instances[1][0].points[1]), '{"x":1,"y":5,"z":0}');
  for (const point of instances[2][0].points) {
    assert.ok(Math.abs(point.x + point.z - 7) < 1e-9);
    assert.ok(Math.abs(point.y - 10) < 1e-9);
  }
});

test("splay spacing is measured on the circular arc at the bar midpoint", () => {
  const layout = splayArcLengthAtMidpoint(
    baseRun.lines,
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 1 },
    { x: 0, y: 0, z: 7 },
  );
  assert.ok(layout);
  assert.ok(Math.abs(layout.angle - Math.PI / 4) < 1e-9);
  assert.ok(Math.abs(layout.radius - 6.5) < 1e-9);
  assert.ok(Math.abs(layout.arcLength - (6.5 * Math.PI) / 4) < 1e-9);
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
