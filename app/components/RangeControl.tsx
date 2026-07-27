"use client";

type Props = {
  axis: "X" | "Y" | "Z";
  bounds: [number, number];
  value: [number, number];
  onChange: (value: [number, number]) => void;
};

export default function RangeControl({
  axis,
  bounds,
  value,
  onChange,
}: Props) {
  const span = bounds[1] - bounds[0] || 1;
  const left = ((value[0] - bounds[0]) / span) * 100;
  const right = ((value[1] - bounds[0]) / span) * 100;
  const toCoordinate = (percent: number) =>
    bounds[0] + (span * percent) / 100;

  return (
    <div className="range-control">
      <div className="range-heading">
        <span>
          <b>{axis}</b> slice
        </span>
        <span className="range-readout">
          {Math.round(left)}/100 — {Math.round(right)}/100
        </span>
      </div>
      <div
        className="range-track"
        style={
          {
            "--range-left": `${left}%`,
            "--range-right": `${right}%`,
          } as React.CSSProperties
        }
      >
        <input
          aria-label={`${axis} slice minimum`}
          type="range"
          min={0}
          max={100}
          step={1}
          value={left}
          onChange={(event) =>
            onChange([
              Math.min(toCoordinate(Number(event.target.value)), value[1]),
              value[1],
            ])
          }
        />
        <input
          aria-label={`${axis} slice maximum`}
          type="range"
          min={0}
          max={100}
          step={1}
          value={right}
          onChange={(event) =>
            onChange([
              value[0],
              Math.max(toCoordinate(Number(event.target.value)), value[0]),
            ])
          }
        />
      </div>
    </div>
  );
}
