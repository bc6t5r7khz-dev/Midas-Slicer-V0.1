import type { RebarLine, Vec3 } from "./types";

export type SectionLine = {
  start: Vec3;
  end: Vec3;
};

export type SectionCircle = {
  center: Vec3;
};

export type SectionRebarGeometry = {
  projectedLines: SectionLine[];
  circles: SectionCircle[];
  /** A bar with both in-plane and depth-travelling legs. */
  mixed: boolean;
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

const removeOverlappingShorterLines = (
  lines: SectionLine[],
  tolerance: number,
) => {
  const ordered = [...lines].sort(
    (first, second) =>
      length(subtract(second.end, second.start)) -
      length(subtract(first.end, first.start)),
  );
  const kept: SectionLine[] = [];
  for (const candidate of ordered) {
    const candidateDelta = subtract(candidate.end, candidate.start);
    const candidateLength = length(candidateDelta);
    if (candidateLength <= tolerance) continue;
    const candidateDirection = normalize(candidateDelta);
    const hiddenByLonger = kept.some((longer) => {
      const longerDelta = subtract(longer.end, longer.start);
      const longerLength = length(longerDelta);
      if (longerLength + tolerance < candidateLength) return false;
      const longerDirection = normalize(longerDelta);
      if (Math.abs(dot(candidateDirection, longerDirection)) < 0.9995) {
        return false;
      }
      const distanceFromLonger = (point: Vec3) => {
        const offset = subtract(point, longer.start);
        return length(
          subtract(offset, scale(longerDirection, dot(offset, longerDirection))),
        );
      };
      const lineTolerance = Math.max(tolerance * 20, longerLength * 1e-5);
      if (
        distanceFromLonger(candidate.start) > lineTolerance ||
        distanceFromLonger(candidate.end) > lineTolerance
      ) {
        return false;
      }
      const first = dot(subtract(candidate.start, longer.start), longerDirection);
      const second = dot(subtract(candidate.end, longer.start), longerDirection);
      const overlap =
        Math.min(longerLength, Math.max(first, second)) -
        Math.max(0, Math.min(first, second));
      return overlap > tolerance;
    });
    if (!hiddenByLonger) kept.push(candidate);
  }
  return kept;
};

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
  preferredUpInput: Vec3 = { x: 0, y: 0, z: 1 },
): SectionRebarGeometry {
  const normal = normalize(planeNormalInput);
  const depth = Math.max(throwDepthModelUnits, 0);
  const projectedLines: SectionLine[] = [];
  const circles: SectionCircle[] = [];
  const tolerance = Math.max(depth * 1e-8, 1e-8);
  const addCircle = (center: Vec3) => {
    if (
      !circles.some(
        (candidate) =>
          length(subtract(candidate.center, center)) <= tolerance * 10,
      )
    ) {
      circles.push({ center });
    }
  };

  type Segment = {
    start: Vec3;
    end: Vec3;
    lineIndex: number;
    segmentIndex: number;
    projectedStart: Vec3;
    projectedEnd: Vec3;
    startDistance: number;
    endDistance: number;
    normalAlignment: number;
    depthTravelling: boolean;
  };
  const segments: Segment[] = [];
  lines.forEach((line, lineIndex) => {
    const segmentCount =
      line.points.length - 1 + (line.closed && line.points.length > 2 ? 1 : 0);
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      const start = line.points[segmentIndex];
      const end = line.points[(segmentIndex + 1) % line.points.length];
      const startDistance = dot(subtract(start, planeOrigin), normal);
      const endDistance = dot(subtract(end, planeOrigin), normal);
      const segmentLength = length(subtract(end, start));
      const normalAlignment = segmentLength > tolerance
        ? Math.abs(endDistance - startDistance) / segmentLength
        : 0;
      segments.push({
        start,
        end,
        lineIndex,
        segmentIndex,
        projectedStart: projectToPlane(start, planeOrigin, normal),
        projectedEnd: projectToPlane(end, planeOrigin, normal),
        startDistance,
        endDistance,
        normalAlignment,
        depthTravelling: normalAlignment >= 0.5,
      });
    }
  });

  const mixed =
    segments.some((segment) => segment.depthTravelling) &&
    segments.some(
      (segment) =>
        !segment.depthTravelling &&
        length(subtract(segment.projectedEnd, segment.projectedStart)) > tolerance,
    );

  const relevantToCut = segments.some((segment) => {
    const distanceDelta = segment.endDistance - segment.startDistance;
    const crossesCut =
      Math.abs(distanceDelta) > tolerance &&
      ((segment.startDistance <= tolerance &&
        segment.endDistance >= -tolerance) ||
        (segment.endDistance <= tolerance &&
          segment.startDistance >= -tolerance));
    return Boolean(
      crossesCut ||
        clipSegmentToDepth(
          segment.start,
          segment.end,
          segment.startDistance,
          segment.endDistance,
          depth,
        ),
    );
  });
  if (!relevantToCut) {
    return { projectedLines, circles, mixed: false };
  }

  // Elevation details commonly contain a leg in the drawing plane followed by
  // a leg travelling into the page. For that mixed case, project the complete
  // representative bar rather than clipping it at the section throw depth.
  // Depth transitions remain dots; a depth-travelling leg also remains a line
  // when its visible rise/fall exceeds ten degrees from drawing horizontal.
  if (mixed) {
    const axes = sectionPlaneAxes(normal, preferredUpInput);
    const tenDegrees = (10 * Math.PI) / 180;
    for (const segment of segments) {
      const projectedDelta = subtract(
        segment.projectedEnd,
        segment.projectedStart,
      );
      const projectedLength = length(projectedDelta);
      if (!segment.depthTravelling) {
        if (projectedLength > tolerance) {
          projectedLines.push({
            start: segment.projectedStart,
            end: segment.projectedEnd,
          });
        }
        continue;
      }

      const siblings = segments.filter(
        (candidate) => candidate.lineIndex === segment.lineIndex,
      );
      const previous = siblings.find(
        (candidate) => candidate.segmentIndex === segment.segmentIndex - 1,
      );
      const next = siblings.find(
        (candidate) => candidate.segmentIndex === segment.segmentIndex + 1,
      );
      if (previous && !previous.depthTravelling) {
        addCircle(segment.projectedStart);
      } else if (next && !next.depthTravelling) {
        addCircle(segment.projectedEnd);
      } else {
        addCircle(
          Math.abs(segment.startDistance) <= Math.abs(segment.endDistance)
            ? segment.projectedStart
            : segment.projectedEnd,
        );
      }

      if (projectedLength <= tolerance) continue;
      const horizontal = Math.abs(dot(projectedDelta, axes.right));
      const vertical = Math.abs(dot(projectedDelta, axes.up));
      const visibleAngle = Math.atan2(vertical, horizontal);
      if (visibleAngle > tenDegrees) {
        projectedLines.push({
          start: segment.projectedStart,
          end: segment.projectedEnd,
        });
      }
    }
    return {
      projectedLines: removeOverlappingShorterLines(projectedLines, tolerance),
      circles,
      mixed,
    };
  }

  for (const segment of segments) {
      const { start, end, startDistance, endDistance } = segment;
      const distanceDelta = endDistance - startDistance;
      const crossesCut =
        Math.abs(distanceDelta) > tolerance &&
        ((startDistance <= tolerance && endDistance >= -tolerance) ||
          (endDistance <= tolerance && startDistance >= -tolerance));
      if (crossesCut) {
        const amount = Math.max(
          0,
          Math.min(1, -startDistance / distanceDelta),
        );
        addCircle(lerp(start, end, amount));
        // A segment passing through the cut is represented by its section
        // marker only. Flattening that same segment onto the plane produces a
        // misleading dash (or a long protruding line for an oblique bar).
        continue;
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
      const normalAlignment = segment.normalAlignment;
      if (normalAlignment >= 0.5) {
        const clippedStartDistance = Math.abs(
          dot(subtract(clipped[0], planeOrigin), normal),
        );
        const clippedEndDistance = Math.abs(
          dot(subtract(clipped[1], planeOrigin), normal),
        );
        addCircle(
          clippedStartDistance <= clippedEndDistance
            ? projectedStart
            : projectedEnd,
        );
        continue;
      }
      if (length(subtract(projectedEnd, projectedStart)) > tolerance) {
        projectedLines.push({
          start: projectedStart,
          end: projectedEnd,
        });
      }
  }
  return { projectedLines, circles, mixed };
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
