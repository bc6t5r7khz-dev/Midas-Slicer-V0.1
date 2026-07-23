"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ModelNode } from "../lib/types";

type SliceRange = { x: [number, number]; y: [number, number] };

type Props = {
  nodes: ModelNode[];
  slice: SliceRange;
  basisReady: boolean;
  selections: Array<number | null>;
  onHover: (payload: {
    node: ModelNode;
    clientX: number;
    clientY: number;
  } | null) => void;
  onPick: (index: number) => void;
};

type SceneState = {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  points: THREE.Points;
  raycaster: THREE.Raycaster;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  resizeObserver: ResizeObserver;
  animationId: number;
};

const vertexShader = `
  attribute vec3 nodeColor;
  attribute vec2 sliceCoord;
  varying vec3 vColor;
  varying float vLocalX;
  varying float vLocalY;

  void main() {
    vColor = nodeColor;
    vLocalX = sliceCoord.x;
    vLocalY = sliceCoord.y;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(72.0 / -mvPosition.z, 2.3, 7.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = `
  uniform vec2 xRange;
  uniform vec2 yRange;
  varying vec3 vColor;
  varying float vLocalX;
  varying float vLocalY;

  void main() {
    if (vLocalX < xRange.x || vLocalX > xRange.y ||
        vLocalY < yRange.x || vLocalY > yRange.y) discard;
    vec2 point = gl_PointCoord - vec2(0.5);
    if (dot(point, point) > 0.25) discard;
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

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
  slice,
  basisReady,
  selections,
  onHover,
  onPick,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneState | null>(null);
  const nodesRef = useRef(nodes);
  const sliceRef = useRef(slice);
  const onHoverRef = useRef(onHover);
  const onPickRef = useRef(onPick);

  nodesRef.current = nodes;
  sliceRef.current = slice;
  onHoverRef.current = onHover;
  onPickRef.current = onPick;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

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
    grid.material.opacity = 0.32;
    grid.material.transparent = true;
    scene.add(grid);

    const geometry = new THREE.BufferGeometry();
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: false,
      uniforms: {
        xRange: { value: new THREE.Vector2(-1e20, 1e20) },
        yRange: { value: new THREE.Vector2(-1e20, 1e20) },
      },
      vertexColors: true,
    });
    const points = new THREE.Points(geometry, material);
    scene.add(points);

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 1.2 };
    const pointer = new THREE.Vector2();

    const getHit = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      return raycaster
        .intersectObject(points)
        .find((hit) => {
          const node = nodesRef.current[hit.index ?? -1];
          if (!node) return false;
          const value = node.local ?? node.global;
          const range = sliceRef.current;
          return (
            value.x >= range.x[0] &&
            value.x <= range.x[1] &&
            value.y >= range.y[0] &&
            value.y <= range.y[1]
          );
        });
    };

    const handleMove = (event: PointerEvent) => {
      const hit = getHit(event);
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
      const hit = getHit(event);
      if (hit?.index !== undefined) onPickRef.current(hit.index);
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
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      animationId = requestAnimationFrame(animate);
    };
    animate();

    sceneRef.current = {
      camera,
      controls,
      geometry,
      material,
      points,
      raycaster,
      renderer,
      scene,
      resizeObserver,
      animationId,
    };

    return () => {
      cancelAnimationFrame(animationId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointermove", handleMove);
      renderer.domElement.removeEventListener("click", handleClick);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      controls.dispose();
      renderer.domElement.remove();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state || nodes.length === 0) return;

    const positions = new Float32Array(nodes.length * 3);
    const colors = new Float32Array(nodes.length * 3);
    const sliceCoordinates = new Float32Array(nodes.length * 2);
    const base = new THREE.Color(0x72e6ff);
    const selected = new THREE.Color(0xffbf47);

    let center = { x: 0, y: 0, z: 0 };
    if (!basisReady) {
      for (const node of nodes) {
        center.x += node.global.x;
        center.y += node.global.y;
        center.z += node.global.z;
      }
      center = {
        x: center.x / nodes.length,
        y: center.y / nodes.length,
        z: center.z / nodes.length,
      };
    }

    nodes.forEach((node, index) => {
      const value = node.local ?? node.global;
      positions[index * 3] = value.x - center.x;
      positions[index * 3 + 1] = value.y - center.y;
      positions[index * 3 + 2] = value.z - center.z;
      sliceCoordinates[index * 2] = value.x;
      sliceCoordinates[index * 2 + 1] = value.y;
      const color = selections.includes(index) ? selected : base;
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
      new THREE.BufferAttribute(sliceCoordinates, 2),
    );
    state.geometry.computeBoundingSphere();
    state.raycaster.params.Points.threshold = Math.max(
      (state.geometry.boundingSphere?.radius ?? 1) / 125,
      0.15,
    );
    fitCamera(state.camera, state.controls, state.geometry);
  }, [nodes, basisReady]);

  useEffect(() => {
    const state = sceneRef.current;
    const colorAttribute = state?.geometry.getAttribute("nodeColor");
    if (!state || !colorAttribute || colorAttribute.count !== nodes.length) return;
    const base = new THREE.Color(0x72e6ff);
    const selected = new THREE.Color(0xffbf47);
    nodes.forEach((_, index) => {
      const color = selections.includes(index) ? selected : base;
      colorAttribute.setXYZ(index, color.r, color.g, color.b);
    });
    colorAttribute.needsUpdate = true;
  }, [nodes, selections]);

  useEffect(() => {
    const material = sceneRef.current?.material;
    if (!material) return;
    material.uniforms.xRange.value.set(slice.x[0], slice.x[1]);
    material.uniforms.yRange.value.set(slice.y[0], slice.y[1]);
  }, [slice]);

  return <div ref={hostRef} className="viewport-canvas" aria-label="3D node cloud" />;
}
