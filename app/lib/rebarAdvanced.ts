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

const planeIntersection = (
  firstNormalInput: Vec3,
  firstPoint: Vec3,
  secondNormalInput: Vec3,
  secondPoint: Vec3,
) => {
  const firstNormal = normalize(firstNormalInput);
  let secondNormal = normalize(secondNormalInput);
  // A plane is unchanged when its normal is reversed. Always use the
  // equivalent target normal nearest the source normal so a harmless node
  // ordering difference cannot turn a small fan into a near-180° rotation.
  if (dot(firstNormal, secondNormal) < 0) {
    secondNormal = scale(secondNormal, -1);
  }
  const directionRaw = cross(firstNormal, secondNormal);
  const denominator = dot(directionRaw, directionRaw);
  if (denominator <= 1e-12) return null;
  const firstConstant = dot(firstNormal, firstPoint);
  const secondConstant = dot(secondNormal, secondPoint);
  const point = scale(
    add(
      scale(cross(secondNormal, directionRaw), firstConstant),
      scale(cross(directionRaw, firstNormal), secondConstant),
    ),
    1 / denominator,
  );
  const direction = normalize(directionRaw);
  const angle = Math.atan2(
    dot(direction, cross(firstNormal, secondNormal)),
    dot(firstNormal, secondNormal),
  );
  return { point, direction, angle };
};

const rotateAroundLine = (
  point: Vec3,
  axisPoint: Vec3,
  axisDirectionInput: Vec3,
  angle: number,
) => {
  const axis = normalize(axisDirectionInput);
  const relative = subtract(point, axisPoint);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return add(
    axisPoint,
    add(
      add(
        scale(relative, cosine),
        scale(cross(axis, relative), sine),
      ),
      scale(axis, dot(axis, relative) * (1 - cosine)),
    ),
  );
};

const pointOnLinesAtFraction = (lines: RebarLine[], fraction: number) => {
  const segments = lines.flatMap((line) =>
    line.points.slice(1).map((point, index) => ({
      start: line.points[index],
      end: point,
      length: length(subtract(point, line.points[index])),
    })),
  );
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (!segments.length) return lines[0]?.points[0] ?? null;
  if (total <= 1e-12) return segments[0].start;
  let remaining = total * Math.max(0, Math.min(1, fraction));
  for (const segment of segments) {
    if (remaining <= segment.length) {
      return lerpPoint(
        segment.start,
        segment.end,
        segment.length <= 1e-12 ? 0 : remaining / segment.length,
      );
    }
    remaining -= segment.length;
  }
  return segments[segments.length - 1].end;
};

export function splayArcLengthAtMidpoint(
  lines: RebarLine[],
  sourceNormal: Vec3,
  sourceOrigin: Vec3,
  targetNormal: Vec3,
  targetOrigin: Vec3,
) {
  const intersection = planeIntersection(
    sourceNormal,
    sourceOrigin,
    targetNormal,
    targetOrigin,
  );
  const midpoint = pointOnLinesAtFraction(lines, 0.5);
  if (!intersection || !midpoint) return null;
  const relative = subtract(midpoint, intersection.point);
  const axial = scale(
    intersection.direction,
    dot(relative, intersection.direction),
  );
  const radius = length(subtract(relative, axial));
  return {
    ...intersection,
    midpoint,
    radius,
    arcLength: radius * Math.abs(intersection.angle),
  };
}

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
  sourceOrigin?: Vec3 | null;
  targetNormal?: Vec3 | null;
  targetOrigin?: Vec3 | null;
  includeVariableLength?: boolean;
  lapOffsetModelUnits?: number;
};

/**
 * Expands one run into the actual bar polylines shown and quantified.
 * Translation follows the saved spacing path. Variable length replaces the
 * final drawn vertex using the interpolated endpoint-control path. Splay
 * keeps the selected bar anchor on that path while rotating the complete bar
 * around the anchor, creating the fan between source and target planes.
 */
export function generateRebarInstances(
  run: RebarRun,
  options: RebarInstanceOptions = {},
): RebarLine[][] {
  const positions = run.positions.length ? run.positions : [0];
  const pathOrigin = run.pathPoints?.[0];
  const lapOffset = options.lapOffsetModelUnits ?? 0;
  const sourceNormal = options.sourceNormal ?? null;
  const sourceOrigin = options.sourceOrigin ?? null;
  const targetNormal = options.targetNormal ?? null;
  const targetOrigin = options.targetOrigin ?? null;

  const instanceAnchors = positions.map((position) => {
    const distance = position + lapOffset;
    return (
      run.pathPoints && run.pathPoints.length >= 2
        ? pointAlongRebarPath(run.pathPoints, distance)
        : run.pathStart && run.distributionVector
          ? add(run.pathStart, scale(run.distributionVector, distance))
          : null
    );
  });

  const linearInstances = positions.map((position, index) => {
    const distance = position + lapOffset;
    const pathPoint = instanceAnchors[index];
    const translation =
      pathPoint && pathOrigin
        ? subtract(pathPoint, pathOrigin)
        : run.distributionVector
          ? scale(run.distributionVector, distance)
          : null;
    const fraction =
      positions.length <= 1 ? 1 : index / (positions.length - 1);
    const lines = run.lines.map((line) => ({
      ...line,
      points: line.points.map((point) => {
        return translation
          ? add(point, translation)
          : {
              ...point,
              [run.axis]: position + lapOffset,
            };
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

  const splay = run.advanced?.splay;
  if (
    !splay ||
    !sourceNormal ||
    !sourceOrigin ||
    !targetNormal ||
    !targetOrigin ||
    !linearInstances.length
  ) {
    return linearInstances;
  }

  const requestedCount =
    splay.scope === "all"
      ? linearInstances.length
      : Math.max(
          1,
          Math.min(
            linearInstances.length,
            Math.round(splay.count ?? 1),
          ),
        );
  const firstSplayedIndex =
    splay.scope === "all" ? 0 : linearInstances.length - requestedCount;
  const layout = planeIntersection(
    sourceNormal,
    sourceOrigin,
    targetNormal,
    targetOrigin,
  );
  if (!layout) return linearInstances;
  const firstSplayedPosition = positions[firstSplayedIndex] ?? 0;
  const angleStartPosition =
    splay.scope === "last" && firstSplayedIndex > 0
      ? positions[firstSplayedIndex - 1]
      : firstSplayedPosition;
  const lastSplayedPosition =
    positions[positions.length - 1] ?? firstSplayedPosition;
  const splayedSpan = lastSplayedPosition - angleStartPosition;
  return linearInstances.map((lines, index) => {
    if (index < firstSplayedIndex) return lines;
    const anchor = instanceAnchors[index];
    if (!anchor) return lines;
    const amount =
      requestedCount <= 1 || splayedSpan <= 1e-12
        ? 1
        : (positions[index] - angleStartPosition) / splayedSpan;
    return lines.map((line) => ({
      ...line,
      points: line.points.map((point) =>
        rotateAroundLine(
          point,
          anchor,
          layout.direction,
          layout.angle * amount,
        ),
      ),
    }));
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
