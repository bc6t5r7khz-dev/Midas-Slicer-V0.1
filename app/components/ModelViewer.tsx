"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createLocalBasis,
  getBounds,
  transformNodes,
} from "../lib/coordinateSystem";
import { parseMctNodes } from "../lib/mctParser";
import { createSampleMct } from "../lib/sampleModel";
import type {
  BasisSelection,
  Bounds,
  ModelNode,
  SelectionSlot,
} from "../lib/types";
import PointCloudViewport from "./PointCloudViewport";
import RangeControl from "./RangeControl";

const EMPTY_SELECTION: BasisSelection = {
  origin: null,
  axis: null,
  plane: null,
};

const SLOT_META: Array<{
  key: SelectionSlot;
  step: string;
  label: string;
  help: string;
}> = [
  { key: "origin", step: "01", label: "Origin", help: "Local zero point" },
  { key: "axis", step: "02", label: "Longitudinal", help: "Positive local X" },
  { key: "plane", step: "03", label: "Transverse", help: "Local XY plane" },
];

const formatCoordinate = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);

const fullSlice = (bounds: Bounds) => ({
  x: [...bounds.x] as [number, number],
  y: [...bounds.y] as [number, number],
});

export default function ModelViewer() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [nodes, setNodes] = useState<ModelNode[]>([]);
  const [fileName, setFileName] = useState("Demo bridge lattice");
  const [basisSelection, setBasisSelection] =
    useState<BasisSelection>(EMPTY_SELECTION);
  const [pickMode, setPickMode] = useState<SelectionSlot | null>("origin");
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [slice, setSlice] = useState({
    x: [0, 1] as [number, number],
    y: [0, 1] as [number, number],
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

  const basisReady = nodes.length > 0 && nodes[0].local !== null;

  const loadText = useCallback((text: string, name: string) => {
    try {
      const result = parseMctNodes(text);
      const globalBounds = getBounds(result.nodes, false);
      setNodes(result.nodes);
      setBounds(globalBounds);
      setSlice(fullSlice(globalBounds));
      setBasisSelection(EMPTY_SELECTION);
      setPickMode("origin");
      setFileName(name);
      setSelectedNode(null);
      setError(null);
      setStatus(
        `${result.nodes.length.toLocaleString()} nodes parsed${
          result.skippedLines ? ` · ${result.skippedLines} lines skipped` : ""
        }`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to read file.");
    }
  }, []);

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

  const handlePick = (index: number) => {
    const node = nodes[index];
    if (!node) return;
    setSelectedNode(node);
    if (!pickMode) return;

    const nextSelection = { ...basisSelection, [pickMode]: index };
    setBasisSelection(nextSelection);
    const currentStep = SLOT_META.findIndex((slot) => slot.key === pickMode);
    setPickMode(SLOT_META[currentStep + 1]?.key ?? null);
    setStatus(`Node ${node.id} set as ${pickMode}.`);
  };

  const applyBasis = () => {
    const origin = basisSelection.origin;
    const axis = basisSelection.axis;
    const plane = basisSelection.plane;
    if (origin === null || axis === null || plane === null) return;
    if (new Set([origin, axis, plane]).size < 3) {
      setError("Use three different nodes to define the local basis.");
      return;
    }

    try {
      const localBasis = createLocalBasis(
        nodes[origin].global,
        nodes[axis].global,
        nodes[plane].global,
      );
      const transformed = transformNodes(nodes, localBasis);
      const localBounds = getBounds(transformed);
      setNodes(transformed);
      setBounds(localBounds);
      setSlice(fullSlice(localBounds));
      setError(null);
      setStatus("Local coordinate system applied.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not create the local coordinate system.",
      );
    }
  };

  const resetBasis = () => {
    const globalNodes = nodes.map((node) => ({ ...node, local: null }));
    const globalBounds = getBounds(globalNodes, false);
    setNodes(globalNodes);
    setBounds(globalBounds);
    setSlice(fullSlice(globalBounds));
    setBasisSelection(EMPTY_SELECTION);
    setPickMode("origin");
    setStatus("Local coordinate system cleared.");
  };

  const selectedIndexes = [
    basisSelection.origin,
    basisSelection.axis,
    basisSelection.plane,
  ];

  const visibleCount = useMemo(
    () =>
      nodes.reduce((count, node) => {
        const value = node.local ?? node.global;
        return (
          count +
          (value.x >= slice.x[0] &&
          value.x <= slice.x[1] &&
          value.y >= slice.y[0] &&
          value.y <= slice.y[1]
            ? 1
            : 0)
        );
      }, 0),
    [nodes, slice],
  );

  const pickInstruction = pickMode
    ? `Pick ${SLOT_META.find((slot) => slot.key === pickMode)?.label.toLowerCase()} node`
    : "Inspect mode";

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
            <span>NODE CLOUD INSPECTOR</span>
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
          <button className="button ghost" onClick={() => loadText(createSampleMct(), "Demo bridge lattice")}>
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
        <section className="panel-section intro">
          <span className="eyebrow">LOCAL COORDINATES</span>
          <h1>Define the inspection frame</h1>
          <p>Choose three nodes in the viewport. The basis is orthogonalized automatically.</p>
        </section>

        <section className="basis-steps">
          {SLOT_META.map((slot) => {
            const index = basisSelection[slot.key];
            const node = index === null ? null : nodes[index];
            const active = pickMode === slot.key;
            return (
              <button
                key={slot.key}
                className={`basis-step ${active ? "active" : ""} ${node ? "complete" : ""}`}
                onClick={() => setPickMode(slot.key)}
                aria-pressed={active}
              >
                <span className="step-number">{slot.step}</span>
                <span>
                  <strong>{slot.label}</strong>
                  <small>{node ? `Node ${node.id}` : slot.help}</small>
                </span>
                <span className="step-state">{node ? "✓" : active ? "PICK" : "—"}</span>
              </button>
            );
          })}
        </section>

        <div className="basis-actions">
          <button
            className="button primary wide"
            disabled={selectedIndexes.some((value) => value === null)}
            onClick={applyBasis}
          >
            Build local frame
          </button>
          <button className="text-button" onClick={resetBasis}>
            Reset frame
          </button>
        </div>

        <section className="node-card">
          <span className="eyebrow">SELECTED NODE</span>
          {selectedNode ? (
            <>
              <div className="node-id">#{selectedNode.id}</div>
              <dl>
                {(["x", "y", "z"] as const).map((axis) => (
                  <div key={axis}>
                    <dt>{selectedNode.local ? `L${axis.toUpperCase()}` : axis.toUpperCase()}</dt>
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
            <p>Hover or click a point to inspect its ID and coordinates.</p>
          )}
        </section>

        <footer className="rail-footer">
          <span>{status}</span>
          <span>Three.js · browser only</span>
        </footer>
      </aside>

      <section className="viewport">
        <PointCloudViewport
          nodes={nodes}
          slice={slice}
          basisReady={basisReady}
          selections={selectedIndexes}
          onHover={setHover}
          onPick={handlePick}
        />

        <div className="view-hud top-left">
          <span className={`mode-indicator ${pickMode ? "picking" : ""}`} />
          <strong>{pickInstruction}</strong>
          <span>Left drag orbit · Right drag pan · Scroll zoom</span>
        </div>

        <div className="axis-badge" aria-label="Local axis legend">
          <span className="axis-x">X</span>
          <span className="axis-y">Y</span>
          <span className="axis-z">Z</span>
          <small>{basisReady ? "LOCAL" : "GLOBAL PREVIEW"}</small>
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

        {bounds && (
          <div className="slicer-panel">
            <div className="slicer-header">
              <div>
                <span className="eyebrow">LIVE SLICING</span>
                <strong>{basisReady ? "Local plane filter" : "Global preview filter"}</strong>
              </div>
              <div className="visible-stat">
                <strong>{visibleCount.toLocaleString()}</strong>
                <span>of {nodes.length.toLocaleString()} visible</span>
              </div>
            </div>
            <RangeControl
              axis="X"
              bounds={bounds.x}
              value={slice.x}
              onChange={(value) => setSlice((current) => ({ ...current, x: value }))}
            />
            <RangeControl
              axis="Y"
              bounds={bounds.y}
              value={slice.y}
              onChange={(value) => setSlice((current) => ({ ...current, y: value }))}
            />
            <button
              className="text-button"
              onClick={() => setSlice(fullSlice(bounds))}
            >
              Show full extent
            </button>
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

      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError(null)}>×</button>
        </div>
      )}
    </main>
  );
}
