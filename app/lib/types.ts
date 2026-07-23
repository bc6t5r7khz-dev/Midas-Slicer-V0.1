export type Vec3 = { x: number; y: number; z: number };
export type Axis = "x" | "y" | "z";

export type ModelNode = {
  id: number;
  global: Vec3;
  local: Vec3 | null;
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
};

export type Polyhedron = {
  faces: Array<{ planeIndex: number; vertices: Vec3[] }>;
  vertices: Vec3[];
};

export type WorkflowTab = "volume" | "coordinates" | "slicing";
