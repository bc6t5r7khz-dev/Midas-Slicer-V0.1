"use client";

type Props = {
  axis: "X" | "Y";
  bounds: [number, number];
  value: [number, number];
  onChange: (value: [number, number]) => void;
};

const format = (value: number) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    useGrouping: false,
  }).format(value);

export default function RangeControl({
  axis,
  bounds,
  value,
  onChange,
}: Props) {
  const span = bounds[1] - bounds[0] || 1;
  const step = Math.max(span / 500, 0.000001);
  const left = ((value[0] - bounds[0]) / span) * 100;
  const right = ((value[1] - bounds[0]) / span) * 100;

  return (
    <div className="range-control">
      <div className="range-heading">
        <span>
          <b>{axis}</b> slice
        </span>
        <span className="range-readout">
          {format(value[0])} — {format(value[1])}
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
          min={bounds[0]}
          max={bounds[1]}
          step={step}
          value={value[0]}
          onChange={(event) =>
            onChange([Math.min(Number(event.target.value), value[1]), value[1]])
          }
        />
        <input
          aria-label={`${axis} slice maximum`}
          type="range"
          min={bounds[0]}
          max={bounds[1]}
          step={step}
          value={value[1]}
          onChange={(event) =>
            onChange([value[0], Math.max(Number(event.target.value), value[0])])
          }
        />
      </div>
    </div>
  );
}
