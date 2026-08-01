import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../app/lib/rebarDetail.ts", import.meta.url),
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
const { offsetLappedSectionSegments } = module.exports;

test("doglegs only the overlapping portion of a lapped section bar", () => {
  const result = offsetLappedSectionSegments(
    [{ start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } }],
    [{ start: { x: 3, y: 0, z: 0 }, end: { x: 8, y: 0, z: 0 } }],
    { x: 0, y: 0, z: 1 },
    { x: 5, y: 5, z: 0 },
    1,
    1e-6,
  );
  assert.equal(result.segments.length, 5);
  assert.equal(result.lapDimensions.length, 1);
  assert.equal(result.lapDimensions[0].lengthModelUnits, 5);
  assert.equal(result.lapDimensions[0].start.y, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.segments[0])),
    { start: { x: 0, y: 0, z: 0 }, end: { x: 3, y: 0, z: 0 } },
  );
});

test("leaves a non-overlapping lapped segment on its true centerline", () => {
  const original = {
    start: { x: 0, y: 0, z: 0 },
    end: { x: 10, y: 0, z: 0 },
  };
  const result = offsetLappedSectionSegments(
    [original],
    [{ start: { x: 0, y: 3, z: 0 }, end: { x: 10, y: 3, z: 0 } }],
    { x: 0, y: 0, z: 1 },
    { x: 5, y: 5, z: 0 },
    1,
    1e-6,
  );
  assert.equal(result.lapDimensions.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.segments)), [original]);
});
