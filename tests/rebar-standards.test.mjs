import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../app/lib/rebarStandards.ts", import.meta.url),
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
  applyStandardBarBends,
  rebarBendStandard,
} = module.exports;

test("uses ASTM nominal diameters and CRSI standard-hook bend multipliers", () => {
  assert.equal(
    JSON.stringify(rebarBendStandard("5")),
    JSON.stringify({
      barNumber: "5",
      diameterInches: 0.625,
      minimumInsideBendDiameterInches: 3.75,
      minimumCenterlineRadiusInches: 2.1875,
      bendDiameterMultiplier: 6,
    }),
  );
  assert.equal(rebarBendStandard("#9").bendDiameterMultiplier, 8);
  assert.equal(rebarBendStandard("14").bendDiameterMultiplier, 10);
  assert.equal(rebarBendStandard("10").diameterInches, 1.27);
});

test("rounds a 90-degree corner at the minimum centerline radius", () => {
  const rounded = applyStandardBarBends(
    {
      id: "corner",
      points: [
        { x: -10, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 10, z: 0 },
      ],
    },
    "5",
    1,
  );
  assert.ok(rounded.points.length > 5);
  assert.ok(Math.abs(rounded.points[1].x + 2.1875) < 1e-9);
  assert.ok(Math.abs(rounded.points.at(-2).y - 2.1875) < 1e-9);
});

test("does not silently create a tighter bend when legs are too short", () => {
  const line = {
    id: "short",
    points: [
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    ],
  };
  assert.equal(
    JSON.stringify(applyStandardBarBends(line, "5", 1)),
    JSON.stringify(line),
  );
});
