import { rebarInstanceLength } from "./rebarAdvanced";
import { rebarBendStandard } from "./rebarStandards";
import type { RebarLine, RebarRun, Vec3 } from "./types";

export const NHDOT_REBAR_SOURCE =
  "https://gis.dot.nh.gov/plan/43444.POP.pdf";

export const NHDOT_UNIT_WEIGHTS_LB_PER_FT: Record<string, number> = {
  "3": 0.376,
  "4": 0.668,
  "5": 1.043,
  "6": 1.502,
  "7": 2.044,
  "8": 2.67,
  "9": 3.4,
  "10": 4.303,
  "11": 5.313,
  "14": 7.65,
  "18": 13.6,
};

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "R", "O"] as const;
export type ScheduleLetter = (typeof LETTERS)[number];

type BendTemplate = {
  type: `N${number}`;
  labels: ScheduleLetter[];
  turns: number[];
  preferredOmissions?: ScheduleLetter[];
  derived?: ScheduleLetter[];
};

// Signed turns and letter order follow the NHDOT standard bend sheet. The
// matcher also tests mirrored, reversed, and permitted terminal-omission forms.
const NHDOT_TEMPLATES: BendTemplate[] = [
  { type: "N1", labels: ["A", "B", "C", "D", "G"], turns: [90, -90, -90, -90], preferredOmissions: ["A", "G"], derived: ["R"] },
  { type: "N2", labels: ["B", "C", "D", "E"], turns: [90, 90, 45], derived: ["H", "K"] },
  { type: "N3", labels: ["B", "D", "C"], turns: [90, 135], derived: ["K", "R"] },
  { type: "N4", labels: ["B", "C", "D"], turns: [135, -135], derived: ["H", "K"] },
  { type: "N5", labels: ["C", "B", "D"], turns: [45, 90] },
  { type: "N6", labels: ["H", "C", "D", "K", "B"], turns: [-90, 45, -90, 45] },
  { type: "N7", labels: ["D", "C", "H"], turns: [-45, -45], derived: ["K"] },
  { type: "N8", labels: ["B", "C"], turns: [-90] },
  { type: "N9", labels: ["C", "B", "D"], turns: [45, 135] },
  { type: "N10", labels: ["K", "H", "B", "C", "D", "J", "R"], turns: [-90, -45, 45, -45, 45, -90] },
  { type: "N11", labels: ["A", "B", "C", "D", "E"], turns: [45, -45, -45, 45], derived: ["H", "J", "K"] },
  { type: "N12", labels: ["A", "B", "C", "D", "G"], turns: [-90, -90, -90, -90], derived: ["H", "R"] },
];

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (value: Vec3, amount: number): Vec3 => ({ x: value.x * amount, y: value.y * amount, z: value.z * amount });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const magnitude = (value: Vec3) => Math.hypot(value.x, value.y, value.z);
const normalize = (value: Vec3): Vec3 => {
  const length = magnitude(value) || 1;
  return scale(value, 1 / length);
};
const distance = (a: Vec3, b: Vec3) => magnitude(subtract(a, b));
const degrees = (radians: number) => (radians * 180) / Math.PI;
const angleDifference = (a: number, b: number) => {
  const delta = ((a - b + 180) % 360 + 360) % 360 - 180;
  return Math.abs(delta);
};

type CleanGeometry = {
  points: Vec3[];
  segmentLengths: number[];
  turns: number[];
  closed: boolean;
  planar: boolean;
  straight: boolean;
  cleanup: string[];
  planeNormal: Vec3;
};

const stitchLines = (lines: RebarLine[], inchesPerModelUnit: number) => {
  const chains = lines
    .filter((line) => line.points.length >= 2)
    .map((line) => line.points.map((point) => scale(point, inchesPerModelUnit)));
  if (!chains.length) return { points: [] as Vec3[], disconnected: false, closed: false };
  const points = [...chains.shift()!];
  let disconnected = false;
  const joinTolerance = 1;
  while (chains.length) {
    let best = { index: 0, reverse: false, prepend: false, gap: Infinity };
    chains.forEach((chain, index) => {
      const options = [
        { reverse: false, prepend: false, gap: distance(points[points.length - 1], chain[0]) },
        { reverse: true, prepend: false, gap: distance(points[points.length - 1], chain[chain.length - 1]) },
        { reverse: false, prepend: true, gap: distance(points[0], chain[chain.length - 1]) },
        { reverse: true, prepend: true, gap: distance(points[0], chain[0]) },
      ];
      options.forEach((option) => {
        if (option.gap < best.gap) best = { index, ...option };
      });
    });
    const chain = [...chains.splice(best.index, 1)[0]];
    if (best.reverse) chain.reverse();
    if (best.gap > joinTolerance) disconnected = true;
    if (best.prepend) {
      if (best.gap <= joinTolerance) chain.pop();
      points.unshift(...chain);
    } else {
      if (best.gap <= joinTolerance) chain.shift();
      points.push(...chain);
    }
  }
  return {
    points,
    disconnected,
    closed: lines.length === 1 && Boolean(lines[0].closed),
  };
};

export function cleanBarGeometry(
  lines: RebarLine[],
  inchesPerModelUnit: number,
): CleanGeometry {
  const stitched = stitchLines(lines, inchesPerModelUnit);
  const cleanup: string[] = [];
  if (stitched.disconnected) cleanup.push("Disconnected source lines");
  const points: Vec3[] = [];
  stitched.points.forEach((point) => {
    if (!points.length || distance(points[points.length - 1], point) >= 0.05) {
      points.push(point);
    } else if (!cleanup.includes("Removed duplicate/short vertices")) {
      cleanup.push("Removed duplicate/short vertices");
    }
  });
  let changed = true;
  while (changed && points.length >= 3) {
    changed = false;
    for (let index = 1; index < points.length - 1; index += 1) {
      const incoming = normalize(subtract(points[index], points[index - 1]));
      const outgoing = normalize(subtract(points[index + 1], points[index]));
      const angle = degrees(Math.acos(Math.max(-1, Math.min(1, dot(incoming, outgoing)))));
      const chord = subtract(points[index + 1], points[index - 1]);
      const chordLength = magnitude(chord) || 1;
      const away = magnitude(cross(subtract(points[index], points[index - 1]), chord)) / chordLength;
      if (angle <= 3 && away <= 0.25) {
        points.splice(index, 1);
        cleanup.push("Merged nearly collinear segments");
        changed = true;
        break;
      }
    }
  }
  const closed = stitched.closed || (points.length > 3 && distance(points[0], points[points.length - 1]) <= 0.25);
  if (closed && distance(points[0], points[points.length - 1]) > 0.05) points.push(points[0]);
  const segments = points.slice(1).map((point, index) => subtract(point, points[index]));
  const segmentLengths = segments.map(magnitude);
  let planeNormal = { x: 0, y: 0, z: 1 };
  let strongestCross = 0;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const candidate = cross(segments[index], segments[index + 1]);
    if (magnitude(candidate) > strongestCross) {
      strongestCross = magnitude(candidate);
      planeNormal = normalize(candidate);
    }
  }
  const span = Math.max(...segmentLengths, 1);
  const planarTolerance = Math.max(0.25, span * 0.005);
  const planar = points.every(
    (point) => Math.abs(dot(subtract(point, points[0] ?? point), planeNormal)) <= planarTolerance,
  );
  const turns = segments.slice(1).map((segment, index) => {
    const previous = normalize(segments[index]);
    const current = normalize(segment);
    return degrees(Math.atan2(dot(planeNormal, cross(previous, current)), dot(previous, current)));
  });
  const developed = segmentLengths.reduce((sum, length) => sum + length, 0);
  const chord = points.length >= 2 ? distance(points[0], points[points.length - 1]) : 0;
  const straight =
    points.length <= 2 ||
    (chord > 0 &&
      developed / chord <= 1.005 &&
      points.every((point) => {
        const baseline = subtract(points[points.length - 1], points[0]);
        return magnitude(cross(subtract(point, points[0]), baseline)) / (magnitude(baseline) || 1) <= Math.max(0.25, developed * 0.005);
      }));
  if (straight && points.length > 2) cleanup.push("Interpreted nearly collinear segments as straight");
  return { points, segmentLengths, turns, closed, planar: planar && !stitched.disconnected, straight, cleanup: [...new Set(cleanup)], planeNormal };
}

type Candidate = {
  template: BendTemplate;
  labels: ScheduleLetter[];
  turns: number[];
  score: number;
  mirrored: boolean;
  reversed: boolean;
  omitted: string[];
};

const signedTurn = (angle: number) =>
  ((angle + 180) % 360 + 360) % 360 - 180;

const indexSelections = (
  total: number,
  count: number,
  start = 0,
  prefix: number[] = [],
): number[][] => {
  if (prefix.length === count) return [prefix];
  const remaining = count - prefix.length;
  const result: number[][] = [];
  for (let index = start; index <= total - remaining; index += 1) {
    result.push(...indexSelections(total, count, index + 1, [...prefix, index]));
  }
  return result;
};

/**
 * Produces orientation-independent versions of a standard shape. Up to two
 * zero-length/missing legs may be omitted anywhere in the standard. This
 * models the drafting convention of using the nearest standard bend even when
 * one or two nominal legs collapse, rather than maintaining one-off exceptions
 * for individual bars.
 */
const templateForms = (template: BendTemplate, observedSegmentCount: number) => {
  const omittedCount = template.labels.length - observedSegmentCount;
  if (omittedCount < 0 || omittedCount > 2 || observedSegmentCount < 2) {
    return [];
  }
  const directions = [0];
  template.turns.forEach((turn) =>
    directions.push(directions[directions.length - 1] + turn),
  );
  return indexSelections(template.labels.length, observedSegmentCount).flatMap(
    (indices) => {
      const retained = new Set(indices);
      const labels = indices.map((index) => template.labels[index]);
      const retainedDirections = indices.map((index) => directions[index]);
      const turns = retainedDirections
        .slice(1)
        .map((direction, index) =>
          signedTurn(direction - retainedDirections[index]),
        );
      const omitted = template.labels.filter((_, index) => !retained.has(index));
      const firstRetained = indices[0];
      const lastRetained = indices[indices.length - 1];
      const omissionPenalty = template.labels.reduce((penalty, label, index) => {
        if (retained.has(index)) return penalty;
        if (template.preferredOmissions?.includes(label)) return penalty + 0.5;
        const outsideRetainedSpan = index < firstRetained || index > lastRetained;
        return penalty + (outsideRetainedSpan ? 2.5 : 4.5);
      }, 0);
      return [false, true].flatMap((reversed) =>
        [false, true].map((mirrored) => {
          const orderedLabels = reversed ? [...labels].reverse() : labels;
          let orderedTurns = reversed
            ? [...turns].reverse().map((turn) => -turn)
            : turns;
          if (mirrored) orderedTurns = orderedTurns.map((turn) => -turn);
          return {
            labels: orderedLabels,
            turns: orderedTurns,
            reversed,
            mirrored,
            omitted,
            omissionPenalty,
          };
        }),
      );
    },
  );
};

export type BarClassification = {
  type: "" | `N${number}` | "NONSTD";
  confidence: "Straight" | "Confirmed" | "Likely" | "Ambiguous" | "Nonstandard";
  score: number;
  mirrored: boolean;
  reversed: boolean;
  legDimensionsInches: Partial<Record<ScheduleLetter, number>>;
  cleanup: string[];
  notes: string[];
  cleanedVertexCount: number;
};

export function classifyNhdotBar(
  lines: RebarLine[],
  inchesPerModelUnit: number,
  barNumber: string,
): BarClassification {
  const geometry = cleanBarGeometry(lines, inchesPerModelUnit);
  if (geometry.straight) {
    return { type: "", confidence: "Straight", score: 0, mirrored: false, reversed: false, legDimensionsInches: {}, cleanup: geometry.cleanup, notes: [], cleanedVertexCount: geometry.points.length };
  }
  if (!geometry.planar || geometry.segmentLengths.length < 2) {
    return { type: "NONSTD", confidence: "Nonstandard", score: 999, mirrored: false, reversed: false, legDimensionsInches: {}, cleanup: geometry.cleanup, notes: [geometry.planar ? "Insufficient connected geometry" : "Bar is not planar within tolerance"], cleanedVertexCount: geometry.points.length };
  }
  const candidates: Candidate[] = [];
  for (const template of NHDOT_TEMPLATES) {
    for (const form of templateForms(template, geometry.segmentLengths.length)) {
      if (form.labels.length !== geometry.segmentLengths.length || form.turns.length !== geometry.turns.length) continue;
      const anglePenalty = form.turns.reduce((sum, turn, index) => sum + angleDifference(turn, geometry.turns[index]) / 5, 0);
      candidates.push({ template, ...form, score: anglePenalty + form.omissionPenalty });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  const secondDifferent = candidates.find((candidate) => candidate.template.type !== best?.template.type);
  if (!best || best.score > 12) {
    return { type: "NONSTD", confidence: "Nonstandard", score: best?.score ?? 999, mirrored: false, reversed: false, legDimensionsInches: {}, cleanup: geometry.cleanup, notes: [best ? `Closest standard was ${best.template.type}, outside tolerance` : "No standard has the same leg count"], cleanedVertexCount: geometry.points.length };
  }
  if (secondDifferent && secondDifferent.score - best.score < 1.5) {
    return { type: "NONSTD", confidence: "Ambiguous", score: best.score, mirrored: best.mirrored, reversed: best.reversed, legDimensionsInches: {}, cleanup: geometry.cleanup, notes: [`Ambiguous between ${best.template.type} and ${secondDifferent.template.type}`], cleanedVertexCount: geometry.points.length };
  }
  const legDimensionsInches: Partial<Record<ScheduleLetter, number>> = {};
  best.labels.forEach((label, index) => {
    legDimensionsInches[label] = geometry.segmentLengths[index];
  });
  const longestIndex = geometry.segmentLengths.indexOf(Math.max(...geometry.segmentLengths));
  const horizontal = normalize(subtract(geometry.points[longestIndex + 1], geometry.points[longestIndex]));
  const vertical = normalize(cross(geometry.planeNormal, horizontal));
  const projections = geometry.points.map((point) => {
    const relative = subtract(point, geometry.points[0]);
    return { x: dot(relative, horizontal), y: dot(relative, vertical) };
  });
  const width = Math.max(...projections.map(({ x }) => x)) - Math.min(...projections.map(({ x }) => x));
  const height = Math.max(...projections.map(({ y }) => y)) - Math.min(...projections.map(({ y }) => y));
  if (best.template.derived?.includes("H") && legDimensionsInches.H === undefined) legDimensionsInches.H = height;
  if (best.template.derived?.includes("K") && legDimensionsInches.K === undefined) {
    const diagonalProjection = geometry.segmentLengths.reduce((maximum, length, index) => {
      const direction = normalize(subtract(geometry.points[index + 1], geometry.points[index]));
      const projection = Math.abs(dot(direction, horizontal)) * length;
      return Math.abs(dot(direction, vertical)) > 0.1 ? Math.max(maximum, projection) : maximum;
    }, 0);
    legDimensionsInches.K = diagonalProjection || width;
  }
  if (best.template.derived?.includes("R")) {
    legDimensionsInches.R = rebarBendStandard(barNumber).minimumCenterlineRadiusInches;
  }
  return {
    type: best.template.type,
    confidence: best.score <= 4 && best.omitted.length === 0 ? "Confirmed" : "Likely",
    score: best.score,
    mirrored: best.mirrored,
    reversed: best.reversed,
    legDimensionsInches,
    cleanup: geometry.cleanup,
    notes: best.omitted.length ? [`Nearest standard with ${best.omitted.join(" and ")} leg${best.omitted.length === 1 ? "" : "s"} omitted`] : [],
    cleanedVertexCount: geometry.points.length,
  };
}

export type ScheduleRunInput = {
  run: RebarRun;
  sharpInstances: RebarLine[][];
  bentInstances: RebarLine[][];
};

export type RebarScheduleRow = {
  mark: string;
  sourceRun: string;
  barNumber: string;
  lengthFeet: number;
  quantity: number;
  type: BarClassification["type"];
  confidence: BarClassification["confidence"];
  score: number;
  mirrored: boolean;
  reversed: boolean;
  legFeet: Partial<Record<ScheduleLetter, number>>;
  cleanup: string[];
  notes: string[];
  coating: string;
  tags: string[];
  cleanedVertexCount: number;
};

export function createRebarScheduleRows(
  inputs: ScheduleRunInput[],
  inchesPerModelUnit: number,
) {
  const rows: RebarScheduleRow[] = [];
  for (const { run, sharpInstances, bentInstances } of inputs) {
    const groups = new Map<string, RebarScheduleRow>();
    sharpInstances.forEach((instance, index) => {
      const classification = classifyNhdotBar(instance, inchesPerModelUnit, run.barNumber ?? "5");
      const lengthInches = Math.round(
        rebarInstanceLength(bentInstances[index] ?? instance) * inchesPerModelUnit,
      );
      const roundedLegs = Object.fromEntries(
        Object.entries(classification.legDimensionsInches).map(([letter, value]) => [letter, Math.round(value)]),
      ) as Partial<Record<ScheduleLetter, number>>;
      const key = JSON.stringify({ type: classification.type, confidence: classification.confidence, lengthInches, roundedLegs });
      const existing = groups.get(key);
      if (existing) {
        existing.quantity += 1;
        return;
      }
      groups.set(key, {
        mark: run.name,
        sourceRun: run.name,
        barNumber: String(run.barNumber ?? "5").replace(/^#/, ""),
        lengthFeet: lengthInches / 12,
        quantity: 1,
        type: classification.type,
        confidence: classification.confidence,
        score: classification.score,
        mirrored: classification.mirrored,
        reversed: classification.reversed,
        legFeet: Object.fromEntries(Object.entries(roundedLegs).map(([letter, value]) => [letter, value / 12])),
        cleanup: classification.cleanup,
        notes: classification.notes,
        coating: /E$/i.test(run.suffix ?? "") || /epoxy/i.test(run.name) ? "Epoxy" : "",
        tags: [run.advanced?.variableLength ? "Varying" : "", run.advanced?.splay ? "Splayed" : "", run.lappedFromRunId ? "Lapped" : ""].filter(Boolean),
        cleanedVertexCount: classification.cleanedVertexCount,
      });
    });
    rows.push(...groups.values());
  }
  return rows;
}

const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const stringCell = (value: string, style = "Body") => `<Cell ss:StyleID="${style}"><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
const numberCell = (value: number, style = "Number") => `<Cell ss:StyleID="${style}"><Data ss:Type="Number">${Number.isFinite(value) ? value : 0}</Data></Cell>`;
const formulaCell = (formula: string, cached: number, style = "Formula") => `<Cell ss:StyleID="${style}" ss:Formula="${escapeXml(formula)}"><Data ss:Type="Number">${cached}</Data></Cell>`;
const rowXml = (cells: string[], style = "") => `<Row${style ? ` ss:StyleID="${style}"` : ""}>${cells.join("")}</Row>`;
const headerRow = (labels: string[]) => rowXml(labels.map((label) => stringCell(label, "Header")));

const worksheetOptions = `<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><PageSetup><Layout x:Orientation="Landscape"/><PageMargins x:Bottom="0.5" x:Left="0.35" x:Right="0.35" x:Top="0.5"/></PageSetup><FreezePanes/><FrozenNoSplit/><SplitHorizontal>3</SplitHorizontal><TopRowBottomPane>3</TopRowBottomPane><ProtectObjects>False</ProtectObjects><ProtectScenarios>False</ProtectScenarios></WorksheetOptions>`;

export function buildRebarScheduleWorkbookXml(
  rows: RebarScheduleRow[],
  projectName: string,
) {
  const title = projectName.replace(/\.[^.]+$/, "") || "Reinforcing Steel";
  const scheduleHeaders = ["Mark", "Size", "Length (ft)", "# Pieces", "Type", ...LETTERS, "Coating", "Item #"];
  const scheduleRows = rows.map((row) =>
    rowXml([
      stringCell(row.mark),
      stringCell(`#${row.barNumber}`, "Center"),
      numberCell(row.lengthFeet, "TwoDecimal"),
      numberCell(row.quantity, "Integer"),
      stringCell(row.type, "Center"),
      ...LETTERS.map((letter) => row.legFeet[letter] === undefined ? stringCell("") : numberCell(row.legFeet[letter]!, "OneDecimal")),
      stringCell(row.coating, "Center"),
      stringCell(""),
    ]),
  ).join("");

  const quantityHeaders = ["Mark", "Size", "Length From Above (ft)", "# Pieces", "Total Length (ft)", "Unit Wt. (lb/ft)", "Total Weight (lb)", "Classification"];
  const quantityRows = rows.map((row, index) => {
    const excelRow = index + 4;
    const totalLength = row.lengthFeet * row.quantity;
    const unitWeight = NHDOT_UNIT_WEIGHTS_LB_PER_FT[row.barNumber] ?? 0;
    const totalWeight = totalLength * unitWeight;
    return rowXml([
      stringCell(row.mark),
      stringCell(`#${row.barNumber}`, "Center"),
      formulaCell(`='Bar Schedule'!R${excelRow}C3`, row.lengthFeet, "TwoDecimal"),
      formulaCell(`='Bar Schedule'!R${excelRow}C4`, row.quantity, "IntegerFormula"),
      formulaCell("=RC[-2]*RC[-1]", totalLength, "TwoDecimalFormula"),
      formulaCell("=IFERROR(VLOOKUP(RC[-4],Reference!R3C1:R13C2,2,FALSE),0)", unitWeight, "ThreeDecimalFormula"),
      formulaCell("=RC[-2]*RC[-1]", totalWeight, "TwoDecimalFormula"),
      stringCell(row.confidence, "Center"),
    ]);
  }).join("");
  const quantityTotalRow = rows.length + 4;
  const quantityTotals = rowXml([
    stringCell("TOTAL", "Total"), stringCell("", "Total"), stringCell("", "Total"), stringCell("", "Total"),
    formulaCell(`=SUM(R4C5:R${quantityTotalRow - 1}C5)`, rows.reduce((sum, row) => sum + row.lengthFeet * row.quantity, 0), "TotalNumber"),
    stringCell("", "Total"),
    formulaCell(`=SUM(R4C7:R${quantityTotalRow - 1}C7)`, rows.reduce((sum, row) => {
      const totalLength = row.lengthFeet * row.quantity;
      return sum + totalLength * (NHDOT_UNIT_WEIGHTS_LB_PER_FT[row.barNumber] ?? 0);
    }, 0), "TotalNumber"),
    stringCell("", "Total"),
  ]);

  const reviewHeaders = ["Source Run", "Mark", "Suggested Type", "Confidence", "Score", "Mirrored", "Reversed", "Clean Vertices", "Cleanup Performed", "Matcher Notes", "Run Tags"];
  const reviewRows = rows.map((row) => rowXml([
    stringCell(row.sourceRun), stringCell(row.mark), stringCell(row.type), stringCell(row.confidence), numberCell(row.score, "OneDecimal"),
    stringCell(row.mirrored ? "Yes" : "No", "Center"), stringCell(row.reversed ? "Yes" : "No", "Center"), numberCell(row.cleanedVertexCount, "Integer"),
    stringCell(row.cleanup.join("; "), "Wrap"), stringCell(row.notes.join("; "), "Wrap"), stringCell(row.tags.join(", "), "Wrap"),
  ])).join("");

  const weights = Object.entries(NHDOT_UNIT_WEIGHTS_LB_PER_FT);
  const referenceRows = weights.map(([barNumber, weight]) => rowXml([stringCell(`#${barNumber}`, "Center"), numberCell(weight, "ThreeDecimal")])).join("");
  const summaryRows = weights.map(([barNumber, weight]) => {
    const total = rows.reduce((sum, row) => row.barNumber === barNumber ? sum + row.lengthFeet * row.quantity * weight : sum, 0);
    return rowXml([
      stringCell(`#${barNumber}`, "Center"),
      numberCell(weight, "ThreeDecimal"),
      formulaCell(`=SUMIF(Quantities!R4C2:R${quantityTotalRow - 1}C2,RC[-2],Quantities!R4C7:R${quantityTotalRow - 1}C7)`, total, "TwoDecimalFormula"),
      formulaCell(`=SUMIF(Quantities!R4C2:R${quantityTotalRow - 1}C2,RC[-3],Quantities!R4C5:R${quantityTotalRow - 1}C5)`, rows.reduce((sum, row) => row.barNumber === barNumber ? sum + row.lengthFeet * row.quantity : sum, 0), "TwoDecimalFormula"),
    ]);
  }).join("");

  const columns = (widths: number[]) => widths.map((width) => `<Column ss:Width="${width}"/>`).join("");
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel">
<DocumentProperties xmlns="urn:schemas-microsoft-com:office:office"><Title>${escapeXml(title)} Reinforcing Bar Schedule</Title><Author>MCT Section Lab</Author></DocumentProperties>
<Styles>
<Style ss:ID="Default"><Alignment ss:Vertical="Center"/><Font ss:FontName="Arial" ss:Size="9"/></Style>
<Style ss:ID="Title"><Alignment ss:Horizontal="Left" ss:Vertical="Center"/><Font ss:FontName="Arial" ss:Size="14" ss:Bold="1"/><Interior ss:Color="#FFFFFF" ss:Pattern="Solid"/></Style>
<Style ss:ID="Header"><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2"/></Borders><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#111111" ss:Pattern="Solid"/></Style>
<Style ss:ID="Body"><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#808080"/></Borders></Style>
<Style ss:ID="Center" ss:Parent="Body"><Alignment ss:Horizontal="Center"/></Style>
<Style ss:ID="Wrap" ss:Parent="Body"><Alignment ss:WrapText="1" ss:Vertical="Top"/></Style>
<Style ss:ID="Number" ss:Parent="Body"><NumberFormat ss:Format="0.00"/></Style>
<Style ss:ID="OneDecimal" ss:Parent="Body"><NumberFormat ss:Format="0.0"/></Style>
<Style ss:ID="TwoDecimal" ss:Parent="Body"><NumberFormat ss:Format="0.00"/></Style>
<Style ss:ID="ThreeDecimal" ss:Parent="Body"><NumberFormat ss:Format="0.000"/></Style>
<Style ss:ID="Integer" ss:Parent="Body"><NumberFormat ss:Format="0"/></Style>
<Style ss:ID="Formula" ss:Parent="Body"><Interior ss:Color="#FFF8D8" ss:Pattern="Solid"/><NumberFormat ss:Format="0.00"/></Style>
<Style ss:ID="OneDecimalFormula" ss:Parent="Formula"><NumberFormat ss:Format="0.0"/></Style>
<Style ss:ID="ThreeDecimalFormula" ss:Parent="Formula"><NumberFormat ss:Format="0.000"/></Style>
<Style ss:ID="IntegerFormula" ss:Parent="Formula"><NumberFormat ss:Format="0"/></Style>
<Style ss:ID="Total"><Borders><Border ss:Position="Top" ss:LineStyle="Double" ss:Weight="3"/></Borders><Font ss:Bold="1"/></Style>
<Style ss:ID="TotalNumber" ss:Parent="Total"><Interior ss:Color="#FFF8D8" ss:Pattern="Solid"/><NumberFormat ss:Format="0.00"/></Style>
</Styles>
<Worksheet ss:Name="Bar Schedule"><Table>${columns([80,45,65,55,50,...LETTERS.map(() => 42),65,65])}${rowXml([stringCell(`${title} - Bar Summary`, "Title")])}${rowXml([stringCell("NHDOT standard bend dimensions; blank Type indicates a straight bar.", "Wrap")])}${headerRow(scheduleHeaders)}${scheduleRows}</Table>${worksheetOptions}</Worksheet>
<Worksheet ss:Name="Quantities"><Table>${columns([90,48,90,60,85,80,90,80])}${rowXml([stringCell(`${title} - Reinforcing Steel Quantities`, "Title")])}${rowXml([stringCell("Yellow cells contain auditable Excel formulas.", "Wrap")])}${headerRow(quantityHeaders)}${quantityRows}${quantityTotals}</Table>${worksheetOptions}</Worksheet>
<Worksheet ss:Name="Classification Review"><Table>${columns([95,85,70,75,55,55,55,70,185,185,90])}${rowXml([stringCell(`${title} - Automatic Bend Classification Review`, "Title")])}${rowXml([stringCell("Ambiguous and Nonstandard rows are intentionally not forced into an NHDOT bend.", "Wrap")])}${headerRow(reviewHeaders)}${reviewRows}</Table>${worksheetOptions}</Worksheet>
<Worksheet ss:Name="Reference"><Table>${columns([60,90,105,105])}${rowXml([stringCell("NHDOT Reinforcing Reference", "Title")])}${headerRow(["Bar #", "Unit Wt. lb/ft"])}${referenceRows}${rowXml([stringCell("Source"), stringCell(NHDOT_REBAR_SOURCE, "Wrap")])}${rowXml([stringCell("Bar #", "Header"), stringCell("Unit Wt. lb/ft", "Header"), stringCell("Total Weight (lb)", "Header"), stringCell("Total Length (ft)", "Header")])}${summaryRows}</Table>${worksheetOptions}</Worksheet>
</Workbook>`;
}
