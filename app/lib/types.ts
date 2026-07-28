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

export type RebarRun = {
  id: string;
  name: string;
  color?: string;
  axis: Axis;
  start: number;
  end: number;
  distributionMode?: "axis" | "edge" | "path";
  distributionVector?: Vec3;
  pathStart?: Vec3;
  pathEnd?: Vec3;
  objectLines?: RebarLine[];
  objectPathStart?: Vec3;
  objectPathEnd?: Vec3;
  spacingInches: number;
  lappedFromRunId?: string;
  lapOffsetInches?: number;
  positions: number[];
  lines: RebarLine[];
};

export type WorkflowTab = "volume" | "coordinates" | "slicing" | "rebar";
