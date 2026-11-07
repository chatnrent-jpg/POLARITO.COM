"use client";

import { useMemo, useState } from "react";
import {
  coerceTimeframe,
  DEFAULT_TIMEFRAME,
  metaFor,
  TIMEFRAMES,
  windowFor,
  type DayResult,
  type Timeframe,
} from "@/lib/polarity";
import {
  hasLiveSentiment,
  sentimentPolarityFor,
  type SentimentByDate,
} from "@/lib/sentimentEngine";

const W = 640;
const H = 260;
const PAD_X = 12;
const PAD_Y = 14;
const FLOOR_STROKE = "#cbd5e1"; // slate-300: crisp against the dark card
const SENTIMENT_STROKE = "#c026ff"; // neon purple: neutral / unavailable news days
const SENTIMENT_GOOD = "#22c55e"; // green: good-news day (+1 Euphoria)
const SENTIMENT_BAD = "#ef4444"; // red: bad-news day (-1 Fear)

const sentimentColor = (polarity: number) =>
  polarity > 0 ? SENTIMENT_GOOD : polarity < 0 ? SENTIMENT_BAD : SENTIMENT_STROKE;

function signedCompact(n: number): string {
  if (n === 0) return "0";
  return `${n > 0 ? "+" : "−"}${compact(Math.abs(n))}`;
}

function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

/**
 * Net Volume chart: one bar per trading day, coloured by that day's polarity,
 * with the ±Noise Floor drawn as a band. Bars outside the band are Drive/Reverse.
 *
 * Hard boundary: this component owns its view selector and renders ONLY the
 * frozen TIMEFRAMES array (1D, 1W, 1M, 3M, 1Y). It accepts no prop that could
 * widen the list, and every timeframe value (including `initialTimeframe`)
 * passes through `coerceTimeframe`.
 */
export default function PolarityChart({
  results,
  sentiment,
  initialTimeframe = DEFAULT_TIMEFRAME,
}: {
  results: readonly DayResult[];
  /** Live news sentiment, by date. Missing or unavailable days plot as 0 (Neutral). */
  sentiment?: SentimentByDate;
  initialTimeframe?: Timeframe;
}) {
  const [timeframe, setTimeframe] = useState<Timeframe>(() =>
    coerceTimeframe(initialTimeframe),
  );

  const view = useMemo(() => windowFor(results, timeframe), [results, timeframe]);
  const liveSentiment = useMemo(() => hasLiveSentiment(sentiment), [sentiment]);

  const geometry = useMemo(() => {
    const n = view.length;
    let max = 1;
    for (const d of view) {
      max = Math.max(max, Math.abs(d.netVolume), d.noiseFloor ?? 0);
    }
    max *= 1.1;
    const innerW = W - PAD_X * 2;
    const innerH = H - PAD_Y * 2;
    const yOf = (v: number) => PAD_Y + ((max - v) / (2 * max)) * innerH;
    const slot = innerW / Math.max(n, 1);
    const barW = Math.min(Math.max(slot * 0.7, 1), 48);
    const zeroY = yOf(0);

    const bars = view.map((d, i) => {
      const cx = PAD_X + slot * (i + 0.5);
      const y = yOf(d.netVolume);
      return {
        key: d.date,
        x: cx - barW / 2,
        w: barW,
        y: Math.min(y, zeroY),
        h: Math.max(Math.abs(y - zeroY), 1),
        fill: metaFor(d.polarity).hex,
      };
    });

    const floorPts = view
      .map((d, i) => ({ d, x: PAD_X + slot * (i + 0.5) }))
      .filter(({ d }) => d.noiseFloor !== null);
    const upper = floorPts
      .map(({ d, x }) => `${x.toFixed(1)},${yOf(d.noiseFloor!).toFixed(1)}`)
      .join(" ");
    const lower = floorPts
      .map(({ d, x }) => `${x.toFixed(1)},${yOf(-d.noiseFloor!).toFixed(1)}`)
      .join(" ");

    // Crowd sentiment overlay: a stepped line, one flat run per day. Its own
    // -1..+1 scale (80% of the half-height) sits over the volume bars.
    const sentCenter = H / 2;
    const sentAmp = (innerH / 2) * 0.8;
    const sentPts: string[] = [];
    // One segment per day so each can take its own color (green good / red bad / purple neutral).
    const sentSegments: { key: string; points: string; color: string }[] = [];
    let prevY: string | null = null;
    view.forEach((d, i) => {
      const polarity = sentimentPolarityFor(sentiment, d.date);
      const y = (sentCenter - polarity * sentAmp).toFixed(1);
      const x0 = (PAD_X + slot * i).toFixed(1);
      const x1 = (PAD_X + slot * (i + 1)).toFixed(1);
      sentPts.push(`${x0},${y}`, `${x1},${y}`);
      sentSegments.push({
        key: d.date,
        points: prevY === null ? `${x0},${y} ${x1},${y}` : `${x0},${prevY} ${x0},${y} ${x1},${y}`,
        color: sentimentColor(polarity),
      });
      prevY = y;
    });

    return {
      bars,
      upper,
      lower,
      zeroY,
      max,
      yOf,
      sentLine: sentPts.join(" "),
      sentSegments,
      sentYs: { up: sentCenter - sentAmp, mid: sentCenter, down: sentCenter + sentAmp },
    };
  }, [view, sentiment]);

  const last = view[view.length - 1];
  const lastMeta = last ? metaFor(last.polarity) : metaFor(0);

  function select(next: string) {
    // Reject anything outside the five allowed views.
    setTimeframe(coerceTimeframe(next));
  }

  return (
    <section
      aria-label="Net volume history"
      className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6"
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-lg font-bold uppercase tracking-wider text-white">
          Net Volume · {timeframe}
        </h2>

        <div
          role="tablist"
          aria-label="Time range"
          className="inline-flex rounded-lg bg-zinc-950 p-1 ring-1 ring-zinc-700"
        >
          {TIMEFRAMES.map((tf) => {
            const active = tf === timeframe;
            return (
              <button
                key={tf}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => select(tf)}
                className={`rounded-md px-3.5 py-2 font-mono text-base font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 ${
                  active
                    ? "bg-white text-zinc-900"
                    : "text-slate-300 hover:text-white"
                }`}
              >
                {tf}
              </button>
            );
          })}
        </div>
      </div>

      {/* Headline metric: the latest day's Net Volume */}
      {last && (
        <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-5xl font-black tabular-nums tracking-tight text-white sm:text-6xl">
            {signedCompact(last.netVolume)}
          </span>
          <span className="text-lg font-semibold text-slate-200">
            Net Volume · {last.date} ·{" "}
            <span className={`font-bold ${lastMeta.text}`}>{lastMeta.label}</span>
          </span>
        </div>
      )}

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Net volume for ${timeframe}, latest state ${lastMeta.label}`}
      >
        {/* Noise floor band */}
        {geometry.upper && view.length > 1 && (
          <>
            <polyline points={geometry.upper} fill="none" stroke={FLOOR_STROKE} strokeWidth={2} strokeDasharray="7 5" />
            <polyline points={geometry.lower} fill="none" stroke={FLOOR_STROKE} strokeWidth={2} strokeDasharray="7 5" />
          </>
        )}
        {view.length === 1 && last?.noiseFloor != null && (
          <>
            <rect
              x={PAD_X}
              width={W - PAD_X * 2}
              y={geometry.yOf(last.noiseFloor)}
              height={geometry.yOf(-last.noiseFloor) - geometry.yOf(last.noiseFloor)}
              fill="#94a3b8"
              opacity={0.18}
            />
            <line x1={PAD_X} x2={W - PAD_X} y1={geometry.yOf(last.noiseFloor)} y2={geometry.yOf(last.noiseFloor)} stroke={FLOOR_STROKE} strokeWidth={2} strokeDasharray="7 5" />
            <line x1={PAD_X} x2={W - PAD_X} y1={geometry.yOf(-last.noiseFloor)} y2={geometry.yOf(-last.noiseFloor)} stroke={FLOOR_STROKE} strokeWidth={2} strokeDasharray="7 5" />
          </>
        )}

        {/* Zero line */}
        <line x1={PAD_X} x2={W - PAD_X} y1={geometry.zeroY} y2={geometry.zeroY} stroke="#64748b" strokeWidth={1.5} />

        {/* Net volume bars */}
        {geometry.bars.map((b) => (
          <rect key={b.key} x={b.x} y={b.y} width={b.w} height={b.h} fill={b.fill} />
        ))}

        {/* Crowd sentiment overlay (live news keywords): a dark underlay for contrast, then one
            colored segment per day: green = good-news day, red = bad-news day, purple = neutral. */}
        {view.length > 0 && (
          <>
            <polyline
              points={geometry.sentLine}
              fill="none"
              stroke="#09090b"
              strokeWidth={7}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {geometry.sentSegments.map((seg) => (
              <polyline
                key={seg.key}
                points={seg.points}
                fill="none"
                stroke={seg.color}
                strokeWidth={3.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          </>
        )}
        {([["+1", geometry.sentYs.up, SENTIMENT_GOOD], ["0", geometry.sentYs.mid, SENTIMENT_STROKE], ["−1", geometry.sentYs.down, SENTIMENT_BAD]] as const).map(
          ([label, y, color]) => (
            <text
              key={label}
              x={PAD_X + 2}
              y={y - 4}
              fontSize="18"
              fontWeight="800"
              fill={color}
              stroke="#09090b"
              strokeWidth={5}
              paintOrder="stroke"
              strokeLinejoin="round"
            >
              {label}
            </text>
          ),
        )}

        {/* Scale labels: large, bold, haloed so they stay readable over bars */}
        <text
          x={W - PAD_X}
          y={PAD_Y + 14}
          textAnchor="end"
          fontSize="20"
          fontWeight="800"
          fill="#f1f5f9"
          stroke="#09090b"
          strokeWidth={5}
          paintOrder="stroke"
          strokeLinejoin="round"
        >
          +{compact(geometry.max)}
        </text>
        <text
          x={W - PAD_X}
          y={H - PAD_Y - 2}
          textAnchor="end"
          fontSize="20"
          fontWeight="800"
          fill="#f1f5f9"
          stroke="#09090b"
          strokeWidth={5}
          paintOrder="stroke"
          strokeLinejoin="round"
        >
          −{compact(geometry.max)}
        </text>
      </svg>

      {/* Legend */}
      <ul className="mt-4 flex flex-col gap-2 text-base font-medium text-slate-200 sm:text-lg">
        <li className="flex items-center gap-3">
          <span className="flex shrink-0 gap-1" aria-hidden="true">
            <span className="h-4 w-2.5 rounded-sm bg-green-500" />
            <span className="h-4 w-2.5 rounded-sm bg-zinc-500" />
            <span className="h-4 w-2.5 rounded-sm bg-red-500" />
          </span>
          <span>
            <strong className="font-bold text-white">Bars</strong> = daily Net Volume
          </span>
        </li>
        <li className="flex items-center gap-3">
          <svg width="40" height="8" viewBox="0 0 40 8" className="shrink-0" aria-hidden="true">
            <line x1="0" y1="4" x2="40" y2="4" stroke={FLOOR_STROKE} strokeWidth={3} strokeDasharray="8 5" />
          </svg>
          <span>
            <strong className="font-bold text-white">Dashed lines</strong> = ±Noise Floor
            {last?.noiseFloor != null && (
              <strong className="font-bold text-white"> (±{compact(last.noiseFloor)} now)</strong>
            )}
            <span className="block text-base text-slate-300">
              10% of the 20-day average volume. Bars outside the lines are Drive or Reverse.
            </span>
          </span>
        </li>
        <li className="flex items-center gap-3">
          <svg width="40" height="8" viewBox="0 0 40 8" className="shrink-0" aria-hidden="true">
            <line x1="0" y1="4" x2="14" y2="4" stroke={SENTIMENT_GOOD} strokeWidth={5} strokeLinecap="round" />
            <line x1="14" y1="4" x2="27" y2="4" stroke={SENTIMENT_STROKE} strokeWidth={5} strokeLinecap="round" />
            <line x1="27" y1="4" x2="40" y2="4" stroke={SENTIMENT_BAD} strokeWidth={5} strokeLinecap="round" />
          </svg>
          <span>
            <strong className="font-bold" style={{ color: SENTIMENT_GOOD }}>Green</strong> /{" "}
            <strong className="font-bold" style={{ color: SENTIMENT_BAD }}>red</strong> /{" "}
            <strong className="font-bold" style={{ color: SENTIMENT_STROKE }}>purple line</strong> = Crowd
            Sentiment{" "}
            {liveSentiment ? (
              <span className="rounded bg-green-400 px-1.5 py-0.5 text-sm font-extrabold uppercase text-zinc-900">
                Live news
              </span>
            ) : (
              <span className="rounded bg-amber-400 px-1.5 py-0.5 text-sm font-extrabold uppercase text-zinc-900">
                News unavailable
              </span>
            )}
            <span className="block text-base text-slate-300">
              Green = good-news day (+1 Euphoria), red = bad-news day (−1 Fear), purple = neutral
              (0 Apathy), scored from bullish vs bearish keywords in news headlines.{" "}
              {liveSentiment
                ? "Days the news feed does not cover plot as 0."
                : "The feed could not be read, so every day plots as 0."}
            </span>
          </span>
        </li>
      </ul>
    </section>
  );
}
