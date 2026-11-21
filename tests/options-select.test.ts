import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DELTA_THRESHOLDS,
  FALLBACK_LABEL,
  MAX_DELTA_DISAGREEMENT,
  MIN_ABS_DELTA,
  MIN_DAYS_TO_EXPIRY,
  affordability,
  assertContractRules,
  bsDelta,
  bsPrice,
  buildRow,
  earliestExpiry,
  impliedVol,
  nearestQualifyingExpiry,
  normCdf,
  pickDeepItm,
  type ChainRow,
  type RawOptionSnapshot,
} from "../src/lib/optionsSelect";
import { daysBetween } from "../src/lib/broker/options";

const TODAY = "2026-11-20";
const NOW = new Date("2026-11-20T20:00:00Z");
const SPOT = 690;
const YEAR_OUT = "2027-11-20"; // exactly 365 days after TODAY

const occ = (exp: string, type: "C" | "P", strike: number): string => `SPY${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${type}${String(Math.round(strike * 1000)).padStart(8, "0")}`;

/** A quote priced by Black-Scholes at 27% volatility, with a tight spread. */
function modelRaw(exp: string, type: "call" | "put", strike: number, opts: { delta?: number | null; iv?: number | null; bidAskFrac?: number } = {}): RawOptionSnapshot {
  const years = daysBetween(TODAY, exp) / 365;
  const mid = bsPrice(type, SPOT, strike, years, 0.27);
  const half = mid * (opts.bidAskFrac ?? 0.004);
  return {
    symbol: occ(exp, type === "call" ? "C" : "P", strike),
    bid: Number((mid - half).toFixed(2)),
    ask: Number((mid + half).toFixed(2)),
    quoteAt: "2026-11-20T19:59:00Z",
    delta: opts.delta ?? null,
    iv: opts.iv ?? null,
  };
}

function rows(exp: string, type: "call" | "put", strikes: number[]): ChainRow[] {
  const out: ChainRow[] = [];
  for (const k of strikes) {
    const r = buildRow(modelRaw(exp, type, k), SPOT, TODAY, NOW);
    assert.ok(r.ok, r.ok ? "" : r.reason);
    out.push(r.row);
  }
  return out;
}

describe("hard rules are fixed constants", () => {
  it("minimum 365 days and delta 0.80", () => {
    assert.equal(MIN_DAYS_TO_EXPIRY, 365);
    assert.equal(MIN_ABS_DELTA, 0.8);
    assert.deepEqual({ ...DELTA_THRESHOLDS }, { primary: 0.8, floor: 0.6 });
    assert.ok(Object.isFrozen(DELTA_THRESHOLDS));
    assert.equal(earliestExpiry(TODAY), YEAR_OUT);
    assert.equal(daysBetween(TODAY, YEAR_OUT), 365);
  });
});

describe("Black-Scholes helpers", () => {
  it("normal CDF is sane", () => {
    assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-12);
    assert.ok(Math.abs(normCdf(1.96) - 0.9750021) < 1e-6);
    assert.ok(Math.abs(normCdf(-1.96) - 0.0249979) < 1e-6);
  });
  it("put-call parity and delta relation", () => {
    const c = bsPrice("call", 690, 690, 1, 0.27);
    const p = bsPrice("put", 690, 690, 1, 0.27);
    const parity = 690 * Math.exp(-0.012) - 690 * Math.exp(-0.043);
    assert.ok(Math.abs(c - p - parity) < 1e-9);
    assert.ok(Math.abs(bsDelta("call", 690, 690, 1, 0.27) - bsDelta("put", 690, 690, 1, 0.27) - Math.exp(-0.012)) < 1e-12);
  });
  it("implied volatility round-trips", () => {
    const price = bsPrice("call", 690, 560, 1.05, 0.31);
    const iv = impliedVol("call", price, 690, 560, 1.05);
    assert.ok(iv !== null && Math.abs(iv - 0.31) < 1e-6);
    assert.equal(impliedVol("call", 1_000_000, 690, 560, 1.05), null);
  });
});

describe("expiry rule: at least 365 days, nearest listed", () => {
  it("364 days is rejected, 365 is accepted", () => {
    assert.equal(nearestQualifyingExpiry(["2027-11-19"], TODAY), null);
    assert.equal(nearestQualifyingExpiry(["2027-11-20"], TODAY), "2027-11-20");
  });
  it("picks the nearest listed expiry at or beyond the minimum, ignoring shorter ones and bad strings", () => {
    const listed = ["2026-12-18", "2027-06-17", "2027-11-19", "2027-12-17", "2028-01-21", "bogus"];
    assert.equal(nearestQualifyingExpiry(listed, TODAY), "2027-12-17");
  });
  it("returns null when nothing is listed far enough out", () => {
    assert.equal(nearestQualifyingExpiry(["2026-12-18", "2027-06-17"], TODAY), null);
  });
});

describe("assertContractRules (final guard)", () => {
  const good = rows("2027-12-17", "call", [520])[0];
  it("a deep in-the-money, long-dated call passes", () => {
    assert.ok(Math.abs(good.delta) >= 0.8, `test row delta ${good.delta}`);
    assert.equal(assertContractRules(good, "call", TODAY), null);
  });
  it("delta just below 0.80 fails and exactly 0.80 passes", () => {
    assert.match(assertContractRules({ ...good, delta: 0.7999 }, "call", TODAY) ?? "", /below 0.8/);
    assert.equal(assertContractRules({ ...good, delta: 0.8 }, "call", TODAY), null);
  });
  it("a put needs delta <= -0.80", () => {
    const put = rows("2027-12-17", "put", [1000])[0];
    assert.ok(put.delta <= -0.8, `put delta ${put.delta}`);
    assert.equal(assertContractRules(put, "put", TODAY), null);
    assert.match(assertContractRules({ ...put, delta: -0.79 }, "put", TODAY) ?? "", /below 0.8/);
    assert.match(assertContractRules({ ...put, delta: 0.9 }, "put", TODAY) ?? "", /wrong sign/);
  });
  it("364 days to expiry fails even with a perfect delta", () => {
    const short = rows("2027-11-19", "call", [520])[0];
    assert.match(assertContractRules(short, "call", TODAY) ?? "", /minimum is 365/);
  });
  it("the wrong option type fails", () => {
    assert.match(assertContractRules(good, "put", TODAY) ?? "", /wanted a put/);
  });
  it("a wide spread fails", () => {
    assert.match(assertContractRules({ ...good, spreadPct: 0.2 }, "call", TODAY) ?? "", /spread/);
  });
  it("a tampered symbol/field mismatch fails", () => {
    assert.match(assertContractRules({ ...good, expiration: "2030-01-01" }, "call", TODAY) ?? "", /do not match/);
  });
});

describe("buildRow", () => {
  it("uses Black-Scholes delta when Alpaca sends none, and says so", () => {
    const r = buildRow(modelRaw("2027-12-17", "call", 520), SPOT, TODAY, NOW);
    assert.ok(r.ok);
    assert.equal(r.row.deltaSource, "black-scholes");
    assert.equal(r.row.ivSource, "solved");
    assert.ok(Math.abs((r.row.iv ?? 0) - 0.27) < 0.002);
  });
  it("uses Alpaca delta when it agrees with Black-Scholes", () => {
    const bs = buildRow(modelRaw("2027-12-17", "call", 520), SPOT, TODAY, NOW);
    assert.ok(bs.ok);
    const r = buildRow(modelRaw("2027-12-17", "call", 520, { delta: bs.row.delta + 0.01, iv: 0.27 }), SPOT, TODAY, NOW);
    assert.ok(r.ok);
    assert.equal(r.row.deltaSource, "alpaca");
  });
  it("rejects an Alpaca delta that disagrees with Black-Scholes by more than the limit", () => {
    const r = buildRow(modelRaw("2027-12-17", "call", 520, { delta: 0.99, iv: 0.27 }), SPOT, TODAY, NOW);
    assert.equal(r.ok, false);
    assert.ok(MAX_DELTA_DISAGREEMENT > 0);
  });
  it("ignores a wrong-signed Alpaca delta and falls back to Black-Scholes", () => {
    const r = buildRow(modelRaw("2027-12-17", "call", 520, { delta: -0.4 }), SPOT, TODAY, NOW);
    assert.ok(r.ok);
    assert.equal(r.row.deltaSource, "black-scholes");
  });
  it("rejects crossed, empty and stale quotes", () => {
    const base = modelRaw("2027-12-17", "call", 520);
    assert.equal(buildRow({ ...base, bid: 50, ask: 40 }, SPOT, TODAY, NOW).ok, false);
    assert.equal(buildRow({ ...base, bid: 0 }, SPOT, TODAY, NOW).ok, false);
    assert.equal(buildRow({ ...base, bid: null }, SPOT, TODAY, NOW).ok, false);
    assert.equal(buildRow({ ...base, quoteAt: "2026-11-01T00:00:00Z" }, SPOT, TODAY, NOW).ok, false);
  });
  it("rejects a non-option symbol", () => {
    assert.equal(buildRow({ ...modelRaw("2027-12-17", "call", 520), symbol: "SPY" }, SPOT, TODAY, NOW).ok, false);
  });
});

describe("pickDeepItm", () => {
  const exp = "2027-12-17";
  const strikes = [450, 480, 500, 520, 540, 560, 600, 650, 690];
  const calls = rows(exp, "call", strikes);

  it("chooses the cheapest contract that still has delta >= 0.80", () => {
    const pick = pickDeepItm(calls, [exp], "call", TODAY);
    assert.ok(pick.ok);
    assert.equal(pick.expiration, exp);
    assert.ok(Math.abs(pick.row.delta) >= 0.8);
    const cheaper = calls.filter((r) => Math.abs(r.delta) >= 0.8 && Math.abs(r.delta) < Math.abs(pick.row.delta));
    assert.equal(cheaper.length, 0);
    assert.ok(pick.qualifying >= 1);
    assert.ok(pick.daysToExpiry >= 365);
  });
  it("picks a put with delta <= -0.80", () => {
    const puts = rows(exp, "put", [690, 750, 800, 850, 900, 950, 1000]);
    const pick = pickDeepItm(puts, [exp], "put", TODAY);
    assert.ok(pick.ok);
    assert.ok(pick.row.delta <= -0.8);
    assert.equal(pick.row.type, "put");
  });
  it("never substitutes a later expiry when the nearest one has no qualifying contract", () => {
    const nearest = "2027-11-26";
    const near = rows(nearest, "call", [690, 750]); // far below even the 0.60 floor
    const later = rows("2027-12-17", "call", [450, 480, 500]); // would qualify
    const pick = pickDeepItm([...near, ...later], [nearest, "2027-12-17"], "call", TODAY);
    assert.equal(pick.ok, false);
    assert.equal(pick.expiration, nearest);
  });
  it("the fallback also never crosses into a later expiry: it stays on the nearest listed one", () => {
    const nearest = "2027-11-26";
    const near = rows(nearest, "call", [650, 690]); // between the floor and the target
    const later = rows("2027-12-17", "call", [450, 480, 500]);
    const pick = pickDeepItm([...near, ...later], [nearest, "2027-12-17"], "call", TODAY);
    assert.ok(pick.ok);
    assert.equal(pick.expiration, nearest);
    assert.equal(pick.tier, "fallback");
  });
  it("never uses an expiry shorter than 365 days, even if it is the only one with quotes", () => {
    const short = rows("2027-06-17", "call", [450, 480, 500]);
    const pick = pickDeepItm(short, ["2027-06-17"], "call", TODAY);
    assert.equal(pick.ok, false);
    assert.equal(pick.expiration, null);
  });
  it("exactly 365 days qualifies", () => {
    const edge = rows(YEAR_OUT, "call", [450, 480, 500]);
    const pick = pickDeepItm(edge, [YEAR_OUT], "call", TODAY);
    assert.ok(pick.ok);
    assert.equal(pick.daysToExpiry, 365);
  });
  it("stands aside when no quotes exist", () => {
    assert.equal(pickDeepItm([], [exp], "call", TODAY).ok, false);
  });
});

describe("delta fallback (primary 0.80, hard floor 0.60)", () => {
  const exp = "2027-12-17";
  const delta = (r: ChainRow) => Math.abs(r.delta);
  it("a contract at or above 0.80 is always chosen first, as before (tier primary, no fallback reason)", () => {
    const pick = pickDeepItm(rows(exp, "call", [450, 520, 600, 650, 690]), [exp], "call", TODAY);
    assert.ok(pick.ok);
    assert.equal(pick.tier, "primary");
    assert.equal(pick.fallbackReason, null);
    assert.ok(delta(pick.row) >= 0.8);
  });
  it("with none at 0.80, takes the HIGHEST |delta| that is still >= 0.60, and explains why", () => {
    const puts = rows(exp, "put", [690, 700, 800, 850, 875]); // all between about 0.40 and 0.75
    assert.ok(puts.every((r) => delta(r) < 0.8));
    const eligible = puts.filter((r) => delta(r) >= 0.6);
    assert.ok(eligible.length >= 2);
    const pick = pickDeepItm(puts, [exp], "put", TODAY);
    assert.ok(pick.ok);
    assert.equal(pick.tier, "fallback");
    assert.ok(delta(pick.row) >= 0.6 && delta(pick.row) < 0.8);
    assert.equal(delta(pick.row), Math.max(...eligible.map(delta)));
    assert.equal(pick.row.strike, 875);
    assert.equal(pick.qualifying, eligible.length);
    assert.match(pick.fallbackReason ?? "", /reaches \|delta\| 0\.8/);
    assert.match(pick.fallbackReason ?? "", /highest \|delta\| of any is/);
    assert.equal(pick.expiration, exp);
    assert.ok(pick.daysToExpiry >= 365);
  });
  it("calls fall back the same way", () => {
    const pick = pickDeepItm(rows(exp, "call", [650, 670, 690]), [exp], "call", TODAY);
    assert.ok(pick.ok);
    assert.equal(pick.tier, "fallback");
    assert.ok(delta(pick.row) >= 0.6 && delta(pick.row) < 0.8);
    assert.equal(pick.row.strike, 650);
  });
  it("nothing at or above 0.60 means no contract, and nothing is substituted", () => {
    const pick = pickDeepItm(rows(exp, "put", [690, 700, 750]), [exp], "put", TODAY);
    assert.equal(pick.ok, false);
    if (!pick.ok) {
      assert.match(pick.reason, /0\.6/);
      assert.equal(pick.expiration, exp);
    }
  });
  it("the floor is exactly 0.60: 0.599 is refused, 0.60 is accepted", () => {
    const base = rows(exp, "put", [850])[0];
    const at = (d: number): ChainRow => ({ ...base, delta: d });
    assert.equal(pickDeepItm([at(-0.599)], [exp], "put", TODAY).ok, false);
    const p = pickDeepItm([at(-0.6)], [exp], "put", TODAY);
    assert.ok(p.ok);
    assert.equal(p.tier, "fallback");
  });
  it("tie on |delta|: the tighter spread wins", () => {
    const base = rows(exp, "put", [850])[0];
    const wide: ChainRow = { ...base, symbol: base.symbol.replace("00850000", "00851000"), strike: 851, spreadPct: 0.1 };
    const tight: ChainRow = { ...base, symbol: base.symbol.replace("00850000", "00852000"), strike: 852, spreadPct: 0.02 };
    const pick = pickDeepItm([wide, tight], [exp], "put", TODAY);
    assert.ok(pick.ok);
    assert.equal(pick.tier, "fallback");
    assert.equal(pick.row.strike, 852);
  });
  it("quote quality still applies to the fallback: wide, crossed or stale quotes are never chosen", () => {
    const base = rows(exp, "put", [850])[0];
    assert.equal(pickDeepItm([{ ...base, spreadPct: 0.2 }], [exp], "put", TODAY).ok, false);
    // a higher delta with a too-wide spread loses to a lower, clean one
    const clean: ChainRow = { ...base, delta: -0.65 };
    const wideHigh: ChainRow = { ...base, symbol: base.symbol.replace("00850000", "00900000"), strike: 900, delta: -0.75, spreadPct: 0.3 };
    const pick = pickDeepItm([clean, wideHigh], [exp], "put", TODAY);
    assert.ok(pick.ok);
    assert.equal(pick.row.strike, 850);
  });
  it("the expiry rule is unchanged for the fallback: under 365 days is never used", () => {
    const short = rows("2027-06-17", "put", [850, 875]);
    const pick = pickDeepItm(short, ["2027-06-17"], "put", TODAY);
    assert.equal(pick.ok, false);
    assert.equal(pick.expiration, null);
  });
  it("assertContractRules: the floor can never be lowered by a caller", () => {
    const put = rows(exp, "put", [850])[0];
    assert.equal(assertContractRules({ ...put, delta: -0.65 }, "put", TODAY, DELTA_THRESHOLDS.floor), null);
    assert.match(assertContractRules({ ...put, delta: -0.65 }, "put", TODAY) ?? "", /below 0\.8/);
    assert.match(assertContractRules({ ...put, delta: -0.5 }, "put", TODAY, 0.1) ?? "", /below 0\.6/);
    assert.match(assertContractRules({ ...put, delta: -0.5 }, "put", TODAY, 0) ?? "", /below 0\.6/);
  });
  it("the label names the target", () => {
    assert.equal(FALLBACK_LABEL, "FALLBACK DELTA (below 0.80)");
  });
});

describe("affordability", () => {
  it("a several-thousand-dollar contract is not affordable on $1,000", () => {
    const a = affordability(6_000, 1_000);
    assert.equal(a.affordable, false);
    assert.equal(a.contracts, 0);
    assert.equal(a.shortfall, 5_000);
    assert.equal(affordability(900, 1_000).contracts, 1);
  });
});
