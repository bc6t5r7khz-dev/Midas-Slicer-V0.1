import type { SectionLine } from "./rebarSection";
import type { Vec3 } from "./types";

export type LapDimension = {
  start: Vec3;
  end: Vec3;
  lengthModelUnits: number;
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

const length = (value: Vec3) => Math.hypot(value.x, value.y, value.z);

const normalize = (value: Vec3): Vec3 => {
  const magnitude = length(value) || 1;
  return scale(value, 1 / magnitude);
};

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

const pointAt = (line: SectionLine, amount: number) =>
  add(line.start, scale(subtract(line.end, line.start), amount));

/**
 * Produces a drafting-only dogleg where a lapped bar would otherwise be hidden
 * directly behind its source bar in a reinforcing section.
 */
export function offsetLappedSectionSegments(
  lappedSegments: SectionLine[],
  sourceSegments: SectionLine[],
  planeNormal: Vec3,
  modelCenter: Vec3,
  offsetDistance: number,
  tolerance: number,
) {
  const segments: SectionLine[] = [];
  const lapDimensions: LapDimension[] = [];
  const epsilon = Math.max(tolerance, 1e-8);

  for (const segment of lappedSegments) {
    const delta = subtract(segment.end, segment.start);
    const segmentLength = length(delta);
    if (segmentLength <= epsilon) continue;
    const direction = scale(delta, 1 / segmentLength);
    let bestOverlap: [number, number] | null = null;

    for (const source of sourceSegments) {
      const sourceDelta = subtract(source.end, source.start);
      const sourceLength = length(sourceDelta);
      if (sourceLength <= epsilon) continue;
      const sourceDirection = scale(sourceDelta, 1 / sourceLength);
      if (Math.abs(dot(direction, sourceDirection)) < 0.995) continue;
      const fromLine = subtract(source.start, segment.start);
      const perpendicular = subtract(
        fromLine,
        scale(direction, dot(fromLine, direction)),
      );
      if (length(perpendicular) > Math.max(offsetDistance * 0.25, epsilon * 10)) {
        continue;
      }
      const first = dot(subtract(source.start, segment.start), direction) / segmentLength;
      const second = dot(subtract(source.end, segment.start), direction) / segmentLength;
      const overlapStart = Math.max(0, Math.min(first, second));
      const overlapEnd = Math.min(1, Math.max(first, second));
      if (overlapEnd - overlapStart <= epsilon / segmentLength) continue;
      if (
        !bestOverlap ||
        overlapEnd - overlapStart > bestOverlap[1] - bestOverlap[0]
      ) {
        bestOverlap = [overlapStart, overlapEnd];
      }
    }

    if (!bestOverlap) {
      segments.push(segment);
      continue;
    }

    const [overlapStart, overlapEnd] = bestOverlap;
    const overlapFirst = pointAt(segment, overlapStart);
    const overlapLast = pointAt(segment, overlapEnd);
    let inward = normalize(cross(planeNormal, direction));
    const overlapCenter = pointAt(segment, (overlapStart + overlapEnd) / 2);
    if (dot(inward, subtract(modelCenter, overlapCenter)) < 0) {
      inward = scale(inward, -1);
    }
    const offset = scale(inward, Math.max(offsetDistance, epsilon));
    const shiftedFirst = add(overlapFirst, offset);
    const shiftedLast = add(overlapLast, offset);

    if (overlapStart > epsilon / segmentLength) {
      segments.push({ start: segment.start, end: overlapFirst });
    }
    segments.push(
      { start: overlapFirst, end: shiftedFirst },
      { start: shiftedFirst, end: shiftedLast },
      { start: shiftedLast, end: overlapLast },
    );
    if (1 - overlapEnd > epsilon / segmentLength) {
      segments.push({ start: overlapLast, end: segment.end });
    }
    lapDimensions.push({
      start: shiftedFirst,
      end: shiftedLast,
      lengthModelUnits: length(subtract(overlapLast, overlapFirst)),
    });
  }

  return { segments, lapDimensions };
}
