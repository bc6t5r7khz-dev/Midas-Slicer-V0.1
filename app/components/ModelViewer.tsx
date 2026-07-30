"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
} from "react";
import {
  createBasisFromFloor,
  getBounds,
  reframeDirection,
  reframePoint,
  transformNodes,
} from "../lib/coordinateSystem";
import { parseMctModel } from "../lib/mctParser";
import { buildElementSkin } from "../lib/elementSkin";
import {
  createPlaneCoverOutlines,
  distributeBars,
} from "../lib/rebarGeometry";
import {
  generateRebarInstances,
  rebarInstanceLength,
} from "../lib/rebarAdvanced";
import { createSampleMct } from "../lib/sampleModel";
import { smartFaceFromSeed } from "../lib/smartSelect";
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
  RebarEndpointAnchor,
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

function DraftNumberInput({
  value,
  onValueChange,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: number;
  onValueChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(String(value));
    }
  }, [value]);

  const commit = (text: string) => {
    const parsed = Number(text);
    if (text.trim() !== "" && Number.isFinite(parsed)) {
      onValueChange(parsed);
      return true;
    }
    return false;
  };

  return (
    <input
      {...props}
      ref={inputRef}
      type="number"
      value={draft}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        commit(next);
      }}
      onBlur={() => {
        if (!commit(draft)) setDraft(String(value));
      }}
    />
  );
}

const TABS: Array<{ id: WorkflowTab; label: string }> = [
  { id: "setup", label: "Setup" },
  { id: "slicing", label: "Slicing" },
  { id: "rebar", label: "Rebar" },
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

const polylineLength = (points: Vec3[]) =>
  points.slice(1).reduce((total, point, index) => {
    const previous = points[index];
    return (
      total +
      Math.hypot(
        point.x - previous.x,
        point.y - previous.y,
        point.z - previous.z,
      )
    );
  }, 0);

const nearlyEqual = (a: number, b: number, epsilon = 1e-7) =>
  Math.abs(a - b) <= epsilon;

const samePoint = (a: Vec3 | null | undefined, b: Vec3 | null | undefined) =>
  (!a && !b) ||
  Boolean(
    a &&
      b &&
      nearlyEqual(a.x, b.x) &&
      nearlyEqual(a.y, b.y) &&
      nearlyEqual(a.z, b.z),
  );

const samePointList = (
  a: Vec3[] | null | undefined,
  b: Vec3[] | null | undefined,
) => {
  const left = a ?? [];
  const right = b ?? [];
  return (
    left.length === right.length &&
    left.every((point, index) => samePoint(point, right[index]))
  );
};

const sameRebarLine = (
  a: RebarLine | null | undefined,
  b: RebarLine | null | undefined,
) =>
  (!a && !b) ||
  Boolean(
    a &&
      b &&
      a.closed === b.closed &&
      samePointList(a.points, b.points),
  );

const sameEndpointAnchors = (
  a: RebarEndpointAnchor[] | null | undefined,
  b: RebarEndpointAnchor[] | null | undefined,
) => {
  const left = a ?? [];
  const right = b ?? [];
  return (
    left.length === right.length &&
    left.every(
      (anchor, index) =>
        nearlyEqual(anchor.fraction, right[index].fraction) &&
        samePoint(anchor.point, right[index].point),
    )
  );
};

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
  const endpointAnchors =
    run.advanced?.variableLength?.endpointAnchors.map((anchor) => {
      const objectPoint =
        anchor.objectPoint ??
        reframePoint(anchor.point, fromBasis, null);
      return {
        ...anchor,
        objectPoint,
        point: reframePoint(objectPoint, null, toBasis),
      };
    }) ?? [];
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
    advanced: run.advanced
      ? {
          ...run.advanced,
          variableLength: run.advanced.variableLength
            ? {
                endpointAnchors,
              }
            : undefined,
        }
      : undefined,
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

const structuredBarMark = (run: RebarRun) => {
  if (run.series !== undefined || run.suffix !== undefined) {
    return {
      series: run.series ?? "101",
      suffix: run.suffix ?? "",
    };
  }
  const barNumber = run.barNumber ?? "5";
  const prefix = `#${barNumber}`;
  const remainder = run.name.startsWith(prefix)
    ? run.name.slice(prefix.length)
    : run.name;
  const match = remainder.match(/^(\d+)(.*)$/);
  return {
    series: match?.[1] ?? "101",
    suffix: match?.[2] ?? "E",
  };
};

const nextBarMark = (runs: RebarRun[]) => {
  const parsed = runs.flatMap((run) => {
    if (run.series !== undefined || run.suffix !== undefined) {
      return [structuredBarMark(run)];
    }
    const prefix = `#${run.barNumber ?? "5"}`;
    return run.name.startsWith(prefix) &&
      /^\d+/.test(run.name.slice(prefix.length))
      ? [structuredBarMark(run)]
      : [];
  });
  const highest = parsed.reduce((current, mark) => {
    const value = Number.parseInt(mark.series, 10);
    return Number.isFinite(value) ? Math.max(current, value) : current;
  }, 100);
  return {
    series: String(highest + 1),
    suffix: parsed[parsed.length - 1]?.suffix ?? "E",
  };
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

const orientRebarProjectInward = (
  runs: RebarRun[],
  planes: RebarPlane[],
  nodes: Array<Pick<ModelNode, "global">>,
) => {
  if (!nodes.length) return { runs, planes };
  const center = nodes.reduce(
    (sum, node) => ({
      x: sum.x + node.global.x / nodes.length,
      y: sum.y + node.global.y / nodes.length,
      z: sum.z + node.global.z / nodes.length,
    }),
    { x: 0, y: 0, z: 0 },
  );
  const flipped = new Set<string>();
  const orientedPlanes = planes.map((plane) => {
    const towardCenter = subtract(center, plane.objectOrigin);
    if (dot(towardCenter, plane.objectNormal) >= 0) return plane;
    flipped.add(plane.id);
    return {
      ...plane,
      objectNormal: {
        x: -plane.objectNormal.x,
        y: -plane.objectNormal.y,
        z: -plane.objectNormal.z,
      },
    };
  });
  const orientedRuns = runs.map((run) =>
    run.planeId && flipped.has(run.planeId)
      ? {
          ...run,
          startOffset:
            run.startOffset === undefined ? undefined : -run.startOffset,
          endOffset: run.endOffset === undefined ? undefined : -run.endOffset,
          start: -run.start,
          end: -run.end,
        }
      : run,
  );
  return { runs: orientedRuns, planes: orientedPlanes };
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
  const [fileName, setFileName] = useState("No model imported");
  const [globalBounds, setGlobalBounds] = useState<Bounds | null>(null);
  const [activeTab, setActiveTab] = useState<WorkflowTab>("setup");
  const [setupStep, setSetupStep] = useState<1 | 2 | 3 | 4 | 5 | 6>(1);
  const [volumeDefinitionMode, setVolumeDefinitionMode] = useState<
    "auto" | "manual"
  >("auto");
  const [faces, setFaces] = useState<VolumeFace[]>([]);
  const [definingFaces, setDefiningFaces] = useState(false);
  const [smartSelecting, setSmartSelecting] = useState(false);
  const smartVariant = "classic" as const;
  const smartAxis = "x" as const;
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
  const [coordinateStep, setCoordinateStep] = useState<
    "idle" | "floor" | "x" | "scale"
  >("floor");
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
  const [slicingSubtab, setSlicingSubtab] = useState<"planes" | "slice">(
    "planes",
  );
  const [selectedSlicingPlaneId, setSelectedSlicingPlaneId] =
    useState<string | null>(null);
  const [selectedSlicingPlaneIds, setSelectedSlicingPlaneIds] = useState<
    Set<string>
  >(new Set());
  const [slicingPlaneOffset, setSlicingPlaneOffset] = useState(0);
  const [slicePreviewActive, setSlicePreviewActive] = useState(false);
  const [flipSliceSection, setFlipSliceSection] = useState(true);
  const [slicePins, setSlicePins] = useState<SlicePin[]>([]);
  const [selectedSlicePinId, setSelectedSlicePinId] =
    useState<string | null>(null);
  const [selectedSlicePinIds, setSelectedSlicePinIds] = useState<Set<string>>(
    new Set(),
  );
  const [renamingSliceId, setRenamingSliceId] = useState<string | null>(null);
  const [activeSlicePinId, setActiveSlicePinId] = useState<string | null>(null);
  const [showRebarInSlicing, setShowRebarInSlicing] = useState(false);
  const [showAllPlanes, setShowAllPlanes] = useState(false);
  const [showAllFavoritePlanes, setShowAllFavoritePlanes] = useState(false);
  const [pinAddedNotice, setPinAddedNotice] = useState<string | null>(null);
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
  const [groupDraftOpen, setGroupDraftOpen] = useState(false);
  const [groupDraftName, setGroupDraftName] = useState("");
  const [groupPopoverPosition, setGroupPopoverPosition] = useState({
    left: 0,
    top: 0,
  });
  const [renamingRebarGroupId, setRenamingRebarGroupId] =
    useState<string | null>(null);
  const [renamingRebarRunId, setRenamingRebarRunId] =
    useState<string | null>(null);
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
  const [rebarBarNumber, setRebarBarNumber] = useState("5");
  const [rebarSeries, setRebarSeries] = useState("101");
  const [rebarSuffix, setRebarSuffix] = useState("E");
  const [rebarAxis, setRebarAxis] = useState<Axis>("x");
  const [rebarStart, setRebarStart] = useState(0);
  const [rebarEnd, setRebarEnd] = useState(0);
  const [rebarLines, setRebarLines] = useState<RebarLine[]>([]);
  const [pendingRebarLine, setPendingRebarLine] =
    useState<RebarLine | null>(null);
  const [rebarSpacing, setRebarSpacing] = useState(12);
  const [customSpacingDraft, setCustomSpacingDraft] = useState("");
  const [rebarPathStart, setRebarPathStart] = useState<Vec3 | null>(null);
  const [rebarPathEnd, setRebarPathEnd] = useState<Vec3 | null>(null);
  const [rebarPathPoints, setRebarPathPoints] = useState<Vec3[]>([]);
  const [advancedRebarOpen, setAdvancedRebarOpen] = useState(false);
  const [rebarSplayEnabled, setRebarSplayEnabled] = useState(false);
  const [rebarSplayTargetPlaneId, setRebarSplayTargetPlaneId] =
    useState<string | null>(null);
  const [rebarSplayTargetOffset, setRebarSplayTargetOffset] = useState(0);
  const [choosingSplayPlane, setChoosingSplayPlane] = useState(false);
  const [hoveredSplayPlaneId, setHoveredSplayPlaneId] =
    useState<string | null>(null);
  const [rebarSplayScope, setRebarSplayScope] =
    useState<"all" | "last">("all");
  const [rebarSplayLastCount, setRebarSplayLastCount] = useState(5);
  const [rebarVariableLengthEnabled, setRebarVariableLengthEnabled] =
    useState(false);
  const [rebarEndpointAnchors, setRebarEndpointAnchors] = useState<
    RebarEndpointAnchor[]
  >([]);
  const [advancedAnchorPickingId, setAdvancedAnchorPickingId] =
    useState<string | null>(null);
  const [shiftPlaneSnapActive, setShiftPlaneSnapActive] = useState(false);
  const [selectedRebarRunIds, setSelectedRebarRunIds] = useState<Set<string>>(
    new Set(),
  );
  const [colorPopoverRunId, setColorPopoverRunId] =
    useState<string | null>(null);
  const [colorPopoverPosition, setColorPopoverPosition] = useState({
    left: 0,
    top: 0,
  });
  const [openHeaderMenu, setOpenHeaderMenu] = useState<
    "file" | "parameters" | "view" | null
  >(null);
  const rebarName = `#${rebarBarNumber || "5"}${rebarSeries}${rebarSuffix}`;

  useEffect(() => {
    const timer = window.setTimeout(() => setRenderSlice(slice), 55);
    return () => window.clearTimeout(timer);
  }, [slice]);

  const tolerance = globalBounds ? modelTolerance(globalBounds) : 1e-6;
  const elementSkin = useMemo(
    () => buildElementSkin(elements, allNodes),
    [allNodes, elements],
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
  const setupComplete = Boolean(
    allNodes.length &&
      volumeConfirmed &&
      floorFaceId &&
      basis &&
      inchesPerModelUnit,
  );
  const shapeEditingFaceId =
    activeTab === "setup" &&
    setupStep === 2 &&
    volumeDefinitionMode === "manual" &&
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
    let objectNormal = normalize(basis.zAxis);
    const modelCenter = allNodes.reduce(
      (sum, node) => ({
        x: sum.x + node.global.x / allNodes.length,
        y: sum.y + node.global.y / allNodes.length,
        z: sum.z + node.global.z / allNodes.length,
      }),
      { x: 0, y: 0, z: 0 },
    );
    const highest = allNodes.reduce((best, node) =>
      dot(node.global, objectNormal) > dot(best.global, objectNormal)
        ? node
        : best,
    );
    if (dot(subtract(modelCenter, highest.global), objectNormal) < 0) {
      objectNormal = {
        x: -objectNormal.x,
        y: -objectNormal.y,
        z: -objectNormal.z,
      };
    }
    setRebarPlanes((current) => [
      ...current,
      {
        id: "auto-top-horizontal",
        name: "Top Horizontal",
        color:
          PLANE_COLORS.find(
            (color) => !current.some((plane) => plane.color === color),
          ) ?? PLANE_COLORS[current.length % PLANE_COLORS.length],
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
  const activeSplayTargetPlane = useMemo(
    () =>
      rebarPlanes.find(
        (plane) => plane.id === rebarSplayTargetPlaneId,
      ) ?? null,
    [rebarPlanes, rebarSplayTargetPlaneId],
  );
  const displaySplayTargetPlane = useMemo(() => {
    if (!activeSplayTargetPlane) return null;
    return {
      origin: reframePoint(
        activeSplayTargetPlane.objectOrigin,
        null,
        basis,
      ),
      normal: normalize(
        reframeDirection(
          activeSplayTargetPlane.objectNormal,
          null,
          basis,
        ),
      ),
    };
  }, [activeSplayTargetPlane, basis]);
  const splayTargetPlaneBounds = useMemo<[number, number]>(() => {
    if (!displaySplayTargetPlane || !allNodes.length) return [0, 0];
    const values = allNodes.map((node) =>
      dot(
        subtract(
          node.local ?? node.global,
          displaySplayTargetPlane.origin,
        ),
        displaySplayTargetPlane.normal,
      ),
    );
    return [Math.min(...values), Math.max(...values)];
  }, [allNodes, displaySplayTargetPlane]);
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
    () => {
      if (selectedSlicePinIds.size !== 1) return null;
      const id = selectedSlicePinIds.values().next().value as string;
      return slicePins.find((pin) => pin.id === id) ?? null;
    },
    [selectedSlicePinIds, slicePins],
  );
  const activeSlicePin = useMemo(
    () => slicePins.find((pin) => pin.id === activeSlicePinId) ?? null,
    [activeSlicePinId, slicePins],
  );
  const activeCustomSlice = useMemo(() => {
    if (
      (activeTab === "rebar" && !activeSlicePin) ||
      (activeTab === "slicing" && !slicePreviewActive && !activeSlicePin)
    ) {
      return null;
    }
    const pin = activeSlicePin;
    const planeId = pin?.planeId ?? selectedSlicingPlaneId;
    const plane = rebarPlanes.find((candidate) => candidate.id === planeId);
    if (
      !plane ||
      (activeTab !== "slicing" && activeTab !== "rebar")
    ) {
      return null;
    }
    const baseNormal = normalize(
      reframeDirection(plane.objectNormal, null, basis),
    );
    const flipped = pin?.flipSection ?? flipSliceSection;
    return {
      origin: reframePoint(plane.objectOrigin, null, basis),
      normal: flipped
        ? { x: -baseNormal.x, y: -baseNormal.y, z: -baseNormal.z }
        : baseNormal,
      offset: flipped
        ? -(pin?.offset ?? slicingPlaneOffset)
        : pin?.offset ?? slicingPlaneOffset,
    };
  }, [
    activeSlicePin,
    activeTab,
    basis,
    flipSliceSection,
    rebarPlanes,
    selectedSlicingPlaneId,
    slicePreviewActive,
    slicingPlaneOffset,
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
      if (
        activeTab === "rebar" &&
        ((rebarPhase === "end" && choosingSplayPlane) ||
          rebarPhase === "spacing") &&
        rebarSplayEnabled &&
        (hoveredSplayPlaneId || activeSplayTargetPlane)
      ) {
        const plane =
          rebarPlanes.find(
            (candidate) => candidate.id === hoveredSplayPlaneId,
          ) ?? activeSplayTargetPlane!;
        return [
          {
            id: plane.id,
            color: plane.color,
            origin: reframePoint(
              plane.objectOrigin,
              null,
              basis,
            ),
            normal: normalize(
              reframeDirection(
                plane.objectNormal,
                null,
                basis,
              ),
            ),
            offset:
              plane.id === rebarSplayTargetPlaneId
                ? rebarSplayTargetOffset
                : 0,
            borderOnly: false,
          },
        ];
      }
      if (
        activeTab === "slicing" &&
        showAllPlanes
      ) {
        return rebarPlanes
          .map((plane) => ({
            id: plane.id,
            color: plane.color,
            origin: reframePoint(plane.objectOrigin, null, basis),
            normal: normalize(
              reframeDirection(plane.objectNormal, null, basis),
            ),
            offset:
              plane.id === selectedSlicingPlaneId ? slicingPlaneOffset : 0,
            borderOnly: true,
          }));
      }
      if (
        activeTab === "slicing" &&
        selectedSlicingPlaneIds.size
      ) {
        return rebarPlanes
          .filter((plane) => selectedSlicingPlaneIds.has(plane.id))
          .map((plane) => ({
            id: plane.id,
            color: plane.color,
            origin: reframePoint(plane.objectOrigin, null, basis),
            normal: normalize(
              reframeDirection(plane.objectNormal, null, basis),
            ),
            offset: 0,
            borderOnly: true,
          }));
      }
      if (activeTab === "slicing" && activeSlicePin) {
        const plane = rebarPlanes.find(
          (candidate) => candidate.id === activeSlicePin.planeId,
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
                offset: activeSlicePin.offset,
                borderOnly: true,
              },
            ]
          : [];
      }
      if (activeTab === "slicing" && selectedSlicingPlaneId) {
        const planeId = activeSlicePin?.planeId ?? selectedSlicingPlaneId;
        const plane = rebarPlanes.find((candidate) => candidate.id === planeId);
        const offset =
          activeSlicePin?.offset ??
          slicingPlaneOffset;
        return plane
          ? [
              {
                id: plane.id,
                color: plane.color,
                origin: reframePoint(plane.objectOrigin, null, basis),
                normal: normalize(
                  reframeDirection(plane.objectNormal, null, basis),
                ),
                offset,
                borderOnly: true,
              },
            ]
          : [];
      }
      if (
        activeTab === "rebar" &&
        rebarPhase === "idle" &&
        activeSlicePin
      ) {
        const plane = rebarPlanes.find(
          (candidate) => candidate.id === activeSlicePin.planeId,
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
                offset: activeSlicePin.offset,
                borderOnly: true,
              },
            ]
          : [];
      }
      if (
        activeTab === "rebar" &&
        rebarPhase === "idle" &&
        previewedRebarPlaneId
      ) {
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
      activeSplayTargetPlane,
      activeTab,
      basis,
      choosingSplayPlane,
      rebarPhase,
      rebarPlanes,
      rebarSplayEnabled,
      rebarSplayTargetOffset,
      rebarSplayTargetPlaneId,
      hoveredSplayPlaneId,
      previewedRebarPlaneId,
      selectedSlicingPlaneId,
      selectedSlicingPlaneIds,
      showAllPlanes,
      slicingPlaneOffset,
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
    setSelectedSlicingPlaneId(null);
    setSelectedSlicingPlaneIds(new Set());
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
      (run) =>
        run.id === rebarReferenceRunId ||
        !run.groupId ||
        visibility.get(run.groupId) !== false,
    );
  }, [rebarGroups, rebarReferenceRunId, rebarRuns]);
  const editingRebarRun = useMemo(
    () =>
      editingRebarRunId
        ? rebarRuns.find((run) => run.id === editingRebarRunId) ?? null
        : null,
    [editingRebarRunId, rebarRuns],
  );
  const editStartSectionChanged = Boolean(
    editingRebarRun &&
      !nearlyEqual(
        rebarStart,
        editingRebarRun.startOffset ?? editingRebarRun.start,
      ),
  );
  const editShapeChanged = Boolean(
    editingRebarRun &&
      !sameRebarLine(
        pendingRebarLine ?? rebarLines[0],
        editingRebarRun.lines[0],
      ),
  );
  const editEndSectionChanged = Boolean(
    editingRebarRun &&
      !nearlyEqual(
        rebarEnd,
        editingRebarRun.endOffset ?? editingRebarRun.end,
      ),
  );
  const editStartAnchorChanged = Boolean(
    editingRebarRun &&
      !samePoint(rebarPathStart, editingRebarRun.pathStart),
  );
  const editEndAnchorChanged = Boolean(
    editingRebarRun &&
      !samePoint(rebarPathEnd, editingRebarRun.pathEnd),
  );
  const editPathChanged = Boolean(
    editingRebarRun &&
      !samePointList(
        rebarPathPoints,
        editingRebarRun.pathPoints ??
          (editingRebarRun.pathStart && editingRebarRun.pathEnd
            ? [editingRebarRun.pathStart, editingRebarRun.pathEnd]
            : []),
      ),
  );
  const editDetailsChanged = Boolean(
    editingRebarRun &&
      (rebarName.trim() !== editingRebarRun.name ||
        rebarBarNumber.trim().replace(/^#/, "") !==
          (editingRebarRun.barNumber ?? "5") ||
        !nearlyEqual(rebarSpacing, editingRebarRun.spacingInches)),
  );
  const editAdvancedChanged = Boolean(
    editingRebarRun &&
      (rebarSplayEnabled !== Boolean(editingRebarRun.advanced?.splay) ||
        (rebarSplayEnabled &&
          (rebarSplayTargetPlaneId !==
            editingRebarRun.advanced?.splay?.targetPlaneId ||
            !nearlyEqual(
              rebarSplayTargetOffset,
              editingRebarRun.advanced?.splay?.targetOffset ?? 0,
            ) ||
            rebarSplayScope !==
              (editingRebarRun.advanced?.splay?.scope ?? "all") ||
            (rebarSplayScope === "last" &&
              Math.max(1, Math.round(rebarSplayLastCount)) !==
                Math.max(
                  1,
                  Math.round(editingRebarRun.advanced?.splay?.count ?? 1),
                )))) ||
        rebarVariableLengthEnabled !==
          Boolean(editingRebarRun.advanced?.variableLength) ||
        (rebarVariableLengthEnabled &&
          !sameEndpointAnchors(
            rebarEndpointAnchors,
            editingRebarRun.advanced?.variableLength?.endpointAnchors,
          ))),
  );
  const editingRebarChanged =
    editStartSectionChanged ||
    editShapeChanged ||
    editEndSectionChanged ||
    editStartAnchorChanged ||
    editEndAnchorChanged ||
    editPathChanged ||
    editDetailsChanged ||
    editAdvancedChanged;
  const activeLappedWorkflow =
    rebarWorkflowKind === "lap" ||
    Boolean(editingRebarRun?.lappedFromRunId);
  useEffect(() => {
    if (rebarPhase !== "end") return;
    const source =
      editingRebarRun ??
      (rebarReferenceRunId
        ? rebarRuns.find((run) => run.id === rebarReferenceRunId) ?? null
        : null);
    if (!source?.advanced?.splay) return;
    setChoosingSplayPlane(true);
    setRebarSplayEnabled(true);
    setPreviewedRebarPlaneId(null);
  }, [
    editingRebarRun,
    rebarPhase,
    rebarReferenceRunId,
    rebarRuns,
  ]);
  const draftAdvancedRun = useMemo<RebarRun | null>(() => {
    if (
      rebarPhase !== "spacing" ||
      !inchesPerModelUnit ||
      !rebarLines.length
    ) {
      return null;
    }
    const pathPoints =
      rebarPathPoints.length >= 2
        ? rebarPathPoints
        : rebarPathStart && rebarPathEnd
          ? [rebarPathStart, rebarPathEnd]
          : [];
    const pathLength = polylineLength(pathPoints);
    if (pathLength <= 1e-12) return null;
    const spacing = activeLappedWorkflow
      ? (rebarReferenceRunId
          ? rebarRuns.find((run) => run.id === rebarReferenceRunId)
              ?.spacingInches
          : undefined) ?? rebarSpacing
      : rebarSpacing;
    const pathDelta = subtract(
      pathPoints[pathPoints.length - 1],
      pathPoints[0],
    );
    const chordLength =
      Math.hypot(pathDelta.x, pathDelta.y, pathDelta.z) || 1;
    const positions = distributeBars(
      0,
      pathLength,
      spacing,
      inchesPerModelUnit,
    );
    return {
      id: "__advanced-draft__",
      name: rebarName,
      color: "#f04b43",
      barNumber: rebarBarNumber,
      planeId: activeRebarPlaneId,
      axis: rebarAxis,
      start: rebarStart,
      end: rebarEnd,
      startOffset: rebarStart,
      endOffset: rebarEnd,
      distributionMode: "path",
      distributionVector: {
        x: pathDelta.x / chordLength,
        y: pathDelta.y / chordLength,
        z: pathDelta.z / chordLength,
      },
      pathStart: pathPoints[0],
      pathEnd: pathPoints[pathPoints.length - 1],
      pathPoints,
      spacingInches: spacing,
      positions,
      lines: rebarLines,
      advanced:
        (rebarSplayEnabled && rebarSplayTargetPlaneId) ||
        (rebarVariableLengthEnabled && rebarEndpointAnchors.length >= 2)
          ? {
              splay:
                rebarSplayEnabled && rebarSplayTargetPlaneId
                  ? {
                      targetPlaneId: rebarSplayTargetPlaneId,
                      targetOffset: rebarSplayTargetOffset,
                      scope: rebarSplayScope,
                      count:
                        rebarSplayScope === "last"
                          ? Math.max(1, Math.round(rebarSplayLastCount))
                          : undefined,
                    }
                  : undefined,
              variableLength:
                rebarVariableLengthEnabled &&
                rebarEndpointAnchors.length >= 2
                  ? { endpointAnchors: rebarEndpointAnchors }
                  : undefined,
            }
          : undefined,
    };
  }, [
    activeLappedWorkflow,
    activeRebarPlaneId,
    inchesPerModelUnit,
    rebarAxis,
    rebarBarNumber,
    rebarEnd,
    rebarEndpointAnchors,
    rebarLines,
    rebarName,
    rebarPathEnd,
    rebarPathPoints,
    rebarPathStart,
    rebarPhase,
    rebarReferenceRunId,
    rebarRuns,
    rebarSpacing,
    rebarSplayEnabled,
    rebarSplayLastCount,
    rebarSplayScope,
    rebarSplayTargetPlaneId,
    rebarSplayTargetOffset,
    rebarStart,
    rebarVariableLengthEnabled,
  ]);
  const advancedAnchorSection = useMemo(() => {
    if (!advancedAnchorPickingId) return null;
    const anchor = rebarEndpointAnchors.find(
      (candidate) => candidate.id === advancedAnchorPickingId,
    );
    return anchor
      ? rebarStart + (rebarEnd - rebarStart) * anchor.fraction
      : null;
  }, [
    advancedAnchorPickingId,
    rebarEnd,
    rebarEndpointAnchors,
    rebarStart,
  ]);
  const displayAdvancedAnchors = useMemo(() => {
    if (
      rebarPhase !== "spacing" ||
      !rebarVariableLengthEnabled ||
      !draftAdvancedRun ||
      rebarEndpointAnchors.length < 2
    ) {
      return [];
    }
    const sourcePlane = rebarPlanes.find(
      (plane) => plane.id === draftAdvancedRun.planeId,
    );
    const targetPlane = rebarPlanes.find(
      (plane) =>
        plane.id === draftAdvancedRun.advanced?.splay?.targetPlaneId,
    );
    const targetNormal = targetPlane
      ? normalize(
          reframeDirection(targetPlane.objectNormal, null, basis),
        )
      : null;
    const targetBaseOrigin = targetPlane
      ? reframePoint(targetPlane.objectOrigin, null, basis)
      : null;
    const sourceNormal = sourcePlane
      ? normalize(
          reframeDirection(sourcePlane.objectNormal, null, basis),
        )
      : null;
    const sourceBaseOrigin = sourcePlane
      ? reframePoint(sourcePlane.objectOrigin, null, basis)
      : null;
    const instances = generateRebarInstances(draftAdvancedRun, {
      sourceNormal,
      sourceOrigin:
        sourceBaseOrigin && sourceNormal
          ? addScaled(
              sourceBaseOrigin,
              sourceNormal,
              draftAdvancedRun.startOffset ?? draftAdvancedRun.start,
            )
          : null,
      targetNormal,
      targetOrigin:
        targetBaseOrigin && targetNormal
          ? addScaled(
              targetBaseOrigin,
              targetNormal,
              draftAdvancedRun.advanced?.splay?.targetOffset ?? 0,
            )
          : null,
    });
    const anchors = [...rebarEndpointAnchors].sort(
      (a, b) => a.fraction - b.fraction,
    );
    return anchors.flatMap((anchor, index) => {
      const instanceIndex = Math.max(
        0,
        Math.min(
          instances.length - 1,
          Math.round(anchor.fraction * Math.max(instances.length - 1, 0)),
        ),
      );
      const instance = instances[instanceIndex];
      const finalLine = instance?.[instance.length - 1];
      const point = finalLine?.points[finalLine.points.length - 1];
      return point
        ? [
            {
              id: anchor.id,
              point,
              role:
                index === 0
                  ? ("start" as const)
                  : index === anchors.length - 1
                    ? ("end" as const)
                    : ("additional" as const),
              active: advancedAnchorPickingId === anchor.id,
            },
          ]
        : [];
    });
  }, [
    advancedAnchorPickingId,
    basis,
    draftAdvancedRun,
    rebarEndpointAnchors,
    rebarPhase,
    rebarPlanes,
    rebarVariableLengthEnabled,
  ]);

  const rebarGuideLines = useMemo(() => {
    const guidePlane =
      rebarPhase === "path-end" &&
      rebarSplayEnabled &&
      displaySplayTargetPlane
        ? displaySplayTargetPlane
        : displayRebarPlane;
    if (
      !inchesPerModelUnit ||
      !guidePlane ||
      rebarPhase === "idle" ||
      rebarPhase === "start" ||
      rebarPhase === "plane" ||
      rebarPhase === "plane-create"
    ) {
      return [];
    }
    const offset =
      advancedAnchorSection ??
      (rebarPhase === "path-end" &&
      rebarSplayEnabled &&
      displaySplayTargetPlane
        ? rebarSplayTargetOffset
        : rebarPhase === "path-end" ||
            rebarPhase === "path-review" ||
            rebarPhase === "spacing"
          ? rebarEnd
          : rebarStart);
    return createPlaneCoverOutlines(
      allNodes,
      elements,
      addScaled(guidePlane.origin, guidePlane.normal, offset),
      guidePlane.normal,
      Math.max(rebarCoverOffsetInches, 0) / inchesPerModelUnit,
    ).map((points, index) => ({
      id: `cover-guide-2-${index}`,
      points,
      closed: true,
    }));
  }, [
    allNodes,
    advancedAnchorSection,
    elements,
    inchesPerModelUnit,
    displayRebarPlane,
    displaySplayTargetPlane,
    rebarEnd,
    rebarPhase,
    rebarStart,
    rebarCoverOffsetInches,
    rebarSplayEnabled,
    rebarSplayTargetOffset,
  ]);
  const rebarInnerGuideLines = useMemo(() => {
    const guidePlane =
      rebarPhase === "path-end" &&
      rebarSplayEnabled &&
      displaySplayTargetPlane
        ? displaySplayTargetPlane
        : displayRebarPlane;
    if (
      !inchesPerModelUnit ||
      !guidePlane ||
      rebarPhase === "idle" ||
      rebarPhase === "start" ||
      rebarPhase === "plane" ||
      rebarPhase === "plane-create"
    ) {
      return [];
    }
    const offset =
      advancedAnchorSection ??
      (rebarPhase === "path-end" &&
      rebarSplayEnabled &&
      displaySplayTargetPlane
        ? rebarSplayTargetOffset
        : rebarPhase === "path-end" ||
            rebarPhase === "path-review" ||
            rebarPhase === "spacing"
          ? rebarEnd
          : rebarStart);
    return createPlaneCoverOutlines(
      allNodes,
      elements,
      addScaled(guidePlane.origin, guidePlane.normal, offset),
      guidePlane.normal,
      Math.max(rebarSecondaryOffsetInches, 0) / inchesPerModelUnit,
    ).map((points, index) => ({
      id: `cover-guide-4-${index}`,
      points,
      closed: true,
    }));
  }, [
    allNodes,
    advancedAnchorSection,
    elements,
    inchesPerModelUnit,
    displayRebarPlane,
    displaySplayTargetPlane,
    rebarEnd,
    rebarPhase,
    rebarStart,
    rebarSecondaryOffsetInches,
    rebarSplayEnabled,
    rebarSplayTargetOffset,
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
    setSelectedSlicingPlaneId(null);
    setSelectedSlicingPlaneIds(new Set());
    setSlicingPlaneOffset(0);
    setSlicePreviewActive(false);
    setFlipSliceSection(true);
    setSlicePins([]);
    setSelectedSlicePinId(null);
    setSelectedSlicePinIds(new Set());
    setActiveSlicePinId(null);
    setShowRebarInSlicing(false);
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
    setAdvancedRebarOpen(false);
    setRebarSplayEnabled(false);
    setRebarSplayTargetPlaneId(null);
    setRebarSplayTargetOffset(0);
    setChoosingSplayPlane(false);
    setHoveredSplayPlaneId(null);
    setRebarSplayScope("all");
    setRebarSplayLastCount(5);
    setRebarVariableLengthEnabled(false);
    setRebarEndpointAnchors([]);
    setAdvancedAnchorPickingId(null);
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
    setActiveTab("setup");
    setSetupStep(2);
    setVolumeDefinitionMode(nextElements.length ? "auto" : "manual");
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
        if (!saved) return;
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
        const migratedRebarSource = migrateRebarProject(
          saved.rebarRuns ?? [],
          saved.rebarPlanes,
          saved.basis,
        );
        const migratedRebar = orientRebarProjectInward(
          migratedRebarSource.runs,
          migratedRebarSource.planes,
          restoredNodes,
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
        setShowRebarInSlicing(saved.showRebarInSlicing ?? false);
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
        const restoredSetupComplete = Boolean(
          saved.volumeConfirmed &&
            saved.floorFaceId &&
            saved.basis &&
            saved.inchesPerModelUnit,
        );
        setActiveTab(
          saved.activeTab === "slicing" || saved.activeTab === "rebar"
            ? saved.activeTab
            : "setup",
        );
        setSetupStep(restoredSetupComplete ? 6 : saved.volumeConfirmed ? 3 : 2);
        setDefiningFaces(saved.definingFaces);
        setSmartSelecting(saved.smartSelecting ?? false);
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
        setStatus("Ready");
      })
      .catch(() => {
        if (!cancelled) {
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
      const migratedSource = migrateRebarProject(
        saved.rebarRuns ?? [],
        saved.rebarPlanes,
        saved.basis,
      );
      const migrated = orientRebarProjectInward(
        migratedSource.runs,
        migratedSource.planes,
        restoredNodes,
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
      setShowRebarInSlicing(saved.showRebarInSlicing ?? false);
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
      const importedSetupComplete = Boolean(
        saved.volumeConfirmed &&
          saved.floorFaceId &&
          saved.basis &&
          saved.inchesPerModelUnit,
      );
      setActiveTab(
        importedSetupComplete &&
          (saved.activeTab === "slicing" || saved.activeTab === "rebar")
          ? saved.activeTab
          : importedSetupComplete
            ? "rebar"
            : "setup",
      );
      setSetupStep(
        importedSetupComplete
          ? 6
          : saved.basis
            ? 5
            : saved.floorFaceId
              ? 4
              : saved.volumeConfirmed
                ? 3
                : 2,
      );
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
      const sourcePlane = rebarPlanes.find(
        (plane) => plane.id === run.planeId,
      );
      const targetPlane = rebarPlanes.find(
        (plane) => plane.id === run.advanced?.splay?.targetPlaneId,
      );
      const targetNormal = targetPlane
        ? normalize(
            reframeDirection(targetPlane.objectNormal, null, basis),
          )
        : null;
      const targetBaseOrigin = targetPlane
        ? reframePoint(targetPlane.objectOrigin, null, basis)
        : null;
      const sourceNormal = sourcePlane
        ? normalize(
            reframeDirection(sourcePlane.objectNormal, null, basis),
          )
        : null;
      const sourceBaseOrigin = sourcePlane
        ? reframePoint(sourcePlane.objectOrigin, null, basis)
        : null;
      const lengthsFeet = generateRebarInstances(run, {
        sourceNormal,
        sourceOrigin:
          sourceBaseOrigin && sourceNormal
            ? addScaled(
                sourceBaseOrigin,
                sourceNormal,
                run.startOffset ?? run.start,
              )
            : null,
        targetNormal,
        targetOrigin:
          targetBaseOrigin && targetNormal
            ? addScaled(
                targetBaseOrigin,
                targetNormal,
                run.advanced?.splay?.targetOffset ?? 0,
              )
            : null,
        lapOffsetModelUnits: run.lapOffsetInches
          ? run.lapOffsetInches / inchesPerModelUnit
          : 0,
      }).map(
        (instance) =>
          (rebarInstanceLength(instance) * inchesPerModelUnit) / 12,
      );
      const totalFeet = lengthsFeet.reduce(
        (total, lengthFeet) => total + lengthFeet,
        0,
      );
      const averageLengthFeet =
        lengthsFeet.length > 0 ? totalFeet / lengthsFeet.length : 0;
      return {
        name: run.name,
        tags: [
          run.advanced?.variableLength ? "Varying" : null,
          run.advanced?.splay ? "Splayed" : null,
        ]
          .filter(Boolean)
          .join(", "),
        quantity: run.positions.length,
        barNumber: run.barNumber ?? "5",
        lengthFeet: averageLengthFeet,
        minimumLengthFeet: lengthsFeet.length
          ? Math.min(...lengthsFeet)
          : 0,
        maximumLengthFeet: lengthsFeet.length
          ? Math.max(...lengthsFeet)
          : 0,
        totalFeet,
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
          `<Row>${cell("String", row.name)}${cell("String", row.tags)}${cell("Number", row.quantity)}${cell("String", `#${row.barNumber}`)}${cell("Number", Number(row.lengthFeet.toFixed(3)))}${cell("Number", Number(row.minimumLengthFeet.toFixed(3)))}${cell("Number", Number(row.maximumLengthFeet.toFixed(3)))}${cell("Number", Number(row.totalFeet.toFixed(3)))}</Row>`,
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
<Worksheet ss:Name="Bar Schedule"><Table><Column ss:Width="180"/><Column ss:Width="75"/><Column ss:Width="65"/><Column ss:Width="65"/><Column ss:Width="95"/><Column ss:Width="90"/><Column ss:Width="90"/><Column ss:Width="95"/>${header(["Bar Name", "Tags", "Quantity", "Bar Number", "Average Length (ft)", "Minimum Length (ft)", "Maximum Length (ft)", "Total Length (ft)"])}${scheduleRows}</Table></Worksheet>
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
      const creatingAutomaticFloor =
        activeTab === "setup" &&
        setupStep === 3 &&
        elementSkinVolume;
      if (creatingAutomaticFloor) {
        setFloorFaceId(face.id);
        setDefiningFaces(false);
        setSmartSelecting(false);
        setSetupStep(4);
        setCoordinateStep("x");
        setXDirectionNodeIds([]);
        setStatus(`${face.label} created and set as the floor plane.`);
      } else {
        setVolumeConfirmed(false);
      }
      if (!creatingAutomaticFloor) {
        setStatus(
          face.fitted
            ? `${face.label} fitted through the selected nodes. It will knit to adjacent planes when confirmed.`
            : `${face.label} created. Select the next face.`,
        );
      }
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not create face.",
      );
    }
  }, [
    allNodes,
    activeTab,
    draftNodeIds,
    elementSkinVolume,
    faces.length,
    fittedFaceConfirmation,
    globalBounds,
    setupStep,
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
        activeTab !== "setup" ||
        (setupStep !== 2 && setupStep !== 3) ||
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

  useEffect(() => {
    if (activeTab !== "setup" || (setupStep !== 4 && setupStep !== 5)) return;
    const cancelCoordinateStep = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) {
        return;
      }
      event.preventDefault();
      setCoordinateStep("idle");
      setScaleDefining(false);
      setScaleNodeIds([]);
      if (coordinateStep === "x") setXDirectionNodeIds([]);
      setStatus("Axes and scale selection cancelled.");
    };
    window.addEventListener("keydown", cancelCoordinateStep);
    return () => window.removeEventListener("keydown", cancelCoordinateStep);
  }, [activeTab, coordinateStep, setupStep]);

  const smartPreviewFace = useMemo(() => {
    if (!smartSelecting || !hover) return null;
    try {
      return smartFaceFromSeed(allNodes, hover.node.id, tolerance);
    } catch {
      return null;
    }
  }, [allNodes, hover?.node.id, smartSelecting, tolerance]);

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
      setInchesPerModelUnit(null);
      setSlice(fullSlice(bounds));
      setCoordinateStep("scale");
      setSetupStep(5);
      setScaleDefining(true);
      setScaleNodeIds([]);
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
      activeTab === "rebar" &&
      shiftPlaneSnapActive &&
      (rebarPhase === "start" || rebarPhase === "end")
    ) {
      if (
        rebarPhase === "end" &&
        choosingSplayPlane &&
        displaySplayTargetPlane
      ) {
        const coordinate = dot(
          subtract(
            node.local ?? node.global,
            displaySplayTargetPlane.origin,
          ),
          displaySplayTargetPlane.normal,
        );
        const clamped = Math.min(
          splayTargetPlaneBounds[1],
          Math.max(splayTargetPlaneBounds[0], coordinate),
        );
        setRebarSplayTargetOffset(clamped);
        setStatus(
          `Splay target plane snapped to node #${node.id}.`,
        );
        return;
      }
      if (!displayRebarPlane) return;
      const coordinate = dot(
        subtract(node.local ?? node.global, displayRebarPlane.origin),
        displayRebarPlane.normal,
      );
      const clamped = Math.min(
        rebarPlaneBounds[1],
        Math.max(rebarPlaneBounds[0], coordinate),
      );
      if (rebarPhase === "start") setRebarStart(clamped);
      else setRebarEnd(clamped);
      setActiveSlicePinId(null);
      setStatus(
        `${rebarPhase === "start" ? "Start" : "End"} section snapped to node #${node.id}.`,
      );
      return;
    }

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
        let objectNormal = normalize(cross(normalize(horizontal), vertical));
        const modelCenter = allNodes.reduce(
          (sum, candidate) => ({
            x: sum.x + candidate.global.x / allNodes.length,
            y: sum.y + candidate.global.y / allNodes.length,
            z: sum.z + candidate.global.z / allNodes.length,
          }),
          { x: 0, y: 0, z: 0 },
        );
        if (dot(subtract(modelCenter, first.global), objectNormal) < 0) {
          objectNormal = {
            x: -objectNormal.x,
            y: -objectNormal.y,
            z: -objectNormal.z,
          };
        }
        const plane: RebarPlane = {
          id: `rebar-plane-${crypto.randomUUID()}`,
          name: `Plane ${rebarPlanes.length + 1}`,
          color:
            PLANE_COLORS.find(
              (color) => !rebarPlanes.some((plane) => plane.color === color),
            ) ??
            PLANE_COLORS[
              rebarPlanes.filter((plane) => plane.id !== "auto-top-horizontal")
                .length % PLANE_COLORS.length
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

    if (
      activeTab === "setup" &&
      setupStep === 5 &&
      coordinateStep === "scale" &&
      scaleDefining
    ) {
      setScaleNodeIds((current) => {
        if (current.includes(nodeId)) return current;
        return current.length >= 2 ? [nodeId] : [...current, nodeId];
      });
      setStatus("Scale definition: select two nodes, then enter their distance.");
      return;
    }

    if (activeTab === "setup" && smartSelecting) {
      try {
        let candidate = smartPreviewFace;
        if (hover?.node.id !== nodeId || !candidate) {
          candidate = smartFaceFromSeed(allNodes, nodeId, tolerance);
        }
        const face: VolumeFace = {
          ...candidate,
          id: `smart-${crypto.randomUUID()}`,
          label: `Face ${faces.length + 1}`,
        };
        setFaces((current) => [...current, face]);
        if (setupStep === 3 && elementSkinVolume) {
          setFloorFaceId(face.id);
          setSmartSelecting(false);
          setSetupStep(4);
          setCoordinateStep("x");
          setXDirectionNodeIds([]);
          setStatus(`${face.label} created and set as the floor plane.`);
        } else {
          setVolumeConfirmed(false);
          setStatus(`${face.label} added by Smart Face. Hover for the next.`);
        }
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

    if (activeTab === "setup" && definingFaces) {
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
      activeTab === "setup" &&
      setupStep === 4 &&
      coordinateStep === "x" &&
      floorFaceId
    ) {
      const next =
        xDirectionNodeIds.length >= 2
          ? [nodeId]
          : xDirectionNodeIds.includes(nodeId)
            ? xDirectionNodeIds
            : [...xDirectionNodeIds, nodeId];
      if (next === xDirectionNodeIds) return;
      if (xDirectionNodeIds.length >= 2) {
        setInchesPerModelUnit(null);
      }
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
    setCoordinateStep("idle");
    setSetupStep(6);
    setStatus(
      `Scale defined: ${scaleDistanceInches} in between nodes ${first.id} and ${second.id}.`,
    );
  };

  const beginCreateRebar = () => {
    const nextMark = nextBarMark(rebarRuns);
    setRebarWorkflowKind("create");
    setRebarReferenceRunId(null);
    setEditingRebarRunId(null);
    setRebarLines([]);
    setPendingRebarLine(null);
    setRebarPathStart(null);
    setRebarPathEnd(null);
    setRebarPathPoints([]);
    setAdvancedRebarOpen(false);
    setRebarSplayEnabled(false);
    setRebarSplayTargetPlaneId(null);
    setRebarSplayTargetOffset(0);
    setChoosingSplayPlane(false);
    setHoveredSplayPlaneId(null);
    setRebarSplayScope("all");
    setRebarSplayLastCount(5);
    setRebarVariableLengthEnabled(false);
    setRebarEndpointAnchors([]);
    setAdvancedAnchorPickingId(null);
    setRebarBarNumber("5");
    setRebarSeries(nextMark.series);
    setRebarSuffix(nextMark.suffix);
    setRebarSpacing(12);
    setCustomSpacingDraft("");
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
    if (rebarPhase === "end" && choosingSplayPlane) {
      if (planeId === activeRebarPlaneId) {
        setStatus("Choose a different plane for the end of the splay.");
        return;
      }
      setRebarSplayEnabled(true);
      setRebarSplayTargetPlaneId(planeId);
      setRebarSplayTargetOffset(0);
      setHoveredSplayPlaneId(null);
      setStatus(
        "Target plane selected. Adjust its position, then confirm the target plane.",
      );
      return;
    }
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

  const toggleFavoritePlane = (planeId: string) => {
    setFavoriteRebarPlaneIds((current) =>
      current.includes(planeId)
        ? current.filter((id) => id !== planeId)
        : [...current, planeId],
    );
  };

  const deleteActiveRebarPlane = () => {
    const deletionIds = selectedSlicingPlaneIds.size
      ? selectedSlicingPlaneIds
      : activeRebarPlaneId
        ? new Set([activeRebarPlaneId])
        : new Set<string>();
    if (!deletionIds.size) return;
    const associated = rebarRuns.filter(
      (run) =>
        (run.planeId && deletionIds.has(run.planeId)) ||
        (run.advanced?.splay?.targetPlaneId &&
          deletionIds.has(run.advanced.splay.targetPlaneId)),
    );
    if (
      associated.length &&
      !window.confirm(
        `Plane has been used to create ${associated.length} bar run${
          associated.length === 1 ? "" : "s"
        }.\n\nConfirm deletion? The bars will remain in place.`,
      )
    ) {
      return;
    }
    const deletedNames = rebarPlanes
      .filter((plane) => deletionIds.has(plane.id))
      .map((plane) => plane.name);
    const nextPlanes = rebarPlanes.filter(
      (candidate) => !deletionIds.has(candidate.id),
    );
    setRebarPlanes(nextPlanes);
    setFavoriteRebarPlaneIds((current) =>
      current.filter((id) => !deletionIds.has(id)),
    );
    setSlicePins((current) =>
      current.filter((pin) => !deletionIds.has(pin.planeId)),
    );
    setActiveSlicePinId((current) =>
      slicePins.some(
        (pin) => pin.id === current && deletionIds.has(pin.planeId),
      )
        ? null
        : current,
    );
    if (associated.length) {
      setRebarRuns((current) =>
        current.map((run) => {
          const sourceDeleted =
            Boolean(run.planeId) && deletionIds.has(run.planeId!);
          const splayTargetDeleted =
            Boolean(run.advanced?.splay?.targetPlaneId) &&
            deletionIds.has(run.advanced!.splay!.targetPlaneId);
          if (!sourceDeleted && !splayTargetDeleted) return run;
          const advanced = splayTargetDeleted
            ? {
                ...run.advanced,
                splay: undefined,
              }
            : run.advanced;
          return {
            ...run,
            planeId: sourceDeleted ? null : run.planeId,
            advanced,
          };
        }),
      );
    }
    if (deletionIds.has("auto-top-horizontal")) {
      setTopRebarPlaneDismissed(true);
    }
    setActiveRebarPlaneId(null);
    setSelectedSlicingPlaneId(null);
    setSelectedSlicingPlaneIds(new Set());
    setPreviewedRebarPlaneId(null);
    setStatus(
      associated.length
        ? `${deletedNames.join(", ")} deleted. ${associated.length} associated bar run${
            associated.length === 1 ? " remains" : "s remain"
          } unchanged.`
        : `${deletedNames.join(", ")} deleted.`,
    );
  };

  const selectSlicingPlane = (
    planeId: string,
    preserveOffset = false,
    additive = false,
  ) => {
    const plane = rebarPlanes.find((candidate) => candidate.id === planeId);
    if (!plane) return;
    setSelectedSlicingPlaneIds((current) => {
      if (!additive) {
        setSelectedSlicingPlaneId(planeId);
        return new Set([planeId]);
      }
      const next = new Set(current);
      if (next.has(planeId)) next.delete(planeId);
      else next.add(planeId);
      setSelectedSlicingPlaneId(
        next.has(planeId)
          ? planeId
          : next.size === 1
            ? [...next][0]
            : null,
      );
      return next;
    });
    setActiveRebarPlaneId(planeId);
    setActiveSlicePinId(null);
    setSelectedSlicePinId(null);
    setSelectedSlicePinIds(new Set());
    setPinAddedNotice(null);
    setSlicePreviewActive(false);
    setFlipSliceSection(true);
    if (!preserveOffset) {
      setSlicingPlaneOffset(0);
    }
  };

  const beginSlicingPlaneCreation = () => {
    setRebarPlaneReturnPhase("idle");
    setRebarPlaneDraftNodeIds([]);
    setRebarPhase("plane-create");
    setStatus("New slicing plane: select two nodes.");
  };

  const createSlicePin = () => {
    if (!selectedSlicingPlaneId) return;
    const pin: SlicePin = {
      id: `slice-pin-${crypto.randomUUID()}`,
      name: `Slice ${slicePins.length + 1}`,
      planeId: selectedSlicingPlaneId,
      offset: slicingPlaneOffset,
      flipSection: flipSliceSection,
    };
    setSlicePins((current) => [...current, pin]);
    setSelectedSlicePinId(pin.id);
    setSelectedSlicePinIds(new Set([pin.id]));
    setActiveSlicePinId(pin.id);
    setPinAddedNotice(`${pin.name} added`);
    setStatus(`${pin.name} saved at this slice.`);
  };

  const activateSlicePin = (pin: SlicePin, applySavedView = false) => {
    setSelectedRebarRunIds(new Set());
    setSelectedSlicePinId(pin.id);
    setSelectedSlicePinIds(new Set([pin.id]));
    setSelectedSlicingPlaneId(null);
    setSelectedSlicingPlaneIds(new Set());
    setSlicingPlaneOffset(pin.offset);
    setFlipSliceSection(pin.flipSection ?? true);
    setSlicePreviewActive(true);
    setActiveSlicePinId(pin.id);
    if (applySavedView && pin.viewOptions) {
      setShowRebarInSlicing(pin.viewOptions.showRebar);
      setLineAndBar(pin.viewOptions.lineAndBar);
      setShowConcreteSkin(pin.viewOptions.showConcreteSkin);
      setShowAllPlanes(pin.viewOptions.showAllPlanes);
      setShowAllFavoritePlanes(pin.viewOptions.showAllFavoritePlanes);
    }
    if (applySavedView && pin.viewpoint) {
      setViewpointToApply({
        pinId: pin.id,
        nonce: Date.now(),
        viewpoint: pin.viewpoint,
      });
    }
  };

  const selectSlicePin = (pin: SlicePin, additive: boolean) => {
    setSelectedRebarRunIds(new Set());
    if (!additive) {
      activateSlicePin(pin);
      return;
    }
    setSelectedSlicePinIds((current) => {
      const next = new Set(current);
      if (next.has(pin.id)) next.delete(pin.id);
      else next.add(pin.id);
      setSelectedSlicePinId(next.size === 1 ? [...next][0] : null);
      return next;
    });
    setSelectedSlicingPlaneId(null);
    setSelectedSlicingPlaneIds(new Set());
    setSlicingPlaneOffset(pin.offset);
    setFlipSliceSection(pin.flipSection ?? true);
    setSlicePreviewActive(true);
    setActiveSlicePinId(pin.id);
  };

  const handleViewpointCaptured = useCallback(
    (pinId: string, viewpoint: CameraViewpoint) => {
      setSlicePins((current) =>
        current.map((pin) =>
          pin.id === pinId
            ? {
                ...pin,
                viewpoint,
                viewOptions: {
                  showRebar: showRebarInSlicing,
                  lineAndBar,
                  showConcreteSkin,
                  showAllPlanes,
                  showAllFavoritePlanes,
                },
              }
            : pin,
        ),
      );
      setViewpointCaptureRequest(null);
      setStatus("Viewpoint saved with the selected pin.");
    },
    [
      lineAndBar,
      showAllFavoritePlanes,
      showAllPlanes,
      showConcreteSkin,
      showRebarInSlicing,
    ],
  );

  const saveSelectedPinViewpoint = () => {
    if (!selectedSlicePin) return;
    setActiveSlicePinId(selectedSlicePin.id);
    setViewpointCaptureRequest({
      pinId: selectedSlicePin.id,
      nonce: Date.now(),
    });
  };

  const deleteSelectedPin = () => {
    if (!selectedSlicePinIds.size) return;
    setSlicePins((current) =>
      current.filter((pin) => !selectedSlicePinIds.has(pin.id)),
    );
    setActiveSlicePinId((current) =>
      current && selectedSlicePinIds.has(current) ? null : current,
    );
    setSelectedSlicePinId(null);
    setSelectedSlicePinIds(new Set());
  };

  const addRebarGroup = () => {
    setGroupDraftName("");
    setGroupDraftOpen(true);
  };

  const confirmRebarGroup = () => {
    if (!groupDraftName.trim()) return;
    const group: RebarGroup = {
      id: `rebar-group-${crypto.randomUUID()}`,
      name: groupDraftName.trim(),
      visible: true,
    };
    setRebarGroups((current) => [...current, group]);
    setGroupDraftOpen(false);
    setGroupDraftName("");
    setStatus(`${group.name} added. Drag bar runs into the folder.`);
  };

  const deleteEmptyRebarGroup = (groupId: string) => {
    if (rebarRuns.some((run) => run.groupId === groupId)) return;
    const group = rebarGroups.find((candidate) => candidate.id === groupId);
    setRebarGroups((current) =>
      current.filter((candidate) => candidate.id !== groupId),
    );
    setCollapsedRebarGroupIds((current) => {
      const next = new Set(current);
      next.delete(groupId);
      return next;
    });
    if (renamingRebarGroupId === groupId) {
      setRenamingRebarGroupId(null);
    }
    setStatus(`${group?.name ?? "Empty group"} deleted.`);
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

  const advancedNormalsForRun = (run: RebarRun) => {
    const sourcePlane = rebarPlanes.find((plane) => plane.id === run.planeId);
    const targetPlane = rebarPlanes.find(
      (plane) => plane.id === run.advanced?.splay?.targetPlaneId,
    );
    const targetNormal = targetPlane
      ? normalize(
          reframeDirection(targetPlane.objectNormal, null, basis),
        )
      : null;
    const targetBaseOrigin = targetPlane
      ? reframePoint(targetPlane.objectOrigin, null, basis)
      : null;
    const sourceNormal = sourcePlane
      ? normalize(
          reframeDirection(sourcePlane.objectNormal, null, basis),
        )
      : null;
    const sourceBaseOrigin = sourcePlane
      ? reframePoint(sourcePlane.objectOrigin, null, basis)
      : null;
    return {
      sourceNormal,
      sourceOrigin:
        sourceBaseOrigin && sourceNormal
          ? addScaled(
              sourceBaseOrigin,
              sourceNormal,
              run.startOffset ?? run.start,
            )
          : null,
      targetNormal,
      targetOrigin:
        targetBaseOrigin && targetNormal
          ? addScaled(
              targetBaseOrigin,
              targetNormal,
              run.advanced?.splay?.targetOffset ?? 0,
            )
          : null,
    };
  };

  const createDefaultEndpointAnchors = () => {
    if (!draftAdvancedRun) return [];
    const baseRun: RebarRun = {
      ...draftAdvancedRun,
      advanced: undefined,
    };
    const instances = generateRebarInstances(baseRun, {
      ...advancedNormalsForRun(baseRun),
      includeVariableLength: false,
    });
    const terminalPoint = (instance: RebarLine[] | undefined) => {
      const line = instance?.[instance.length - 1];
      return line?.points[line.points.length - 1] ?? null;
    };
    const first = terminalPoint(instances[0]);
    const last = terminalPoint(instances[instances.length - 1]);
    if (!first || !last) return [];
    return [
      {
        id: `endpoint-anchor-${crypto.randomUUID()}`,
        fraction: 0,
        point: { ...first },
      },
      {
        id: `endpoint-anchor-${crypto.randomUUID()}`,
        fraction: 1,
        point: { ...last },
      },
    ];
  };

  const addVariableLengthAnchor = () => {
    const anchors = [...rebarEndpointAnchors].sort(
      (a, b) => a.fraction - b.fraction,
    );
    if (anchors.length < 2) return;
    let largestGapIndex = 0;
    let largestGap = -1;
    for (let index = 0; index < anchors.length - 1; index += 1) {
      const gap = anchors[index + 1].fraction - anchors[index].fraction;
      if (gap > largestGap) {
        largestGap = gap;
        largestGapIndex = index;
      }
    }
    const before = anchors[largestGapIndex];
    const after = anchors[largestGapIndex + 1];
    const fraction = (before.fraction + after.fraction) / 2;
    const amount =
      after.fraction - before.fraction <= 1e-12
        ? 0
        : (fraction - before.fraction) /
          (after.fraction - before.fraction);
    const anchor: RebarEndpointAnchor = {
      id: `endpoint-anchor-${crypto.randomUUID()}`,
      fraction,
      point: {
        x: before.point.x + (after.point.x - before.point.x) * amount,
        y: before.point.y + (after.point.y - before.point.y) * amount,
        z: before.point.z + (after.point.z - before.point.z) * amount,
      },
    };
    setRebarEndpointAnchors(
      [...anchors, anchor].sort((a, b) => a.fraction - b.fraction),
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
    setCustomSpacingDraft(
      [12, 9, 6].includes(source.spacingInches)
        ? ""
        : String(source.spacingInches),
    );
    const nextMark = nextBarMark(rebarRuns);
    setRebarSeries(nextMark.series);
    setRebarSuffix(nextMark.suffix);
    setRebarBarNumber(source.barNumber ?? "5");
    setRebarLines([]);
    setPendingRebarLine(null);
    setRebarPathStart(null);
    setRebarPathEnd(null);
    setRebarPathPoints([]);
    setAdvancedRebarOpen(false);
    setRebarSplayEnabled(Boolean(source.advanced?.splay));
    setRebarSplayTargetPlaneId(
      source.advanced?.splay?.targetPlaneId ?? null,
    );
    setRebarSplayTargetOffset(
      source.advanced?.splay?.targetOffset ?? 0,
    );
    setChoosingSplayPlane(false);
    setHoveredSplayPlaneId(null);
    setRebarSplayScope(source.advanced?.splay?.scope ?? "all");
    setRebarSplayLastCount(source.advanced?.splay?.count ?? 5);
    setRebarVariableLengthEnabled(
      Boolean(source.advanced?.variableLength),
    );
    setRebarEndpointAnchors(
      source.advanced?.variableLength?.endpointAnchors.map((anchor) => ({
        ...anchor,
        point: { ...anchor.point },
      })) ?? [],
    );
    setAdvancedAnchorPickingId(null);
    setSelectedRebarRunIds(new Set([source.id]));
    setRebarPhase("start");
    setStatus(
      `${source.name} selected. Its start and end sections are suggested.`,
    );
  };

  const beginEditRebar = (run: RebarRun) => {
    const mark = structuredBarMark(run);
    setRebarWorkflowKind("edit");
    setRebarReferenceRunId(run.lappedFromRunId ?? null);
    setEditingRebarRunId(run.id);
    setActiveRebarPlaneId(run.planeId ?? null);
    setPreviewedRebarPlaneId(run.planeId ?? null);
    setRebarAxis(run.axis);
    setRebarStart(run.startOffset ?? run.start);
    setRebarEnd(run.endOffset ?? run.end);
    setRebarSpacing(run.spacingInches);
    setCustomSpacingDraft(
      [12, 9, 6].includes(run.spacingInches)
        ? ""
        : String(run.spacingInches),
    );
    setRebarSeries(mark.series);
    setRebarSuffix(mark.suffix);
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
    setAdvancedRebarOpen(false);
    setRebarSplayEnabled(Boolean(run.advanced?.splay));
    setRebarSplayTargetPlaneId(
      run.advanced?.splay?.targetPlaneId ?? null,
    );
    setRebarSplayTargetOffset(
      run.advanced?.splay?.targetOffset ?? 0,
    );
    setChoosingSplayPlane(false);
    setHoveredSplayPlaneId(null);
    setRebarSplayScope(run.advanced?.splay?.scope ?? "all");
    setRebarSplayLastCount(run.advanced?.splay?.count ?? 5);
    setRebarVariableLengthEnabled(
      Boolean(run.advanced?.variableLength),
    );
    setRebarEndpointAnchors(
      run.advanced?.variableLength?.endpointAnchors.map((anchor) => ({
        ...anchor,
        point: { ...anchor.point },
      })) ?? [],
    );
    setAdvancedAnchorPickingId(null);
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
    if (advancedAnchorPickingId) {
      setRebarEndpointAnchors((current) =>
        current.map((anchor) =>
          anchor.id === advancedAnchorPickingId
            ? { ...anchor, point: { ...point }, objectPoint: undefined }
            : anchor,
        ),
      );
      setAdvancedAnchorPickingId(null);
      setStatus("Variable-length endpoint anchor updated.");
      return;
    }
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
      const endpointPlane =
        rebarSplayEnabled && displaySplayTargetPlane
          ? displaySplayTargetPlane
          : displayRebarPlane;
      const endpointOffset =
        rebarSplayEnabled && displaySplayTargetPlane
          ? rebarSplayTargetOffset
          : rebarEnd;
      const endpoint = endpointPlane
        ? projectToPlaneOffset(
            point,
            endpointPlane.origin,
            endpointPlane.normal,
            endpointOffset,
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
    const runPositions = distributeBars(
      0,
      pathLength,
      spacing,
      inchesPerModelUnit,
    );
    const run: RebarRun = {
      id: editingRun?.id ?? `rebar-${crypto.randomUUID()}`,
      name: rebarName,
      color: editingRun?.color ?? leastUsedRebarColor(rebarRuns),
      barNumber: rebarBarNumber.trim().replace(/^#/, "") || "5",
      series: rebarSeries,
      suffix: rebarSuffix,
      groupId: editingRun?.groupId,
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
      positions: runPositions,
      lines: rebarLines,
      advanced:
        (rebarSplayEnabled && rebarSplayTargetPlaneId) ||
        (rebarVariableLengthEnabled && rebarEndpointAnchors.length >= 2)
          ? {
              splay:
                rebarSplayEnabled && rebarSplayTargetPlaneId
                  ? {
                      targetPlaneId: rebarSplayTargetPlaneId,
                      targetOffset: rebarSplayTargetOffset,
                      scope: rebarSplayScope,
                      count:
                        rebarSplayScope === "last"
                          ? Math.max(1, Math.round(rebarSplayLastCount))
                          : undefined,
                    }
                  : undefined,
              variableLength:
                rebarVariableLengthEnabled &&
                rebarEndpointAnchors.length >= 2
                  ? {
                      endpointAnchors: rebarEndpointAnchors
                        .map((anchor) => ({
                          ...anchor,
                          objectPoint: reframePoint(
                            anchor.point,
                            basis,
                            null,
                          ),
                        }))
                        .sort((a, b) => a.fraction - b.fraction),
                    }
                  : undefined,
            }
          : undefined,
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
    setAdvancedRebarOpen(false);
    setRebarSplayEnabled(false);
    setRebarSplayTargetPlaneId(null);
    setRebarSplayTargetOffset(0);
    setChoosingSplayPlane(false);
    setHoveredSplayPlaneId(null);
    setRebarSplayScope("all");
    setRebarSplayLastCount(5);
    setRebarVariableLengthEnabled(false);
    setRebarEndpointAnchors([]);
    setAdvancedAnchorPickingId(null);
    if (!editingRun) {
      const numericSeries = Number.parseInt(rebarSeries, 10);
      if (Number.isFinite(numericSeries)) {
        setRebarSeries(String(numericSeries + 1));
      }
    }
    setRebarBarNumber("5");
    setStatus(
      `${run.name} ${editingRun ? "updated" : "created"} with ${run.positions.length} bars.`,
    );
  };

  const prepareLappedRebarDetails = () => {
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
    setRebarPathPoints([startPoint, endpoint]);
    setRebarPhase("spacing");
    setStatus(
      "Lapped path prepared. Review details and any Advanced options before finishing.",
    );
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
    setAdvancedRebarOpen(false);
    setRebarSplayEnabled(false);
    setRebarSplayTargetPlaneId(null);
    setRebarSplayTargetOffset(0);
    setChoosingSplayPlane(false);
    setHoveredSplayPlaneId(null);
    setRebarSplayScope("all");
    setRebarSplayLastCount(5);
    setRebarVariableLengthEnabled(false);
    setRebarEndpointAnchors([]);
    setAdvancedAnchorPickingId(null);
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
      if (cancel && advancedAnchorPickingId) {
        setAdvancedAnchorPickingId(null);
        setStatus("Endpoint anchor pick cancelled.");
        return;
      }
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
        if (choosingSplayPlane) {
          setChoosingSplayPlane(false);
          setHoveredSplayPlaneId(null);
          setRebarSplayEnabled(false);
          setPreviewedRebarPlaneId(activeRebarPlaneId);
          setStatus("Splay target selection cancelled.");
          return;
        }
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
    activeRebarPlaneId,
    advancedAnchorPickingId,
    choosingSplayPlane,
    pendingRebarLine,
    rebarLines,
    rebarPathPoints,
    editingRebarRunId,
    rebarPlaneDraftNodeIds.length,
    rebarPhase,
    rebarRuns.length,
    cancelRebarWorkflow,
  ]);

  useEffect(() => {
    const setShiftState = (event: KeyboardEvent) => {
      if (event.key === "Shift") setShiftPlaneSnapActive(event.type === "keydown");
      if (
        event.type !== "keydown" ||
        !event.shiftKey ||
        activeTab !== "rebar" ||
        (rebarPhase !== "start" && rebarPhase !== "end") ||
        !inchesPerModelUnit ||
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) {
        return;
      }
      event.preventDefault();
      const direction =
        event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
      const update = (
        current: number,
        limits: [number, number],
      ) => {
        const currentInches = current * inchesPerModelUnit;
        const exactNextInches =
          currentInches + rebarCoverOffsetInches * direction;
        return Math.min(
          limits[1],
          Math.max(limits[0], exactNextInches / inchesPerModelUnit),
        );
      };
      if (rebarPhase === "start") {
        setRebarStart((current) => update(current, rebarPlaneBounds));
      } else if (choosingSplayPlane && rebarSplayTargetPlaneId) {
        setRebarSplayTargetOffset((current) =>
          update(current, splayTargetPlaneBounds),
        );
      } else {
        setRebarEnd((current) => update(current, rebarPlaneBounds));
      }
    };
    const clearShift = () => setShiftPlaneSnapActive(false);
    window.addEventListener("keydown", setShiftState);
    window.addEventListener("keyup", setShiftState);
    window.addEventListener("blur", clearShift);
    return () => {
      window.removeEventListener("keydown", setShiftState);
      window.removeEventListener("keyup", setShiftState);
      window.removeEventListener("blur", clearShift);
    };
  }, [
    activeTab,
    inchesPerModelUnit,
    rebarCoverOffsetInches,
    rebarPhase,
    rebarPlaneBounds,
    choosingSplayPlane,
    rebarSplayTargetPlaneId,
    splayTargetPlaneBounds,
  ]);

  const handleFacePick = (faceId: string) => {
    if (activeTab === "setup" && setupStep === 3 && !elementSkinVolume) {
      setFloorFaceId(faceId);
      setXDirectionNodeIds([]);
      reframeRebar(basis, null);
      setBasis(null);
      setInchesPerModelUnit(null);
      setAllNodes((current) =>
        current.map((node) => ({ ...node, local: null })),
      );
      if (globalBounds) setSlice(fullSlice(globalBounds));
      setCoordinateStep("x");
      setSetupStep(4);
      setStatus("Floor selected. Pick two nodes for positive X.");
      return;
    }

    if (activeTab === "setup" && setupStep === 2) {
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
    setFloorFaceId(null);
    setXDirectionNodeIds([]);
    reframeRebar(basis, null);
    setBasis(null);
    setInchesPerModelUnit(null);
    setSetupStep(3);
    setCoordinateStep("floor");
    setDefiningFaces(false);
    setSmartSelecting(false);
    setDraftNodeIds([]);
    setStatus("Closed inspection volume confirmed.");
  };

  const confirmAutomaticElementVolume = () => {
    if (!elementSkin.surfaces.length) return;
    setElementSkinVolume(true);
    setVolumeConfirmed(true);
    setShowElementSkin(true);
    setDefiningFaces(false);
    setSmartSelecting(false);
    setFloorFaceId(null);
    setXDirectionNodeIds([]);
    reframeRebar(basis, null);
    setBasis(null);
    setInchesPerModelUnit(null);
    setSetupStep(3);
    setCoordinateStep("floor");
    setStatus("Automatic element volume confirmed. Define the floor plane.");
  };

  const undoVolumeConfirmation = () => {
    setVolumeConfirmed(false);
    setElementSkinVolume(false);
    setConfirmWarning(false);
    setActiveTab("setup");
    setSetupStep(2);
    setDefiningFaces(false);
    setSmartSelecting(false);
    setDraftNodeIds([]);
    setFittedFaceConfirmation(null);
    setStatus("Volume confirmation undone. Faces are ready for editing.");
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

  const activateSmartSelect = () => {
    const next = !smartSelecting;
    setSmartSelecting(next);
    setDefiningFaces(false);
    setDraftNodeIds([]);
    if (!(setupStep === 3 && elementSkinVolume)) {
      setVolumeConfirmed(false);
    }
    setStatus(
      next
        ? "Hover an exterior connected planar patch, then click."
        : "Smart Select ended.",
    );
  };

  const renderRebarRunButton = (run: RebarRun) => (
    <div
      key={run.id}
      draggable={rebarPhase === "idle"}
      className="bar-run-row"
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-mct-rebar-run", run.id);
      }}
    >
      <button
        type="button"
        title={`${run.positions.length} bars · #${run.barNumber ?? "5"} · ${run.spacingInches}" nominal${run.advanced?.variableLength ? " · Varying" : ""}${run.advanced?.splay ? " · Splayed" : ""}${run.lappedFromRunId ? " · lapped" : ""}`}
        className={`bar-run-item ${
          selectedRebarRunIds.has(run.id) ? "selected" : ""
        }`}
        data-rebar-selection-control
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
          setColorPopoverRunId(null);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (rebarPhase === "idle") setRenamingRebarRunId(run.id);
        }}
      >
        <i
          className="bar-run-color"
          style={{ background: run.color ?? REBAR_COLORS[0] }}
          aria-hidden="true"
        />
        <span>
          {renamingRebarRunId === run.id ? (
            <input
              autoFocus
              defaultValue={run.name}
              aria-label={`Rename ${run.name}`}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onBlur={(event) => {
                const name = event.currentTarget.value.trim();
                if (name) {
                  setRebarRuns((current) =>
                    current.map((candidate) =>
                      candidate.id === run.id ? { ...candidate, name } : candidate,
                    ),
                  );
                }
                setRenamingRebarRunId(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setRenamingRebarRunId(null);
              }}
            />
          ) : (
            <strong>{run.name}</strong>
          )}
        </span>
      </button>
      {selectedRebarRunIds.has(run.id) && rebarPhase === "idle" && (
        <div className="bar-run-inline-actions" data-rebar-selection-control>
          <button type="button" onClick={() => beginEditRebar(run)}>Edit</button>
          <button
            type="button"
            className="bar-color-trigger"
            style={{ background: run.color ?? REBAR_COLORS[0] }}
            aria-label={`Change ${run.name} color`}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setColorPopoverPosition({
                left: rect.right + 7,
                top: Math.min(rect.top, window.innerHeight - 120),
              });
              setColorPopoverRunId((current) =>
                current === run.id ? null : run.id,
              );
            }}
          />
          {colorPopoverRunId === run.id && (
            <div
              className="inline-color-popover"
              style={colorPopoverPosition}
            >
              {REBAR_COLORS.map((color) => (
                <button
                  type="button"
                  key={color}
                  style={{ background: color }}
                  aria-label={`Set ${run.name} to ${color}`}
                  onClick={() => {
                    setRebarRuns((current) =>
                      current.map((candidate) =>
                        selectedRebarRunIds.has(candidate.id)
                          ? { ...candidate, color }
                          : candidate,
                      ),
                    );
                    setColorPopoverRunId(null);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <main
      className="app-shell"
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest(".header-menu")) setOpenHeaderMenu(null);
        if (
          !target.closest(".group-name-popover") &&
          !target.closest(".header-add-group")
        ) {
          setGroupDraftOpen(false);
        }
        if (
          activeTab === "setup" &&
          setupStep === 2 &&
          volumeDefinitionMode === "manual" &&
          !target.closest(".face-list-section")
        ) {
          setSelectedFaceIds(new Set());
        }
        if (
          activeTab === "rebar" &&
          !target.closest(".viewport") &&
          !target.closest("[data-plane-control]")
        ) {
          setPreviewedRebarPlaneId(null);
        }
        if (
          activeTab === "slicing" &&
          !target.closest(".viewport") &&
          !target.closest("[data-plane-selection-control]") &&
          !target.closest(".plane-slice-control")
        ) {
          setSelectedSlicingPlaneId(null);
          setSelectedSlicingPlaneIds(new Set());
          setPreviewedRebarPlaneId(null);
        }
        if (
          activeTab === "slicing" &&
          selectedSlicePinIds.size &&
          !target.closest(".viewport") &&
          !target.closest("[data-slice-selection-control]")
        ) {
          setSelectedSlicePinId(null);
          setSelectedSlicePinIds(new Set());
        }
        if (
          activeTab !== "rebar" ||
          rebarPhase !== "idle" ||
          !selectedRebarRunIds.size
        ) {
          return;
        }
        if (target.closest("[data-rebar-selection-control]")) return;
        if (target.closest(".viewport")) return;
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
        if (file) {
          if (/\.mctlab\.json$|\.json$/i.test(file.name)) void importProject(file);
          else void loadFile(file);
        }
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
        <div className="top-menu-bar" aria-label="Application menus">
          <div className="header-menu">
            <button
              type="button"
              aria-expanded={openHeaderMenu === "file"}
              onClick={() =>
                setOpenHeaderMenu((current) =>
                  current === "file" ? null : "file",
                )
              }
            >
              File
            </button>
            {openHeaderMenu === "file" && (
              <div className="header-menu-popover">
                <div className="active-model-menu-item">
                  <span>ACTIVE MODEL</span>
                  <strong>{fileName}</strong>
                </div>
                <button
                  onClick={() => {
                    projectInputRef.current?.click();
                    setOpenHeaderMenu(null);
                  }}
                >
                  Import Project
                </button>
                <button
                  onClick={() => {
                    exportProject();
                    setOpenHeaderMenu(null);
                  }}
                >
                  Export Project
                </button>
                <button
                  onClick={() => {
                    fileInputRef.current?.click();
                    setOpenHeaderMenu(null);
                  }}
                >
                  Import MCT
                </button>
                {activeTab === "rebar" && (
                  <button
                    disabled={!rebarRuns.length}
                    onClick={() => {
                      exportRebarQuantities();
                      setOpenHeaderMenu(null);
                    }}
                  >
                    Export Bar Quantity
                  </button>
                )}
                <button
                  onClick={() => {
                    loadText(createSampleMct(), "Demo bridge lattice");
                    setOpenHeaderMenu(null);
                  }}
                >
                  Load Demo
                </button>
                <div className="help-menu-item" tabIndex={0}>
                  <span>Help</span>
                  <div className="help-flyout" role="tooltip">
                    <strong>Mouse</strong>
                    <dl>
                      <div><dt>Left drag</dt><dd>Orbit model</dd></div>
                      <div><dt>Middle drag</dt><dd>Pan view</dd></div>
                      <div><dt>Scroll</dt><dd>Zoom</dd></div>
                      <div><dt>Right-click</dt><dd>Remove an editable face vertex</dd></div>
                      <div><dt>Double-click</dt><dd>Rename a plane</dd></div>
                      <div><dt>Ctrl + click</dt><dd>Select multiple bar runs</dd></div>
                    </dl>
                    <strong>Keyboard</strong>
                    <dl>
                      <div><dt>Escape</dt><dd>Cancel the active drawing or edit</dd></div>
                      <div><dt>Backspace</dt><dd>Undo the current point or workflow step</dd></div>
                      <div><dt>Ctrl + Z</dt><dd>Undo rebar work</dd></div>
                      <div><dt>Space</dt><dd>Complete or confirm a volume face</dd></div>
                      <div><dt>Shift + click</dt><dd>Snap a rebar section to a node</dd></div>
                      <div><dt>Shift + arrows</dt><dd>Move a section by the primary offset</dd></div>
                    </dl>
                  </div>
                </div>
              </div>
            )}
          </div>
          {(activeTab === "rebar" || activeTab === "slicing") && (
            <>
              {activeTab === "rebar" && <div className="header-menu">
                <button
                  type="button"
                  aria-expanded={openHeaderMenu === "parameters"}
                  onClick={() =>
                    setOpenHeaderMenu((current) =>
                      current === "parameters" ? null : "parameters",
                    )
                  }
                >
                  Parameters
                </button>
                {openHeaderMenu === "parameters" && (
                  <div className="header-menu-popover parameter-menu">
                    <label>
                      Primary perimeter offset (in)
                      <DraftNumberInput
                        min={0}
                        step={0.125}
                        value={rebarCoverOffsetInches}
                        onValueChange={(value) =>
                          setRebarCoverOffsetInches(Math.max(0, value))
                        }
                      />
                    </label>
                    <label>
                      Secondary perimeter offset (in)
                      <DraftNumberInput
                        min={0}
                        step={0.125}
                        value={rebarSecondaryOffsetInches}
                        onValueChange={(value) =>
                          setRebarSecondaryOffsetInches(Math.max(0, value))
                        }
                      />
                    </label>
                  </div>
                )}
              </div>}
              <div className="header-menu">
                <button
                  type="button"
                  aria-expanded={openHeaderMenu === "view"}
                  onClick={() =>
                    setOpenHeaderMenu((current) =>
                      current === "view" ? null : "view",
                    )
                  }
                >
                  Display
                </button>
                {openHeaderMenu === "view" && (
                  <div className="header-menu-popover view-menu">
                    {activeTab === "slicing" && (
                      <label>
                        <input
                          type="checkbox"
                          checked={showRebarInSlicing}
                          onChange={(event) =>
                            setShowRebarInSlicing(event.target.checked)
                          }
                        />
                        Display Rebar
                      </label>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={lineAndBar}
                        onChange={(event) => setLineAndBar(event.target.checked)}
                      />
                      Line and Bar
                    </label>
                    {activeTab === "rebar" && <label>
                      <input
                        type="checkbox"
                        checked={showConcreteSkin}
                        disabled={lineAndBar}
                        onChange={(event) =>
                          setShowConcreteSkin(event.target.checked)
                        }
                      />
                      Show Concrete Skin
                    </label>}
                    {activeTab === "slicing" && (
                      <label>
                        <input
                          type="checkbox"
                          checked={showAllPlanes}
                          onChange={(event) =>
                            setShowAllPlanes(event.target.checked)
                          }
                        />
                        Show all Planes
                      </label>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <div className="top-actions">
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
        className={`control-rail ${activeTab === "rebar" ? "rebar-rail" : ""}`}
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
              disabled={tab.id !== "setup" && !setupComplete}
              onClick={() => {
                if (
                  activeTab === "rebar" &&
                  tab.id !== "rebar" &&
                  rebarPhase !== "idle"
                ) {
                  cancelRebarWorkflow();
                }
                if (tab.id !== "rebar") {
                  setSelectedRebarRunIds(new Set());
                  setColorPopoverRunId(null);
                }
                setActiveTab(tab.id);
                if (tab.id === "setup" && setupComplete) setSetupStep(6);
                if (tab.id === "rebar") setHover(null);
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
              {tab.label}
            </button>
          ))}
        </nav>

        {activeTab === "setup" && (
          <div className="tab-content setup-content">
            <div className="setup-steps">
              <section className={`setup-step ${allNodes.length ? "complete" : ""} ${setupStep === 1 ? "active" : ""}`}>
                <button type="button" className="setup-step-heading" onClick={() => setSetupStep(1)}>
                  <span>01</span>
                  <strong>Import</strong>
                  <small>{allNodes.length ? fileName : "Project or MCT file"}</small>
                </button>
                {setupStep === 1 && (
                  <div className="setup-step-body">
                    <p>Import a saved MCT Section Lab project or a MIDAS MCT model.</p>
                    <div className="action-grid">
                      <button className="button primary" onClick={() => projectInputRef.current?.click()}>
                        Import Project
                      </button>
                      <button className="button" onClick={() => fileInputRef.current?.click()}>
                        Import MCT
                      </button>
                    </div>
                  </div>
                )}
              </section>

              <section className={`setup-step ${volumeConfirmed ? "complete" : ""} ${setupStep === 2 ? "active" : ""}`}>
                <button
                  type="button"
                  className="setup-step-heading"
                  disabled={!allNodes.length}
                  onClick={() => setSetupStep(2)}
                >
                  <span>02</span>
                  <strong>Volume Definition</strong>
                  <small>{volumeConfirmed ? "Volume created" : "Enclose the model"}</small>
                </button>
                {setupStep === 2 && (
                  <div className="setup-step-body">
                    <div className="setup-method-tabs" role="tablist">
                      <button
                        type="button"
                        className={volumeDefinitionMode === "auto" ? "active" : ""}
                        onClick={() => {
                          setVolumeDefinitionMode("auto");
                          setDefiningFaces(false);
                          setSmartSelecting(false);
                        }}
                      >
                        Auto
                      </button>
                      <button
                        type="button"
                        className={volumeDefinitionMode === "manual" ? "active" : ""}
                        onClick={() => setVolumeDefinitionMode("manual")}
                      >
                        Manual
                      </button>
                    </div>
                    {volumeDefinitionMode === "auto" ? (
                      <button
                        className="button primary wide"
                        disabled={!elementSkin.surfaces.length}
                        onClick={confirmAutomaticElementVolume}
                      >
                        Auto Volume
                      </button>
                    ) : (
                      <>
                        <p>Define every exterior face needed to completely enclose the volume.</p>
                        <div className="action-grid">
                          <button
                            className={`button ${definingFaces ? "primary" : ""}`}
                            onClick={() => {
                              setDefiningFaces((current) => !current);
                              setSmartSelecting(false);
                              setDraftNodeIds([]);
                            }}
                          >
                            {definingFaces ? "Defining…" : "Manual Face"}
                          </button>
                          <button
                            className={`button ${smartSelecting ? "primary" : ""}`}
                            onClick={activateSmartSelect}
                          >
                            Smart Face
                          </button>
                        </div>
                        {(definingFaces || smartSelecting) && (
                          <div className="selection-callout">
                            <strong>{definingFaces ? `${draftNodeIds.length} points selected` : "Smart Face active"}</strong>
                            <span>{definingFaces ? "Trace the boundary and press Space." : "Hover a connected planar face and click."}</span>
                          </div>
                        )}
                        <section className="face-list-section light-list" data-face-selection-control>
                          <div className="section-heading">
                            <div>
                              <span className="eyebrow">DEFINED FACES</span>
                              <strong>{faces.length}</strong>
                            </div>
                            <button
                              type="button"
                              onClick={() => setSelectedFaceIds(new Set(faces.map((face) => face.id)))}
                            >
                              All
                            </button>
                          </div>
                          <div className="face-list">
                            {faces.length ? faces.map((face) => (
                              <label key={face.id} className={selectedFaceIds.has(face.id) ? "selected" : ""}>
                                <input
                                  type="checkbox"
                                  checked={selectedFaceIds.has(face.id)}
                                  onChange={() => toggleFaceSelection(face.id)}
                                />
                                <span>
                                  <strong>{face.label}</strong>
                                  <small>{face.nodeIds.length} boundary nodes</small>
                                </span>
                              </label>
                            )) : <p>No faces yet.</p>}
                          </div>
                          <div className="list-delete-row">
                            <button
                              className="button compact danger-outline"
                              disabled={!selectedFaceIds.size}
                              onClick={deleteSelectedFaces}
                            >
                              Delete
                            </button>
                          </div>
                        </section>
                        <button
                          className="button primary wide"
                          disabled={faces.length < 4}
                          onClick={confirmVolume}
                        >
                          Create Volume
                        </button>
                      </>
                    )}
                  </div>
                )}
              </section>

              <section className={`setup-step ${floorFaceId ? "complete" : ""} ${setupStep === 3 ? "active" : ""}`}>
                <button
                  type="button"
                  className="setup-step-heading"
                  disabled={!volumeConfirmed}
                  onClick={() => {
                    setSetupStep(3);
                    setCoordinateStep("floor");
                  }}
                >
                  <span>03</span>
                  <strong>Define Floor Plane</strong>
                  <small>{floorFaceId ? faces.find((face) => face.id === floorFaceId)?.label ?? "Defined" : "Choose the bottom plane"}</small>
                </button>
                {setupStep === 3 && (
                  <div className="setup-step-body">
                    {elementSkinVolume ? (
                      <>
                        <p>Create the bottom face; it will be used automatically as the floor plane.</p>
                        <div className="action-grid">
                          <button
                            className={`button ${definingFaces ? "primary" : ""}`}
                            onClick={() => {
                              setDefiningFaces((current) => !current);
                              setSmartSelecting(false);
                              setDraftNodeIds([]);
                            }}
                          >
                            {definingFaces ? "Defining…" : "Manual Face"}
                          </button>
                          <button className={`button ${smartSelecting ? "primary" : ""}`} onClick={activateSmartSelect}>
                            Smart Face
                          </button>
                        </div>
                      </>
                    ) : (
                      <p>Select one of the manual volume faces in the viewer to use as the floor plane.</p>
                    )}
                  </div>
                )}
              </section>

              <section className={`setup-step ${basis ? "complete" : ""} ${setupStep === 4 ? "active" : ""}`}>
                <button
                  type="button"
                  className="setup-step-heading"
                  disabled={!floorFaceId}
                  onClick={() => {
                    setSetupStep(4);
                    setCoordinateStep("x");
                  }}
                >
                  <span>04</span>
                  <strong>Define X Axis</strong>
                  <small>{basis ? "Axis applied" : `${xDirectionNodeIds.length}/2 nodes`}</small>
                </button>
                {setupStep === 4 && (
                  <div className="setup-step-body">
                    <p>Pick two nodes to define the X axis. Point 1 is the origin, Point 2 the positive direction.</p>
                    <div className="selection-callout">
                      <strong>{xDirectionNodeIds.length >= 2 ? "Pick a new Point 1 to redefine" : `${xDirectionNodeIds.length}/2 nodes selected`}</strong>
                    </div>
                  </div>
                )}
              </section>

              <section className={`setup-step ${inchesPerModelUnit ? "complete" : ""} ${setupStep === 5 ? "active" : ""}`}>
                <button
                  type="button"
                  className="setup-step-heading"
                  disabled={!basis}
                  onClick={() => {
                    setSetupStep(5);
                    setCoordinateStep("scale");
                    setScaleDefining(true);
                    setScaleNodeIds([]);
                  }}
                >
                  <span>05</span>
                  <strong>Define Scale</strong>
                  <small>{inchesPerModelUnit ? "Scale applied" : "Two nodes and a known distance"}</small>
                </button>
                {setupStep === 5 && (
                  <div className="setup-step-body">
                    <div className="scale-definition">
                      <span>{scaleNodeIds.length}/2 nodes selected</span>
                      <label>
                        Known distance (inches)
                        <DraftNumberInput
                          min={0.001}
                          step={0.125}
                          value={scaleDistanceInches}
                          onValueChange={setScaleDistanceInches}
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
                  </div>
                )}
              </section>
            </div>
          </div>
        )}

        {false && (
          <div className="tab-content model-content">
            <h2 className="model-section-title">Face Definition</h2>
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
                {definingFaces ? "Defining…" : "Manual"}
              </button>
              <button
                className={`button ${smartSelecting ? "primary" : ""}`}
                onClick={activateSmartSelect}
                title="Connected exterior planar patch"
              >
                Smart Select
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
                <strong>CONNECTED</strong>
                <span>Exterior plane with connected-region growth</span>
              </div>
            )}

            <section className="face-list-section light-list">
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
                className="button danger compact-face-delete"
                disabled={!selectedFaceIds.size}
                onClick={deleteSelectedFaces}
              >
                Delete Selected
              </button>
            </section>

            <h2 className="model-section-title">Volume Definition</h2>
            <div className="volume-actions volume-definition-actions">
              <button
                className="button primary wide"
                disabled={!elementSkin.surfaces.length}
                onClick={() => {
                  setElementSkinVolume(true);
                  setVolumeConfirmed(true);
                  setShowElementSkin(true);
                  setDefiningFaces(false);
                  setSmartSelecting(false);
                  setStatus("Automatic element volume confirmed.");
                }}
              >
                Auto-Volume
              </button>
              <button
                className="button wide"
                disabled={faces.length < 4}
                onClick={confirmVolume}
              >
                Volume from Manual Faces
              </button>
              {elements.length > 0 && (
                <button
                  className={`button wide ${elementEditMode ? "primary" : ""}`}
                  onClick={() => {
                    setElementEditMode((value) => !value);
                    setSelectedElementIds(new Set());
                    setShowElementSkin(true);
                    setDefiningFaces(false);
                    setSmartSelecting(false);
                  }}
                >
                  {elementEditMode ? "Finish Element Editing" : "Delete Elements"}
                </button>
              )}
              {elementEditMode && (
                <div className="selection-callout">
                  <strong>{selectedElementIds.size} selected</strong>
                  <button
                    className="button danger"
                    disabled={!selectedElementIds.size}
                    onClick={deleteSelectedElements}
                  >
                    Delete Selected Elements
                  </button>
                </div>
              )}
              {volumeConfirmed && (
                <div className="volume-confirmed-notice">
                  <strong>✓ Volume Confirmed</strong>
                </div>
              )}
              {volumeConfirmed && (
                <button
                  className="button wide undo-volume"
                  onClick={undoVolumeConfirmation}
                >
                  Undo Volume
                </button>
              )}
            </div>
          </div>
        )}

        {false && (
          <div className="tab-content">
            <div className="coordinate-steps">
              <button
                type="button"
                className={`${floorFaceId ? "complete" : ""} ${
                  coordinateStep === "floor" ? "active" : ""
                }`}
                onClick={() => {
                  setCoordinateStep("floor");
                  setScaleDefining(false);
                  setStatus("Select a floor face.");
                }}
              >
                <span>01</span>
                <strong>Floor face</strong>
                <small>
                  {floorFaceId
                    ? faces.find((face) => face.id === floorFaceId)?.label
                    : "Click a face in the viewport"}
                </small>
              </button>
              <button
                type="button"
                disabled={!floorFaceId}
                className={
                  `${basis ? "complete" : ""} ${
                    coordinateStep === "x" ? "active" : ""
                  }`
                }
                onClick={() => {
                  setCoordinateStep("x");
                  setScaleDefining(false);
                  setXDirectionNodeIds([]);
                  setStatus("Select two nodes for positive X.");
                }}
              >
                <span>02</span>
                <strong>Positive X</strong>
                <small>
                  {xDirectionNodeIds.length
                    ? xDirectionNodeIds.map((id) => `#${id}`).join(" → ")
                    : "Pick two nodes"}
                </small>
              </button>
              <button
                type="button"
                disabled={!basis}
                className={`${inchesPerModelUnit ? "complete" : ""} ${
                  coordinateStep === "scale" ? "active" : ""
                }`}
                onClick={() => {
                  setCoordinateStep("scale");
                  setScaleDefining(true);
                  setScaleNodeIds([]);
                  setStatus("Select two nodes with a known distance.");
                }}
              >
                <span>03</span>
                <strong>Scale</strong>
                <small>
                  {inchesPerModelUnit
                    ? `1 unit = ${inchesPerModelUnit!.toFixed(5)} in`
                    : "Pick two nodes and enter the known distance"}
                </small>
              </button>
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
                setCoordinateStep("floor");
                setScaleDefining(false);
                setScaleNodeIds([]);
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
            {coordinateStep === "scale" && scaleDefining && (
              <section className="panel-section scale-section">
                <div className="scale-definition">
                  <span>
                    {scaleNodeIds.length}/2 nodes selected
                  </span>
                  <label>
                    Known distance (inches)
                    <DraftNumberInput
                      min={0.001}
                      step={0.125}
                      value={scaleDistanceInches}
                      onValueChange={setScaleDistanceInches}
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
              </section>
            )}
          </div>
        )}

        {activeTab === "slicing" && currentBounds && (
          <div className="tab-content slicing-content combined-slicing">
            <section className="slicing-workspace">
              <h2 className="slicing-list-title">Planes</h2>
              <div className="slicing-plane-list">
                {rebarPlanes.map((plane) => (
                  <div
                    key={plane.id}
                    className={`slicing-plane-row ${
                      selectedSlicingPlaneIds.has(plane.id) ? "selected" : ""
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
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") setRenamingRebarPlaneId(null);
                          }}
                        />
                      </div>
                    ) : (
                      <button
                        className="plane-select-button"
                        data-plane-selection-control
                        onClick={(event) =>
                          selectSlicingPlane(
                            plane.id,
                            false,
                            event.ctrlKey || event.metaKey,
                          )
                        }
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          setRenamingRebarPlaneId(plane.id);
                        }}
                        title="Click to select; Ctrl-click for multiple; double-click to rename"
                      >
                        <span className="plane-color" style={{ background: plane.color }} />
                        <span>{plane.name}</span>
                      </button>
                    )}
                  </div>
                ))}
                {!rebarPlanes.length && <p className="empty-list">No project planes yet.</p>}
              </div>
              <div className="plane-management-actions plane-list-actions" data-plane-selection-control>
                <button className="button compact" onClick={beginSlicingPlaneCreation}>
                  Add Plane
                </button>
                <button
                  className="button compact danger-outline"
                  disabled={!selectedSlicingPlaneIds.size}
                  onClick={deleteActiveRebarPlane}
                >
                  Delete Plane{selectedSlicingPlaneIds.size > 1 ? "s" : ""}
                </button>
              </div>
              {rebarPhase === "plane-create" && (
                <div className="selection-callout">
                  <strong>Defining a plane</strong>
                  <span>Select two nodes ({rebarPlaneDraftNodeIds.length}/2).</span>
                </div>
              )}

              {selectedSlicingPlane && !selectedSlicePinIds.size && (
                <div className="plane-slice-control">
                  <div>
                    <strong>Slicing</strong>
                    <span>Selected Plane: {selectedSlicingPlane.name}</span>
                  </div>
                  <div className="slice-slider-row">
                    <input
                      aria-label="Slice position"
                      type="range"
                      min={slicingPlaneBounds[0]}
                      max={slicingPlaneBounds[1]}
                      step={Math.max(
                        (slicingPlaneBounds[1] - slicingPlaneBounds[0]) / 500,
                        0.000001,
                      )}
                      value={slicingPlaneOffset}
                      onChange={(event) => {
                        setActiveSlicePinId(null);
                        setSlicePreviewActive(true);
                        setSlicingPlaneOffset(Number(event.target.value));
                      }}
                    />
                    <DraftNumberInput
                      className="slice-compact-input"
                      aria-label="Slice position value"
                      min={slicingPlaneBounds[0] * (inchesPerModelUnit ?? 1)}
                      max={slicingPlaneBounds[1] * (inchesPerModelUnit ?? 1)}
                      step={inchesPerModelUnit ? 0.25 : 0.001}
                      value={Number(
                        (slicingPlaneOffset * (inchesPerModelUnit ?? 1)).toFixed(4),
                      )}
                      onValueChange={(value) => {
                        setActiveSlicePinId(null);
                        setSlicePreviewActive(true);
                        setSlicingPlaneOffset(
                          Math.min(
                            slicingPlaneBounds[1],
                            Math.max(
                              slicingPlaneBounds[0],
                              value / (inchesPerModelUnit ?? 1),
                            ),
                          ),
                        );
                      }}
                    />
                  </div>
                  <div className="slice-actions">
                    <button
                      className={`button ${flipSliceSection ? "primary" : ""}`}
                      onClick={() => {
                        setFlipSliceSection((current) => !current);
                        setSlicePreviewActive(true);
                      }}
                    >
                      Flip Section
                    </button>
                    <button className="button primary" onClick={createSlicePin}>
                      Slice
                    </button>
                  </div>
                </div>
              )}

              <h2 className="slicing-list-title">Slices</h2>
              <div className="slice-pin-list">
                {slicePins.map((pin) =>
                  renamingSliceId === pin.id ? (
                    <div className="slice-rename-row" key={pin.id} data-slice-selection-control>
                      <input
                        autoFocus
                        defaultValue={pin.name}
                        onBlur={(event) => {
                          const name = event.currentTarget.value.trim();
                          if (name) {
                            setSlicePins((current) =>
                              current.map((candidate) =>
                                candidate.id === pin.id ? { ...candidate, name } : candidate,
                              ),
                            );
                          }
                          setRenamingSliceId(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") setRenamingSliceId(null);
                        }}
                      />
                    </div>
                  ) : (
                    <div className="slice-pin-entry" key={pin.id}>
                      <button
                        data-slice-selection-control
                        className={`slice-pin-row ${
                          selectedSlicePinIds.has(pin.id) ? "selected" : ""
                        } ${pin.viewpoint ? "has-viewpoint" : "no-viewpoint"}`}
                        onClick={(event) =>
                          selectSlicePin(pin, event.ctrlKey || event.metaKey)
                        }
                        onDoubleClick={() => setRenamingSliceId(pin.id)}
                        title="Ctrl-click to select multiple; double-click to rename"
                      >
                        <span>{pin.name}</span>
                        <small>
                          {rebarPlanes.find((plane) => plane.id === pin.planeId)?.name ??
                            "Missing plane"}
                        </small>
                      </button>
                    </div>
                  ),
                )}
                {!slicePins.length && <p className="empty-list">Create a slice above.</p>}
              </div>
              <div className="pin-management-actions" data-slice-selection-control>
                <button
                  className="button primary"
                  disabled={!selectedSlicePin}
                  onClick={saveSelectedPinViewpoint}
                >
                  Save as View
                </button>
                <button
                  className="button danger-outline"
                  disabled={!selectedSlicePinIds.size}
                  onClick={deleteSelectedPin}
                >
                  Delete{selectedSlicePinIds.size > 1 ? " Selected" : ""}
                </button>
              </div>
            </section>
          </div>
        )}

        {false && currentBounds && (
          <div className="tab-content slicing-content">
            <div className="slicing-subtabs" role="tablist">
              {(["planes", "slice"] as const).map((tab) => (
                <button
                  key={tab}
                  className={slicingSubtab === tab ? "active" : ""}
                  onClick={() => {
                    setSlicingSubtab(tab);
                    setActiveSlicePinId(null);
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
                  {tab === "planes" ? "Planes" : "Slice"}
                </button>
              ))}
            </div>

            {slicingSubtab === "planes" && (
              <section className="slicing-workspace">
                <div className="slicing-section-heading">
                  <div>
                    <h2>Planes List</h2>
                  </div>
                </div>
                <div className="slicing-plane-list">
                  {rebarPlanes.map((plane) => {
                    const favorite = favoriteRebarPlaneIds.includes(plane.id);
                    return (
                      <div
                        key={plane.id}
                        className={`slicing-plane-row ${
                          selectedSlicingPlaneIds.has(plane.id) ? "selected" : ""
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
                            className="plane-select-button"
                            data-plane-selection-control
                            onClick={(event) =>
                              selectSlicingPlane(
                                plane.id,
                                false,
                                event.ctrlKey || event.metaKey,
                              )
                            }
                            onDoubleClick={(event) => {
                              event.stopPropagation();
                              setRenamingRebarPlaneId(null);
                            }}
                            title="Click to select; double-click to rename"
                          >
                            <span
                              className="plane-color"
                              style={{ background: plane.color }}
                            />
                            <span>{plane.name}</span>
                          </button>
                        )}
                        <button
                          className={`plane-star ${favorite ? "favorite" : ""}`}
                          data-plane-selection-control
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
                <div className="plane-management-actions plane-list-actions">
                  <button
                    className="button compact"
                    onClick={beginSlicingPlaneCreation}
                  >
                    Add Plane
                  </button>
                  <button
                    className="button compact danger-outline"
                    data-plane-selection-control
                    disabled={!selectedSlicingPlaneIds.size}
                    onClick={deleteActiveRebarPlane}
                  >
                    Delete Plane{selectedSlicingPlaneIds.size > 1 ? "s" : ""}
                  </button>
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
                <h2 className="slicing-list-title">Favorite Planes</h2>
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
                  favoriteRebarPlaneIds.includes(selectedSlicingPlane?.id ?? "") && (
                    <div className="plane-slice-control">
                      <div>
                        <strong>Plane Pinning</strong>
                        <span>Selected Plane: {selectedSlicingPlane?.name}</span>
                      </div>
                      <label className="slice-position-input">
                        Position {inchesPerModelUnit ? "(in)" : ""}
                        <DraftNumberInput
                          min={
                            slicingPlaneBounds[0] *
                            (inchesPerModelUnit ?? 1)
                          }
                          max={
                            slicingPlaneBounds[1] *
                            (inchesPerModelUnit ?? 1)
                          }
                          step={inchesPerModelUnit ? 0.25 : 0.001}
                          value={Number(
                            (
                              slicingPlaneOffset *
                              (inchesPerModelUnit ?? 1)
                            ).toFixed(4),
                          )}
                          onValueChange={(value) => {
                            setActiveSlicePinId(null);
                            setPinAddedNotice(null);
                            setSlicePreviewActive(true);
                            setSlicingPlaneOffset(
                              Math.min(
                                slicingPlaneBounds[1],
                                Math.max(
                                  slicingPlaneBounds[0],
                                  value / (inchesPerModelUnit ?? 1),
                                ),
                              ),
                            );
                          }}
                        />
                      </label>
                      <div className="single-plane-slider">
                        <label>
                          <input
                            type="range"
                            min={slicingPlaneBounds[0]}
                            max={slicingPlaneBounds[1]}
                            step={Math.max(
                              (slicingPlaneBounds[1] -
                                slicingPlaneBounds[0]) /
                                500,
                              0.000001,
                            )}
                            value={slicingPlaneOffset}
                            onChange={(event) => {
                              setActiveSlicePinId(null);
                              setPinAddedNotice(null);
                              setSlicePreviewActive(true);
                              setSlicingPlaneOffset(Number(event.target.value));
                            }}
                          />
                        </label>
                      </div>
                      <div className="slice-actions">
                        <button
                          className={`button ${flipSliceSection ? "primary" : ""}`}
                          onClick={() => {
                            setFlipSliceSection((current) => !current);
                            setSlicePreviewActive(true);
                          }}
                        >
                          Flip Section
                        </button>
                        <button
                          className="button primary"
                          onClick={createSlicePin}
                        >
                          Slice
                        </button>
                      </div>
                      {pinAddedNotice && (
                        <div className="pin-added-notice" role="status">
                          ✓ {pinAddedNotice}
                        </div>
                      )}
                    </div>
                  )}
                <h2 className="slicing-list-title">Slices</h2>
                <div className="slice-pin-list">
                  {slicePins.map((pin) =>
                    renamingSliceId === pin.id ? (
                      <div className="slice-rename-row" key={pin.id}>
                        <input
                          autoFocus
                          defaultValue={pin.name}
                          onBlur={(event) => {
                            const name = event.currentTarget.value.trim();
                            if (name) {
                              setSlicePins((current) =>
                                current.map((candidate) =>
                                  candidate.id === pin.id
                                    ? { ...candidate, name }
                                    : candidate,
                                ),
                              );
                            }
                            setRenamingSliceId(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") setRenamingSliceId(null);
                          }}
                        />
                      </div>
                    ) : (
                      <button
                        key={pin.id}
                        className={`slice-pin-row ${
                          selectedSlicePinId === pin.id ? "selected" : ""
                        } ${pin.viewpoint ? "has-viewpoint" : "no-viewpoint"}`}
                        onClick={() => activateSlicePin(pin)}
                        onDoubleClick={() => setRenamingSliceId(pin.id)}
                        title="Double-click to rename"
                      >
                        <span>{pin.name}</span>
                        <small>
                          {rebarPlanes.find((plane) => plane.id === pin.planeId)
                            ?.name ?? "Missing plane"}
                        </small>
                      </button>
                    ),
                  )}
                  {!slicePins.length && (
                    <p className="empty-list">Create a slice above.</p>
                  )}
                </div>
                <div className="pin-management-actions">
                  <button
                    className="button primary"
                    disabled={!selectedSlicePin}
                    onClick={saveSelectedPinViewpoint}
                  >
                    Save as View
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
                          (choosingSplayPlane
                            ? rebarSplayTargetPlaneId === plane.id
                            : previewedRebarPlaneId === plane.id)
                            ? "selected"
                            : ""
                        }`}
                        onMouseEnter={() => {
                          if (
                            rebarPhase === "end" &&
                            choosingSplayPlane &&
                            plane.id !== activeRebarPlaneId
                          ) {
                            setHoveredSplayPlaneId(plane.id);
                          }
                        }}
                        onMouseLeave={() =>
                          setHoveredSplayPlaneId((current) =>
                            current === plane.id ? null : current,
                          )
                        }
                      >
                        <button
                          type="button"
                          disabled={
                            !choosingSplayPlane &&
                            Boolean(editingRebarRunId) &&
                            plane.id !== activeRebarPlaneId
                          }
                          onClick={() => selectRebarPlane(plane.id)}
                          title={
                            choosingSplayPlane
                              ? plane.id === activeRebarPlaneId
                                ? "Starting plane"
                                : "Click to use as the splay target"
                              : editingRebarRunId &&
                            plane.id !== activeRebarPlaneId
                              ? "The drawing plane is locked while editing"
                              : "Click to show this plane"
                          }
                        >
                          <i style={{ background: plane.color }} />
                          <span>{plane.name}</span>
                        </button>
                      </div>
                    ))}
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
                      Select a plane in the scrollable plane manager above.
                      Create or delete planes in Slicing → Planes.
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
                      <DraftNumberInput
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
                        onValueChange={(value) =>
                          setRebarStart(value / inchesPerModelUnit)
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
                    <small className="keyboard-hint">
                      Hold Shift to reveal nodes. Shift-click a node to snap;
                      Shift + arrow moves by {rebarCoverOffsetInches}&quot;
                      toward or away from the model.
                    </small>
                    <button
                      className="button primary wide"
                      onClick={confirmRebarStartSection}
                    >
                      {editingRebarRunId
                        ? editStartSectionChanged
                          ? "Update Start Section"
                          : "Start Section OK"
                        : "Confirm Section"}
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
                      {editingRebarRunId
                        ? editShapeChanged
                          ? "Update Rebar Shape"
                          : "Rebar Shape OK"
                        : "Confirm Rebar"}
                    </button>
                  </section>
                )}

                {rebarPhase === "path-start" && (
                  <section className="rebar-step">
                    <span className="eyebrow">SPACING PATH · START</span>
                    <div className="selection-callout">
                      <strong>Pick an anchor on the completed bar</strong>
                      <span>
                        Click anywhere on the active plane, including outside
                        the member or behind visible concrete. Vertices and
                        guide lines remain optional snaps.
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
                        {editStartAnchorChanged
                          ? "Update Start Anchor"
                          : "Start Anchor OK"}
                      </button>
                    )}
                  </section>
                )}

                {rebarPhase === "end" && (
                  <section className="rebar-step">
                    <span className="eyebrow">END SECTION</span>
                    {!choosingSplayPlane ? (
                      <>
                    <label>
                      Position (in)
                      <DraftNumberInput
                        min={rebarPlaneBounds[0] * inchesPerModelUnit}
                        max={rebarPlaneBounds[1] * inchesPerModelUnit}
                        step={0.25}
                        value={Number(
                          (
                            rebarEnd * inchesPerModelUnit
                          ).toFixed(3),
                        )}
                        onValueChange={(value) =>
                          setRebarEnd(value / inchesPerModelUnit)
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
                      </>
                    ) : (
                      <div className="splay-end-panel">
                        <div className="selection-callout">
                          <strong>Splay target</strong>
                          <span>
                            {activeSplayTargetPlane?.name ?? "Choose A Plane"}
                          </span>
                        </div>
                        {activeSplayTargetPlane && (
                          <>
                            <label>
                              Target position (in)
                              <DraftNumberInput
                                min={splayTargetPlaneBounds[0] * inchesPerModelUnit}
                                max={splayTargetPlaneBounds[1] * inchesPerModelUnit}
                                step={0.25}
                                value={Number(
                                  (
                                    rebarSplayTargetOffset * inchesPerModelUnit
                                  ).toFixed(3),
                                )}
                                onValueChange={(value) =>
                                  setRebarSplayTargetOffset(
                                    value / inchesPerModelUnit,
                                  )
                                }
                              />
                            </label>
                            <input
                              aria-label="Splay target plane position"
                              type="range"
                              min={splayTargetPlaneBounds[0] * inchesPerModelUnit}
                              max={splayTargetPlaneBounds[1] * inchesPerModelUnit}
                              step={0.25}
                              value={rebarSplayTargetOffset * inchesPerModelUnit}
                              onChange={(event) =>
                                setRebarSplayTargetOffset(
                                  Number(event.target.value) /
                                    inchesPerModelUnit,
                                )
                              }
                            />
                          </>
                        )}
                        <div className="advanced-scope-buttons">
                          <button
                            type="button"
                            className={rebarSplayScope === "all" ? "active" : ""}
                            onClick={() => setRebarSplayScope("all")}
                          >
                            All bars
                          </button>
                          <button
                            type="button"
                            className={rebarSplayScope === "last" ? "active" : ""}
                            onClick={() => setRebarSplayScope("last")}
                          >
                            Last X
                          </button>
                        </div>
                        {rebarSplayScope === "last" && (
                          <label>
                            Number of ending bars
                            <DraftNumberInput
                              min={1}
                              max={draftAdvancedRun?.positions.length ?? 999}
                              step={1}
                              value={rebarSplayLastCount}
                              onValueChange={(value) =>
                                setRebarSplayLastCount(
                                  Math.max(1, Math.round(value)),
                                )
                              }
                            />
                          </label>
                        )}
                      </div>
                    )}
                    <small className="keyboard-hint">
                      Hold Shift to reveal nodes. Shift-click a node to snap;
                      Shift + arrow moves by {rebarCoverOffsetInches}&quot;
                      toward or away from the model.
                    </small>
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
                        <label className="custom-bar-number">
                          <span>Other</span>
                          <b>#</b>
                          <input
                            aria-label="Other bar number"
                            className={
                              ["5", "6", "7", "8", "9", "10"].includes(
                                rebarBarNumber,
                              )
                                ? ""
                                : "custom-active"
                            }
                            value={
                              ["5", "6", "7", "8", "9", "10"].includes(
                                rebarBarNumber,
                              )
                                ? ""
                                : rebarBarNumber
                            }
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
                    <div className="end-section-choice-actions">
                      <button
                        className="button"
                        onClick={() => {
                          if (choosingSplayPlane) {
                            setChoosingSplayPlane(false);
                            setHoveredSplayPlaneId(null);
                            setRebarSplayEnabled(false);
                            setRebarSplayTargetPlaneId(null);
                            setRebarSplayTargetOffset(0);
                            setPreviewedRebarPlaneId(activeRebarPlaneId);
                            setStatus(
                              "Using the starting plane for the end section.",
                            );
                          } else {
                            const existingSplay = Boolean(
                              editingRebarRun?.advanced?.splay,
                            );
                            setChoosingSplayPlane(true);
                            setRebarSplayEnabled(true);
                            setHoveredSplayPlaneId(null);
                            setPreviewedRebarPlaneId(null);
                            if (!existingSplay) {
                              setRebarSplayTargetPlaneId(null);
                              setRebarSplayTargetOffset(0);
                            }
                            setStatus(
                              "Choose a target plane from the Planes list.",
                            );
                          }
                        }}
                      >
                        {choosingSplayPlane
                          ? "Use Starting Plane"
                          : "Choose Other Plane"}
                      </button>
                      <button
                        className="button dark-confirm"
                        disabled={
                          choosingSplayPlane && !rebarSplayTargetPlaneId
                        }
                        onClick={() => {
                          if (!choosingSplayPlane) {
                            setRebarSplayEnabled(false);
                            setRebarSplayTargetPlaneId(null);
                            setRebarSplayTargetOffset(0);
                          }
                          setChoosingSplayPlane(false);
                          setHoveredSplayPlaneId(null);
                          if (activeLappedWorkflow) {
                            prepareLappedRebarDetails();
                          } else {
                            setRebarPhase("path-end");
                          }
                        }}
                      >
                        Confirm
                      </button>
                    </div>
                  </section>
                )}

                {rebarPhase === "path-end" && (
                  <section className="rebar-step">
                    <span className="eyebrow">SPACING PATH · END</span>
                    <div className="selection-callout">
                      <strong>Pick the path endpoint</strong>
                      <span>
                        Click anywhere on the end plane, even outside the
                        member or behind another face. The bar anchor follows
                        the path between your chosen points.
                      </span>
                    </div>
                    {editingRebarRunId && rebarPathEnd && (
                      <button
                        className="button primary wide"
                        onClick={() => {
                          const endpointPlane =
                            rebarSplayEnabled && displaySplayTargetPlane
                              ? displaySplayTargetPlane
                              : displayRebarPlane;
                          const endpointOffset =
                            rebarSplayEnabled && displaySplayTargetPlane
                              ? rebarSplayTargetOffset
                              : rebarEnd;
                          if (endpointPlane) {
                            const retained = projectToPlaneOffset(
                                rebarPathEnd,
                                endpointPlane.origin,
                                endpointPlane.normal,
                                endpointOffset,
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
                        {editEndAnchorChanged
                          ? "Update End Anchor"
                          : "End Anchor OK"}
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
                        {editingRebarRunId
                          ? editPathChanged
                            ? "Update Path"
                            : "Path OK"
                          : "Complete Path"}
                      </button>
                    </div>
                  </section>
                )}

                {rebarPhase === "spacing" && (
                  <section className="rebar-step">
                    <span className="eyebrow">SPACING</span>
                    <div className="bar-mark-fields">
                      <label>
                        Series
                        <span className="bar-mark-input">
                          <b>#{rebarBarNumber || "5"}</b>
                          <input
                            aria-label="Bar mark series"
                            inputMode="numeric"
                            value={rebarSeries}
                            onChange={(event) =>
                              setRebarSeries(
                                event.target.value.replace(/\D/g, ""),
                              )
                            }
                          />
                        </span>
                      </label>
                      <label>
                        Suffix
                        <input
                          aria-label="Bar mark suffix"
                          value={rebarSuffix}
                          onChange={(event) =>
                            setRebarSuffix(event.target.value)
                          }
                        />
                      </label>
                    </div>
                    <div className="compact-setting-field">
                      <span className="eyebrow">BAR SPACING</span>
                      <div className="compact-choice-row spacing-choice-row">
                        {[12, 9, 6].map((spacing) => (
                          <button
                            type="button"
                            key={spacing}
                            disabled={activeLappedWorkflow}
                            className={
                              customSpacingDraft === "" &&
                              nearlyEqual(rebarSpacing, spacing)
                                ? "active"
                                : ""
                            }
                            onClick={() => {
                              setRebarSpacing(spacing);
                              setCustomSpacingDraft("");
                            }}
                          >
                            {spacing}&quot;
                          </button>
                        ))}
                        <input
                          aria-label="Other bar spacing in inches"
                          inputMode="decimal"
                          disabled={activeLappedWorkflow}
                          className={customSpacingDraft ? "active" : ""}
                          value={customSpacingDraft}
                          placeholder="Other"
                          onChange={(event) => {
                            const draft = event.target.value.replace(
                              /[^0-9.]/g,
                              "",
                            );
                            setCustomSpacingDraft(draft);
                            const value = Number(draft);
                            if (Number.isFinite(value) && value > 0) {
                              setRebarSpacing(value);
                            }
                          }}
                        />
                      </div>
                      {activeLappedWorkflow && (
                        <small>Inherited from the selected lapped bar.</small>
                      )}
                    </div>
                    <div className="bar-number-field">
                      <span className="eyebrow">BAR NUMBER</span>
                      <div className="compact-choice-row bar-number-buttons">
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
                        <label className="compact-other-number">
                          <b>#</b>
                        <input
                          aria-label="Other bar number"
                          className={
                            ["5", "6", "7", "8", "9", "10"].includes(
                              rebarBarNumber,
                            )
                              ? ""
                              : "custom-active"
                          }
                          value={
                            ["5", "6", "7", "8", "9", "10"].includes(
                              rebarBarNumber,
                            )
                              ? ""
                              : rebarBarNumber
                          }
                          onChange={(event) =>
                            setRebarBarNumber(
                              event.target.value.replace(/[^0-9A-Za-z.-]/g, ""),
                            )
                          }
                          placeholder="Other"
                        />
                        </label>
                      </div>
                    </div>
                    <small>
                      Bars follow the selected anchor path and finish exactly
                      at its endpoint.
                    </small>
                    <button
                      type="button"
                      className={`advanced-rebar-toggle ${
                        advancedRebarOpen ? "active" : ""
                      }`}
                      onClick={() => {
                        setAdvancedRebarOpen((current) => !current);
                        setAdvancedAnchorPickingId(null);
                      }}
                      aria-expanded={advancedRebarOpen}
                    >
                      Advanced
                      <span>{advancedRebarOpen ? "−" : "+"}</span>
                    </button>
                    {advancedRebarOpen && (
                      <div className="advanced-rebar-panel">
                        <section>
                          <label className="advanced-feature-toggle">
                            <input
                              type="checkbox"
                              checked={rebarSplayEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setRebarSplayEnabled(enabled);
                                if (enabled && !rebarSplayTargetPlaneId) {
                                  setRebarSplayTargetPlaneId(
                                    rebarPlanes.find(
                                      (plane) =>
                                        plane.id !== activeRebarPlaneId,
                                    )?.id ?? null,
                                  );
                                }
                              }}
                            />
                            <span>
                              <strong>Splay to another plane</strong>
                              <small>
                                Project every point of successive bars from the
                                drawing plane toward a positioned project plane.
                              </small>
                            </span>
                          </label>
                          {rebarSplayEnabled && (
                            <div className="advanced-feature-body">
                              <label>
                                Target plane
                                <select
                                  value={rebarSplayTargetPlaneId ?? ""}
                                  onChange={(event) => {
                                    setRebarSplayTargetPlaneId(
                                      event.target.value || null,
                                    );
                                    setRebarSplayTargetOffset(0);
                                  }}
                                >
                                  <option value="">Choose a plane</option>
                                  {rebarPlanes
                                    .filter(
                                      (plane) =>
                                        plane.id !== activeRebarPlaneId,
                                    )
                                    .map((plane) => (
                                      <option key={plane.id} value={plane.id}>
                                        {plane.name}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              {activeSplayTargetPlane && (
                                <label>
                                  Target plane position (in)
                                  <div className="splay-target-position">
                                    <input
                                      aria-label="Splay target plane position"
                                      type="range"
                                      min={
                                        splayTargetPlaneBounds[0] *
                                        inchesPerModelUnit
                                      }
                                      max={
                                        splayTargetPlaneBounds[1] *
                                        inchesPerModelUnit
                                      }
                                      step={0.25}
                                      value={
                                        rebarSplayTargetOffset *
                                        inchesPerModelUnit
                                      }
                                      onChange={(event) =>
                                        setRebarSplayTargetOffset(
                                          Number(event.target.value) /
                                            inchesPerModelUnit,
                                        )
                                      }
                                    />
                                    <DraftNumberInput
                                      min={
                                        splayTargetPlaneBounds[0] *
                                        inchesPerModelUnit
                                      }
                                      max={
                                        splayTargetPlaneBounds[1] *
                                        inchesPerModelUnit
                                      }
                                      step={0.25}
                                      value={Number(
                                        (
                                          rebarSplayTargetOffset *
                                          inchesPerModelUnit
                                        ).toFixed(3),
                                      )}
                                      onValueChange={(value) =>
                                        setRebarSplayTargetOffset(
                                          value / inchesPerModelUnit,
                                        )
                                      }
                                    />
                                  </div>
                                </label>
                              )}
                              <div className="advanced-scope-buttons">
                                <button
                                  type="button"
                                  className={
                                    rebarSplayScope === "all" ? "active" : ""
                                  }
                                  onClick={() => setRebarSplayScope("all")}
                                >
                                  All bars
                                </button>
                                <button
                                  type="button"
                                  className={
                                    rebarSplayScope === "last" ? "active" : ""
                                  }
                                  onClick={() => setRebarSplayScope("last")}
                                >
                                  Last X
                                </button>
                              </div>
                              {rebarSplayScope === "last" && (
                                <label>
                                  Number of ending bars
                                  <DraftNumberInput
                                    min={1}
                                    max={
                                      draftAdvancedRun?.positions.length ?? 999
                                    }
                                    step={1}
                                    value={rebarSplayLastCount}
                                    onValueChange={(value) =>
                                      setRebarSplayLastCount(
                                        Math.max(1, Math.round(value)),
                                      )
                                    }
                                  />
                                </label>
                              )}
                            </div>
                          )}
                        </section>
                        <section>
                          <label className="advanced-feature-toggle">
                            <input
                              type="checkbox"
                              checked={rebarVariableLengthEnabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setRebarVariableLengthEnabled(enabled);
                                setAdvancedAnchorPickingId(null);
                                if (
                                  enabled &&
                                  rebarEndpointAnchors.length < 2
                                ) {
                                  setRebarEndpointAnchors(
                                    createDefaultEndpointAnchors(),
                                  );
                                }
                              }}
                            />
                            <span>
                              <strong>Vary bar length</strong>
                              <small>
                                Drive the last drawn point through a separate
                                endpoint path along the run.
                              </small>
                            </span>
                          </label>
                          {rebarVariableLengthEnabled && (
                            <div className="advanced-feature-body">
                              <div className="endpoint-anchor-list">
                                {rebarEndpointAnchors
                                  .slice()
                                  .sort(
                                    (a, b) => a.fraction - b.fraction,
                                  )
                                  .map((anchor, index, anchors) => (
                                    <div
                                      key={anchor.id}
                                      className={`endpoint-anchor-row ${
                                        index === 0
                                          ? "start-anchor"
                                          : index === anchors.length - 1
                                            ? "end-anchor"
                                            : "additional-anchor"
                                      } ${
                                        advancedAnchorPickingId === anchor.id
                                          ? "picking"
                                          : ""
                                      }`}
                                    >
                                      {index === 0 ||
                                      index === anchors.length - 1 ? (
                                        <strong className="anchor-role-label">
                                          <i aria-hidden="true" />
                                          {index === 0 ? "Start" : "End"}
                                        </strong>
                                      ) : (
                                        <label
                                          title="Run % locates this additional endpoint vertex between the first and last bars in the run."
                                        >
                                          <span>Run %</span>
                                          <DraftNumberInput
                                            min={0.1}
                                            max={99.9}
                                            step={1}
                                            value={Number(
                                              (anchor.fraction * 100).toFixed(
                                                2,
                                              ),
                                            )}
                                            onValueChange={(value) =>
                                              setRebarEndpointAnchors(
                                                (current) =>
                                                  current
                                                    .map((candidate) =>
                                                      candidate.id === anchor.id
                                                        ? {
                                                            ...candidate,
                                                            fraction:
                                                              Math.max(
                                                                0.001,
                                                                Math.min(
                                                                  0.999,
                                                                  value / 100,
                                                                ),
                                                              ),
                                                          }
                                                        : candidate,
                                                    )
                                                    .sort(
                                                      (a, b) =>
                                                        a.fraction -
                                                        b.fraction,
                                                    ),
                                              )
                                            }
                                          />
                                        </label>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setAdvancedAnchorPickingId(
                                            anchor.id,
                                          );
                                          setStatus(
                                            `Pick the ${
                                              index === 0
                                                ? "Start"
                                                : index === anchors.length - 1
                                                  ? "End"
                                                  : `${(anchor.fraction * 100).toFixed(0)}%`
                                            } terminal point. Inner perimeter snaps are active.`,
                                          );
                                        }}
                                      >
                                        Pick
                                      </button>
                                      {index > 0 &&
                                        index < anchors.length - 1 && (
                                          <button
                                            type="button"
                                            className="remove-endpoint-anchor"
                                            aria-label={`Remove endpoint anchor at ${(anchor.fraction * 100).toFixed(0)} percent`}
                                            onClick={() =>
                                              setRebarEndpointAnchors(
                                                (current) =>
                                                  current.filter(
                                                    (candidate) =>
                                                      candidate.id !==
                                                      anchor.id,
                                                  ),
                                              )
                                            }
                                          >
                                            ×
                                          </button>
                                        )}
                                    </div>
                                  ))}
                              </div>
                              {advancedAnchorPickingId && (
                                <div className="advanced-pick-notice">
                                  Click anywhere on the highlighted section to
                                  place this terminal anchor. Escape cancels.
                                </div>
                              )}
                              <div className="advanced-anchor-actions">
                                <button
                                  type="button"
                                  onClick={addVariableLengthAnchor}
                                  disabled={rebarEndpointAnchors.length < 2}
                                >
                                  Additional Vertex
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setRebarEndpointAnchors(
                                      createDefaultEndpointAnchors(),
                                    )
                                  }
                                >
                                  Reset Ends
                                </button>
                              </div>
                            </div>
                          )}
                        </section>
                      </div>
                    )}
                    <button
                      className="button primary wide"
                      onClick={() => finishRebarRun()}
                    >
                      {editingRebarRunId
                        ? editingRebarChanged
                          ? "Update Bar"
                          : "Bar OK"
                        : "Really Finish Bar"}
                    </button>
                  </section>
                )}

                {rebarRuns.length > 0 && (
                  <section className="face-list-section">
                    <div className="section-heading">
                      <span className="eyebrow">BAR RUNS</span>
                      <div className="bar-runs-heading-actions add-group-shell">
                        <strong>{rebarRuns.length}</strong>
                        <button
                          type="button"
                          className="header-add-group"
                          data-rebar-selection-control
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            setGroupPopoverPosition({
                              left: rect.right + 8,
                              top: Math.min(rect.top - 4, window.innerHeight - 48),
                            });
                            addRebarGroup();
                          }}
                        >
                          Add Group
                        </button>
                        {groupDraftOpen && (
                          <div
                            className="group-name-popover"
                            data-rebar-selection-control
                            style={groupPopoverPosition}
                          >
                            <input
                              autoFocus
                              value={groupDraftName}
                              placeholder="Group name"
                              onChange={(event) =>
                                setGroupDraftName(event.target.value)
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") confirmRebarGroup();
                                if (event.key === "Escape") setGroupDraftOpen(false);
                              }}
                            />
                            <button type="button" onClick={confirmRebarGroup}>
                              OK
                            </button>
                          </div>
                        )}
                      </div>
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
                                onDoubleClick={(event) => {
                                  event.stopPropagation();
                                  setRenamingRebarGroupId(group.id);
                                }}
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
                                {renamingRebarGroupId === group.id ? (
                                  <input
                                    autoFocus
                                    defaultValue={group.name}
                                    onClick={(event) => event.stopPropagation()}
                                    onBlur={(event) => {
                                      const name = event.currentTarget.value.trim();
                                      if (name) {
                                        setRebarGroups((current) =>
                                          current.map((candidate) =>
                                            candidate.id === group.id
                                              ? { ...candidate, name }
                                              : candidate,
                                          ),
                                        );
                                      }
                                      setRenamingRebarGroupId(null);
                                    }}
                                    onKeyDown={(event) => {
                                      event.stopPropagation();
                                      if (event.key === "Enter") {
                                        event.currentTarget.blur();
                                      }
                                      if (event.key === "Escape") {
                                        setRenamingRebarGroupId(null);
                                      }
                                    }}
                                  />
                                ) : (
                                  <strong>{group.name}</strong>
                                )}
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
                              {groupRuns.length === 0 && (
                                <button
                                  type="button"
                                  className="delete-empty-group"
                                  aria-label={`Delete empty group ${group.name}`}
                                  title={`Delete empty group ${group.name}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    deleteEmptyRebarGroup(group.id);
                                  }}
                                >
                                  🗑
                                </button>
                              )}
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
                    <div className="bar-run-footer">
                      <button
                        className="button danger-outline bar-run-delete"
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
                        Delete Bar Run{selectedRebarRunIds.size > 1 ? "s" : ""}
                      </button>
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        )}

        <footer className="rail-footer">
          <span>{status}</span>
        </footer>
      </aside>

      <section
        className={`viewport ${
          activeTab === "setup" && volumeConfirmed
            ? "model-volume-confirmed"
            : ""
        }`}
      >
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
            (activeTab === "setup" &&
              setupStep === 3 &&
              !elementSkinVolume) ||
            (activeTab === "setup" &&
              (setupStep === 2 || setupStep === 3) &&
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
            (activeTab === "slicing" &&
              (showRebarInSlicing || lineAndBar)) ||
            (activeTab === "slicing" &&
              displayRebarPlanePreviews.length > 0)
          }
          customSlicePlane={activeCustomSlice}
          viewpointCaptureRequest={viewpointCaptureRequest}
          viewpointToApply={viewpointToApply}
          onViewpointCaptured={handleViewpointCaptured}
          showRebarPlaneNodes={
            rebarPhase === "plane-create" ||
            (shiftPlaneSnapActive &&
              (rebarPhase === "start" || rebarPhase === "end"))
          }
          rebarRuns={
            activeTab === "slicing" && !showRebarInSlicing && !lineAndBar
              ? []
              : draftAdvancedRun
                ? [
                    ...visibleRebarRuns.filter(
                      (run) => run.id !== editingRebarRunId,
                    ),
                    draftAdvancedRun,
                  ]
                : editingRebarRunId
                  ? visibleRebarRuns.filter(
                      (run) => run.id !== editingRebarRunId,
                    )
                  : visibleRebarRuns
          }
          rebarPlanes={rebarPlanes}
          rebarAdvancedAnchors={displayAdvancedAnchors}
          selectedRebarRunIds={selectedRebarRunIds}
          showRebarLabels={false}
          rebarGuideLines={
            pendingRebarLine ||
            rebarPhase === "path-end" ||
            Boolean(advancedAnchorPickingId)
              ? rebarGuideLines
              : []
          }
          rebarInnerGuideLines={
            pendingRebarLine ||
            rebarPhase === "path-end" ||
            Boolean(advancedAnchorPickingId)
              ? rebarInnerGuideLines
              : []
          }
          rebarOuterEdges={null}
          selectedRebarEdgeIndex={null}
          rebarEdgeSelectionMode={false}
          onPickRebarEdge={() => undefined}
          pendingRebarLine={pendingRebarLine}
          draftRebarLines={draftAdvancedRun ? [] : rebarLines}
          rebarSnapLines={
            advancedAnchorPickingId
              ? [...rebarGuideLines, ...rebarInnerGuideLines]
              : pendingRebarLine
              ? [...rebarGuideLines, ...rebarInnerGuideLines]
              : rebarPhase === "path-start"
                ? rebarLines
                : rebarPhase === "path-end"
                  ? [...rebarGuideLines, ...rebarInnerGuideLines]
                  : []
          }
          rebarSnapRequired={false}
          rebarPreviewStart={
            rebarPhase === "path-end" ? rebarPathStart : null
          }
          rebarPathStart={rebarPathStart}
          rebarPathEnd={rebarPathEnd}
          rebarPathPoints={rebarPathPoints}
          rebarAxis={rebarAxis}
          rebarDrawingPlane={
            rebarPhase === "path-end" &&
            rebarSplayEnabled &&
            displaySplayTargetPlane &&
            activeSplayTargetPlane
              ? {
                  ...displaySplayTargetPlane,
                  color: activeSplayTargetPlane.color,
                }
              : displayRebarPlane && activeRebarPlane
              ? {
                  ...displayRebarPlane,
                  color: activeRebarPlane.color,
                }
              : null
          }
          rebarPlanePreviews={displayRebarPlanePreviews}
          rebarSection={
            advancedAnchorSection !== null
              ? advancedAnchorSection
              : rebarPhase === "end" && choosingSplayPlane
                ? null
              : rebarPhase === "path-end" &&
                  rebarSplayEnabled &&
                  displaySplayTargetPlane
                ? rebarSplayTargetOffset
              : activeTab !== "rebar" ||
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
            Boolean(advancedAnchorPickingId) ||
            rebarPhase === "path-start" ||
            rebarPhase === "path-end"
          }
          showAxes={activeTab === "setup"}
          onPickRebarPoint={pickRebarWorkflowPoint}
          elementEditMode={elementEditMode}
          selectedElementIds={[...selectedElementIds]}
          onPickElement={toggleElementSelection}
          onHover={activeTab === "rebar" ? () => undefined : setHover}
          onHoverFace={setHoveredFaceId}
          onPickNode={handleNodePick}
          onPickFace={handleFacePick}
          onRemoveFaceVertex={removeFaceVertex}
          onInsertFaceVertex={insertFaceVertex}
        />

        {(activeTab === "slicing" || activeTab === "rebar") &&
          slicePins.some((pin) => pin.viewpoint) && (
            <div className="saved-view-ribbon" aria-label="Saved views">
              <div>
                {slicePins
                  .filter((pin) => pin.viewpoint)
                  .map((pin) => (
                    <button
                      type="button"
                      key={pin.id}
                      className={activeSlicePinId === pin.id ? "active" : ""}
                      onClick={() => activateSlicePin(pin, true)}
                    >
                      {pin.name}
                    </button>
                  ))}
              </div>
              <button
                type="button"
                className="clear-view-button"
                onClick={() => {
                  setActiveSlicePinId(null);
                  setSelectedSlicePinId(null);
                  setSelectedSlicePinIds(new Set());
                  setSelectedSlicingPlaneId(null);
                  setSelectedSlicingPlaneIds(new Set());
                  setSlicePreviewActive(false);
                }}
              >
                Clear
              </button>
            </div>
          )}

        {activeTab === "setup" && (
          <div className="axis-badge" aria-label="Local axis legend">
            <span className="axis-x">X</span>
            <span className="axis-y">Y</span>
            <span className="axis-z">Z</span>
            <small>{basis ? "LOCAL" : "MODEL"}</small>
          </div>
        )}

        {activeTab !== "rebar" && hover && (
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
            <strong>Drop project or MCT file</strong>
            <small>Project data and MCT geometry are processed locally</small>
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
                  setElementSkinVolume(false);
                  setFloorFaceId(null);
                  setXDirectionNodeIds([]);
                  reframeRebar(basis, null);
                  setBasis(null);
                  setInchesPerModelUnit(null);
                  setSetupStep(3);
                  setCoordinateStep("floor");
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
