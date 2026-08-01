import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const cache = new Map();
const loadModule = (name) => {
  if (cache.has(name)) return cache.get(name).exports;
  const source = readFileSync(
    new URL(`../app/lib/${name}.ts`, import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  cache.set(name, module);
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: (request) => loadModule(request.replace(/^\.\//, "")),
  });
  return module.exports;
};

const {
  buildRebarScheduleWorkbookXml,
  classifyNhdotBar,
  createRebarScheduleRows,
} = loadModule("rebarSchedule");

const line = (points) => [{ id: "bar", points }];

test("treats a tiny intermediate kink as an intended straight bar", () => {
  const result = classifyNhdotBar(
    line([
      { x: 0, y: 0, z: 0 },
      { x: 5, y: 0.01, z: 0 },
      { x: 10, y: 0, z: 0 },
    ]),
    1,
    "5",
  );
  assert.equal(result.type, "");
  assert.equal(result.confidence, "Straight");
  assert.match(result.cleanup.join(" "), /collinear|straight/i);
});

test("classifies mirrored right-angle bars as N8 and maps B and C", () => {
  const result = classifyNhdotBar(
    line([
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 5, z: 0 },
    ]),
    1,
    "5",
  );
  assert.equal(result.type, "N8");
  assert.equal(result.confidence, "Confirmed");
  assert.equal(result.legDimensionsInches.B, 10);
  assert.equal(result.legDimensionsInches.C, 5);
});

test("recognizes the simplified N1 form with optional terminal legs omitted", () => {
  const result = classifyNhdotBar(
    line([
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 8, z: 0 },
      { x: 12, y: 8, z: 0 },
      { x: 12, y: 0, z: 0 },
    ]),
    1,
    "5",
  );
  assert.equal(result.type, "N1");
  assert.equal(result.confidence, "Likely");
  assert.match(result.notes.join(" "), /optional/i);
});

test("classifies the five-leg crown form as N11", () => {
  const result = classifyNhdotBar(
    line([
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
      { x: 8, y: 4, z: 0 },
      { x: 16, y: 4, z: 0 },
      { x: 20, y: 0, z: 0 },
      { x: 24, y: 0, z: 0 },
    ]),
    1,
    "6",
  );
  assert.equal(result.type, "N11");
  assert.equal(result.legDimensionsInches.C, 8);
});

test("creates a formula-driven multi-sheet hand-calculation workbook", () => {
  const run = {
    id: "run-1",
    name: "#5101E",
    barNumber: "5",
    suffix: "E",
    lines: line([
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: -5, z: 0 },
    ]),
    positions: [0, 12],
    axis: "x",
    start: 0,
    end: 12,
    spacingInches: 12,
  };
  const instances = [run.lines, run.lines];
  const rows = createRebarScheduleRows(
    [{ run, sharpInstances: instances, bentInstances: instances }],
    1,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].type, "N8");
  const workbook = buildRebarScheduleWorkbookXml(rows, "Abutment B.mct");
  assert.match(workbook, /Worksheet ss:Name="Bar Schedule"/);
  assert.match(workbook, /Worksheet ss:Name="Quantities"/);
  assert.match(workbook, /Worksheet ss:Name="Classification Review"/);
  assert.match(workbook, /ss:Formula="=ROUND\(RC\[-2\]\*RC\[-1\],0\)"/);
  assert.match(workbook, /VLOOKUP/);
  assert.match(workbook, /Reference!R3C1:R13C2/);
  assert.match(workbook, /#5101E/);
  assert.match(workbook, />N8</);
});
