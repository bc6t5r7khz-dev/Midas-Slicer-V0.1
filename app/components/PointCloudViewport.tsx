"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import {
  reframeDirection,
  reframePoint,
  toLocal,
  transformPlane,
} from "../lib/coordinateSystem";
import { generateRebarInstances } from "../lib/rebarAdvanced";
import {
  applyStandardBendsToInstance,
  rebarBendStandard,
} from "../lib/rebarStandards";
import { sectionRebarGeometry } from "../lib/rebarSection";
import {
  offsetLappedSectionSegments,
  type LapDimension,
} from "../lib/rebarDetail";
import type {
  Bounds,
  CameraViewpoint,
  DetailNote,
  DetailRunAdjustment,
  LocalBasis,
  ElementSurface,
  ModelElement,
  RebarLine,
  RebarPlane,
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
  rebarPlanes: RebarPlane[];
  rebarAdvancedAnchors: Array<{
    id: string;
    point: Vec3;
    role: "start" | "end" | "additional";
    active: boolean;
  }>;
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
  draftRebarBarNumber: string;
  rebarLapSnapPoints: Vec3[];
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
  rebarSectionView: {
    origin: Vec3;
    normal: Vec3;
    throwDepthModelUnits: number;
  } | null;
  detailMode: boolean;
  lockOrbit: boolean;
  normalizeViewUpRequest: number;
  detailRunAdjustments: Record<string, DetailRunAdjustment>;
  detailNotes: DetailNote[];
  pendingDetailNoteText: string | null;
  onDetailRunAdjustment: (
    runId: string,
    adjustment: DetailRunAdjustment,
  ) => void;
  onDetailNotesChange: (notes: DetailNote[]) => void;
  onPlaceDetailNote: (note: DetailNote) => void;
  onCancelDetailNote: () => void;
  sectionViewRequest: {
    id: string;
    nonce: number;
    origin: Vec3;
    normal: Vec3;
    up: Vec3;
  } | null;
  inchesPerModelUnit: number | null;
  showConcreteSkin: boolean;
  lineAndBar: boolean;
  rebarDrawing: boolean;
  showAxes: boolean;
  onPickRebarPoint: (point: Vec3) => void;
  onRejectRebarPoint: () => void;
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

type ScreenPoint = { x: number; y: number };

const DETAIL_LANDING_LENGTH = 34;
const DETAIL_TEXT_GAP = 7;

type DetailDrag =
  | {
      kind: "run-label" | "run-leader" | "dimension" | "lap-dimension";
      id: string;
      start: ScreenPoint;
      initial: DetailRunAdjustment;
    }
  | { kind: "run-target"; id: string }
  | {
      kind: "note-label" | "note-leader" | "note-target";
      id: string;
      start: ScreenPoint;
      initial: DetailNote;
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
      materials.forEach((material) => {
        if ("map" in material) {
          (
            material as THREE.Material & { map?: THREE.Texture | null }
          ).map?.dispose();
        }
        material.dispose();
      });
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
  cap: number | null;
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
  planeIndex: number,
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
    clipped.push({ vertices: unique, cap: planeIndex });
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
  const customCapPositions: number[] = [];

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
      cap: null,
    }));
    for (let planeIndex = 0; planeIndex < planes.length; planeIndex += 1) {
      faces = clipCellFaces(faces, planes[planeIndex], epsilon, planeIndex);
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
            if (face.cap !== null) capPositions.push(point.x, point.y, point.z);
            if (customPlane && face.cap === planes.length - 1) {
              customCapPositions.push(point.x, point.y, point.z);
            }
          },
        );
      }
    }
  }
  return { positions, capPositions, customCapPositions };
}

function triangleBoundaryPositions(positions: number[], tolerance: number) {
  type Edge = { start: number[]; end: number[]; count: number };
  const edges = new Map<string, Edge>();
  const epsilon = Math.max(tolerance, 1e-8);
  const pointKey = (point: number[]) =>
    point.map((value) => Math.round(value / epsilon)).join(",");
  for (let index = 0; index < positions.length; index += 9) {
    const triangle = [0, 3, 6].map((offset) =>
      positions.slice(index + offset, index + offset + 3),
    );
    for (let edgeIndex = 0; edgeIndex < 3; edgeIndex += 1) {
      const start = triangle[edgeIndex];
      const end = triangle[(edgeIndex + 1) % 3];
      const startKey = pointKey(start);
      const endKey = pointKey(end);
      const key = startKey < endKey
        ? `${startKey}|${endKey}`
        : `${endKey}|${startKey}`;
      const existing = edges.get(key);
      if (existing) existing.count += 1;
      else edges.set(key, { start, end, count: 1 });
    }
  }
  return [...edges.values()]
    .filter(({ count }) => count === 1)
    .flatMap(({ start, end }) => [...start, ...end]);
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
  rebarPlanes,
  rebarAdvancedAnchors,
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
  draftRebarBarNumber,
  rebarLapSnapPoints,
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
  rebarSectionView,
  detailMode,
  lockOrbit,
  normalizeViewUpRequest,
  detailRunAdjustments,
  detailNotes,
  pendingDetailNoteText,
  onDetailRunAdjustment,
  onDetailNotesChange,
  onPlaceDetailNote,
  onCancelDetailNote,
  sectionViewRequest,
  inchesPerModelUnit,
  showConcreteSkin,
  lineAndBar,
  rebarDrawing,
  showAxes,
  onPickRebarPoint,
  onRejectRebarPoint,
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
  const rebarLapSnapPointsRef = useRef<Vec3[]>(rebarLapSnapPoints);
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
  const detailModeRef = useRef(detailMode);
  const lockOrbitRef = useRef(lockOrbit);
  const onPickElementRef = useRef(onPickElement);
  const rebarDrawingRef = useRef(rebarDrawing);
  const onPickRebarPointRef = useRef(onPickRebarPoint);
  const onRejectRebarPointRef = useRef(onRejectRebarPoint);
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
    wholeInchSnap: boolean;
  } | null>(null);
  const [detailProjectionRevision, setDetailProjectionRevision] = useState(0);
  const [detailNoteCursor, setDetailNoteCursor] = useState<ScreenPoint | null>(
    null,
  );

const addVec = (first: Vec3, second: Vec3): Vec3 => ({
  x: first.x + second.x,
  y: first.y + second.y,
  z: first.z + second.z,
});
const subtractVec = (first: Vec3, second: Vec3): Vec3 => ({
  x: first.x - second.x,
  y: first.y - second.y,
  z: first.z - second.z,
});
const scaleVec = (value: Vec3, amount: number): Vec3 => ({
  x: value.x * amount,
  y: value.y * amount,
  z: value.z * amount,
});
const lengthVec = (value: Vec3) => Math.hypot(value.x, value.y, value.z);
  const [detailDrag, setDetailDrag] = useState<DetailDrag | null>(null);

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
  detailModeRef.current = detailMode;
  lockOrbitRef.current = lockOrbit;
  onPickElementRef.current = onPickElement;
  rebarDrawingRef.current = rebarDrawing;
  onPickRebarPointRef.current = onPickRebarPoint;
  onRejectRebarPointRef.current = onRejectRebarPoint;
  rebarEdgeSelectionModeRef.current = rebarEdgeSelectionMode;
  onPickRebarEdgeRef.current = onPickRebarEdge;
  selectedRebarEdgeIndexRef.current = selectedRebarEdgeIndex;
  rebarAxisRef.current = rebarAxis;
  rebarSectionRef.current = rebarSection;
  rebarDrawingPlaneRef.current = rebarDrawingPlane;
  pendingRebarLineRef.current = pendingRebarLine;
  rebarSnapLinesRef.current = rebarSnapLines;
  rebarLapSnapPointsRef.current = rebarLapSnapPoints;
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
    const state = sceneRef.current;
    if (!state || !normalizeViewUpRequest) return;
    const viewDirection = state.controls.target.clone().sub(state.camera.position).normalize();
    const localZ = new THREE.Vector3(0, 0, 1);
    state.camera.up.copy(
      Math.abs(viewDirection.dot(localZ)) > 0.9
        ? new THREE.Vector3(0, 1, 0)
        : localZ,
    );
    state.camera.lookAt(state.controls.target);
    state.controls.update();
  }, [normalizeViewUpRequest]);

  useEffect(() => {
    const state = sceneRef.current;
    const host = hostRef.current;
    if (!state || !host || !detailMode) return;
    const refresh = () =>
      setDetailProjectionRevision((current) => current + 1);
    state.controls.addEventListener("change", refresh);
    const observer = new ResizeObserver(refresh);
    observer.observe(host);
    refresh();
    return () => {
      state.controls.removeEventListener("change", refresh);
      observer.disconnect();
    };
  }, [detailMode, sectionViewRequest, viewpointToApply]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state || !sectionViewRequest || !allNodes.length) return;
    const target = toThree(sectionViewRequest.origin, displayOffset);
    const normal = new THREE.Vector3(
      sectionViewRequest.normal.x,
      sectionViewRequest.normal.y,
      sectionViewRequest.normal.z,
    ).normalize();
    const up = new THREE.Vector3(
      sectionViewRequest.up.x,
      sectionViewRequest.up.y,
      sectionViewRequest.up.z,
    )
      .addScaledVector(
        normal,
        -normal.dot(
          new THREE.Vector3(
            sectionViewRequest.up.x,
            sectionViewRequest.up.y,
            sectionViewRequest.up.z,
          ),
        ),
      )
      .normalize();
    const extent = Math.max(
      ...allNodes.map((node) => {
        const point = node.local ?? node.global;
        return Math.hypot(
          point.x - sectionViewRequest.origin.x,
          point.y - sectionViewRequest.origin.y,
          point.z - sectionViewRequest.origin.z,
        );
      }),
      1,
    );
    const distance =
      (extent * 1.25) /
      Math.tan(THREE.MathUtils.degToRad(state.camera.fov / 2));
    state.camera.up.copy(up);
    state.camera.position.copy(target).addScaledVector(normal, distance);
    state.controls.target.copy(target);
    state.camera.lookAt(target);
    state.camera.updateProjectionMatrix();
    state.controls.update();
    state.controls.saveState();
  }, [allNodes, displayOffset, sectionViewRequest]);

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
        for (const point of rebarLapSnapPointsRef.current) {
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
          if (distance <= 22 && (!closest || distance < closest.distance)) {
            closest = { point, distance };
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
          const previous =
            pendingRebarLineRef.current?.points[
              (pendingRebarLineRef.current?.points.length ?? 0) - 1
            ];
          if (event.shiftKey && previous && inchesPerModelUnitRef.current) {
            const start = new THREE.Vector3(
              guidePoint.segment[0].x,
              guidePoint.segment[0].y,
              guidePoint.segment[0].z,
            );
            const end = new THREE.Vector3(
              guidePoint.segment[1].x,
              guidePoint.segment[1].y,
              guidePoint.segment[1].z,
            );
            const direction = end.sub(start).normalize();
            const candidate = new THREE.Vector3(
              guidePoint.point.x - previous.x,
              guidePoint.point.y - previous.y,
              guidePoint.point.z - previous.z,
            );
            if (candidate.dot(direction) < 0) direction.multiplyScalar(-1);
            const wholeInches = Math.max(
              1,
              Math.round(candidate.length() * inchesPerModelUnitRef.current),
            );
            return {
              point: {
                x: previous.x + direction.x * wholeInches / inchesPerModelUnitRef.current,
                y: previous.y + direction.y * wholeInches / inchesPerModelUnitRef.current,
                z: previous.z + direction.z * wholeInches / inchesPerModelUnitRef.current,
              },
              snapped: false,
              segment: guidePoint.segment,
              wholeInchSnap: true,
            };
          }
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
          let wholeInchSnap = false;
          if (event.shiftKey && inchesPerModelUnitRef.current) {
            const snappedDelta = new THREE.Vector3(
              point.x - previous.x,
              point.y - previous.y,
              point.z - previous.z,
            );
            const modelLength = snappedDelta.length();
            if (modelLength > 1e-9) {
              const wholeInches = Math.max(
                1,
                Math.round(modelLength * inchesPerModelUnitRef.current),
              );
              snappedDelta.setLength(
                wholeInches / inchesPerModelUnitRef.current,
              );
              point.x = previous.x + snappedDelta.x;
              point.y = previous.y + snappedDelta.y;
              point.z = previous.z + snappedDelta.z;
              wholeInchSnap = true;
            }
          }
          return { point, snapped: false, wholeInchSnap };
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
        if (orbitDrag && !edgeDrag && !detailModeRef.current && !lockOrbitRef.current) {
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
            rebarSnapSegment.material.color.setHex(
              rebarSnapRequiredRef.current ? 0xffbf47 : 0xff8a2a,
            );
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
                wholeInchSnap: Boolean(
                  "wholeInchSnap" in candidate && candidate.wholeInchSnap,
                ),
              });
            }
          } else {
            rebarPreview.visible = false;
            setSegmentLengthHud(null);
          }
          renderer.domElement.style.cursor = candidate
            ? "crosshair"
            : rebarSnapRequiredRef.current
              ? "not-allowed"
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
        if (detailModeRef.current) {
          renderer.domElement.style.cursor = "default";
          return;
        }
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
          else onRejectRebarPointRef.current();
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

  const generatedRebarInstances = useMemo(() => {
    const generated = new Map<string, RebarLine[][]>();
    for (const run of rebarRuns) {
      const sourcePlane = rebarPlanes.find(
        (plane) => plane.id === run.planeId,
      );
      const targetPlane = rebarPlanes.find(
        (plane) => plane.id === run.advanced?.splay?.targetPlaneId,
      );
      const targetNormal = targetPlane
        ? reframeDirection(targetPlane.objectNormal, null, basis)
        : null;
      const targetBaseOrigin = targetPlane
        ? reframePoint(targetPlane.objectOrigin, null, basis)
        : null;
      const targetOrigin =
        targetBaseOrigin && targetNormal
          ? {
              x:
                targetBaseOrigin.x +
                targetNormal.x * (run.advanced?.splay?.targetOffset ?? 0),
              y:
                targetBaseOrigin.y +
                targetNormal.y * (run.advanced?.splay?.targetOffset ?? 0),
              z:
                targetBaseOrigin.z +
                targetNormal.z * (run.advanced?.splay?.targetOffset ?? 0),
            }
          : null;
      const sourceNormal = sourcePlane
        ? reframeDirection(sourcePlane.objectNormal, null, basis)
        : null;
      const sourceBaseOrigin = sourcePlane
        ? reframePoint(sourcePlane.objectOrigin, null, basis)
        : null;
      const sourceOrigin =
        sourceBaseOrigin && sourceNormal
          ? {
              x:
                sourceBaseOrigin.x +
                sourceNormal.x * (run.startOffset ?? run.start),
              y:
                sourceBaseOrigin.y +
                sourceNormal.y * (run.startOffset ?? run.start),
              z:
                sourceBaseOrigin.z +
                sourceNormal.z * (run.startOffset ?? run.start),
            }
          : null;
      generated.set(
        run.id,
        generateRebarInstances(run, {
          sourceNormal,
          sourceOrigin,
          targetNormal,
          targetOrigin,
          lapOffsetModelUnits:
            inchesPerModelUnit && run.lapOffsetInches
              ? run.lapOffsetInches / inchesPerModelUnit
              : 0,
        }).map((instance) =>
          applyStandardBendsToInstance(
            instance,
            run.barNumber,
            inchesPerModelUnit ?? 1,
          ),
        ),
      );
    }
    return generated;
  }, [basis, inchesPerModelUnit, rebarPlanes, rebarRuns]);

  const sectionRebarGraphics = useMemo(() => {
    if (!rebarSectionView) return null;
    type Graphic = {
      segments: Array<[Vec3, Vec3]>;
      circles: Vec3[];
      lapDimensions: LapDimension[];
      mixed: boolean;
      dimensionRange: [Vec3, Vec3] | null;
      representativeTarget: Vec3 | null;
    };
    const raw = new Map<string, Graphic>();
    const center = allNodes.length
      ? allNodes.reduce(
          (sum, node) => {
            const point = node.local ?? node.global;
            return {
              x: sum.x + point.x / allNodes.length,
              y: sum.y + point.y / allNodes.length,
              z: sum.z + point.z / allNodes.length,
            };
          },
          { x: 0, y: 0, z: 0 },
        )
      : rebarSectionView.origin;
    for (const run of rebarRuns) {
      const graphic: Graphic = {
        segments: [],
        circles: [],
        lapDimensions: [],
        mixed: false,
        dimensionRange: null,
        representativeTarget: null,
      };
      const candidates = (generatedRebarInstances.get(run.id) ?? []).map(
        (instance, index) => {
          const points = instance.flatMap((line) => line.points);
          const signedDistances = points.map((point) =>
            dot(subtractVec(point, rebarSectionView.origin), rebarSectionView.normal),
          );
          const closestSignedDistance = signedDistances.reduce(
            (closest, distance) =>
              Math.abs(distance) < Math.abs(closest) ? distance : closest,
            signedDistances[0] ?? 0,
          );
          const sectionNormal =
            closestSignedDistance > 0
              ? scaleVec(rebarSectionView.normal, -1)
              : rebarSectionView.normal;
          return {
            index,
            distance: Math.abs(closestSignedDistance),
            section: sectionRebarGeometry(
              instance,
              rebarSectionView.origin,
              sectionNormal,
              rebarSectionView.throwDepthModelUnits,
            ),
          };
        },
      );
      const mixedCandidates = candidates.filter(({ section }) => section.mixed);
      const middleIndex = Math.floor(candidates.length / 2);
      const mixedCandidate = mixedCandidates.reduce(
        (best, candidate) =>
          !best || Math.abs(candidate.index - middleIndex) < Math.abs(best.index - middleIndex)
            ? candidate
            : best,
        null as (typeof candidates)[number] | null,
      );
      const lineCandidate = candidates
        .filter(({ section }) => section.projectedLines.length)
        .sort((first, second) => first.distance - second.distance)[0];
      const visibleCandidates = mixedCandidate
        ? [mixedCandidate]
        : lineCandidate
          ? [lineCandidate]
          : candidates;
      graphic.mixed = Boolean(mixedCandidate);
      for (const { section } of visibleCandidates) {
        section.projectedLines.forEach(({ start, end }) =>
          graphic.segments.push([start, end]),
        );
        section.circles.forEach(({ center: circleCenter }) => {
          if (
            !graphic.circles.some(
              (candidate) =>
                Math.hypot(
                  candidate.x - circleCenter.x,
                  candidate.y - circleCenter.y,
                  candidate.z - circleCenter.z,
                ) <= Math.max(tolerance * 10, 1e-7),
            )
          ) {
            graphic.circles.push(circleCenter);
          }
        });
      }
      if (graphic.mixed) {
        const pathStart = run.pathPoints?.[0] ?? run.pathStart ?? null;
        const pathEnd = run.pathPoints?.at(-1) ?? run.pathEnd ?? null;
        const projectToSection = (point: Vec3) =>
          subtractVec(
            point,
            scaleVec(
              rebarSectionView.normal,
              dot(subtractVec(point, rebarSectionView.origin), rebarSectionView.normal),
            ),
          );
        if (pathStart && pathEnd) {
          const projectedStart = projectToSection(pathStart);
          const projectedEnd = projectToSection(pathEnd);
          if (lengthVec(subtractVec(projectedEnd, projectedStart)) > tolerance) {
            graphic.dimensionRange = [projectedStart, projectedEnd];
          }
        }
        graphic.representativeTarget =
          graphic.circles[0] ??
          (graphic.segments[0]
            ? scaleVec(addVec(graphic.segments[0][0], graphic.segments[0][1]), 0.5)
            : null);
      }
      raw.set(run.id, graphic);
    }

    const result = new Map(raw);
    if (!inchesPerModelUnit) return result;
    for (const run of rebarRuns) {
      if (!run.lappedFromRunId) continue;
      const graphic = raw.get(run.id);
      const source = raw.get(run.lappedFromRunId);
      if (!graphic || !source || !graphic.segments.length) continue;
      const sourceRun = rebarRuns.find(
        (candidate) => candidate.id === run.lappedFromRunId,
      );
      const sourceDiameter = rebarBendStandard(
        sourceRun?.barNumber ?? run.barNumber,
      ).diameterInches;
      const offset = offsetLappedSectionSegments(
        graphic.segments.map(([start, end]) => ({ start, end })),
        source.segments.map(([start, end]) => ({ start, end })),
        rebarSectionView.normal,
        center,
        (sourceDiameter + 0.125) / inchesPerModelUnit,
        tolerance,
      );
      result.set(run.id, {
        ...graphic,
        segments: offset.segments.map(({ start, end }) => [start, end]),
        lapDimensions: offset.lapDimensions,
      });
    }

    const segmentOwners = [...result.entries()].flatMap(([runId, graphic]) =>
      graphic.segments.map((segment) => ({ runId, segment })),
    );
    for (const run of rebarRuns) {
      const graphic = result.get(run.id);
      if (!graphic?.circles.length) continue;
      const diameter = rebarBendStandard(run.barNumber).diameterInches;
      const shifted = graphic.circles.map((circle) => {
        let next = circle;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const collision = segmentOwners.find(({ runId, segment }) => {
            if (runId === run.id) return false;
            const delta = subtractVec(segment[1], segment[0]);
            const denominator = dot(delta, delta) || 1;
            const amount = Math.max(
              0,
              Math.min(1, dot(subtractVec(next, segment[0]), delta) / denominator),
            );
            const closest = addVec(segment[0], scaleVec(delta, amount));
            const otherRun = rebarRuns.find((candidate) => candidate.id === runId);
            const otherDiameter = rebarBendStandard(
              otherRun?.barNumber ?? run.barNumber,
            ).diameterInches;
            const clearance =
              (diameter + otherDiameter) / (2 * inchesPerModelUnit) +
              0.125 / inchesPerModelUnit;
            return lengthVec(subtractVec(next, closest)) < clearance;
          });
          if (!collision) break;
          const inwardRaw = subtractVec(center, next);
          const inwardNormalAmount = dot(inwardRaw, rebarSectionView.normal);
          const inward = normalize(
            subtractVec(
              inwardRaw,
              scaleVec(rebarSectionView.normal, inwardNormalAmount),
            ),
          );
          next = addVec(
            next,
            scaleVec(inward, (diameter + 0.125) / inchesPerModelUnit),
          );
        }
        return next;
      });
      result.set(run.id, { ...graphic, circles: shifted });
    }
    return result;
  }, [
    allNodes,
    generatedRebarInstances,
    inchesPerModelUnit,
    rebarRuns,
    rebarSectionView,
    tolerance,
  ]);

  const detailScreenGraphics = useMemo(() => {
    const state = sceneRef.current;
    const host = hostRef.current;
    if (
      !detailMode ||
      !state ||
      !host ||
      !sectionRebarGraphics ||
      !inchesPerModelUnit
    ) {
      return [];
    }
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    const project = (point: Vec3): ScreenPoint => {
      const projected = toThree(point, displayOffset)
        .project(state.camera);
      return {
        x: (projected.x * 0.5 + 0.5) * width,
        y: (-projected.y * 0.5 + 0.5) * height,
      };
    };
    return rebarRuns.map((run) => {
      const graphic = sectionRebarGraphics.get(run.id) ?? {
        segments: [],
        circles: [],
        lapDimensions: [],
        mixed: false,
        dimensionRange: null,
        representativeTarget: null,
      };
      return {
        run,
        segments: graphic.segments.map(([start, end]) => [
          project(start),
          project(end),
        ] as [ScreenPoint, ScreenPoint]),
        dots: graphic.circles.map(project),
        mixed: graphic.mixed,
        dimensionRange: graphic.dimensionRange
          ? [project(graphic.dimensionRange[0]), project(graphic.dimensionRange[1])] as [ScreenPoint, ScreenPoint]
          : null,
        representativeTarget: graphic.representativeTarget
          ? project(graphic.representativeTarget)
          : null,
        lapDimensions: graphic.lapDimensions.map((dimension) => ({
          start: project(dimension.start),
          end: project(dimension.end),
          lengthInches: dimension.lengthModelUnits * inchesPerModelUnit,
        })),
      };
    });
  }, [
    detailMode,
    detailProjectionRevision,
    displayOffset,
    inchesPerModelUnit,
    rebarRuns,
    sectionRebarGraphics,
  ]);

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
      const renderPositions = detailMode
        ? buffers.customCapPositions
        : buffers.positions;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(renderPositions, 3),
      );
      geometry.computeVertexNormals();
      if (!lineOnly && renderPositions.length) {
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
      } else if (!renderPositions.length) {
        geometry.dispose();
      }

      if (detailMode) {
        const boundary = triangleBoundaryPositions(
          buffers.customCapPositions,
          Math.max(tolerance * 10, 1e-7),
        );
        if (boundary.length) {
          const cutGeometry = new LineSegmentsGeometry();
          cutGeometry.setPositions(boundary);
          const cutMaterial = new LineMaterial({
            color: 0x05090c,
            linewidth: 2.5,
            resolution: new THREE.Vector2(
              state.renderer.domElement.clientWidth,
              state.renderer.domElement.clientHeight,
            ),
          });
          const outline = new LineSegments2(cutGeometry, cutMaterial);
          outline.computeLineDistances();
          state.elementGroup.add(outline);
        }
        if (lineOnly && renderPositions.length) geometry.dispose();
        return;
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
    if (!lineOnly && !detailMode) {
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

    if (detailMode) {
      meshGeometry.dispose();
      if (cutEdgePositions.length) {
        const cutGeometry = new THREE.BufferGeometry();
        cutGeometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(cutEdgePositions, 3),
        );
        state.elementGroup.add(
          new THREE.LineSegments(
            cutGeometry,
            new THREE.LineBasicMaterial({ color: 0x05090c }),
          ),
        );
      }
    } else if (lineOnly) {
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
    detailMode,
    slice,
    sliceBounds,
    slicingMode,
    tolerance,
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
      diameterInches: number,
      alwaysVisible = false,
      radiusScale = 1,
    ) => {
      if (!segments.length && !joints.length) return;
      if (rebarSectionView) {
        if (segments.length) {
          const geometry = new LineSegmentsGeometry();
          geometry.setPositions(
            segments.flatMap(([start, end]) => [
              ...toThree(start, displayOffset).toArray(),
              ...toThree(end, displayOffset).toArray(),
            ]),
          );
          const material = new LineMaterial({
            color,
            linewidth: alwaysVisible ? 4.5 : 2.75,
            depthTest: false,
            depthWrite: false,
            resolution: new THREE.Vector2(
              state.renderer.domElement.clientWidth || 1,
              state.renderer.domElement.clientHeight || 1,
            ),
          });
          const linework = new LineSegments2(geometry, material);
          linework.renderOrder = alwaysVisible ? 42 : 40;
          state.rebarGroup.add(linework);
        }
        if (joints.length) {
          const dotCanvas = document.createElement("canvas");
          dotCanvas.width = 32;
          dotCanvas.height = 32;
          const context = dotCanvas.getContext("2d");
          if (context) {
            context.fillStyle = "#fff";
            context.beginPath();
            context.arc(16, 16, 14, 0, Math.PI * 2);
            context.fill();
          }
          const texture = new THREE.CanvasTexture(dotCanvas);
          const geometry = new THREE.BufferGeometry().setFromPoints(
            joints.map((point) => toThree(point, displayOffset)),
          );
          const material = new THREE.PointsMaterial({
            color,
            map: texture,
            alphaTest: 0.5,
            transparent: true,
            size: alwaysVisible ? 11 : 8,
            sizeAttenuation: false,
            depthTest: false,
            depthWrite: false,
          });
          const dots = new THREE.Points(geometry, material);
          dots.renderOrder = alwaysVisible ? 43 : 41;
          state.rebarGroup.add(dots);
        }
        return;
      }
      if (!segments.length || !inchesPerModelUnit) return;
      const radius =
        (diameterInches * 0.5 * radiusScale) / inchesPerModelUnit;
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
      diameterInches: number;
    };
    const rodsByColor = new Map<string, RodBuffers>();
    const selectedRodsByColor = new Map<string, RodBuffers>();
    for (const run of rebarRuns) {
      const runSelected = selectedRebarRunIds.has(run.id);
      const color = run.color ?? "#8f1717";
      const diameterInches = rebarBendStandard(
        run.barNumber,
      ).diameterInches;
      const rodKey = `${color}|${diameterInches}`;
      const colorBuffers = rodsByColor.get(rodKey) ?? {
        segments: [],
        joints: [],
        diameterInches,
      };
      const selectedColorBuffers = selectedRodsByColor.get(rodKey) ?? {
        segments: [],
        joints: [],
        diameterInches,
      };
      if (!runSelected && !rodsByColor.has(rodKey)) {
        rodsByColor.set(rodKey, colorBuffers);
      }
      if (runSelected && !selectedRodsByColor.has(rodKey)) {
        selectedRodsByColor.set(rodKey, selectedColorBuffers);
      }
      const targetSegments = runSelected
        ? selectedColorBuffers.segments
        : colorBuffers.segments;
      const targetJoints = runSelected
        ? selectedColorBuffers.joints
        : colorBuffers.joints;
      const instances = generatedRebarInstances.get(run.id) ?? [];
      if (rebarSectionView) {
        const graphic = sectionRebarGraphics?.get(run.id);
        const lift = Math.max(tolerance * 5, 1e-8);
        const towardCamera = (point: Vec3): Vec3 => ({
          x: point.x + rebarSectionView.normal.x * lift,
          y: point.y + rebarSectionView.normal.y * lift,
          z: point.z + rebarSectionView.normal.z * lift,
        });
        graphic?.segments.forEach(([start, end]) => {
          targetSegments.push([towardCamera(start), towardCamera(end)]);
        });
        graphic?.circles.forEach((center) => {
          targetJoints.push(towardCamera(center));
        });
      }
      for (const instance of instances) {
        if (rebarSectionView) continue;
        for (const line of instance) {
          targetJoints.push(...line.points);
          for (let index = 0; index < line.points.length - 1; index += 1) {
            targetSegments.push([line.points[index], line.points[index + 1]]);
          }
          if (line.closed && line.points.length > 2) {
            targetSegments.push([
              line.points[line.points.length - 1],
              line.points[0],
            ]);
          }
        }
      }
      const firstPoint = instances[0]?.[0]?.points[0];
      if (showRebarLabels && firstPoint) {
        const label = createTextSprite(run.name);
        if (label) {
          const position = toThree(firstPoint, displayOffset);
          label.position.copy(position);
          state.rebarGroup.add(label);
        }
      }
    }
    rodsByColor.forEach((buffers, key) => {
      addRodMeshes(
        buffers.segments,
        buffers.joints,
        new THREE.Color(key.split("|")[0]).getHex(),
        buffers.diameterInches,
      );
    });
    selectedRodsByColor.forEach((buffers, key) => {
      addRodMeshes(
        buffers.segments,
        buffers.joints,
        new THREE.Color(key.split("|")[0]).getHex(),
        buffers.diameterInches,
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
    addRodMeshes(
      draftSegments,
      draftJoints,
      0xf04b43,
      rebarBendStandard(draftRebarBarNumber).diameterInches,
      true,
    );
    if (rebarLapSnapPoints.length) {
      const markerRadius = Math.max(
        tolerance * 18,
        inchesPerModelUnit ? 0.7 / inchesPerModelUnit : tolerance * 18,
      );
      rebarLapSnapPoints.forEach((point) => {
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(markerRadius, 18, 12),
          new THREE.MeshBasicMaterial({
            color: 0x1688ff,
            depthTest: false,
            depthWrite: false,
          }),
        );
        marker.position.copy(toThree(point, displayOffset));
        marker.renderOrder = 45;
        state.rebarGroup.add(marker);
      });
    }
    for (const anchor of rebarAdvancedAnchors) {
      const radius = Math.max(
        tolerance * 14,
        inchesPerModelUnit ? 1.25 / inchesPerModelUnit : tolerance * 18,
      );
      const color =
        anchor.role === "start"
          ? 0xffc400
          : anchor.role === "end"
            ? 0x00cfe8
            : 0xf28c28;
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(
          radius * (anchor.active ? 1.3 : 1),
          18,
          12,
        ),
        new THREE.MeshBasicMaterial({
          color,
          depthTest: false,
          depthWrite: false,
        }),
      );
      marker.position.copy(toThree(anchor.point, displayOffset));
      marker.renderOrder = 40;
      state.rebarGroup.add(marker);
    }
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
    draftRebarBarNumber,
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
    rebarSectionView,
    rebarLapSnapPoints,
    rebarPlanes,
    rebarAdvancedAnchors,
    rebarRuns,
    generatedRebarInstances,
    sectionRebarGraphics,
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

  const nearestDetailTarget = (
    point: ScreenPoint,
    segments: Array<[ScreenPoint, ScreenPoint]>,
  ) => {
    let best = { segmentIndex: 0, fraction: 0.5, distance: Infinity };
    segments.forEach(([start, end], segmentIndex) => {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const denominator = dx * dx + dy * dy || 1;
      const fraction = Math.max(
        0,
        Math.min(
          1,
          ((point.x - start.x) * dx + (point.y - start.y) * dy) /
            denominator,
        ),
      );
      const x = start.x + dx * fraction;
      const y = start.y + dy * fraction;
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance < best.distance) {
        best = { segmentIndex, fraction, distance };
      }
    });
    return best;
  };

  const updateDetailNote = (id: string, next: DetailNote) => {
    onDetailNotesChange(
      detailNotes.map((note) => (note.id === id ? next : note)),
    );
  };

  const detailPointAtScreen = (
    point: ScreenPoint,
    width: number,
    height: number,
  ) => {
    const state = sceneRef.current;
    if (!state || !rebarSectionView) return null;
    state.camera.updateMatrixWorld(true);
    const pointer = new THREE.Vector2(
      (point.x / Math.max(width, 1)) * 2 - 1,
      -(point.y / Math.max(height, 1)) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, state.camera);
    const planePoint = toThree(rebarSectionView.origin, displayOffset);
    const planeNormal = new THREE.Vector3(
      rebarSectionView.normal.x,
      rebarSectionView.normal.y,
      rebarSectionView.normal.z,
    ).normalize();
    const intersection = raycaster.ray.intersectPlane(
      new THREE.Plane().setFromNormalAndCoplanarPoint(
        planeNormal,
        planePoint,
      ),
      new THREE.Vector3(),
    );
    if (!intersection) return null;
    const currentPoint = {
      x: intersection.x + displayOffset.x,
      y: intersection.y + displayOffset.y,
      z: intersection.z + displayOffset.z,
    };
    return reframePoint(currentPoint, basis, null);
  };

  const projectDetailObjectPoint = (
    objectPoint: Vec3 | undefined,
    fallback: ScreenPoint,
    width: number,
    height: number,
  ): ScreenPoint => {
    const state = sceneRef.current;
    if (!state || !objectPoint) return fallback;
    const currentPoint = reframePoint(objectPoint, null, basis);
    const projected = toThree(currentPoint, displayOffset).project(state.camera);
    return {
      x: (projected.x * 0.5 + 0.5) * width,
      y: (-projected.y * 0.5 + 0.5) * height,
    };
  };

  const projectDetailNoteTarget = (
    note: DetailNote,
    width: number,
    height: number,
  ) => projectDetailObjectPoint(
    note.objectTarget,
    { x: note.target.x * width, y: note.target.y * height },
    width,
    height,
  );

  useEffect(() => {
    if (
      !detailMode ||
      !rebarSectionView ||
      !detailNotes.some(
        (note) => !note.objectTarget || !note.objectLabel || !note.objectLeader,
      )
    ) {
      return;
    }
    const host = hostRef.current;
    if (!host?.clientWidth || !host.clientHeight) return;
    let changed = false;
    const migrated = detailNotes.map((note) => {
      const objectTarget = note.objectTarget ?? detailPointAtScreen(
        { x: note.target.x * host.clientWidth, y: note.target.y * host.clientHeight },
        host.clientWidth, host.clientHeight,
      );
      const objectLabel = note.objectLabel ?? detailPointAtScreen(
        { x: note.label.x * host.clientWidth, y: note.label.y * host.clientHeight },
        host.clientWidth, host.clientHeight,
      );
      const objectLeader = note.objectLeader ?? detailPointAtScreen(
        { x: note.leader.x * host.clientWidth, y: note.leader.y * host.clientHeight },
        host.clientWidth, host.clientHeight,
      );
      if (!objectTarget || !objectLabel || !objectLeader) return note;
      changed = true;
      return { ...note, objectTarget, objectLabel, objectLeader };
    });
    if (changed) onDetailNotesChange(migrated);
  }, [
    basis,
    detailMode,
    detailNotes,
    detailProjectionRevision,
    displayOffset,
    onDetailNotesChange,
    rebarSectionView,
  ]);

  useEffect(() => {
    if (!detailMode || !rebarSectionView) return;
    const host = hostRef.current;
    if (!host?.clientWidth || !host.clientHeight) return;
    const allDetailPoints = detailScreenGraphics.flatMap((candidate) => [
      ...candidate.segments.flat(),
      ...candidate.dots,
    ]);
    const center = allDetailPoints.length
      ? {
          x: allDetailPoints.reduce((sum, item) => sum + item.x, 0) / allDetailPoints.length,
          y: allDetailPoints.reduce((sum, item) => sum + item.y, 0) / allDetailPoints.length,
        }
      : { x: host.clientWidth / 2, y: host.clientHeight / 2 };
    const occupied: Array<{ left: number; right: number; top: number; bottom: number }> = [];
    for (const graphic of detailScreenGraphics) {
      if (!graphic.segments.length || graphic.dots.length >= 2) continue;
      const adjustment = detailRunAdjustments[graphic.run.id] ?? {};
      if (adjustment.objectLabel && adjustment.objectLeader) {
        const existing = projectDetailObjectPoint(
          adjustment.objectLabel,
          center,
          host.clientWidth,
          host.clientHeight,
        );
        const width = Math.max(70, `${graphic.run.name} @ ${graphic.run.spacingInches}\"`.length * 7);
        occupied.push({ left: existing.x - width / 2, right: existing.x + width / 2, top: existing.y - 10, bottom: existing.y + 10 });
        continue;
      }
      const longest = graphic.segments.reduce(
        (best, segment, index) => {
          const distance = Math.hypot(
            segment[1].x - segment[0].x,
            segment[1].y - segment[0].y,
          );
          return distance > best.distance ? { index, distance } : best;
        },
        { index: 0, distance: 0 },
      );
      const targetDefinition = adjustment.target ?? {
        segmentIndex: longest.index,
        fraction: 0.5,
      };
      const segment = graphic.segments[targetDefinition.segmentIndex] ?? graphic.segments[longest.index];
      if (!segment) continue;
      const target = {
        x: segment[0].x + (segment[1].x - segment[0].x) * targetDefinition.fraction,
        y: segment[0].y + (segment[1].y - segment[0].y) * targetDefinition.fraction,
      };
      const horizontalDirection = target.x >= center.x ? 1 : -1;
      const verticalDirection = target.y >= center.y ? 1 : -1;
      const labelWidth = Math.max(70, `${graphic.run.name} @ ${graphic.run.spacingInches}\"`.length * 7);
      let landingStart = { x: target.x, y: target.y };
      let label = { x: target.x, y: target.y };
      let labelBounds = { left: 0, right: 0, top: 0, bottom: 0 };
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const pointerReach = 46 + attempt * 18;
        const verticalNudge = attempt % 2 ? Math.ceil(attempt / 2) * 18 : 0;
        landingStart = {
          x: target.x + horizontalDirection * pointerReach,
          y: target.y + verticalDirection * (pointerReach + verticalNudge),
        };
        label = {
          x: landingStart.x + horizontalDirection * (DETAIL_LANDING_LENGTH + DETAIL_TEXT_GAP),
          y: landingStart.y,
        };
        labelBounds = {
          left: horizontalDirection > 0 ? label.x : label.x - labelWidth,
          right: horizontalDirection > 0 ? label.x + labelWidth : label.x,
          top: label.y - 10,
          bottom: label.y + 10,
        };
        if (!occupied.some((item) =>
          labelBounds.left < item.right && labelBounds.right > item.left &&
          labelBounds.top < item.bottom && labelBounds.bottom > item.top
        )) break;
      }
      occupied.push(labelBounds);
      const leader = landingStart;
      const objectLabel = adjustment.objectLabel ?? detailPointAtScreen(label, host.clientWidth, host.clientHeight);
      const objectLeader = adjustment.objectLeader ?? detailPointAtScreen(leader, host.clientWidth, host.clientHeight);
      if (objectLabel && objectLeader) {
        onDetailRunAdjustment(graphic.run.id, { ...adjustment, objectLabel, objectLeader });
      }
    }
  }, [
    basis,
    detailMode,
    detailProjectionRevision,
    detailRunAdjustments,
    detailScreenGraphics,
    displayOffset,
    onDetailRunAdjustment,
    rebarSectionView,
  ]);

  const handleDetailPointerMove = (
    event: ReactPointerEvent<SVGSVGElement>,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    if (pendingDetailNoteText) setDetailNoteCursor(point);
    if (!detailDrag) return;
    if (detailDrag.kind === "run-target") {
      const graphic = detailScreenGraphics.find(
        (candidate) => candidate.run.id === detailDrag.id,
      );
      if (!graphic?.segments.length) return;
      const target = nearestDetailTarget(point, graphic.segments);
      onDetailRunAdjustment(detailDrag.id, {
        ...(detailRunAdjustments[detailDrag.id] ?? {}),
        target: {
          segmentIndex: target.segmentIndex,
          fraction: target.fraction,
        },
      });
      return;
    }
    const dx = event.clientX - detailDrag.start.x;
    const dy = event.clientY - detailDrag.start.y;
    if (detailDrag.kind === "run-label" || detailDrag.kind === "run-leader") {
      const initial = detailDrag.initial;
      const initialLabel = projectDetailObjectPoint(
        initial.objectLabel,
        { x: point.x - dx, y: point.y - dy },
        rect.width,
        rect.height,
      );
      const objectPoint = detailPointAtScreen(
        { x: initialLabel.x + dx, y: initialLabel.y + dy },
        rect.width,
        rect.height,
      );
      if (!objectPoint) return;
      const next = { ...initial, objectLabel: objectPoint };
      onDetailRunAdjustment(detailDrag.id, next);
      return;
    }
    if (
      detailDrag.kind === "dimension" ||
      detailDrag.kind === "lap-dimension"
    ) {
      const initial = detailDrag.initial;
      onDetailRunAdjustment(detailDrag.id, {
        ...initial,
        ...(detailDrag.kind === "dimension"
          ? { dimensionOffset: (initial.dimensionOffset ?? 0) + dy }
          : {
              lapDimensionOffset:
                (initial.lapDimensionOffset ?? 0) + dy,
            }),
      });
      return;
    }
    const initial = detailDrag.initial as DetailNote;
    if (detailDrag.kind === "note-target") {
      const objectTarget = detailPointAtScreen(point, rect.width, rect.height);
      updateDetailNote(detailDrag.id, {
        ...initial,
        target: { x: point.x / rect.width, y: point.y / rect.height },
        ...(objectTarget ? { objectTarget } : {}),
      });
    } else if (detailDrag.kind === "note-label") {
      const initialLabel = projectDetailObjectPoint(
        initial.objectLabel,
        { x: initial.label.x * rect.width, y: initial.label.y * rect.height },
        rect.width,
        rect.height,
      );
      const nextLabel = { x: initialLabel.x + dx, y: initialLabel.y + dy };
      const objectLabel = detailPointAtScreen(nextLabel, rect.width, rect.height);
      updateDetailNote(detailDrag.id, {
        ...initial,
        label: {
          x: nextLabel.x / rect.width,
          y: nextLabel.y / rect.height,
        },
        ...(objectLabel ? { objectLabel } : {}),
      });
    } else {
      const objectLeader = detailPointAtScreen(point, rect.width, rect.height);
      updateDetailNote(detailDrag.id, {
        ...initial,
        leader: {
          x: (initial.leader.x * rect.width + dx) / rect.width,
          y: (initial.leader.y * rect.height + dy) / rect.height,
        },
        ...(objectLeader ? { objectLeader } : {}),
      });
    }
  };

  useEffect(() => {
    if (!pendingDetailNoteText) {
      setDetailNoteCursor(null);
      return;
    }
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onCancelDetailNote();
      setDetailNoteCursor(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [onCancelDetailNote, pendingDetailNoteText]);

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
      {detailMode && rebarSectionView && (
        <svg
          className={`detail-annotation-layer${
            pendingDetailNoteText ? " placing-note" : ""
          }`}
          aria-label="Editable reinforcing detail annotations"
          onPointerMove={handleDetailPointerMove}
          onPointerDown={(event) => {
            if (!pendingDetailNoteText || event.target !== event.currentTarget) {
              return;
            }
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const target = {
              x: event.clientX - rect.left,
              y: event.clientY - rect.top,
            };
            const objectTarget = detailPointAtScreen(
              target,
              rect.width,
              rect.height,
            );
            if (!objectTarget) return;
            const leaderPoint = { x: target.x + 46, y: target.y - 46 };
            const labelPoint = {
              x: leaderPoint.x + DETAIL_LANDING_LENGTH + DETAIL_TEXT_GAP,
              y: leaderPoint.y,
            };
            const objectLeader = detailPointAtScreen(leaderPoint, rect.width, rect.height);
            const objectLabel = detailPointAtScreen(labelPoint, rect.width, rect.height);
            onPlaceDetailNote({
              id: `detail-note-${crypto.randomUUID()}`,
              text: pendingDetailNoteText,
              target: { x: target.x / rect.width, y: target.y / rect.height },
              objectTarget,
              ...(objectLeader ? { objectLeader } : {}),
              ...(objectLabel ? { objectLabel } : {}),
              leader: {
                x: Math.min(0.98, leaderPoint.x / rect.width),
                y: Math.max(0.02, (target.y - 38) / rect.height),
              },
              label: {
                x: Math.min(0.98, labelPoint.x / rect.width),
                y: Math.max(0.02, (target.y - 38) / rect.height),
              },
            });
            setDetailNoteCursor(null);
          }}
          onPointerUp={() => setDetailDrag(null)}
          onPointerCancel={() => setDetailDrag(null)}
        >
          <defs>
            <marker
              id="detail-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#111" />
            </marker>
          </defs>
          {detailScreenGraphics.map((graphic) => {
            const adjustment = detailRunAdjustments[graphic.run.id] ?? {};
            const label = `${graphic.run.name} @ ${graphic.run.spacingInches}\"`;
            if (graphic.dimensionRange || graphic.dots.length >= 2) {
              let pair: [ScreenPoint, ScreenPoint] = graphic.dimensionRange ?? [
                graphic.dots[0],
                graphic.dots[1],
              ];
              if (!graphic.dimensionRange) {
                let farthest = 0;
                graphic.dots.forEach((first, firstIndex) =>
                  graphic.dots.slice(firstIndex + 1).forEach((second) => {
                    const distance = Math.hypot(
                      second.x - first.x,
                      second.y - first.y,
                    );
                    if (distance > farthest) {
                      farthest = distance;
                      pair = [first, second];
                    }
                  }),
                );
              }
              const dx = pair[1].x - pair[0].x;
              const dy = pair[1].y - pair[0].y;
              const magnitude = Math.hypot(dx, dy) || 1;
              let normal = { x: -dy / magnitude, y: dx / magnitude };
              if (normal.y > 0) normal = { x: -normal.x, y: -normal.y };
              const offset = 32 - (adjustment.dimensionOffset ?? 0);
              const first = {
                x: pair[0].x + normal.x * offset,
                y: pair[0].y + normal.y * offset,
              };
              const second = {
                x: pair[1].x + normal.x * offset,
                y: pair[1].y + normal.y * offset,
              };
              const middle = {
                x: (first.x + second.x) / 2 + normal.x * 7,
                y: (first.y + second.y) / 2 + normal.y * 7,
              };
              let textAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
              if (textAngle > 90) textAngle -= 180;
              if (textAngle < -90) textAngle += 180;
              return (
                <g
                  key={graphic.run.id}
                  className="detail-dimension annotation-draggable"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDetailDrag({
                      kind: "dimension",
                      id: graphic.run.id,
                      start: { x: event.clientX, y: event.clientY },
                      initial: adjustment,
                    });
                  }}
                >
                  <line x1={pair[0].x} y1={pair[0].y} x2={first.x} y2={first.y} />
                  <line x1={pair[1].x} y1={pair[1].y} x2={second.x} y2={second.y} />
                  <line
                    x1={first.x}
                    y1={first.y}
                    x2={second.x}
                    y2={second.y}
                    markerStart="url(#detail-arrow)"
                    markerEnd="url(#detail-arrow)"
                  />
                  {graphic.mixed && graphic.representativeTarget && (
                    <line
                      className="detail-dimension-witness"
                      x1={(first.x + second.x) / 2}
                      y1={(first.y + second.y) / 2}
                      x2={graphic.representativeTarget.x}
                      y2={graphic.representativeTarget.y}
                    />
                  )}
                  <text
                    x={middle.x}
                    y={middle.y}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    transform={`rotate(${textAngle} ${middle.x} ${middle.y})`}
                  >
                    {label}
                  </text>
                </g>
              );
            }

            const longest = graphic.segments.reduce(
              (best, segment, index) => {
                const distance = Math.hypot(
                  segment[1].x - segment[0].x,
                  segment[1].y - segment[0].y,
                );
                return distance > best.distance
                  ? { index, distance }
                  : best;
              },
              { index: 0, distance: 0 },
            );
            const targetDefinition = adjustment.target ?? {
              segmentIndex: longest.index,
              fraction: 0.5,
            };
            const targetSegment =
              graphic.segments[targetDefinition.segmentIndex] ??
              graphic.segments[longest.index];
            if (!targetSegment) return null;
            const target = {
              x:
                targetSegment[0].x +
                (targetSegment[1].x - targetSegment[0].x) *
                  targetDefinition.fraction,
              y:
                targetSegment[0].y +
                (targetSegment[1].y - targetSegment[0].y) *
                  targetDefinition.fraction,
            };
            const host = hostRef.current;
            const width = Math.max(host?.clientWidth ?? 1, 1);
            const height = Math.max(host?.clientHeight ?? 1, 1);
            const textPoint = projectDetailObjectPoint(
              adjustment.objectLabel,
              {
                x: target.x + (adjustment.labelOffset?.x ?? 54),
                y: target.y + (adjustment.labelOffset?.y ?? -22),
              },
              width,
              height,
            );
            const textDirection = textPoint.x >= target.x ? 1 : -1;
            const textAnchor = textDirection > 0 ? "start" : "end";
            const landingEnd = {
              x: textPoint.x - textDirection * DETAIL_TEXT_GAP,
              y: textPoint.y,
            };
            const leader = {
              x: landingEnd.x - textDirection * DETAIL_LANDING_LENGTH,
              y: textPoint.y,
            };
            const beginLabelDrag = (event: ReactPointerEvent<SVGElement>) => {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDetailDrag({
                kind: "run-label",
                id: graphic.run.id,
                start: { x: event.clientX, y: event.clientY },
                initial: adjustment,
              });
            };
            return (
              <g key={graphic.run.id} className="detail-leader">
                <line
                  x1={target.x}
                  y1={target.y}
                  x2={leader.x}
                  y2={leader.y}
                  markerStart="url(#detail-arrow)"
                />
                <line
                  className="annotation-draggable detail-landing"
                  x1={leader.x}
                  y1={leader.y}
                  x2={landingEnd.x}
                  y2={landingEnd.y}
                  onPointerDown={beginLabelDrag}
                />
                <text
                  className="annotation-draggable"
                  x={textPoint.x}
                  y={textPoint.y}
                  textAnchor={textAnchor}
                  dominantBaseline="middle"
                  onPointerDown={beginLabelDrag}
                >
                  {label}
                </text>
                <circle
                  className="detail-handle annotation-draggable"
                  cx={target.x}
                  cy={target.y}
                  r="5"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDetailDrag({ kind: "run-target", id: graphic.run.id });
                  }}
                />
                {graphic.lapDimensions.map((dimension, index) => {
                  const lapOffset =
                    24 + (adjustment.lapDimensionOffset ?? 0) + index * 14;
                  const dx = dimension.end.x - dimension.start.x;
                  const dy = dimension.end.y - dimension.start.y;
                  const magnitude = Math.hypot(dx, dy) || 1;
                  let normal = { x: -dy / magnitude, y: dx / magnitude };
                  if (normal.y < 0) normal = { x: -normal.x, y: -normal.y };
                  const start = {
                    x: dimension.start.x + normal.x * lapOffset,
                    y: dimension.start.y + normal.y * lapOffset,
                  };
                  const end = {
                    x: dimension.end.x + normal.x * lapOffset,
                    y: dimension.end.y + normal.y * lapOffset,
                  };
                  return (
                    <g
                      key={`${graphic.run.id}-lap-${index}`}
                      className="detail-lap-dimension annotation-draggable"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setDetailDrag({
                          kind: "lap-dimension",
                          id: graphic.run.id,
                          start: { x: event.clientX, y: event.clientY },
                          initial: adjustment,
                        });
                      }}
                    >
                      <line x1={dimension.start.x} y1={dimension.start.y} x2={start.x} y2={start.y} />
                      <line x1={dimension.end.x} y1={dimension.end.y} x2={end.x} y2={end.y} />
                      <line
                        x1={start.x}
                        y1={start.y}
                        x2={end.x}
                        y2={end.y}
                        markerStart="url(#detail-arrow)"
                        markerEnd="url(#detail-arrow)"
                      />
                      <text
                        x={(start.x + end.x) / 2}
                        y={(start.y + end.y) / 2 - 5}
                        textAnchor="middle"
                      >
                        {`${dimension.lengthInches.toFixed(1)}\" LAP`}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
          {detailNotes.map((note) => {
            const host = hostRef.current;
            const width = Math.max(host?.clientWidth ?? 1, 1);
            const height = Math.max(host?.clientHeight ?? 1, 1);
            const target = projectDetailNoteTarget(note, width, height);
            const label = projectDetailObjectPoint(
              note.objectLabel,
              { x: note.label.x * width, y: note.label.y * height },
              width,
              height,
            );
            const textDirection = label.x >= target.x ? 1 : -1;
            const textAnchor = textDirection > 0 ? "start" : "end";
            const landingEnd = {
              x: label.x - textDirection * DETAIL_TEXT_GAP,
              y: label.y,
            };
            const leader = {
              x: landingEnd.x - textDirection * DETAIL_LANDING_LENGTH,
              y: label.y,
            };
            const beginNoteLabelDrag = (event: ReactPointerEvent<SVGElement>) => {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDetailDrag({
                kind: "note-label",
                id: note.id,
                start: { x: event.clientX, y: event.clientY },
                initial: note,
              });
            };
            return (
              <g key={note.id} className="detail-leader custom-detail-note">
                <line
                  x1={target.x}
                  y1={target.y}
                  x2={leader.x}
                  y2={leader.y}
                  markerStart="url(#detail-arrow)"
                />
                <line
                  className="annotation-draggable detail-landing"
                  x1={leader.x}
                  y1={leader.y}
                  x2={landingEnd.x}
                  y2={landingEnd.y}
                  onPointerDown={beginNoteLabelDrag}
                />
                <text
                  className="annotation-draggable"
                  x={label.x}
                  y={label.y}
                  textAnchor={textAnchor}
                  dominantBaseline="middle"
                  onPointerDown={beginNoteLabelDrag}
                >
                  {note.text}
                </text>
                <circle
                  className="detail-handle annotation-draggable"
                  cx={target.x}
                  cy={target.y}
                  r="5"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDetailDrag({
                      kind: "note-target",
                      id: note.id,
                      start: { x: event.clientX, y: event.clientY },
                      initial: note,
                    });
                  }}
                />
              </g>
            );
          })}
          {pendingDetailNoteText && detailNoteCursor && (() => {
            const target = detailNoteCursor;
            const label = {
              x: target.x + DETAIL_LANDING_LENGTH + DETAIL_TEXT_GAP + 46,
              y: target.y - 46,
            };
            const landingEnd = {
              x: label.x - DETAIL_TEXT_GAP,
              y: label.y,
            };
            const leader = {
              x: landingEnd.x - DETAIL_LANDING_LENGTH,
              y: label.y,
            };
            return (
              <g className="detail-leader pending-detail-note" aria-hidden="true">
                <line
                  x1={target.x}
                  y1={target.y}
                  x2={leader.x}
                  y2={leader.y}
                  markerStart="url(#detail-arrow)"
                />
                <line
                  x1={leader.x}
                  y1={leader.y}
                  x2={landingEnd.x}
                  y2={landingEnd.y}
                />
                <text x={label.x} y={label.y} dominantBaseline="middle">
                  {pendingDetailNoteText}
                </text>
              </g>
            );
          })()}
        </svg>
      )}
      {segmentLengthHud && (
        <div
          className="rebar-segment-length"
          style={{
            left: segmentLengthHud.clientX + 14,
            top: segmentLengthHud.clientY + 14,
          }}
        >
          {segmentLengthHud.wholeInchSnap
            ? `${Math.round(segmentLengthHud.inches)} in · WHOLE-INCH SNAP`
            : `${segmentLengthHud.inches.toFixed(2)} in`}
        </div>
      )}
    </div>
  );
}
