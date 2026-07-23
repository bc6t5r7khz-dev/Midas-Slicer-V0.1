import { Vector3 } from "three";
import {
  ConvexHull,
  type Face,
  type VertexNode,
} from "three/examples/jsm/math/ConvexHull.js";
import type { Bounds, ModelNode, Vec3, VolumeFace } from "./types";
import { coplanarConvexHull } from "./volumeGeometry";

const MAX_INITIAL_HULL_INPUTS = 14000;
const MAX_REFINEMENT_ADDITIONS = 8000;
const MAX_REFINEMENT_PASSES = 20;

type HullBuild = {
  hull: ConvexHull;
  nodeByPoint: WeakMap<Vector3, ModelNode>;
};

function coordinateKey(point: Vec3) {
  return `${point.x}|${point.y}|${point.z}`;
}

function uniqueNodes(nodes: ModelNode[]): ModelNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    const key = coordinateKey(node.global);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Creates a spatially distributed seed set. Every retained entry is still an
 * original MCT node; no synthetic coordinates are introduced.
 */
function reducePointCloud(nodes: ModelNode[], bounds: Bounds): ModelNode[] {
  if (nodes.length <= MAX_INITIAL_HULL_INPUTS) return uniqueNodes(nodes);

  const resolution = 24;
  const span = {
    x: Math.max(bounds.x[1] - bounds.x[0], 1e-12),
    y: Math.max(bounds.y[1] - bounds.y[0], 1e-12),
    z: Math.max(bounds.z[1] - bounds.z[0], 1e-12),
  };
  const center = {
    x: (bounds.x[0] + bounds.x[1]) / 2,
    y: (bounds.y[0] + bounds.y[1]) / 2,
    z: (bounds.z[0] + bounds.z[1]) / 2,
  };
  const cells = new Map<string, { node: ModelNode; score: number }>();

  for (const node of nodes) {
    const point = node.global;
    const ix = Math.min(
      resolution - 1,
      Math.floor(((point.x - bounds.x[0]) / span.x) * resolution),
    );
    const iy = Math.min(
      resolution - 1,
      Math.floor(((point.y - bounds.y[0]) / span.y) * resolution),
    );
    const iz = Math.min(
      resolution - 1,
      Math.floor(((point.z - bounds.z[0]) / span.z) * resolution),
    );
    const key = `${ix}:${iy}:${iz}`;
    const score = Math.hypot(
      (point.x - center.x) / span.x,
      (point.y - center.y) / span.y,
      (point.z - center.z) / span.z,
    );
    const current = cells.get(key);
    if (!current || score > current.score) cells.set(key, { node, score });
  }
  return uniqueNodes([...cells.values()].map(({ node }) => node));
}

function buildHull(nodes: ModelNode[]): HullBuild {
  const nodeByPoint = new WeakMap<Vector3, ModelNode>();
  const points = nodes.map((node) => {
    const point = new Vector3(node.global.x, node.global.y, node.global.z);
    nodeByPoint.set(point, node);
    return point;
  });
  return {
    hull: new ConvexHull().setFromPoints(points),
    nodeByPoint,
  };
}

function exactHull(
  nodes: ModelNode[],
  bounds: Bounds,
): HullBuild {
  const unique = uniqueNodes(nodes);
  const selected = reducePointCloud(unique, bounds);
  const selectedKeys = new Set(
    selected.map((node) => coordinateKey(node.global)),
  );
  const diagonal = Math.hypot(
    bounds.x[1] - bounds.x[0],
    bounds.y[1] - bounds.y[0],
    bounds.z[1] - bounds.z[0],
  );
  const containmentTolerance = Math.max(diagonal * 1e-10, 1e-10);

  for (let pass = 0; pass < MAX_REFINEMENT_PASSES; pass += 1) {
    const built = buildHull(selected);
    if (built.hull.faces.length < 4) {
      throw new Error("The node cloud is coplanar or otherwise degenerate.");
    }

    const outside: Array<{ distance: number; node: ModelNode }> = [];
    for (const node of unique) {
      if (selectedKeys.has(coordinateKey(node.global))) continue;
      const point = new Vector3(
        node.global.x,
        node.global.y,
        node.global.z,
      );
      let greatestDistance = -Infinity;
      for (const face of built.hull.faces) {
        greatestDistance = Math.max(
          greatestDistance,
          face.normal.dot(point) - face.constant,
        );
      }
      if (greatestDistance > containmentTolerance) {
        outside.push({ distance: greatestDistance, node });
      }
    }

    if (!outside.length) return built;
    outside.sort((a, b) => b.distance - a.distance);
    for (const { node } of outside.slice(0, MAX_REFINEMENT_ADDITIONS)) {
      const key = coordinateKey(node.global);
      if (!selectedKeys.has(key)) {
        selected.push(node);
        selectedKeys.add(key);
      }
    }
  }
  throw new Error("The exact hull did not converge for this node cloud.");
}

function faceVertices(face: Face): VertexNode[] {
  const vertices: VertexNode[] = [];
  let edge = face.edge;
  do {
    vertices.push(edge.head());
    edge = edge.next;
  } while (edge !== face.edge);
  return vertices;
}

function coplanarGroups(
  faces: Face[],
  mergeTolerance: number,
): Face[][] {
  const faceIndex = new Map(faces.map((face, index) => [face, index]));
  const visited = new Set<number>();
  const groups: Face[][] = [];
  const cosineThreshold = Math.cos((0.05 * Math.PI) / 180);

  faces.forEach((seed, seedIndex) => {
    if (visited.has(seedIndex)) return;
    visited.add(seedIndex);
    const group: Face[] = [];
    const queue = [seed];

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const face = queue[cursor];
      group.push(face);
      let edge = face.edge;
      do {
        const neighbor = edge.twin?.face;
        const neighborIndex = neighbor ? faceIndex.get(neighbor) : undefined;
        if (
          neighbor &&
          neighborIndex !== undefined &&
          !visited.has(neighborIndex) &&
          seed.normal.dot(neighbor.normal) >= cosineThreshold &&
          faceVertices(neighbor).every(
            (vertex) =>
              Math.abs(seed.normal.dot(vertex.point) - seed.constant) <=
              mergeTolerance,
          )
        ) {
          visited.add(neighborIndex);
          queue.push(neighbor);
        }
        edge = edge.next;
      } while (edge !== face.edge);
    }
    groups.push(group);
  });
  return groups;
}

/**
 * Computes the exact convex hull of the complete node cloud. Every face is
 * defined exclusively by original MCT nodes. Adjacent triangles are combined
 * only when those node coordinates are genuinely coplanar.
 */
export function autoHullFaces(
  nodes: ModelNode[],
  bounds: Bounds,
): VolumeFace[] {
  if (nodes.length < 4) {
    throw new Error("At least four non-coplanar nodes are required.");
  }

  const { hull, nodeByPoint } = exactHull(nodes, bounds);
  const diagonal = Math.hypot(
    bounds.x[1] - bounds.x[0],
    bounds.y[1] - bounds.y[0],
    bounds.z[1] - bounds.z[0],
  );
  const mergeTolerance = Math.max(diagonal * 1e-9, 1e-9);
  const groups = coplanarGroups(hull.faces, mergeTolerance);

  return groups.map((group, index) => {
    const seed = group[0];
    const groupNodes = new Map<number, ModelNode>();
    for (const face of group) {
      for (const vertex of faceVertices(face)) {
        const node = nodeByPoint.get(vertex.point);
        if (node) groupNodes.set(node.id, node);
      }
    }
    const boundary = coplanarConvexHull(
      [...groupNodes.values()].map((node) => node.global),
      { x: seed.normal.x, y: seed.normal.y, z: seed.normal.z },
    );
    const nodeByGlobal = new Map(
      [...groupNodes.values()].map((node) => [node.global, node.id]),
    );
    const nodeIds = boundary
      .map((point) => nodeByGlobal.get(point))
      .filter((id): id is number => id !== undefined);
    if (boundary.length < 3 || nodeIds.length !== boundary.length) {
      throw new Error("An exact node-defined hull face could not be built.");
    }

    return {
      id: `hull-${crypto.randomUUID()}`,
      label: `Hull ${String(index + 1).padStart(2, "0")}`,
      nodeIds,
      vertices: boundary,
      plane: {
        normal: {
          x: seed.normal.x,
          y: seed.normal.y,
          z: seed.normal.z,
        },
        constant: -seed.constant,
      },
      automatic: true,
    };
  });
}
