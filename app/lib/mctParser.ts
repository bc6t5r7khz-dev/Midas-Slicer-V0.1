import type { ModelNode } from "./types";

export type ParseResult = {
  nodes: ModelNode[];
  skippedLines: number;
  duplicateIds: number;
};

const SECTION_LINE = /^\s*\*([A-Z0-9_-]+)/i;

/**
 * Parses only the *NODE block of a MIDAS Civil MCT export.
 * Expected records are: node id, X, Y, Z[, ignored fields...].
 */
export function parseMctNodes(source: string): ParseResult {
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  const nodesById = new Map<number, ModelNode>();
  let inNodeSection = false;
  let foundNodeSection = false;
  let skippedLines = 0;
  let duplicateIds = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";")) continue;

    const section = line.match(SECTION_LINE);
    if (section) {
      const name = section[1].toUpperCase();
      if (name === "NODE") {
        inNodeSection = true;
        foundNodeSection = true;
        continue;
      }
      if (inNodeSection) break;
      continue;
    }

    if (!inNodeSection) continue;

    const fields = line.split(",").map((field) => field.trim());
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
  };
}
