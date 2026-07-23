import { Vector3 } from "three";
import { ConvexHull } from "three/examples/jsm/math/ConvexHull.js";
import type {
  Bounds,
  ModelNode,
  PlaneDefinition,
  Vec3,
  VolumeFace,
} from "./types";
import {
  add,
  buildPolyhedron,
  dot,
  modelTolerance,
  normalize,
  scale,
} from "./volumeGeometry";

type WeightedNormal = {
  normal: Vec3;
  weight: number;
};

const MAX_HULL_INPUTS = 16000;
const TARGET_FACE_COUNT = 48;

function reducePointCloud(nodes: ModelNode[], bounds: Bounds): Vec3[] {
  if (nodes.length <= MAX_HULL_INPUTS) {
    return nodes.map((node) => node.global);
  }

  const resolution = 25;
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
  const cells = new Map<string, { point: Vec3; score: number }>();

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
    if (!current || score > current.score) cells.set(key, { point, score });
  }

  return [...cells.values()].map((entry) => entry.point);
}

function clusterNormals(
  normals: WeightedNormal[],
  angleDegrees: number,
): WeightedNormal[] {
  const cosineThreshold = Math.cos((angleDegrees * Math.PI) / 180);
  const clusters: WeightedNormal[] = [];

  for (const candidate of normals) {
    const match = clusters.find(
      (cluster) => dot(cluster.normal, candidate.normal) >= cosineThreshold,
    );
    if (!match) {
      clusters.push({ ...candidate });
      continue;
    }
    const totalWeight = match.weight + candidate.weight;
    match.normal = normalize(
      add(
        scale(match.normal, match.weight / totalWeight),
        scale(candidate.normal, candidate.weight / totalWeight),
      ),
    );
    match.weight = totalWeight;
  }

  return clusters;
}

function outwardSupportPlane(
  normal: Vec3,
  nodes: ModelNode[],
): PlaneDefinition {
  let support = -Infinity;
  for (const node of nodes) {
    support = Math.max(support, dot(normal, node.global));
  }
  return { normal, constant: -support };
}

/**
 * Creates a simplified convex hull around the actual node cloud.
 * The hull follows the model silhouette and merges nearby facet normals so the
 * resulting face list remains editable.
 */
export function autoHullFaces(
  nodes: ModelNode[],
  bounds: Bounds,
): VolumeFace[] {
  if (nodes.length < 4) {
    throw new Error("At least four non-coplanar nodes are required.");
  }

  const reduced = reducePointCloud(nodes, bounds);
  const hull = new ConvexHull().setFromPoints(
    reduced.map((point) => new Vector3(point.x, point.y, point.z)),
  );
  if (hull.faces.length < 4) {
    throw new Error("The node cloud is coplanar or otherwise degenerate.");
  }

  const rawNormals: WeightedNormal[] = hull.faces.map((face) => ({
    normal: {
      x: face.normal.x,
      y: face.normal.y,
      z: face.normal.z,
    },
    weight: Math.max(face.area, 1e-12),
  }));

  let angle = 2;
  let clustered = clusterNormals(rawNormals, angle);
  while (clustered.length > TARGET_FACE_COUNT && angle < 24) {
    angle += 2;
    clustered = clusterNormals(rawNormals, angle);
  }

  const planes = clustered.map((cluster) =>
    outwardSupportPlane(cluster.normal, nodes),
  );
  const tolerance = modelTolerance(bounds);
  const polyhedron = buildPolyhedron(planes, tolerance * 2, false);
  if (!polyhedron || polyhedron.faces.length < 4) {
    throw new Error("A stable convex hull could not be generated.");
  }

  return polyhedron.faces.map((polygon, index) => {
    const plane = planes[polygon.planeIndex];
    return {
      id: `hull-${crypto.randomUUID()}`,
      label: `Hull ${String(index + 1).padStart(2, "0")}`,
      nodeIds: [],
      vertices: polygon.vertices,
      plane,
      automatic: true,
    };
  });
}
