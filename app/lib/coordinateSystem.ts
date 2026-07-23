import type {
  Bounds,
  LocalBasis,
  ModelNode,
  PlaneDefinition,
  Vec3,
} from "./types";
import { cross, dot, normalize, subtract } from "./volumeGeometry";

export function createBasisFromFloor(
  origin: Vec3,
  axisPoint: Vec3,
  floorPlane: PlaneDefinition,
): LocalBasis {
  // Face normals point out of the volume; the floor's inward direction is +Z.
  const zAxis = normalize({
    x: -floorPlane.normal.x,
    y: -floorPlane.normal.y,
    z: -floorPlane.normal.z,
  });
  const rawX = subtract(axisPoint, origin);
  const zProjection = dot(rawX, zAxis);
  const xAxis = normalize({
    x: rawX.x - zProjection * zAxis.x,
    y: rawX.y - zProjection * zAxis.y,
    z: rawX.z - zProjection * zAxis.z,
  });
  const yAxis = normalize(cross(zAxis, xAxis));
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

export function transformPlane(
  plane: PlaneDefinition,
  basis: LocalBasis,
): PlaneDefinition {
  return {
    normal: {
      x: dot(plane.normal, basis.xAxis),
      y: dot(plane.normal, basis.yAxis),
      z: dot(plane.normal, basis.zAxis),
    },
    constant: dot(plane.normal, basis.origin) + plane.constant,
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
