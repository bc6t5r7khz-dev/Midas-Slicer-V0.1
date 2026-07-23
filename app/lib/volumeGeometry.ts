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

export function createFace(
  id: string,
  label: string,
  nodes: Array<{ id: number; point: Vec3 }>,
  cloudCenter: Vec3,
  tolerance: number,
): VolumeFace {
  if (nodes.length < 3 || nodes.length > 4) {
    throw new Error("A face needs three or four nodes.");
  }

  let normal = normalize(
    cross(
      subtract(nodes[1].point, nodes[0].point),
      subtract(nodes[2].point, nodes[0].point),
    ),
  );
  let constant = -dot(normal, nodes[0].point);

  for (const node of nodes.slice(3)) {
    if (Math.abs(dot(normal, node.point) + constant) > tolerance) {
      throw new Error("The selected nodes are not coplanar.");
    }
  }

  // Orient the plane so the model centroid lies on the inside side.
  if (dot(normal, cloudCenter) + constant > 0) {
    normal = scale(normal, -1);
    constant *= -1;
  }

  return {
    id,
    label,
    nodeIds: nodes.map((node) => node.id),
    vertices: sortCoplanarPoints(
      nodes.map((node) => node.point),
      normal,
    ),
    plane: { normal, constant },
  };
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
