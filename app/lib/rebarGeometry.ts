import type { Axis, ModelNode, Vec3 } from "./types";

type Point2 = { a: number; b: number };

const otherAxes: Record<Axis, [Axis, Axis]> = {
  x: ["y", "z"],
  y: ["x", "z"],
  z: ["x", "y"],
};

const cross2 = (o: Point2, a: Point2, b: Point2) =>
  (a.a - o.a) * (b.b - o.b) - (a.b - o.b) * (b.a - o.a);

function convexHull(points: Point2[]) {
  const sorted = [...points].sort((a, b) => a.a - b.a || a.b - b.b);
  const unique = sorted.filter(
    (point, index) =>
      !index ||
      point.a !== sorted[index - 1].a ||
      point.b !== sorted[index - 1].b,
  );
  if (unique.length < 3) return unique;
  const lower: Point2[] = [];
  for (const point of unique) {
    while (
      lower.length >= 2 &&
      cross2(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Point2[] = [];
  for (const point of [...unique].reverse()) {
    while (
      upper.length >= 2 &&
      cross2(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function insetConvexPolygon(points: Point2[], distance: number) {
  if (points.length < 3 || distance <= 0) return points;
  return points.map((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const edgeA = { a: point.a - previous.a, b: point.b - previous.b };
    const edgeB = { a: next.a - point.a, b: next.b - point.b };
    const lengthA = Math.hypot(edgeA.a, edgeA.b) || 1;
    const lengthB = Math.hypot(edgeB.a, edgeB.b) || 1;
    const normalA = { a: -edgeA.b / lengthA, b: edgeA.a / lengthA };
    const normalB = { a: -edgeB.b / lengthB, b: edgeB.a / lengthB };
    const bisector = {
      a: normalA.a + normalB.a,
      b: normalA.b + normalB.b,
    };
    const denominator = bisector.a * normalA.a + bisector.b * normalA.b;
    const scale = Math.abs(denominator) > 1e-8 ? distance / denominator : distance;
    return {
      a: point.a + bisector.a * scale,
      b: point.b + bisector.b * scale,
    };
  });
}

export function createCoverOutline(
  nodes: ModelNode[],
  axis: Axis,
  coordinate: number,
  coverModelUnits: number,
): Vec3[] {
  const [aAxis, bAxis] = otherAxes[axis];
  const coordinates = nodes.map((node) => node.local ?? node.global);
  const closest = Math.min(
    ...coordinates.map((point) => Math.abs(point[axis] - coordinate)),
  );
  const span = Math.max(
    ...coordinates.map((point) => point[axis]),
  ) - Math.min(...coordinates.map((point) => point[axis]));
  const tolerance = Math.max(span * 1e-7, 1e-7);
  const sectionPoints = coordinates
    .filter((point) => Math.abs(point[axis] - coordinate) <= closest + tolerance)
    .map((point) => ({ a: point[aAxis], b: point[bAxis] }));
  const outline = insetConvexPolygon(convexHull(sectionPoints), coverModelUnits);
  return outline.map((point) => ({
    x: axis === "x" ? coordinate : aAxis === "x" ? point.a : point.b,
    y: axis === "y" ? coordinate : aAxis === "y" ? point.a : point.b,
    z: axis === "z" ? coordinate : aAxis === "z" ? point.a : point.b,
  }));
}

export function distributeBars(
  start: number,
  end: number,
  spacingInches: number,
  inchesPerUnit: number,
) {
  const direction = end >= start ? 1 : -1;
  const lengthInches = Math.abs(end - start) * inchesPerUnit;
  if (lengthInches < 1e-9) return [start];
  const spacing = Math.max(spacingInches, 0.01);
  const regularCount = Math.floor(lengthInches / spacing);
  const positions = Array.from(
    { length: regularCount + 1 },
    (_, index) => start + direction * (index * spacing) / inchesPerUnit,
  );
  if (Math.abs(positions[positions.length - 1] - end) < 1e-9) return positions;
  positions.push(end);
  const adjustableBars = Math.min(5, positions.length - 1);
  const anchorIndex = positions.length - adjustableBars - 1;
  const anchor = positions[anchorIndex];
  for (let index = 1; index <= adjustableBars; index += 1) {
    positions[anchorIndex + index] =
      anchor + ((end - anchor) * index) / adjustableBars;
  }
  return positions;
}
