import type { ModelNode, Vec3, VolumeFace } from "./types";
import {
  centroid,
  coplanarConvexHull,
  cross,
  dot,
  normalize,
  planeDistance,
  scale,
  subtract,
} from "./volumeGeometry";

type Candidate = {
  constant: number;
  normal: Vec3;
  score: number;
};

const squaredDistance = (a: Vec3, b: Vec3) => {
  const x = a.x - b.x;
  const y = a.y - b.y;
  const z = a.z - b.z;
  return x * x + y * y + z * z;
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 1;
};

function connectedCoplanarPatch(
  inliers: ModelNode[],
  seedId: number,
  connectionRadius: number,
): ModelNode[] {
  const cellSize = Math.max(connectionRadius, 1e-9);
  const cells = new Map<string, number[]>();
  const keyFor = (point: Vec3) =>
    `${Math.floor(point.x / cellSize)},${Math.floor(point.y / cellSize)},${Math.floor(point.z / cellSize)}`;

  inliers.forEach((node, index) => {
    const key = keyFor(node.global);
    const cell = cells.get(key);
    if (cell) cell.push(index);
    else cells.set(key, [index]);
  });

  const seedIndex = inliers.findIndex((node) => node.id === seedId);
  if (seedIndex < 0) return [];

  const radiusSquared = connectionRadius * connectionRadius;
  const visited = new Set<number>([seedIndex]);
  const queue = [seedIndex];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const currentIndex = queue[cursor];
    const current = inliers[currentIndex].global;
    const cellX = Math.floor(current.x / cellSize);
    const cellY = Math.floor(current.y / cellSize);
    const cellZ = Math.floor(current.z / cellSize);
    for (let x = cellX - 1; x <= cellX + 1; x += 1) {
      for (let y = cellY - 1; y <= cellY + 1; y += 1) {
        for (let z = cellZ - 1; z <= cellZ + 1; z += 1) {
          for (const index of cells.get(`${x},${y},${z}`) ?? []) {
            if (
              !visited.has(index) &&
              squaredDistance(current, inliers[index].global) <= radiusSquared
            ) {
              visited.add(index);
              queue.push(index);
            }
          }
        }
      }
    }
  }
  return queue.map((index) => inliers[index]);
}

/**
 * Fits an exterior plane through a hovered seed, then grows only through the
 * spatially connected coplanar patch. The resulting finite convex boundary is
 * suitable for previewing and committing with one click.
 */
export function smartFaceFromSeed(
  nodes: ModelNode[],
  seedId: number,
  tolerance: number,
): VolumeFace {
  const seed = nodes.find((node) => node.id === seedId);
  if (!seed || nodes.length < 3) {
    throw new Error("The hovered node cannot seed a face.");
  }

  const nearest = nodes
    .filter((node) => node.id !== seedId)
    .map((node) => ({
      distanceSquared: squaredDistance(node.global, seed.global),
      node,
    }))
    .filter(({ distanceSquared }) => distanceSquared > 0)
    .sort((a, b) => a.distanceSquared - b.distanceSquared)
    .slice(0, 36);
  if (nearest.length < 2) throw new Error("Not enough neighboring nodes.");

  const spacing = median(
    nearest
      .slice(0, Math.min(8, nearest.length))
      .map(({ distanceSquared }) => Math.sqrt(distanceSquared)),
  );
  const planeTolerance = Math.max(tolerance * 8, spacing * 0.015);
  const pairPool = nearest.slice(0, Math.min(22, nearest.length));
  const sampleStep = Math.max(1, Math.ceil(nodes.length / 2400));
  const supportSample = nodes.filter(
    (node, index) => node.id === seedId || index % sampleStep === 0,
  );
  let best: Candidate | null = null;

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
      let constant = -dot(normal, seed.global);

      let positive = 0;
      let negative = 0;
      for (const node of supportSample) {
        const distance = dot(normal, node.global) + constant;
        if (distance > planeTolerance) positive += 1;
        else if (distance < -planeTolerance) negative += 1;
      }
      if (positive > negative) {
        normal = scale(normal, -1);
        constant *= -1;
        [positive, negative] = [negative, positive];
      }

      const allowedOutside = Math.max(1, Math.floor(supportSample.length * 0.006));
      if (positive > allowedOutside) continue;
      const localInliers = pairPool.reduce(
        (count, item) =>
          count +
          (Math.abs(dot(normal, item.node.global) + constant) <= planeTolerance
            ? 1
            : 0),
        1,
      );
      const score = localInliers * 100 - positive * 250;
      if (!best || score > best.score) best = { normal, constant, score };
    }
  }

  if (!best) {
    throw new Error("No exterior planar patch was found here.");
  }

  const inliers = nodes.filter(
    (node) => Math.abs(planeDistance(best, node.global)) <= planeTolerance,
  );
  let patch = connectedCoplanarPatch(inliers, seedId, spacing * 3.4);
  if (patch.length < 3) {
    patch = inliers
      .map((node) => ({
        distanceSquared: squaredDistance(node.global, seed.global),
        node,
      }))
      .sort((a, b) => a.distanceSquared - b.distanceSquared)
      .slice(0, Math.min(24, inliers.length))
      .map(({ node }) => node);
  }

  let normal = best.normal;
  let constant = best.constant;
  const cloudCenter = centroid(nodes.map((node) => node.global));
  if (dot(normal, cloudCenter) + constant > 0) {
    normal = scale(normal, -1);
    constant *= -1;
  }

  const vertices = coplanarConvexHull(
    patch.map((node) => node.global),
    normal,
  );
  if (vertices.length < 3) {
    throw new Error("The connected patch does not have a usable boundary.");
  }
  const nodeByPoint = new Map(patch.map((node) => [node.global, node.id]));

  return {
    id: "smart-preview",
    label: "Smart preview",
    nodeIds: vertices
      .map((vertex) => nodeByPoint.get(vertex))
      .filter((id): id is number => id !== undefined),
    vertices,
    plane: { normal, constant },
    smart: true,
  };
}
