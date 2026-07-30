import type { RebarLine, Vec3 } from "./types";

export type RebarBendStandard = {
  barNumber: string;
  diameterInches: number;
  minimumInsideBendDiameterInches: number;
  minimumCenterlineRadiusInches: number;
  bendDiameterMultiplier: number;
};

const ASTM_BAR_DIAMETERS_INCHES: Record<string, number> = {
  "3": 0.375,
  "4": 0.5,
  "5": 0.625,
  "6": 0.75,
  "7": 0.875,
  "8": 1,
  "9": 1.128,
  "10": 1.27,
  "11": 1.41,
  "14": 1.693,
  "18": 2.257,
};

const normalizeBarNumber = (barNumber: string | number | null | undefined) =>
  String(barNumber ?? "5").trim().replace(/^#/, "") || "5";

const bendDiameterMultiplier = (barNumber: number) => {
  if (barNumber >= 14) return 10;
  if (barNumber >= 9) return 8;
  return 6;
};

export const STANDARD_REBAR_NUMBERS = Object.keys(
  ASTM_BAR_DIAMETERS_INCHES,
);

export function rebarBendStandard(
  barNumberInput: string | number | null | undefined,
): RebarBendStandard {
  const barNumber = normalizeBarNumber(barNumberInput);
  const numericBarNumber = Number(barNumber);
  const diameterInches =
    ASTM_BAR_DIAMETERS_INCHES[barNumber] ??
    (Number.isFinite(numericBarNumber) && numericBarNumber > 0
      ? numericBarNumber / 8
      : ASTM_BAR_DIAMETERS_INCHES["5"]);
  const multiplier = bendDiameterMultiplier(
    Number.isFinite(numericBarNumber) ? numericBarNumber : 5,
  );
  const minimumInsideBendDiameterInches = diameterInches * multiplier;
  return {
    barNumber,
    diameterInches,
    minimumInsideBendDiameterInches,
    minimumCenterlineRadiusInches:
      (minimumInsideBendDiameterInches + diameterInches) / 2,
    bendDiameterMultiplier: multiplier,
  };
}

export const CRSI_REBAR_BEND_STANDARDS = STANDARD_REBAR_NUMBERS.map(
  rebarBendStandard,
);

const add = (first: Vec3, second: Vec3): Vec3 => ({
  x: first.x + second.x,
  y: first.y + second.y,
  z: first.z + second.z,
});

const subtract = (first: Vec3, second: Vec3): Vec3 => ({
  x: first.x - second.x,
  y: first.y - second.y,
  z: first.z - second.z,
});

const scale = (value: Vec3, amount: number): Vec3 => ({
  x: value.x * amount,
  y: value.y * amount,
  z: value.z * amount,
});

const dot = (first: Vec3, second: Vec3) =>
  first.x * second.x + first.y * second.y + first.z * second.z;

const cross = (first: Vec3, second: Vec3): Vec3 => ({
  x: first.y * second.z - first.z * second.y,
  y: first.z * second.x - first.x * second.z,
  z: first.x * second.y - first.y * second.x,
});

const magnitude = (value: Vec3) => Math.hypot(value.x, value.y, value.z);

const normalize = (value: Vec3) => {
  const length = magnitude(value);
  return length > 1e-12 ? scale(value, 1 / length) : null;
};

const rotateAroundAxis = (value: Vec3, axis: Vec3, angle: number) =>
  add(
    add(
      scale(value, Math.cos(angle)),
      scale(cross(axis, value), Math.sin(angle)),
    ),
    scale(axis, dot(axis, value) * (1 - Math.cos(angle))),
  );

const appendUnique = (points: Vec3[], point: Vec3) => {
  const previous = points[points.length - 1];
  if (!previous || magnitude(subtract(point, previous)) > 1e-9) {
    points.push(point);
  }
};

/**
 * Replaces sharp polyline vertices with tangent circular arcs using the CRSI /
 * ACI standard-hook minimum centerline radius for the selected ASTM bar size.
 * If adjacent legs are too short to fit that radius, the corner remains sharp
 * instead of silently drawing a tighter, noncompliant bend.
 */
export function applyStandardBarBends(
  line: RebarLine,
  barNumber: string | number | null | undefined,
  inchesPerModelUnit: number,
): RebarLine {
  if (line.points.length < 3 || inchesPerModelUnit <= 0) return line;
  const source = line.points;
  const result: Vec3[] = [];
  if (!line.closed) appendUnique(result, source[0]);
  const radius =
    rebarBendStandard(barNumber).minimumCenterlineRadiusInches /
    inchesPerModelUnit;
  const cornerIndexes = line.closed
    ? source.map((_, index) => index)
    : source.slice(1, -1).map((_, index) => index + 1);

  for (const index of cornerIndexes) {
    const previous = source[(index - 1 + source.length) % source.length];
    const vertex = source[index];
    const next = source[(index + 1) % source.length];
    const incoming = normalize(subtract(previous, vertex));
    const outgoing = normalize(subtract(next, vertex));
    if (!incoming || !outgoing) {
      appendUnique(result, vertex);
      continue;
    }
    const cosine = Math.max(-1, Math.min(1, dot(incoming, outgoing)));
    const angle = Math.acos(cosine);
    const planeNormal = normalize(cross(incoming, outgoing));
    const halfTangent = Math.tan(angle / 2);
    const tangentDistance =
      Math.abs(halfTangent) > 1e-9 ? radius / halfTangent : Infinity;
    const previousLength = magnitude(subtract(previous, vertex));
    const nextLength = magnitude(subtract(next, vertex));
    if (
      !planeNormal ||
      angle < 1e-4 ||
      Math.PI - angle < 1e-4 ||
      !Number.isFinite(tangentDistance) ||
      tangentDistance >= previousLength * 0.5 ||
      tangentDistance >= nextLength * 0.5
    ) {
      appendUnique(result, vertex);
      continue;
    }
    const bisector = normalize(add(incoming, outgoing));
    if (!bisector) {
      appendUnique(result, vertex);
      continue;
    }
    const tangentStart = add(vertex, scale(incoming, tangentDistance));
    const tangentEnd = add(vertex, scale(outgoing, tangentDistance));
    const centerDistance = radius / Math.sin(angle / 2);
    const center = add(vertex, scale(bisector, centerDistance));
    const startRadius = subtract(tangentStart, center);
    const endRadius = subtract(tangentEnd, center);
    const sweep = Math.atan2(
      dot(planeNormal, cross(startRadius, endRadius)),
      dot(startRadius, endRadius),
    );
    const steps = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
    appendUnique(result, tangentStart);
    for (let step = 1; step <= steps; step += 1) {
      appendUnique(
        result,
        add(
          center,
          rotateAroundAxis(startRadius, planeNormal, (sweep * step) / steps),
        ),
      );
    }
  }
  if (!line.closed) {
    appendUnique(result, source[source.length - 1]);
  }
  return { ...line, points: result };
}

export function applyStandardBendsToInstance(
  lines: RebarLine[],
  barNumber: string | number | null | undefined,
  inchesPerModelUnit: number,
) {
  return lines.map((line) =>
    applyStandardBarBends(line, barNumber, inchesPerModelUnit),
  );
}
