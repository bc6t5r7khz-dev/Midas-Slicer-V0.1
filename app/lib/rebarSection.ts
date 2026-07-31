import type { RebarLine, Vec3 } from "./types";

export type SectionLine = {
  start: Vec3;
  end: Vec3;
};

export type SectionCircle = {
  center: Vec3;
};

const add = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});

const subtract = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

const scale = (value: Vec3, amount: number): Vec3 => ({
  x: value.x * amount,
  y: value.y * amount,
  z: value.z * amount,
});

const dot = (a: Vec3, b: Vec3) =>
  a.x * b.x + a.y * b.y + a.z * b.z;

const length = (value: Vec3) =>
  Math.hypot(value.x, value.y, value.z);

const normalize = (value: Vec3): Vec3 => {
  const magnitude = length(value) || 1;
  return scale(value, 1 / magnitude);
};

const lerp = (a: Vec3, b: Vec3, amount: number): Vec3 => ({
  x: a.x + (b.x - a.x) * amount,
  y: a.y + (b.y - a.y) * amount,
  z: a.z + (b.z - a.z) * amount,
});

const projectToPlane = (
  point: Vec3,
  planeOrigin: Vec3,
  normal: Vec3,
) => subtract(point, scale(normal, dot(subtract(point, planeOrigin), normal)));

const clipSegmentToDepth = (
  start: Vec3,
  end: Vec3,
  startDistance: number,
  endDistance: number,
  depth: number,
) => {
  let minimum = 0;
  let maximum = 1;
  const delta = endDistance - startDistance;
  const clip = (coefficient: number, constant: number) => {
    if (Math.abs(coefficient) <= 1e-12) return constant >= 0;
    const amount = constant / coefficient;
    if (coefficient > 0) maximum = Math.min(maximum, amount);
    else minimum = Math.max(minimum, amount);
    return minimum <= maximum;
  };
  // Keep -depth <= distance <= 0: the material side of the selected cut.
  if (!clip(delta, -startDistance)) return null;
  if (!clip(-delta, startDistance + depth)) return null;
  return [lerp(start, end, minimum), lerp(start, end, maximum)] as const;
};

/**
 * Produces conventional reinforcing-section graphics. Bars within the throw
 * depth are projected onto the cut; bars crossing the cut are represented by
 * circles at their centerline intersections.
 */
export function sectionRebarGeometry(
  lines: RebarLine[],
  planeOrigin: Vec3,
  planeNormalInput: Vec3,
  throwDepthModelUnits: number,
) {
  const normal = normalize(planeNormalInput);
  const depth = Math.max(throwDepthModelUnits, 0);
  const projectedLines: SectionLine[] = [];
  const circles: SectionCircle[] = [];
  const tolerance = Math.max(depth * 1e-8, 1e-8);

  for (const line of lines) {
    const segmentCount =
      line.points.length - 1 + (line.closed && line.points.length > 2 ? 1 : 0);
    for (let index = 0; index < segmentCount; index += 1) {
      const start = line.points[index];
      const end = line.points[(index + 1) % line.points.length];
      const startDistance = dot(subtract(start, planeOrigin), normal);
      const endDistance = dot(subtract(end, planeOrigin), normal);
      const distanceDelta = endDistance - startDistance;
      if (
        Math.abs(distanceDelta) > tolerance &&
        startDistance * endDistance <= tolerance
      ) {
        const amount = Math.max(
          0,
          Math.min(1, -startDistance / distanceDelta),
        );
        const center = lerp(start, end, amount);
        if (
          !circles.some(
            (candidate) =>
              length(subtract(candidate.center, center)) <= tolerance * 10,
          )
        ) {
          circles.push({ center });
        }
      }
      const clipped = clipSegmentToDepth(
        start,
        end,
        startDistance,
        endDistance,
        depth,
      );
      if (!clipped) continue;
      const projectedStart = projectToPlane(clipped[0], planeOrigin, normal);
      const projectedEnd = projectToPlane(clipped[1], planeOrigin, normal);
      if (length(subtract(projectedEnd, projectedStart)) > tolerance) {
        projectedLines.push({
          start: projectedStart,
          end: projectedEnd,
        });
      }
    }
  }
  return { projectedLines, circles };
}

export function sectionPlaneAxes(
  normalInput: Vec3,
  preferredUpInput: Vec3,
) {
  const normal = normalize(normalInput);
  let up = subtract(
    preferredUpInput,
    scale(normal, dot(preferredUpInput, normal)),
  );
  if (length(up) <= 1e-8) {
    const fallback =
      Math.abs(normal.z) < 0.9
        ? ({ x: 0, y: 0, z: 1 } as Vec3)
        : ({ x: 0, y: 1, z: 0 } as Vec3);
    up = subtract(fallback, scale(normal, dot(fallback, normal)));
  }
  up = normalize(up);
  const right = normalize({
    x: up.y * normal.z - up.z * normal.y,
    y: up.z * normal.x - up.x * normal.z,
    z: up.x * normal.y - up.y * normal.x,
  });
  return { normal, up, right };
}
