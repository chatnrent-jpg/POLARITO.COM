import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_POLLER_CONFIG, SpyPoller, type PollResult, type PollStatus, type PollerConfig } from "../src/lib/spyPoller";
import { createFakeClock } from "./helpers/fakeClock";

type Rig = ReturnType<typeof rig>;

/** A poller whose two fetches are scripted per call; every call time and every concurrent overlap is recorded. */
function rig(over: { config?: Partial<PollerConfig>; light?: (n: number, signal: AbortSignal) => Promise<PollResult<number>>; heavy?: (n: number, signal: AbortSignal) => Promise<PollResult<number>>; reject?: (v: number) => string | null } = {}) {
  const clock = createFakeClock(1_000_000);
  const t0 = clock.now();
  const lightAt: number[] = [];
  const heavyAt: number[] = [];
  const accepted: { light: number[]; heavy: number[] } = { light: [], heavy: [] };
  const live = { light: 0, heavy: 0, maxLight: 0, maxHeavy: 0 };
  const statuses: PollStatus[] = [];
  const wrap = (name: "light" | "heavy", at: number[], f: (n: number, s: AbortSignal) => Promise<PollResult<number>>) => async (signal: AbortSignal) => {
    at.push(clock.now() - t0);
    live[name]++;
    live[name === "light" ? "maxLight" : "maxHeavy"] = Math.max(live[name === "light" ? "maxLight" : "maxHeavy"], live[name]);
    try {
      return await f(at.length, signal);
    } finally {
      live[name]--;
    }
  };
  const ok = async (n: number): Promise<PollResult<number>> => ({ ok: true, value: n });
  const poller = new SpyPoller<number, number>(clock.env, { ...DEFAULT_POLLER_CONFIG, ...over.config }, {
    fetchLight: wrap("light", lightAt, over.light ?? ok),
    fetchHeavy: wrap("heavy", heavyAt, over.heavy ?? ok),
    onLight: (v) => (over.reject?.(v) ?? null) || (accepted.light.push(v), null),
    onHeavy: (v) => (accepted.heavy.push(v), null),
    onStatus: (s) => statuses.push(s),
  });
  return { clock, poller, lightAt, heavyAt, accepted, live, statuses, t0 };
}
const gaps = (xs: number[]): number[] => xs.slice(1).map((x, i) => x - xs[i]);
const fail = async (): Promise<PollResult<number>> => ({ ok: false, error: "down" });
const hang = (_n: number, signal: AbortSignal): Promise<PollResult<number>> => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));

describe("SPY desk poller: cadence", () => {
  it("asks both channels at once, then light every 5 s and heavy every 45 s", async () => {
    const r: Rig = rig();
    r.poller.start();
    await r.clock.advance(100_000);
    assert.equal(r.lightAt[0], 0);
    assert.equal(r.heavyAt[0], 0);
    assert.deepEqual(new Set(gaps(r.lightAt)), new Set([5_000]));
    assert.deepEqual(new Set(gaps(r.heavyAt)), new Set([45_000]));
    assert.equal(r.lightAt.length, 21);
    assert.equal(r.heavyAt.length, 3);
    r.poller.stop();
  });
  it("the default cadence is 5 s light, 45 s heavy, with the cap at 20 requests a minute", () => {
    assert.equal(DEFAULT_POLLER_CONFIG.light.intervalMs, 5_000);
    assert.equal(DEFAULT_POLLER_CONFIG.heavy.intervalMs, 45_000);
    assert.equal(DEFAULT_POLLER_CONFIG.maxPerMinute, 20);
  });
  it("the normal load stays under the cap, so the cap only matters for retries and manual refreshes", async () => {
    const r = rig();
    r.poller.start();
    await r.clock.advance(300_000);
    const all = [...r.lightAt, ...r.heavyAt].sort((a, b) => a - b);
    for (let i = 0; i < all.length; i++) assert.ok(all.filter((t) => t >= all[i] && t < all[i] + 60_000).length <= 20);
    assert.equal(r.poller.getStatus().throttled, false);
    r.poller.stop();
  });
  it("a successful answer is passed on and the status says ok with the time of the answer", async () => {
    const r = rig();
    r.poller.start();
    await r.clock.advance(5_000);
    assert.deepEqual(r.accepted.light, [1, 2]);
    assert.deepEqual(r.accepted.heavy, [1]);
    const s = r.poller.getStatus();
    assert.equal(s.light.state, "ok");
    assert.equal(s.light.lastOkAt, r.t0 + 5_000);
    assert.equal(s.light.nextAt, r.t0 + 10_000);
    r.poller.stop();
  });
});

describe("SPY desk poller: no overlap", () => {
  it("a slow request is never joined by a second one on the same channel", async () => {
    const r = rig({ light: hang });
    r.poller.start();
    await r.clock.advance(14_000);
    assert.equal(r.lightAt.length, 1, "ticks at 5 s and 10 s are skipped while the first request is still open");
    assert.equal(r.live.maxLight, 1);
    r.poller.stop();
  });
  it("after the slow request times out (15 s) the channel carries on, still one at a time", async () => {
    const r = rig({ light: hang });
    r.poller.start();
    await r.clock.advance(120_000);
    assert.ok(r.lightAt.length >= 3);
    assert.equal(r.live.maxLight, 1);
    assert.equal(r.live.maxHeavy, 1);
    r.poller.stop();
  });
  it("a manual refresh while a request is open does not start a second one", async () => {
    const r = rig({ light: hang });
    r.poller.start();
    await r.clock.advance(1_000);
    r.poller.refreshNow("light");
    r.poller.refreshNow("both");
    await r.clock.advance(1_000);
    assert.equal(r.lightAt.length, 1);
    r.poller.stop();
  });
  it("a request that never answers is cut off after 15 s and counts as a failure, even if the fetch ignores the abort", async () => {
    const r = rig({ light: () => new Promise<PollResult<number>>(() => undefined) });
    r.poller.start();
    await r.clock.advance(14_999);
    assert.equal(r.poller.getStatus().light.failures, 0);
    await r.clock.advance(2);
    const s = r.poller.getStatus().light;
    assert.equal(s.failures, 1);
    assert.match(s.error ?? "", /timed out/);
    assert.equal(s.state, "error");
    r.poller.stop();
  });
});

describe("SPY desk poller: pause when the tab is hidden", () => {
  it("nothing is requested while hidden, the status says paused, and an open request is cancelled", async () => {
    const r = rig({ light: hang });
    r.poller.start();
    await r.clock.advance(1_000);
    assert.equal(r.live.light, 1);
    await r.clock.setHidden(true);
    assert.equal(r.live.light, 0, "the open request was aborted");
    const before = r.lightAt.length + r.heavyAt.length;
    await r.clock.advance(300_000);
    assert.equal(r.lightAt.length + r.heavyAt.length, before);
    const s = r.poller.getStatus();
    assert.equal(s.hidden, true);
    assert.equal(s.light.state, "paused");
    assert.equal(s.heavy.state, "paused");
    r.poller.stop();
  });
  it("starting while hidden asks for nothing; showing the tab asks at once", async () => {
    const r = rig();
    await r.clock.setHidden(true);
    r.poller.start();
    await r.clock.advance(60_000);
    assert.equal(r.lightAt.length + r.heavyAt.length, 0);
    await r.clock.setHidden(false);
    await r.clock.advance(0);
    assert.equal(r.lightAt.length, 1);
    assert.equal(r.heavyAt.length, 1);
    r.poller.stop();
  });
  it("coming back after a long absence refreshes both channels immediately", async () => {
    const r = rig();
    r.poller.start();
    await r.clock.advance(1_000);
    await r.clock.setHidden(true);
    await r.clock.advance(120_000);
    const l = r.lightAt.length;
    const h = r.heavyAt.length;
    await r.clock.setHidden(false);
    await r.clock.advance(0);
    assert.equal(r.lightAt.length, l + 1);
    assert.equal(r.heavyAt.length, h + 1);
    assert.equal(r.lightAt[l], 121_000);
    r.poller.stop();
  });
  it("a short absence keeps the cadence: no extra request, the next one is still due on time", async () => {
    const r = rig();
    r.poller.start();
    await r.clock.advance(1_000);
    await r.clock.setHidden(true);
    await r.clock.advance(1_000);
    await r.clock.setHidden(false);
    await r.clock.advance(0);
    assert.equal(r.lightAt.length, 1);
    await r.clock.advance(2_999);
    assert.equal(r.lightAt.length, 1);
    await r.clock.advance(2);
    assert.equal(r.lightAt.length, 2);
    assert.equal(r.lightAt[1], 5_000);
    r.poller.stop();
  });
});

describe("SPY desk poller: exponential backoff", () => {
  it("waits 10, 20, 40 s, then at most 60 s between tries after failures", async () => {
    const r = rig({ light: fail });
    r.poller.start();
    await r.clock.advance(400_000);
    assert.deepEqual(gaps(r.lightAt).slice(0, 6), [10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    r.poller.stop();
  });
  it("the heavy channel backs off on its own scale (90 s, then 120 s at most) without slowing the light channel", async () => {
    const r = rig({ heavy: fail });
    r.poller.start();
    await r.clock.advance(500_000);
    assert.deepEqual(gaps(r.heavyAt).slice(0, 4), [90_000, 120_000, 120_000, 120_000]);
    assert.deepEqual(new Set(gaps(r.lightAt)), new Set([5_000]));
    r.poller.stop();
  });
  it("one good answer resets the pace to 5 s and clears the error", async () => {
    let n = 0;
    const r = rig({ light: async (): Promise<PollResult<number>> => (++n <= 3 ? fail() : { ok: true, value: n }) });
    r.poller.start();
    await r.clock.advance(120_000);
    const g = gaps(r.lightAt);
    assert.deepEqual(g.slice(0, 3), [10_000, 20_000, 40_000]);
    assert.equal(g[3], 5_000);
    const s = r.poller.getStatus().light;
    assert.equal(s.failures, 0);
    assert.equal(s.error, null);
    r.poller.stop();
  });
  it("an answer the receiver rejects (malformed or old) counts as a failure and backs off", async () => {
    const r = rig({ reject: () => "The live data was not used." });
    r.poller.start();
    await r.clock.advance(35_000);
    assert.deepEqual(gaps(r.lightAt), [10_000, 20_000]);
    assert.equal(r.poller.getStatus().light.error, "The live data was not used.");
    assert.deepEqual(r.accepted.light, []);
    r.poller.stop();
  });
  it("a receiver that throws is a failure, not a crash", async () => {
    const clock = createFakeClock(0);
    const p = new SpyPoller<number, number>(clock.env, DEFAULT_POLLER_CONFIG, {
      fetchLight: async () => ({ ok: true, value: 1 }),
      fetchHeavy: async () => ({ ok: true, value: 1 }),
      onLight: () => {
        throw new Error("boom");
      },
      onHeavy: () => null,
      onStatus: () => {
        throw new Error("listener boom");
      },
    });
    p.start();
    await clock.advance(1_000);
    assert.equal(p.getStatus().light.failures, 1);
    p.stop();
  });
});

describe("SPY desk poller: request cap", () => {
  it("never sends more than the cap in any 60 s window, even with fast cadences and failing retries", async () => {
    const r = rig({ config: { light: { intervalMs: 500, maxBackoffMs: 500 }, heavy: { intervalMs: 500, maxBackoffMs: 500 }, maxPerMinute: 6 } });
    r.poller.start();
    await r.clock.advance(65_000);
    const all = [...r.lightAt, ...r.heavyAt].sort((a, b) => a - b);
    assert.ok(all.length >= 6);
    for (const t of all) assert.ok(all.filter((x) => x >= t && x < t + 60_000).length <= 6, `window starting ${t}`);
    assert.ok(all.length <= 13);
    r.poller.stop();
  });
  it("says so while the cap holds a refresh back, and recovers when slots free", async () => {
    const r = rig({ config: { light: { intervalMs: 500, maxBackoffMs: 500 }, heavy: { intervalMs: 500, maxBackoffMs: 500 }, maxPerMinute: 4 } });
    r.poller.start();
    await r.clock.advance(5_000);
    assert.equal(r.poller.getStatus().throttled, true);
    await r.clock.advance(60_000);
    assert.ok(r.lightAt.length + r.heavyAt.length > 4);
    r.poller.stop();
  });
  it("manual refreshes are counted against the cap too", async () => {
    const r = rig({ config: { maxPerMinute: 5 } });
    r.poller.start();
    await r.clock.advance(10);
    for (let i = 0; i < 20; i++) {
      r.poller.refreshNow("both");
      await r.clock.advance(100);
    }
    assert.ok(r.lightAt.length + r.heavyAt.length <= 5);
    r.poller.stop();
  });
});

describe("SPY desk poller: holds, invalidation and stop", () => {
  it("an answer that was in flight when a user action started is thrown away", async () => {
    let release: ((v: PollResult<number>) => void) | null = null;
    const r = rig({
      light: (n) => (n === 1 ? new Promise<PollResult<number>>((res) => (release = res)) : Promise.resolve({ ok: true, value: n })),
    });
    r.poller.start();
    await r.clock.advance(1_000);
    const done = r.poller.hold();
    release!({ ok: true, value: 111 });
    await r.clock.settle();
    assert.ok(!r.accepted.light.includes(111), "the old answer must not overwrite what the action changed");
    assert.equal(r.live.maxLight, 1);
    done();
    r.poller.stop();
  });
  it("no request starts during a hold; releasing it refreshes both channels at once; releasing twice is harmless", async () => {
    const r = rig();
    r.poller.start();
    await r.clock.advance(1_000);
    const done = r.poller.hold();
    const l = r.lightAt.length;
    const h = r.heavyAt.length;
    await r.clock.advance(60_000);
    assert.equal(r.lightAt.length, l);
    assert.equal(r.heavyAt.length, h);
    done();
    await r.clock.advance(0);
    assert.equal(r.lightAt.length, l + 1);
    assert.equal(r.heavyAt.length, h + 1);
    done();
    await r.clock.advance(0);
    assert.equal(r.lightAt.length, l + 1);
    r.poller.stop();
  });
  it("two overlapping holds refresh only when the last one ends", async () => {
    const r = rig();
    r.poller.start();
    await r.clock.advance(1_000);
    const a = r.poller.hold();
    const b = r.poller.hold();
    const l = r.lightAt.length;
    a();
    await r.clock.advance(0);
    assert.equal(r.lightAt.length, l);
    b();
    await r.clock.advance(0);
    assert.equal(r.lightAt.length, l + 1);
    r.poller.stop();
  });
  it("invalidate keeps polling alive (the cancelled channel is rescheduled)", async () => {
    const r = rig({ light: hang });
    r.poller.start();
    await r.clock.advance(1_000);
    r.poller.invalidate();
    await r.clock.advance(20_000);
    assert.ok(r.lightAt.length >= 2);
    r.poller.stop();
  });
  it("refreshNow asks right away, outside the cadence", async () => {
    const r = rig();
    r.poller.start();
    await r.clock.advance(1_000);
    r.poller.refreshNow("heavy");
    await r.clock.advance(0);
    assert.equal(r.heavyAt.length, 2);
    assert.equal(r.heavyAt[1], 1_000);
    r.poller.stop();
  });
  it("stop ends everything: no timers, no requests, no late answers", async () => {
    const r = rig({ light: hang });
    r.poller.start();
    await r.clock.advance(1_000);
    r.poller.stop();
    assert.equal(r.clock.pendingTimers(), 0);
    const n = r.lightAt.length + r.heavyAt.length;
    r.poller.refreshNow("both");
    await r.clock.advance(300_000);
    assert.equal(r.lightAt.length + r.heavyAt.length, n);
    assert.equal(r.poller.getStatus().light.state, "idle");
  });
  it("start twice does not double the polling", async () => {
    const r = rig();
    r.poller.start();
    r.poller.start();
    await r.clock.advance(20_000);
    assert.deepEqual(new Set(gaps(r.lightAt)), new Set([5_000]));
    r.poller.stop();
  });
});
