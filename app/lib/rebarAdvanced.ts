import type { RebarLine, RebarRun, Vec3 } from "./types";

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

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

const length = (value: Vec3) =>
  Math.hypot(value.x, value.y, value.z);

const normalize = (value: Vec3): Vec3 => {
  const magnitude = length(value);
  return magnitude <= 1e-12
    ? { x: 0, y: 0, z: 1 }
    : scale(value, 1 / magnitude);
};

const lerpPoint = (a: Vec3, b: Vec3, amount: number): Vec3 => ({
  x: a.x + (b.x - a.x) * amount,
  y: a.y + (b.y - a.y) * amount,
  z: a.z + (b.z - a.z) * amount,
});

export function pointAlongRebarPath(points: Vec3[], distance: number) {
  if (!points.length) return { x: 0, y: 0, z: 0 };
  if (points.length === 1 || distance <= 0) return points[0];
  let remaining = distance;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentLength = length(subtract(end, start));
    if (remaining <= segmentLength || index === points.length - 1) {
      return lerpPoint(
        start,
        end,
        segmentLength <= 1e-12
          ? 0
          : Math.max(0, Math.min(1, remaining / segmentLength)),
      );
    }
    remaining -= segmentLength;
  }
  return points[points.length - 1];
}

const rotateAroundAxis = (
  value: Vec3,
  axisInput: Vec3,
  angle: number,
): Vec3 => {
  const axis = normalize(axisInput);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return add(
    add(
      scale(value, cosine),
      scale(cross(axis, value), sine),
    ),
    scale(axis, dot(axis, value) * (1 - cosine)),
  );
};

const perpendicularTo = (normal: Vec3) =>
  normalize(
    cross(
      normal,
      Math.abs(normal.x) < 0.8
        ? { x: 1, y: 0, z: 0 }
        : { x: 0, y: 1, z: 0 },
    ),
  );

const rotateNormalToward = (
  point: Vec3,
  anchor: Vec3,
  sourceNormalInput: Vec3,
  targetNormalInput: Vec3,
  amount: number,
) => {
  if (amount <= 0) return point;
  const sourceNormal = normalize(sourceNormalInput);
  const targetNormal = normalize(targetNormalInput);
  const cosine = Math.max(-1, Math.min(1, dot(sourceNormal, targetNormal)));
  const angle = Math.acos(cosine);
  if (angle <= 1e-10) return point;
  const rawAxis = cross(sourceNormal, targetNormal);
  const axis =
    length(rawAxis) <= 1e-10 ? perpendicularTo(sourceNormal) : normalize(rawAxis);
  return add(
    anchor,
    rotateAroundAxis(subtract(point, anchor), axis, angle * amount),
  );
};

const splayAmount = (
  run: RebarRun,
  index: number,
  total: number,
) => {
  const splay = run.advanced?.splay;
  if (!splay || total <= 0) return 0;
  if (splay.scope === "all") {
    return total <= 1 ? 1 : index / (total - 1);
  }
  const count = Math.max(1, Math.min(total, Math.round(splay.count ?? 1)));
  const firstSplayedIndex = total - count;
  if (index < firstSplayedIndex) return 0;
  return (index - firstSplayedIndex + 1) / count;
};

const terminalAnchorAt = (run: RebarRun, fraction: number) => {
  const anchors = [...(run.advanced?.variableLength?.endpointAnchors ?? [])]
    .filter((anchor) => Number.isFinite(anchor.fraction))
    .sort((a, b) => a.fraction - b.fraction);
  if (!anchors.length) return null;
  if (fraction <= anchors[0].fraction) return anchors[0].point;
  if (fraction >= anchors[anchors.length - 1].fraction) {
    return anchors[anchors.length - 1].point;
  }
  const upperIndex = anchors.findIndex(
    (anchor) => anchor.fraction >= fraction,
  );
  const lower = anchors[Math.max(0, upperIndex - 1)];
  const upper = anchors[upperIndex];
  const span = upper.fraction - lower.fraction;
  return lerpPoint(
    lower.point,
    upper.point,
    span <= 1e-12 ? 0 : (fraction - lower.fraction) / span,
  );
};

export type RebarInstanceOptions = {
  sourceNormal?: Vec3 | null;
  targetNormal?: Vec3 | null;
  includeVariableLength?: boolean;
  lapOffsetModelUnits?: number;
};

/**
 * Expands one run into the actual bar polylines shown and quantified.
 * Translation follows the saved spacing path, splay rotates each copy around
 * its path anchor, and variable length replaces the final drawn vertex using
 * the interpolated endpoint-control path.
 */
export function generateRebarInstances(
  run: RebarRun,
  options: RebarInstanceOptions = {},
): RebarLine[][] {
  const positions = run.positions.length ? run.positions : [0];
  const pathOrigin = run.pathPoints?.[0];
  const lapOffset = options.lapOffsetModelUnits ?? 0;
  const sourceNormal = options.sourceNormal ?? null;
  const targetNormal = options.targetNormal ?? null;

  return positions.map((position, index) => {
    const distance = position + lapOffset;
    const pathPoint =
      run.pathPoints && run.pathPoints.length >= 2
        ? pointAlongRebarPath(run.pathPoints, distance)
        : run.pathStart && run.distributionVector
          ? add(run.pathStart, scale(run.distributionVector, distance))
          : null;
    const translation =
      pathPoint && pathOrigin
        ? subtract(pathPoint, pathOrigin)
        : run.distributionVector
          ? scale(run.distributionVector, distance)
          : null;
    const fraction =
      positions.length <= 1 ? 1 : index / (positions.length - 1);
    const amount =
      sourceNormal && targetNormal ? splayAmount(run, index, positions.length) : 0;
    const anchor =
      pathPoint ??
      (run.pathStart && translation
        ? add(run.pathStart, translation)
        : run.lines[0]?.points[0] ?? { x: 0, y: 0, z: 0 });

    const lines = run.lines.map((line) => ({
      ...line,
      points: line.points.map((point) => {
        const translated = translation
          ? add(point, translation)
          : {
              ...point,
              [run.axis]: position + lapOffset,
            };
        return sourceNormal && targetNormal
          ? rotateNormalToward(
              translated,
              anchor,
              sourceNormal,
              targetNormal,
              amount,
            )
          : translated;
      }),
    }));

    if (options.includeVariableLength !== false) {
      const endpoint = terminalAnchorAt(run, fraction);
      const finalLine = lines[lines.length - 1];
      if (endpoint && finalLine?.points.length) {
        finalLine.points[finalLine.points.length - 1] = { ...endpoint };
      }
    }
    return lines;
  });
}

export function rebarInstanceLength(lines: RebarLine[]) {
  return lines.reduce(
    (total, line) =>
      total +
      line.points.slice(1).reduce((lineTotal, point, index) => {
        const previous = line.points[index];
        return lineTotal + length(subtract(point, previous));
      }, 0) +
      (line.closed && line.points.length > 2
        ? length(subtract(line.points[0], line.points[line.points.length - 1]))
        : 0),
    0,
  );
}
