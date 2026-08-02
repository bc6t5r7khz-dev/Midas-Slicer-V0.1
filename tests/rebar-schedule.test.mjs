import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

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
    require: (request) => request.startsWith("./")
      ? loadModule(request.replace(/^\.\//, ""))
      : nodeRequire(request),
  });
  return module.exports;
};

const {
  buildRebarScheduleWorkbookXlsx,
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
  assert.equal(result.type, "N1", JSON.stringify(result));
  assert.equal(result.confidence, "Likely");
  assert.match(result.notes.join(" "), /omitted/i);
});

test("recognizes an N11 when unused terminal legs collapse", () => {
  const result = classifyNhdotBar(
    line([
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
      { x: 8, y: 4, z: 0 },
      { x: 22, y: 4, z: 0 },
    ]),
    1,
    "5",
  );
  assert.equal(result.type, "N11", JSON.stringify(result));
  assert.equal(result.confidence, "Likely");
  assert.match(result.notes.join(" "), /omitted/i);
});

test("recognizes N2 using its consistent three-turn topology", () => {
  const result = classifyNhdotBar(
    line([
      { x: 0, y: 0, z: 0 },
      { x: 8, y: 0, z: 0 },
      { x: 8, y: 5, z: 0 },
      { x: 5, y: 5, z: 0 },
      { x: 1, y: 1, z: 0 },
    ]),
    1,
    "5",
  );
  assert.equal(result.type, "N2");
  assert.equal(result.confidence, "Confirmed");
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
      { x: 10, y: -5.49, z: 0 },
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
  assert.equal(rows[0].lengthFeet, 1.25, "individual length rounds to 15 inches");
  const workbook = buildRebarScheduleWorkbookXml(rows, "Abutment B.mct");
  assert.match(workbook, /Worksheet ss:Name="Bar Schedule"/);
  assert.match(workbook, /Worksheet ss:Name="Quantities"/);
  assert.match(workbook, /Worksheet ss:Name="Classification Review"/);
  assert.match(workbook, /ss:Formula="=RC\[-2\]\*RC\[-1\]"/);
  assert.doesNotMatch(workbook, /ROUND\(RC\[-2\]\*RC\[-1\],0\)/);
  assert.match(
    workbook,
    /ss:Formula="=RC\[-2\]\*RC\[-1\]"><Data ss:Type="Number">2\.5<\/Data>/,
    "total length keeps the unrounded 2.5 ft result",
  );
  assert.match(workbook, />2\.6075<\/Data>/, "total weight remains unrounded");
  assert.match(workbook, /VLOOKUP/);
  assert.match(workbook, /Reference!R3C1:R13C2/);
  assert.match(workbook, /#5101E/);
  assert.match(workbook, />N8</);

  const xlsx = buildRebarScheduleWorkbookXlsx(rows, "Abutment B.mct");
  assert.equal(xlsx[0], 0x50, "xlsx begins with a ZIP signature");
  assert.equal(xlsx[1], 0x4b, "xlsx begins with a ZIP signature");
  const { unzipSync, strFromU8 } = nodeRequire("fflate");
  const files = unzipSync(xlsx);
  assert.ok(files["[Content_Types].xml"]);
  assert.ok(files["xl/workbook.xml"]);
  assert.ok(files["xl/styles.xml"]);
  assert.ok(files["xl/worksheets/sheet1.xml"]);
  assert.ok(files["xl/worksheets/sheet4.xml"]);
  assert.match(strFromU8(files["xl/workbook.xml"]), /name="Bar Schedule"/);
  assert.match(strFromU8(files["xl/worksheets/sheet2.xml"]), /<f>C4\*D4<\/f>/);
});

test("sorts marks by series number without treating bar size as the primary key", () => {
  const marks = ["#7201E", "#4104E", "#6103E", "#5102E", "#5101E"];
  const inputs = marks.map((name, index) => {
    const barNumber = name[1];
    const run = {
      id: `run-${index}`,
      name,
      barNumber,
      suffix: "E",
      lines: line([{ x: 0, y: 0, z: 0 }, { x: 12, y: 0, z: 0 }]),
      positions: [0],
      axis: "x",
      start: 0,
      end: 0,
      spacingInches: 12,
    };
    return { run, sharpInstances: [run.lines], bentInstances: [run.lines] };
  });
  assert.deepEqual(
    Array.from(createRebarScheduleRows(inputs, 1), (row) => row.mark),
    ["#5101E", "#5102E", "#6103E", "#4104E", "#7201E"],
  );
});
