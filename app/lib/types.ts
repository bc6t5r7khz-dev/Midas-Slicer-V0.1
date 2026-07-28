export type Vec3 = { x: number; y: number; z: number };
export type Axis = "x" | "y" | "z";

export type ModelNode = {
  id: number;
  global: Vec3;
  local: Vec3 | null;
};

export type ModelElement = {
  id: number;
  type: "PLATE" | "PLSTRS" | "PLSTRN" | "AXISYM" | "SOLID";
  nodeIds: number[];
};

export type ElementSurface = {
  id: string;
  elementId: number;
  nodeIds: number[];
  vertices: Vec3[];
  source: "plate" | "solid";
};

export type ElementShell = {
  id: string;
  surfaceIds: string[];
  closed: boolean;
  boundaryEdgeCount: number;
  nonManifoldEdgeCount: number;
};

export type LocalBasis = {
  origin: Vec3;
  xAxis: Vec3;
  yAxis: Vec3;
  zAxis: Vec3;
};

export type Bounds = Record<Axis, [number, number]>;
export type SliceRanges = Record<Axis, [number, number]>;

/** Plane convention: normal · point + constant <= 0 is inside. */
export type PlaneDefinition = {
  normal: Vec3;
  constant: number;
};

export type VolumeFace = {
  id: string;
  label: string;
  nodeIds: number[];
  vertices: Vec3[];
  plane: PlaneDefinition;
  automatic?: boolean;
  smart?: boolean;
  fitted?: boolean;
  fitDeviation?: number;
};

export type Polyhedron = {
  faces: Array<{ planeIndex: number; vertices: Vec3[] }>;
  vertices: Vec3[];
};

export type RebarLine = {
  id: string;
  points: Vec3[];
  closed?: boolean;
};

export type RebarPlane = {
  id: string;
  name: string;
  color: string;
  /** Stable model-space point on the plane family. */
  objectOrigin: Vec3;
  /** Stable model-space normal. Positive offsets move along this vector. */
  objectNormal: Vec3;
  /** The two model nodes originally used to define the vertical plane. */
  nodeIds: number[];
};

export type RebarGroup = {
  id: string;
  name: string;
  visible: boolean;
};

export type CameraViewpoint = {
  position: Vec3;
  target: Vec3;
  up: Vec3;
};

export type SlicePin = {
  id: string;
  name: string;
  planeId: string;
  offset: number;
  viewpoint?: CameraViewpoint;
};

export type RebarRun = {
  id: string;
  name: string;
  color?: string;
  barNumber?: string;
  planeId?: string | null;
  groupId?: string;
  startOffset?: number;
  endOffset?: number;
  axis: Axis;
  start: number;
  end: number;
  distributionMode?: "axis" | "edge" | "path";
  distributionVector?: Vec3;
  pathStart?: Vec3;
  pathEnd?: Vec3;
  /** Ordered anchors for a bar run distributed along a bent/polyline path. */
  pathPoints?: Vec3[];
  objectLines?: RebarLine[];
  objectPathStart?: Vec3;
  objectPathEnd?: Vec3;
  objectPathPoints?: Vec3[];
  spacingInches: number;
  lappedFromRunId?: string;
  lapOffsetInches?: number;
  positions: number[];
  lines: RebarLine[];
};

export type WorkflowTab = "volume" | "coordinates" | "slicing" | "rebar";
