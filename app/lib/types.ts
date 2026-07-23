export type Vec3 = { x: number; y: number; z: number };

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

export type Bounds = {
  x: [number, number];
  y: [number, number];
  z: [number, number];
};

export type SelectionSlot = "origin" | "axis" | "plane";

export type BasisSelection = Record<SelectionSlot, number | null>;
