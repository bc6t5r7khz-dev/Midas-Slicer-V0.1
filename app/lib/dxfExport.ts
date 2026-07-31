import type { ElementSurface, RebarLine, Vec3 } from "./types";

const pair = (code: number, value: string | number) => `${code}\n${value}\n`;

const layerName = (value: string) =>
  value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "0";

const pointPairs = (point: Vec3, base = 10) =>
  pair(base, point.x) + pair(base + 10, point.y) + pair(base + 20, point.z);

export function createDxf(entities: string[]) {
  return [
    pair(0, "SECTION"),
    pair(2, "HEADER"),
    pair(9, "$ACADVER"),
    pair(1, "AC1009"),
    pair(0, "ENDSEC"),
    pair(0, "SECTION"),
    pair(2, "ENTITIES"),
    ...entities,
    pair(0, "ENDSEC"),
    pair(0, "EOF"),
  ].join("");
}

export function dxfLine(start: Vec3, end: Vec3, layer: string) {
  return (
    pair(0, "LINE") +
    pair(8, layerName(layer)) +
    pointPairs(start) +
    pointPairs(end, 11)
  );
}

export function dxfCircle(center: Vec3, radius: number, layer: string) {
  return (
    pair(0, "CIRCLE") +
    pair(8, layerName(layer)) +
    pointPairs(center) +
    pair(40, radius)
  );
}

export function dxfPolyline(
  points: Vec3[],
  layer: string,
  closed = false,
) {
  if (points.length < 2) return "";
  return (
    pair(0, "POLYLINE") +
    pair(8, layerName(layer)) +
    pair(66, 1) +
    pair(70, closed ? 9 : 8) +
    points
      .map(
        (point) =>
          pair(0, "VERTEX") +
          pair(8, layerName(layer)) +
          pair(70, 32) +
          pointPairs(point),
      )
      .join("") +
    pair(0, "SEQEND")
  );
}

export function dxfFaces(
  surfaces: ElementSurface[],
  transform: (point: Vec3) => Vec3,
  layer = "CONCRETE",
) {
  return surfaces.flatMap((surface) => {
    if (surface.vertices.length < 3) return [];
    const first = transform(surface.vertices[0]);
    return surface.vertices.slice(2).map((vertex, index) => {
      const second = transform(surface.vertices[index + 1]);
      const third = transform(vertex);
      return (
        pair(0, "3DFACE") +
        pair(8, layerName(layer)) +
        pointPairs(first) +
        pointPairs(second, 11) +
        pointPairs(third, 12) +
        pointPairs(third, 13)
      );
    });
  });
}

export function dxfRebarLines(
  instances: RebarLine[][],
  transform: (point: Vec3) => Vec3,
  layer: string,
) {
  return instances.flatMap((instance) =>
    instance.map((line) =>
      dxfPolyline(line.points.map(transform), layer, Boolean(line.closed)),
    ),
  );
}
