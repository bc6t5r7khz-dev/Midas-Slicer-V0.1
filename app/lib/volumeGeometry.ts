import type {
  Bounds,
  PlaneDefinition,
  Polyhedron,
  Vec3,
  VolumeFace,
} from "./types";

const EPSILON = 1e-8;

export const add = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});

export const subtract = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

export const scale = (v: Vec3, amount: number): Vec3 => ({
  x: v.x * amount,
  y: v.y * amount,
  z: v.z * amount,
});

export const dot = (a: Vec3, b: Vec3) =>
  a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const length = (v: Vec3) => Math.sqrt(dot(v, v));

export const normalize = (v: Vec3): Vec3 => {
  const magnitude = length(v);
  if (magnitude < EPSILON) {
    throw new Error("The selected points do not define a usable direction.");
  }
  return scale(v, 1 / magnitude);
};

export const centroid = (points: Vec3[]): Vec3 =>
  scale(
    points.reduce((sum, point) => add(sum, point), { x: 0, y: 0, z: 0 }),
    1 / Math.max(points.length, 1),
  );

export const planeDistance = (plane: PlaneDefinition, point: Vec3) =>
  dot(plane.normal, point) + plane.constant;

export function modelTolerance(bounds: Bounds): number {
  const diagonal = Math.hypot(
    bounds.x[1] - bounds.x[0],
    bounds.y[1] - bounds.y[0],
    bounds.z[1] - bounds.z[0],
  );
  return Math.max(diagonal * 1e-5, 1e-7);
}

function basisOnPlane(normal: Vec3): [Vec3, Vec3] {
  const helper =
    Math.abs(normal.z) < 0.8
      ? { x: 0, y: 0, z: 1 }
      : { x: 0, y: 1, z: 0 };
  const u = normalize(cross(helper, normal));
  return [u, normalize(cross(normal, u))];
}

export function sortCoplanarPoints(points: Vec3[], normal: Vec3): Vec3[] {
  const center = centroid(points);
  const [u, v] = basisOnPlane(normal);
  return [...points].sort((a, b) => {
    const aRelative = subtract(a, center);
    const bRelative = subtract(b, center);
    return (
      Math.atan2(dot(aRelative, v), dot(aRelative, u)) -
      Math.atan2(dot(bRelative, v), dot(bRelative, u))
    );
  });
}

type ProjectedPoint = {
  point: Vec3;
  x: number;
  y: number;
};

function cross2D(
  origin: Pick<ProjectedPoint, "x" | "y">,
  a: Pick<ProjectedPoint, "x" | "y">,
  b: Pick<ProjectedPoint, "x" | "y">,
) {
  return (a.x - origin.x) * (b.y - origin.y) -
    (a.y - origin.y) * (b.x - origin.x);
}

/** Returns the outer boundary of coplanar points in counter-clockwise order. */
export function coplanarConvexHull(points: Vec3[], normal: Vec3): Vec3[] {
  const [u, v] = basisOnPlane(normal);
  const projected: ProjectedPoint[] = points.map((point) => ({
    point,
    x: dot(point, u),
    y: dot(point, v),
  }));
  projected.sort((a, b) => a.x - b.x || a.y - b.y);

  const unique = projected.filter(
    (point, index) =>
      index === 0 ||
      Math.abs(point.x - projected[index - 1].x) > EPSILON ||
      Math.abs(point.y - projected[index - 1].y) > EPSILON,
  );
  if (unique.length <= 3) return unique.map(({ point }) => point);

  const lower: ProjectedPoint[] = [];
  for (const point of unique) {
    while (
      lower.length >= 2 &&
      cross2D(lower[lower.length - 2], lower[lower.length - 1], point) <=
        EPSILON
    ) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper: ProjectedPoint[] = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index];
    while (
      upper.length >= 2 &&
      cross2D(upper[upper.length - 2], upper[upper.length - 1], point) <=
        EPSILON
    ) {
      upper.pop();
    }
    upper.push(point);
  }

  return [...lower.slice(0, -1), ...upper.slice(0, -1)].map(
    ({ point }) => point,
  );
}

function polygonNormal(points: Vec3[]): Vec3 {
  const sum = { x: 0, y: 0, z: 0 };
  for (
    let current = 0, previous = points.length - 1;
    current < points.length;
    previous = current, current += 1
  ) {
    const a = points[previous];
    const b = points[current];
    sum.x += (a.y - b.y) * (a.z + b.z);
    sum.y += (a.z - b.z) * (a.x + b.x);
    sum.z += (a.x - b.x) * (a.y + b.y);
  }
  return normalize(sum);
}

function segmentsIntersect2D(
  a: Pick<ProjectedPoint, "x" | "y">,
  b: Pick<ProjectedPoint, "x" | "y">,
  c: Pick<ProjectedPoint, "x" | "y">,
  d: Pick<ProjectedPoint, "x" | "y">,
): boolean {
  const abC = cross2D(a, b, c);
  const abD = cross2D(a, b, d);
  const cdA = cross2D(c, d, a);
  const cdB = cross2D(c, d, b);
  return (
    ((abC > EPSILON && abD < -EPSILON) ||
      (abC < -EPSILON && abD > EPSILON)) &&
    ((cdA > EPSILON && cdB < -EPSILON) ||
      (cdA < -EPSILON && cdB > EPSILON))
  );
}

function validateOrderedBoundary(
  points: Vec3[],
  normal: Vec3,
): void {
  const [u, v] = basisOnPlane(normal);
  const polygon = points.map((point) => ({
    point,
    x: dot(point, u),
    y: dot(point, v),
  }));

  for (let first = 0; first < polygon.length; first += 1) {
    const firstNext = (first + 1) % polygon.length;
    for (let second = first + 1; second < polygon.length; second += 1) {
      const secondNext = (second + 1) % polygon.length;
      if (
        first === second ||
        firstNext === second ||
        secondNext === first
      ) {
        continue;
      }
      if (
        segmentsIntersect2D(
          polygon[first],
          polygon[firstNext],
          polygon[second],
          polygon[secondNext],
        )
      ) {
        throw new Error(
          "The boundary lines cross. Use Backspace and trace the perimeter in order.",
        );
      }
    }
  }
}

export function createFace(
  id: string,
  label: string,
  nodes: Array<{ id: number; point: Vec3 }>,
  cloudCenter: Vec3,
  tolerance: number,
): VolumeFace {
  if (nodes.length < 3) {
    throw new Error("A face needs at least three nodes.");
  }

  const orderedPoints = nodes.map((node) => node.point);
  let normal = polygonNormal(orderedPoints);
  let constant = -dot(normal, nodes[0].point);

  for (const node of nodes.slice(1)) {
    if (Math.abs(dot(normal, node.point) + constant) > tolerance) {
      throw new Error("The selected nodes are not coplanar.");
    }
  }
  validateOrderedBoundary(orderedPoints, normal);

  // Orient the plane so the model centroid lies on the inside side.
  if (dot(normal, cloudCenter) + constant > 0) {
    normal = scale(normal, -1);
    constant *= -1;
  }

  return {
    id,
    label,
    nodeIds: nodes.map((node) => node.id),
    vertices: orderedPoints,
    plane: { normal, constant },
  };
}

/**
 * Accepts a slightly warped ordered boundary by fitting one plane through its
 * centroid, then projecting the display polygon onto that plane. The original
 * node IDs remain attached to the face.
 */
export function createFittedFace(
  id: string,
  label: string,
  nodes: Array<{ id: number; point: Vec3 }>,
  cloudCenter: Vec3,
): VolumeFace {
  if (nodes.length < 3) {
    throw new Error("A face needs at least three nodes.");
  }
  const sourcePoints = nodes.map((node) => node.point);
  let normal = polygonNormal(sourcePoints);
  const faceCenter = centroid(sourcePoints);
  let constant = -dot(normal, faceCenter);
  let fitDeviation = 0;
  for (const point of sourcePoints) {
    fitDeviation = Math.max(
      fitDeviation,
      Math.abs(dot(normal, point) + constant),
    );
  }
  const vertices = sourcePoints.map((point) => {
    const distance = dot(normal, point) + constant;
    return subtract(point, scale(normal, distance));
  });
  validateOrderedBoundary(vertices, normal);

  if (dot(normal, cloudCenter) + constant > 0) {
    normal = scale(normal, -1);
    constant *= -1;
  }
  return {
    id,
    label,
    nodeIds: nodes.map((node) => node.id),
    vertices,
    plane: { normal, constant },
    fitted: true,
    fitDeviation,
  };
}

/**
 * Tests the finite polygon, not the infinite plane. This keeps distant
 * coplanar patches visible when a manually defined face peels the point cloud.
 */
export function isPointWithinFace(
  point: Vec3,
  face: Pick<VolumeFace, "vertices" | "plane">,
  tolerance: number,
): boolean {
  if (
    face.vertices.length < 3 ||
    Math.abs(planeDistance(face.plane, point)) > tolerance
  ) {
    return false;
  }

  const [u, v] = basisOnPlane(face.plane.normal);
  const polygon = face.vertices.map((vertex) => ({
    x: dot(vertex, u),
    y: dot(vertex, v),
  }));
  const target = { x: dot(point, u), y: dot(point, v) };

  let inside = false;
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current, current += 1
  ) {
    const a = polygon[previous];
    const b = polygon[current];
    const edgeX = b.x - a.x;
    const edgeY = b.y - a.y;
    const edgeLengthSquared = edgeX * edgeX + edgeY * edgeY;
    const projection =
      edgeLengthSquared > EPSILON
        ? Math.max(
            0,
            Math.min(
              1,
              ((target.x - a.x) * edgeX + (target.y - a.y) * edgeY) /
                edgeLengthSquared,
            ),
          )
        : 0;
    if (
      Math.hypot(
        target.x - (a.x + projection * edgeX),
        target.y - (a.y + projection * edgeY),
      ) <= tolerance
    ) {
      return true;
    }

    const crosses =
      (a.y > target.y) !== (b.y > target.y) &&
      target.x <
        ((b.x - a.x) * (target.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * Identifies points on the finite polygon perimeter, including intermediate
 * nodes along an edge rather than only the vertices used to define that edge.
 */
export function isPointOnFaceBoundary(
  point: Vec3,
  face: Pick<VolumeFace, "vertices" | "plane">,
  tolerance: number,
): boolean {
  if (
    face.vertices.length < 2 ||
    Math.abs(planeDistance(face.plane, point)) > tolerance
  ) {
    return false;
  }

  for (
    let current = 0, previous = face.vertices.length - 1;
    current < face.vertices.length;
    previous = current, current += 1
  ) {
    const start = face.vertices[previous];
    const end = face.vertices[current];
    const edge = subtract(end, start);
    const edgeLengthSquared = dot(edge, edge);
    const amount =
      edgeLengthSquared > EPSILON
        ? Math.max(
            0,
            Math.min(1, dot(subtract(point, start), edge) / edgeLengthSquared),
          )
        : 0;
    const closest = add(start, scale(edge, amount));
    if (length(subtract(point, closest)) <= tolerance * 2) return true;
  }
  return false;
}

function intersectPlanes(
  a: PlaneDefinition,
  b: PlaneDefinition,
  c: PlaneDefinition,
): Vec3 | null {
  const bCrossC = cross(b.normal, c.normal);
  const determinant = dot(a.normal, bCrossC);
  if (Math.abs(determinant) < EPSILON) return null;

  return scale(
    add(
      add(
        scale(bCrossC, -a.constant),
        scale(cross(c.normal, a.normal), -b.constant),
      ),
      scale(cross(a.normal, b.normal), -c.constant),
    ),
    1 / determinant,
  );
}

function uniquePoints(points: Vec3[], tolerance: number): Vec3[] {
  const unique: Vec3[] = [];
  for (const point of points) {
    if (
      !unique.some(
        (candidate) => length(subtract(point, candidate)) <= tolerance,
      )
    ) {
      unique.push(point);
    }
  }
  return unique;
}

export function buildPolyhedron(
  planes: PlaneDefinition[],
  tolerance: number,
  requireAllPlanes = true,
): Polyhedron | null {
  const intersections: Vec3[] = [];

  for (let i = 0; i < planes.length - 2; i += 1) {
    for (let j = i + 1; j < planes.length - 1; j += 1) {
      for (let k = j + 1; k < planes.length; k += 1) {
        const point = intersectPlanes(planes[i], planes[j], planes[k]);
        if (
          point &&
          planes.every((plane) => planeDistance(plane, point) <= tolerance)
        ) {
          intersections.push(point);
        }
      }
    }
  }

  const vertices = uniquePoints(intersections, tolerance * 5);
  if (vertices.length < 4) return null;

  const faces = planes
    .map((plane, planeIndex) => {
      const faceVertices = vertices.filter(
        (point) => Math.abs(planeDistance(plane, point)) <= tolerance * 5,
      );
      return {
        planeIndex,
        vertices:
          faceVertices.length >= 3
            ? sortCoplanarPoints(faceVertices, plane.normal)
            : [],
      };
    })
    .filter((face) => face.vertices.length >= 3);

  // Every supplied plane must contribute a polygon for the volume to be closed.
  if (
    faces.length < 4 ||
    (requireAllPlanes && faces.length !== planes.length)
  ) {
    return null;
  }
  return { faces, vertices };
}

export const isInsidePlanes = (
  point: Vec3,
  planes: PlaneDefinition[],
  tolerance: number,
) => planes.every((plane) => planeDistance(plane, point) <= tolerance);

/** Clips one polygon against a collection of half-spaces. */
export function clipPolygonToPlanes(
  vertices: Vec3[],
  planes: PlaneDefinition[],
  tolerance: number,
): Vec3[] {
  let polygon = [...vertices];
  for (const plane of planes) {
    if (!polygon.length) break;
    const clipped: Vec3[] = [];
    for (
      let currentIndex = 0, previousIndex = polygon.length - 1;
      currentIndex < polygon.length;
      previousIndex = currentIndex, currentIndex += 1
    ) {
      const previous = polygon[previousIndex];
      const current = polygon[currentIndex];
      const previousDistance = planeDistance(plane, previous);
      const currentDistance = planeDistance(plane, current);
      const previousInside = previousDistance <= tolerance;
      const currentInside = currentDistance <= tolerance;

      if (previousInside !== currentInside) {
        const denominator = previousDistance - currentDistance;
        if (Math.abs(denominator) > EPSILON) {
          const amount = previousDistance / denominator;
          clipped.push({
            x: previous.x + (current.x - previous.x) * amount,
            y: previous.y + (current.y - previous.y) * amount,
            z: previous.z + (current.z - previous.z) * amount,
          });
        }
      }
      if (currentInside) clipped.push(current);
    }
    polygon = clipped;
  }
  return polygon;
}

export function slicePlanes(bounds: Bounds): PlaneDefinition[] {
  return [
    { normal: { x: -1, y: 0, z: 0 }, constant: bounds.x[0] },
    { normal: { x: 1, y: 0, z: 0 }, constant: -bounds.x[1] },
    { normal: { x: 0, y: -1, z: 0 }, constant: bounds.y[0] },
    { normal: { x: 0, y: 1, z: 0 }, constant: -bounds.y[1] },
    { normal: { x: 0, y: 0, z: -1 }, constant: bounds.z[0] },
    { normal: { x: 0, y: 0, z: 1 }, constant: -bounds.z[1] },
  ];
}

export function autoBoxFaces(bounds: Bounds): VolumeFace[] {
  const [xmin, xmax] = bounds.x;
  const [ymin, ymax] = bounds.y;
  const [zmin, zmax] = bounds.z;
  const specifications: Array<{
    label: string;
    plane: PlaneDefinition;
    vertices: Vec3[];
  }> = [
    {
      label: "West",
      plane: { normal: { x: -1, y: 0, z: 0 }, constant: xmin },
      vertices: [
        { x: xmin, y: ymin, z: zmin },
        { x: xmin, y: ymax, z: zmin },
        { x: xmin, y: ymax, z: zmax },
        { x: xmin, y: ymin, z: zmax },
      ],
    },
    {
      label: "East",
      plane: { normal: { x: 1, y: 0, z: 0 }, constant: -xmax },
      vertices: [
        { x: xmax, y: ymin, z: zmin },
        { x: xmax, y: ymin, z: zmax },
        { x: xmax, y: ymax, z: zmax },
        { x: xmax, y: ymax, z: zmin },
      ],
    },
    {
      label: "South",
      plane: { normal: { x: 0, y: -1, z: 0 }, constant: ymin },
      vertices: [
        { x: xmin, y: ymin, z: zmin },
        { x: xmin, y: ymin, z: zmax },
        { x: xmax, y: ymin, z: zmax },
        { x: xmax, y: ymin, z: zmin },
      ],
    },
    {
      label: "North",
      plane: { normal: { x: 0, y: 1, z: 0 }, constant: -ymax },
      vertices: [
        { x: xmin, y: ymax, z: zmin },
        { x: xmax, y: ymax, z: zmin },
        { x: xmax, y: ymax, z: zmax },
        { x: xmin, y: ymax, z: zmax },
      ],
    },
    {
      label: "Bottom",
      plane: { normal: { x: 0, y: 0, z: -1 }, constant: zmin },
      vertices: [
        { x: xmin, y: ymin, z: zmin },
        { x: xmax, y: ymin, z: zmin },
        { x: xmax, y: ymax, z: zmin },
        { x: xmin, y: ymax, z: zmin },
      ],
    },
    {
      label: "Top",
      plane: { normal: { x: 0, y: 0, z: 1 }, constant: -zmax },
      vertices: [
        { x: xmin, y: ymin, z: zmax },
        { x: xmin, y: ymax, z: zmax },
        { x: xmax, y: ymax, z: zmax },
        { x: xmax, y: ymin, z: zmax },
      ],
    },
  ];

  return specifications.map((specification, index) => ({
    id: `auto-${index + 1}`,
    label: specification.label,
    nodeIds: [],
    vertices: specification.vertices,
    plane: specification.plane,
    automatic: true,
  }));
}
