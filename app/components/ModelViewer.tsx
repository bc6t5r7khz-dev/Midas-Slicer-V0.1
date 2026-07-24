"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createBasisFromFloor,
  getBounds,
  transformNodes,
} from "../lib/coordinateSystem";
import { autoHullFaces } from "../lib/autoVolume";
import { parseMctModel } from "../lib/mctParser";
import { buildElementSkin } from "../lib/elementSkin";
import {
  createCoverOutline,
  createSectionBoundary,
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
  LocalBasis,
  ModelElement,
  RebarLine,
  RebarRun,
  ModelNode,
  SliceRanges,
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
import RangeControl from "./RangeControl";
import InchRangeControl from "./InchRangeControl";

const TABS: Array<{ id: WorkflowTab; label: string; number: string }> = [
  { id: "volume", label: "Volume Definition", number: "01" },
  { id: "coordinates", label: "Coordinates", number: "02" },
  { id: "slicing", label: "Slicing", number: "03" },
  { id: "rebar", label: "Rebar", number: "04" },
];

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

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export default function ModelViewer() {
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  const [rebarPhase, setRebarPhase] = useState<
    "idle" | "start" | "lines" | "end" | "spacing"
  >("idle");
  const [rebarName, setRebarName] = useState("Bar Run 1");
  const [rebarAxis, setRebarAxis] = useState<Axis>("x");
  const [rebarStart, setRebarStart] = useState(0);
  const [rebarEnd, setRebarEnd] = useState(0);
  const [rebarLines, setRebarLines] = useState<RebarLine[]>([]);
  const [pendingRebarLine, setPendingRebarLine] =
    useState<RebarLine | null>(null);
  const [selectedRebarEdgeIndex, setSelectedRebarEdgeIndex] = useState<
    number | null
  >(null);
  const [rebarSpacing, setRebarSpacing] = useState(12);

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

  const rebarGuideLine = useMemo(() => {
    if (
      !inchesPerModelUnit ||
      rebarPhase === "idle" ||
      rebarPhase === "start"
    ) {
      return null;
    }
    const points = createCoverOutline(
      allNodes,
      elements,
      rebarAxis,
      rebarStart,
      2 / inchesPerModelUnit,
    );
    return points.length >= 3
      ? { id: "cover-guide", points }
      : null;
  }, [
    allNodes,
    elements,
    inchesPerModelUnit,
    rebarAxis,
    rebarPhase,
    rebarStart,
  ]);
  const rebarOuterEdges = useMemo(() => {
    if (
      rebarPhase === "idle" ||
      rebarPhase === "start"
    ) {
      return null;
    }
    const boundary = createSectionBoundary(
      allNodes,
      elements,
      rebarAxis,
      rebarStart,
    );
    return boundary.segments.length ? boundary.segments : null;
  }, [allNodes, elements, rebarAxis, rebarPhase, rebarStart]);

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
    setRebarPhase("idle");
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
        setRebarRuns(saved.rebarRuns ?? []);
        setShowConcreteSkin(saved.showConcreteSkin ?? true);
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
        showConcreteSkin,
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
    smartSelecting,
    smartVariant,
    smartAxis,
    slice,
    showElementSkin,
    showConcreteSkin,
    volumeConfirmed,
    workspaceReady,
    xDirectionNodeIds,
  ]);

  const loadFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".mct")) {
      setError("Choose a MIDAS Civil .mct file.");
      return;
    }
    setStatus("Reading file…");
    loadText(await file.text(), file.name);
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
      setBasis(null);
      setAllNodes((current) =>
        current.map((node) => ({ ...node, local: null })),
      );
      if (globalBounds) setSlice(fullSlice(globalBounds));
    }
    setStatus(`${removed.label} removed.`);
  }, [faces, floorFaceId, globalBounds]);

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

  const finishRebarRun = () => {
    if (!inchesPerModelUnit || !rebarLines.length) return;
    const run: RebarRun = {
      id: `rebar-${crypto.randomUUID()}`,
      name: rebarName.trim() || `Bar Run ${rebarRuns.length + 1}`,
      axis: rebarAxis,
      start: rebarStart,
      end: rebarEnd,
      spacingInches: rebarSpacing,
      positions: distributeBars(
        rebarStart,
        rebarEnd,
        rebarSpacing,
        inchesPerModelUnit,
      ),
      lines: rebarLines,
    };
    setRebarRuns((current) => [...current, run]);
    setRebarPhase("idle");
    setRebarLines([]);
    setPendingRebarLine(null);
    setSelectedRebarEdgeIndex(null);
    setRebarName(`Bar Run ${rebarRuns.length + 2}`);
    setStatus(`${run.name} created with ${run.positions.length} bars.`);
  };

  const handleFacePick = (faceId: string) => {
    if (activeTab === "coordinates") {
      setFloorFaceId(faceId);
      setXDirectionNodeIds([]);
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
      ...(editableFace?.nodeIds ?? []),
    ],
    [draftNodeIds, editableFace, scaleNodeIds, xDirectionNodeIds],
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
          ? "Adjust X, Y, and Z slice ranges"
          : rebarPhase === "idle"
            ? "Create or review reinforcement runs"
            : "Follow the active rebar step";

  return (
    <main
      className="app-shell"
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
        </div>
      </header>

      <aside className="control-rail">
        <nav className="workflow-tabs" aria-label="Model workflow">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={activeTab === tab.id ? "active" : ""}
              onClick={() => {
                setActiveTab(tab.id);
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
            <section className="panel-section intro compact">
              <span className="eyebrow">LIVE CLIPPING</span>
              <h1>Peel back the volume</h1>
              <p>
                Each handle moves in hundredths of the local model extent.
                The solid surface is clipped directly; black lines mark cuts.
              </p>
            </section>
            {(["x", "y", "z"] as const).map((axis) => (
              <RangeControl
                key={axis}
                axis={axis.toUpperCase() as "X" | "Y" | "Z"}
                bounds={currentBounds[axis]}
                value={slice[axis]}
                onChange={(value) =>
                  setSlice((current) => ({ ...current, [axis]: value }))
                }
              />
            ))}
            <button
              className="text-button"
              onClick={() => setSlice(fullSlice(currentBounds))}
            >
              Show full extent
            </button>
          </div>
        )}

        {activeTab === "rebar" && currentBounds && (
          <div className="tab-content rebar-content">
            <section className="panel-section intro compact">
              <span className="eyebrow">REINFORCEMENT</span>
              <h1>Lay out bar runs</h1>
              <p>
                Sections and spacing use the physical scale defined in
                Coordinates.
              </p>
            </section>
            {!inchesPerModelUnit ? (
              <div className="selection-callout">
                <strong>Scale required</strong>
                <span>Use Coordinates → Define Scale before creating bars.</span>
              </div>
            ) : (
              <>
                {(["x", "y", "z"] as const).map((axis) => (
                  <InchRangeControl
                    key={axis}
                    axis={axis.toUpperCase() as "X" | "Y" | "Z"}
                    bounds={currentBounds[axis]}
                    value={slice[axis]}
                    inchesPerUnit={inchesPerModelUnit}
                    onChange={(value) =>
                      setSlice((current) => ({ ...current, [axis]: value }))
                    }
                  />
                ))}
                <label className="skin-toggle">
                  <input
                    type="checkbox"
                    checked={showConcreteSkin}
                    onChange={(event) =>
                      setShowConcreteSkin(event.target.checked)
                    }
                  />
                  Show concrete skin
                </label>

                {rebarPhase === "idle" && (
                  <button
                    className="button primary wide"
                    onClick={() => {
                      setRebarPhase("start");
                      setRebarAxis("x");
                      setRebarStart(currentBounds.x[0]);
                      setRebarEnd(currentBounds.x[1]);
                      setRebarLines([]);
                      setSelectedRebarEdgeIndex(null);
                      setStatus("Choose the start section axis and location.");
                    }}
                  >
                    Create Bar
                  </button>
                )}

                {rebarPhase === "start" && (
                  <section className="rebar-step">
                    <span className="eyebrow">START SECTION</span>
                    <div className="axis-choice">
                      {(["x", "y", "z"] as const).map((axis) => (
                        <button
                          key={axis}
                          className={rebarAxis === axis ? "active" : ""}
                          onClick={() => {
                            setRebarAxis(axis);
                            setRebarStart(currentBounds[axis][0]);
                            setRebarEnd(currentBounds[axis][1]);
                            setSelectedRebarEdgeIndex(null);
                          }}
                        >
                          {axis.toUpperCase()}
                        </button>
                      ))}
                    </div>
                    <label>
                      Position (in)
                      <input
                        type="number"
                        min={0}
                        max={
                          (currentBounds[rebarAxis][1] -
                            currentBounds[rebarAxis][0]) *
                          inchesPerModelUnit
                        }
                        step={0.25}
                        value={Number(
                          (
                            (rebarStart -
                              currentBounds[rebarAxis][0]) *
                            inchesPerModelUnit
                          ).toFixed(3),
                        )}
                        onChange={(event) =>
                          setRebarStart(
                            currentBounds[rebarAxis][0] +
                              Number(event.target.value) /
                                inchesPerModelUnit,
                          )
                        }
                      />
                    </label>
                    <input
                      aria-label="Start section position"
                      type="range"
                      min={0}
                      max={
                        (currentBounds[rebarAxis][1] -
                          currentBounds[rebarAxis][0]) *
                        inchesPerModelUnit
                      }
                      step={0.25}
                      value={
                        (rebarStart - currentBounds[rebarAxis][0]) *
                        inchesPerModelUnit
                      }
                      onChange={(event) =>
                        setRebarStart(
                          currentBounds[rebarAxis][0] +
                            Number(event.target.value) / inchesPerModelUnit,
                        )
                      }
                    />
                    <button
                      className="button primary wide"
                      onClick={() => {
                        setSelectedRebarEdgeIndex(null);
                        setRebarPhase("lines");
                      }}
                    >
                      Confirm Section
                    </button>
                  </section>
                )}

                {rebarPhase === "lines" && (
                  <section className="rebar-step">
                    <span className="eyebrow">BAR SHAPE</span>
                    <div className="selection-callout">
                      <strong>
                        {selectedRebarEdgeIndex === null
                          ? "Select an outer edge"
                          : `Edge ${selectedRebarEdgeIndex + 1} selected`}
                      </strong>
                      <span>
                        Hover turns gold · selected edge stays green.
                      </span>
                    </div>
                    {!pendingRebarLine ? (
                      <button
                        className="button wide"
                        disabled={
                          !rebarGuideLine ||
                          selectedRebarEdgeIndex === null
                        }
                        onClick={() =>
                          setPendingRebarLine({
                            id: `line-${crypto.randomUUID()}`,
                            points: [],
                            closed: false,
                          })
                        }
                      >
                        Line
                      </button>
                    ) : (
                      <button
                        className="button primary wide"
                        disabled={pendingRebarLine.points.length < 2}
                        onClick={() => {
                          setRebarLines((current) => [
                            ...current,
                            pendingRebarLine,
                          ]);
                          setPendingRebarLine(null);
                        }}
                      >
                        Finish Line
                      </button>
                    )}
                    {pendingRebarLine && (
                      <small>
                        Click the gold guide to add snapped points ·{" "}
                        {pendingRebarLine.points.length} selected
                      </small>
                    )}
                    <small>{rebarLines.length} finished line(s)</small>
                    <button
                      className="button primary wide"
                      disabled={!rebarLines.length || Boolean(pendingRebarLine)}
                      onClick={() => setRebarPhase("end")}
                    >
                      Finish Bar
                    </button>
                  </section>
                )}

                {rebarPhase === "end" && (
                  <section className="rebar-step">
                    <span className="eyebrow">END SECTION</span>
                    <label>
                      Position (in)
                      <input
                        type="number"
                        min={0}
                        max={
                          (currentBounds[rebarAxis][1] -
                            currentBounds[rebarAxis][0]) *
                          inchesPerModelUnit
                        }
                        step={0.25}
                        value={Number(
                          (
                            (rebarEnd - currentBounds[rebarAxis][0]) *
                            inchesPerModelUnit
                          ).toFixed(3),
                        )}
                        onChange={(event) =>
                          setRebarEnd(
                            currentBounds[rebarAxis][0] +
                              Number(event.target.value) /
                                inchesPerModelUnit,
                          )
                        }
                      />
                    </label>
                    <input
                      aria-label="End section position"
                      type="range"
                      min={0}
                      max={
                        (currentBounds[rebarAxis][1] -
                          currentBounds[rebarAxis][0]) *
                        inchesPerModelUnit
                      }
                      step={0.25}
                      value={
                        (rebarEnd - currentBounds[rebarAxis][0]) *
                        inchesPerModelUnit
                      }
                      onChange={(event) =>
                        setRebarEnd(
                          currentBounds[rebarAxis][0] +
                            Number(event.target.value) / inchesPerModelUnit,
                        )
                      }
                    />
                    <button
                      className="button primary wide"
                      onClick={() => setRebarPhase("spacing")}
                    >
                      Confirm Section
                    </button>
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
                    <button
                      className="button primary wide"
                      onClick={finishRebarRun}
                    >
                      Really Finish Bar
                    </button>
                  </section>
                )}

                {rebarRuns.length > 0 && (
                  <section className="face-list-section">
                    <div className="section-heading">
                      <span className="eyebrow">BAR RUNS</span>
                      <strong>{rebarRuns.length}</strong>
                    </div>
                    <div className="face-list">
                      {rebarRuns.map((run) => (
                        <label key={run.id}>
                          <span>
                            <strong>{run.name}</strong>
                            <small>
                              {run.positions.length} bars ·{" "}
                              {run.spacingInches}" nominal
                            </small>
                          </span>
                          <button
                            className="danger-button"
                            onClick={() =>
                              setRebarRuns((current) =>
                                current.filter(
                                  (candidate) => candidate.id !== run.id,
                                ),
                              )
                            }
                          >
                            Delete
                          </button>
                        </label>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        )}

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

        <footer className="rail-footer">
          <span>{status}</span>
          <span>Three.js · browser only</span>
        </footer>
      </aside>

      <section className="viewport">
        <PointCloudViewport
          nodes={displayNodes}
          allNodes={allNodes}
          slice={slice}
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
          rebarRuns={rebarRuns}
          rebarGuideLine={pendingRebarLine ? rebarGuideLine : null}
          rebarOuterEdges={rebarOuterEdges}
          selectedRebarEdgeIndex={selectedRebarEdgeIndex}
          rebarEdgeSelectionMode={
            activeTab === "rebar" &&
            rebarPhase === "lines" &&
            !pendingRebarLine
          }
          onPickRebarEdge={setSelectedRebarEdgeIndex}
          pendingRebarLine={pendingRebarLine}
          rebarAxis={rebarAxis}
          rebarSection={
            activeTab !== "rebar" || rebarPhase === "idle"
              ? null
              : rebarPhase === "end" || rebarPhase === "spacing"
                ? rebarEnd
                : rebarStart
          }
          showConcreteSkin={showConcreteSkin}
          rebarDrawing={Boolean(pendingRebarLine)}
          onPickRebarPoint={(point) =>
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
            })
          }
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
