"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { toLocal, transformPlane } from "../lib/coordinateSystem";
import type {
  LocalBasis,
  ModelNode,
  SliceRanges,
  Vec3,
  VolumeFace,
} from "../lib/types";
import {
  buildPolyhedron,
  clipPolygonToPlanes,
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
  onCycleSmartAxis?: () => void;
};

type SceneState = {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  faceGroup: THREE.Group;
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
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      materials.forEach((material) => material.dispose());
    }
  }
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
  onHover,
  onHoverFace,
  onPickNode,
  onPickFace,
  onRemoveFaceVertex,
  onInsertFaceVertex,
  onCycleSmartAxis,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneState | null>(null);
  const faceMeshesRef = useRef<THREE.Mesh[]>([]);
  const faceEdgesRef = useRef<THREE.Line[]>([]);
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
  const onCycleSmartAxisRef = useRef(onCycleSmartAxis);
  const displayOffsetRef = useRef<Vec3>({ x: 0, y: 0, z: 0 });
  const toleranceRef = useRef(tolerance);
  const [renderError, setRenderError] = useState<string | null>(null);

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
  onCycleSmartAxisRef.current = onCycleSmartAxis;

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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    try {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x071018);
      scene.fog = new THREE.FogExp2(0x071018, 0.0014);

      const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000000);
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      host.appendChild(renderer.domElement);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false;
      controls.screenSpacePanning = true;
      controls.panSpeed = 1;
      controls.zoomSpeed = 0.9;
      controls.zoomToCursor = true;
      controls.mouseButtons.LEFT = null as unknown as THREE.MOUSE;
      controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
      controls.mouseButtons.RIGHT = null as unknown as THREE.MOUSE;

      const grid = new THREE.GridHelper(240, 24, 0x254255, 0x142835);
      grid.rotation.x = Math.PI / 2;
      grid.material.opacity = 0.28;
      grid.material.transparent = true;
      scene.add(grid);

      const faceGroup = new THREE.Group();
      scene.add(faceGroup);

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
      let orbitDrag: {
        pointerId: number;
        x: number;
        y: number;
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

      const getSnapNode = (faceId: string, event: PointerEvent) => {
        const face = facesRef.current.find((candidate) => candidate.id === faceId);
        if (!face) return null;
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
          if (planeDistance > toleranceRef.current * 2) continue;
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

      const rotateWithSwappedAxes = (deltaX: number, deltaY: number) => {
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
        spherical.theta -= deltaY * radiansPerPixel;
        spherical.phi -= deltaX * radiansPerPixel;
        spherical.makeSafe();
        offset.setFromSpherical(spherical).applyQuaternion(fromYUp);
        camera.position.copy(controls.target).add(offset);
        camera.lookAt(controls.target);
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
        if (orbitDrag && !edgeDrag) {
          rotateWithSwappedAxes(
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
          event.preventDefault();
          return;
        }
        if (event.button === 3 && onCycleSmartAxisRef.current) {
          event.preventDefault();
          onCycleSmartAxisRef.current();
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
        if (event.button === 1 || event.button === 3) event.preventDefault();
      };

      renderer.domElement.addEventListener("pointermove", handleMove);
      const handleLeave = () => {
        onHoverRef.current(null);
        onHoverFaceRef.current(null);
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

      const animate = () => {
        try {
          controls.update();
          renderer.render(scene, camera);
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
      animate();

      sceneRef.current = {
        camera,
        controls,
        faceGroup,
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
    if (!state || !nodes.length) return;

    const positions = new Float32Array(nodes.length * 3);
    const colors = new Float32Array(nodes.length * 3);
    const coordinates = new Float32Array(nodes.length * 3);
    const base = new THREE.Color(0x72e6ff);
    const selected = new THREE.Color(0xffbf47);
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
    const base = new THREE.Color(0x72e6ff);
    const selected = new THREE.Color(0xffbf47);
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
    <div ref={hostRef} className="viewport-canvas" aria-label="3D node cloud" />
  );
}
