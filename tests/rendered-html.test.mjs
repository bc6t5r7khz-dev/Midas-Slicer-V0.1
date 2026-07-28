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
  assert.match(html, />Model</);
  assert.match(html, /Axes \+ Scale/);
  assert.match(html, /Slicing/);
  assert.match(html, /Rebar/);
  assert.match(html, /Import Project/);
  assert.match(html, /Export Project/);
  assert.doesNotMatch(html, /codex-preview/i);
});

test("includes plane-based rebar and quantity export workflows", async () => {
  const [viewer, types, storage] = await Promise.all([
    readFile(
      new URL("../app/components/ModelViewer.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/lib/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/workspaceStorage.ts", import.meta.url), "utf8"),
  ]);
  assert.match(viewer, /Add Plane/);
  assert.match(viewer, /Delete Plane/);
  assert.match(viewer, /Add Group/);
  assert.match(viewer, /PERIMETER SNAP OFFSETS/);
  assert.match(viewer, /auto-top-horizontal/);
  assert.match(viewer, /Export Rebar Quantity/);
  assert.match(viewer, /event\.key === "Escape"/);
  assert.match(viewer, /mct-section-lab-project/);
  assert.match(viewer, /Display rebar/);
  assert.match(viewer, /FAVORITE PLANES/);
  assert.match(viewer, /PINNED SLICES/);
  assert.match(viewer, /Save Viewpoint/);
  assert.match(viewer, /favoriteRebarPlaneIds/);
  assert.match(viewer, /Add another keypoint/);
  assert.match(viewer, /rebarPathPoints/);
  assert.doesNotMatch(viewer, /<InchRangeControl/);
  assert.match(types, /export type RebarPlane/);
  assert.match(types, /export type SlicePin/);
  assert.match(types, /pathPoints\?: Vec3\[\]/);
  assert.match(types, /barNumber\?: string/);
  assert.match(storage, /rebarPlanes\?: RebarPlane\[\]/);
  assert.match(storage, /slicePins\?: SlicePin\[\]/);
});
