"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createBasisFromFloor,
  getBounds,
  reframeDirection,
  reframePoint,
  transformNodes,
} from "../lib/coordinateSystem";
import { autoHullFaces } from "../lib/autoVolume";
import { parseMctModel } from "../lib/mctParser";
import { buildElementSkin } from "../lib/elementSkin";
import {
  createPlaneCoverOutlines,
  distributeBars,
} from "../lib/rebarGeometry";
import { createSampleMct } from "../lib/sampleModel";
import { smartFaceFromSeed } from "../lib/smartSelect";
import {
  axisSliceFaceFromSeed,
  fullPlaneFaceFromSeed,
  localPatchFaceFromSeed,
  type SmartAxis,
} from "../lib/smartSelectVariants";
import {
  loadWorkspace,
  saveWorkspace,
  type SavedWorkspace,
} from "../lib/workspaceStorage";
import type {
  Axis,
  Bounds,
  CameraViewpoint,
  LocalBasis,
  ModelElement,
  RebarLine,
  RebarGroup,
  RebarPlane,
  RebarRun,
  ModelNode,
  SliceRanges,
  SlicePin,
  Vec3,
  VolumeFace,
  WorkflowTab,
} from "../lib/types";
import {
  autoBoxFaces,
  buildPolyhedron,
  centroid,
  createFace,
  createFittedFace,
  isInsidePlanes,
  isPointOnFaceBoundary,
  isPointWithinFace,
  modelTolerance,
} from "../lib/volumeGeometry";
import PointCloudViewport from "./PointCloudViewport";

const TABS: Array<{ id: WorkflowTab; label: string; number: string }> = [
  { id: "volume", label: "Model", number: "01" },
  { id: "coordinates", label: "Axes + Scale", number: "02" },
  { id: "slicing", label: "Slicing", number: "03" },
  { id: "rebar", label: "Rebar", number: "04" },
];

const REBAR_COLORS = [
  "#8f1717",
  "#c62828",
  "#ef5350",
  "#ff7043",
  "#f9a825",
  "#fdd835",
  "#7cb342",
  "#2e7d32",
  "#00897b",
  "#00acc1",
  "#0288d1",
  "#1565c0",
  "#3949ab",
  "#5e35b1",
  "#8e24aa",
  "#d81b60",
  "#6d4c41",
  "#546e7a",
  "#b0bec5",
  "#212121",
] as const;

const PLANE_COLORS = [
  "#42a5f5",
  "#ab47bc",
  "#26a69a",
  "#ffa726",
  "#ec407a",
  "#7e57c2",
  "#66bb6a",
  "#29b6f6",
  "#ff7043",
  "#d4e157",
] as const;

const formatCoordinate = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);

const fullSlice = (bounds: Bounds): SliceRanges => ({
  x: [...bounds.x],
  y: [...bounds.y],
  z: [...bounds.z],
});

const subtract = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

const reframeRebarLine = (
  line: RebarLine,
  fromBasis: LocalBasis | null,
  toBasis: LocalBasis | null,
): RebarLine => ({
  ...line,
  points: line.points.map((point) =>
    reframePoint(point, fromBasis, toBasis),
  ),
});

const reframeRebarRun = (
  run: RebarRun,
  fromBasis: LocalBasis | null,
  toBasis: LocalBasis | null,
): RebarRun => {
  const objectLines =
    run.objectLines ??
    run.lines.map((line) =>
      reframeRebarLine(line, fromBasis, null),
    );
  const objectPathStart =
    run.objectPathStart ??
    (run.pathStart
      ? reframePoint(run.pathStart, fromBasis, null)
      : undefined);
  const objectPathEnd =
    run.objectPathEnd ??
    (run.pathEnd
      ? reframePoint(run.pathEnd, fromBasis, null)
      : undefined);
  const objectPathPoints =
    run.objectPathPoints ??
    run.pathPoints?.map((point) => reframePoint(point, fromBasis, null)) ??
    (objectPathStart && objectPathEnd
      ? [objectPathStart, objectPathEnd]
      : undefined);
  const pathStart = objectPathStart
    ? reframePoint(objectPathStart, null, toBasis)
    : undefined;
  const pathEnd = objectPathEnd
    ? reframePoint(objectPathEnd, null, toBasis)
    : undefined;
  const pathPoints = objectPathPoints?.map((point) =>
    reframePoint(point, null, toBasis),
  );
  let distributionVector = run.distributionVector
    ? reframeDirection(run.distributionVector, fromBasis, toBasis)
    : undefined;
  if (pathStart && pathEnd) {
    const delta = subtract(pathEnd, pathStart);
    const length = Math.hypot(delta.x, delta.y, delta.z);
    if (length > 1e-12) {
      distributionVector = {
        x: delta.x / length,
        y: delta.y / length,
        z: delta.z / length,
      };
    }
  }
  return {
    ...run,
    start: pathStart?.[run.axis] ?? run.start,
    end: pathEnd?.[run.axis] ?? run.end,
    pathStart,
    pathEnd,
    objectLines,
    objectPathStart,
    objectPathEnd,
    objectPathPoints,
    pathPoints,
    distributionVector,
    lines: objectLines.map((line) =>
      reframeRebarLine(line, null, toBasis),
    ),
  };
};

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

const dot = (a: Vec3, b: Vec3) =>
  a.x * b.x + a.y * b.y + a.z * b.z;

const normalize = (value: Vec3): Vec3 => {
  const length = Math.hypot(value.x, value.y, value.z);
  if (length <= 1e-12) throw new Error("The selected nodes do not define a direction.");
  return {
    x: value.x / length,
    y: value.y / length,
    z: value.z / length,
  };
};

const addScaled = (origin: Vec3, direction: Vec3, amount: number): Vec3 => ({
  x: origin.x + direction.x * amount,
  y: origin.y + direction.y * amount,
  z: origin.z + direction.z * amount,
});

const projectToPlaneOffset = (
  point: Vec3,
  origin: Vec3,
  normal: Vec3,
  offset: number,
) => {
  const currentOffset = dot(subtract(point, origin), normal);
  return addScaled(point, normal, offset - currentOffset);
};

const leastUsedRebarColor = (runs: RebarRun[]) => {
  const counts = new Map(REBAR_COLORS.map((color) => [color, 0]));
  runs.forEach((run) => {
    if (run.color && counts.has(run.color as (typeof REBAR_COLORS)[number])) {
      counts.set(
        run.color as (typeof REBAR_COLORS)[number],
        (counts.get(run.color as (typeof REBAR_COLORS)[number]) ?? 0) + 1,
      );
    }
  });
  const minimum = Math.min(...counts.values());
  const candidates = [...counts.entries()]
    .filter(([, count]) => count === minimum)
    .map(([color]) => color);
  return candidates[Math.floor(Math.random() * candidates.length)] ?? REBAR_COLORS[0];
};

const migrateRebarProject = (
  runs: RebarRun[],
  savedPlanes: RebarPlane[] | undefined,
  savedBasis: LocalBasis | null,
) => {
  const planes = [...(savedPlanes ?? [])];
  const migratedRuns = runs.map((run) => {
    if (run.planeId === null) return run;
    if (run.planeId && planes.some((plane) => plane.id === run.planeId)) {
      return run;
    }
    const id = `legacy-plane-${run.id}`;
    const axisDirection: Vec3 = {
      x: run.axis === "x" ? 1 : 0,
      y: run.axis === "y" ? 1 : 0,
      z: run.axis === "z" ? 1 : 0,
    };
    const objectNormal = normalize(
      reframeDirection(axisDirection, savedBasis, null),
    );
    const objectOrigin =
      run.objectPathStart ??
      run.objectLines?.[0]?.points[0] ??
      reframePoint(run.lines[0]?.points[0] ?? { x: 0, y: 0, z: 0 }, savedBasis, null);
    planes.push({
      id,
      name: `Legacy ${run.name} plane`,
      color: PLANE_COLORS[planes.length % PLANE_COLORS.length],
      objectOrigin,
      objectNormal,
      nodeIds: [],
    });
    const objectStart = run.objectPathStart ?? objectOrigin;
    const objectEnd = run.objectPathEnd ?? objectStart;
    return {
      ...run,
      planeId: id,
      startOffset: dot(subtract(objectStart, objectOrigin), objectNormal),
      endOffset: dot(subtract(objectEnd, objectOrigin), objectNormal),
    };
  });
  return { runs: migratedRuns, planes };
};

export default function ModelViewer() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const [allNodes, setAllNodes] = useState<ModelNode[]>([]);
  const [elements, setElements] = useState<ModelElement[]>([]);
  const [showElementSkin, setShowElementSkin] = useState(true);
  const [elementSkinVolume, setElementSkinVolume] = useState(false);
  const [elementEditMode, setElementEditMode] = useState(false);
  const [selectedElementIds, setSelectedElementIds] = useState<Set<number>>(
    new Set(),
  );
  const [fileName, setFileName] = useState("Demo bridge lattice");
  const [globalBounds, setGlobalBounds] = useState<Bounds | null>(null);
  const [activeTab, setActiveTab] = useState<WorkflowTab>("volume");
  const [faces, setFaces] = useState<VolumeFace[]>([]);
  const [definingFaces, setDefiningFaces] = useState(false);
  const [smartSelecting, setSmartSelecting] = useState(false);
  const [smartVariant, setSmartVariant] = useState<
    "classic" | "axis" | "local" | "full"
  >("classic");
  const [smartAxis, setSmartAxis] = useState<SmartAxis>("x");
  const [draftNodeIds, setDraftNodeIds] = useState<number[]>([]);
  const [fittedFaceConfirmation, setFittedFaceConfirmation] = useState<
    string | null
  >(null);
  const [selectedFaceIds, setSelectedFaceIds] = useState<Set<string>>(
    new Set(),
  );
  const [hoveredFaceId, setHoveredFaceId] = useState<string | null>(null);
  const [volumeConfirmed, setVolumeConfirmed] = useState(false);
  const [confirmWarning, setConfirmWarning] = useState(false);
  const [floorFaceId, setFloorFaceId] = useState<string | null>(null);
  const [xDirectionNodeIds, setXDirectionNodeIds] = useState<number[]>([]);
  const [basis, setBasis] = useState<LocalBasis | null>(null);
  const [slice, setSlice] = useState<SliceRanges>({
    x: [0, 1],
    y: [0, 1],
    z: [0, 1],
  });
  const [renderSlice, setRenderSlice] = useState<SliceRanges>(slice);
  const [hover, setHover] = useState<{
    node: ModelNode;
    clientX: number;
    clientY: number;
  } | null>(null);
  const [selectedNode, setSelectedNode] = useState<ModelNode | null>(null);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [scaleDefining, setScaleDefining] = useState(false);
  const [scaleNodeIds, setScaleNodeIds] = useState<number[]>([]);
  const [scaleDistanceInches, setScaleDistanceInches] = useState(12);
  const [inchesPerModelUnit, setInchesPerModelUnit] = useState<number | null>(
    null,
  );
  const [rebarRuns, setRebarRuns] = useState<RebarRun[]>([]);
  const [showConcreteSkin, setShowConcreteSkin] = useState(true);
  const [lineAndBar, setLineAndBar] = useState(false);
  const [showRebarLabels, setShowRebarLabels] = useState(false);
  const [rebarPlanes, setRebarPlanes] = useState<RebarPlane[]>([]);
  const [favoriteRebarPlaneIds, setFavoriteRebarPlaneIds] = useState<string[]>(
    [],
  );
  const [slicingSubtab, setSlicingSubtab] = useState<
    "planes" | "slice" | "pins"
  >("planes");
  const [selectedSlicingPlaneId, setSelectedSlicingPlaneId] =
    useState<string | null>(null);
  const [slicingPlaneOffset, setSlicingPlaneOffset] = useState(0);
  const [slicePins, setSlicePins] = useState<SlicePin[]>([]);
  const [selectedSlicePinId, setSelectedSlicePinId] =
    useState<string | null>(null);
  const [activeSlicePinId, setActiveSlicePinId] = useState<string | null>(null);
  const [showRebarInSlicing, setShowRebarInSlicing] = useState(true);
  const [viewpointCaptureRequest, setViewpointCaptureRequest] = useState<{
    pinId: string;
    nonce: number;
  } | null>(null);
  const [viewpointToApply, setViewpointToApply] = useState<{
    pinId: string;
    nonce: number;
    viewpoint: CameraViewpoint;
  } | null>(null);
  const [rebarGroups, setRebarGroups] = useState<RebarGroup[]>([]);
  const [collapsedRebarGroupIds, setCollapsedRebarGroupIds] = useState<
    Set<string>
  >(new Set());
  const [renamingRebarPlaneId, setRenamingRebarPlaneId] =
    useState<string | null>(null);
  const [rebarCoverOffsetInches, setRebarCoverOffsetInches] = useState(2);
  const [rebarSecondaryOffsetInches, setRebarSecondaryOffsetInches] =
    useState(4);
  const [topRebarPlaneDismissed, setTopRebarPlaneDismissed] = useState(false);
  const [activeRebarPlaneId, setActiveRebarPlaneId] =
    useState<string | null>(null);
  const [previewedRebarPlaneId, setPreviewedRebarPlaneId] =
    useState<string | null>(null);
  const [rebarPlaneDraftNodeIds, setRebarPlaneDraftNodeIds] = useState<
    number[]
  >([]);
  const [rebarPlaneReturnPhase, setRebarPlaneReturnPhase] = useState<
    "idle" | "plane"
  >("idle");
  const [rebarPhase, setRebarPhase] = useState<
    | "idle"
    | "lap-source"
    | "plane"
    | "plane-create"
    | "start"
    | "lines"
    | "path-start"
    | "end"
    | "path-end"
    | "path-review"
    | "spacing"
  >("idle");
  const [rebarWorkflowKind, setRebarWorkflowKind] = useState<
    "create" | "lap" | "edit"
  >("create");
  const [rebarReferenceRunId, setRebarReferenceRunId] =
    useState<string | null>(null);
  const [editingRebarRunId, setEditingRebarRunId] =
    useState<string | null>(null);
  const [rebarName, setRebarName] = useState("Bar Run 1");
  const [rebarBarNumber, setRebarBarNumber] = useState("5");
  const [rebarAxis, setRebarAxis] = useState<Axis>("x");
  const [rebarStart, setRebarStart] = useState(0);
  const [rebarEnd, setRebarEnd] = useState(0);
  const [rebarLines, setRebarLines] = useState<RebarLine[]>([]);
  const [pendingRebarLine, setPendingRebarLine] =
    useState<RebarLine | null>(null);
  const [rebarSpacing, setRebarSpacing] = useState(12);
  const [rebarPathStart, setRebarPathStart] = useState<Vec3 | null>(null);
  const [rebarPathEnd, setRebarPathEnd] = useState<Vec3 | null>(null);
  const [rebarPathPoints, setRebarPathPoints] = useState<Vec3[]>([]);
  const [selectedRebarRunIds, setSelectedRebarRunIds] = useState<Set<string>>(
    new Set(),
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setRenderSlice(slice), 55);
    return () => window.clearTimeout(timer);
  }, [slice]);

  const tolerance = globalBounds ? modelTolerance(globalBounds) : 1e-6;
  const elementSkin = useMemo(
    () => buildElementSkin(elements, allNodes),
    [allNodes, elements],
  );
  const closedElementShells = useMemo(
    () => elementSkin.shells.filter((shell) => shell.closed),
    [elementSkin.shells],
  );
  const facePlanes = useMemo(() => faces.map((face) => face.plane), [faces]);
  const automaticVolume = useMemo(
    () => faces.length >= 4 && faces.every((face) => face.automatic),
    [faces],
  );
  const definingNodeIds = useMemo(
    () => new Set(faces.flatMap((face) => face.nodeIds)),
    [faces],
  );
  const shapeEditingFaceId =
    activeTab === "volume" &&
    !definingFaces &&
    !smartSelecting &&
    selectedFaceIds.size === 1
      ? [...selectedFaceIds][0]
      : null;

  const displayNodes = useMemo(() => {
    if (!allNodes.length) return [];
    const draftSet = new Set(draftNodeIds);

    return allNodes.filter((node) => {
      let onFace = false;
      let onFaceEdge = false;
      let onEditingFace = false;
      for (const face of faces) {
        const faceTolerance = Math.max(
          tolerance,
          (face.fitDeviation ?? 0) * 1.1,
        );
        if (
          face.id === shapeEditingFaceId &&
          face.nodeIds.includes(node.id)
        ) {
          onEditingFace = true;
        }
        if (isPointWithinFace(node.global, face, faceTolerance)) {
          onFace = true;
          if (face.id === shapeEditingFaceId) onEditingFace = true;
        }
        if (isPointOnFaceBoundary(node.global, face, faceTolerance)) {
          onFaceEdge = true;
        }
      }

      if (!volumeConfirmed) {
        return (
          !onFace || onFaceEdge || onEditingFace || draftSet.has(node.id)
        );
      }

      const inside =
        automaticVolume ||
        isInsidePlanes(node.global, facePlanes, tolerance);
      return (
        inside &&
        (
          !onFace ||
          onFaceEdge ||
          definingNodeIds.has(node.id) ||
          draftSet.has(node.id)
        )
      );
    });
  }, [
    allNodes,
    automaticVolume,
    definingNodeIds,
    draftNodeIds,
    faces,
    facePlanes,
    shapeEditingFaceId,
    tolerance,
    volumeConfirmed,
  ]);

  const currentBounds = useMemo(() => {
    if (!allNodes.length) return null;
    const candidates = displayNodes.length ? displayNodes : allNodes;
    return getBounds(candidates, Boolean(basis));
  }, [allNodes, basis, displayNodes]);
  const reframeRebar = useCallback(
    (fromBasis: LocalBasis | null, toBasis: LocalBasis | null) => {
      if (fromBasis === toBasis) return;
      setRebarRuns((current) =>
        current.map((run) =>
          reframeRebarRun(run, fromBasis, toBasis),
        ),
      );
      setRebarLines((current) =>
        current.map((line) =>
          reframeRebarLine(line, fromBasis, toBasis),
        ),
      );
      setPendingRebarLine((current) =>
        current
          ? reframeRebarLine(current, fromBasis, toBasis)
          : null,
      );
      setRebarPathStart((current) =>
        current ? reframePoint(current, fromBasis, toBasis) : null,
      );
      setRebarPathEnd((current) =>
        current ? reframePoint(current, fromBasis, toBasis) : null,
      );
      setRebarPathPoints((current) =>
        current.map((point) => reframePoint(point, fromBasis, toBasis)),
      );
    },
    [],
  );
  const activeRebarPlane = useMemo(
    () =>
      activeRebarPlaneId
        ? rebarPlanes.find((plane) => plane.id === activeRebarPlaneId) ?? null
        : null,
    [activeRebarPlaneId, rebarPlanes],
  );
  useEffect(() => {
    if (
      !basis ||
      !allNodes.length ||
      topRebarPlaneDismissed ||
      rebarPlanes.some(
        (plane) =>
          plane.id === "auto-top-horizontal" ||
          plane.name.trim().toLowerCase() === "top horizontal",
      )
    ) {
      return;
    }
    const objectNormal = normalize(basis.zAxis);
    const highest = allNodes.reduce((best, node) =>
      dot(node.global, objectNormal) > dot(best.global, objectNormal)
        ? node
        : best,
    );
    setRebarPlanes((current) => [
      ...current,
      {
        id: "auto-top-horizontal",
        name: "Top Horizontal",
        color: PLANE_COLORS[current.length % PLANE_COLORS.length],
        objectOrigin: { ...highest.global },
        objectNormal,
        nodeIds: [],
      },
    ]);
  }, [allNodes, basis, rebarPlanes, topRebarPlaneDismissed]);
  const displayRebarPlane = useMemo(() => {
    if (!activeRebarPlane) return null;
    return {
      origin: reframePoint(activeRebarPlane.objectOrigin, null, basis),
      normal: normalize(
        reframeDirection(activeRebarPlane.objectNormal, null, basis),
      ),
      vertical: normalize(
        reframeDirection(
          basis?.zAxis ?? { x: 0, y: 0, z: 1 },
          null,
          basis,
        ),
      ),
    };
  }, [activeRebarPlane, basis]);
  const selectedSlicingPlane = useMemo(
    () =>
      rebarPlanes.find((plane) => plane.id === selectedSlicingPlaneId) ??
      null,
    [rebarPlanes, selectedSlicingPlaneId],
  );
  const displaySlicingPlane = useMemo(() => {
    if (!selectedSlicingPlane) return null;
    return {
      origin: reframePoint(selectedSlicingPlane.objectOrigin, null, basis),
      normal: normalize(
        reframeDirection(selectedSlicingPlane.objectNormal, null, basis),
      ),
    };
  }, [basis, selectedSlicingPlane]);
  const slicingPlaneBounds = useMemo<[number, number]>(() => {
    if (!displaySlicingPlane || !allNodes.length) return [0, 0];
    const values = allNodes.map((node) =>
      dot(
        subtract(node.local ?? node.global, displaySlicingPlane.origin),
        displaySlicingPlane.normal,
      ),
    );
    return [Math.min(...values), Math.max(...values)];
  }, [allNodes, displaySlicingPlane]);
  const selectedSlicePin = useMemo(
    () =>
      slicePins.find((pin) => pin.id === selectedSlicePinId) ?? null,
    [selectedSlicePinId, slicePins],
  );
  const activeSlicePin = useMemo(
    () => slicePins.find((pin) => pin.id === activeSlicePinId) ?? null,
    [activeSlicePinId, slicePins],
  );
  const activeCustomSlice = useMemo(() => {
    if (
      (activeTab === "rebar" && !activeSlicePin) ||
      (activeTab === "slicing" &&
        slicingSubtab !== "slice" &&
        !activeSlicePin)
    ) {
      return null;
    }
    const pin =
      activeTab === "rebar" || slicingSubtab === "pins"
        ? activeSlicePin
        : null;
    const planeId = pin?.planeId ?? selectedSlicingPlaneId;
    const plane = rebarPlanes.find((candidate) => candidate.id === planeId);
    if (
      !plane ||
      (activeTab !== "slicing" && activeTab !== "rebar")
    ) {
      return null;
    }
    return {
      origin: reframePoint(plane.objectOrigin, null, basis),
      normal: normalize(
        reframeDirection(plane.objectNormal, null, basis),
      ),
      offset: pin?.offset ?? slicingPlaneOffset,
    };
  }, [
    activeSlicePin,
    activeTab,
    basis,
    rebarPlanes,
    selectedSlicingPlaneId,
    slicingPlaneOffset,
    slicingSubtab,
  ]);
  const displayRebarPlanePreviews = useMemo(
    () => {
      if (rebarPhase === "plane" || rebarPhase === "plane-create") {
        return rebarPlanes.map((plane) => ({
            id: plane.id,
            color: plane.color,
            origin: reframePoint(plane.objectOrigin, null, basis),
            normal: normalize(
              reframeDirection(plane.objectNormal, null, basis),
            ),
          }));
      }
      if (activeTab === "slicing") {
        const planeId = activeSlicePin?.planeId ?? selectedSlicingPlaneId;
        const plane = rebarPlanes.find((candidate) => candidate.id === planeId);
        return plane
          ? [
              {
                id: plane.id,
                color: plane.color,
                origin: reframePoint(plane.objectOrigin, null, basis),
                normal: normalize(
                  reframeDirection(plane.objectNormal, null, basis),
                ),
              },
            ]
          : [];
      }
      if (activeTab === "rebar" && previewedRebarPlaneId) {
        const plane = rebarPlanes.find(
          (candidate) => candidate.id === previewedRebarPlaneId,
        );
        return plane
          ? [
              {
                id: plane.id,
                color: plane.color,
                origin: reframePoint(plane.objectOrigin, null, basis),
                normal: normalize(
                  reframeDirection(plane.objectNormal, null, basis),
                ),
              },
            ]
          : [];
      }
      return [];
    },
    [
      activeSlicePin,
      activeTab,
      basis,
      rebarPhase,
      rebarPlanes,
      previewedRebarPlaneId,
      selectedSlicingPlaneId,
    ],
  );
  const rebarPlaneBounds = useMemo<[number, number]>(() => {
    if (!displayRebarPlane || !allNodes.length) return [0, 0];
    const values = allNodes.map((node) =>
      dot(
        subtract(node.local ?? node.global, displayRebarPlane.origin),
        displayRebarPlane.normal,
      ),
    );
    return [Math.min(...values), Math.max(...values)];
  }, [allNodes, displayRebarPlane]);
  useEffect(() => {
    if (
      selectedSlicingPlaneId &&
      rebarPlanes.some((plane) => plane.id === selectedSlicingPlaneId)
    ) {
      return;
    }
    setSelectedSlicingPlaneId(rebarPlanes[0]?.id ?? null);
  }, [rebarPlanes, selectedSlicingPlaneId]);
  useEffect(() => {
    setSlicingPlaneOffset((current) =>
      Math.min(
        slicingPlaneBounds[1],
        Math.max(slicingPlaneBounds[0], current),
      ),
    );
  }, [slicingPlaneBounds]);
  const rebarSectionBookmarks = useMemo(
    () =>
      rebarRuns
        .filter((run) => run.planeId === activeRebarPlaneId)
        .flatMap((run) => [
          run.startOffset ?? run.start,
          run.endOffset ?? run.end,
        ])
        .filter(
          (value, index, values) =>
            values.findIndex(
              (candidate) => Math.abs(candidate - value) <= tolerance,
            ) === index,
        ),
    [activeRebarPlaneId, rebarRuns, tolerance],
  );
  const selectedRebarRun = useMemo(() => {
    if (selectedRebarRunIds.size !== 1) return null;
    const id = selectedRebarRunIds.values().next().value as string;
    return rebarRuns.find((run) => run.id === id) ?? null;
  }, [rebarRuns, selectedRebarRunIds]);
  const visibleRebarRuns = useMemo(() => {
    const visibility = new Map(
      rebarGroups.map((group) => [group.id, group.visible]),
    );
    return rebarRuns.filter(
      (run) => !run.groupId || visibility.get(run.groupId) !== false,
    );
  }, [rebarGroups, rebarRuns]);
  const editingRebarRun = useMemo(
    () =>
      editingRebarRunId
        ? rebarRuns.find((run) => run.id === editingRebarRunId) ?? null
        : null,
    [editingRebarRunId, rebarRuns],
  );
  const activeLappedWorkflow =
    rebarWorkflowKind === "lap" ||
    Boolean(editingRebarRun?.lappedFromRunId);

  const rebarGuideLines = useMemo(() => {
    if (
      !inchesPerModelUnit ||
      !displayRebarPlane ||
      rebarPhase === "idle" ||
      rebarPhase === "start" ||
      rebarPhase === "plane" ||
      rebarPhase === "plane-create"
    ) {
      return [];
    }
    const offset =
      rebarPhase === "path-end" ||
      rebarPhase === "path-review" ||
      rebarPhase === "spacing"
        ? rebarEnd
        : rebarStart;
    return createPlaneCoverOutlines(
      allNodes,
      elements,
      addScaled(displayRebarPlane.origin, displayRebarPlane.normal, offset),
      displayRebarPlane.normal,
      Math.max(rebarCoverOffsetInches, 0) / inchesPerModelUnit,
    ).map((points, index) => ({
      id: `cover-guide-2-${index}`,
      points,
      closed: true,
    }));
  }, [
    allNodes,
    elements,
    inchesPerModelUnit,
    displayRebarPlane,
    rebarEnd,
    rebarPhase,
    rebarStart,
    rebarCoverOffsetInches,
  ]);
  const rebarInnerGuideLines = useMemo(() => {
    if (
      !inchesPerModelUnit ||
      !displayRebarPlane ||
      rebarPhase === "idle" ||
      rebarPhase === "start" ||
      rebarPhase === "plane" ||
      rebarPhase === "plane-create"
    ) {
      return [];
    }
    const offset =
      rebarPhase === "path-end" ||
      rebarPhase === "path-review" ||
      rebarPhase === "spacing"
        ? rebarEnd
        : rebarStart;
    return createPlaneCoverOutlines(
      allNodes,
      elements,
      addScaled(displayRebarPlane.origin, displayRebarPlane.normal, offset),
      displayRebarPlane.normal,
      Math.max(rebarSecondaryOffsetInches, 0) / inchesPerModelUnit,
    ).map((points, index) => ({
      id: `cover-guide-4-${index}`,
      points,
      closed: true,
    }));
  }, [
    allNodes,
    elements,
    inchesPerModelUnit,
    displayRebarPlane,
    rebarEnd,
    rebarPhase,
    rebarStart,
    rebarSecondaryOffsetInches,
  ]);
  const resetWorkflow = useCallback((nodes: ModelNode[], bounds: Bounds, nextElements: ModelElement[] = []) => {
    setAllNodes(nodes);
    setElements(nextElements);
    setShowElementSkin(nextElements.length > 0);
    setElementSkinVolume(false);
    setElementEditMode(false);
    setSelectedElementIds(new Set());
    setScaleDefining(false);
    setScaleNodeIds([]);
    setInchesPerModelUnit(null);
    setRebarRuns([]);
    setRebarPlanes([]);
    setFavoriteRebarPlaneIds([]);
    setSlicingSubtab("planes");
    setSelectedSlicingPlaneId(null);
    setSlicingPlaneOffset(0);
    setSlicePins([]);
    setSelectedSlicePinId(null);
    setActiveSlicePinId(null);
    setShowRebarInSlicing(true);
    setViewpointCaptureRequest(null);
    setViewpointToApply(null);
    setRebarGroups([]);
    setCollapsedRebarGroupIds(new Set());
    setRenamingRebarPlaneId(null);
    setRebarCoverOffsetInches(2);
    setRebarSecondaryOffsetInches(4);
    setTopRebarPlaneDismissed(false);
    setActiveRebarPlaneId(null);
    setPreviewedRebarPlaneId(null);
    setRebarPlaneDraftNodeIds([]);
    setLineAndBar(false);
    setRebarPhase("idle");
    setRebarWorkflowKind("create");
    setRebarReferenceRunId(null);
    setEditingRebarRunId(null);
    setRebarLines([]);
    setPendingRebarLine(null);
    setRebarPathStart(null);
    setRebarPathEnd(null);
    setSelectedRebarRunIds(new Set());
    setRebarAxis("x");
    setRebarStart(bounds.x[0]);
    setRebarEnd(bounds.x[1]);
    setGlobalBounds(bounds);
    setFaces([]);
    setDefiningFaces(false);
    setSmartSelecting(false);
    setDraftNodeIds([]);
    setFittedFaceConfirmation(null);
    setSelectedFaceIds(new Set());
    setVolumeConfirmed(false);
    setConfirmWarning(false);
    setFloorFaceId(null);
    setXDirectionNodeIds([]);
    setBasis(null);
    setSlice(fullSlice(bounds));
    setActiveTab("volume");
    setSelectedNode(null);
  }, []);

  const loadText = useCallback(
    (text: string, name: string) => {
      try {
        const result = parseMctModel(text);
        const bounds = getBounds(result.nodes, false);
        resetWorkflow(result.nodes, bounds, result.elements);
        setFileName(name);
        setError(null);
        setStatus(
          `${result.nodes.length.toLocaleString()} nodes · ${result.elements.length.toLocaleString()} surface/solid elements parsed${
            result.skippedLines
              ? ` · ${result.skippedLines} lines skipped`
              : ""
          }`,
        );
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Unable to read file.",
        );
      }
    },
    [resetWorkflow],
  );

  useEffect(() => {
    let cancelled = false;
    void loadWorkspace()
      .then((saved) => {
        if (cancelled) return;
        if (!saved) {
          loadText(createSampleMct(), "Demo bridge lattice");
          return;
        }
        const restoredNodes: ModelNode[] = saved.nodes.map((node) => ({
          ...node,
          local: null,
        }));
        const nodes = saved.basis
          ? transformNodes(restoredNodes, saved.basis)
          : restoredNodes;
        const bounds = getBounds(restoredNodes, false);
        setAllNodes(nodes);
        setElements(saved.elements ?? []);
        setShowElementSkin(saved.showElementSkin ?? Boolean(saved.elements?.length));
        setElementSkinVolume(saved.elementSkinVolume ?? false);
        setInchesPerModelUnit(saved.inchesPerModelUnit ?? null);
        const migratedRebar = migrateRebarProject(
          saved.rebarRuns ?? [],
          saved.rebarPlanes,
          saved.basis,
        );
        setRebarRuns(
          migratedRebar.runs.map((run) =>
            reframeRebarRun(
              run,
              saved.basis,
              saved.basis,
            ),
          ),
        );
        setRebarPlanes(migratedRebar.planes);
        setFavoriteRebarPlaneIds(saved.favoriteRebarPlaneIds ?? []);
        setSlicePins(saved.slicePins ?? []);
        setShowRebarInSlicing(saved.showRebarInSlicing ?? true);
        setRebarGroups(saved.rebarGroups ?? []);
        setRebarCoverOffsetInches(saved.rebarCoverOffsetInches ?? 2);
        setRebarSecondaryOffsetInches(
          saved.rebarSecondaryOffsetInches ?? 4,
        );
        setTopRebarPlaneDismissed(saved.topRebarPlaneDismissed ?? false);
        setActiveRebarPlaneId(
          migratedRebar.planes[0]?.id ?? null,
        );
        setPreviewedRebarPlaneId(null);
        setShowConcreteSkin(saved.showConcreteSkin ?? true);
        setLineAndBar(saved.lineAndBar ?? false);
        setShowRebarLabels(saved.showRebarLabels ?? false);
        setFileName(saved.fileName);
        setGlobalBounds(bounds);
        setFaces(saved.faces);
        setActiveTab(saved.activeTab);
        setDefiningFaces(saved.definingFaces);
        setSmartSelecting(saved.smartSelecting ?? false);
        setSmartVariant(saved.smartVariant ?? "classic");
        setSmartAxis(saved.smartAxis ?? "x");
        setDraftNodeIds(saved.draftNodeIds);
        setSelectedFaceIds(new Set(saved.selectedFaceIds));
        setVolumeConfirmed(saved.volumeConfirmed);
        setFloorFaceId(saved.floorFaceId);
        setXDirectionNodeIds(saved.xDirectionNodeIds);
        setBasis(saved.basis);
        setSlice(saved.slice);
        setSelectedNode(
          nodes.find((node) => node.id === saved.selectedNodeId) ?? null,
        );
        setStatus(
          `${nodes.length.toLocaleString()} nodes restored from this browser.`,
        );
      })
      .catch(() => {
        if (!cancelled) {
          loadText(createSampleMct(), "Demo bridge lattice");
          setError("The saved workspace could not be restored.");
        }
      })
      .finally(() => {
        if (!cancelled) setWorkspaceReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadText]);

  useEffect(() => {
    if (!workspaceReady || !allNodes.length) return;
    const timer = window.setTimeout(() => {
      const workspace: SavedWorkspace = {
        version: 1,
        fileName,
        nodes: allNodes.map(({ id, global }) => ({ id, global })),
        faces,
        activeTab,
        definingFaces,
        smartSelecting,
        smartVariant,
        smartAxis,
        draftNodeIds,
        selectedFaceIds: [...selectedFaceIds],
        volumeConfirmed,
        floorFaceId,
        xDirectionNodeIds,
        basis,
        slice,
        selectedNodeId: selectedNode?.id ?? null,
        elements,
        showElementSkin,
        elementSkinVolume,
        inchesPerModelUnit,
        rebarRuns,
        rebarPlanes,
        rebarGroups,
        rebarCoverOffsetInches,
        rebarSecondaryOffsetInches,
        topRebarPlaneDismissed,
        showConcreteSkin,
        lineAndBar,
        showRebarLabels,
        favoriteRebarPlaneIds,
        slicePins,
        showRebarInSlicing,
      };
      void saveWorkspace(workspace).catch(() => {
        setError(
          "This browser could not save the workspace. Its local storage may be full or disabled.",
        );
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    activeTab,
    allNodes,
    basis,
    definingFaces,
    draftNodeIds,
    faces,
    elements,
    elementSkinVolume,
    inchesPerModelUnit,
    fileName,
    floorFaceId,
    selectedFaceIds,
    selectedNode?.id,
    rebarRuns,
    rebarPlanes,
    favoriteRebarPlaneIds,
    slicePins,
    showRebarInSlicing,
    rebarGroups,
    rebarCoverOffsetInches,
    rebarSecondaryOffsetInches,
    topRebarPlaneDismissed,
    smartSelecting,
    smartVariant,
    smartAxis,
    slice,
    showElementSkin,
    showConcreteSkin,
    lineAndBar,
    showRebarLabels,
    volumeConfirmed,
    workspaceReady,
    xDirectionNodeIds,
  ]);

  const loadFile = async (file: File) => {
    if (file.name.toLowerCase().endsWith(".mctlab.json")) {
      await importProject(file);
      return;
    }
    if (!file.name.toLowerCase().endsWith(".mct")) {
      setError("Choose a MIDAS Civil .mct or MCT Section Lab project file.");
      return;
    }
    setStatus("Reading file…");
    loadText(await file.text(), file.name);
  };

  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportProject = () => {
    const workspace: SavedWorkspace = {
      version: 1,
      fileName,
      nodes: allNodes.map(({ id, global }) => ({ id, global })),
      faces,
      activeTab,
      definingFaces: false,
      smartSelecting: false,
      smartVariant,
      smartAxis,
      draftNodeIds: [],
      selectedFaceIds: [],
      volumeConfirmed,
      floorFaceId,
      xDirectionNodeIds,
      basis,
      slice,
      selectedNodeId: selectedNode?.id ?? null,
      elements,
      showElementSkin,
      elementSkinVolume,
      inchesPerModelUnit,
      rebarRuns,
      rebarPlanes,
      rebarGroups,
      rebarCoverOffsetInches,
      rebarSecondaryOffsetInches,
      topRebarPlaneDismissed,
      showConcreteSkin,
      lineAndBar,
      showRebarLabels,
      favoriteRebarPlaneIds,
      slicePins,
      showRebarInSlicing,
    };
    downloadBlob(
      new Blob(
        [
          JSON.stringify(
            {
              format: "mct-section-lab-project",
              version: 1,
              savedAt: new Date().toISOString(),
              workspace,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
      `${fileName.replace(/\.[^.]+$/, "") || "mct-project"}.mctlab.json`,
    );
    setStatus("Project exported with geometry, planes, and reinforcement.");
  };

  async function importProject(file: File) {
    try {
      const payload = JSON.parse(await file.text()) as {
        format?: string;
        workspace?: SavedWorkspace;
      };
      const saved = payload.workspace;
      if (
        payload.format !== "mct-section-lab-project" ||
        !saved ||
        !Array.isArray(saved.nodes)
      ) {
        throw new Error("This is not an MCT Section Lab project file.");
      }
      const restoredNodes: ModelNode[] = saved.nodes.map((node) => ({
        ...node,
        local: null,
      }));
      const nodes = saved.basis
        ? transformNodes(restoredNodes, saved.basis)
        : restoredNodes;
      const migrated = migrateRebarProject(
        saved.rebarRuns ?? [],
        saved.rebarPlanes,
        saved.basis,
      );
      setAllNodes(nodes);
      setElements(saved.elements ?? []);
      setShowElementSkin(saved.showElementSkin ?? Boolean(saved.elements?.length));
      setElementSkinVolume(saved.elementSkinVolume ?? false);
      setInchesPerModelUnit(saved.inchesPerModelUnit ?? null);
      setRebarRuns(
        migrated.runs.map((run) =>
          reframeRebarRun(run, saved.basis, saved.basis),
        ),
      );
      setRebarPlanes(migrated.planes);
      setFavoriteRebarPlaneIds(saved.favoriteRebarPlaneIds ?? []);
      setSlicePins(saved.slicePins ?? []);
      setShowRebarInSlicing(saved.showRebarInSlicing ?? true);
      setRebarGroups(saved.rebarGroups ?? []);
      setRebarCoverOffsetInches(saved.rebarCoverOffsetInches ?? 2);
      setRebarSecondaryOffsetInches(
        saved.rebarSecondaryOffsetInches ?? 4,
      );
      setTopRebarPlaneDismissed(saved.topRebarPlaneDismissed ?? false);
      setActiveRebarPlaneId(migrated.planes[0]?.id ?? null);
      setPreviewedRebarPlaneId(null);
      setShowConcreteSkin(saved.showConcreteSkin ?? true);
      setLineAndBar(saved.lineAndBar ?? false);
      setShowRebarLabels(saved.showRebarLabels ?? false);
      setFileName(saved.fileName);
      setGlobalBounds(getBounds(restoredNodes, false));
      setFaces(saved.faces ?? []);
      setActiveTab(saved.activeTab ?? "volume");
      setDefiningFaces(false);
      setSmartSelecting(false);
      setDraftNodeIds([]);
      setSelectedFaceIds(new Set());
      setVolumeConfirmed(saved.volumeConfirmed ?? false);
      setFloorFaceId(saved.floorFaceId ?? null);
      setXDirectionNodeIds(saved.xDirectionNodeIds ?? []);
      setBasis(saved.basis ?? null);
      setSlice(saved.slice ?? fullSlice(getBounds(nodes, Boolean(saved.basis))));
      setSelectedNode(
        nodes.find((node) => node.id === saved.selectedNodeId) ?? null,
      );
      setRebarPhase("idle");
      setSelectedRebarRunIds(new Set());
      setStatus("Project imported with geometry, planes, and reinforcement.");
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not import project.",
      );
    }
  }

  const exportRebarQuantities = () => {
    if (!inchesPerModelUnit || !rebarRuns.length) return;
    const escapeXml = (value: string) =>
      value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    const rows = rebarRuns.map((run) => {
      const lines = run.objectLines ?? run.lines;
      const lengthModelUnits = lines.reduce(
        (total, line) =>
          total +
          line.points.slice(1).reduce((lineTotal, point, index) => {
            const previous = line.points[index];
            return (
              lineTotal +
              Math.hypot(
                point.x - previous.x,
                point.y - previous.y,
                point.z - previous.z,
              )
            );
          }, 0),
        0,
      );
      const lengthFeet = (lengthModelUnits * inchesPerModelUnit) / 12;
      return {
        name: run.name,
        quantity: run.positions.length,
        barNumber: run.barNumber ?? "5",
        lengthFeet,
        totalFeet: lengthFeet * run.positions.length,
      };
    });
    const totals = new Map<string, number>();
    rows.forEach((row) =>
      totals.set(
        row.barNumber,
        (totals.get(row.barNumber) ?? 0) + row.totalFeet,
      ),
    );
    const cell = (type: "String" | "Number", value: string | number) =>
      `<Cell><Data ss:Type="${type}">${type === "String" ? escapeXml(String(value)) : value}</Data></Cell>`;
    const header = (values: string[]) =>
      `<Row ss:StyleID="Header">${values.map((value) => cell("String", value)).join("")}</Row>`;
    const scheduleRows = rows
      .map(
        (row) =>
          `<Row>${cell("String", row.name)}${cell("Number", row.quantity)}${cell("String", `#${row.barNumber}`)}${cell("Number", Number(row.lengthFeet.toFixed(3)))}${cell("Number", Number(row.totalFeet.toFixed(3)))}</Row>`,
      )
      .join("");
    const totalRows = [...totals.entries()]
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(
        ([barNumber, total]) =>
          `<Row>${cell("String", `#${barNumber}`)}${cell("Number", Number(total.toFixed(3)))}</Row>`,
      )
      .join("");
    const workbook = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles><Style ss:ID="Default"><Alignment ss:Vertical="Center"/><Font ss:FontName="Aptos" ss:Size="10"/></Style><Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#155E75" ss:Pattern="Solid"/></Style></Styles>
<Worksheet ss:Name="Bar Schedule"><Table><Column ss:Width="180"/><Column ss:Width="65"/><Column ss:Width="65"/><Column ss:Width="90"/><Column ss:Width="95"/>${header(["Bar Name", "Quantity", "Bar Number", "Length Each (ft)", "Total Length (ft)"])}${scheduleRows}</Table></Worksheet>
<Worksheet ss:Name="Totals by Bar Number"><Table><Column ss:Width="100"/><Column ss:Width="140"/>${header(["Bar Number", "Total Length (ft)"])}${totalRows}</Table></Worksheet>
</Workbook>`;
    downloadBlob(
      new Blob([workbook], { type: "application/vnd.ms-excel" }),
      `${fileName.replace(/\.[^.]+$/, "") || "rebar"}-quantities.xls`,
    );
    setStatus("Excel rebar quantity workbook exported.");
  };

  const commitDraftFace = useCallback(() => {
    if (!globalBounds || draftNodeIds.length < 3) {
      setError("Select at least three nodes, then press Space.");
      return;
    }

    try {
      const nodeMap = new Map(allNodes.map((node) => [node.id, node]));
      const selected = draftNodeIds.map((id) => {
        const node = nodeMap.get(id);
        if (!node) throw new Error(`Node ${id} is no longer available.`);
        return { id, point: node.global };
      });
      const nextNumber = faces.length + 1;
      const id = `face-${crypto.randomUUID()}`;
      const label = `Face ${nextNumber}`;
      const cloudCenter = centroid(allNodes.map((node) => node.global));
      const signature = draftNodeIds.join(",");
      let face: VolumeFace;
      try {
        face = createFace(
          id,
          label,
          selected,
          cloudCenter,
          tolerance,
        );
      } catch (caught) {
        const message =
          caught instanceof Error ? caught.message : "Could not create face.";
        if (!message.includes("not coplanar")) throw caught;
        if (fittedFaceConfirmation !== signature) {
          setFittedFaceConfirmation(signature);
          setError(
            "These boundary nodes are not coplanar. Press Space again to fit and accept this face.",
          );
          setStatus(
            "Non-coplanar boundary detected · Space again accepts a fitted plane.",
          );
          return;
        }
        face = createFittedFace(id, label, selected, cloudCenter);
      }
      setFaces((current) => [...current, face]);
      setDraftNodeIds([]);
      setFittedFaceConfirmation(null);
      setVolumeConfirmed(false);
      setStatus(
        face.fitted
          ? `${face.label} fitted through the selected nodes. It will knit to adjacent planes when confirmed.`
          : `${face.label} created. Select the next face.`,
      );
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not create face.",
      );
    }
  }, [
    allNodes,
    draftNodeIds,
    faces.length,
    fittedFaceConfirmation,
    globalBounds,
    tolerance,
  ]);

  const removeLastFace = useCallback(() => {
    const removed = faces.at(-1);
    if (!removed) return;
    setFaces((current) => current.slice(0, -1));
    setSelectedFaceIds((current) => {
      const next = new Set(current);
      next.delete(removed.id);
      return next;
    });
    setVolumeConfirmed(false);
    if (floorFaceId === removed.id) {
      setFloorFaceId(null);
      setXDirectionNodeIds([]);
      reframeRebar(basis, null);
      setBasis(null);
      setAllNodes((current) =>
        current.map((node) => ({ ...node, local: null })),
      );
      if (globalBounds) setSlice(fullSlice(globalBounds));
    }
    setStatus(`${removed.label} removed.`);
  }, [basis, faces, floorFaceId, globalBounds, reframeRebar]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        activeTab !== "volume" ||
        target?.matches("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      if (event.code === "Space" && definingFaces) {
        event.preventDefault();
        if (!event.repeat) commitDraftFace();
      }
      if (event.code === "Backspace") {
        event.preventDefault();
        if (draftNodeIds.length) {
          setDraftNodeIds((current) => current.slice(0, -1));
          setFittedFaceConfirmation(null);
          setStatus("Last selected point removed.");
        } else if (!event.repeat) {
          removeLastFace();
        }
      }
      if (
        event.code === "Escape" &&
        definingFaces
      ) {
        setDraftNodeIds([]);
        setFittedFaceConfirmation(null);
        setStatus("Current face selection cleared.");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeTab,
    commitDraftFace,
    definingFaces,
    draftNodeIds.length,
    removeLastFace,
  ]);

  const smartPreviewFace = useMemo(() => {
    if (!smartSelecting || !hover) return null;
    try {
      if (smartVariant === "axis") {
        return axisSliceFaceFromSeed(
          allNodes,
          hover.node.id,
          tolerance,
          smartAxis,
          basis,
        );
      }
      if (smartVariant === "local") {
        return localPatchFaceFromSeed(allNodes, hover.node.id, tolerance);
      }
      if (smartVariant === "full") {
        return fullPlaneFaceFromSeed(allNodes, hover.node.id, tolerance);
      }
      return smartFaceFromSeed(allNodes, hover.node.id, tolerance);
    } catch {
      return null;
    }
  }, [
    allNodes,
    basis,
    hover?.node.id,
    smartAxis,
    smartSelecting,
    smartVariant,
    tolerance,
  ]);

  const applyCoordinateSystem = (
    nextDirectionNodeIds: number[],
    floorId = floorFaceId,
  ) => {
    if (!floorId || nextDirectionNodeIds.length !== 2) return;
    const floor = faces.find((face) => face.id === floorId);
    const first = allNodes.find((node) => node.id === nextDirectionNodeIds[0]);
    const second = allNodes.find((node) => node.id === nextDirectionNodeIds[1]);
    if (!floor || !first || !second) return;

    try {
      const nextBasis = createBasisFromFloor(
        first.global,
        second.global,
        floor.plane,
      );
      const transformed = transformNodes(allNodes, nextBasis);
      const bounds = getBounds(transformed);
      reframeRebar(basis, nextBasis);
      setAllNodes(transformed);
      setBasis(nextBasis);
      setSlice(fullSlice(bounds));
      setStatus("Floor aligned to XY and local X direction applied.");
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not apply the coordinate system.",
      );
    }
  };

  const handleNodePick = (nodeId: number) => {
    const node = allNodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    setSelectedNode(node);

    if (
      (activeTab === "rebar" || activeTab === "slicing") &&
      rebarPhase === "plane-create"
    ) {
      if (rebarPlaneDraftNodeIds.includes(nodeId)) return;
      const next = [...rebarPlaneDraftNodeIds, nodeId];
      if (next.length < 2) {
        setRebarPlaneDraftNodeIds(next);
        setStatus("Plane definition: select the second node.");
        return;
      }
      const first = allNodes.find((candidate) => candidate.id === next[0]);
      const second = allNodes.find((candidate) => candidate.id === next[1]);
      if (!first || !second) return;
      try {
        const vertical = normalize(
          basis?.zAxis ?? { x: 0, y: 0, z: 1 },
        );
        const rawDirection = subtract(second.global, first.global);
        const horizontal = subtract(
          rawDirection,
          {
            x: vertical.x * dot(rawDirection, vertical),
            y: vertical.y * dot(rawDirection, vertical),
            z: vertical.z * dot(rawDirection, vertical),
          },
        );
        const objectNormal = normalize(cross(normalize(horizontal), vertical));
        const plane: RebarPlane = {
          id: `rebar-plane-${crypto.randomUUID()}`,
          name: `Plane ${rebarPlanes.length + 1}`,
          color:
            PLANE_COLORS[
              (rebarPlanes.length +
                Math.floor(Math.random() * PLANE_COLORS.length)) %
                PLANE_COLORS.length
            ],
          objectOrigin: { ...first.global },
          objectNormal,
          nodeIds: next,
        };
        setRebarPlanes((current) => [...current, plane]);
        setActiveRebarPlaneId(plane.id);
        setPreviewedRebarPlaneId(plane.id);
        setRebarPlaneDraftNodeIds([]);
        setRebarStart(0);
        setRebarEnd(0);
        if (rebarPlaneReturnPhase === "plane") {
          setRebarPhase("start");
          setStatus(`${plane.name} created. Choose the start section.`);
        } else {
          setRebarPhase("idle");
          setStatus(`${plane.name} created and added to the plane manager.`);
        }
        setError(null);
      } catch (caught) {
        setRebarPlaneDraftNodeIds([]);
        setError(
          caught instanceof Error
            ? caught.message
            : "Those nodes could not define a vertical plane.",
        );
      }
      return;
    }

    if (activeTab === "coordinates" && scaleDefining) {
      setScaleNodeIds((current) => {
        if (current.includes(nodeId)) return current;
        return current.length >= 2 ? [nodeId] : [...current, nodeId];
      });
      setStatus("Scale definition: select two nodes, then enter their distance.");
      return;
    }

    if (activeTab === "volume" && smartSelecting) {
      try {
        let candidate = smartPreviewFace;
        if (hover?.node.id !== nodeId || !candidate) {
          candidate =
            smartVariant === "axis"
              ? axisSliceFaceFromSeed(
                  allNodes,
                  nodeId,
                  tolerance,
                  smartAxis,
                  basis,
                )
              : smartVariant === "local"
                ? localPatchFaceFromSeed(allNodes, nodeId, tolerance)
                : smartVariant === "full"
                  ? fullPlaneFaceFromSeed(allNodes, nodeId, tolerance)
                  : smartFaceFromSeed(allNodes, nodeId, tolerance);
        }
        const face: VolumeFace = {
          ...candidate,
          id: `smart-${crypto.randomUUID()}`,
          label: `Face ${faces.length + 1}`,
        };
        setFaces((current) => [...current, face]);
        setVolumeConfirmed(false);
        setStatus(`${face.label} added by Smart Select. Hover for the next.`);
        setError(null);
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "No planar face was found here.",
        );
      }
      return;
    }

    if (activeTab === "volume" && definingFaces) {
      setFittedFaceConfirmation(null);
      setDraftNodeIds((current) => {
        if (current.includes(nodeId)) {
          setError(
            "That point is already on this boundary. Use Backspace to step backward.",
          );
          return current;
        }
        setError(null);
        return [...current, nodeId];
      });
      return;
    }

    if (
      activeTab === "coordinates" &&
      floorFaceId &&
      xDirectionNodeIds.length < 2
    ) {
      if (xDirectionNodeIds.includes(nodeId)) return;
      const next = [...xDirectionNodeIds, nodeId];
      setXDirectionNodeIds(next);
      setStatus(
        next.length === 1
          ? "Select the second node for positive X."
          : "Applying local coordinate system…",
      );
      if (next.length === 2) applyCoordinateSystem(next);
    }
  };

  const applyDefinedScale = () => {
    if (scaleNodeIds.length !== 2 || scaleDistanceInches <= 0) return;
    const first = allNodes.find((node) => node.id === scaleNodeIds[0]);
    const second = allNodes.find((node) => node.id === scaleNodeIds[1]);
    if (!first || !second) return;
    const delta = subtract(second.global, first.global);
    const modelDistance = Math.hypot(delta.x, delta.y, delta.z);
    if (modelDistance <= 1e-12) {
      setError("The selected scale nodes occupy the same point.");
      return;
    }
    setInchesPerModelUnit(scaleDistanceInches / modelDistance);
    setScaleDefining(false);
    setStatus(
      `Scale defined: ${scaleDistanceInches} in between nodes ${first.id} and ${second.id}.`,
    );
  };

  const beginCreateRebar = () => {
    setRebarWorkflowKind("create");
    setRebarReferenceRunId(null);
    setEditingRebarRunId(null);
    setRebarLines([]);
    setPendingRebarLine(null);
    setRebarPathStart(null);
    setRebarPathEnd(null);
    setRebarPathPoints([]);
    setRebarBarNumber("5");
    if (activeRebarPlaneId) {
      chooseRebarPlane(activeRebarPlaneId);
      setStatus("Selected plane retained. Choose the start section.");
    } else {
      setRebarPhase("plane");
      setStatus("Choose a drawing plane or add a new one.");
    }
  };

  const chooseRebarPlane = (planeId: string) => {
    const previous = [...rebarRuns]
      .reverse()
      .find((run) => run.planeId === planeId);
    setActiveRebarPlaneId(planeId);
    setPreviewedRebarPlaneId(planeId);
    setRebarStart(previous?.startOffset ?? 0);
    setRebarEnd(previous?.endOffset ?? previous?.startOffset ?? 0);
    setRebarPhase("start");
    setStatus(
      previous
        ? `Plane selected. Last-used sections for ${previous.name} restored.`
        : "Plane selected. Choose the start section.",
    );
  };

  const selectRebarPlane = (planeId: string) => {
    if (editingRebarRunId && planeId !== activeRebarPlaneId) {
      setStatus("A bar's drawing plane is locked while editing.");
      return;
    }
    if (
      activeLappedWorkflow &&
      rebarPhase !== "idle" &&
      planeId !== activeRebarPlaneId
    ) {
      setStatus("Lapped bars must remain on the source bar's plane.");
      return;
    }
    if (rebarPhase === "plane") {
      chooseRebarPlane(planeId);
      return;
    }
    setActiveRebarPlaneId(planeId);
    setPreviewedRebarPlaneId(planeId);
  };

  const deleteActiveRebarPlane = () => {
    if (!activeRebarPlaneId) return;
    const plane = rebarPlanes.find(
      (candidate) => candidate.id === activeRebarPlaneId,
    );
    if (!plane) return;
    const associated = rebarRuns.filter(
      (run) => run.planeId === activeRebarPlaneId,
    );
    if (
      associated.length &&
      !window.confirm(
        `${plane.name} is associated with ${associated.length} bar run${
          associated.length === 1 ? "" : "s"
        }. Delete the plane anyway? The bars will remain in place.`,
      )
    ) {
      return;
    }
    const nextPlanes = rebarPlanes.filter(
      (candidate) => candidate.id !== activeRebarPlaneId,
    );
    setRebarPlanes(nextPlanes);
    setFavoriteRebarPlaneIds((current) =>
      current.filter((id) => id !== activeRebarPlaneId),
    );
    setSlicePins((current) =>
      current.filter((pin) => pin.planeId !== activeRebarPlaneId),
    );
    setActiveSlicePinId((current) =>
      slicePins.some(
        (pin) => pin.id === current && pin.planeId === activeRebarPlaneId,
      )
        ? null
        : current,
    );
    if (associated.length) {
      setRebarRuns((current) =>
        current.map((run) =>
          run.planeId === activeRebarPlaneId
            ? { ...run, planeId: null }
            : run,
        ),
      );
    }
    if (activeRebarPlaneId === "auto-top-horizontal") {
      setTopRebarPlaneDismissed(true);
    }
    setActiveRebarPlaneId(nextPlanes[0]?.id ?? null);
    setPreviewedRebarPlaneId((current) =>
      current === activeRebarPlaneId ? null : current,
    );
    setStatus(
      associated.length
        ? `${plane.name} deleted. ${associated.length} associated bar run${
            associated.length === 1 ? " remains" : "s remain"
          } unchanged.`
        : `${plane.name} deleted.`,
    );
  };

  const selectSlicingPlane = (planeId: string, preserveOffset = false) => {
    const plane = rebarPlanes.find((candidate) => candidate.id === planeId);
    if (!plane) return;
    setSelectedSlicingPlaneId(planeId);
    setActiveSlicePinId(null);
    if (!preserveOffset) {
      const origin = reframePoint(plane.objectOrigin, null, basis);
      const normal = normalize(
        reframeDirection(plane.objectNormal, null, basis),
      );
      const values = allNodes.map((node) =>
        dot(subtract(node.local ?? node.global, origin), normal),
      );
      setSlicingPlaneOffset(values.length ? Math.max(...values) : 0);
    }
  };

  const beginSlicingPlaneCreation = () => {
    setRebarPlaneReturnPhase("idle");
    setRebarPlaneDraftNodeIds([]);
    setRebarPhase("plane-create");
    setStatus("New slicing plane: select two nodes.");
  };

  const toggleFavoritePlane = (planeId: string) => {
    setFavoriteRebarPlaneIds((current) =>
      current.includes(planeId)
        ? current.filter((id) => id !== planeId)
        : [...current, planeId],
    );
  };

  const createSlicePin = () => {
    if (!selectedSlicingPlaneId) return;
    const pin: SlicePin = {
      id: `slice-pin-${crypto.randomUUID()}`,
      name: `Pin ${slicePins.length + 1}`,
      planeId: selectedSlicingPlaneId,
      offset: slicingPlaneOffset,
    };
    setSlicePins((current) => [...current, pin]);
    setSelectedSlicePinId(pin.id);
    setActiveSlicePinId(pin.id);
    setStatus(`${pin.name} saved at this slice.`);
  };

  const activateSlicePin = (pin: SlicePin) => {
    setSelectedSlicePinId(pin.id);
    setSelectedSlicingPlaneId(pin.planeId);
    setSlicingPlaneOffset(pin.offset);
    setActiveSlicePinId(pin.id);
    if (pin.viewpoint) {
      setViewpointToApply({
        pinId: pin.id,
        nonce: Date.now(),
        viewpoint: pin.viewpoint,
      });
    }
  };

  const handleViewpointCaptured = useCallback(
    (pinId: string, viewpoint: CameraViewpoint) => {
      setSlicePins((current) =>
        current.map((pin) =>
          pin.id === pinId ? { ...pin, viewpoint } : pin,
        ),
      );
      setViewpointCaptureRequest(null);
      setStatus("Viewpoint saved with the selected pin.");
    },
    [],
  );

  const saveSelectedPinViewpoint = () => {
    if (!selectedSlicePin) return;
    activateSlicePin(selectedSlicePin);
    setViewpointCaptureRequest({
      pinId: selectedSlicePin.id,
      nonce: Date.now(),
    });
  };

  const renameSelectedPin = () => {
    if (!selectedSlicePin) return;
    const name = window.prompt("Rename slice pin", selectedSlicePin.name)?.trim();
    if (!name) return;
    setSlicePins((current) =>
      current.map((pin) =>
        pin.id === selectedSlicePin.id ? { ...pin, name } : pin,
      ),
    );
  };

  const deleteSelectedPin = () => {
    if (!selectedSlicePin) return;
    setSlicePins((current) =>
      current.filter((pin) => pin.id !== selectedSlicePin.id),
    );
    setActiveSlicePinId((current) =>
      current === selectedSlicePin.id ? null : current,
    );
    setSelectedSlicePinId(null);
  };

  const addRebarGroup = () => {
    const name = window.prompt("Name this rebar group:");
    if (!name?.trim()) return;
    const group: RebarGroup = {
      id: `rebar-group-${crypto.randomUUID()}`,
      name: name.trim(),
      visible: true,
    };
    setRebarGroups((current) => [...current, group]);
    setStatus(`${group.name} added. Drag bar runs into the folder.`);
  };

  const moveRebarRunToGroup = (
    runId: string,
    groupId: string | undefined,
  ) => {
    setRebarRuns((current) =>
      current.map((run) =>
        run.id === runId ? { ...run, groupId } : run,
      ),
    );
  };

  const beginLappedRebar = (source: RebarRun) => {
    if (
      !source.planeId ||
      !rebarPlanes.some((plane) => plane.id === source.planeId)
    ) {
      setError(
        `${source.name}'s drawing plane was deleted. The bar remains visible, but a lapped bar requires an existing source plane.`,
      );
      return;
    }
    setRebarWorkflowKind("lap");
    setRebarReferenceRunId(source.id);
    setEditingRebarRunId(null);
    setActiveRebarPlaneId(source.planeId ?? null);
    setRebarAxis(source.axis);
    setRebarStart(source.startOffset ?? source.start);
    setRebarEnd(source.endOffset ?? source.end);
    setRebarSpacing(source.spacingInches);
    setRebarName(`${source.name} Lap`);
    setRebarBarNumber(source.barNumber ?? "5");
    setRebarLines([]);
    setPendingRebarLine(null);
    setRebarPathStart(null);
    setRebarPathEnd(null);
    setRebarPathPoints([]);
    setSelectedRebarRunIds(new Set([source.id]));
    setRebarPhase("start");
    setStatus(
      `${source.name} selected. Its start and end sections are suggested.`,
    );
  };

  const beginEditRebar = (run: RebarRun) => {
    setRebarWorkflowKind("edit");
    setRebarReferenceRunId(run.lappedFromRunId ?? null);
    setEditingRebarRunId(run.id);
    setActiveRebarPlaneId(run.planeId ?? null);
    setRebarAxis(run.axis);
    setRebarStart(run.startOffset ?? run.start);
    setRebarEnd(run.endOffset ?? run.end);
    setRebarSpacing(run.spacingInches);
    setRebarName(run.name);
    setRebarBarNumber(run.barNumber ?? "5");
    setRebarLines([]);
    setPendingRebarLine(
      run.lines[0]
        ? {
            ...run.lines[0],
            points: run.lines[0].points.map((point) => ({ ...point })),
          }
        : null,
    );
    setRebarPathStart(run.pathStart ?? null);
    setRebarPathEnd(run.pathEnd ?? null);
    setRebarPathPoints(
      run.pathPoints ??
        (run.pathStart && run.pathEnd ? [run.pathStart, run.pathEnd] : []),
    );
    setSelectedRebarRunIds(new Set([run.id]));
    setRebarPhase("start");
    setStatus(`Editing ${run.name}. Confirm or update each step.`);
  };

  const confirmRebarStartSection = () => {
    if (!displayRebarPlane) {
      setError("Choose a drawing plane first.");
      return;
    }
    const editingRun = editingRebarRunId
      ? rebarRuns.find((run) => run.id === editingRebarRunId)
      : null;
    const sourceLine = pendingRebarLine ?? editingRun?.lines[0] ?? null;
    setPendingRebarLine(
      sourceLine
        ? {
            ...sourceLine,
            points: sourceLine.points.map((point) =>
              projectToPlaneOffset(
                point,
                displayRebarPlane.origin,
                displayRebarPlane.normal,
                rebarStart,
              ),
            ),
          }
        : {
            id: `line-${crypto.randomUUID()}`,
            points: [],
            closed: false,
          },
    );
    if (editingRun && rebarPathStart) {
      const projectedStart = projectToPlaneOffset(
        rebarPathStart,
        displayRebarPlane.origin,
        displayRebarPlane.normal,
        rebarStart,
      );
      setRebarPathStart(projectedStart);
      setRebarPathPoints((current) =>
        current.length ? [projectedStart, ...current.slice(1)] : current,
      );
    }
    setRebarLines([]);
    setRebarPhase("lines");
    setStatus(
      editingRun
        ? "Existing shape loaded. Keep it, extend it, or replace it."
        : "Draw the bar shape on the confirmed section.",
    );
  };

  const pickRebarWorkflowPoint = (point: Vec3) => {
    if (pendingRebarLine) {
      setPendingRebarLine((current) => {
        if (!current) return current;
        const previous = current.points[current.points.length - 1];
        if (
          previous &&
          Math.hypot(
            previous.x - point.x,
            previous.y - point.y,
            previous.z - point.z,
          ) < tolerance
        ) {
          return current;
        }
        return { ...current, points: [...current.points, point] };
      });
      return;
    }
    if (rebarPhase === "path-start") {
      setRebarPathStart(point);
      setRebarPathPoints([point]);
      setRebarPhase("end");
      setStatus("Start anchor selected. Choose the end section.");
      return;
    }
    if (rebarPhase === "path-end") {
      const endpoint = displayRebarPlane
        ? projectToPlaneOffset(
            point,
            displayRebarPlane.origin,
            displayRebarPlane.normal,
            rebarEnd,
          )
        : point;
      setRebarPathEnd(endpoint);
      setRebarPathPoints((current) => [
        ...(current.length
          ? current
          : rebarPathStart
            ? [rebarPathStart]
            : []),
        endpoint,
      ]);
      setRebarPhase("path-review");
      setStatus("Keypoint added. Add another depth and anchor, or complete the path.");
    }
  };

  const finishRebarRun = (
    pathStartOverride?: Vec3,
    pathEndOverride?: Vec3,
  ) => {
    const pathStart = pathStartOverride ?? rebarPathPoints[0] ?? rebarPathStart;
    const pathEnd =
      pathEndOverride ??
      rebarPathPoints[rebarPathPoints.length - 1] ??
      rebarPathEnd;
    const pathPoints =
      pathStartOverride && pathEndOverride
        ? [pathStartOverride, pathEndOverride]
        : rebarPathPoints.length >= 2
          ? rebarPathPoints
          : pathStart && pathEnd
            ? [pathStart, pathEnd]
            : [];
    if (
      !inchesPerModelUnit ||
      !rebarLines.length ||
      !pathStart ||
      !pathEnd
    ) {
      return;
    }
    const pathDelta = subtract(pathEnd, pathStart);
    const chordLength =
      Math.hypot(pathDelta.x, pathDelta.y, pathDelta.z) || 1;
    const pathLength = pathPoints.slice(1).reduce((total, point, index) => {
      const previous = pathPoints[index];
      return (
        total +
        Math.hypot(
          point.x - previous.x,
          point.y - previous.y,
          point.z - previous.z,
        )
      );
    }, 0);
    if (pathLength <= 1e-12) {
      setError("The rebar spacing path needs a measurable length.");
      return;
    }
    const distributionVector = {
      x: pathDelta.x / chordLength,
      y: pathDelta.y / chordLength,
      z: pathDelta.z / chordLength,
    };
    const editingRun = editingRebarRunId
      ? rebarRuns.find((candidate) => candidate.id === editingRebarRunId)
      : null;
    const referenceRun = rebarReferenceRunId
      ? rebarRuns.find((candidate) => candidate.id === rebarReferenceRunId)
      : null;
    const isLapped =
      rebarWorkflowKind === "lap" || Boolean(editingRun?.lappedFromRunId);
    const spacing = isLapped
      ? referenceRun?.spacingInches ?? editingRun?.spacingInches ?? rebarSpacing
      : rebarSpacing;
    const run: RebarRun = {
      id: editingRun?.id ?? `rebar-${crypto.randomUUID()}`,
      name: rebarName.trim() || `Bar Run ${rebarRuns.length + 1}`,
      color: editingRun?.color ?? leastUsedRebarColor(rebarRuns),
      barNumber: rebarBarNumber.trim().replace(/^#/, "") || "5",
      planeId: activeRebarPlaneId ?? undefined,
      startOffset: rebarStart,
      endOffset: rebarEnd,
      axis: rebarAxis,
      start: rebarStart,
      end: rebarEnd,
      distributionMode: "path",
      distributionVector,
      pathStart,
      pathEnd,
      pathPoints,
      objectLines: rebarLines.map((line) =>
        reframeRebarLine(line, basis, null),
      ),
      objectPathStart: reframePoint(pathStart, basis, null),
      objectPathEnd: reframePoint(pathEnd, basis, null),
      objectPathPoints: pathPoints.map((point) =>
        reframePoint(point, basis, null),
      ),
      spacingInches: spacing,
      lappedFromRunId: isLapped
        ? referenceRun?.id ?? editingRun?.lappedFromRunId
        : undefined,
      lapOffsetInches: isLapped
        ? editingRun?.lapOffsetInches ??
          (referenceRun?.lapOffsetInches ?? 0) + 1
        : undefined,
      positions: distributeBars(
        0,
        pathLength,
        spacing,
        inchesPerModelUnit,
      ),
      lines: rebarLines,
    };
    setRebarRuns((current) =>
      editingRun
        ? current.map((candidate) =>
            candidate.id === editingRun.id ? run : candidate,
          )
        : [...current, run],
    );
    setSelectedRebarRunIds(new Set([run.id]));
    setRebarPhase("idle");
    setRebarWorkflowKind("create");
    setRebarReferenceRunId(null);
    setEditingRebarRunId(null);
    setRebarLines([]);
    setPendingRebarLine(null);
    setRebarPathStart(null);
    setRebarPathEnd(null);
    setRebarPathPoints([]);
    setRebarName(`Bar Run ${rebarRuns.length + (editingRun ? 1 : 2)}`);
    setRebarBarNumber("5");
    setStatus(
      `${run.name} ${editingRun ? "updated" : "created"} with ${run.positions.length} bars.`,
    );
  };

  const finishLappedRebar = () => {
    const referenceRun = rebarReferenceRunId
      ? rebarRuns.find((run) => run.id === rebarReferenceRunId)
      : null;
    const startPoint = rebarPathStart ?? rebarLines[0]?.points[0] ?? null;
    const editingRun = editingRebarRunId
      ? rebarRuns.find((run) => run.id === editingRebarRunId)
      : null;
    const direction =
      referenceRun?.distributionVector ?? editingRun?.distributionVector;
    if (!startPoint || !direction) {
      setError("The selected source bar does not have a spacing direction.");
      return;
    }
    if (!displayRebarPlane) {
      setError("The selected source bar does not have a valid drawing plane.");
      return;
    }
    const crossing = dot(direction, displayRebarPlane.normal);
    if (Math.abs(crossing) <= 1e-9) {
      setError(
        "The source bar spacing direction does not cross its drawing plane.",
      );
      return;
    }
    const distance = (rebarEnd - rebarStart) / crossing;
    const endpoint = {
      x: startPoint.x + direction.x * distance,
      y: startPoint.y + direction.y * distance,
      z: startPoint.z + direction.z * distance,
    };
    setRebarPathEnd(endpoint);
    finishRebarRun(startPoint, endpoint);
  };

  const cancelRebarWorkflow = useCallback(() => {
    setRebarPhase("idle");
    setRebarWorkflowKind("create");
    setRebarReferenceRunId(null);
    setEditingRebarRunId(null);
    setRebarLines([]);
    setPendingRebarLine(null);
    setRebarPathStart(null);
    setRebarPathEnd(null);
    setRebarPathPoints([]);
    setRebarPlaneDraftNodeIds([]);
    setStatus("Rebar workflow cancelled.");
  }, []);

  useEffect(() => {
    const undoRebar = (event: KeyboardEvent) => {
      if (activeTab !== "rebar") return;
      const target = event.target as HTMLElement | null;
      if (
        event.key === "Backspace" &&
        target?.matches("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      const controlUndo =
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "z";
      const stepBack =
        event.key === "Backspace" && rebarPhase !== "idle";
      const cancel = event.key === "Escape" && rebarPhase !== "idle";
      if (!controlUndo && !stepBack && !cancel) return;
      event.preventDefault();
      if (cancel) {
        cancelRebarWorkflow();
        return;
      }
      if (pendingRebarLine?.points.length) {
        setPendingRebarLine({
          ...pendingRebarLine,
          points: pendingRebarLine.points.slice(0, -1),
        });
      } else if (rebarPhase === "lines") {
        setPendingRebarLine(null);
        setRebarPhase("start");
      } else if (rebarPhase === "spacing") {
        setRebarPhase("path-review");
      } else if (rebarPhase === "path-review") {
        setRebarPathPoints((current) => current.slice(0, -1));
        setRebarPathEnd(
          rebarPathPoints[rebarPathPoints.length - 2] ?? null,
        );
        setRebarPhase("end");
      } else if (rebarPhase === "path-end") {
        setRebarPhase("end");
      } else if (rebarPhase === "end") {
        if (activeLappedWorkflow) {
          const line = rebarLines[0] ?? null;
          setPendingRebarLine(line);
          setRebarLines([]);
          setRebarPhase("lines");
        } else {
          setRebarPhase(
            rebarPathPoints.length > 1 ? "path-review" : "path-start",
          );
        }
      } else if (rebarPhase === "path-start") {
        const line = rebarLines[0] ?? null;
        setPendingRebarLine(line);
        setRebarLines([]);
        setRebarPhase("lines");
      } else if (rebarPhase === "start") {
        setRebarPhase(
          activeLappedWorkflow || editingRebarRunId ? "idle" : "plane",
        );
      } else if (rebarPhase === "plane-create") {
        if (rebarPlaneDraftNodeIds.length) {
          setRebarPlaneDraftNodeIds((current) => current.slice(0, -1));
        } else {
          setRebarPhase("plane");
        }
      } else if (rebarPhase === "plane") {
        cancelRebarWorkflow();
      } else if (rebarPhase === "lap-source") {
        cancelRebarWorkflow();
      } else if (controlUndo && rebarRuns.length) {
        setRebarRuns((current) => current.slice(0, -1));
      }
    };
    window.addEventListener("keydown", undoRebar);
    return () => window.removeEventListener("keydown", undoRebar);
  }, [
    activeTab,
    activeLappedWorkflow,
    pendingRebarLine,
    rebarLines,
    rebarPathPoints,
    editingRebarRunId,
    rebarPlaneDraftNodeIds.length,
    rebarPhase,
    rebarRuns.length,
    cancelRebarWorkflow,
  ]);

  const handleFacePick = (faceId: string) => {
    if (activeTab === "coordinates") {
      setFloorFaceId(faceId);
      setXDirectionNodeIds([]);
      reframeRebar(basis, null);
      setBasis(null);
      setAllNodes((current) =>
        current.map((node) => ({ ...node, local: null })),
      );
      if (globalBounds) setSlice(fullSlice(globalBounds));
      setStatus("Floor selected. Pick two nodes for positive X.");
      return;
    }

    if (activeTab === "volume") {
      setSelectedFaceIds(new Set([faceId]));
      setVolumeConfirmed(false);
      const face = faces.find((candidate) => candidate.id === faceId);
      setStatus(
        `${face?.label ?? "Face"} highlighted. Right-click a vertex to remove it, or drag an edge to a point to add one.`,
      );
    }
  };

  const toggleFaceSelection = (faceId: string) => {
    setSelectedFaceIds((current) => {
      const next = new Set(current);
      if (next.has(faceId)) next.delete(faceId);
      else next.add(faceId);
      return next;
    });
  };

  const rebuildFace = useCallback(
    (faceId: string, nodeIds: number[]) => {
      const original = faces.find((face) => face.id === faceId);
      if (!original) return false;
      if (nodeIds.length < 3) {
        setError("A face must keep at least three vertices.");
        return false;
      }
      try {
        const nodeMap = new Map(allNodes.map((node) => [node.id, node]));
        const selected = nodeIds.map((id) => {
          const node = nodeMap.get(id);
          if (!node) throw new Error(`Node ${id} is no longer available.`);
          return { id, point: node.global };
        });
        const cloudCenter = centroid(allNodes.map((node) => node.global));
        const replacement = original.fitted
          ? createFittedFace(
              original.id,
              original.label,
              selected,
              cloudCenter,
            )
          : createFace(
              original.id,
              original.label,
              selected,
              cloudCenter,
              tolerance,
            );
        replacement.automatic = original.automatic;
        replacement.smart = original.smart;
        setFaces((current) =>
          current.map((face) => (face.id === faceId ? replacement : face)),
        );
        setVolumeConfirmed(false);
        setError(null);
        return true;
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "Could not edit that face.",
        );
        return false;
      }
    },
    [allNodes, faces, tolerance],
  );

  const removeFaceVertex = useCallback(
    (faceId: string, nodeId: number) => {
      const face = faces.find((candidate) => candidate.id === faceId);
      if (!face || !face.nodeIds.includes(nodeId)) return;
      const changed = rebuildFace(
        faceId,
        face.nodeIds.filter((id) => id !== nodeId),
      );
      if (changed) setStatus(`Node #${nodeId} removed from ${face.label}.`);
    },
    [faces, rebuildFace],
  );

  const insertFaceVertex = useCallback(
    (faceId: string, edgeIndex: number, nodeId: number) => {
      const face = faces.find((candidate) => candidate.id === faceId);
      const node = allNodes.find((candidate) => candidate.id === nodeId);
      if (!face || !node) return;
      if (face.nodeIds.includes(nodeId)) {
        setError("That node is already a vertex of this face.");
        return;
      }
      const distance = Math.abs(
        face.plane.normal.x * node.global.x +
          face.plane.normal.y * node.global.y +
          face.plane.normal.z * node.global.z +
          face.plane.constant,
      );
      const editTolerance = Math.max(
        tolerance,
        (face.fitDeviation ?? 0) * 1.25,
      );
      if (distance > editTolerance) {
        setError("The new vertex must be on the face plane.");
        return;
      }
      const nodeIds = [...face.nodeIds];
      nodeIds.splice(edgeIndex + 1, 0, nodeId);
      if (rebuildFace(faceId, nodeIds)) {
        setStatus(`Node #${nodeId} added to ${face.label}.`);
      }
    },
    [allNodes, faces, rebuildFace, tolerance],
  );

  const deleteSelectedFaces = () => {
    if (!selectedFaceIds.size) return;
    const deletingFloor =
      floorFaceId !== null && selectedFaceIds.has(floorFaceId);
    setFaces((current) =>
      current.filter((face) => !selectedFaceIds.has(face.id)),
    );
    setSelectedFaceIds(new Set());
    setVolumeConfirmed(false);
    if (deletingFloor) {
      setFloorFaceId(null);
      setXDirectionNodeIds([]);
      reframeRebar(basis, null);
      setBasis(null);
      setAllNodes((current) =>
        current.map((node) => ({ ...node, local: null })),
      );
    }
    setStatus("Selected faces removed.");
  };

  const removeAllFaces = () => {
    setFaces([]);
    setDraftNodeIds([]);
    setSelectedFaceIds(new Set());
    setSmartSelecting(false);
    setVolumeConfirmed(false);
    setFloorFaceId(null);
    setXDirectionNodeIds([]);
    reframeRebar(basis, null);
    setBasis(null);
    setAllNodes((current) =>
      current.map((node) => ({ ...node, local: null })),
    );
    if (globalBounds) setSlice(fullSlice(globalBounds));
    setStatus("All faces removed.");
  };

  const toggleElementSelection = (elementId: number) => {
    setSelectedElementIds((current) => {
      const next = new Set(current);
      if (next.has(elementId)) next.delete(elementId);
      else next.add(elementId);
      return next;
    });
  };

  const deleteSelectedElements = () => {
    if (!selectedElementIds.size) return;
    const nextElements = elements.filter(
      (element) => !selectedElementIds.has(element.id),
    );
    setElements(nextElements);
    setSelectedElementIds(new Set());
    setStatus(
      elementSkinVolume
        ? "Selected MCT elements deleted. Tolerant element volume remains active."
        : "Selected MCT elements deleted.",
    );
  };

  const confirmVolume = () => {
    const polyhedron = automaticVolume
      ? true
      : buildPolyhedron(facePlanes, tolerance);
    if (!polyhedron) {
      setConfirmWarning(true);
      return;
    }
    const retained = automaticVolume
      ? allNodes
      : allNodes.filter((node) =>
          isInsidePlanes(node.global, facePlanes, tolerance),
        );
    if (retained.length) {
      setSlice(fullSlice(getBounds(retained, Boolean(basis))));
    }
    setVolumeConfirmed(true);
    setElementSkinVolume(false);
    setDefiningFaces(false);
    setSmartSelecting(false);
    setDraftNodeIds([]);
    setStatus("Closed inspection volume confirmed.");
  };

  const undoVolumeConfirmation = () => {
    setVolumeConfirmed(false);
    setElementSkinVolume(false);
    setConfirmWarning(false);
    setActiveTab("volume");
    setDefiningFaces(false);
    setSmartSelecting(false);
    setDraftNodeIds([]);
    setFittedFaceConfirmation(null);
    setStatus("Volume confirmation undone. Faces are ready for editing.");
  };

  const autoDefine = () => {
    if (!globalBounds) return;
    try {
      const generated = autoHullFaces(allNodes, globalBounds);
      setFaces(generated);
      setSelectedFaceIds(new Set());
      setDraftNodeIds([]);
      setDefiningFaces(false);
      setSmartSelecting(false);
      setVolumeConfirmed(false);
      setFloorFaceId(null);
      setStatus(
        `${generated.length} exact node-defined hull faces generated. Review or confirm the volume.`,
      );
      setError(null);
    } catch (caught) {
      setError(
        `${
          caught instanceof Error ? caught.message : "Hull generation failed."
        } A bounding box was used instead.`,
      );
      const fallback = autoBoxFaces(globalBounds);
      setFaces(fallback);
      setStatus("Hull fallback: six bounding faces generated.");
    }
  };

  const editableFace = useMemo(() => {
    if (!shapeEditingFaceId) return null;
    return (
      faces.find(
        (face) => face.id === shapeEditingFaceId && face.nodeIds.length,
      ) ??
      null
    );
  }, [faces, shapeEditingFaceId]);

  const invalidDraftNodeIds = useMemo(() => {
    if (draftNodeIds.length < 4) return [];
    const nodeMap = new Map(allNodes.map((node) => [node.id, node.global]));
    const points = draftNodeIds
      .map((id) => ({ id, point: nodeMap.get(id) }))
      .filter(
        (entry): entry is { id: number; point: Vec3 } => Boolean(entry.point),
      );
    let origin: Vec3 | null = null;
    let normal: Vec3 | null = null;
    for (let i = 0; i < points.length - 2 && !normal; i += 1) {
      for (let j = i + 1; j < points.length - 1 && !normal; j += 1) {
        for (let k = j + 1; k < points.length; k += 1) {
          const candidate = cross(
            subtract(points[j].point, points[i].point),
            subtract(points[k].point, points[i].point),
          );
          const length = Math.hypot(candidate.x, candidate.y, candidate.z);
          if (length > tolerance) {
            origin = points[i].point;
            normal = {
              x: candidate.x / length,
              y: candidate.y / length,
              z: candidate.z / length,
            };
            break;
          }
        }
      }
    }
    if (!origin || !normal) return [];
    return points
      .filter(({ point }) => {
        const delta = subtract(point, origin);
        return (
          Math.abs(
            delta.x * normal!.x +
              delta.y * normal!.y +
              delta.z * normal!.z,
          ) > tolerance
        );
      })
      .map(({ id }) => id);
  }, [allNodes, draftNodeIds, tolerance]);

  const selectedNodeIds = useMemo(
    () => [
      ...draftNodeIds,
      ...xDirectionNodeIds,
      ...scaleNodeIds,
      ...rebarPlaneDraftNodeIds,
      ...(editableFace?.nodeIds ?? []),
    ],
    [
      draftNodeIds,
      editableFace,
      rebarPlaneDraftNodeIds,
      scaleNodeIds,
      xDirectionNodeIds,
    ],
  );
  const floorOrbitFace = useMemo(() => {
    if (!floorFaceId) return null;
    return faces.find((face) => face.id === floorFaceId) ?? null;
  }, [faces, floorFaceId]);
  const floorOrbitTarget = useMemo(
    () => (floorOrbitFace ? centroid(floorOrbitFace.vertices) : null),
    [floorOrbitFace],
  );

  const activateSmartSelect = (
    variant: "classic" | "axis" | "local" | "full",
  ) => {
    const next = !smartSelecting || smartVariant !== variant;
    setSmartSelecting(next);
    setSmartVariant(variant);
    setDefiningFaces(false);
    setDraftNodeIds([]);
    setVolumeConfirmed(false);
    const descriptions = {
      classic: "Hover an exterior connected planar patch, then click.",
      axis: `Tracing the complete local ${smartAxis.toUpperCase()} coordinate plane. Arrow keys cycle axes.`,
      local: "Hover a node to fit a compact local tangent patch.",
      full: "Hover a node to fit and trace its complete matching plane.",
    };
    setStatus(next ? descriptions[variant] : "Smart Select ended.");
  };

  const cycleSmartAxis = useCallback((direction: 1 | -1 = 1) => {
    setSmartAxis((current) => {
      const axes: SmartAxis[] = ["x", "y", "z"];
      const next =
        axes[(axes.indexOf(current) + direction + axes.length) % axes.length];
      setStatus(
        `Smart Select 1 now traces the local ${next.toUpperCase()} plane.`,
      );
      return next;
    });
  }, []);

  useEffect(() => {
    if (
      activeTab !== "volume" ||
      !smartSelecting ||
      smartVariant !== "axis"
    ) {
      return;
    }
    const handleAxisKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) {
        return;
      }
      if (event.code === "ArrowRight" || event.code === "ArrowUp") {
        event.preventDefault();
        cycleSmartAxis(1);
      } else if (
        event.code === "ArrowLeft" ||
        event.code === "ArrowDown"
      ) {
        event.preventDefault();
        cycleSmartAxis(-1);
      }
    };
    window.addEventListener("keydown", handleAxisKey);
    return () => window.removeEventListener("keydown", handleAxisKey);
  }, [activeTab, cycleSmartAxis, smartSelecting, smartVariant]);

  const instruction =
    activeTab === "volume"
      ? definingFaces
        ? `${draftNodeIds.length} boundary points · Space closes face`
        : smartSelecting
          ? smartPreviewFace
            ? smartVariant === "axis"
              ? `Click to add local ${smartAxis.toUpperCase()} plane · Arrow keys change axis`
              : "Click to add the highlighted face"
            : "Hover a node to preview this method"
          : elementEditMode
            ? "Click a plate to select its whole MCT element"
            : "Begin, Smart Select, or Auto-Define"
      : activeTab === "coordinates"
        ? !floorFaceId
          ? "Select the floor face"
          : xDirectionNodeIds.length < 2
            ? `Pick X direction node ${xDirectionNodeIds.length + 1}/2`
            : "Local coordinates active"
        : activeTab === "slicing"
          ? rebarPhase === "plane-create"
            ? `Define plane node ${rebarPlaneDraftNodeIds.length + 1}/2`
            : slicingSubtab === "planes"
              ? "Choose planes and star your slicing favorites"
              : slicingSubtab === "slice"
                ? "Move a favorite plane, then pin useful slices"
                : "Manage pins and saved viewpoints"
          : rebarPhase === "idle"
            ? "Create or review reinforcement runs"
            : "Follow the active rebar step";

  const renderRebarRunButton = (run: RebarRun) => (
    <button
      type="button"
      key={run.id}
      draggable={rebarPhase === "idle"}
      className={`bar-run-item ${
        selectedRebarRunIds.has(run.id) ? "selected" : ""
      }`}
      data-rebar-selection-control
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-mct-rebar-run", run.id);
      }}
      onClick={(event) => {
        if (rebarPhase === "lap-source") {
          beginLappedRebar(run);
          return;
        }
        if (event.ctrlKey || event.metaKey) {
          setSelectedRebarRunIds((current) => {
            const next = new Set(current);
            if (next.has(run.id)) next.delete(run.id);
            else next.add(run.id);
            return next;
          });
        } else {
          setSelectedRebarRunIds(new Set([run.id]));
        }
      }}
    >
      <i
        className="bar-run-color"
        style={{ background: run.color ?? REBAR_COLORS[0] }}
        aria-hidden="true"
      />
      <span>
        <strong>{run.name}</strong>
        <small>
          {run.positions.length} bars · #{run.barNumber ?? "5"} ·{" "}
          {run.spacingInches}&quot; nominal
          {run.lappedFromRunId ? " · lapped" : ""}
        </small>
      </span>
    </button>
  );

  return (
    <main
      className="app-shell"
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (
          activeTab === "rebar" &&
          !target.closest(".viewport") &&
          !target.closest("[data-plane-control]")
        ) {
          setPreviewedRebarPlaneId(null);
        }
        if (
          activeTab !== "rebar" ||
          rebarPhase !== "idle" ||
          !selectedRebarRunIds.size
        ) {
          return;
        }
        if (target.closest("[data-rebar-selection-control]")) return;
        setSelectedRebarRunIds(new Set());
      }}
      onDragEnter={(event) => {
        if (Array.from(event.dataTransfer.types).includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes("Files")) {
          event.preventDefault();
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) void loadFile(file);
      }}
    >
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div>
            <strong>MCT SECTION LAB</strong>
            <span>VOLUME INSPECTION WORKSPACE</span>
          </div>
        </div>
        <div className="file-summary">
          <span className="eyebrow">ACTIVE MODEL</span>
          <strong>{fileName}</strong>
        </div>
        <div className="top-actions">
          <span className="privacy-note">
            <span className="status-dot" /> LOCAL PROCESSING
          </span>
          <button
            className="button ghost"
            onClick={() =>
              loadText(createSampleMct(), "Demo bridge lattice")
            }
          >
            Load demo
          </button>
          <button
            className="button ghost"
            onClick={() => projectInputRef.current?.click()}
          >
            Import Project
          </button>
          <button className="button ghost" onClick={exportProject}>
            Export Project
          </button>
          <button
            className="button primary"
            onClick={() => fileInputRef.current?.click()}
          >
            Open MCT
          </button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".mct,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void loadFile(file);
              event.target.value = "";
            }}
          />
          <input
            ref={projectInputRef}
            className="visually-hidden"
            type="file"
            accept=".json,.mctlab.json,application/json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importProject(file);
              event.target.value = "";
            }}
          />
        </div>
      </header>

      <aside
        className="control-rail"
        onClickCapture={(event) => {
          if (
            activeTab === "rebar" &&
            !(event.target as HTMLElement).closest("[data-plane-control]")
          ) {
            setPreviewedRebarPlaneId(null);
          }
        }}
      >
        <nav className="workflow-tabs" aria-label="Model workflow">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={activeTab === tab.id ? "active" : ""}
              onClick={() => {
                setActiveTab(tab.id);
                if (
                  (tab.id === "slicing" || tab.id === "rebar") &&
                  currentBounds
                ) {
                  setSlice(fullSlice(currentBounds));
                }
                if (rebarPhase === "plane-create") {
                  setRebarPhase("idle");
                  setRebarPlaneDraftNodeIds([]);
                }
                setDefiningFaces(false);
                setSmartSelecting(false);
                setElementEditMode(false);
                setSelectedElementIds(new Set());
                setDraftNodeIds([]);
              }}
            >
              <span>{tab.number}</span>
              {tab.label}
            </button>
          ))}
        </nav>

        {activeTab === "volume" && (
          <div className="tab-content">
            <section className="panel-section intro compact">
              <span className="eyebrow">CONVEX BOUNDARY</span>
              <h1>Define the inspection volume</h1>
              <p>
                Click a start node, then trace the perimeter in order. Press
                Space to close the last line back to the start. Smart Select
                remains available for automatic planar patches.
              </p>
            </section>

            {elements.length > 0 && (
              <section className="panel-section element-skin-section">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">MCT ELEMENT SKIN</span>
                    <strong>
                      {elementSkin.surfaces.length.toLocaleString()} faces
                    </strong>
                  </div>
                  <button onClick={() => setShowElementSkin((value) => !value)}>
                    {showElementSkin ? "Hide" : "Show"}
                  </button>
                </div>
                <p>
                  {elementSkin.plateElementCount.toLocaleString()} plate ·{" "}
                  {elementSkin.solidElementCount.toLocaleString()} solid ·{" "}
                  {closedElementShells.length} closed shell
                  {closedElementShells.length === 1 ? "" : "s"}
                </p>
                {elementSkin.shells.some((shell) => !shell.closed) && (
                  <small>
                    Open edges detected in{" "}
                    {elementSkin.shells.filter((shell) => !shell.closed).length}{" "}
                    shell component(s). Tolerant mode can continue without
                    repairing or deleting them.
                  </small>
                )}
                <button
                  className="button primary wide"
                  disabled={!elementSkin.surfaces.length}
                  onClick={() => {
                    setElementSkinVolume(true);
                    setVolumeConfirmed(true);
                    setShowElementSkin(true);
                    setDefiningFaces(false);
                    setSmartSelecting(false);
                    setStatus(
                      closedElementShells.length
                        ? "Closed MCT element skin is now the inspection volume."
                        : "Element volume accepted in tolerant mode. Open and interior faces will not block the workflow.",
                    );
                  }}
                >
                  {elementSkinVolume
                    ? closedElementShells.length
                      ? "Element Skin In Use"
                      : "Tolerant Element Volume In Use"
                    : closedElementShells.length
                      ? "Use Element Skin as Volume"
                      : "Continue with Element Volume"}
                </button>
                <button
                  className={`button wide ${elementEditMode ? "primary" : ""}`}
                  disabled={!elements.length}
                  onClick={() => {
                    setElementEditMode((value) => !value);
                    setSelectedElementIds(new Set());
                    setShowElementSkin(true);
                    setDefiningFaces(false);
                    setSmartSelecting(false);
                    setStatus(
                      elementEditMode
                        ? "Element editing ended."
                        : "Element editing active. Click an unwanted face.",
                    );
                  }}
                >
                  {elementEditMode ? "Finish Element Editing" : "Delete Elements"}
                </button>
                {elementEditMode && (
                  <div className="selection-callout">
                    <strong>
                      {selectedElementIds.size} element
                      {selectedElementIds.size === 1 ? "" : "s"} selected
                    </strong>
                    <span>
                      Click a face to toggle its complete source MCT element.
                      This works for both solid and plate elements.
                    </span>
                    <button
                      className="danger-button"
                      disabled={!selectedElementIds.size}
                      onClick={deleteSelectedElements}
                    >
                      Delete Selected Elements
                    </button>
                  </div>
                )}
              </section>
            )}

            <div className="action-grid">
              <button
                className={`button ${definingFaces ? "primary" : ""}`}
                onClick={() => {
                  setDefiningFaces((current) => !current);
                  setSmartSelecting(false);
                  setDraftNodeIds([]);
                  setVolumeConfirmed(false);
                  setStatus(
                    definingFaces
                      ? "Manual boundary ended."
                      : "Pick the first boundary point, then trace each side.",
                  );
                }}
              >
                {definingFaces ? "Defining…" : "Begin"}
              </button>
              <button
                className={`button ${
                  smartSelecting && smartVariant === "classic" ? "primary" : ""
                }`}
                onClick={() => activateSmartSelect("classic")}
                title="Connected exterior planar patch"
              >
                Smart Select
              </button>
              <button
                className={`button ${
                  smartSelecting && smartVariant === "axis" ? "primary" : ""
                }`}
                onClick={() => activateSmartSelect("axis")}
                title="Complete local coordinate plane; arrow keys cycle X, Y, and Z"
              >
                Smart Select 1 · {smartAxis.toUpperCase()}
              </button>
              <button
                className={`button ${
                  smartSelecting && smartVariant === "local" ? "primary" : ""
                }`}
                onClick={() => activateSmartSelect("local")}
                title="Compact best-fit tangent patch around the hovered node"
              >
                Smart Select 2
              </button>
              <button
                className={`button ${
                  smartSelecting && smartVariant === "full" ? "primary" : ""
                }`}
                onClick={() => activateSmartSelect("full")}
                title="Best-fit local plane expanded across all matching nodes"
              >
                Smart Select 3
              </button>
              <button className="button auto-wide" onClick={autoDefine}>
                Auto-Define
              </button>
            </div>

            {definingFaces && (
              <div className="selection-callout">
                <strong>{draftNodeIds.length} selected</strong>
                <span>
                  {invalidDraftNodeIds.length
                    ? fittedFaceConfirmation === draftNodeIds.join(",")
                      ? "Press Space again to accept the fitted plane"
                      : `${invalidDraftNodeIds.length} red point${
                          invalidDraftNodeIds.length === 1 ? " is" : "s are"
                        } off-plane · Space reviews`
                    : draftNodeIds.length >= 3
                    ? "Press Space to close and create the face"
                    : `Trace ${3 - draftNodeIds.length} more point${
                        3 - draftNodeIds.length === 1 ? "" : "s"
                      }`}
                </span>
              </div>
            )}

            {smartSelecting && (
              <div className="selection-callout smart-method-callout">
                <strong>
                  {smartVariant === "classic"
                    ? "CONNECTED"
                    : smartVariant === "axis"
                      ? `AXIS ${smartAxis.toUpperCase()}`
                      : smartVariant === "local"
                        ? "LOCAL FIT"
                        : "FULL PLANE"}
                </strong>
                <span>
                  {smartVariant === "classic"
                    ? "Exterior plane with connected-region growth"
                    : smartVariant === "axis"
                      ? "All nodes at one local coordinate · Arrow keys cycle"
                      : smartVariant === "local"
                        ? "Compact tangent fit around the hovered node"
                        : "Local plane fit expanded through the complete model"}
                </span>
              </div>
            )}

            <section className="face-list-section">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">DEFINED FACES</span>
                  <strong>{faces.length}</strong>
                </div>
                <div>
                  <button
                    onClick={() =>
                      setSelectedFaceIds(
                        new Set(faces.map((face) => face.id)),
                      )
                    }
                  >
                    All
                  </button>
                  <button onClick={() => setSelectedFaceIds(new Set())}>
                    None
                  </button>
                </div>
              </div>
              <div className="face-list">
                {faces.length ? (
                  faces.map((face) => (
                    <label
                      key={face.id}
                      className={
                        selectedFaceIds.has(face.id) ? "selected" : ""
                      }
                    >
                      <input
                        type="checkbox"
                        checked={selectedFaceIds.has(face.id)}
                        onChange={() => toggleFaceSelection(face.id)}
                      />
                      <span>
                        <strong>{face.label}</strong>
                        <small>
                          {face.automatic
                            ? `${face.nodeIds.length} MCT boundary nodes`
                            : face.smart
                              ? `Smart plane · ${face.nodeIds.length} boundary nodes`
                              : face.fitted
                                ? `Fitted plane · ${face.nodeIds.length} source nodes`
                                : `${face.nodeIds.length} nodes`}
                        </small>
                      </span>
                    </label>
                  ))
                ) : (
                  <p>No faces yet.</p>
                )}
              </div>
              <button
                className="text-button"
                disabled={!selectedFaceIds.size}
                onClick={deleteSelectedFaces}
              >
                Delete selected
              </button>
            </section>

            <div className="volume-actions">
              <button
                className="button primary wide"
                disabled={faces.length < 4 || volumeConfirmed}
                onClick={confirmVolume}
              >
                {volumeConfirmed ? "Volume Confirmed" : "Confirm Volume"}
              </button>
              {volumeConfirmed && (
                <button
                  className="button wide undo-volume"
                  onClick={undoVolumeConfirmation}
                >
                  Undo Volume Confirmation
                </button>
              )}
              <button className="danger-button" onClick={removeAllFaces}>
                Remove All Faces
              </button>
            </div>
          </div>
        )}

        {activeTab === "coordinates" && (
          <div className="tab-content">
            <section className="panel-section intro compact">
              <span className="eyebrow">LOCAL FRAME</span>
              <h1>Lay out the model</h1>
              <p>
                Select a floor face, then two nodes to establish positive X.
              </p>
            </section>
            <div className="coordinate-steps">
              <div className={floorFaceId ? "complete" : "active"}>
                <span>01</span>
                <strong>Floor face</strong>
                <small>
                  {floorFaceId
                    ? faces.find((face) => face.id === floorFaceId)?.label
                    : "Click a face in the viewport"}
                </small>
              </div>
              <div
                className={
                  !floorFaceId
                    ? ""
                    : xDirectionNodeIds.length === 2
                      ? "complete"
                      : "active"
                }
              >
                <span>02</span>
                <strong>Positive X</strong>
                <small>
                  {xDirectionNodeIds.length
                    ? xDirectionNodeIds.map((id) => `#${id}`).join(" → ")
                    : "Pick two nodes"}
                </small>
              </div>
            </div>
            {basis && (
              <div className="success-callout">
                <span>✓</span>
                <div>
                  <strong>Coordinates applied</strong>
                  <small>Floor is XY · inward normal is +Z</small>
                </div>
              </div>
            )}
            <button
              className="text-button"
              onClick={() => {
                setFloorFaceId(null);
                setXDirectionNodeIds([]);
                reframeRebar(basis, null);
                setBasis(null);
                setAllNodes((current) =>
                  current.map((node) => ({ ...node, local: null })),
                );
                if (globalBounds) setSlice(fullSlice(globalBounds));
              }}
            >
              Reset coordinates
            </button>
            <section className="panel-section scale-section">
              <span className="eyebrow">PHYSICAL UNITS</span>
              <button
                className={`button wide ${scaleDefining ? "primary" : ""}`}
                onClick={() => {
                  setScaleDefining((value) => !value);
                  setScaleNodeIds([]);
                  setStatus("Select two nodes with a known distance.");
                }}
              >
                {scaleDefining ? "Selecting Scale Nodes…" : "Define Scale"}
              </button>
              {scaleDefining && (
                <div className="scale-definition">
                  <span>
                    {scaleNodeIds.length}/2 nodes selected
                  </span>
                  <label>
                    Known distance (inches)
                    <input
                      type="number"
                      min={0.001}
                      step={0.125}
                      value={scaleDistanceInches}
                      onChange={(event) =>
                        setScaleDistanceInches(Number(event.target.value))
                      }
                    />
                  </label>
                  <button
                    className="button primary"
                    disabled={scaleNodeIds.length !== 2}
                    onClick={applyDefinedScale}
                  >
                    Apply Scale
                  </button>
                </div>
              )}
              {inchesPerModelUnit && (
                <small>
                  1 model unit = {inchesPerModelUnit.toFixed(5)} inches
                </small>
              )}
            </section>
          </div>
        )}

        {activeTab === "slicing" && currentBounds && (
          <div className="tab-content slicing-content">
            <div className="slicing-subtabs" role="tablist">
              {(["planes", "slice", "pins"] as const).map((tab) => (
                <button
                  key={tab}
                  className={slicingSubtab === tab ? "active" : ""}
                  onClick={() => {
                    setSlicingSubtab(tab);
                    if (tab !== "pins") setActiveSlicePinId(null);
                    if (
                      tab === "slice" &&
                      !favoriteRebarPlaneIds.includes(
                        selectedSlicingPlaneId ?? "",
                      )
                    ) {
                      const first = favoriteRebarPlaneIds.find((id) =>
                        rebarPlanes.some((plane) => plane.id === id),
                      );
                      if (first) selectSlicingPlane(first);
                    }
                  }}
                >
                  {tab === "planes"
                    ? "Planes"
                    : tab === "slice"
                      ? "Slice"
                      : "Pins"}
                </button>
              ))}
            </div>

            <label className="skin-toggle slicing-rebar-toggle">
              <input
                type="checkbox"
                checked={showRebarInSlicing}
                onChange={(event) =>
                  setShowRebarInSlicing(event.target.checked)
                }
              />
              Display rebar
            </label>

            {slicingSubtab === "planes" && (
              <section className="slicing-workspace">
                <div className="slicing-section-heading">
                  <div>
                    <span className="eyebrow">PROJECT PLANES</span>
                    <strong>Choose or favorite a plane</strong>
                  </div>
                  <button
                    className="button compact"
                    onClick={beginSlicingPlaneCreation}
                  >
                    Add Plane
                  </button>
                </div>
                <div className="slicing-plane-list">
                  {rebarPlanes.map((plane) => {
                    const favorite = favoriteRebarPlaneIds.includes(plane.id);
                    return (
                      <div
                        key={plane.id}
                        className={`slicing-plane-row ${
                          selectedSlicingPlaneId === plane.id ? "selected" : ""
                        }`}
                      >
                        <button
                          className="plane-select-button"
                          onClick={() => selectSlicingPlane(plane.id)}
                        >
                          <span
                            className="plane-color"
                            style={{ background: plane.color }}
                          />
                          <span>{plane.name}</span>
                        </button>
                        <button
                          className={`plane-star ${favorite ? "favorite" : ""}`}
                          aria-label={
                            favorite
                              ? `Remove ${plane.name} from favorites`
                              : `Add ${plane.name} to favorites`
                          }
                          onClick={() => toggleFavoritePlane(plane.id)}
                        >
                          {favorite ? "★" : "☆"}
                        </button>
                      </div>
                    );
                  })}
                  {!rebarPlanes.length && (
                    <p className="empty-list">No project planes yet.</p>
                  )}
                </div>
                {rebarPhase === "plane-create" && (
                  <div className="selection-callout">
                    <strong>Defining a plane</strong>
                    <span>
                      Select two nodes ({rebarPlaneDraftNodeIds.length}/2).
                    </span>
                  </div>
                )}
              </section>
            )}

            {slicingSubtab === "slice" && (
              <section className="slicing-workspace">
                <span className="eyebrow">FAVORITE PLANES</span>
                <div className="favorite-plane-list">
                  {favoriteRebarPlaneIds
                    .map((id) =>
                      rebarPlanes.find((plane) => plane.id === id),
                    )
                    .filter((plane): plane is RebarPlane => Boolean(plane))
                    .map((plane) => (
                      <button
                        key={plane.id}
                        className={
                          selectedSlicingPlaneId === plane.id ? "selected" : ""
                        }
                        onClick={() => selectSlicingPlane(plane.id)}
                      >
                        <span
                          className="plane-color"
                          style={{ background: plane.color }}
                        />
                        {plane.name}
                      </button>
                    ))}
                  {!favoriteRebarPlaneIds.some((id) =>
                    rebarPlanes.some((plane) => plane.id === id),
                  ) && (
                    <p className="empty-list">
                      Star a plane in the Planes tab to use it here.
                    </p>
                  )}
                </div>
                {selectedSlicingPlane &&
                  favoriteRebarPlaneIds.includes(selectedSlicingPlane.id) && (
                    <div className="plane-slice-control">
                      <div>
                        <strong>{selectedSlicingPlane.name}</strong>
                        <span>
                          {inchesPerModelUnit
                            ? `${(
                                slicingPlaneOffset * inchesPerModelUnit
                              ).toFixed(2)} in`
                            : slicingPlaneOffset.toFixed(3)}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={slicingPlaneBounds[0]}
                        max={slicingPlaneBounds[1]}
                        step={Math.max(
                          (slicingPlaneBounds[1] - slicingPlaneBounds[0]) /
                            500,
                          0.000001,
                        )}
                        value={slicingPlaneOffset}
                        onChange={(event) => {
                          setActiveSlicePinId(null);
                          setSlicingPlaneOffset(Number(event.target.value));
                        }}
                      />
                      <div className="slice-actions">
                        <button
                          className="button primary"
                          onClick={createSlicePin}
                        >
                          Pin
                        </button>
                        <button
                          className="button"
                          onClick={() => {
                            setActiveSlicePinId(null);
                            setSlicingPlaneOffset(slicingPlaneBounds[1]);
                          }}
                        >
                          Full extent
                        </button>
                      </div>
                    </div>
                  )}
              </section>
            )}

            {slicingSubtab === "pins" && (
              <section className="slicing-workspace pins-workspace">
                <span className="eyebrow">PINNED SLICES</span>
                <div className="slice-pin-list">
                  {slicePins.map((pin) => (
                    <button
                      key={pin.id}
                      className={`slice-pin-row ${
                        selectedSlicePinId === pin.id ? "selected" : ""
                      } ${pin.viewpoint ? "has-viewpoint" : "no-viewpoint"}`}
                      onClick={() => activateSlicePin(pin)}
                    >
                      <span>{pin.name}</span>
                      <small>
                        {rebarPlanes.find((plane) => plane.id === pin.planeId)
                          ?.name ?? "Missing plane"}
                      </small>
                    </button>
                  ))}
                  {!slicePins.length && (
                    <p className="empty-list">
                      Pin a position from the Slice tab.
                    </p>
                  )}
                </div>
                <div className="pin-management-actions">
                  <button
                    className="button primary"
                    disabled={!selectedSlicePin}
                    onClick={saveSelectedPinViewpoint}
                  >
                    Save Viewpoint
                  </button>
                  <button
                    className="button"
                    disabled={!selectedSlicePin}
                    onClick={renameSelectedPin}
                  >
                    Rename
                  </button>
                  <button
                    className="button danger"
                    disabled={!selectedSlicePin}
                    onClick={deleteSelectedPin}
                  >
                    Delete
                  </button>
                </div>
              </section>
            )}
          </div>
        )}

        {activeTab === "rebar" && currentBounds && (
          <div className="tab-content rebar-content">
            {!inchesPerModelUnit ? (
              <div className="selection-callout">
                <strong>Scale required</strong>
                <span>Use Coordinates → Define Scale before creating bars.</span>
              </div>
            ) : (
              <>
                <div className="rebar-view-options" aria-label="View options">
                <label className="skin-toggle" title="Show the concrete surface">
                  <input
                    type="checkbox"
                    checked={showConcreteSkin}
                    disabled={lineAndBar}
                    onChange={(event) =>
                      setShowConcreteSkin(event.target.checked)
                    }
                  />
                  Show concrete skin
                </label>
                <label className="skin-toggle" title="Show only model outlines and reinforcement">
                  <input
                    type="checkbox"
                    checked={lineAndBar}
                    onChange={(event) =>
                      setLineAndBar(event.target.checked)
                    }
                  />
                  Line and Bar
                </label>
                <label className="skin-toggle" title="Show compact names beside bar runs">
                  <input
                    type="checkbox"
                    checked={showRebarLabels}
                    onChange={(event) =>
                      setShowRebarLabels(event.target.checked)
                    }
                  />
                  Show bar labels
                </label>
                </div>
                <section className="cover-offset-controls">
                  <span className="eyebrow">PERIMETER SNAP OFFSETS</span>
                  <div>
                    <label>
                      Primary (in)
                      <input
                        type="number"
                        min={0}
                        step={0.125}
                        value={rebarCoverOffsetInches}
                        onChange={(event) =>
                          setRebarCoverOffsetInches(
                            Math.max(0, Number(event.target.value)),
                          )
                        }
                      />
                    </label>
                    <label>
                      Secondary (in)
                      <input
                        type="number"
                        min={0}
                        step={0.125}
                        value={rebarSecondaryOffsetInches}
                        onChange={(event) =>
                          setRebarSecondaryOffsetInches(
                            Math.max(0, Number(event.target.value)),
                          )
                        }
                      />
                    </label>
                  </div>
                </section>
                <section
                  className="rebar-plane-manager"
                  data-plane-control
                >
                  <div className="section-heading">
                    <span className="eyebrow">PLANES</span>
                    <strong>{rebarPlanes.length}</strong>
                  </div>
                  <div className="rebar-plane-list">
                    {rebarPlanes.map((plane) => (
                      <div
                        key={plane.id}
                        className={`rebar-plane-row ${
                          previewedRebarPlaneId === plane.id ? "selected" : ""
                        }`}
                      >
                        {renamingRebarPlaneId === plane.id ? (
                          <div className="rebar-plane-rename">
                            <i style={{ background: plane.color }} />
                            <input
                              autoFocus
                              defaultValue={plane.name}
                              aria-label={`Rename ${plane.name}`}
                              onBlur={(event) => {
                                const name = event.currentTarget.value.trim();
                                if (name) {
                                  setRebarPlanes((current) =>
                                    current.map((candidate) =>
                                      candidate.id === plane.id
                                        ? { ...candidate, name }
                                        : candidate,
                                    ),
                                  );
                                }
                                setRenamingRebarPlaneId(null);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.currentTarget.blur();
                                } else if (event.key === "Escape") {
                                  setRenamingRebarPlaneId(null);
                                }
                              }}
                            />
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={
                              Boolean(editingRebarRunId) &&
                              plane.id !== activeRebarPlaneId
                            }
                            onClick={() => selectRebarPlane(plane.id)}
                            onDoubleClick={(event) => {
                              event.stopPropagation();
                              setRenamingRebarPlaneId(plane.id);
                            }}
                            title={
                              editingRebarRunId &&
                              plane.id !== activeRebarPlaneId
                                ? "The drawing plane is locked while editing"
                                : "Click to show this plane; double-click to rename"
                            }
                          >
                            <i style={{ background: plane.color }} />
                            <span>{plane.name}</span>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="rebar-plane-actions">
                    <button
                      className="button"
                      disabled={
                        rebarPhase !== "idle" && rebarPhase !== "plane"
                      }
                      onClick={() => {
                        setRebarPlaneReturnPhase(
                          rebarPhase === "plane" ? "plane" : "idle",
                        );
                        setRebarPlaneDraftNodeIds([]);
                        setRebarPhase("plane-create");
                        setStatus(
                          "Select two nodes to define the horizontal direction of a vertical plane.",
                        );
                      }}
                    >
                      Add Plane
                    </button>
                    <button
                      className="danger-button"
                      disabled={
                        !activeRebarPlaneId ||
                        (rebarPhase !== "idle" && rebarPhase !== "plane")
                      }
                      onClick={deleteActiveRebarPlane}
                    >
                      Delete Plane
                    </button>
                  </div>
                </section>

                {rebarPhase === "idle" && (
                  <div className="rebar-primary-actions">
                    <button
                      className="button primary"
                      onClick={beginCreateRebar}
                      title={
                        activeRebarPlane
                          ? `Start on ${activeRebarPlane.name}`
                          : "Choose a plane and create a bar run"
                      }
                    >
                      Add Bar
                    </button>
                    <button
                      className="button"
                      disabled={!rebarRuns.length}
                      onClick={() => {
                        if (selectedRebarRun) {
                          beginLappedRebar(selectedRebarRun);
                          return;
                        }
                        setRebarWorkflowKind("lap");
                        setRebarReferenceRunId(null);
                        setEditingRebarRunId(null);
                        setRebarPhase("lap-source");
                        setStatus(
                          "Select the existing bar run that this bar will lap.",
                        );
                      }}
                      title={
                        selectedRebarRun
                          ? `Create a lap from ${selectedRebarRun.name}`
                          : "Select an existing bar run to lap"
                      }
                    >
                      {selectedRebarRun
                        ? `Lap ${selectedRebarRun.name}`
                        : "Add Lapped Bar"}
                    </button>
                  </div>
                )}

                {rebarPhase === "lap-source" && (
                  <section className="rebar-step">
                    <span className="eyebrow">LAPPED BAR · SOURCE</span>
                    <div className="selection-callout">
                      <strong>Select an existing bar run</strong>
                      <span>
                        Click one run below. Its axis, start, end, spacing,
                        and color will be suggested for the new lapped bar.
                      </span>
                    </div>
                    <button
                      className="text-button"
                      onClick={cancelRebarWorkflow}
                    >
                      Cancel
                    </button>
                  </section>
                )}

                {rebarPhase === "plane" && (
                  <section className="rebar-step">
                    <span className="eyebrow">DRAWING PLANE</span>
                    <div className="selection-callout">
                      <strong>Choose a drawing plane</strong>
                      <span>
                        Saved planes are shown in the viewer. Their colors match
                        this list and remain fixed to the model.
                      </span>
                    </div>
                    <small>
                      Select a plane in the scrollable plane manager above, or
                      use Add Plane.
                    </small>
                    <button className="text-button" onClick={cancelRebarWorkflow}>
                      Cancel
                    </button>
                  </section>
                )}

                {rebarPhase === "plane-create" && (
                  <section className="rebar-step">
                    <span className="eyebrow">NEW VERTICAL PLANE</span>
                    <div className="selection-callout">
                      <strong>
                        Select node {rebarPlaneDraftNodeIds.length + 1} of 2
                      </strong>
                      <span>
                        The two nodes define the plane direction. Vertical comes
                        from the project axes you already established.
                      </span>
                    </div>
                    <button className="text-button" onClick={cancelRebarWorkflow}>
                      Cancel
                    </button>
                  </section>
                )}

                {rebarPhase === "start" && (
                  <section className="rebar-step">
                    <span className="eyebrow">START SECTION</span>
                    <div className="active-plane-chip">
                      <i style={{ background: activeRebarPlane?.color }} />
                      <span>{activeRebarPlane?.name ?? "No plane selected"}</span>
                    </div>
                    <label>
                      Position (in)
                      <input
                        type="number"
                        min={rebarPlaneBounds[0] * inchesPerModelUnit}
                        max={
                          rebarPlaneBounds[1] * inchesPerModelUnit
                        }
                        step={0.25}
                        value={Number(
                          (
                            rebarStart * inchesPerModelUnit
                          ).toFixed(3),
                        )}
                        onChange={(event) =>
                          setRebarStart(Number(event.target.value) / inchesPerModelUnit)
                        }
                      />
                    </label>
                    <div className="range-with-markers">
                      <div className="section-markers">
                        {rebarSectionBookmarks.map((coordinate) => {
                          const span =
                            rebarPlaneBounds[1] - rebarPlaneBounds[0];
                          const left =
                            span <= 0
                              ? 0
                              : ((coordinate - rebarPlaneBounds[0]) / span) *
                                100;
                          const inches = coordinate * inchesPerModelUnit;
                          return (
                            <button
                              type="button"
                              key={coordinate}
                              style={{ left: `${left}%` }}
                              title={`Use saved section ${inches.toFixed(3)} in`}
                              aria-label={`Use saved section ${inches.toFixed(3)} inches`}
                              onClick={() => setRebarStart(coordinate)}
                            >
                              ▲
                            </button>
                          );
                        })}
                      </div>
                      <input
                        aria-label="Start section position"
                        type="range"
                        min={rebarPlaneBounds[0] * inchesPerModelUnit}
                        max={rebarPlaneBounds[1] * inchesPerModelUnit}
                        step={0.25}
                        value={rebarStart * inchesPerModelUnit}
                        onChange={(event) =>
                          setRebarStart(
                            Number(event.target.value) / inchesPerModelUnit,
                          )
                        }
                      />
                    </div>
                    <button
                      className="button primary wide"
                      onClick={confirmRebarStartSection}
                    >
                      {editingRebarRunId ? "Update Section" : "Confirm Section"}
                    </button>
                  </section>
                )}

                {rebarPhase === "lines" && (
                  <section className="rebar-step">
                    <span className="eyebrow">BAR SHAPE</span>
                    <div className="selection-callout">
                      <strong>Draw the complete bar</strong>
                      <span>
                        Grey = {rebarCoverOffsetInches}″ cover · pink ={" "}
                        {rebarSecondaryOffsetInches}″ cover · vertices snap
                        firmly · guide lines and plane horizontal/vertical
                        directions snap gently.
                      </span>
                    </div>
                    {pendingRebarLine && (
                      <small>
                        {pendingRebarLine.points.length} point(s) · Backspace
                        removes the last point
                      </small>
                    )}
                    {editingRebarRunId &&
                      pendingRebarLine &&
                      pendingRebarLine.points.length > 0 && (
                        <button
                          className="text-button"
                          onClick={() =>
                            setPendingRebarLine({
                              ...pendingRebarLine,
                              points: [],
                            })
                          }
                        >
                          Replace shape
                        </button>
                      )}
                    <button
                      className="button primary wide"
                      disabled={
                        !pendingRebarLine ||
                        pendingRebarLine.points.length < 2
                      }
                      onClick={() => {
                        if (!pendingRebarLine) return;
                        setRebarLines([pendingRebarLine]);
                        setPendingRebarLine(null);
                        if (activeLappedWorkflow) {
                          const anchor = pendingRebarLine.points[0];
                          setRebarPathStart(anchor);
                          setRebarPathEnd(null);
                          setRebarPhase("end");
                          setStatus(
                            "Bar shape confirmed. Confirm or update the suggested end section.",
                          );
                        } else {
                          if (!editingRebarRunId) {
                            setRebarPathStart(null);
                            setRebarPathEnd(null);
                          }
                          setRebarPhase("path-start");
                        }
                      }}
                    >
                      {editingRebarRunId ? "Update Rebar Shape" : "Confirm Rebar"}
                    </button>
                  </section>
                )}

                {rebarPhase === "path-start" && (
                  <section className="rebar-step">
                    <span className="eyebrow">SPACING PATH · START</span>
                    <div className="selection-callout">
                      <strong>Pick an anchor on the completed bar</strong>
                      <span>
                        Vertices snap firmly; points along the bar snap
                        gently. Every copy will place this anchor on the
                        spacing path.
                      </span>
                    </div>
                    {editingRebarRunId && rebarPathStart && (
                      <button
                        className="button primary wide"
                        onClick={() => {
                          setRebarPhase("end");
                          setStatus(
                            "Existing start anchor retained. Confirm the end section.",
                          );
                        }}
                      >
                        Keep Existing Anchor
                      </button>
                    )}
                  </section>
                )}

                {rebarPhase === "end" && (
                  <section className="rebar-step">
                    <span className="eyebrow">END SECTION</span>
                    <label>
                      Position (in)
                      <input
                        type="number"
                        min={rebarPlaneBounds[0] * inchesPerModelUnit}
                        max={rebarPlaneBounds[1] * inchesPerModelUnit}
                        step={0.25}
                        value={Number(
                          (
                            rebarEnd * inchesPerModelUnit
                          ).toFixed(3),
                        )}
                        onChange={(event) =>
                          setRebarEnd(Number(event.target.value) / inchesPerModelUnit)
                        }
                      />
                    </label>
                    <div className="range-with-markers">
                      <div className="section-markers">
                        {rebarSectionBookmarks.map((coordinate) => {
                          const span =
                            rebarPlaneBounds[1] - rebarPlaneBounds[0];
                          const left =
                            span <= 0
                              ? 0
                              : ((coordinate -
                                    rebarPlaneBounds[0]) /
                                  span) *
                                100;
                          const inches = coordinate * inchesPerModelUnit;
                          return (
                            <button
                              type="button"
                              key={coordinate}
                              style={{ left: `${left}%` }}
                              title={`Return to ${inches.toFixed(3)} in`}
                              aria-label={`Return to saved end section ${inches.toFixed(3)} inches`}
                              onClick={() => setRebarEnd(coordinate)}
                            >
                              ▲
                            </button>
                          );
                        })}
                      </div>
                      <input
                        aria-label="End section position"
                        type="range"
                        min={rebarPlaneBounds[0] * inchesPerModelUnit}
                        max={rebarPlaneBounds[1] * inchesPerModelUnit}
                        step={0.25}
                        value={
                          rebarEnd * inchesPerModelUnit
                        }
                        onChange={(event) =>
                          setRebarEnd(Number(event.target.value) / inchesPerModelUnit)
                        }
                      />
                    </div>
                    {activeLappedWorkflow && (
                      <div className="bar-number-field">
                        <span className="eyebrow">BAR NUMBER</span>
                        <div className="bar-number-buttons">
                          {["5", "6", "7", "8", "9", "10"].map((number) => (
                            <button
                              type="button"
                              key={number}
                              className={
                                rebarBarNumber === number ? "active" : ""
                              }
                              onClick={() => setRebarBarNumber(number)}
                            >
                              #{number}
                            </button>
                          ))}
                        </div>
                        <label>
                          Other
                          <input
                            value={rebarBarNumber}
                            onChange={(event) =>
                              setRebarBarNumber(
                                event.target.value.replace(
                                  /[^0-9A-Za-z.-]/g,
                                  "",
                                ),
                              )
                            }
                          />
                        </label>
                      </div>
                    )}
                    <button
                      className="button primary wide"
                      onClick={() => {
                        if (activeLappedWorkflow) {
                          finishLappedRebar();
                        } else {
                          setRebarPhase("path-end");
                        }
                      }}
                    >
                      {activeLappedWorkflow
                        ? editingRebarRunId
                          ? "Update Lapped Bar"
                          : "Finish Lapped Bar"
                        : "Confirm Section"}
                    </button>
                  </section>
                )}

                {rebarPhase === "path-end" && (
                  <section className="rebar-step">
                    <span className="eyebrow">SPACING PATH · END</span>
                    <div className="selection-callout">
                      <strong>Pick the path endpoint</strong>
                      <span>
                        Click a dashed-outline vertex or any point on the end
                        section. The selected bar anchor will follow the line
                        between the two points.
                      </span>
                    </div>
                    {editingRebarRunId && rebarPathEnd && (
                      <button
                        className="button primary wide"
                        onClick={() => {
                          if (displayRebarPlane) {
                            const retained = projectToPlaneOffset(
                                rebarPathEnd,
                                displayRebarPlane.origin,
                                displayRebarPlane.normal,
                                rebarEnd,
                              );
                            setRebarPathEnd(retained);
                            setRebarPathPoints((current) =>
                              current.length
                                ? [...current.slice(0, -1), retained]
                                : current,
                            );
                          }
                          setRebarPhase("path-review");
                          setStatus(
                            "Existing path endpoint retained. Review the path.",
                          );
                        }}
                      >
                        Keep Existing Endpoint
                      </button>
                    )}
                  </section>
                )}

                {rebarPhase === "path-review" && (
                  <section className="rebar-step">
                    <span className="eyebrow">SPACING PATH</span>
                    <div className="path-keypoint-summary">
                      <strong>{rebarPathPoints.length} keypoints</strong>
                      <span>
                        The bar copies will follow each segment in order.
                      </span>
                    </div>
                    <div className="rebar-step-actions">
                      <button
                        className="button"
                        onClick={() => {
                          setRebarPhase("end");
                          setStatus(
                            "Choose the next plane depth, then pick its anchor.",
                          );
                        }}
                        title="Continue the distribution path through another section"
                      >
                        Add another keypoint
                      </button>
                      <button
                        className="button primary"
                        onClick={() => {
                          setRebarPhase("spacing");
                          setStatus("Path complete. Confirm the bar run details.");
                        }}
                        title="Use the current multipoint path"
                      >
                        Complete Path
                      </button>
                    </div>
                  </section>
                )}

                {rebarPhase === "spacing" && (
                  <section className="rebar-step">
                    <span className="eyebrow">SPACING</span>
                    <label>
                      Run name
                      <input
                        value={rebarName}
                        onChange={(event) => setRebarName(event.target.value)}
                      />
                    </label>
                    <label>
                      Bar spacing (in)
                      <input
                        type="number"
                        min={0.01}
                        step={0.125}
                        value={rebarSpacing}
                        onChange={(event) =>
                          setRebarSpacing(Number(event.target.value))
                        }
                      />
                    </label>
                    <div className="bar-number-field">
                      <span className="eyebrow">BAR NUMBER</span>
                      <div className="bar-number-buttons">
                        {["5", "6", "7", "8", "9", "10"].map((number) => (
                          <button
                            type="button"
                            key={number}
                            className={rebarBarNumber === number ? "active" : ""}
                            onClick={() => setRebarBarNumber(number)}
                          >
                            #{number}
                          </button>
                        ))}
                      </div>
                      <label>
                        Other
                        <input
                          value={rebarBarNumber}
                          onChange={(event) =>
                            setRebarBarNumber(
                              event.target.value.replace(/[^0-9A-Za-z.-]/g, ""),
                            )
                          }
                        />
                      </label>
                    </div>
                    <small>
                      Bars follow the selected anchor path and finish exactly
                      at its endpoint.
                    </small>
                    <button
                      className="button primary wide"
                      onClick={() => finishRebarRun()}
                    >
                      {editingRebarRunId ? "Update Bar" : "Really Finish Bar"}
                    </button>
                  </section>
                )}

                {rebarRuns.length > 0 && (
                  <section className="face-list-section">
                    <div className="section-heading">
                      <span className="eyebrow">BAR RUNS</span>
                      <strong>{rebarRuns.length}</strong>
                    </div>
                    <div className="bar-run-list">
                      {rebarGroups.map((group) => {
                        const groupRuns = rebarRuns.filter(
                          (run) => run.groupId === group.id,
                        );
                        const collapsed = collapsedRebarGroupIds.has(group.id);
                        return (
                          <div
                            className="bar-run-group"
                            key={group.id}
                            onDragOver={(event) => {
                              if (
                                event.dataTransfer.types.includes(
                                  "application/x-mct-rebar-run",
                                )
                              ) {
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                              }
                            }}
                            onDrop={(event) => {
                              const runId = event.dataTransfer.getData(
                                "application/x-mct-rebar-run",
                              );
                              if (!runId) return;
                              event.preventDefault();
                              moveRebarRunToGroup(runId, group.id);
                            }}
                          >
                            <div className="bar-run-group-header">
                              <button
                                type="button"
                                onClick={() =>
                                  setCollapsedRebarGroupIds((current) => {
                                    const next = new Set(current);
                                    if (next.has(group.id)) next.delete(group.id);
                                    else next.add(group.id);
                                    return next;
                                  })
                                }
                              >
                                <span>{collapsed ? "▸" : "▾"}</span>
                                <strong>{group.name}</strong>
                                <small>{groupRuns.length}</small>
                              </button>
                              <label title="Show or hide this group">
                                <input
                                  type="checkbox"
                                  checked={group.visible}
                                  onChange={(event) =>
                                    setRebarGroups((current) =>
                                      current.map((candidate) =>
                                        candidate.id === group.id
                                          ? {
                                              ...candidate,
                                              visible: event.target.checked,
                                            }
                                          : candidate,
                                      ),
                                    )
                                  }
                                />
                              </label>
                            </div>
                            {!collapsed &&
                              groupRuns.map((run) =>
                                renderRebarRunButton(run),
                              )}
                          </div>
                        );
                      })}
                      <div
                        className="bar-run-ungrouped"
                        onDragOver={(event) => {
                          if (
                            event.dataTransfer.types.includes(
                              "application/x-mct-rebar-run",
                            )
                          ) {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                          }
                        }}
                        onDrop={(event) => {
                          const runId = event.dataTransfer.getData(
                            "application/x-mct-rebar-run",
                          );
                          if (!runId) return;
                          event.preventDefault();
                          moveRebarRunToGroup(runId, undefined);
                        }}
                      >
                        {rebarRuns
                          .filter(
                            (run) =>
                              !run.groupId ||
                              !rebarGroups.some(
                                (group) => group.id === run.groupId,
                              ),
                          )
                          .map((run) => renderRebarRunButton(run))}
                      </div>
                    </div>
                    <button
                      className="button wide add-group-button"
                      data-rebar-selection-control
                      onClick={addRebarGroup}
                    >
                      Add Group
                    </button>
                    {rebarPhase === "idle" && selectedRebarRun && (
                      <button
                        className="button wide bar-run-edit"
                        data-rebar-selection-control
                        onClick={() => beginEditRebar(selectedRebarRun)}
                      >
                        Edit Bar
                      </button>
                    )}
                    {rebarPhase === "idle" &&
                      selectedRebarRunIds.size > 0 && (
                        <div
                          className="rebar-color-picker"
                          data-rebar-selection-control
                        >
                          <span className="eyebrow">BAR COLOR</span>
                          <div>
                            {REBAR_COLORS.map((color) => (
                              <button
                                type="button"
                                key={color}
                                style={{ background: color }}
                                title={`Set selected bars to ${color}`}
                                aria-label={`Set selected bars to ${color}`}
                                onClick={() =>
                                  setRebarRuns((current) =>
                                    current.map((candidate) =>
                                      selectedRebarRunIds.has(candidate.id)
                                        ? { ...candidate, color }
                                        : candidate,
                                    ),
                                  )
                                }
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    <button
                      className="danger-button bar-run-delete"
                      data-rebar-selection-control
                      disabled={
                        rebarPhase !== "idle" ||
                        !selectedRebarRunIds.size
                      }
                      onClick={() => {
                        if (!selectedRebarRunIds.size) return;
                        setRebarRuns((current) =>
                          current.filter(
                            (run) => !selectedRebarRunIds.has(run.id),
                          ),
                        );
                        setSelectedRebarRunIds(new Set());
                      }}
                    >
                      Delete selected bar run
                      {selectedRebarRunIds.size === 1 ? "" : "s"}
                    </button>
                  </section>
                )}
                <button
                  className="button wide export-quantity"
                  disabled={!rebarRuns.length}
                  onClick={exportRebarQuantities}
                >
                  Export Rebar Quantity
                </button>
              </>
            )}
          </div>
        )}

        {activeTab !== "rebar" && activeTab !== "slicing" && (
        <section className="node-card condensed">
          <span className="eyebrow">SELECTED NODE</span>
          {selectedNode ? (
            <>
              <div className="node-id">#{selectedNode.id}</div>
              <dl>
                {(["x", "y", "z"] as const).map((axis) => (
                  <div key={axis}>
                    <dt>
                      {selectedNode.local
                        ? `L${axis.toUpperCase()}`
                        : axis.toUpperCase()}
                    </dt>
                    <dd>
                      {formatCoordinate(
                        (selectedNode.local ?? selectedNode.global)[axis],
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          ) : (
            <p>Click a point to inspect it.</p>
          )}
        </section>
        )}

        {(activeTab === "slicing" || activeTab === "rebar") &&
          slicePins.length > 0 && (
            <section className="slice-pin-dock" aria-label="Pinned slices">
              <span>PINS</span>
              <div>
                {slicePins.map((pin) => (
                  <button
                    key={pin.id}
                    className={`${activeSlicePinId === pin.id ? "active" : ""} ${
                      pin.viewpoint ? "has-viewpoint" : ""
                    }`}
                    onClick={() => activateSlicePin(pin)}
                    title={
                      pin.viewpoint
                        ? `${pin.name}: apply slice and saved viewpoint`
                        : `${pin.name}: apply slice`
                    }
                  >
                    {pin.name}
                  </button>
                ))}
                <button
                  className="clear-pinned-slice"
                  onClick={() => setActiveSlicePinId(null)}
                >
                  Clear
                </button>
              </div>
            </section>
          )}

        <footer className="rail-footer">
          <span>{status}</span>
          <span>Three.js · browser only</span>
        </footer>
      </aside>

      <section className="viewport">
        <PointCloudViewport
          nodes={displayNodes}
          allNodes={allNodes}
          slice={renderSlice}
          basis={basis}
          faces={faces}
          previewFace={smartPreviewFace}
          draftNodeIds={draftNodeIds}
          selectedNodeIds={selectedNodeIds}
          invalidNodeIds={invalidDraftNodeIds}
          selectedFaceIds={[...selectedFaceIds]}
          hoveredFaceId={hoveredFaceId}
          floorFaceId={floorFaceId}
          orbitTarget={floorOrbitTarget}
          editableFaceId={editableFace?.id ?? null}
          volumeConfirmed={volumeConfirmed}
          pickTarget={
            (activeTab === "coordinates" && !floorFaceId) ||
            (activeTab === "volume" &&
              !definingFaces &&
              !smartSelecting)
              ? "face"
              : "node"
          }
          tolerance={tolerance}
          elementSurfaces={elementSkin.surfaces}
          elements={elements}
          showElementSkin={showElementSkin}
          slicingMode={activeTab === "slicing"}
          sliceBounds={currentBounds}
          rebarMode={activeTab === "rebar"}
          showRebarScene={
            activeTab === "rebar" ||
            (activeTab === "slicing" && showRebarInSlicing) ||
            (activeTab === "slicing" &&
              displayRebarPlanePreviews.length > 0)
          }
          customSlicePlane={activeCustomSlice}
          viewpointCaptureRequest={viewpointCaptureRequest}
          viewpointToApply={viewpointToApply}
          onViewpointCaptured={handleViewpointCaptured}
          showRebarPlaneNodes={rebarPhase === "plane-create"}
          rebarRuns={
            activeTab === "slicing" && !showRebarInSlicing
              ? []
              : visibleRebarRuns
          }
          selectedRebarRunIds={selectedRebarRunIds}
          showRebarLabels={showRebarLabels}
          rebarGuideLines={
            pendingRebarLine || rebarPhase === "path-end"
              ? rebarGuideLines
              : []
          }
          rebarInnerGuideLines={
            pendingRebarLine || rebarPhase === "path-end"
              ? rebarInnerGuideLines
              : []
          }
          rebarOuterEdges={null}
          selectedRebarEdgeIndex={null}
          rebarEdgeSelectionMode={false}
          onPickRebarEdge={() => undefined}
          pendingRebarLine={pendingRebarLine}
          draftRebarLines={rebarLines}
          rebarSnapLines={
            pendingRebarLine
              ? [...rebarGuideLines, ...rebarInnerGuideLines]
              : rebarPhase === "path-start"
                ? rebarLines
                : rebarPhase === "path-end"
                  ? [...rebarGuideLines, ...rebarInnerGuideLines]
                  : []
          }
          rebarSnapRequired={rebarPhase === "path-start"}
          rebarPreviewStart={
            rebarPhase === "path-end" ? rebarPathStart : null
          }
          rebarPathStart={rebarPathStart}
          rebarPathEnd={rebarPathEnd}
          rebarPathPoints={rebarPathPoints}
          rebarAxis={rebarAxis}
          rebarDrawingPlane={
            displayRebarPlane && activeRebarPlane
              ? {
                  ...displayRebarPlane,
                  color: activeRebarPlane.color,
                }
              : null
          }
          rebarPlanePreviews={displayRebarPlanePreviews}
          rebarSection={
            activeTab !== "rebar" ||
            rebarPhase === "idle" ||
            rebarPhase === "lap-source" ||
            rebarPhase === "plane" ||
            rebarPhase === "plane-create"
              ? null
              : rebarPhase === "end" ||
                  rebarPhase === "path-end" ||
                  rebarPhase === "path-review" ||
                  rebarPhase === "spacing"
                ? rebarEnd
                : rebarStart
          }
          inchesPerModelUnit={inchesPerModelUnit}
          showConcreteSkin={showConcreteSkin}
          lineAndBar={lineAndBar}
          rebarDrawing={
            Boolean(pendingRebarLine) ||
            rebarPhase === "path-start" ||
            rebarPhase === "path-end"
          }
          showAxes={activeTab === "volume" || activeTab === "slicing"}
          onPickRebarPoint={pickRebarWorkflowPoint}
          elementEditMode={elementEditMode}
          selectedElementIds={[...selectedElementIds]}
          onPickElement={toggleElementSelection}
          onHover={setHover}
          onHoverFace={setHoveredFaceId}
          onPickNode={handleNodePick}
          onPickFace={handleFacePick}
          onRemoveFaceVertex={removeFaceVertex}
          onInsertFaceVertex={insertFaceVertex}
        />

        <div className="view-hud top-left">
          <span
            className={`mode-indicator ${
              definingFaces || smartSelecting || activeTab === "coordinates"
                ? "picking"
                : ""
            }`}
          />
          <strong>{instruction}</strong>
          <span>Left drag: horizontal orbit · vertical tilt · Middle pan · Scroll zoom</span>
        </div>

        <div className="axis-badge" aria-label="Local axis legend">
          <span className="axis-x">X</span>
          <span className="axis-y">Y</span>
          <span className="axis-z">Z</span>
          <small>{basis ? "LOCAL" : "MODEL"}</small>
        </div>

        {hover && (
          <div
            className={`hover-label ${
              editableFace?.nodeIds.includes(hover.node.id)
                ? "delete-ready"
                : ""
            }`}
            style={{ left: hover.clientX + 14, top: hover.clientY + 14 }}
          >
            <strong>NODE {hover.node.id}</strong>
            {editableFace?.nodeIds.includes(hover.node.id) && (
              <b className="delete-symbol" aria-hidden="true">
                ×
              </b>
            )}
            <span>
              {(["x", "y", "z"] as const)
                .map((axis) =>
                  formatCoordinate((hover.node.local ?? hover.node.global)[axis]),
                )
                .join(" · ")}
            </span>
            {editableFace?.nodeIds.includes(hover.node.id) && (
              <span>Right-click to remove vertex</span>
            )}
          </div>
        )}
      </section>

      {dragging && (
        <div className="drop-overlay">
          <div>
            <span className="drop-icon">↓</span>
            <strong>Drop MCT file</strong>
            <small>The *NODE section will be parsed locally</small>
          </div>
        </div>
      )}

      {confirmWarning && (
        <div className="modal-backdrop">
          <div className="confirm-modal" role="dialog" aria-modal="true">
            <span className="eyebrow">OPEN VOLUME</span>
            <h2>The faces do not fully enclose a volume</h2>
            <p>
              Add or adjust faces to close every side. You can continue, but
              outside-node removal and solid shading may be incomplete.
            </p>
            <div>
              <button
                className="button"
                onClick={() => setConfirmWarning(false)}
              >
                Go back
              </button>
              <button
                className="button primary"
                onClick={() => {
                  setConfirmWarning(false);
                  setVolumeConfirmed(true);
                  setDefiningFaces(false);
                  setStatus("Open volume accepted with warning.");
                }}
              >
                Continue anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
    </main>
  );
}
