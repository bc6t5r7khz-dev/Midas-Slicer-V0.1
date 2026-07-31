import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../app/lib/dxfExport.ts", import.meta.url),
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
const { createDxf, dxfCircle, dxfFaces, dxfLine, dxfPolyline } =
  module.exports;

test("creates an AutoCAD R12 DXF with section entities", () => {
  const dxf = createDxf([
    dxfLine({ x: 0, y: 0, z: 0 }, { x: 12, y: 0, z: 0 }, "CONCRETE SECTION"),
    dxfCircle({ x: 6, y: 4, z: 0 }, 0.3125, "REBAR #5"),
  ]);
  assert.match(dxf, /\$ACADVER\n1\nAC1009/);
  assert.match(dxf, /0\nLINE\n8\nCONCRETE_SECTION/);
  assert.match(dxf, /0\nCIRCLE\n8\nREBAR__5/);
  assert.match(dxf, /0\nEOF/);
});

test("creates 3D face and polyline entities", () => {
  const identity = (point) => point;
  const faces = dxfFaces(
    [{ vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }] }],
    identity,
  );
  const polyline = dxfPolyline(
    [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 }],
    "REBAR",
  );
  assert.equal(faces.length, 1);
  assert.match(faces[0], /0\n3DFACE/);
  assert.match(polyline, /0\nPOLYLINE/);
  assert.match(polyline, /70\n8/);
});
