import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the MCT Section Lab application", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>MCT Section Lab<\/title>/i);
  assert.match(html, />Setup</);
  assert.match(html, />Import</);
  assert.match(html, /Define Floor Plane/);
  assert.match(html, /Define X Axis/);
  assert.match(html, /Define Scale/);
  assert.match(html, /Slicing/);
  assert.match(html, /Rebar/);
  assert.match(html, /Application menus/);
  assert.match(html, />File</);
  assert.doesNotMatch(html, /codex-preview/i);
});

test("includes plane-based rebar and quantity export workflows", async () => {
  const [viewer, styles, types, storage] = await Promise.all([
    readFile(
      new URL("../app/components/ModelViewer.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/workspaceStorage.ts", import.meta.url), "utf8"),
  ]);
  assert.match(viewer, /Add Plane/);
  assert.match(viewer, /Delete Plane/);
  assert.match(viewer, /Add Group/);
  assert.match(viewer, /Primary perimeter offset/);
  assert.match(viewer, /Import Project/);
  assert.match(viewer, /Export Project/);
  assert.match(viewer, /Export Active Section DXF/);
  assert.match(viewer, /Export 3D Model DXF/);
  assert.match(viewer, /Reinforcing section throw depth/);
  assert.match(viewer, /Lap snap distance from each source-bar end/);
  assert.match(viewer, /Round a new bar segment to whole inches/);
  assert.match(viewer, /Shift \+ arrows/);
  assert.match(viewer, /Show all Planes/);
  assert.match(viewer, /saved-view-ribbon/);
  assert.match(viewer, /combined-slicing/);
  assert.match(viewer, /title=\{`\$\{run\.positions\.length\} bars/);
  assert.match(viewer, /danger-outline bar-run-delete/);
  assert.doesNotMatch(viewer, /Create or review reinforcement runs/);
  assert.doesNotMatch(viewer, /LOCAL PROCESSING/);
  assert.doesNotMatch(viewer, /Three\.js · browser only/);
  assert.doesNotMatch(viewer, /Smart Select 1/);
  assert.doesNotMatch(viewer, /Smart Select 2/);
  assert.doesNotMatch(viewer, /Smart Select 3/);
  assert.doesNotMatch(viewer, /Auto-Define/);
  assert.doesNotMatch(viewer, /MCT ELEMENT SKIN/);
  assert.doesNotMatch(viewer, /SELECTED NODE/);
  assert.doesNotMatch(viewer, /restored from this browser/);
  assert.match(viewer, /showAxes=\{activeTab === "setup"\}/);
  assert.match(
    viewer,
    /\{activeTab === "setup" && \(\s*<div className="axis-badge"/,
  );
  assert.equal(
    [...viewer.matchAll(/setRenamingRebarPlaneId\(plane\.id\)/g)].length,
    1,
    "plane renaming should only be available in Slicing → Planes",
  );
  assert.match(viewer, /auto-top-horizontal/);
  assert.match(viewer, /Export Bar Quantity/);
  assert.match(viewer, /event\.key === "Escape"/);
  assert.match(viewer, /mct-section-lab-project/);
  assert.match(viewer, /Display Rebar/);
  assert.doesNotMatch(viewer, /PINNED SLICES/);
  assert.match(viewer, /Save as View/);
  assert.match(viewer, /Flip Section/);
  assert.match(viewer, /Volume Definition/);
  assert.match(viewer, /Auto Volume/);
  assert.match(viewer, /Create Volume/);
  assert.match(viewer, /Smart Face/);
  assert.match(viewer, /selectedSlicePinIds/);
  assert.match(viewer, /coordinateStep/);
  assert.match(viewer, /favoriteRebarPlaneIds/);
  assert.match(viewer, /Add another keypoint/);
  assert.match(viewer, /rebarPathPoints/);
  assert.match(viewer, /delete-empty-group/);
  assert.match(viewer, /Start Section OK/);
  assert.match(viewer, /Rebar Shape OK/);
  assert.match(viewer, /Choose Other Plane/);
  assert.match(viewer, /Splay target/);
  assert.match(viewer, /Bar mark series/);
  assert.match(viewer, /BAR SPACING/);
  assert.match(viewer, /CRSI Standard Bar Bends/);
  assert.match(viewer, /draftRebarBarNumber=\{rebarBarNumber\}/);
  assert.match(viewer, /Bar OK/);
  assert.match(viewer, /slicing-list-title">Planes</);
  assert.match(viewer, /setSelectedRebarRunIds\(new Set\(\)\)/);
  assert.match(viewer, /activeTab === "rebar"[\s\S]*tab\.id !== "rebar"/);
  assert.match(viewer, /bar-run-footer/);
  assert.match(styles, /V48 let lists grow before scrolling/);
  assert.match(
    styles,
    /\.combined-slicing \.slice-pin-list[\s\S]*max-height: none/,
  );
  assert.match(
    styles,
    /\.rebar-content > \.rebar-plane-manager[\s\S]*max-height: none/,
  );
  assert.doesNotMatch(viewer, /<InchRangeControl/);
  assert.match(types, /export type RebarPlane/);
  assert.match(types, /export type SlicePin/);
  assert.match(types, /pathPoints\?: Vec3\[\]/);
  assert.match(types, /barNumber\?: string/);
  assert.match(types, /series\?: string/);
  assert.match(types, /suffix\?: string/);
  assert.match(storage, /rebarPlanes\?: RebarPlane\[\]/);
  assert.match(storage, /slicePins\?: SlicePin\[\]/);
});
