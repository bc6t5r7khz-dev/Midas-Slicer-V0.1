import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../app/lib/rebarSection.ts", import.meta.url),
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
const { sectionRebarGeometry } = module.exports;

const origin = { x: 0, y: 0, z: 0 };
const normal = { x: 0, y: 0, z: 1 };

test("draws a bar crossing the cut as a section circle", () => {
  const result = sectionRebarGeometry(
    [{ id: "crossing", points: [{ x: 2, y: 3, z: -5 }, { x: 2, y: 3, z: 5 }] }],
    origin,
    normal,
    12,
  );
  assert.equal(result.circles.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.circles[0].center)),
    { x: 2, y: 3, z: 0 },
  );
  assert.equal(result.projectedLines.length, 0);
});

test("shows an oblique crossing as one dot instead of a projected dash", () => {
  const result = sectionRebarGeometry(
    [
      { id: "oblique-a", points: [{ x: -4, y: 1, z: -5 }, { x: 4, y: 1, z: 5 }] },
      { id: "oblique-b", points: [{ x: 4, y: 1, z: 5 }, { x: -4, y: 1, z: -5 }] },
    ],
    origin,
    normal,
    12,
  );
  assert.equal(result.circles.length, 1);
  assert.equal(result.projectedLines.length, 0);
});

test("shows an in-depth bar aimed into the page as a section dot", () => {
  const result = sectionRebarGeometry(
    [
      {
        id: "behind-cut",
        points: [{ x: 2, y: 3, z: -2 }, { x: 5, y: 3, z: -10 }],
      },
    ],
    origin,
    normal,
    12,
  );
  assert.equal(result.circles.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.circles[0].center)),
    { x: 2, y: 3, z: 0 },
  );
  assert.equal(result.projectedLines.length, 0);
});

test("projects in-depth bars and hides bars beyond the throw depth", () => {
  const result = sectionRebarGeometry(
    [
      { id: "inside", points: [{ x: 0, y: 0, z: -6 }, { x: 10, y: 0, z: -6 }] },
      { id: "outside", points: [{ x: 0, y: 4, z: -13 }, { x: 10, y: 4, z: -13 }] },
    ],
    origin,
    normal,
    12,
  );
  assert.equal(result.projectedLines.length, 1);
  assert.equal(result.projectedLines[0].start.z, 0);
  assert.equal(result.projectedLines[0].end.z, 0);
});

test("projects a complete mixed elevation bar with dots at depth transitions", () => {
  const result = sectionRebarGeometry(
    [
      {
        id: "mixed-elevation",
        points: [
          { x: 0, y: 10, z: -5 },
          { x: 0, y: 10, z: 5 },
          { x: 0, y: 0, z: 5 },
          { x: 0, y: -10, z: 20 },
        ],
      },
    ],
    origin,
    normal,
    2,
  );

  assert.equal(result.mixed, true);
  assert.equal(result.circles.length, 2);
  assert.equal(result.projectedLines.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.circles.map(({ center }) => center))),
    [
      { x: 0, y: 10, z: 0 },
      { x: 0, y: 0, z: 0 },
    ],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.projectedLines[1].end)),
    { x: 0, y: -10, z: 0 },
  );
});

test("suppresses a depth leg whose visible slant is within ten degrees of horizontal", () => {
  const result = sectionRebarGeometry(
    [
      {
        id: "nearly-horizontal-depth-leg",
        points: [
          { x: 0, y: 10, z: -5 },
          { x: 0, y: 10, z: 5 },
          { x: 0, y: 0, z: 5 },
          { x: 10, y: -1, z: 20 },
        ],
      },
    ],
    origin,
    normal,
    2,
  );

  assert.equal(result.mixed, true);
  assert.equal(result.circles.length, 2);
  assert.equal(result.projectedLines.length, 1);
});

test("does not draw a mixed bar wholly in front of the selected section", () => {
  const result = sectionRebarGeometry(
    [
      {
        id: "unrelated-front-bar",
        points: [
          { x: 0, y: 10, z: 50 },
          { x: 0, y: 10, z: 60 },
          { x: 0, y: 0, z: 60 },
          { x: 0, y: -10, z: 75 },
        ],
      },
    ],
    origin,
    normal,
    12,
  );

  assert.equal(result.mixed, false);
  assert.equal(result.circles.length, 0);
  assert.equal(result.projectedLines.length, 0);
});

test("does not project a planar bar from the front side of a horizontal cut", () => {
  const result = sectionRebarGeometry(
    [
      {
        id: "above-horizontal-cut",
        points: [
          { x: 0, y: 0, z: 5 },
          { x: 10, y: 0, z: 5 },
        ],
      },
    ],
    origin,
    normal,
    12,
  );

  assert.equal(result.circles.length, 0);
  assert.equal(result.projectedLines.length, 0);
});

test("keeps only the longer of overlapping elevation legs", () => {
  const result = sectionRebarGeometry(
    [
      {
        id: "side-on-u-bar",
        points: [
          { x: 0, y: 10, z: -5 },
          { x: 0, y: -10, z: -5 },
          { x: 0, y: -10, z: 5 },
          { x: 0, y: 8, z: 5 },
        ],
      },
    ],
    origin,
    normal,
    12,
  );

  assert.equal(result.mixed, true);
  assert.equal(result.projectedLines.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.projectedLines[0])),
    {
      start: { x: 0, y: 10, z: 0 },
      end: { x: 0, y: -10, z: 0 },
    },
  );
});
