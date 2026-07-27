import type { LocalBasis, ModelNode, Vec3, VolumeFace } from "./types";
import {
  centroid,
  coplanarConvexHull,
  cross,
  dot,
  normalize,
  scale,
  subtract,
} from "./volumeGeometry";

export type SmartAxis = "x" | "y" | "z";

const squaredDistance = (a: Vec3, b: Vec3) =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 1;
};

function orientPlane(
  normal: Vec3,
  seed: Vec3,
  nodes: ModelNode[],
): { normal: Vec3; constant: number } {
  let nextNormal = normal;
  let constant = -dot(nextNormal, seed);
  const center = centroid(nodes.map((node) => node.global));
  if (dot(nextNormal, center) + constant > 0) {
    nextNormal = scale(nextNormal, -1);
    constant *= -1;
  }
  return { normal: nextNormal, constant };
}

function faceFromPatch(
  nodes: ModelNode[],
  patch: ModelNode[],
  normal: Vec3,
): VolumeFace {
  const vertices = coplanarConvexHull(
    patch.map((node) => node.global),
    normal,
  );
  const nodeByPoint = new Map(patch.map((node) => [node.global, node.id]));
  const nodeIds = vertices
    .map((vertex) => nodeByPoint.get(vertex))
    .filter((id): id is number => id !== undefined);
  if (vertices.length < 3 || nodeIds.length !== vertices.length) {
    throw new Error("This method could not trace a usable node boundary.");
  }
  return {
    id: "smart-preview",
    label: "Smart preview",
    nodeIds,
    vertices,
    plane: orientPlane(normal, vertices[0], nodes),
    smart: true,
  };
}

function localPlane(
  nodes: ModelNode[],
  seedId: number,
  tolerance: number,
  scoreAllNodes: boolean,
): { normal: Vec3; planeTolerance: number; seed: ModelNode } {
  const seed = nodes.find((node) => node.id === seedId);
  if (!seed) throw new Error("The hovered node cannot seed a face.");
  const nearest = nodes
    .filter((node) => node.id !== seedId)
    .map((node) => ({
      node,
      distance: Math.sqrt(squaredDistance(node.global, seed.global)),
    }))
    .filter(({ distance }) => distance > 0)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 96);
  if (nearest.length < 3) throw new Error("Not enough neighboring nodes.");

  const spacing = median(nearest.slice(0, 10).map(({ distance }) => distance));
  const planeTolerance = Math.max(tolerance * 8, spacing * 0.018);
  const pairPool = nearest.slice(0, 22);
  const support = scoreAllNodes
    ? nodes.filter(
        (_, index) =>
          index % Math.max(1, Math.ceil(nodes.length / 5000)) === 0,
      )
    : nearest.slice(0, 72).map(({ node }) => node);
  let best: { normal: Vec3; score: number } | null = null;

  for (let first = 0; first < pairPool.length - 1; first += 1) {
    for (let second = first + 1; second < pairPool.length; second += 1) {
      let normal: Vec3;
      try {
        normal = normalize(
          cross(
            subtract(pairPool[first].node.global, seed.global),
            subtract(pairPool[second].node.global, seed.global),
          ),
        );
      } catch {
        continue;
      }
      const constant = -dot(normal, seed.global);
      let inliers = 0;
      let residual = 0;
      for (const node of support) {
        const distance = Math.abs(dot(normal, node.global) + constant);
        if (distance <= planeTolerance) inliers += 1;
        residual += Math.min(distance / planeTolerance, 4);
      }
      const score = inliers * 20 - residual;
      if (!best || score > best.score) best = { normal, score };
    }
  }
  if (!best) throw new Error("No stable local plane was found.");
  return { normal: best.normal, planeTolerance, seed };
}

/** Smart Select 1: traces every node on a local/global coordinate slice. */
export function axisSliceFaceFromSeed(
  nodes: ModelNode[],
  seedId: number,
  tolerance: number,
  axis: SmartAxis,
  basis: LocalBasis | null,
): VolumeFace {
  const seed = nodes.find((node) => node.id === seedId);
  if (!seed) throw new Error("The hovered node cannot seed a face.");
  const coordinate = (node: ModelNode) =>
    (basis ? node.local : node.global)?.[axis] ?? node.global[axis];
  const seedCoordinate = coordinate(seed);
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const node of nodes) {
    const value = coordinate(node);
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const span = maximum - minimum;
  const planeTolerance = Math.max(tolerance * 8, span * 1e-8);
  const patch = nodes.filter(
    (node) => Math.abs(coordinate(node) - seedCoordinate) <= planeTolerance,
  );
  const normal = basis
    ? basis[`${axis}Axis` as "xAxis" | "yAxis" | "zAxis"]
    : {
        x: axis === "x" ? 1 : 0,
        y: axis === "y" ? 1 : 0,
        z: axis === "z" ? 1 : 0,
      };
  return faceFromPatch(nodes, patch, normal);
}

/** Smart Select 2: fits a small tangent patch around the hovered node. */
export function localPatchFaceFromSeed(
  nodes: ModelNode[],
  seedId: number,
  tolerance: number,
): VolumeFace {
  const fitted = localPlane(nodes, seedId, tolerance, false);
  const patch = nodes
    .map((node) => ({
      node,
      distance: squaredDistance(node.global, fitted.seed.global),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 120)
    .filter(
      ({ node }) =>
        Math.abs(
          dot(fitted.normal, subtract(node.global, fitted.seed.global)),
        ) <= fitted.planeTolerance,
    )
    .map(({ node }) => node);
  return faceFromPatch(nodes, patch, fitted.normal);
}

/** Smart Select 3: fits locally, then traces the complete matching plane. */
export function fullPlaneFaceFromSeed(
  nodes: ModelNode[],
  seedId: number,
  tolerance: number,
): VolumeFace {
  const fitted = localPlane(nodes, seedId, tolerance, true);
  const patch = nodes.filter(
    (node) =>
      Math.abs(
        dot(fitted.normal, subtract(node.global, fitted.seed.global)),
      ) <= fitted.planeTolerance,
  );
  return faceFromPatch(nodes, patch, fitted.normal);
}
