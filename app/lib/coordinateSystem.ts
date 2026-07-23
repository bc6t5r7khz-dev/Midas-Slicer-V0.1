import type { Bounds, LocalBasis, ModelNode, Vec3 } from "./types";

const EPSILON = 1e-10;

const subtract = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

const normalize = (v: Vec3): Vec3 => {
  const length = Math.sqrt(dot(v, v));
  if (length < EPSILON) throw new Error("Selected nodes are too close together.");
  return { x: v.x / length, y: v.y / length, z: v.z / length };
};

export function createLocalBasis(
  origin: Vec3,
  axisPoint: Vec3,
  planePoint: Vec3,
): LocalBasis {
  const xAxis = normalize(subtract(axisPoint, origin));
  const planeVector = subtract(planePoint, origin);
  const projection = dot(planeVector, xAxis);
  const transverse = {
    x: planeVector.x - projection * xAxis.x,
    y: planeVector.y - projection * xAxis.y,
    z: planeVector.z - projection * xAxis.z,
  };
  const yAxis = normalize(transverse);
  const zAxis = normalize(cross(xAxis, yAxis));
  return { origin, xAxis, yAxis, zAxis };
}

export function toLocal(point: Vec3, basis: LocalBasis): Vec3 {
  const relative = subtract(point, basis.origin);
  return {
    x: dot(relative, basis.xAxis),
    y: dot(relative, basis.yAxis),
    z: dot(relative, basis.zAxis),
  };
}

export function transformNodes(
  nodes: ModelNode[],
  basis: LocalBasis,
): ModelNode[] {
  return nodes.map((node) => ({
    ...node,
    local: toLocal(node.global, basis),
  }));
}

export function getBounds(nodes: ModelNode[], useLocal = true): Bounds {
  const values = nodes.map((node) =>
    useLocal && node.local ? node.local : node.global,
  );
  return values.reduce<Bounds>(
    (bounds, value) => ({
      x: [Math.min(bounds.x[0], value.x), Math.max(bounds.x[1], value.x)],
      y: [Math.min(bounds.y[0], value.y), Math.max(bounds.y[1], value.y)],
      z: [Math.min(bounds.z[0], value.z), Math.max(bounds.z[1], value.z)],
    }),
    {
      x: [Infinity, -Infinity],
      y: [Infinity, -Infinity],
      z: [Infinity, -Infinity],
    },
  );
}
