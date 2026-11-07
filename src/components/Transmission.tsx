import { metaFor, POLARITY_META, type Polarity } from "@/lib/polarity";

const SLOTS = [POLARITY_META["1"], POLARITY_META["0"], POLARITY_META["-1"]] as const;

/** Knob horizontal position (percent of the track) per state: R (-1) left, N middle, D (+1) right. */
const KNOB_LEFT: Record<"1" | "0" | "-1", string> = {
  "1": "left-[88%]",
  "0": "left-[50%]",
  "-1": "left-[12%]",
};

const SPIN: Record<"1" | "0" | "-1", string> = {
  "1": "gear-spin-cw",
  "0": "",
  "-1": "gear-spin-ccw",
};

function Gear({
  teeth,
  radius,
  className,
  color,
}: {
  teeth: number;
  radius: number;
  className?: string;
  color: string;
}) {
  const toothW = (2 * Math.PI * radius) / (teeth * 2.2);
  const toothH = radius * 0.18;
  return (
    <g className={className}>
      {Array.from({ length: teeth }, (_, i) => (
        <rect
          key={i}
          x={-toothW / 2}
          y={-radius - toothH}
          width={toothW}
          height={toothH + 2}
          rx={1.5}
          fill={color}
          transform={`rotate(${(360 / teeth) * i})`}
        />
      ))}
      <circle r={radius} fill={color} />
      <circle r={radius * 0.72} fill="#09090b" />
      {Array.from({ length: 4 }, (_, i) => (
        <rect
          key={i}
          x={-3}
          y={-radius * 0.72}
          width={6}
          height={radius * 0.72}
          fill={color}
          transform={`rotate(${90 * i})`}
        />
      ))}
      <circle r={radius * 0.22} fill={color} />
    </g>
  );
}

export default function Transmission({ polarity }: { polarity: Polarity }) {
  const meta = metaFor(polarity);
  const key = String(polarity) as "1" | "0" | "-1";

  return (
    <section
      aria-label="Polarity transmission"
      className="flex flex-col items-center gap-8"
    >
      {/* Mechanical assembly: gear on top of the horizontal gated shifter */}
      <div className="flex flex-col items-center gap-6 sm:gap-10">
        <svg
          viewBox="-100 -100 200 200"
          className="h-36 w-36 sm:h-52 sm:w-52"
          role="img"
          aria-label={`Gear train ${polarity === 0 ? "stationary" : polarity === 1 ? "turning forward" : "turning backward"}`}
        >
          <Gear
            teeth={14}
            radius={54}
            color={meta.hex}
            className={SPIN[key]}
          />
        </svg>

        {/* Shifter gate */}
        <div
          className={`relative h-28 w-64 rounded-3xl border-2 bg-zinc-900 transition-shadow duration-500 sm:h-32 sm:w-80 ${meta.border} ${meta.glow}`}
        >
          {/* Slot rail */}
          <div className="absolute inset-x-6 top-1/2 h-5 -translate-y-1/2 rounded-full bg-zinc-950 shadow-inner ring-1 ring-zinc-700" />

          {/* Detent labels */}
          {SLOTS.map((slot, idx) => {
            const active = slot.value === polarity;
            return (
              <div
                key={slot.gear}
                className={`absolute top-2 flex -translate-x-1/2 flex-col items-center text-xs font-bold tracking-widest transition-opacity ${
                  idx === 0 ? "left-[88%]" : idx === 1 ? "left-[50%]" : "left-[12%]"
                } ${active ? slot.text : "text-zinc-600"}`}
              >
                <span className="text-lg leading-none">{slot.gear}</span>
              </div>
            );
          })}
          {SLOTS.map((slot, idx) => {
            const active = slot.value === polarity;
            return (
              <div
                key={slot.display}
                className={`absolute bottom-2 -translate-x-1/2 font-mono text-xs font-bold transition-opacity ${
                  idx === 0 ? "left-[88%]" : idx === 1 ? "left-[50%]" : "left-[12%]"
                } ${active ? slot.text : "text-zinc-600"}`}
              >
                {slot.display}
              </div>
            );
          })}

          {/* Knob */}
          <div
            className={`absolute top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-zinc-950 transition-all duration-500 ease-out ${KNOB_LEFT[key]} ${meta.bg} ${meta.glow}`}
          >
            <div className="absolute inset-2 rounded-full bg-white/25" />
          </div>
        </div>
      </div>

      {/* State readout */}
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col items-center gap-1"
      >
        <span
          className={`font-mono text-6xl font-bold tabular-nums transition-colors sm:text-7xl ${meta.text}`}
        >
          {meta.display}
        </span>
        <span
          className={`text-lg font-semibold uppercase tracking-[0.35em] transition-colors ${meta.text}`}
        >
          {meta.label}
        </span>
        <span className="text-sm text-slate-400">Latest session&apos;s volume-weighted candle direction</span>
      </div>
    </section>
  );
}
