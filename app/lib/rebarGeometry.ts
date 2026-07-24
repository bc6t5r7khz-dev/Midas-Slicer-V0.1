import type { Axis, ModelElement, ModelNode, Vec3 } from "./types";

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

const solidEdges = (size: number): Array<[number, number]> => {
  if (size === 4) return [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];
  if (size === 6) {
    return [
      [0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3],
      [0, 3], [1, 4], [2, 5],
    ];
  }
  if (size === 8) {
    return [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
  }
  return [];
};

const pointKey = (point: Vec3, precision: number) =>
  `${Math.round(point.x * precision)},${Math.round(point.y * precision)},${Math.round(point.z * precision)}`;

export function createSectionBoundary(
  nodes: ModelNode[],
  elements: ModelElement[],
  axis: Axis,
  coordinate: number,
): { segments: Array<[Vec3, Vec3]>; loops: Vec3[][] } {
  const [aAxis, bAxis] = otherAxes[axis];
  const nodeMap = new Map(nodes.map((node) => [node.id, node.local ?? node.global]));
  const coordinates = [...nodeMap.values()];
  const minimum = Math.min(...coordinates.map((point) => point[axis]));
  const maximum = Math.max(...coordinates.map((point) => point[axis]));
  const span = Math.max(maximum - minimum, 1);
  const tolerance = span * 1e-7;
  const effectiveCoordinate =
    coordinate + tolerance <= maximum
      ? coordinate + tolerance
      : coordinate - tolerance;
  const precision = 1 / Math.max(tolerance, 1e-8);
  const edgeCounts = new Map<
    string,
    { segment: [Vec3, Vec3]; count: number }
  >();

  for (const element of elements) {
    if (element.type !== "SOLID") continue;
    const vertices = element.nodeIds.map((id) => nodeMap.get(id));
    if (vertices.some((point) => !point)) continue;
    const intersections: Vec3[] = [];
    for (const [firstIndex, secondIndex] of solidEdges(vertices.length)) {
      const first = vertices[firstIndex]!;
      const second = vertices[secondIndex]!;
      const firstDistance = first[axis] - effectiveCoordinate;
      const secondDistance = second[axis] - effectiveCoordinate;
      if (Math.abs(firstDistance) <= tolerance) {
        intersections.push({ ...first, [axis]: coordinate });
      }
      if (firstDistance * secondDistance < 0) {
        const amount = firstDistance / (firstDistance - secondDistance);
        intersections.push({
          x: first.x + (second.x - first.x) * amount,
          y: first.y + (second.y - first.y) * amount,
          z: first.z + (second.z - first.z) * amount,
          [axis]: coordinate,
        });
      }
    }
    const unique = intersections.filter(
      (point, index) =>
        intersections.findIndex(
          (candidate) => pointKey(candidate, precision) === pointKey(point, precision),
        ) === index,
    );
    if (unique.length < 3) continue;
    const center = unique.reduce(
      (sum, point) => ({
        a: sum.a + point[aAxis] / unique.length,
        b: sum.b + point[bAxis] / unique.length,
      }),
      { a: 0, b: 0 },
    );
    unique.sort(
      (first, second) =>
        Math.atan2(first[bAxis] - center.b, first[aAxis] - center.a) -
        Math.atan2(second[bAxis] - center.b, second[aAxis] - center.a),
    );
    unique.forEach((point, index) => {
      const next = unique[(index + 1) % unique.length];
      const firstKey = pointKey(point, precision);
      const secondKey = pointKey(next, precision);
      const key =
        firstKey < secondKey
          ? `${firstKey}|${secondKey}`
          : `${secondKey}|${firstKey}`;
      const current = edgeCounts.get(key);
      edgeCounts.set(key, {
        segment: current?.segment ?? [point, next],
        count: (current?.count ?? 0) + 1,
      });
    });
  }

  const segments = [...edgeCounts.values()]
    .filter((entry) => entry.count % 2 === 1)
    .map((entry) => entry.segment);
  const unused = new Set(segments.map((_, index) => index));
  const loops: Vec3[][] = [];
  while (unused.size) {
    const startIndex = unused.values().next().value as number;
    unused.delete(startIndex);
    const [start, next] = segments[startIndex];
    const loop = [start, next];
    let current = next;
    while (loop.length <= segments.length + 1) {
      const currentKey = pointKey(current, precision);
      const match = [...unused].find((index) => {
        const [a, b] = segments[index];
        return (
          pointKey(a, precision) === currentKey ||
          pointKey(b, precision) === currentKey
        );
      });
      if (match === undefined) break;
      unused.delete(match);
      const [a, b] = segments[match];
      current =
        pointKey(a, precision) === currentKey ? b : a;
      if (pointKey(current, precision) === pointKey(loop[0], precision)) break;
      loop.push(current);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return { segments, loops };
}

export function createCoverOutline(
  nodes: ModelNode[],
  elements: ModelElement[],
  axis: Axis,
  coordinate: number,
  coverModelUnits: number,
): Vec3[] {
  const [aAxis, bAxis] = otherAxes[axis];
  const boundary = createSectionBoundary(nodes, elements, axis, coordinate);
  let loop = boundary.loops
    .map((vertices) => ({
      vertices,
      area: Math.abs(
        vertices.reduce((area, point, index) => {
          const next = vertices[(index + 1) % vertices.length];
          return area + point[aAxis] * next[bAxis] - next[aAxis] * point[bAxis];
        }, 0) / 2,
      ),
    }))
    .sort((a, b) => b.area - a.area)[0]?.vertices;
  if (!loop) {
    const points = nodes.map((node) => node.local ?? node.global);
    loop = convexHull(points.map((point) => ({ a: point[aAxis], b: point[bAxis] }))).map(
      (point) => ({
        x: axis === "x" ? coordinate : aAxis === "x" ? point.a : point.b,
        y: axis === "y" ? coordinate : aAxis === "y" ? point.a : point.b,
        z: axis === "z" ? coordinate : aAxis === "z" ? point.a : point.b,
      }),
    );
  }
  const points2 = loop.map((point) => ({ a: point[aAxis], b: point[bAxis] }));
  const signedArea = points2.reduce((area, point, index) => {
    const next = points2[(index + 1) % points2.length];
    return area + point.a * next.b - next.a * point.b;
  }, 0);
  const oriented = signedArea < 0 ? [...points2].reverse() : points2;
  return insetConvexPolygon(oriented, coverModelUnits).map((point) => ({
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
