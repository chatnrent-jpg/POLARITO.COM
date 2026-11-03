# Forward test: capitulation fade (frozen protocol)

Started: 2026-11-03. This file is the contract. If any rule below changes, start a NEW log
directory; never edit a running one.

## Rule (identical to reports/capitulation-validation.md)
A stock's session is a **signal** when the shipped engine reads **Reverse at a 1.5x Noise
Floor**: red candle (close < open) on volume > 1.5x its trailing 20-session average volume.
Trade: **buy the next session's open, sell that same session's close**, long only, 1x notional.

## Universe (frozen in `universe.json`)
48 liquid US stocks: the 39-stock validation list + the top-10 SPY holdings used in
`reports/top10-study.md` (deduplicated). SPY is fetched only as a calendar reference.

## Process
1. Run `npm run signal-log` **after 16:20 ET and before the next 09:30 ET open**. Sessions are
   treated as finished only after 16:20 ET (partial days are ignored).
2. A signal is logged only if it is **live**: no later session bar exists yet. Anything found
   after the next open began is refused, not back-filled (that would be hindsight).
3. The next run settles earlier signals: entry = open, exit = close of the first later session.
   The baseline is the mean open->close return of the whole universe the same day.
4. At settlement the signal is re-evaluated on final data (`still_fires`) to measure how often a
   live after-close volume number disagrees with the final consolidated one.
5. Sessions the script did not run are listed as **missed** in the summary; they are never
   reconstructed.

## Costs reported (per side, round trip = 2x)
2 bps (mega-cap, market-on-open / market-on-close), 4 bps (stress), 10 bps (the earlier doubled
stress that failed). Real fills are NOT simulated here; this log uses official open and close
prints, so it measures the signal, not execution. Measure execution separately with small real
orders before trusting any cost figure.

## What this log can and cannot show
- Roughly 2-3 signals per session, about 500-600 per year. Per-signal noise is about 2%, so one
  year gives a standard error near 0.08%, similar to the effect itself (about 0.1%).
- It therefore **cannot statistically confirm** the edge within a year. Confirmation already
  rests on the 4,765-signal backtest. This log's jobs are: (1) check the live after-close data
  matches final data, (2) catch the effect disappearing, (3) accumulate genuinely unseen data.
- Do not risk capital on this log alone.
