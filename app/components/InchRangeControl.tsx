"use client";

type Props = {
  axis: "X" | "Y" | "Z";
  bounds: [number, number];
  value: [number, number];
  inchesPerUnit: number;
  compact?: boolean;
  onChange: (value: [number, number]) => void;
};

export default function InchRangeControl({
  axis,
  bounds,
  value,
  inchesPerUnit,
  compact = false,
  onChange,
}: Props) {
  const span = bounds[1] - bounds[0] || 1;
  const maxInches = span * inchesPerUnit;
  const toInches = (coordinate: number) =>
    (coordinate - bounds[0]) * inchesPerUnit;
  const toCoordinate = (inches: number) =>
    bounds[0] + inches / inchesPerUnit;
  const low = toInches(value[0]);
  const high = toInches(value[1]);
  const apply = (nextLow: number, nextHigh: number) =>
    onChange([
      toCoordinate(Math.max(0, Math.min(nextLow, nextHigh, maxInches))),
      toCoordinate(Math.min(maxInches, Math.max(nextHigh, nextLow, 0))),
    ]);

  return (
    <div className="range-control inch-range">
      <div className="range-heading">
        <span><b>{axis}</b> slice</span>
        <span className="range-readout">0–{maxInches.toFixed(1)} in</span>
      </div>
      {!compact && <div className="manual-range-values">
        <label>
          Min
          <input
            type="number"
            min={0}
            max={maxInches}
            step={0.25}
            value={Number(low.toFixed(3))}
            onChange={(event) => apply(Number(event.target.value), high)}
          />
        </label>
        <label>
          Max
          <input
            type="number"
            min={0}
            max={maxInches}
            step={0.25}
            value={Number(high.toFixed(3))}
            onChange={(event) => apply(low, Number(event.target.value))}
          />
        </label>
      </div>}
      <div
        className="range-track"
        style={{
          "--range-left": `${(low / Math.max(maxInches, 1)) * 100}%`,
          "--range-right": `${(high / Math.max(maxInches, 1)) * 100}%`,
        } as React.CSSProperties}
      >
        <input
          aria-label={`${axis} minimum inches`}
          type="range"
          min={0}
          max={maxInches}
          step={Math.max(maxInches / 500, 0.01)}
          value={low}
          onChange={(event) => apply(Number(event.target.value), high)}
        />
        <input
          aria-label={`${axis} maximum inches`}
          type="range"
          min={0}
          max={maxInches}
          step={Math.max(maxInches / 500, 0.01)}
          value={high}
          onChange={(event) => apply(low, Number(event.target.value))}
        />
      </div>
    </div>
  );
}
