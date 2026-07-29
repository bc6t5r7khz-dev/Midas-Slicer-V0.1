"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { toLocal, transformPlane } from "../lib/coordinateSystem";
import type {
  Bounds,
  CameraViewpoint,
  LocalBasis,
  ElementSurface,
  ModelElement,
  RebarLine,
  RebarRun,
  ModelNode,
  SliceRanges,
  Vec3,
  VolumeFace,
} from "../lib/types";
import {
  buildPolyhedron,
  clipPolygonToPlanes,
  dot,
  normalize,
  slicePlanes,
} from "../lib/volumeGeometry";

type PickTarget = "node" | "face";

type Props = {
  nodes: ModelNode[];
  allNodes: ModelNode[];
  slice: SliceRanges;
  basis: LocalBasis | null;
  faces: VolumeFace[];
  previewFace: VolumeFace | null;
  draftNodeIds: number[];
  selectedNodeIds: number[];
  invalidNodeIds: number[];
  selectedFaceIds: string[];
  hoveredFaceId: string | null;
  floorFaceId: string | null;
  orbitTarget: Vec3 | null;
  editableFaceId: string | null;
  volumeConfirmed: boolean;
  pickTarget: PickTarget;
  tolerance: number;
  elementSurfaces: ElementSurface[];
  elements: ModelElement[];
  showElementSkin: boolean;
  elementEditMode: boolean;
  selectedElementIds: number[];
  onPickElement: (elementId: number) => void;
  slicingMode: boolean;
  sliceBounds: Bounds | null;
  rebarMode: boolean;
  showRebarScene: boolean;
  customSlicePlane: {
    origin: Vec3;
    normal: Vec3;
    offset: number;
  } | null;
  viewpointCaptureRequest: { pinId: string; nonce: number } | null;
  viewpointToApply: {
    pinId: string;
    nonce: number;
    viewpoint: CameraViewpoint;
  } | null;
  onViewpointCaptured: (pinId: string, viewpoint: CameraViewpoint) => void;
  showRebarPlaneNodes: boolean;
  rebarRuns: RebarRun[];
  selectedRebarRunIds: ReadonlySet<string>;
  showRebarLabels: boolean;
  rebarGuideLines: RebarLine[];
  rebarInnerGuideLines: RebarLine[];
  rebarOuterEdges: Array<[Vec3, Vec3]> | null;
  selectedRebarEdgeIndex: number | null;
  rebarEdgeSelectionMode: boolean;
  onPickRebarEdge: (edgeIndex: number) => void;
  pendingRebarLine: RebarLine | null;
  draftRebarLines: RebarLine[];
  rebarSnapLines: RebarLine[];
  rebarSnapRequired: boolean;
  rebarPreviewStart: Vec3 | null;
  rebarPathStart: Vec3 | null;
  rebarPathEnd: Vec3 | null;
  rebarPathPoints: Vec3[];
  rebarAxis: "x" | "y" | "z";
  rebarSection: number | null;
  rebarDrawingPlane: {
    origin: Vec3;
    normal: Vec3;
    vertical: Vec3;
    color: string;
  } | null;
  rebarPlanePreviews: Array<{
    id: string;
    origin: Vec3;
    normal: Vec3;
    color: string;
    offset?: number;
    borderOnly?: boolean;
  }>;
  inchesPerModelUnit: number | null;
  showConcreteSkin: boolean;
  lineAndBar: boolean;
  rebarDrawing: boolean;
  showAxes: boolean;
  onPickRebarPoint: (point: Vec3) => void;
  onHover: (payload: {
    node: ModelNode;
    clientX: number;
    clientY: number;
  } | null) => void;
  onHoverFace: (faceId: string | null) => void;
  onPickNode: (nodeId: number) => void;
  onPickFace: (faceId: string) => void;
  onRemoveFaceVertex: (faceId: string, nodeId: number) => void;
  onInsertFaceVertex: (
    faceId: string,
    edgeIndex: number,
    nodeId: number,
  ) => void;
};

type SceneState = {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  faceGroup: THREE.Group;
  elementGroup: THREE.Group;
  grid: THREE.GridHelper;
  axes: THREE.AxesHelper;
  rebarGroup: THREE.Group;
  rebarSnapMarker: THREE.Mesh;
  rebarSnapSegment: LineSegments2;
  rebarPreview: THREE.Line;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  points: THREE.Points;
  raycaster: THREE.Raycaster;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  resizeObserver: ResizeObserver;
};

const vertexShader = `
  attribute vec3 nodeColor;
  attribute vec3 sliceCoord;
  varying vec3 vColor;
  varying vec3 vSliceCoord;

  void main() {
    vColor = nodeColor;
    vSliceCoord = sliceCoord;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(72.0 / -mvPosition.z, 2.3, 7.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = `
  uniform vec2 xRange;
  uniform vec2 yRange;
  uniform vec2 zRange;
  varying vec3 vColor;
  varying vec3 vSliceCoord;

  void main() {
    if (vSliceCoord.x < xRange.x || vSliceCoord.x > xRange.y ||
        vSliceCoord.y < yRange.x || vSliceCoord.y > yRange.y ||
        vSliceCoord.z < zRange.x || vSliceCoord.z > zRange.y) discard;
    vec2 point = gl_PointCoord - vec2(0.5);
    if (dot(point, point) > 0.25) discard;
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

const toThree = (point: Vec3, offset: Vec3) =>
  new THREE.Vector3(
    point.x - offset.x,
    point.y - offset.y,
    point.z - offset.z,
  );

function triangulatePolygon(vertices: Vec3[], offset: Vec3) {
  const positions: number[] = [];
  const normal = new THREE.Vector3();
  for (
    let current = 0, previous = vertices.length - 1;
    current < vertices.length;
    previous = current, current += 1
  ) {
    const a = vertices[previous];
    const b = vertices[current];
    normal.x += (a.y - b.y) * (a.z + b.z);
    normal.y += (a.z - b.z) * (a.x + b.x);
    normal.z += (a.x - b.x) * (a.y + b.y);
  }
  normal.normalize();
  const helper =
    Math.abs(normal.z) < 0.8
      ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(helper, normal).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u).normalize();
  const contour = vertices.map(
    (vertex) =>
      new THREE.Vector2(
        vertex.x * u.x + vertex.y * u.y + vertex.z * u.z,
        vertex.x * v.x + vertex.y * v.y + vertex.z * v.z,
      ),
  );
  const triangles = THREE.ShapeUtils.triangulateShape(contour, []);

  for (const triangle of triangles) {
    for (const index of triangle) {
      const vertex = vertices[index];
      positions.push(
        vertex.x - offset.x,
        vertex.y - offset.y,
        vertex.z - offset.z,
      );
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.computeVertexNormals();
  return geometry;
}

function disposeGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    if (
      "geometry" in child &&
      "material" in child &&
      child.geometry instanceof THREE.BufferGeometry
    ) {
      child.geometry.dispose();
      const sourceMaterial = child.material as
        | THREE.Material
        | THREE.Material[];
      const materials = Array.isArray(sourceMaterial)
        ? sourceMaterial
        : [sourceMaterial];
      materials.forEach((material) => material.dispose());
    } else if (child instanceof THREE.Sprite) {
      child.material.map?.dispose();
      child.material.dispose();
    }
  }
}

function createTextSprite(text: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "rgba(5, 12, 16, 0.82)";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f1c36c";
  context.font = "600 38px Arial";
  context.textBaseline = "middle";
  context.fillText(text, 18, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      transparent: true,
      sizeAttenuation: false,
    }),
  );
  sprite.scale.set(0.055, 0.0103, 1);
  return sprite;
}

type CellFace = {
  vertices: Vec3[];
  cap: boolean;
};

type ClipPlane = {
  normal: Vec3;
  constant: number;
};

function solidFaces(size: number): number[][] {
  if (size === 4) return [[0, 1, 2], [0, 3, 1], [1, 3, 2], [2, 3, 0]];
  if (size === 6) {
    return [
      [0, 2, 1],
      [3, 4, 5],
      [0, 1, 4, 3],
      [1, 2, 5, 4],
      [2, 0, 3, 5],
    ];
  }
  if (size === 8) {
    return [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
    ];
  }
  return [];
}

const planeDistance = (plane: ClipPlane, point: Vec3) =>
  plane.normal.x * point.x +
  plane.normal.y * point.y +
  plane.normal.z * point.z +
  plane.constant;

function clipCellFaces(
  faces: CellFace[],
  plane: ClipPlane,
  epsilon: number,
): CellFace[] {
  const clipped: CellFace[] = [];
  const capPoints: Vec3[] = [];

  for (const face of faces) {
    const vertices: Vec3[] = [];
    for (
      let currentIndex = 0, previousIndex = face.vertices.length - 1;
      currentIndex < face.vertices.length;
      previousIndex = currentIndex, currentIndex += 1
    ) {
      const previous = face.vertices[previousIndex];
      const current = face.vertices[currentIndex];
      const previousDistance = planeDistance(plane, previous);
      const currentDistance = planeDistance(plane, current);
      const previousInside = previousDistance >= -epsilon;
      const currentInside = currentDistance >= -epsilon;

      if (previousInside !== currentInside) {
        const amount =
          previousDistance / (previousDistance - currentDistance);
        const intersection = {
          x: previous.x + (current.x - previous.x) * amount,
          y: previous.y + (current.y - previous.y) * amount,
          z: previous.z + (current.z - previous.z) * amount,
        };
        vertices.push(intersection);
        capPoints.push(intersection);
      }
      if (currentInside) vertices.push(current);
    }
    if (vertices.length >= 3) clipped.push({ ...face, vertices });
  }

  const unique = capPoints.filter(
    (point, index) =>
      capPoints.findIndex(
        (candidate) =>
          (candidate.x - point.x) ** 2 +
            (candidate.y - point.y) ** 2 +
            (candidate.z - point.z) ** 2 <
          epsilon ** 2,
      ) === index,
  );
  if (unique.length >= 3) {
    const center = unique.reduce(
      (sum, point) => ({
        x: sum.x + point.x / unique.length,
        y: sum.y + point.y / unique.length,
        z: sum.z + point.z / unique.length,
      }),
      { x: 0, y: 0, z: 0 },
    );
    const normal = new THREE.Vector3(
      plane.normal.x,
      plane.normal.y,
      plane.normal.z,
    ).normalize();
    const helper =
      Math.abs(normal.z) < 0.8
        ? new THREE.Vector3(0, 0, 1)
        : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(helper, normal).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();
    unique.sort((a, b) => {
      const ax = (a.x - center.x) * u.x +
        (a.y - center.y) * u.y +
        (a.z - center.z) * u.z;
      const ay = (a.x - center.x) * v.x +
        (a.y - center.y) * v.y +
        (a.z - center.z) * v.z;
      const bx = (b.x - center.x) * u.x +
        (b.y - center.y) * u.y +
        (b.z - center.z) * u.z;
      const by = (b.x - center.x) * v.x +
        (b.y - center.y) * v.y +
        (b.z - center.z) * v.z;
      return Math.atan2(ay, ax) - Math.atan2(by, bx);
    });
    clipped.push({ vertices: unique, cap: true });
  }
  return clipped;
}

function clippedSolidBuffers(
  elements: ModelElement[],
  nodes: ModelNode[],
  basis: LocalBasis | null,
  slice: SliceRanges,
  offset: Vec3,
  customPlane: ClipPlane | null,
) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const planes: ClipPlane[] = [
    { normal: { x: 1, y: 0, z: 0 }, constant: -slice.x[0] },
    { normal: { x: -1, y: 0, z: 0 }, constant: slice.x[1] },
    { normal: { x: 0, y: 1, z: 0 }, constant: -slice.y[0] },
    { normal: { x: 0, y: -1, z: 0 }, constant: slice.y[1] },
    { normal: { x: 0, y: 0, z: 1 }, constant: -slice.z[0] },
    { normal: { x: 0, y: 0, z: -1 }, constant: slice.z[1] },
  ];
  if (customPlane) planes.push(customPlane);
  const span = Math.max(
    slice.x[1] - slice.x[0],
    slice.y[1] - slice.y[0],
    slice.z[1] - slice.z[0],
    1,
  );
  const epsilon = span * 1e-8;
  const positions: number[] = [];
  const capPositions: number[] = [];

  for (const element of elements) {
    if (element.type !== "SOLID") continue;
    const sourceVertices = element.nodeIds.map((id) => {
      const node = nodeMap.get(id);
      if (!node) return null;
      return basis ? toLocal(node.global, basis) : node.global;
    });
    if (sourceVertices.some((point) => !point)) continue;
    let faces: CellFace[] = solidFaces(element.nodeIds.length).map((indices) => ({
      vertices: indices.map((index) => sourceVertices[index] as Vec3),
      cap: false,
    }));
    for (const plane of planes) {
      faces = clipCellFaces(faces, plane, epsilon);
      if (!faces.length) break;
    }

    for (const face of faces) {
      const displayed = face.vertices.map((vertex) => ({
        x: vertex.x - offset.x,
        y: vertex.y - offset.y,
        z: vertex.z - offset.z,
      }));
      for (let index = 1; index < displayed.length - 1; index += 1) {
        [displayed[0], displayed[index], displayed[index + 1]].forEach(
          (point) => {
            positions.push(point.x, point.y, point.z);
            if (face.cap) capPositions.push(point.x, point.y, point.z);
          },
        );
      }
    }
  }
  return { positions, capPositions };
}

function clipSurfacePolygon(
  vertices: Vec3[],
  plane: ClipPlane,
  epsilon: number,
) {
  const clipped: Vec3[] = [];
  for (
    let currentIndex = 0, previousIndex = vertices.length - 1;
    currentIndex < vertices.length;
    previousIndex = currentIndex, currentIndex += 1
  ) {
    const previous = vertices[previousIndex];
    const current = vertices[currentIndex];
    const previousDistance = planeDistance(plane, previous);
    const currentDistance = planeDistance(plane, current);
    const previousInside = previousDistance >= -epsilon;
    const currentInside = currentDistance >= -epsilon;
    if (previousInside !== currentInside) {
      const amount =
        previousDistance / (previousDistance - currentDistance);
      clipped.push({
        x: previous.x + (current.x - previous.x) * amount,
        y: previous.y + (current.y - previous.y) * amount,
        z: previous.z + (current.z - previous.z) * amount,
      });
    }
    if (currentInside) clipped.push(current);
  }
  return clipped;
}

function clippedExteriorPositions(
  surfaces: ElementSurface[],
  basis: LocalBasis | null,
  slice: SliceRanges,
  offset: Vec3,
  customPlane: ClipPlane | null,
) {
  const planes: ClipPlane[] = [
    { normal: { x: 1, y: 0, z: 0 }, constant: -slice.x[0] },
    { normal: { x: -1, y: 0, z: 0 }, constant: slice.x[1] },
    { normal: { x: 0, y: 1, z: 0 }, constant: -slice.y[0] },
    { normal: { x: 0, y: -1, z: 0 }, constant: slice.y[1] },
    { normal: { x: 0, y: 0, z: 1 }, constant: -slice.z[0] },
    { normal: { x: 0, y: 0, z: -1 }, constant: slice.z[1] },
  ];
  if (customPlane) planes.push(customPlane);
  const positions: number[] = [];
  for (const surface of surfaces) {
    let vertices = surface.vertices.map((vertex) =>
      basis ? toLocal(vertex, basis) : vertex,
    );
    for (const plane of planes) {
      vertices = clipSurfacePolygon(vertices, plane, 1e-8);
      if (vertices.length < 3) break;
    }
    for (let index = 1; index < vertices.length - 1; index += 1) {
      [vertices[0], vertices[index], vertices[index + 1]].forEach(
        (vertex) =>
          positions.push(
            vertex.x - offset.x,
            vertex.y - offset.y,
            vertex.z - offset.z,
          ),
      );
    }
  }
  return positions;
}

function fitCamera(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  geometry: THREE.BufferGeometry,
  localCoordinates: boolean,
) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box || box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z, 1);
  const distance = maxDimension / (2 * Math.tan((camera.fov * Math.PI) / 360));
  camera.near = Math.max(distance / 10000, 0.001);
  camera.far = distance * 100;
  camera.up.set(0, localCoordinates ? 0 : 1, localCoordinates ? 1 : 0);
  camera.position.set(
    center.x + distance * 0.78,
    center.y - distance * 0.7,
    center.z + distance * 0.48,
  );
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  camera.lookAt(center);
  controls.update();
  controls.saveState();
}

function pointAlongPolyline(points: Vec3[], distance: number): Vec3 {
  if (!points.length) return { x: 0, y: 0, z: 0 };
  if (points.length === 1 || distance <= 0) return points[0];
  let remaining = distance;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const length = Math.hypot(
      end.x - start.x,
      end.y - start.y,
      end.z - start.z,
    );
    if (remaining <= length || index === points.length - 1) {
      const amount = length > 1e-12 ? Math.min(remaining / length, 1) : 0;
      return {
        x: start.x + (end.x - start.x) * amount,
        y: start.y + (end.y - start.y) * amount,
        z: start.z + (end.z - start.z) * amount,
      };
    }
    remaining -= length;
  }
  return points[points.length - 1];
}

export default function PointCloudViewport({
  nodes,
  allNodes,
  slice,
  basis,
  faces,
  previewFace,
  draftNodeIds,
  selectedNodeIds,
  invalidNodeIds,
  selectedFaceIds,
  hoveredFaceId,
  floorFaceId,
  orbitTarget,
  editableFaceId,
  volumeConfirmed,
  pickTarget,
  tolerance,
  elementSurfaces,
  elements,
  showElementSkin,
  elementEditMode,
  selectedElementIds,
  onPickElement,
  slicingMode,
  sliceBounds,
  rebarMode,
  showRebarScene,
  customSlicePlane,
  viewpointCaptureRequest,
  viewpointToApply,
  onViewpointCaptured,
  showRebarPlaneNodes,
  rebarRuns,
  selectedRebarRunIds,
  showRebarLabels,
  rebarGuideLines,
  rebarInnerGuideLines,
  rebarOuterEdges,
  selectedRebarEdgeIndex,
  rebarEdgeSelectionMode,
  onPickRebarEdge,
  pendingRebarLine,
  draftRebarLines,
  rebarSnapLines,
  rebarSnapRequired,
  rebarPreviewStart,
  rebarPathStart,
  rebarPathEnd,
  rebarPathPoints,
  rebarAxis,
  rebarSection,
  rebarDrawingPlane,
  rebarPlanePreviews,
  inchesPerModelUnit,
  showConcreteSkin,
  lineAndBar,
  rebarDrawing,
  showAxes,
  onPickRebarPoint,
  onHover,
  onHoverFace,
  onPickNode,
  onPickFace,
  onRemoveFaceVertex,
  onInsertFaceVertex,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneState | null>(null);
  const faceMeshesRef = useRef<THREE.Mesh[]>([]);
  const faceEdgesRef = useRef<THREE.Line[]>([]);
  const elementMeshRef = useRef<THREE.Mesh | null>(null);
  const triangleElementIdsRef = useRef<number[]>([]);
  const rebarGuideObjectsRef = useRef<THREE.Line[]>([]);
  const rebarEdgeObjectsRef = useRef<LineSegments2[]>([]);
  const rebarEdgeDataRef = useRef<
    Array<{ object: LineSegments2; start: Vec3; end: Vec3; index: number }>
  >([]);
  const rebarGuidePointsRef = useRef<Vec3[]>([]);
  const rebarSnapLinesRef = useRef<RebarLine[]>(rebarSnapLines);
  const rebarSnapRequiredRef = useRef(rebarSnapRequired);
  const pendingRebarLineRef = useRef(pendingRebarLine);
  const rebarPreviewStartRef = useRef(rebarPreviewStart);
  const fittedNodesRef = useRef<ModelNode[] | null>(null);
  const fittedBasisRef = useRef<LocalBasis | null>(null);
  const nodesRef = useRef(nodes);
  const sliceRef = useRef(slice);
  const pickTargetRef = useRef(pickTarget);
  const editableFaceIdRef = useRef(editableFaceId);
  const facesRef = useRef(faces);
  const onHoverRef = useRef(onHover);
  const onHoverFaceRef = useRef(onHoverFace);
  const onPickNodeRef = useRef(onPickNode);
  const onPickFaceRef = useRef(onPickFace);
  const onRemoveFaceVertexRef = useRef(onRemoveFaceVertex);
  const onInsertFaceVertexRef = useRef(onInsertFaceVertex);
  const elementEditModeRef = useRef(elementEditMode);
  const onPickElementRef = useRef(onPickElement);
  const rebarDrawingRef = useRef(rebarDrawing);
  const onPickRebarPointRef = useRef(onPickRebarPoint);
  const rebarEdgeSelectionModeRef = useRef(rebarEdgeSelectionMode);
  const onPickRebarEdgeRef = useRef(onPickRebarEdge);
  const selectedRebarEdgeIndexRef = useRef(selectedRebarEdgeIndex);
  const rebarAxisRef = useRef(rebarAxis);
  const rebarSectionRef = useRef(rebarSection);
  const rebarDrawingPlaneRef = useRef(rebarDrawingPlane);
  const displayOffsetRef = useRef<Vec3>({ x: 0, y: 0, z: 0 });
  const toleranceRef = useRef(tolerance);
  const inchesPerModelUnitRef = useRef(inchesPerModelUnit);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [segmentLengthHud, setSegmentLengthHud] = useState<{
    clientX: number;
    clientY: number;
    inches: number;
  } | null>(null);

  nodesRef.current = nodes;
  sliceRef.current = slice;
  pickTargetRef.current = pickTarget;
  editableFaceIdRef.current = editableFaceId;
  facesRef.current = faces;
  onHoverRef.current = onHover;
  onHoverFaceRef.current = onHoverFace;
  onPickNodeRef.current = onPickNode;
  onPickFaceRef.current = onPickFace;
  onRemoveFaceVertexRef.current = onRemoveFaceVertex;
  onInsertFaceVertexRef.current = onInsertFaceVertex;
  elementEditModeRef.current = elementEditMode;
  onPickElementRef.current = onPickElement;
  rebarDrawingRef.current = rebarDrawing;
  onPickRebarPointRef.current = onPickRebarPoint;
  rebarEdgeSelectionModeRef.current = rebarEdgeSelectionMode;
  onPickRebarEdgeRef.current = onPickRebarEdge;
  selectedRebarEdgeIndexRef.current = selectedRebarEdgeIndex;
  rebarAxisRef.current = rebarAxis;
  rebarSectionRef.current = rebarSection;
  rebarDrawingPlaneRef.current = rebarDrawingPlane;
  pendingRebarLineRef.current = pendingRebarLine;
  rebarSnapLinesRef.current = rebarSnapLines;
  rebarSnapRequiredRef.current = rebarSnapRequired;
  rebarPreviewStartRef.current = rebarPreviewStart;
  inchesPerModelUnitRef.current = inchesPerModelUnit;

  const displayOffset = useMemo(() => {
    if (basis || !allNodes.length) return { x: 0, y: 0, z: 0 };
    const sum = allNodes.reduce(
      (current, node) => ({
        x: current.x + node.global.x,
        y: current.y + node.global.y,
        z: current.z + node.global.z,
      }),
      { x: 0, y: 0, z: 0 },
    );
    return {
      x: sum.x / allNodes.length,
      y: sum.y / allNodes.length,
      z: sum.z / allNodes.length,
    };
  }, [allNodes, basis]);
  displayOffsetRef.current = displayOffset;
  toleranceRef.current = tolerance;

  const displayCustomClipPlane = useMemo<ClipPlane | null>(() => {
    if (!customSlicePlane) return null;
    const normal = normalize(customSlicePlane.normal);
    return {
      normal: { x: -normal.x, y: -normal.y, z: -normal.z },
      constant:
        dot(normal, customSlicePlane.origin) + customSlicePlane.offset,
    };
  }, [customSlicePlane]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state || !viewpointCaptureRequest) return;
    onViewpointCaptured(viewpointCaptureRequest.pinId, {
      position: {
        x: state.camera.position.x,
        y: state.camera.position.y,
        z: state.camera.position.z,
      },
      target: {
        x: state.controls.target.x,
        y: state.controls.target.y,
        z: state.controls.target.z,
      },
      up: {
        x: state.camera.up.x,
        y: state.camera.up.y,
        z: state.camera.up.z,
      },
    });
  }, [onViewpointCaptured, viewpointCaptureRequest]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state || !viewpointToApply) return;
    const { position, target, up } = viewpointToApply.viewpoint;
    state.camera.position.set(position.x, position.y, position.z);
    state.camera.up.set(up.x, up.y, up.z);
    state.controls.target.set(target.x, target.y, target.z);
    state.camera.lookAt(state.controls.target);
    state.controls.update();
  }, [viewpointToApply]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    try {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xf7f7f2);
      scene.fog = new THREE.FogExp2(0xf7f7f2, 0.0007);

      const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000000);
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.localClippingEnabled = true;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      host.appendChild(renderer.domElement);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false;
      controls.screenSpacePanning = true;
      controls.panSpeed = 1;
      controls.zoomSpeed = 0.9;
      controls.zoomToCursor = true;
      controls.mouseButtons.LEFT = null as unknown as THREE.MOUSE;
      controls.mouseButtons.MIDDLE = null as unknown as THREE.MOUSE;
      controls.mouseButtons.RIGHT = null as unknown as THREE.MOUSE;

      const grid = new THREE.GridHelper(240, 24, 0x9aa1a6, 0xd7dbdd);
      grid.rotation.x = Math.PI / 2;
      grid.material.opacity = 0.5;
      grid.material.transparent = true;
      scene.add(grid);
      const axes = new THREE.AxesHelper(24);
      axes.renderOrder = 40;
      scene.add(axes);

      const faceGroup = new THREE.Group();
      scene.add(faceGroup);
      const elementGroup = new THREE.Group();
      scene.add(elementGroup);
      const rebarGroup = new THREE.Group();
      scene.add(rebarGroup);
      const rebarSnapMarker = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 10),
        new THREE.MeshBasicMaterial({
          color: 0xff8a2a,
          depthTest: false,
        }),
      );
      rebarSnapMarker.visible = false;
      rebarSnapMarker.renderOrder = 50;
      scene.add(rebarSnapMarker);
      const snapSegmentGeometry = new LineSegmentsGeometry();
      snapSegmentGeometry.setPositions([0, 0, 0, 0, 0, 0]);
      const rebarSnapSegment = new LineSegments2(
        snapSegmentGeometry,
        new LineMaterial({
          color: 0xff8a2a,
          linewidth: 5,
          depthTest: false,
          resolution: new THREE.Vector2(
            renderer.domElement.clientWidth || 1,
            renderer.domElement.clientHeight || 1,
          ),
        }),
      );
      rebarSnapSegment.visible = false;
      rebarSnapSegment.renderOrder = 51;
      scene.add(rebarSnapSegment);
      const rebarPreview = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({
          color: 0xff8a2a,
          depthTest: false,
        }),
      );
      rebarPreview.visible = false;
      rebarPreview.renderOrder = 49;
      scene.add(rebarPreview);

      const geometry = new THREE.BufferGeometry();
      const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          xRange: { value: new THREE.Vector2(-1e20, 1e20) },
          yRange: { value: new THREE.Vector2(-1e20, 1e20) },
          zRange: { value: new THREE.Vector2(-1e20, 1e20) },
        },
        vertexColors: true,
      });
      const points = new THREE.Points(geometry, material);
      scene.add(points);

      const raycaster = new THREE.Raycaster();
      raycaster.params.Points = { threshold: 1.2 };
      raycaster.params.Line = { threshold: 1.2 };
      const pointer = new THREE.Vector2();
      let edgeDrag: {
        faceId: string;
        edgeIndex: number;
        start: THREE.Vector3;
        end: THREE.Vector3;
        plane: THREE.Plane;
        preview: THREE.Line;
        snapNodeId: number | null;
      } | null = null;
      let hoveredEdge: THREE.Line | null = null;
      let hoveredRebarEdge: LineSegments2 | null = null;
      let hoveredRebarVertex: Vec3 | null = null;
      let orbitDrag: {
        pointerId: number;
        x: number;
        y: number;
      } | null = null;
      let panDrag: {
        pointerId: number;
        anchor: THREE.Vector3;
        plane: THREE.Plane;
      } | null = null;
      let suppressNextClick = false;
      let pointerStart: { x: number; y: number } | null = null;

      const updatePointer = (event: PointerEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
      };

      const getNodeHit = (event: PointerEvent) => {
        updatePointer(event);
        return raycaster.intersectObject(points).find((hit) => {
          const node = nodesRef.current[hit.index ?? -1];
          if (!node) return false;
          const value = node.local ?? node.global;
          const range = sliceRef.current;
          return (
            value.x >= range.x[0] &&
            value.x <= range.x[1] &&
            value.y >= range.y[0] &&
            value.y <= range.y[1] &&
            value.z >= range.z[0] &&
            value.z <= range.z[1]
          );
        });
      };

      const setHoveredEdge = (edge: THREE.Line | null) => {
        if (hoveredEdge === edge) return;
        if (hoveredEdge) {
          (hoveredEdge.material as THREE.LineBasicMaterial).color.setHex(
            0x02070a,
          );
        }
        hoveredEdge = edge;
        if (hoveredEdge) {
          (hoveredEdge.material as THREE.LineBasicMaterial).color.setHex(
            0xffbf47,
          );
        }
      };

      const setHoveredRebarEdge = (edge: LineSegments2 | null) => {
        if (hoveredRebarEdge === edge) return;
        if (hoveredRebarEdge) {
          const selected =
            hoveredRebarEdge.userData.edgeIndex ===
            selectedRebarEdgeIndexRef.current;
          (
            hoveredRebarEdge.material as LineMaterial
          ).color.setHex(selected ? 0x48d18b : 0x05090c);
        }
        hoveredRebarEdge = edge;
        if (hoveredRebarEdge) {
          (
            hoveredRebarEdge.material as LineMaterial
          ).color.setHex(0xffbf47);
        }
      };

      const projectedDistanceToSegment = (
        event: PointerEvent,
        start: Vec3,
        end: Vec3,
      ) => {
        const rect = renderer.domElement.getBoundingClientRect();
        const project = (value: Vec3) => {
          const point = toThree(value, displayOffsetRef.current).project(camera);
          return {
            x: rect.left + ((point.x + 1) * rect.width) / 2,
            y: rect.top + ((1 - point.y) * rect.height) / 2,
          };
        };
        const first = project(start);
        const second = project(end);
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const lengthSquared = dx * dx + dy * dy;
        const amount =
          lengthSquared <= 1e-9
            ? 0
            : Math.max(
                0,
                Math.min(
                  1,
                  ((event.clientX - first.x) * dx +
                    (event.clientY - first.y) * dy) /
                    lengthSquared,
                ),
              );
        return Math.hypot(
          event.clientX - (first.x + amount * dx),
          event.clientY - (first.y + amount * dy),
        );
      };

      const closestRebarEdge = (event: PointerEvent) => {
        let closest:
          | { object: LineSegments2; index: number; distance: number }
          | null = null;
        for (const edge of rebarEdgeDataRef.current) {
          const distance = projectedDistanceToSegment(
            event,
            edge.start,
            edge.end,
          );
          if (distance <= 16 && (!closest || distance < closest.distance)) {
            closest = { object: edge.object, index: edge.index, distance };
          }
        }
        return closest;
      };

      const closestGuideVertex = (event: PointerEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        let closest: { point: Vec3; distance: number } | null = null;
        for (const line of rebarSnapLinesRef.current) {
          for (const point of line.points) {
            const projected = toThree(
              point,
              displayOffsetRef.current,
            ).project(camera);
            const distance = Math.hypot(
              event.clientX -
                (rect.left + ((projected.x + 1) * rect.width) / 2),
              event.clientY -
                (rect.top + ((1 - projected.y) * rect.height) / 2),
            );
            if (
              distance <= 18 &&
              (!closest || distance < closest.distance)
            ) {
              closest = { point, distance };
            }
          }
        }
        return closest?.point ?? null;
      };

      const closestGuidePoint = (event: PointerEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        let closest:
          | {
              point: Vec3;
              distance: number;
              segment: [Vec3, Vec3];
            }
          | null = null;
        for (const line of rebarSnapLinesRef.current) {
          const segmentCount =
            line.points.length - 1 + (line.closed ? 1 : 0);
          for (let index = 0; index < segmentCount; index += 1) {
            const start = line.points[index];
            const end = line.points[(index + 1) % line.points.length];
            const project = (point: Vec3) => {
              const projected = toThree(
                point,
                displayOffsetRef.current,
              ).project(camera);
              return {
                x: rect.left + ((projected.x + 1) * rect.width) / 2,
                y: rect.top + ((1 - projected.y) * rect.height) / 2,
              };
            };
            const first = project(start);
            const second = project(end);
            const dx = second.x - first.x;
            const dy = second.y - first.y;
            const denominator = dx * dx + dy * dy;
            const amount =
              denominator <= 1e-9
                ? 0
                : Math.max(
                    0,
                    Math.min(
                      1,
                      ((event.clientX - first.x) * dx +
                        (event.clientY - first.y) * dy) /
                        denominator,
                    ),
                  );
            const distance = Math.hypot(
              event.clientX - (first.x + dx * amount),
              event.clientY - (first.y + dy * amount),
            );
            if (
              distance <= 10 &&
              (!closest || distance < closest.distance)
            ) {
              closest = {
                point: {
                  x: start.x + (end.x - start.x) * amount,
                  y: start.y + (end.y - start.y) * amount,
                  z: start.z + (end.z - start.z) * amount,
                },
                distance,
                segment: [start, end],
              };
            }
          }
        }
        return closest;
      };

      const rebarPointAtPointer = (event: PointerEvent) => {
        updatePointer(event);
        const snapped = closestGuideVertex(event);
        if (snapped) return { point: snapped, snapped: true };
        const guidePoint = closestGuidePoint(event);
        if (guidePoint) {
          return {
            point: guidePoint.point,
            snapped: false,
            segment: guidePoint.segment,
          };
        }
        if (rebarSnapRequiredRef.current) return null;
        if (rebarSectionRef.current === null) return null;
        const drawingPlane = rebarDrawingPlaneRef.current;
        const axis = rebarAxisRef.current;
        const normal = drawingPlane
          ? new THREE.Vector3(
              drawingPlane.normal.x,
              drawingPlane.normal.y,
              drawingPlane.normal.z,
            ).normalize()
          : new THREE.Vector3(
              axis === "x" ? 1 : 0,
              axis === "y" ? 1 : 0,
              axis === "z" ? 1 : 0,
            );
        const sectionPoint = drawingPlane
          ? new THREE.Vector3(
              drawingPlane.origin.x - displayOffsetRef.current.x,
              drawingPlane.origin.y - displayOffsetRef.current.y,
              drawingPlane.origin.z - displayOffsetRef.current.z,
            ).addScaledVector(normal, rebarSectionRef.current)
          : new THREE.Vector3(
              axis === "x" ? rebarSectionRef.current - displayOffsetRef.current.x : 0,
              axis === "y" ? rebarSectionRef.current - displayOffsetRef.current.y : 0,
              axis === "z" ? rebarSectionRef.current - displayOffsetRef.current.z : 0,
            );
        const plane = new THREE.Plane(normal, -normal.dot(sectionPoint));
        const projected = raycaster.ray.intersectPlane(
          plane,
          new THREE.Vector3(),
        );
        if (!projected) return null;
        const point: Vec3 = {
          x: projected.x + displayOffsetRef.current.x,
          y: projected.y + displayOffsetRef.current.y,
          z: projected.z + displayOffsetRef.current.z,
        };
        const previous =
          pendingRebarLineRef.current?.points[
            (pendingRebarLineRef.current?.points.length ?? 0) - 1
          ];
        if (previous) {
          const planeVertical = drawingPlane
            ? new THREE.Vector3(
                drawingPlane.vertical.x,
                drawingPlane.vertical.y,
                drawingPlane.vertical.z,
              )
                .addScaledVector(
                  normal,
                  -normal.dot(
                    new THREE.Vector3(
                      drawingPlane.vertical.x,
                      drawingPlane.vertical.y,
                      drawingPlane.vertical.z,
                    ),
                  ),
                )
                .normalize()
            : new THREE.Vector3(
                axis === "z" ? 0 : 0,
                axis === "z" ? 1 : 0,
                axis === "z" ? 0 : 1,
              );
          const planeHorizontal = new THREE.Vector3()
            .crossVectors(planeVertical, normal)
            .normalize();
          const delta = new THREE.Vector3(
            point.x - previous.x,
            point.y - previous.y,
            point.z - previous.z,
          );
          const horizontalDelta = planeHorizontal.dot(delta);
          const verticalDelta = planeVertical.dot(delta);
          const angle =
            (Math.atan2(
              Math.abs(verticalDelta),
              Math.abs(horizontalDelta),
            ) *
              180) /
            Math.PI;
          if (angle <= 5) {
            point.x = previous.x + planeHorizontal.x * horizontalDelta;
            point.y = previous.y + planeHorizontal.y * horizontalDelta;
            point.z = previous.z + planeHorizontal.z * horizontalDelta;
          } else if (angle >= 85) {
            point.x = previous.x + planeVertical.x * verticalDelta;
            point.y = previous.y + planeVertical.y * verticalDelta;
            point.z = previous.z + planeVertical.z * verticalDelta;
          }
        }
        return { point, snapped: false };
      };

      const getSnapNode = (faceId: string, event: PointerEvent) => {
        const face = facesRef.current.find((candidate) => candidate.id === faceId);
        if (!face) return null;
        const faceTolerance = Math.max(
          toleranceRef.current * 2,
          (face.fitDeviation ?? 0) * 1.25,
        );
        const rect = renderer.domElement.getBoundingClientRect();
        let closest:
          | { node: ModelNode; point: THREE.Vector3; distance: number }
          | null = null;
        for (const node of nodesRef.current) {
          if (face.nodeIds.includes(node.id)) continue;
          const planeDistance = Math.abs(
            face.plane.normal.x * node.global.x +
              face.plane.normal.y * node.global.y +
              face.plane.normal.z * node.global.z +
              face.plane.constant,
          );
          if (planeDistance > faceTolerance) continue;
          const value = node.local ?? node.global;
          const point = toThree(value, displayOffsetRef.current);
          const projected = point.clone().project(camera);
          const clientX = rect.left + ((projected.x + 1) / 2) * rect.width;
          const clientY = rect.top + ((1 - projected.y) / 2) * rect.height;
          const distance = Math.hypot(
            clientX - event.clientX,
            clientY - event.clientY,
          );
          if (distance <= 20 && (!closest || distance < closest.distance)) {
            closest = { node, point, distance };
          }
        }
        return closest;
      };

      const rotateNaturally = (deltaX: number, deltaY: number) => {
        const offset = camera.position.clone().sub(controls.target);
        const toYUp = new THREE.Quaternion().setFromUnitVectors(
          camera.up.clone().normalize(),
          new THREE.Vector3(0, 1, 0),
        );
        const fromYUp = toYUp.clone().invert();
        offset.applyQuaternion(toYUp);
        const spherical = new THREE.Spherical().setFromVector3(offset);
        const radiansPerPixel =
          (Math.PI * 2) /
          Math.max(renderer.domElement.clientHeight, 1);
        spherical.theta -= deltaX * radiansPerPixel;
        spherical.phi -= deltaY * radiansPerPixel;
        spherical.makeSafe();
        offset.setFromSpherical(spherical).applyQuaternion(fromYUp);
        camera.position.copy(controls.target).add(offset);
        camera.lookAt(controls.target);
        controls.update();
      };

      const panToPointer = (event: PointerEvent) => {
        if (!panDrag) return;
        camera.updateMatrixWorld(true);
        updatePointer(event);
        const current = raycaster.ray.intersectPlane(
          panDrag.plane,
          new THREE.Vector3(),
        );
        if (!current) return;
        const translation = panDrag.anchor.clone().sub(current);
        camera.position.add(translation);
        controls.target.add(translation);
        camera.lookAt(controls.target);
        camera.updateMatrixWorld(true);
        controls.update();
      };

      const handleMove = (event: PointerEvent) => {
        if (
          pointerStart &&
          Math.hypot(
            event.clientX - pointerStart.x,
            event.clientY - pointerStart.y,
          ) > 4
        ) {
          suppressNextClick = true;
        }
        if (panDrag) {
          panToPointer(event);
          renderer.domElement.style.cursor = "move";
          onHoverRef.current(null);
          onHoverFaceRef.current(null);
          return;
        }
        if (orbitDrag && !edgeDrag) {
          rotateNaturally(
            event.clientX - orbitDrag.x,
            event.clientY - orbitDrag.y,
          );
          orbitDrag.x = event.clientX;
          orbitDrag.y = event.clientY;
          renderer.domElement.style.cursor = "grabbing";
          onHoverRef.current(null);
          onHoverFaceRef.current(null);
          return;
        }
        if (rebarDrawingRef.current) {
          const candidate = rebarPointAtPointer(event);
          hoveredRebarVertex = candidate?.snapped
            ? candidate.point
            : null;
          rebarSnapMarker.visible = Boolean(hoveredRebarVertex);
          if (hoveredRebarVertex) {
            rebarSnapMarker.position.copy(
              toThree(hoveredRebarVertex, displayOffsetRef.current),
            );
            const distance = camera.position.distanceTo(
              rebarSnapMarker.position,
            );
            rebarSnapMarker.scale.setScalar(
              Math.max(toleranceRef.current * 10, distance * 0.006),
            );
          }
          rebarSnapSegment.visible = Boolean(candidate?.segment);
          if (candidate?.segment) {
            const start = toThree(
              candidate.segment[0],
              displayOffsetRef.current,
            );
            const end = toThree(
              candidate.segment[1],
              displayOffsetRef.current,
            );
            (
              rebarSnapSegment.geometry as LineSegmentsGeometry
            ).setPositions([...start.toArray(), ...end.toArray()]);
          }
          const previous =
            pendingRebarLineRef.current?.points[
              (pendingRebarLineRef.current?.points.length ?? 0) - 1
            ] ?? rebarPreviewStartRef.current;
          if (previous && candidate) {
            rebarPreview.geometry.setFromPoints([
              toThree(previous, displayOffsetRef.current),
              toThree(candidate.point, displayOffsetRef.current),
            ]);
            rebarPreview.visible = true;
            if (inchesPerModelUnitRef.current) {
              setSegmentLengthHud({
                clientX: event.clientX,
                clientY: event.clientY,
                inches:
                  Math.hypot(
                    candidate.point.x - previous.x,
                    candidate.point.y - previous.y,
                    candidate.point.z - previous.z,
                  ) * inchesPerModelUnitRef.current,
              });
            }
          } else {
            rebarPreview.visible = false;
            setSegmentLengthHud(null);
          }
          renderer.domElement.style.cursor = candidate
            ? "crosshair"
            : "default";
          onHoverRef.current(null);
          onHoverFaceRef.current(null);
          return;
        }
        rebarSnapMarker.visible = false;
        rebarSnapSegment.visible = false;
        rebarPreview.visible = false;
        setSegmentLengthHud(null);
        if (rebarEdgeSelectionModeRef.current) {
          const edgeHit = closestRebarEdge(event);
          setHoveredRebarEdge(edgeHit?.object ?? null);
          renderer.domElement.style.cursor = edgeHit ? "pointer" : "default";
          onHoverRef.current(null);
          onHoverFaceRef.current(null);
          return;
        }
        if (elementEditModeRef.current) {
          updatePointer(event);
          const elementHit = elementMeshRef.current
            ? raycaster.intersectObject(elementMeshRef.current)[0]
            : undefined;
          renderer.domElement.style.cursor = elementHit ? "pointer" : "crosshair";
          onHoverRef.current(null);
          onHoverFaceRef.current(null);
          return;
        }
        const hit = getNodeHit(event);
        updatePointer(event);
        const faceHit = raycaster.intersectObjects(faceMeshesRef.current)[0];
        const faceId = faceHit?.object.userData.faceId as string | undefined;
        const edgeHit = raycaster
          .intersectObjects(faceEdgesRef.current)
          .find(
            (candidate) =>
              candidate.object.userData.faceId === editableFaceIdRef.current,
          );
        let snappedNode: ModelNode | null = null;
        if (!edgeDrag) {
          setHoveredEdge((edgeHit?.object as THREE.Line | undefined) ?? null);
        } else {
          const snap = getSnapNode(edgeDrag.faceId, event);
          const bend =
            snap?.point ??
            raycaster.ray.intersectPlane(
              edgeDrag.plane,
              new THREE.Vector3(),
            );
          edgeDrag.snapNodeId = snap?.node.id ?? null;
          snappedNode = snap?.node ?? null;
          if (bend) {
            edgeDrag.preview.geometry.setFromPoints([
              edgeDrag.start,
              bend,
              edgeDrag.end,
            ]);
          }
        }
        onHoverFaceRef.current(faceId ?? null);
        renderer.domElement.style.cursor = edgeDrag
          ? edgeDrag.snapNodeId !== null
            ? "copy"
            : "grabbing"
          : edgeHit
            ? "pointer"
          : hit
            ? "crosshair"
            : faceId
              ? "pointer"
              : "grab";
        if (snappedNode) {
          onHoverRef.current({
            node: snappedNode,
            clientX: event.clientX,
            clientY: event.clientY,
          });
        } else if (hit?.index !== undefined) {
          onHoverRef.current({
            node: nodesRef.current[hit.index],
            clientX: event.clientX,
            clientY: event.clientY,
          });
        } else {
          onHoverRef.current(null);
        }
      };

      const handlePointerDown = (event: PointerEvent) => {
        if (event.button === 1) {
          camera.updateMatrixWorld(true);
          updatePointer(event);
          const viewNormal = camera.getWorldDirection(new THREE.Vector3());
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
            viewNormal,
            controls.target,
          );
          const anchor = raycaster.ray.intersectPlane(
            plane,
            new THREE.Vector3(),
          );
          if (!anchor) return;
          panDrag = { pointerId: event.pointerId, anchor, plane };
          renderer.domElement.setPointerCapture(event.pointerId);
          event.preventDefault();
          return;
        }
        if (event.button === 0) {
          pointerStart = { x: event.clientX, y: event.clientY };
        }
        if (event.button !== 0) return;
        updatePointer(event);
        const edgeHit = editableFaceIdRef.current
          ? raycaster
              .intersectObjects(faceEdgesRef.current)
              .find(
                (hit) =>
                  hit.object.userData.faceId === editableFaceIdRef.current,
              )
          : undefined;
        if (edgeHit) {
          const edge = edgeHit.object as THREE.Line;
          const start = (edge.userData.start as THREE.Vector3).clone();
          const end = (edge.userData.end as THREE.Vector3).clone();
          const preview = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([start, start, end]),
            new THREE.LineBasicMaterial({
              color: 0xffbf47,
              opacity: 1,
              transparent: true,
            }),
          );
          scene.add(preview);
          edgeDrag = {
            faceId: edgeHit.object.userData.faceId as string,
            edgeIndex: edgeHit.object.userData.edgeIndex as number,
            start,
            end,
            plane: edge.userData.plane as THREE.Plane,
            preview,
            snapNodeId: null,
          };
          suppressNextClick = true;
          controls.enabled = false;
        } else {
          orbitDrag = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          };
        }
        renderer.domElement.setPointerCapture(event.pointerId);
        event.preventDefault();
      };

      const handlePointerUp = (event: PointerEvent) => {
        if (event.button === 0) pointerStart = null;
        if (panDrag && event.button === 1) {
          panDrag = null;
          if (renderer.domElement.hasPointerCapture(event.pointerId)) {
            renderer.domElement.releasePointerCapture(event.pointerId);
          }
          event.preventDefault();
          return;
        }
        if (orbitDrag && event.button === 0) {
          orbitDrag = null;
          if (renderer.domElement.hasPointerCapture(event.pointerId)) {
            renderer.domElement.releasePointerCapture(event.pointerId);
          }
          event.preventDefault();
          return;
        }
        if (!edgeDrag || event.button !== 0) return;
        if (edgeDrag.snapNodeId !== null) {
          onInsertFaceVertexRef.current(
            edgeDrag.faceId,
            edgeDrag.edgeIndex,
            edgeDrag.snapNodeId,
          );
        }
        scene.remove(edgeDrag.preview);
        edgeDrag.preview.geometry.dispose();
        (edgeDrag.preview.material as THREE.Material).dispose();
        edgeDrag = null;
        controls.enabled = true;
        if (renderer.domElement.hasPointerCapture(event.pointerId)) {
          renderer.domElement.releasePointerCapture(event.pointerId);
        }
        event.preventDefault();
      };

      const handlePointerCancel = (event: PointerEvent) => {
        pointerStart = null;
        orbitDrag = null;
        panDrag = null;
        if (edgeDrag) {
          scene.remove(edgeDrag.preview);
          edgeDrag.preview.geometry.dispose();
          (edgeDrag.preview.material as THREE.Material).dispose();
          edgeDrag = null;
          controls.enabled = true;
        }
        if (renderer.domElement.hasPointerCapture(event.pointerId)) {
          renderer.domElement.releasePointerCapture(event.pointerId);
        }
      };

      const handleContextMenu = (event: MouseEvent) => {
        if (!editableFaceIdRef.current) return;
        const nodeHit = getNodeHit(event as unknown as PointerEvent);
        if (nodeHit?.index === undefined) return;
        const nodeId = nodesRef.current[nodeHit.index].id;
        const face = facesRef.current.find(
          (candidate) => candidate.id === editableFaceIdRef.current,
        );
        if (!face?.nodeIds.includes(nodeId)) return;
        event.preventDefault();
        onRemoveFaceVertexRef.current(face.id, nodeId);
      };

      const handleClick = (event: PointerEvent) => {
        if (event.button !== 0) return;
        if (suppressNextClick) {
          suppressNextClick = false;
          return;
        }
        updatePointer(event);

        if (rebarDrawingRef.current) {
          const candidate =
            hoveredRebarVertex !== null
              ? { point: hoveredRebarVertex }
              : rebarPointAtPointer(event);
          if (candidate) onPickRebarPointRef.current(candidate.point);
          return;
        }

        if (rebarEdgeSelectionModeRef.current) {
          const hit = closestRebarEdge(event);
          if (hit) onPickRebarEdgeRef.current(hit.index);
          return;
        }

        if (elementEditModeRef.current) {
          const hit = elementMeshRef.current
            ? raycaster.intersectObject(elementMeshRef.current)[0]
            : undefined;
          const faceIndex = hit?.faceIndex;
          const elementId =
            typeof faceIndex === "number"
              ? triangleElementIdsRef.current[faceIndex]
              : undefined;
          if (elementId !== undefined) onPickElementRef.current(elementId);
          return;
        }

        if (pickTargetRef.current === "face") {
          const faceHit = raycaster.intersectObjects(faceMeshesRef.current)[0];
          const faceId = faceHit?.object.userData.faceId as string | undefined;
          if (faceId) onPickFaceRef.current(faceId);
          return;
        }

        const nodeHit = getNodeHit(event);
        if (nodeHit?.index !== undefined) {
          onPickNodeRef.current(nodesRef.current[nodeHit.index].id);
        }
      };

      const preventAuxiliaryClick = (event: MouseEvent) => {
        if (event.button === 1) event.preventDefault();
      };

      renderer.domElement.addEventListener("pointermove", handleMove);
      const handleLeave = () => {
        onHoverRef.current(null);
        onHoverFaceRef.current(null);
        rebarSnapMarker.visible = false;
        rebarSnapSegment.visible = false;
        rebarPreview.visible = false;
        setSegmentLengthHud(null);
        setHoveredRebarEdge(null);
      };
      renderer.domElement.addEventListener("pointerleave", handleLeave);
      renderer.domElement.addEventListener("pointerdown", handlePointerDown);
      renderer.domElement.addEventListener("pointerup", handlePointerUp);
      renderer.domElement.addEventListener(
        "pointercancel",
        handlePointerCancel,
      );
      renderer.domElement.addEventListener("click", handleClick);
      renderer.domElement.addEventListener("contextmenu", handleContextMenu);
      renderer.domElement.addEventListener("auxclick", preventAuxiliaryClick);

      const resizeObserver = new ResizeObserver(() => {
        const { clientWidth, clientHeight } = host;
        if (!clientWidth || !clientHeight) return;
        renderer.setSize(clientWidth, clientHeight, false);
        camera.aspect = clientWidth / clientHeight;
        camera.updateProjectionMatrix();
      });
      resizeObserver.observe(host);

      let animationId = 0;
      const handleContextLost = (event: Event) => {
        event.preventDefault();
        cancelAnimationFrame(animationId);
        setRenderError(
          "The browser lost access to the graphics processor. Enable WebGL or hardware acceleration and reload.",
        );
      };
      renderer.domElement.addEventListener(
        "webglcontextlost",
        handleContextLost,
      );

      let lastRenderTime = 0;
      const animate = (time = 0) => {
        try {
          if (time - lastRenderTime >= 1000 / 30) {
            controls.update();
            renderer.render(scene, camera);
            lastRenderTime = time;
          }
          animationId = requestAnimationFrame(animate);
        } catch (error) {
          cancelAnimationFrame(animationId);
          setRenderError(
            error instanceof Error
              ? `The 3D view stopped: ${error.message}`
              : "The graphics processor became unavailable.",
          );
        }
      };
      animationId = requestAnimationFrame(animate);

      sceneRef.current = {
        camera,
        controls,
        faceGroup,
        elementGroup,
        grid,
        axes,
        rebarGroup,
        rebarSnapMarker,
        rebarSnapSegment,
        rebarPreview,
        geometry,
        material,
        points,
        raycaster,
        renderer,
        scene,
        resizeObserver,
      };

      return () => {
        cancelAnimationFrame(animationId);
        resizeObserver.disconnect();
        renderer.domElement.removeEventListener("pointermove", handleMove);
        renderer.domElement.removeEventListener("pointerleave", handleLeave);
        renderer.domElement.removeEventListener(
          "pointerdown",
          handlePointerDown,
        );
        renderer.domElement.removeEventListener("pointerup", handlePointerUp);
        renderer.domElement.removeEventListener(
          "pointercancel",
          handlePointerCancel,
        );
        renderer.domElement.removeEventListener("click", handleClick);
        renderer.domElement.removeEventListener(
          "contextmenu",
          handleContextMenu,
        );
        renderer.domElement.removeEventListener(
          "auxclick",
          preventAuxiliaryClick,
        );
        renderer.domElement.removeEventListener(
          "webglcontextlost",
          handleContextLost,
        );
        disposeGroup(faceGroup);
        disposeGroup(elementGroup);
        disposeGroup(rebarGroup);
        rebarSnapMarker.geometry.dispose();
        (rebarSnapMarker.material as THREE.Material).dispose();
        rebarSnapSegment.geometry.dispose();
        rebarSnapSegment.material.dispose();
        rebarPreview.geometry.dispose();
        (rebarPreview.material as THREE.Material).dispose();
        geometry.dispose();
        material.dispose();
        renderer.dispose();
        controls.dispose();
        renderer.domElement.remove();
        sceneRef.current = null;
      };
    } catch (error) {
      setRenderError(
        error instanceof Error
          ? `3D rendering could not start: ${error.message}`
          : "3D rendering could not start in this browser.",
      );
    }
  }, []);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    const solidView = slicingMode || rebarMode;
    state.points.visible = !solidView || showRebarPlaneNodes;
    state.grid.visible = !solidView;
    state.faceGroup.visible = !(solidView && elementSurfaces.length > 0);
  }, [elementSurfaces.length, rebarMode, showRebarPlaneNodes, slicingMode]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    state.axes.visible = showAxes;
  }, [showAxes]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state || !nodes.length) return;

    const positions = new Float32Array(nodes.length * 3);
    const colors = new Float32Array(nodes.length * 3);
    const coordinates = new Float32Array(nodes.length * 3);
    const base = new THREE.Color(0x111111);
    const selected = new THREE.Color(0xf28c28);
    const invalid = new THREE.Color(0xff4d62);

    nodes.forEach((node, index) => {
      const value = node.local ?? node.global;
      positions[index * 3] = value.x - displayOffset.x;
      positions[index * 3 + 1] = value.y - displayOffset.y;
      positions[index * 3 + 2] = value.z - displayOffset.z;
      coordinates[index * 3] = value.x;
      coordinates[index * 3 + 1] = value.y;
      coordinates[index * 3 + 2] = value.z;
      const color = invalidNodeIds.includes(node.id)
        ? invalid
        : selectedNodeIds.includes(node.id)
          ? selected
          : base;
      colors[index * 3] = color.r;
      colors[index * 3 + 1] = color.g;
      colors[index * 3 + 2] = color.b;
    });

    state.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(positions, 3),
    );
    state.geometry.setAttribute(
      "nodeColor",
      new THREE.BufferAttribute(colors, 3),
    );
    state.geometry.setAttribute(
      "sliceCoord",
      new THREE.BufferAttribute(coordinates, 3),
    );
    state.geometry.computeBoundingSphere();
    const modelRadius = state.geometry.boundingSphere?.radius ?? 1;
    state.axes.scale.setScalar(Math.max(modelRadius / 24, 0.01));
    state.axes.position.copy(state.controls.target);
    state.raycaster.params.Points.threshold = Math.max(
      (state.geometry.boundingSphere?.radius ?? 1) / 125,
      0.15,
    );
    state.raycaster.params.Line.threshold = Math.max(
      (state.geometry.boundingSphere?.radius ?? 1) / 160,
      0.12,
    );
    if (
      fittedNodesRef.current !== allNodes ||
      fittedBasisRef.current !== basis
    ) {
      fitCamera(
        state.camera,
        state.controls,
        state.geometry,
        Boolean(basis),
      );
      fittedNodesRef.current = allNodes;
      fittedBasisRef.current = basis;
    }
  }, [
    allNodes,
    basis,
    nodes,
    displayOffset.x,
    displayOffset.y,
    displayOffset.z,
  ]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    disposeGroup(state.elementGroup);
    elementMeshRef.current = null;
    triangleElementIdsRef.current = [];
    const solidView = slicingMode || rebarMode;
    const lineOnly = (rebarMode || slicingMode) && lineAndBar;
    const renderElementSkin = rebarMode
      ? showConcreteSkin || lineOnly
      : lineOnly || showElementSkin || slicingMode;
    state.elementGroup.visible = renderElementSkin;
    if (!renderElementSkin || !elementSurfaces.length) return;

    if (
      solidView &&
      elements.some((element) => element.type === "SOLID")
    ) {
      const buffers = clippedSolidBuffers(
        elements,
        allNodes,
        basis,
        slice,
        displayOffset,
        displayCustomClipPlane,
      );
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(buffers.positions, 3),
      );
      geometry.computeVertexNormals();
      if (!lineOnly) {
        const mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshBasicMaterial({
            color: 0xc8d0d3,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
            side: THREE.DoubleSide,
          }),
        );
        state.elementGroup.add(mesh);
      } else {
        geometry.dispose();
      }

      const exteriorGeometry = new THREE.BufferGeometry();
      exteriorGeometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          clippedExteriorPositions(
            elementSurfaces,
            basis,
            slice,
            displayOffset,
            displayCustomClipPlane,
          ),
          3,
        ),
      );
      const featureGeometry = new THREE.EdgesGeometry(exteriorGeometry, 25);
      exteriorGeometry.dispose();
      if (featureGeometry.getAttribute("position").count) {
        state.elementGroup.add(
          new THREE.LineSegments(
            featureGeometry,
            new THREE.LineBasicMaterial({
              color: lineOnly ? 0xaeb9be : 0x05090c,
              opacity: lineOnly ? 0.96 : 0.82,
              transparent: true,
            }),
          ),
        );
      } else {
        featureGeometry.dispose();
      }

      if (buffers.capPositions.length) {
        const capGeometry = new THREE.BufferGeometry();
        capGeometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(buffers.capPositions, 3),
        );
        const capOutline = new THREE.EdgesGeometry(capGeometry, 25);
        capGeometry.dispose();
        const outlineAttribute = capOutline.getAttribute("position");
        const cutGeometry = new LineSegmentsGeometry();
        cutGeometry.setPositions(
          Array.from(outlineAttribute.array as ArrayLike<number>),
        );
        capOutline.dispose();
        const cutMaterial = new LineMaterial({
          color: lineOnly ? 0xd8e0e3 : 0x05090c,
          linewidth: 3,
          resolution: new THREE.Vector2(
            state.renderer.domElement.clientWidth,
            state.renderer.domElement.clientHeight,
          ),
        });
        const cuts = new LineSegments2(cutGeometry, cutMaterial);
        cuts.computeLineDistances();
        state.elementGroup.add(cuts);
      }
      return;
    }

    const toDisplay = (point: Vec3) => (basis ? toLocal(point, basis) : point);
    const trianglePositions: number[] = [];
    const triangleColors: number[] = [];
    const edgePositions: number[] = [];
    const cutEdgePositions: number[] = [];
    const normalColor = new THREE.Color(
      solidView ? 0xc8d0d3 : elementEditMode ? 0xffbf47 : 0x91afba,
    );
    const selectedColor = new THREE.Color(0xff4d62);
    const clippingPlanes = solidView
      ? [
          new THREE.Plane(
            new THREE.Vector3(1, 0, 0),
            displayOffset.x - slice.x[0],
          ),
          new THREE.Plane(
            new THREE.Vector3(-1, 0, 0),
            slice.x[1] - displayOffset.x,
          ),
          new THREE.Plane(
            new THREE.Vector3(0, 1, 0),
            displayOffset.y - slice.y[0],
          ),
          new THREE.Plane(
            new THREE.Vector3(0, -1, 0),
            slice.y[1] - displayOffset.y,
          ),
          new THREE.Plane(
            new THREE.Vector3(0, 0, 1),
            displayOffset.z - slice.z[0],
          ),
          new THREE.Plane(
            new THREE.Vector3(0, 0, -1),
            slice.z[1] - displayOffset.z,
          ),
        ].concat(
          displayCustomClipPlane
            ? [
                new THREE.Plane(
                  new THREE.Vector3(
                    displayCustomClipPlane.normal.x,
                    displayCustomClipPlane.normal.y,
                    displayCustomClipPlane.normal.z,
                  ),
                  displayCustomClipPlane.constant +
                    displayCustomClipPlane.normal.x * displayOffset.x +
                    displayCustomClipPlane.normal.y * displayOffset.y +
                    displayCustomClipPlane.normal.z * displayOffset.z,
                ),
              ]
            : [],
        )
      : [];
    const activeCuts =
      solidView && sliceBounds
        ? clippingPlanes.filter((_, index) => {
            if (index >= 6) return true;
            const axis = (["x", "x", "y", "y", "z", "z"] as const)[index];
            const endpoint = index % 2;
            const coordinate =
              endpoint === 0 ? slice[axis][0] : slice[axis][1];
            const span =
              sliceBounds[axis][1] - sliceBounds[axis][0];
            return (
              Math.abs(coordinate - sliceBounds[axis][endpoint]) >
              Math.max(Math.abs(span) * 1e-7, 1e-9)
            );
          })
        : [];

    const addCutSegment = (
      triangle: THREE.Vector3[],
      plane: THREE.Plane,
    ) => {
      const hits: THREE.Vector3[] = [];
      for (let index = 0; index < 3; index += 1) {
        const a = triangle[index];
        const b = triangle[(index + 1) % 3];
        const da = plane.distanceToPoint(a);
        const db = plane.distanceToPoint(b);
        if (Math.abs(da) < 1e-8) hits.push(a.clone());
        if (da * db < 0) hits.push(a.clone().lerp(b, da / (da - db)));
      }
      const unique = hits.filter(
        (hit, index) =>
          hits.findIndex(
            (candidate) => candidate.distanceToSquared(hit) < 1e-14,
          ) === index,
      );
      if (unique.length >= 2) {
        cutEdgePositions.push(
          unique[0].x,
          unique[0].y,
          unique[0].z,
          unique[1].x,
          unique[1].y,
          unique[1].z,
        );
      }
    };

    for (const surface of elementSurfaces) {
      const vertices = surface.vertices.map(toDisplay);
      for (let index = 1; index < vertices.length - 1; index += 1) {
        const color = selectedElementIds.includes(surface.elementId)
          ? selectedColor
          : normalColor;
        const triangle = [
          vertices[0],
          vertices[index],
          vertices[index + 1],
        ].map((vertex) => toThree(vertex, displayOffset));
        triangle.forEach((point) => {
          trianglePositions.push(point.x, point.y, point.z);
          triangleColors.push(color.r, color.g, color.b);
        });
        activeCuts.forEach((plane) => addCutSegment(triangle, plane));
        triangleElementIdsRef.current.push(surface.elementId);
      }
      vertices.forEach((vertex, index) => {
        const next = vertices[(index + 1) % vertices.length];
        const a = toThree(vertex, displayOffset);
        const b = toThree(next, displayOffset);
        edgePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      });
    }

    const meshGeometry = new THREE.BufferGeometry();
    meshGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(trianglePositions, 3),
    );
    meshGeometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(triangleColors, 3),
    );
    meshGeometry.computeVertexNormals();
    if (!lineOnly) {
      const elementMesh = new THREE.Mesh(
        meshGeometry,
        new THREE.MeshBasicMaterial({
          clippingPlanes,
          vertexColors: true,
          opacity: solidView
            ? 1
            : elementEditMode
              ? 0.42
              : volumeConfirmed
                ? 0.18
                : 0.1,
          transparent: !solidView,
          depthWrite: solidView,
          side: THREE.DoubleSide,
        }),
      );
      elementMeshRef.current = elementMesh;
      state.elementGroup.add(elementMesh);
    }

    if (lineOnly) {
      const outlineGeometry = new THREE.EdgesGeometry(meshGeometry, 25);
      if (outlineGeometry.getAttribute("position").count) {
        state.elementGroup.add(
          new THREE.LineSegments(
            outlineGeometry,
            new THREE.LineBasicMaterial({
              clippingPlanes,
              color: 0xaeb9be,
              depthTest: false,
            }),
          ),
        );
      } else {
        outlineGeometry.dispose();
      }
      meshGeometry.dispose();
    } else if (!solidView) {
      const edgeGeometry = new THREE.BufferGeometry();
      edgeGeometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(edgePositions, 3),
      );
      state.elementGroup.add(
        new THREE.LineSegments(
          edgeGeometry,
          new THREE.LineBasicMaterial({
            color: 0x05090c,
            opacity: 0.72,
            transparent: true,
          }),
        ),
      );
    } else if (cutEdgePositions.length) {
      const cutGeometry = new THREE.BufferGeometry();
      cutGeometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(cutEdgePositions, 3),
      );
      state.elementGroup.add(
        new THREE.LineSegments(
          cutGeometry,
          new THREE.LineBasicMaterial({
            clippingPlanes,
            color: 0x05090c,
          }),
        ),
      );
    }
  }, [
    allNodes,
    basis,
    displayOffset.x,
    displayOffset.y,
    displayOffset.z,
    elementSurfaces,
    elements,
    elementEditMode,
    selectedElementIds,
    showElementSkin,
    rebarMode,
    showRebarScene,
    displayCustomClipPlane,
    showConcreteSkin,
    lineAndBar,
    slice,
    sliceBounds,
    slicingMode,
    volumeConfirmed,
  ]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    disposeGroup(state.rebarGroup);
    rebarGuideObjectsRef.current = [];
    rebarEdgeObjectsRef.current = [];
    rebarEdgeDataRef.current = [];
    rebarGuidePointsRef.current = rebarGuideLines.flatMap(
      (line) => line.points,
    );
    state.rebarGroup.visible = showRebarScene;
    if (!showRebarScene) return;

    const addPolyline = (
      points: Vec3[],
      color: number,
      opacity = 1,
      closed = true,
    ) => {
      if (points.length < 2) return;
      const geometry = new THREE.BufferGeometry().setFromPoints([
        ...points.map((point) => toThree(point, displayOffset)),
        ...(closed ? [toThree(points[0], displayOffset)] : []),
      ]);
      const line = new THREE.Line(
          geometry,
          new THREE.LineBasicMaterial({
            color,
            opacity,
            transparent: opacity < 1,
          }),
        );
      state.rebarGroup.add(line);
      return line;
    };

    const addRodMeshes = (
      segments: Array<[Vec3, Vec3]>,
      joints: Vec3[],
      color: number,
      alwaysVisible = false,
      radiusScale = 1,
    ) => {
      if (!segments.length || !inchesPerModelUnit) return;
      const radius = (0.5 * radiusScale) / inchesPerModelUnit;
      const rodMaterial = new THREE.MeshBasicMaterial({
        color,
        depthTest: !alwaysVisible,
        depthWrite: !alwaysVisible,
      });
      const rods = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(radius, radius, 1, 8),
        rodMaterial,
        segments.length,
      );
      const up = new THREE.Vector3(0, 1, 0);
      const matrix = new THREE.Matrix4();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      segments.forEach(([start, end], index) => {
        const first = toThree(start, displayOffset);
        const second = toThree(end, displayOffset);
        const direction = second.clone().sub(first);
        const length = direction.length();
        quaternion.setFromUnitVectors(up, direction.normalize());
        scale.set(1, length, 1);
        matrix.compose(
          first.clone().add(second).multiplyScalar(0.5),
          quaternion,
          scale,
        );
        rods.setMatrixAt(index, matrix);
      });
      rods.instanceMatrix.needsUpdate = true;
      rods.renderOrder = alwaysVisible ? 30 : 5;
      state.rebarGroup.add(rods);

      const jointMeshes = new THREE.InstancedMesh(
        new THREE.SphereGeometry(radius, 8, 6),
        rodMaterial.clone(),
        joints.length,
      );
      joints.forEach((point, index) => {
        const translated = toThree(point, displayOffset);
        matrix.makeTranslation(translated.x, translated.y, translated.z);
        jointMeshes.setMatrixAt(index, matrix);
      });
      jointMeshes.instanceMatrix.needsUpdate = true;
      jointMeshes.renderOrder = alwaysVisible ? 30 : 5;
      state.rebarGroup.add(jointMeshes);
    };

    type RodBuffers = {
      segments: Array<[Vec3, Vec3]>;
      joints: Vec3[];
    };
    const rodsByColor = new Map<string, RodBuffers>();
    const selectedRodsByColor = new Map<string, RodBuffers>();
    for (const run of rebarRuns) {
      const runSelected = selectedRebarRunIds.has(run.id);
      const color = run.color ?? "#8f1717";
      const colorBuffers = rodsByColor.get(color) ?? {
        segments: [],
        joints: [],
      };
      const selectedColorBuffers = selectedRodsByColor.get(color) ?? {
        segments: [],
        joints: [],
      };
      if (!runSelected && !rodsByColor.has(color)) {
        rodsByColor.set(color, colorBuffers);
      }
      if (runSelected && !selectedRodsByColor.has(color)) {
        selectedRodsByColor.set(color, selectedColorBuffers);
      }
      const targetSegments = runSelected
        ? selectedColorBuffers.segments
        : colorBuffers.segments;
      const targetJoints = runSelected
        ? selectedColorBuffers.joints
        : colorBuffers.joints;
      const lapOffset =
        inchesPerModelUnit && run.lapOffsetInches
          ? run.lapOffsetInches / inchesPerModelUnit
          : 0;
      for (const position of run.positions) {
        const pathTranslation =
          run.pathPoints && run.pathPoints.length >= 2
            ? (() => {
                const pathPoint = pointAlongPolyline(
                  run.pathPoints!,
                  position + lapOffset,
                );
                const origin = run.pathPoints![0];
                return {
                  x: pathPoint.x - origin.x,
                  y: pathPoint.y - origin.y,
                  z: pathPoint.z - origin.z,
                };
              })()
            : null;
        for (const line of run.lines) {
          const translated = line.points.map((point) => {
            if (pathTranslation) {
              return {
                x: point.x + pathTranslation.x,
                y: point.y + pathTranslation.y,
                z: point.z + pathTranslation.z,
              };
            }
            if (
              (run.distributionMode === "edge" ||
                run.distributionMode === "path") &&
              run.distributionVector
            ) {
              return {
                x:
                  point.x +
                  run.distributionVector.x * (position + lapOffset),
                y:
                  point.y +
                  run.distributionVector.y * (position + lapOffset),
                z:
                  point.z +
                  run.distributionVector.z * (position + lapOffset),
              };
            }
            return {
              ...point,
              [run.axis]: position + lapOffset,
            };
          });
          targetJoints.push(...translated);
          for (let index = 0; index < translated.length - 1; index += 1) {
            targetSegments.push([translated[index], translated[index + 1]]);
          }
          if (line.closed && translated.length > 2) {
            targetSegments.push([
              translated[translated.length - 1],
              translated[0],
            ]);
          }
        }
      }
      const firstPoint = run.lines[0]?.points[0];
      if (showRebarLabels && firstPoint) {
        const label = createTextSprite(run.name);
        if (label) {
          const labelPoint =
            run.distributionMode === "path" && run.distributionVector
              ? {
                  x: firstPoint.x + run.distributionVector.x * lapOffset,
                  y: firstPoint.y + run.distributionVector.y * lapOffset,
                  z: firstPoint.z + run.distributionVector.z * lapOffset,
                }
              : {
                  ...firstPoint,
                  [run.axis]: run.start + lapOffset,
                };
          const position = toThree(labelPoint, displayOffset);
          label.position.copy(position);
          state.rebarGroup.add(label);
        }
      }
    }
    rodsByColor.forEach((buffers, color) => {
      addRodMeshes(
        buffers.segments,
        buffers.joints,
        new THREE.Color(color).getHex(),
      );
    });
    selectedRodsByColor.forEach((buffers, color) => {
      addRodMeshes(
        buffers.segments,
        buffers.joints,
        new THREE.Color(color).getHex(),
        true,
        1.35,
      );
    });

    const draftSegments: Array<[Vec3, Vec3]> = [];
    const draftJoints: Vec3[] = [];
    const visibleDraftLines = [
      ...draftRebarLines,
      ...(pendingRebarLine ? [pendingRebarLine] : []),
    ];
    for (const line of visibleDraftLines) {
      draftJoints.push(...line.points);
      for (let index = 0; index < line.points.length - 1; index += 1) {
        draftSegments.push([line.points[index], line.points[index + 1]]);
      }
      if (line.closed && line.points.length > 2) {
        draftSegments.push([
          line.points[line.points.length - 1],
          line.points[0],
        ]);
      }
    }
    addRodMeshes(draftSegments, draftJoints, 0xf04b43, true);
    if (rebarOuterEdges?.length) {
      rebarOuterEdges.forEach(([point, next], edgeIndex) => {
        const geometry = new LineSegmentsGeometry();
        const first = toThree(point, displayOffset);
        const second = toThree(next, displayOffset);
        geometry.setPositions([...first.toArray(), ...second.toArray()]);
        const material = new LineMaterial({
            color:
              selectedRebarEdgeIndex === edgeIndex ? 0x48d18b : 0x05090c,
            depthTest: false,
            linewidth:
              selectedRebarEdgeIndex === edgeIndex ? 5 : 2.25,
            resolution: new THREE.Vector2(
              state.renderer.domElement.clientWidth,
              state.renderer.domElement.clientHeight,
            ),
          });
        const edge = new LineSegments2(geometry, material);
        edge.renderOrder = 20;
        edge.userData.edgeIndex = edgeIndex;
        state.rebarGroup.add(edge);
        rebarEdgeObjectsRef.current.push(edge);
        rebarEdgeDataRef.current.push({
          object: edge,
          start: point,
          end: next,
          index: edgeIndex,
        });
      });
    }
    const addDashedGuide = (guideLine: RebarLine, color: number) => {
      const guide = addPolyline(guideLine.points, color, 0, true);
      if (guide) {
        guide.renderOrder = 21;
        guide.userData.guidePoints = guideLine.points;
        rebarGuideObjectsRef.current.push(guide);
      }
      const dashPositions: number[] = [];
      const points = guideLine.points;
      const dashLength = Math.max(tolerance * 30, 0.35);
      for (let index = 0; index < points.length; index += 1) {
        const start = toThree(points[index], displayOffset);
        const end = toThree(points[(index + 1) % points.length], displayOffset);
        const segment = end.clone().sub(start);
        const length = segment.length();
        const direction = segment.normalize();
        for (let distance = 0; distance < length; distance += dashLength * 1.7) {
          const dashStart = start
            .clone()
            .addScaledVector(direction, distance);
          const dashEnd = start
            .clone()
            .addScaledVector(
              direction,
              Math.min(distance + dashLength, length),
            );
          dashPositions.push(...dashStart.toArray(), ...dashEnd.toArray());
        }
      }
      const dashGeometry = new LineSegmentsGeometry();
      dashGeometry.setPositions(dashPositions);
      const dashMaterial = new LineMaterial({
        color,
        linewidth: 3,
        depthTest: false,
        resolution: new THREE.Vector2(
          state.renderer.domElement.clientWidth,
          state.renderer.domElement.clientHeight,
        ),
      });
      const dashedGuide = new LineSegments2(dashGeometry, dashMaterial);
      dashedGuide.renderOrder = 22;
      state.rebarGroup.add(dashedGuide);
    };
    rebarGuideLines.forEach((line) =>
      addDashedGuide(line, 0xe8eef0),
    );
    rebarInnerGuideLines.forEach((line) =>
      addDashedGuide(line, 0xff7faf),
    );
    if (pendingRebarLine) {
      addPolyline(pendingRebarLine.points, 0xff8a2a, 1, false);
    }
    if (rebarPathPoints.length >= 2 || (rebarPathStart && rebarPathEnd)) {
      const path = addPolyline(
        rebarPathPoints.length >= 2
          ? rebarPathPoints
          : [rebarPathStart!, rebarPathEnd!],
        0xffbf47,
        1,
        false,
      );
      if (path) {
        path.material.depthTest = false;
        path.renderOrder = 24;
      }
    }

    const addPlanePatch = (
      origin: Vec3,
      normalValue: Vec3,
      color: string | number,
      opacity: number,
      offset = 0,
      borderOnly = false,
    ) => {
      if (!sliceBounds) return;
      const normal = new THREE.Vector3(
        normalValue.x,
        normalValue.y,
        normalValue.z,
      ).normalize();
      const reference =
        Math.abs(normal.z) < 0.92
          ? new THREE.Vector3(0, 0, 1)
          : new THREE.Vector3(0, 1, 0);
      const u = reference.clone().cross(normal).normalize();
      const v = normal.clone().cross(u).normalize();
      const baseCenter = new THREE.Vector3(origin.x, origin.y, origin.z)
        .addScaledVector(normal, offset);
      const boundsCorners = [sliceBounds.x[0], sliceBounds.x[1]].flatMap((x) =>
        [sliceBounds.y[0], sliceBounds.y[1]].flatMap((y) =>
          [sliceBounds.z[0], sliceBounds.z[1]].map(
            (z) => new THREE.Vector3(x, y, z),
          ),
        ),
      );
      const uValues = boundsCorners.map((corner) =>
        u.dot(corner.clone().sub(baseCenter)),
      );
      const vValues = boundsCorners.map((corner) =>
        v.dot(corner.clone().sub(baseCenter)),
      );
      const uMid = (Math.min(...uValues) + Math.max(...uValues)) / 2;
      const vMid = (Math.min(...vValues) + Math.max(...vValues)) / 2;
      const uHalf = Math.max(
        (Math.max(...uValues) - Math.min(...uValues)) * 0.6,
        0.5,
      );
      const vHalf = Math.max(
        (Math.max(...vValues) - Math.min(...vValues)) * 0.6,
        0.5,
      );
      const center = baseCenter
        .clone()
        .addScaledVector(u, uMid)
        .addScaledVector(v, vMid);
      const corners = [
        center.clone().addScaledVector(u, -uHalf).addScaledVector(v, -vHalf),
        center.clone().addScaledVector(u, uHalf).addScaledVector(v, -vHalf),
        center.clone().addScaledVector(u, uHalf).addScaledVector(v, vHalf),
        center.clone().addScaledVector(u, -uHalf).addScaledVector(v, vHalf),
      ].map((point) => ({ x: point.x, y: point.y, z: point.z }));
      const geometry = triangulatePolygon(corners, displayOffset);
      if (!borderOnly) {
        state.rebarGroup.add(
          new THREE.Mesh(
            geometry,
            new THREE.MeshBasicMaterial({
              color,
              opacity,
              transparent: true,
              depthWrite: false,
              side: THREE.DoubleSide,
            }),
          ),
        );
      } else {
        geometry.dispose();
      }
      const border = addPolyline(corners, new THREE.Color(color).getHex(), 0.9);
      if (border && borderOnly) {
        border.material.depthTest = false;
        border.renderOrder = 25;
      }
    };
    rebarPlanePreviews.forEach((plane) =>
      addPlanePatch(
        plane.origin,
        plane.normal,
        plane.color,
        0.14,
        plane.offset ?? 0,
        plane.borderOnly ?? false,
      ),
    );
    if (rebarSection !== null && rebarDrawingPlane) {
      addPlanePatch(
        rebarDrawingPlane.origin,
        rebarDrawingPlane.normal,
        rebarDrawingPlane.color,
        0.22,
        rebarSection,
      );
    }
  }, [
    displayOffset,
    draftRebarLines,
    pendingRebarLine,
    rebarAxis,
    rebarGuideLines,
    rebarInnerGuideLines,
    rebarOuterEdges,
    showRebarScene,
    rebarPathEnd,
    rebarPathPoints,
    rebarPathStart,
    rebarDrawingPlane,
    rebarPlanePreviews,
    rebarRuns,
    rebarSection,
    selectedRebarRunIds,
    selectedRebarEdgeIndex,
    showRebarLabels,
    sliceBounds,
    tolerance,
    inchesPerModelUnit,
  ]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state || !orbitTarget) return;
    const displayTarget = basis ? toLocal(orbitTarget, basis) : orbitTarget;
    const nextTarget = toThree(displayTarget, displayOffset);
    const shift = nextTarget.clone().sub(state.controls.target);
    state.camera.position.add(shift);
    state.controls.target.copy(nextTarget);
    state.camera.lookAt(nextTarget);
    state.controls.update();
    state.controls.saveState();
  }, [
    basis,
    displayOffset.x,
    displayOffset.y,
    displayOffset.z,
    orbitTarget,
  ]);

  useEffect(() => {
    const state = sceneRef.current;
    const colorAttribute = state?.geometry.getAttribute("nodeColor");
    if (!state || !colorAttribute || colorAttribute.count !== nodes.length) return;
    const base = new THREE.Color(0x111111);
    const selected = new THREE.Color(0xf28c28);
    const invalid = new THREE.Color(0xff4d62);
    nodes.forEach((node, index) => {
      const color = invalidNodeIds.includes(node.id)
        ? invalid
        : selectedNodeIds.includes(node.id)
          ? selected
          : base;
      colorAttribute.setXYZ(index, color.r, color.g, color.b);
    });
    colorAttribute.needsUpdate = true;
  }, [invalidNodeIds, nodes, selectedNodeIds]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    state.material.uniforms.xRange.value.set(slice.x[0], slice.x[1]);
    state.material.uniforms.yRange.value.set(slice.y[0], slice.y[1]);
    state.material.uniforms.zRange.value.set(slice.z[0], slice.z[1]);
  }, [slice]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    disposeGroup(state.faceGroup);
    faceMeshesRef.current = [];
    faceEdgesRef.current = [];

    const toDisplay = (point: Vec3) => (basis ? toLocal(point, basis) : point);
    const displayPlanes = faces.map((face) =>
      basis ? transformPlane(face.plane, basis) : face.plane,
    );
    const polygons: Array<{
      vertices: Vec3[];
      faceId?: string;
      selected: boolean;
      isSlice: boolean;
    }> = [];

    const exactAutomaticVolume =
      volumeConfirmed &&
      faces.length >= 4 &&
      faces.every((face) => face.automatic);

    if (exactAutomaticVolume) {
      const clippingPlanes = slicePlanes(slice);
      for (const face of faces) {
        const vertices = clipPolygonToPlanes(
          face.vertices.map(toDisplay),
          clippingPlanes,
          tolerance,
        );
        if (vertices.length >= 3) {
          polygons.push({
            vertices,
            faceId: face.id,
            selected: selectedFaceIds.includes(face.id),
            isSlice: false,
          });
        }
      }
    } else if (volumeConfirmed && displayPlanes.length >= 4) {
      const clipped = buildPolyhedron(
        [...displayPlanes, ...slicePlanes(slice)],
        tolerance,
        false,
      );
      if (clipped) {
        for (const polygon of clipped.faces) {
          const face = faces[polygon.planeIndex];
          polygons.push({
            vertices: polygon.vertices,
            faceId: face?.id,
            selected: face ? selectedFaceIds.includes(face.id) : false,
            isSlice: polygon.planeIndex >= faces.length,
          });
        }
      }
    } else {
      for (const face of faces) {
        polygons.push({
          vertices: face.vertices.map(toDisplay),
          faceId: face.id,
          selected: selectedFaceIds.includes(face.id),
          isSlice: false,
        });
      }
    }

    if (previewFace) {
      polygons.push({
        vertices: previewFace.vertices.map(toDisplay),
        selected: true,
        isSlice: false,
      });
    }

    const nodeMap = new Map(allNodes.map((node) => [node.id, node]));
    const draft = draftNodeIds
      .map((id) => nodeMap.get(id))
      .filter((node): node is ModelNode => Boolean(node))
      .map((node) => node.local ?? node.global);
    if (draft.length >= 2) {
      const draftLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(
          draft.map((point) => toThree(point, displayOffset)),
        ),
        new THREE.LineBasicMaterial({
          color: 0xffbf47,
          opacity: 1,
          transparent: true,
        }),
      );
      state.faceGroup.add(draftLine);
    }
    if (draft.length >= 3 && invalidNodeIds.length === 0) {
      polygons.push({
        vertices: draft,
        selected: true,
        isSlice: false,
      });
    }

    for (const polygon of polygons) {
      if (polygon.vertices.length < 3) continue;
      const geometry = triangulatePolygon(polygon.vertices, displayOffset);
      const material = new THREE.MeshBasicMaterial({
        color:
          polygon.faceId === floorFaceId
            ? 0x4ce39a
            : polygon.selected
              ? 0xffbf47
              : polygon.faceId === hoveredFaceId
                ? 0x72e6ff
                : polygon.isSlice
                  ? 0xa9c3cc
                  : 0x91afba,
        opacity:
          polygon.faceId === hoveredFaceId ||
          polygon.faceId === floorFaceId ||
          polygon.selected
            ? 0.36
            : volumeConfirmed
              ? 0.19
              : 0.25,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      if (polygon.faceId) {
        mesh.userData.faceId = polygon.faceId;
        faceMeshesRef.current.push(mesh);
      }
      state.faceGroup.add(mesh);

      const outlineGeometry = new THREE.BufferGeometry().setFromPoints([
        ...polygon.vertices.map((vertex) => toThree(vertex, displayOffset)),
        toThree(polygon.vertices[0], displayOffset),
      ]);
      const outline = new THREE.Line(
        outlineGeometry,
        new THREE.LineBasicMaterial({
          color: 0x02070a,
          opacity: 0.95,
          transparent: true,
        }),
      );
      state.faceGroup.add(outline);

      if (
        polygon.faceId &&
        polygon.faceId === editableFaceId &&
        !volumeConfirmed
      ) {
        polygon.vertices.forEach((vertex, edgeIndex) => {
          const nextVertex =
            polygon.vertices[(edgeIndex + 1) % polygon.vertices.length];
          const edge = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([
              toThree(vertex, displayOffset),
              toThree(nextVertex, displayOffset),
            ]),
            new THREE.LineBasicMaterial({
              color: 0x02070a,
              opacity: 1,
              transparent: true,
            }),
          );
          const sourceFace = faces.find(
            (face) => face.id === polygon.faceId,
          );
          const planeDefinition = sourceFace
            ? basis
              ? transformPlane(sourceFace.plane, basis)
              : sourceFace.plane
            : null;
          if (planeDefinition) {
            const normal = new THREE.Vector3(
              planeDefinition.normal.x,
              planeDefinition.normal.y,
              planeDefinition.normal.z,
            );
            edge.userData.plane = new THREE.Plane(
              normal,
              planeDefinition.constant +
                normal.x * displayOffset.x +
                normal.y * displayOffset.y +
                normal.z * displayOffset.z,
            );
          }
          edge.userData.faceId = polygon.faceId;
          edge.userData.edgeIndex = edgeIndex;
          edge.userData.start = toThree(vertex, displayOffset);
          edge.userData.end = toThree(nextVertex, displayOffset);
          faceEdgesRef.current.push(edge);
          state.faceGroup.add(edge);
        });
      }
    }
  }, [
    allNodes,
    basis,
    displayOffset.x,
    displayOffset.y,
    displayOffset.z,
    draftNodeIds,
    editableFaceId,
    faces,
    floorFaceId,
    hoveredFaceId,
    invalidNodeIds,
    previewFace,
    selectedFaceIds,
    slice,
    tolerance,
    volumeConfirmed,
  ]);

  if (renderError) {
    return (
      <div className="viewport-canvas render-fallback" role="alert">
        <div>
          <strong>3D VIEW UNAVAILABLE</strong>
          <p>{renderError}</p>
          <small>
            Your MCT data remains local and has not been uploaded.
          </small>
        </div>
      </div>
    );
  }

  return (
    <div ref={hostRef} className="viewport-canvas" aria-label="3D node cloud">
      {segmentLengthHud && (
        <div
          className="rebar-segment-length"
          style={{
            left: segmentLengthHud.clientX + 14,
            top: segmentLengthHud.clientY + 14,
          }}
        >
          {segmentLengthHud.inches.toFixed(2)} in
        </div>
      )}
    </div>
  );
}
