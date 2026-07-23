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
  coplanarConvexHull,
  cross,
  normalize,
  slicePlanes,
  subtract,
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
  selectedFaceIds: string[];
  volumeConfirmed: boolean;
  pickTarget: PickTarget;
  tolerance: number;
  onHover: (payload: {
    node: ModelNode;
    clientX: number;
    clientY: number;
  } | null) => void;
  onPickNode: (nodeId: number) => void;
  onPickFace: (faceId: string) => void;
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
  for (let index = 1; index < vertices.length - 1; index += 1) {
    for (const vertex of [vertices[0], vertices[index], vertices[index + 1]]) {
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
  camera.position.set(
    center.x + distance * 0.78,
    center.y - distance * 0.7,
    center.z + distance * 0.48,
  );
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
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
  selectedFaceIds,
  volumeConfirmed,
  pickTarget,
  tolerance,
  onHover,
  onPickNode,
  onPickFace,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneState | null>(null);
  const faceMeshesRef = useRef<THREE.Mesh[]>([]);
  const fittedNodesRef = useRef<ModelNode[] | null>(null);
  const fittedBasisRef = useRef<LocalBasis | null>(null);
  const nodesRef = useRef(nodes);
  const sliceRef = useRef(slice);
  const pickTargetRef = useRef(pickTarget);
  const onHoverRef = useRef(onHover);
  const onPickNodeRef = useRef(onPickNode);
  const onPickFaceRef = useRef(onPickFace);
  const [renderError, setRenderError] = useState<string | null>(null);

  nodesRef.current = nodes;
  sliceRef.current = slice;
  pickTargetRef.current = pickTarget;
  onHoverRef.current = onHover;
  onPickNodeRef.current = onPickNode;
  onPickFaceRef.current = onPickFace;

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
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.screenSpacePanning = true;

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
      const pointer = new THREE.Vector2();

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

      const handleMove = (event: PointerEvent) => {
        const hit = getNodeHit(event);
        renderer.domElement.style.cursor = hit ? "crosshair" : "grab";
        if (hit?.index !== undefined) {
          onHoverRef.current({
            node: nodesRef.current[hit.index],
            clientX: event.clientX,
            clientY: event.clientY,
          });
        } else {
          onHoverRef.current(null);
        }
      };

      const handleClick = (event: PointerEvent) => {
        if (event.button !== 0) return;
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

      renderer.domElement.addEventListener("pointermove", handleMove);
      renderer.domElement.addEventListener("pointerleave", () =>
        onHoverRef.current(null),
      );
      renderer.domElement.addEventListener("click", handleClick);

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
        renderer.domElement.removeEventListener("click", handleClick);
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

    nodes.forEach((node, index) => {
      const value = node.local ?? node.global;
      positions[index * 3] = value.x - displayOffset.x;
      positions[index * 3 + 1] = value.y - displayOffset.y;
      positions[index * 3 + 2] = value.z - displayOffset.z;
      coordinates[index * 3] = value.x;
      coordinates[index * 3 + 1] = value.y;
      coordinates[index * 3 + 2] = value.z;
      const color = selectedNodeIds.includes(node.id) ? selected : base;
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
    if (
      fittedNodesRef.current !== allNodes ||
      fittedBasisRef.current !== basis
    ) {
      fitCamera(state.camera, state.controls, state.geometry);
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
    const colorAttribute = state?.geometry.getAttribute("nodeColor");
    if (!state || !colorAttribute || colorAttribute.count !== nodes.length) return;
    const base = new THREE.Color(0x72e6ff);
    const selected = new THREE.Color(0xffbf47);
    nodes.forEach((node, index) => {
      const color = selectedNodeIds.includes(node.id) ? selected : base;
      colorAttribute.setXYZ(index, color.r, color.g, color.b);
    });
    colorAttribute.needsUpdate = true;
  }, [nodes, selectedNodeIds]);

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
    if (draftNodeIds.length >= 3) {
      const draft = draftNodeIds
        .map((id) => nodeMap.get(id))
        .filter((node): node is ModelNode => Boolean(node))
        .map((node) => node.local ?? node.global);
      if (draft.length >= 3) {
        try {
          const normal = normalize(
            cross(subtract(draft[1], draft[0]), subtract(draft[2], draft[0])),
          );
          polygons.push({
            vertices: coplanarConvexHull(draft, normal),
            selected: true,
            isSlice: false,
          });
        } catch {
          // Two coincident draft points do not form a preview yet.
        }
      }
    }

    for (const polygon of polygons) {
      if (polygon.vertices.length < 3) continue;
      const geometry = triangulatePolygon(polygon.vertices, displayOffset);
      const material = new THREE.MeshBasicMaterial({
        color: polygon.selected
          ? 0xffbf47
          : polygon.isSlice
            ? 0xa9c3cc
            : 0x91afba,
        opacity: volumeConfirmed ? 0.19 : 0.25,
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
    }
  }, [
    allNodes,
    basis,
    displayOffset.x,
    displayOffset.y,
    displayOffset.z,
    draftNodeIds,
    faces,
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
