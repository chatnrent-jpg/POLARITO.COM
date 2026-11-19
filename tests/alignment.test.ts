/**
 * The one rule of the system: no trade that does not match the current polarity,
 * regardless of anything else (sizing, risk limits, cash, flips, settings).
 *   +1 (Drive)   -> long only
 *   -1 (Reverse) -> short only
 *    0 / not ready -> flat
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAutoSim, type AutoSimInput } from "../src/lib/autoSim";
import { DEFAULT_AUTO_SIM_PREFS, type AutoSimPrefs } from "../src/lib/autoSimPrefs";
import { addLedgerEntry, type ClosedTrade, type LedgerEntry, type LedgerSnapshot, type Position } from "../src/lib/ledger";
import type { Polarity } from "../src/lib/polarity";

const NOW = new Date("2026-11-20T15:00:00Z");
const POLARITIES: Polarity[] = [1, 0, -1];

/** The rule, written independently of the app code: +1 long, -1 short, anything else flat. */
function wantedSide(polarity: number, ready: boolean): "long" | "short" | null {
  if (!ready) return null;
  if (polarity === 1) return "long";
  if (polarity === -1) return "short";
  return null;
}
const READY = [true, false];
const HELD: Array<"none" | "long" | "short"> = ["none", "long", "short"];

const pos = (side: "long" | "short"): Position => ({
  ticker: "NVDA",
  side,
  quantity: 10,
  avgPrice: 90,
  openedAt: "2026-11-17T00:00:00.000Z",
  updatedAt: "2026-11-17T00:00:00.000Z",
  fills: 1,
  polarityAtEntry: side === "long" ? 1 : -1,
});

const loss = (pnl: number): ClosedTrade => ({
  id: `t${pnl}`,
  simulated: true,
  ticker: "NVDA",
  side: "long",
  quantity: 10,
  entryPrice: 100,
  exitPrice: 100 + pnl / 10,
  exitDate: "2026-11-19",
  openedAt: "2026-11-01T00:00:00.000Z",
  closedAt: "2026-11-19",
  realizedPnl: pnl,
});

const SCENARIOS: Array<{ name: string; closed: ClosedTrade[]; prefs: Partial<AutoSimPrefs> }> = [
  { name: "normal", closed: [], prefs: {} },
  { name: "daily loss pause", closed: [loss(-3_000)], prefs: {} },
  { name: "daily profit lock", closed: [loss(5_000)], prefs: {} },
  { name: "losing streak", closed: [loss(-10), loss(-10), loss(-10)], prefs: {} },
  { name: "huge request", closed: [], prefs: { quantity: 100_000 } },
  { name: "risk sizing", closed: [], prefs: { sizingMode: "risk" } },
  { name: "next-open fills", closed: [], prefs: { fillMode: "next-open" } },
];

describe("alignment: the decision never leaves a position against the polarity", () => {
  for (const sc of SCENARIOS) {
    for (const polarity of POLARITIES) {
      for (const ready of READY) {
        for (const held of HELD) {
          const label = `${sc.name} | polarity ${polarity} ready=${ready} | holding ${held}`;
          it(label, () => {
            const input: AutoSimInput = {
              ticker: "NVDA",
              signal: { polarity, ready, date: "2026-11-18" },
              fill: { date: "2026-11-19", price: 100 },
            };
            const ledger: LedgerSnapshot = {
              accountId: "conservative-swing",
              positions: held === "none" ? [] : [pos(held)],
              closed: sc.closed,
            };
            const prefs: AutoSimPrefs = { ...DEFAULT_AUTO_SIM_PREFS, enabled: true, quantity: 10, ...sc.prefs };
            const d = decideAutoSim(input, ledger, prefs, NOW);
            const wanted = wantedSide(polarity, ready);

            // The state after the decision is applied.
            const after = ledger.positions.filter((p) => p !== d.close);
            if (d.enter) after.push({ ...pos(d.enter.side) });

            if (wanted === null) {
              assert.equal(d.enter, null, "never enters on Neutral / not ready");
              assert.equal(after.length, 0, "flat on Neutral / not ready");
            } else {
              if (d.enter) assert.equal(d.enter.side, wanted, "entries match the polarity");
              for (const p of after) assert.equal(p.side, wanted, "no position against the polarity");
            }
          });
        }
      }
    }
  }

  it("the only time nothing is done about a wrong-way position is when the data cannot be trusted (stale)", () => {
    const stale: AutoSimInput = {
      ticker: "NVDA",
      signal: { polarity: -1, ready: true, date: "2026-10-01" },
      fill: { date: "2026-10-02", price: 100 },
    };
    const d = decideAutoSim(
      stale,
      { accountId: "conservative-swing", positions: [pos("long")], closed: [] },
      { ...DEFAULT_AUTO_SIM_PREFS, enabled: true },
      NOW,
    );
    assert.equal(d.enter, null);
    assert.equal(d.kind, "skip");
  });
});

describe("alignment: the ledger refuses a misaligned entry on its own", () => {
  const entry = (side: "long" | "short", polarityAtEntry: Polarity): LedgerEntry => ({
    id: "e1",
    createdAt: "2026-11-19T00:00:00.000Z",
    simulated: true,
    ticker: "NVDA",
    side,
    quantity: 1,
    price: 100,
    priceBasis: "last daily close",
    priceDate: "2026-11-19",
    polarityAtEntry,
    notional: 100,
  });

  it("long on Reverse and short on Drive are rejected before anything is stored", () => {
    for (const [side, pol] of [["long", -1], ["short", 1]] as const) {
      const r = addLedgerEntry(entry(side, pol), "conservative-swing");
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, /must match the polarity/);
    }
  });

  it("a Neutral stamp is rejected too", () => {
    assert.equal(addLedgerEntry(entry("long", 0), "conservative-swing").ok, false);
  });
});
