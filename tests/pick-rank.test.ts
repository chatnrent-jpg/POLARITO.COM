import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computePolaritySeries } from "../src/lib/polarity";
import {
  COMPANY_GROUPS,
  dollarVolume20,
  rankCandidates,
  readingScore,
  sizeLiveEntry,
  toReading,
  walkCandidates,
  type Reading,
} from "../src/lib/pickRank";
import { makeBars, TODAY } from "./helpers/liveFake";

const reading = (ticker: string, over: Partial<Reading> = {}): Reading => ({
  ticker,
  polarity: 1,
  ready: true,
  score: 10,
  dollarVolume20: 1_000_000,
  price: 100,
  barDate: TODAY,
  ...over,
});

const size1k = (price: number, over: Partial<Parameters<typeof sizeLiveEntry>[0]> = {}) =>
  sizeLiveEntry(
    { price, equity: 1_000, lastEquity: 1_000, cash: 1_000, buyingPower: 1_000, reservedNotional: 0, today: TODAY, quantity: 1, maxPositionPct: 50, dailyLossPct: 1, ...over },
    "long",
  );

describe("readingScore and toReading", () => {
  it("scores |netVolume| / noiseFloor and is 0 for Neutral", () => {
    const strong = toReading("X", makeBars({ kind: "drive", mult: 9 }), computePolaritySeries(makeBars({ kind: "drive", mult: 9 })));
    assert.equal(strong.polarity, 1);
    assert.ok(strong.score > 50);
    const neutralBars = makeBars({ kind: "neutral" });
    const neutral = toReading("X", neutralBars, computePolaritySeries(neutralBars));
    assert.equal(neutral.polarity, 0);
    assert.equal(neutral.score, 0);
  });

  it("a bigger volume surge scores higher", () => {
    const score = (mult: number) => {
      const b = makeBars({ kind: "drive", mult });
      return toReading("X", b, computePolaritySeries(b)).score;
    };
    assert.ok(score(12) > score(6));
  });

  it("not-ready history scores 0", () => {
    const b = makeBars({ kind: "drive", count: 10 });
    const r = toReading("X", b, computePolaritySeries(b));
    assert.equal(r.ready, false);
    assert.equal(r.score, 0);
    assert.equal(readingScore({ ...computePolaritySeries(makeBars({ kind: "drive" })).at(-1)!, noiseFloor: 0 }), 0);
  });

  it("dollar volume averages the last 20 bars", () => {
    assert.equal(dollarVolume20([]), 0);
    const b = makeBars({ kind: "neutral", price: 100, baseVolume: 1000 });
    assert.ok(dollarVolume20(b) > 90_000 && dollarVolume20(b) < 100_000);
  });
});

describe("rankCandidates", () => {
  it("orders by score, then liquidity, then name", () => {
    const ranked = rankCandidates([
      reading("AAA", { score: 5 }),
      reading("BBB", { score: 9 }),
      reading("DDD", { score: 5, dollarVolume20: 2_000_000 }),
      reading("CCC", { score: 5 }),
    ]);
    assert.deepEqual(ranked.map((r) => r.key), ["BBB", "DDD", "AAA", "CCC"]);
  });

  it("Neutral names sink to the bottom", () => {
    const ranked = rankCandidates([reading("NEU", { polarity: 0, score: 0 }), reading("DRV", { score: 1 })]);
    assert.deepEqual(ranked.map((r) => r.key), ["DRV", "NEU"]);
  });

  it("GOOGL and GOOG collapse into one candidate (Alphabet counted once)", () => {
    assert.deepEqual(COMPANY_GROUPS, [["GOOGL", "GOOG"]]);
    const ranked = rankCandidates([
      reading("GOOGL", { score: 8 }),
      reading("GOOG", { score: 8 }),
      reading("NVDA", { score: 7 }),
    ]);
    assert.equal(ranked.length, 2);
    assert.deepEqual(ranked.map((r) => r.key), ["GOOG", "NVDA"]);
    assert.equal(ranked[0].members.length, 2);
  });

  it("GOOGL/GOOG with equal scores and equal liquidity: GOOG first, alphabetical", () => {
    const ranked = rankCandidates([reading("GOOGL"), reading("GOOG")]);
    assert.deepEqual(ranked[0].members.map((m) => m.ticker), ["GOOG", "GOOGL"]);
  });

  it("GOOGL/GOOG: the more liquid class is tried first, whatever the score gap", () => {
    const ranked = rankCandidates([
      reading("GOOG", { score: 9.4, dollarVolume20: 1_000 }),
      reading("GOOGL", { score: 9.1, dollarVolume20: 5_000 }),
    ]);
    assert.deepEqual(ranked[0].members.map((m) => m.ticker), ["GOOGL", "GOOG"]);
    assert.equal(ranked[0].score, 9.4);
  });

  it("a near-equal Alphabet pair cannot take two slots, and ties between companies break by liquidity", () => {
    const ranked = rankCandidates([
      reading("GOOGL", { score: 6.001 }),
      reading("GOOG", { score: 6.002 }),
      reading("AAPL", { score: 6.0, dollarVolume20: 9_000_000 }),
    ]);
    assert.equal(ranked.length, 2);
    // Scores compare at two decimals: 6.00 ties, the more liquid company wins.
    assert.equal(ranked[0].key, "AAPL");
  });

  it("an Alphabet pair where one class is Neutral still ranks by the better class", () => {
    const ranked = rankCandidates([reading("GOOGL", { polarity: 0, score: 0 }), reading("GOOG", { score: 4 }), reading("TSLA", { score: 3 })]);
    assert.equal(ranked[0].key, "GOOG");
  });
});

describe("sizeLiveEntry at $1,000 with the 50% cap", () => {
  it("lets one whole share of each of Henry's ten names through", () => {
    const prices: Record<string, number> = { NVDA: 130.35, AMZN: 248.52, GOOG: 267.58, GOOGL: 270.49, AVGO: 302.96, JPM: 311.42, WMT: 128.75, AAPL: 344.54, TSLA: 348.59, MSFT: 487.1 };
    for (const [t, p] of Object.entries(prices)) assert.equal(size1k(p).quantity, 1, t);
  });

  it("rounds a share that costs more than the cap down to zero and says why", () => {
    const r = size1k(600);
    assert.equal(r.quantity, 0);
    assert.match(r.reason ?? "", /per-position cap/);
    assert.equal(size1k(1106.54).quantity, 0, "COST would never fit");
  });

  it("MSFT is borderline: it fits at $975 of equity (2 x $487.10) and drops out at $973", () => {
    assert.equal(size1k(487.1, { equity: 975, lastEquity: 975, cash: 975, buyingPower: 975 }).quantity, 1);
    assert.equal(size1k(487.1, { equity: 973, lastEquity: 973, cash: 973, buyingPower: 973 }).quantity, 0);
    assert.equal(size1k(500.01).quantity, 0);
  });

  it("WMT just fits at $258 of equity", () => {
    assert.equal(size1k(128.75, { equity: 258, lastEquity: 258, cash: 258, buyingPower: 258 }).quantity, 1);
    assert.equal(size1k(128.75, { equity: 257, lastEquity: 257, cash: 257, buyingPower: 257 }).quantity, 0);
  });

  it("a larger fixed quantity is cut to the cap (WMT up to 3, never above)", () => {
    const r = size1k(128.75, { quantity: 10 });
    assert.equal(r.quantity, 3);
    assert.ok(r.notes.some((n) => /per-position cap/.test(n)));
  });

  it("cash can also round to zero", () => {
    assert.equal(size1k(128.75, { cash: 100, buyingPower: 100 }).quantity, 0);
  });

  it("blocks new entries once the day is at the 1% stop", () => {
    const r = size1k(128.75, { equity: 990, lastEquity: 1_000 });
    assert.equal(r.quantity, 0);
    assert.match(r.reason ?? "", /Daily loss limit/);
  });
});

describe("walkCandidates", () => {
  const ok = async () => null;
  const sized = (price: Record<string, number>) => (r: Reading, side: "long" | "short") => {
    const s = sizeLiveEntry(
      { price: price[r.ticker] ?? r.price, equity: 1_000, lastEquity: 1_000, cash: 1_000, buyingPower: 1_000, reservedNotional: 0, today: TODAY, quantity: 1, maxPositionPct: 50, dailyLossPct: 1 },
      side,
    );
    return s;
  };
  const ctx = (over: Record<string, unknown> = {}) => ({
    today: TODAY,
    shortBlocked: "shorting needs $2,000.",
    longOnlyFallback: "next" as const,
    checkAsset: ok,
    size: sized({}),
    ...over,
  });

  it("takes the top-ranked eligible name", async () => {
    const ranked = rankCandidates([reading("A", { score: 9 }), reading("B", { score: 5 })]);
    const w = await walkCandidates(ranked, ctx());
    assert.equal(w.pick?.reading.ticker, "A");
    assert.equal(w.pick?.side, "long");
    assert.deepEqual(w.skips, []);
  });

  it("a top name that rounds to zero shares is skipped and the next eligible one is taken, with a logged reason", async () => {
    const ranked = rankCandidates([reading("EXPENSIVE", { score: 9 }), reading("CHEAP", { score: 5 })]);
    const w = await walkCandidates(ranked, ctx({ size: sized({ EXPENSIVE: 900, CHEAP: 120 }) }));
    assert.equal(w.pick?.reading.ticker, "CHEAP");
    assert.equal(w.skips.length, 1);
    assert.match(w.skips[0], /^EXPENSIVE: .*per-position cap/);
  });

  it("returns no pick when every name is ineligible, one line per skip", async () => {
    const ranked = rankCandidates([
      reading("A", { polarity: 0, score: 0 }),
      reading("B", { ready: false, score: 0 }),
      reading("C", { barDate: "2026-11-18" }),
      reading("D", { score: 1 }),
    ]);
    const w = await walkCandidates(ranked, ctx({ checkAsset: async () => "asset is not tradable." }));
    assert.equal(w.pick, null);
    assert.equal(w.aside, null);
    assert.equal(w.skips.length, 4);
    assert.ok(w.skips.some((s) => /Neutral/.test(s)));
    assert.ok(w.skips.some((s) => /not enough history/.test(s)));
    assert.ok(w.skips.some((s) => /not today/.test(s)));
    assert.ok(w.skips.some((s) => /not tradable/.test(s)));
  });

  it("long-only: a Reverse name is skipped to the next Drive name (fallback next)", async () => {
    const ranked = rankCandidates([reading("DOWN", { polarity: -1, score: 9 }), reading("UP", { score: 4 })]);
    const w = await walkCandidates(ranked, ctx());
    assert.equal(w.pick?.reading.ticker, "UP");
    assert.match(w.skips[0], /^DOWN: Reverse \(-1\) but shorting needs/);
  });

  it("long-only: with the aside fallback a Reverse name on top stands the day aside", async () => {
    const ranked = rankCandidates([reading("DOWN", { polarity: -1, score: 9 }), reading("UP", { score: 4 })]);
    const w = await walkCandidates(ranked, ctx({ longOnlyFallback: "aside" }));
    assert.equal(w.pick, null);
    assert.match(w.aside ?? "", /Standing aside/);
  });

  it("aside only triggers when the Reverse name outranks every eligible Drive name", async () => {
    const ranked = rankCandidates([reading("UP", { score: 9 }), reading("DOWN", { polarity: -1, score: 4 })]);
    const w = await walkCandidates(ranked, ctx({ longOnlyFallback: "aside" }));
    assert.equal(w.pick?.reading.ticker, "UP");
  });

  it("when shorting is allowed a Reverse name is picked as a short", async () => {
    const ranked = rankCandidates([reading("DOWN", { polarity: -1, score: 9 })]);
    const w = await walkCandidates(ranked, ctx({ shortBlocked: null }));
    assert.equal(w.pick?.side, "short");
  });

  it("Alphabet: the chosen class failing its checks falls to the other class before the next company", async () => {
    const ranked = rankCandidates([
      reading("GOOG", { score: 8, dollarVolume20: 5_000 }),
      reading("GOOGL", { score: 8, dollarVolume20: 1_000 }),
      reading("NVDA", { score: 7 }),
    ]);
    const calls: string[] = [];
    const w = await walkCandidates(ranked, ctx({ checkAsset: async (t: string) => { calls.push(t); return t === "GOOG" ? "asset is not tradable." : null; } }));
    assert.equal(w.pick?.reading.ticker, "GOOGL");
    assert.deepEqual(calls, ["GOOG", "GOOGL"]);
  });

  it("Alphabet: both classes failing moves on to the next company, never trading both", async () => {
    const ranked = rankCandidates([reading("GOOG", { score: 8 }), reading("GOOGL", { score: 8 }), reading("NVDA", { score: 7 })]);
    const w = await walkCandidates(ranked, ctx({ checkAsset: async (t: string) => (t.startsWith("GOOG") ? "asset is not tradable." : null) }));
    assert.equal(w.pick?.reading.ticker, "NVDA");
    assert.equal(w.skips.length, 2);
  });
});
