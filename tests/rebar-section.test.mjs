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
