import type {
  ElementShell,
  ElementSurface,
  ModelElement,
  ModelNode,
} from "./types";

export type ElementSkin = {
  surfaces: ElementSurface[];
  shells: ElementShell[];
  plateElementCount: number;
  solidElementCount: number;
};

const faceKey = (ids: number[]) => [...ids].sort((a, b) => a - b).join(":");
const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function solidFaceIndices(size: number): number[][] {
  if (size === 4) return [[0, 1, 2], [0, 3, 1], [1, 3, 2], [2, 3, 0]];
  if (size === 6) {
    return [
      [0, 2, 1], [3, 4, 5],
      [0, 1, 4, 3], [1, 2, 5, 4], [2, 0, 3, 5],
    ];
  }
  if (size === 8) {
    return [
      [0, 3, 2, 1], [4, 5, 6, 7],
      [0, 1, 5, 4], [1, 2, 6, 5],
      [2, 3, 7, 6], [3, 0, 4, 7],
    ];
  }
  return [];
}

export function buildElementSkin(
  elements: ModelElement[],
  nodes: ModelNode[],
): ElementSkin {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const solidCandidates = new Map<
    string,
    Array<{ elementId: number; nodeIds: number[] }>
  >();
  const surfaces: ElementSurface[] = [];

  for (const element of elements) {
    if (element.type === "SOLID") {
      for (const indices of solidFaceIndices(element.nodeIds.length)) {
        const nodeIds = indices.map((index) => element.nodeIds[index]);
        const key = faceKey(nodeIds);
        const candidates = solidCandidates.get(key) ?? [];
        candidates.push({ elementId: element.id, nodeIds });
        solidCandidates.set(key, candidates);
      }
      continue;
    }
    const vertices = element.nodeIds.map((id) => nodeMap.get(id)?.global);
    if (vertices.some((point) => !point)) continue;
    surfaces.push({
      id: `plate-${element.id}`,
      elementId: element.id,
      nodeIds: element.nodeIds,
      vertices: vertices as ElementSurface["vertices"],
      source: "plate",
    });
  }

  for (const candidates of solidCandidates.values()) {
    if (candidates.length !== 1) continue;
    const candidate = candidates[0];
    const vertices = candidate.nodeIds.map((id) => nodeMap.get(id)?.global);
    if (vertices.some((point) => !point)) continue;
    surfaces.push({
      id: `solid-${candidate.elementId}-${faceKey(candidate.nodeIds)}`,
      elementId: candidate.elementId,
      nodeIds: candidate.nodeIds,
      vertices: vertices as ElementSurface["vertices"],
      source: "solid",
    });
  }

  const edgeToSurfaces = new Map<string, number[]>();
  surfaces.forEach((surface, surfaceIndex) => {
    surface.nodeIds.forEach((id, index) => {
      const key = edgeKey(id, surface.nodeIds[(index + 1) % surface.nodeIds.length]);
      const owners = edgeToSurfaces.get(key) ?? [];
      owners.push(surfaceIndex);
      edgeToSurfaces.set(key, owners);
    });
  });

  const neighbors = surfaces.map(() => new Set<number>());
  for (const owners of edgeToSurfaces.values()) {
    owners.forEach((owner) =>
      owners.forEach((other) => {
        if (owner !== other) neighbors[owner].add(other);
      }),
    );
  }

  const visited = new Set<number>();
  const shells: ElementShell[] = [];
  surfaces.forEach((_, start) => {
    if (visited.has(start)) return;
    const component: number[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const current = queue.pop()!;
      component.push(current);
      neighbors[current].forEach((next) => {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      });
    }
    const componentSet = new Set(component);
    const counts = [...edgeToSurfaces.values()]
      .map((owners) => owners.filter((owner) => componentSet.has(owner)).length)
      .filter(Boolean);
    const boundaryEdgeCount = counts.filter((count) => count === 1).length;
    const nonManifoldEdgeCount = counts.filter((count) => count > 2).length;
    shells.push({
      id: `shell-${shells.length + 1}`,
      surfaceIds: component.map((index) => surfaces[index].id),
      closed: boundaryEdgeCount === 0 && nonManifoldEdgeCount === 0,
      boundaryEdgeCount,
      nonManifoldEdgeCount,
    });
  });

  return {
    surfaces,
    shells,
    plateElementCount: elements.filter((element) => element.type !== "SOLID").length,
    solidElementCount: elements.filter((element) => element.type === "SOLID").length,
  };
}
