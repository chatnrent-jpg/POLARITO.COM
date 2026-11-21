/**
 * READ-ONLY: what would one-year-plus SPY options cost today, and what would -10% / +10% do to them?
 *
 *   npx tsx scripts/spy-options-now.ts [--spot=689.81] [--iv=0.27] [--rate=0.043] [--div=0.012] [--expiry=2027-12-17] [--asof=2026-11-20] [--budget=1000]
 *
 * This is a Black-Scholes MODEL with assumed volatilities, NOT a market quote. No keys, no network, no orders.
 * Real prices must come from the live options chain (Alpaca options snapshots need the repo's Alpaca keys).
 * Skew is a rough assumption: out-of-the-money puts carry a higher IV than the at-the-money level, calls a lower one.
 */
const arg = (name: string, d: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? d;
const S = Number(arg("spot", "689.81"));
const IV_ATM = Number(arg("iv", "0.27"));
const R = Number(arg("rate", "0.043"));
const Q = Number(arg("div", "0.012"));
const ASOF = arg("asof", "2026-11-20");
const EXPIRY = arg("expiry", "2027-12-17");
const BUDGET = Number(arg("budget", "1000"));
const SKEW_PUT_PER_10 = 0.04;
const SKEW_CALL_PER_10 = -0.03;
const MAX_PREMIUM_PCT_OF_EQUITY = 0.1; // src/lib/optionsRunner.ts

const N = (x: number) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};
const nd = (x: number) => 0.3989423 * Math.exp((-x * x) / 2);
type Type = "call" | "put";
function bs(type: Type, s: number, k: number, t: number, sigma: number) {
  if (t <= 0) return Math.max(type === "call" ? s - k : k - s, 0);
  const v = sigma * Math.sqrt(t);
  const d1 = (Math.log(s / k) + (R - Q + (sigma * sigma) / 2) * t) / v;
  const d2 = d1 - v;
  return type === "call" ? s * Math.exp(-Q * t) * N(d1) - k * Math.exp(-R * t) * N(d2) : k * Math.exp(-R * t) * N(-d2) - s * Math.exp(-Q * t) * N(-d1);
}
function greeks(type: Type, s: number, k: number, t: number, sigma: number) {
  const v = sigma * Math.sqrt(t);
  const d1 = (Math.log(s / k) + (R - Q + (sigma * sigma) / 2) * t) / v;
  const delta = type === "call" ? Math.exp(-Q * t) * N(d1) : -Math.exp(-Q * t) * N(-d1);
  const vega = (s * Math.exp(-Q * t) * nd(d1) * Math.sqrt(t)) / 100; // per 1 vol point
  const theta = bs(type, s, k, t - 1 / 365, sigma) - bs(type, s, k, t, sigma); // per calendar day
  return { delta, vega, theta };
}

const t0 = Date.parse(ASOF);
const T = (Date.parse(EXPIRY) - t0) / (365 * 86_400_000);
if (!(S > 0) || !(T > 0)) throw new Error("bad inputs");
const roundK = (k: number, up: boolean) => (up ? Math.ceil(k / 5) * 5 : Math.floor(k / 5) * 5);
const specs: Array<{ name: string; type: Type; k: number; otm: number }> = [
  { name: "ATM call", type: "call", k: Math.round(S / 5) * 5, otm: 0 },
  { name: "10% OTM call", type: "call", k: roundK(S * 1.1, true), otm: 0.1 },
  { name: "20% OTM call", type: "call", k: roundK(S * 1.2, true), otm: 0.2 },
  { name: "ATM put", type: "put", k: Math.round(S / 5) * 5, otm: 0 },
  { name: "10% OTM put", type: "put", k: roundK(S * 0.9, false), otm: 0.1 },
  { name: "20% OTM put", type: "put", k: roundK(S * 0.8, false), otm: 0.2 },
];
const ivFor = (s: (typeof specs)[number]) => IV_ATM + (s.otm / 0.1) * (s.type === "put" ? SKEW_PUT_PER_10 : SKEW_CALL_PER_10);
const usd = (x: number) => `$${x.toFixed(2)}`;
const pc = (x: number) => `${(x * 100).toFixed(0)}%`;

const rows = specs.map((s) => {
  const iv = ivFor(s);
  const prem = bs(s.type, S, s.k, T, iv);
  const g = greeks(s.type, S, s.k, T, iv);
  const one = (spotMove: number, ivShift: number, days: number) => {
    const t = Math.max(0, T - days / 365);
    const v = bs(s.type, S * (1 + spotMove), s.k, t, iv + ivShift);
    return { value: v, pnlPct: v / prem - 1, pnlUsd: (v - prem) * 100 };
  };
  const cost = prem * 100;
  return {
    name: s.name, strike: s.k, iv, premiumPerShare: prem, perContract: cost, contractsFor1000: Math.floor(BUDGET / cost), fitsRepoCap: cost <= BUDGET * MAX_PREMIUM_PCT_OF_EQUITY,
    ...g, thetaPerContractPerDay: g.theta * 100, vegaPerContract: g.vega * 100, deltaShares: g.delta * 100,
    down10: one(-0.1, 0, 0), up10: one(0.1, 0, 0), down10IvUp: one(-0.1, 0.06, 0), up10IvDown: one(0.1, -0.04, 0),
    down10After90d: one(-0.1, 0, 90), up10After90d: one(0.1, 0, 90), flat90d: one(0, 0, 90), flat180d: one(0, 0, 180),
  };
});

const lines: string[] = [];
lines.push(`SPY ${S}, as of ${ASOF}, expiry ${EXPIRY} (T = ${T.toFixed(2)} years), ATM IV assumed ${pc(IV_ATM)}, rate ${pc(R)}, dividend yield ${(Q * 100).toFixed(1)}%. MODEL, not quotes.`);
lines.push("| Option | Strike | IV used | Price / share | Cost / contract | Contracts for budget | Delta (shares) | Theta / day / contract | Vega / vol pt / contract |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) lines.push(`| ${r.name} | ${r.strike} | ${pc(r.iv)} | ${usd(r.premiumPerShare)} | ${usd(r.perContract)} | ${r.contractsFor1000} | ${r.deltaShares.toFixed(0)} | ${usd(r.thetaPerContractPerDay)} | ${usd(r.vegaPerContract)} |`);
lines.push("");
lines.push("| Option | SPY -10% now | SPY -10% now, IV +6 pts | SPY +10% now | SPY +10% now, IV -4 pts | flat 3 months | flat 6 months | -10% after 3 months | +10% after 3 months |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) lines.push(`| ${r.name} | ${pc(r.down10.pnlPct)} (${usd(r.down10.pnlUsd)}) | ${pc(r.down10IvUp.pnlPct)} (${usd(r.down10IvUp.pnlUsd)}) | ${pc(r.up10.pnlPct)} (${usd(r.up10.pnlUsd)}) | ${pc(r.up10IvDown.pnlPct)} (${usd(r.up10IvDown.pnlUsd)}) | ${pc(r.flat90d.pnlPct)} | ${pc(r.flat180d.pnlPct)} | ${pc(r.down10After90d.pnlPct)} | ${pc(r.up10After90d.pnlPct)} |`);
lines.push("");
const sens = [0.22, 0.27, 0.32].map((iv) => `IV ${pc(iv)}: ATM call ${usd(bs("call", S, Math.round(S / 5) * 5, T, iv) * 100)}, ATM put ${usd(bs("put", S, Math.round(S / 5) * 5, T, iv) * 100)} per contract`);
lines.push(`ATM sensitivity to the IV assumption: ${sens.join("; ")}.`);
lines.push(`Repo cap: src/lib/optionsRunner.ts MAX_PREMIUM_PCT_OF_EQUITY = ${MAX_PREMIUM_PCT_OF_EQUITY * 100}% of equity = ${usd(BUDGET * MAX_PREMIUM_PCT_OF_EQUITY)} per position on a ${usd(BUDGET)} account.`);
for (const type of ["call", "put"] as Type[]) {
  for (const budget of [BUDGET, BUDGET * MAX_PREMIUM_PCT_OF_EQUITY]) {
    let found: string | null = null;
    for (let otm = 0; otm <= 0.85 && !found; otm += 0.01) {
      const k = type === "call" ? roundK(S * (1 + otm), true) : roundK(S * (1 - otm), false);
      const iv = IV_ATM + (otm / 0.1) * (type === "put" ? SKEW_PUT_PER_10 : SKEW_CALL_PER_10);
      const cost = bs(type, S, k, T, Math.max(0.05, iv)) * 100;
      if (cost <= budget) found = `${(otm * 100).toFixed(0)}% OTM, strike ${k}, about ${usd(cost)} per contract`;
    }
    lines.push(`Closest 1-year ${type} that costs at most ${usd(budget)}: ${found ?? "none within 85% OTM"}.`);
  }
}
console.log(lines.join("\n"));
if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
