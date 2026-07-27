import type { ModelElement, ModelNode } from "./types";

export type ParseResult = {
  nodes: ModelNode[];
  skippedLines: number;
  duplicateIds: number;
  elements: ModelElement[];
  skippedElements: number;
};

const SECTION_LINE = /^\s*\*([A-Z0-9_-]+)/i;

/**
 * Parses only the *NODE block of a MIDAS Civil MCT export.
 * Expected records are: node id, X, Y, Z[, ignored fields...].
 */
export function parseMctModel(source: string): ParseResult {
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  const nodesById = new Map<number, ModelNode>();
  let inNodeSection = false;
  let foundNodeSection = false;
  let skippedLines = 0;
  let duplicateIds = 0;
  let sectionName = "";
  let skippedElements = 0;
  const elements: ModelElement[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";")) continue;

    const section = line.match(SECTION_LINE);
    if (section) {
      const name = section[1].toUpperCase();
      sectionName = name;
      if (name === "NODE") {
        inNodeSection = true;
        foundNodeSection = true;
        continue;
      }
      inNodeSection = false;
      continue;
    }

    const fields = line.split(",").map((field) => field.trim());
    if (sectionName === "ELEMENT") {
      const id = Number(fields[0]);
      const type = fields[1]?.toUpperCase() as ModelElement["type"];
      const supported = new Set([
        "PLATE",
        "PLSTRS",
        "PLSTRN",
        "AXISYM",
        "SOLID",
      ]);
      const limit = type === "SOLID" ? 8 : 4;
      const nodeIds = fields
        .slice(4, 4 + limit)
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0)
        .filter((value, index, values) => values.indexOf(value) === index);
      const minimum = type === "SOLID" ? 4 : 3;
      if (!Number.isInteger(id) || !supported.has(type) || nodeIds.length < minimum) {
        if (supported.has(type)) skippedElements += 1;
        continue;
      }
      elements.push({ id, type, nodeIds });
      continue;
    }

    if (!inNodeSection) continue;
    if (fields.length < 4) {
      skippedLines += 1;
      continue;
    }

    const id = Number(fields[0]);
    const x = Number(fields[1]);
    const y = Number(fields[2]);
    const z = Number(fields[3]);

    if (!Number.isInteger(id) || ![x, y, z].every(Number.isFinite)) {
      skippedLines += 1;
      continue;
    }

    if (nodesById.has(id)) duplicateIds += 1;
    nodesById.set(id, {
      id,
      global: { x, y, z },
      local: null,
    });
  }

  if (!foundNodeSection) {
    throw new Error("No *NODE section was found in this file.");
  }
  if (nodesById.size === 0) {
    throw new Error("The *NODE section did not contain any valid node records.");
  }

  return {
    nodes: [...nodesById.values()],
    skippedLines,
    duplicateIds,
    elements,
    skippedElements,
  };
}

export const parseMctNodes = parseMctModel;
