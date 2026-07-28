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
  assert.match(html, /Volume Definition/);
  assert.match(html, /Coordinates/);
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
  assert.match(viewer, /Add New Plane/);
  assert.match(viewer, /Export Rebar Quantity/);
  assert.match(viewer, /event\.key === "Escape"/);
  assert.match(viewer, /mct-section-lab-project/);
  assert.match(types, /export type RebarPlane/);
  assert.match(types, /barNumber\?: string/);
  assert.match(storage, /rebarPlanes\?: RebarPlane\[\]/);
});
