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
const {
  createDxf,
  dxfCircle,
  dxfFaces,
  dxfLine,
  dxfPolyline,
  dxfRebarSolids,
  dxfText,
} =
  module.exports;

test("creates an AutoCAD R12 DXF with section entities", () => {
  const dxf = createDxf([
    dxfLine({ x: 0, y: 0, z: 0 }, { x: 12, y: 0, z: 0 }, "CONCRETE SECTION"),
    dxfCircle({ x: 6, y: 4, z: 0 }, 0.3125, "REBAR #5"),
    dxfText({ x: 2, y: 3, z: 0 }, "#5101E @ 12\"", 1.25, "ANNOTATIONS"),
  ]);
  assert.match(dxf, /\$ACADVER\n1\nAC1009/);
  assert.match(dxf, /0\nLINE\n8\nCONCRETE_SECTION/);
  assert.match(dxf, /0\nCIRCLE\n8\nREBAR__5/);
  assert.match(dxf, /0\nTEXT\n8\nANNOTATIONS/);
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

test("exports 3D rebar as true-diameter tube faces", () => {
  const faces = dxfRebarSolids(
    [[{ id: "bar", points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }] }]],
    (point) => point,
    1,
    "REBAR_5",
    8,
  );
  assert.equal(faces.length, 24);
  assert.ok(faces.every((entity) => /0\n3DFACE\n8\nREBAR_5/.test(entity)));
  assert.match(faces.join(""), /20\n0\.5/);
});
