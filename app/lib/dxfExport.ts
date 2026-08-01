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

const dxfFaceEntity = (
  first: Vec3,
  second: Vec3,
  third: Vec3,
  fourth: Vec3,
  layer: string,
) =>
  pair(0, "3DFACE") +
  pair(8, layerName(layer)) +
  pointPairs(first) +
  pointPairs(second, 11) +
  pointPairs(third, 12) +
  pointPairs(fourth, 13);

const tubeSegmentFaces = (
  start: Vec3,
  end: Vec3,
  radius: number,
  layer: string,
  sides: number,
) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const segmentLength = Math.hypot(dx, dy, dz);
  if (segmentLength <= 1e-9 || radius <= 0) return [];
  const direction = {
    x: dx / segmentLength,
    y: dy / segmentLength,
    z: dz / segmentLength,
  };
  const reference =
    Math.abs(direction.z) < 0.9
      ? { x: 0, y: 0, z: 1 }
      : { x: 0, y: 1, z: 0 };
  const cross = (a: Vec3, b: Vec3): Vec3 => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  });
  const unit = (value: Vec3): Vec3 => {
    const magnitude = Math.hypot(value.x, value.y, value.z) || 1;
    return {
      x: value.x / magnitude,
      y: value.y / magnitude,
      z: value.z / magnitude,
    };
  };
  const firstAxis = unit(cross(direction, reference));
  const secondAxis = unit(cross(direction, firstAxis));
  const ring = (center: Vec3) =>
    Array.from({ length: sides }, (_, index) => {
      const angle = (index / sides) * Math.PI * 2;
      const firstAmount = Math.cos(angle) * radius;
      const secondAmount = Math.sin(angle) * radius;
      return {
        x:
          center.x +
          firstAxis.x * firstAmount +
          secondAxis.x * secondAmount,
        y:
          center.y +
          firstAxis.y * firstAmount +
          secondAxis.y * secondAmount,
        z:
          center.z +
          firstAxis.z * firstAmount +
          secondAxis.z * secondAmount,
      };
    });
  const startRing = ring(start);
  const endRing = ring(end);
  const entities: string[] = [];
  for (let index = 0; index < sides; index += 1) {
    const next = (index + 1) % sides;
    entities.push(
      dxfFaceEntity(
        startRing[index],
        startRing[next],
        endRing[next],
        endRing[index],
        layer,
      ),
      dxfFaceEntity(start, startRing[next], startRing[index], startRing[index], layer),
      dxfFaceEntity(end, endRing[index], endRing[next], endRing[next], layer),
    );
  }
  return entities;
};

/** Exports each rebar centerline segment as an eight-sided tube at true diameter. */
export function dxfRebarSolids(
  instances: RebarLine[][],
  transform: (point: Vec3) => Vec3,
  diameter: number,
  layer: string,
  sides = 8,
) {
  return instances.flatMap((instance) =>
    instance.flatMap((line) => {
      const points = line.points.map(transform);
      const segmentCount =
        points.length - 1 + (line.closed && points.length > 2 ? 1 : 0);
      return Array.from({ length: Math.max(0, segmentCount) }, (_, index) =>
        tubeSegmentFaces(
          points[index],
          points[(index + 1) % points.length],
          diameter / 2,
          layer,
          Math.max(6, Math.round(sides)),
        ),
      ).flat();
    }),
  );
}
