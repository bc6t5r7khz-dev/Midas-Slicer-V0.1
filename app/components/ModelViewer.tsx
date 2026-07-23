"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createBasisFromFloor,
  getBounds,
  transformNodes,
} from "../lib/coordinateSystem";
import { autoHullFaces } from "../lib/autoVolume";
import { parseMctNodes } from "../lib/mctParser";
import { createSampleMct } from "../lib/sampleModel";
import { smartFaceFromSeed } from "../lib/smartSelect";
import type {
  Bounds,
  LocalBasis,
  ModelNode,
  SliceRanges,
  VolumeFace,
  WorkflowTab,
} from "../lib/types";
import {
  autoBoxFaces,
  buildPolyhedron,
  centroid,
  createFace,
  isInsidePlanes,
  isPointWithinFace,
  modelTolerance,
} from "../lib/volumeGeometry";
import PointCloudViewport from "./PointCloudViewport";
import RangeControl from "./RangeControl";

const TABS: Array<{ id: WorkflowTab; label: string; number: string }> = [
  { id: "volume", label: "Volume Definition", number: "01" },
  { id: "coordinates", label: "Coordinates", number: "02" },
  { id: "slicing", label: "Slicing", number: "03" },
];

const formatCoordinate = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);

const fullSlice = (bounds: Bounds): SliceRanges => ({
  x: [...bounds.x],
  y: [...bounds.y],
  z: [...bounds.z],
});

export default function ModelViewer() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [allNodes, setAllNodes] = useState<ModelNode[]>([]);
  const [fileName, setFileName] = useState("Demo bridge lattice");
  const [globalBounds, setGlobalBounds] = useState<Bounds | null>(null);
  const [activeTab, setActiveTab] = useState<WorkflowTab>("volume");
  const [faces, setFaces] = useState<VolumeFace[]>([]);
  const [definingFaces, setDefiningFaces] = useState(false);
  const [smartSelecting, setSmartSelecting] = useState(false);
  const [draftNodeIds, setDraftNodeIds] = useState<number[]>([]);
  const [selectedFaceIds, setSelectedFaceIds] = useState<Set<string>>(
    new Set(),
  );
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

  const tolerance = globalBounds ? modelTolerance(globalBounds) : 1e-6;
  const facePlanes = useMemo(() => faces.map((face) => face.plane), [faces]);
  const definingNodeIds = useMemo(
    () => new Set(faces.flatMap((face) => face.nodeIds)),
    [faces],
  );

  const displayNodes = useMemo(() => {
    if (!allNodes.length) return [];
    const draftSet = new Set(draftNodeIds);

    return allNodes.filter((node) => {
      const onFace = faces.some((face) =>
        isPointWithinFace(node.global, face, tolerance),
      );

      if (!volumeConfirmed) {
        return !onFace || draftSet.has(node.id);
      }

      const inside = isInsidePlanes(node.global, facePlanes, tolerance);
      return (
        inside &&
        (!onFace || definingNodeIds.has(node.id) || draftSet.has(node.id))
      );
    });
  }, [
    allNodes,
    definingNodeIds,
    draftNodeIds,
    faces,
    facePlanes,
    tolerance,
    volumeConfirmed,
  ]);

  const currentBounds = useMemo(() => {
    if (!allNodes.length) return null;
    const candidates = displayNodes.length ? displayNodes : allNodes;
    return getBounds(candidates, Boolean(basis));
  }, [allNodes, basis, displayNodes]);

  const resetWorkflow = useCallback((nodes: ModelNode[], bounds: Bounds) => {
    setAllNodes(nodes);
    setGlobalBounds(bounds);
    setFaces([]);
    setDefiningFaces(false);
    setSmartSelecting(false);
    setDraftNodeIds([]);
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
        const result = parseMctNodes(text);
        const bounds = getBounds(result.nodes, false);
        resetWorkflow(result.nodes, bounds);
        setFileName(name);
        setError(null);
        setStatus(
          `${result.nodes.length.toLocaleString()} nodes parsed${
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
    loadText(createSampleMct(), "Demo bridge lattice");
  }, [loadText]);

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
      const face = createFace(
        `face-${crypto.randomUUID()}`,
        `Face ${nextNumber}`,
        selected,
        centroid(allNodes.map((node) => node.global)),
        tolerance,
      );
      setFaces((current) => [...current, face]);
      setDraftNodeIds([]);
      setVolumeConfirmed(false);
      setStatus(`${face.label} created. Select the next face.`);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not create face.",
      );
    }
  }, [allNodes, draftNodeIds, faces.length, globalBounds, tolerance]);

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
      if (
        event.code === "Space" &&
        definingFaces
      ) {
        event.preventDefault();
        commitDraftFace();
      }
      if (event.code === "Backspace") {
        event.preventDefault();
        if (draftNodeIds.length) {
          setDraftNodeIds((current) => current.slice(0, -1));
          setStatus("Last selected point removed.");
        } else {
          removeLastFace();
        }
      }
      if (
        event.code === "Escape" &&
        definingFaces
      ) {
        setDraftNodeIds([]);
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

    if (activeTab === "volume" && smartSelecting) {
      try {
        const candidate =
          hover?.node.id === nodeId && smartPreviewFace
            ? smartPreviewFace
            : smartFaceFromSeed(allNodes, nodeId, tolerance);
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
      setDraftNodeIds((current) => {
        if (current.includes(nodeId)) return current.filter((id) => id !== nodeId);
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
      setSelectedFaceIds((current) => {
        const next = new Set(current);
        if (next.has(faceId)) next.delete(faceId);
        else next.add(faceId);
        return next;
      });
    }
  };

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

  const confirmVolume = () => {
    const polyhedron = buildPolyhedron(facePlanes, tolerance);
    if (!polyhedron) {
      setConfirmWarning(true);
      return;
    }
    const retained = allNodes.filter((node) =>
      isInsidePlanes(node.global, facePlanes, tolerance),
    );
    if (retained.length) {
      setSlice(fullSlice(getBounds(retained, Boolean(basis))));
    }
    setVolumeConfirmed(true);
    setDefiningFaces(false);
    setSmartSelecting(false);
    setDraftNodeIds([]);
    setStatus("Closed inspection volume confirmed.");
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
        `${generated.length} shape-aware hull faces generated. Review or confirm the volume.`,
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

  const visibleCount = useMemo(() => {
    return displayNodes.reduce((count, node) => {
      const value = node.local ?? node.global;
      const visible =
        value.x >= slice.x[0] &&
        value.x <= slice.x[1] &&
        value.y >= slice.y[0] &&
        value.y <= slice.y[1] &&
        value.z >= slice.z[0] &&
        value.z <= slice.z[1];
      return count + (visible ? 1 : 0);
    }, 0);
  }, [displayNodes, slice]);

  const selectedNodeIds = useMemo(
    () => [...draftNodeIds, ...xDirectionNodeIds],
    [draftNodeIds, xDirectionNodeIds],
  );
  const highlightedFaceIds = useMemo(() => {
    const next = new Set(selectedFaceIds);
    if (floorFaceId) next.add(floorFaceId);
    return [...next];
  }, [floorFaceId, selectedFaceIds]);

  const instruction =
    activeTab === "volume"
      ? definingFaces
        ? `${draftNodeIds.length} nodes · Space creates face`
        : smartSelecting
          ? smartPreviewFace
            ? "Click to add the highlighted face"
            : "Hover an exterior planar patch"
          : "Begin, Smart Select, or Auto-Define"
      : activeTab === "coordinates"
        ? !floorFaceId
          ? "Select the floor face"
          : xDirectionNodeIds.length < 2
            ? `Pick X direction node ${xDirectionNodeIds.length + 1}/2`
            : "Local coordinates active"
        : "Adjust X, Y, and Z slice ranges";

  return (
    <main
      className="app-shell"
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
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
                Pick 3 or more coplanar nodes and press Space, or hover and
                click with Smart Select. Only nodes inside the face boundary
                peel away.
              </p>
            </section>

            <div className="action-grid">
              <button
                className={`button ${definingFaces ? "primary" : ""}`}
                onClick={() => {
                  setDefiningFaces((current) => !current);
                  setSmartSelecting(false);
                  setDraftNodeIds([]);
                  setVolumeConfirmed(false);
                }}
              >
                {definingFaces ? "Defining…" : "Begin"}
              </button>
              <button
                className={`button ${smartSelecting ? "primary" : ""}`}
                onClick={() => {
                  setSmartSelecting((current) => {
                    const next = !current;
                    setStatus(
                      next
                        ? "Hover a planar exterior patch, then click to add it."
                        : "Smart Select ended.",
                    );
                    return next;
                  });
                  setDefiningFaces(false);
                  setDraftNodeIds([]);
                  setVolumeConfirmed(false);
                }}
              >
                Smart Select
              </button>
              <button className="button auto-wide" onClick={autoDefine}>
                Auto-Define
              </button>
            </div>

            {definingFaces && (
              <div className="selection-callout">
                <strong>{draftNodeIds.length} selected</strong>
                <span>
                  {draftNodeIds.length >= 3
                    ? "Press Space to create this face"
                    : `Pick ${3 - draftNodeIds.length} more node${
                        3 - draftNodeIds.length === 1 ? "" : "s"
                      }`}
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
                        onChange={() => handleFacePick(face.id)}
                      />
                      <span>
                        <strong>{face.label}</strong>
                        <small>
                          {face.automatic
                            ? "Auto plane"
                            : face.smart
                              ? `Smart plane · ${face.nodeIds.length} boundary nodes`
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
                disabled={faces.length < 4}
                onClick={confirmVolume}
              >
                {volumeConfirmed ? "Volume Confirmed" : "Confirm Volume"}
              </button>
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
          </div>
        )}

        {activeTab === "slicing" && currentBounds && (
          <div className="tab-content slicing-content">
            <section className="panel-section intro compact">
              <span className="eyebrow">LIVE CLIPPING</span>
              <h1>Peel back the volume</h1>
              <p>
                Black edges track every cut through the confirmed volume.
              </p>
            </section>
            <div className="slice-count">
              <strong>{visibleCount.toLocaleString()}</strong>
              <span>of {displayNodes.length.toLocaleString()} visible</span>
            </div>
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
          selectedFaceIds={highlightedFaceIds}
          volumeConfirmed={volumeConfirmed}
          pickTarget={
            activeTab === "coordinates" && !floorFaceId ? "face" : "node"
          }
          tolerance={tolerance}
          onHover={setHover}
          onPickNode={handleNodePick}
          onPickFace={handleFacePick}
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
          <span>Left drag orbit · Right drag pan · Scroll zoom</span>
        </div>

        <div className="axis-badge" aria-label="Local axis legend">
          <span className="axis-x">X</span>
          <span className="axis-y">Y</span>
          <span className="axis-z">Z</span>
          <small>{basis ? "LOCAL" : "MODEL"}</small>
        </div>

        {hover && (
          <div
            className="hover-label"
            style={{ left: hover.clientX + 14, top: hover.clientY + 14 }}
          >
            <strong>NODE {hover.node.id}</strong>
            <span>
              {(["x", "y", "z"] as const)
                .map((axis) =>
                  formatCoordinate((hover.node.local ?? hover.node.global)[axis]),
                )
                .join(" · ")}
            </span>
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
