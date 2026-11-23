# Polarito

polarito.com is a **SPY-only, long-timeframe options desk**, driven by volume-weighted candle polarity (Drive +1, Neutral 0, Reverse -1). It is **dry run only**: it reads market data and keeps a small dry-run record. No code in this repository can send an order.

## Getting Started

```bash
cp .env.example .env.local
# Fill the Alpaca data keys and the Polarito login env (see below), then:
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Unauthenticated visitors are redirected to `/login`; after sign-in `/` redirects to `/spy`.

## Login gate

The app is closed until someone signs in. Credentials live in **server env only** (never `NEXT_PUBLIC_*`, never a default password in the repo):

| Variable | Purpose |
| --- | --- |
| `POLARITO_AUTH_USER` | Username |
| `POLARITO_AUTH_PASSWORD` | Password (choose a strong one yourself) |
| `POLARITO_AUTH_SECRET` | Cookie signing secret (`openssl rand -hex 32`, at least 16 chars) |

Fail-closed: if any of the three are missing, sign-in is refused and everything stays locked. `src/proxy.ts` gates every page and API route (the only exceptions are the two exact scheduler paths `/api/spy/auto-run` and `/api/spy-wwv/auto-run`, which refuse everything without the `CRON_SECRET` bearer). **Sign out** is the button at the top right of `/spy`; it clears the httpOnly `polarito_session` cookie.

## SPY desk (`/spy`)

Off unless the server has `POLARITO_SPY_DESK=1`. It shows the four period-to-date readings (monthly, quarterly, 6-month, yearly), the decision on the chosen timeframe, the contract the engine would pick (nearest listed expiry of at least 365 days, primary delta 0.80, floor 0.60, then the cheapest at or above the floor), a **manual dry-run ticket** (labelled MANUAL, guarded by the gear: see "Analyze and the gear" below), a manual Close and the **Auto practice trader** (below). Manual and automatic actions change only the saved dry-run record, and every trade record says AUTO or MANUAL.

| Piece | Where |
| --- | --- |
| Page and routes | `src/app/spy/page.tsx`, `src/app/api/spy/{desk,live,analyze,ticket,close,auto,auto-run}` (`live` and `analyze` are GET-only reads; POST routes are same-origin only; `auto-run` is the only cookie-free path and needs the `CRON_SECRET` bearer) |
| Engine, chain, desk logic | `src/lib/spy*.ts`, `src/lib/optionsSelect.ts`, `src/lib/longPolarity.ts`, `src/lib/polarity.ts` |
| Read-only Alpaca client | `src/lib/alpacaReadOnly.ts` (GET allowlist: account, option contracts, latest trade, option snapshots, bars) |
| Dry-run record | Redis-over-HTTPS (Upstash / Vercel KV): `KV_REST_API_URL`, `KV_REST_API_TOKEN`. Without it the readings show and the manual actions say they are off. `SPY_DESK_STORE=memory` is for local development only and is refused in production. |

### Live refresh (every 5 s) and Analyze

The page keeps itself current with GET requests only; a refresh never submits anything and never resets what you chose (Call/Put, contract row, ticked boxes, an open Close box all stay).

- **Light refresh, every 5 s** (`GET /api/spy/live`): saved position and its live P&L (the held contract's bid against the entry ask), Auto switch and audit log, journal, the four readings and the decision, the SPY price. It reads the saved record, one daily-bars call (cached 15 s on the server), the SPY price (cached 2 s) and at most the one held contract (cached 2 s). It cannot read the option chain.
- **Full refresh, every 45 s or on demand** (`GET /api/spy/desk`, the Refresh button, or once when the reading/position changes): the option chain (125+ quotes) behind the contract preview and the ticket lists. Alpaca's free plan is rate limited, so the chain is never polled at 5 s.
- Guards: one request per channel at a time, nothing while the tab is hidden (an immediate refresh when you come back), exponential backoff after errors (light 10, 20, 40, then 60 s at most; full 90 s, then 120 s at most), at most 20 requests per minute from one page (about 13 in normal use), a 15 s timeout per request, and answers started before one of your own actions are thrown away.
- The page shows `updated HH:MM:SS`. If a refresh fails, or the data on screen is older than 15 s, it says so in red and dims the data (STALE); a malformed, too-old, future-dated or out-of-order answer is rejected, never shown as fresh.
- Code: `src/lib/spyPoller.ts` (timing, pure), `src/lib/spyDeskData.ts` (checks and merge), `src/lib/spyDeskClient.ts` (GET helper), `src/lib/spyLive.ts`, `src/lib/spyTtlCache.ts`; tests `tests/spy-poller.test.ts` and `tests/spy-refresh.test.ts` use a fake clock.

### Analyze and the gear

The manual ticket has a read-only Ticker (SPY) and an **Analyze** button: it loads the daily bars and the monthly gear (`GET /api/spy/analyze?ticker=SPY`) and shows Drive, Neutral or Reverse with the monthly net volume and the as-of time. The ticket stays disabled until Analyze has succeeded.

- Drive allows only a Call (Put blocked), Reverse allows only a Put (Call blocked), Neutral allows both. The check shows the moment Call or Put is toggled.
- The server checks again in `POST /api/spy/ticket`: it recomputes the gear itself and refuses a counter-polarity ticket (`COUNTER_POLARITY`), a gear that moved since Analyze (`GEAR_CHANGED`), and stale or missing bars (`DATA_UNAVAILABLE`), before it reads the chain. Nothing is trusted from the browser.
- If the gear changes under the 5 s refresh the page warns, blocks the ticket, clears the acknowledgement, loads the gear again once and re-checks the selected side. Close is never gated by the gear.
- Code: `src/lib/spyGear.ts` (the rule, shared), `src/lib/spyAnalysis.ts`, `src/lib/spyAnalyzer.ts`; tests `tests/spy-gear.test.ts`.

### Auto practice trader (default OFF)

Switch it on or off with the Auto card on `/spy` (stored in the same KV store; no key or an unreadable value means OFF). Vercel Cron (`vercel.json`) calls `GET /api/spy/auto-run` at 21:30 UTC on weekdays, with a 22:30 UTC retry (always after 16:15 ET, summer and winter). The route needs `Authorization: Bearer $CRON_SECRET`; **you set `CRON_SECRET` yourself** in Vercel, Project, Settings, Environment Variables, Production (at least 32 characters, e.g. `openssl rand -hex 32`); Vercel Cron then sends it automatically. Unset or short means the route refuses everything. Append `?dry=1` to see what a run would do without saving anything.

Rules: no position and Drive opens the call chosen by the contract rules, Reverse opens a put, Neutral does nothing (you decide). If Auto holds a position and the reading turns opposite it closes at the re-fetched bid and opens the other side in the same run if the rules allow. Neutral while holding leaves the position and `/spy` shows a banner. A MANUAL position is never touched by Auto, and a manual action today makes Auto stand aside for the session. Stale, crossed or missing data, or unavailable polarity: refuse and log. Every decision, including "no action" and why, is in the audit log on `/spy`. One lock around every run (manual actions use it too), settled sessions are not run twice. Details and defaults: `docs/spy-monthly-options-plan.md`.

Settings: `SPY_DECISION_TIMEFRAME` (M, Q, H, Y; default M), `SPY_LIVE_BUDGET`, `SPY_STOCK_FEED`, `SPY_OPTIONS_FEED`. Data keys are `ALPACA_LIVE_KEY_ID` / `ALPACA_LIVE_SECRET_KEY` or `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` (read-only use).

Two manual GitHub workflows run the same code without the website (no schedule, GET only, keys never printed): `SPY options chain (read-only)` and `SPY options dry run (no orders)` (`scripts/spy-options-chain.ts`, `scripts/spy-options-engine.ts`).

## SPY DESK WWV (`/spy-wwv`)

A second, separate desk beside `/spy`. Same page, same rules, same practice-only guard rails; the only difference is the **decision source**: the **daily timeframe Weis Wave Volume (WWV), setting fixed at 1**, instead of the period readings. Page title and labels say **SPY DESK WWV** and show the timeframe (**Daily, WWV**). Same session login and the same `POLARITO_SPY_DESK=1` flag. Nothing new to set in Vercel.

| What | Detail |
| --- | --- |
| Page and routes | `src/app/spy-wwv/page.tsx`, `src/app/api/spy-wwv/{desk,live,analyze,ticket,close,auto,auto-run}` (the same route code as `/spy`, selected by a desk profile) |
| Decision source | `src/lib/wwv.ts` (pure, tested in `tests/wwv.test.ts`) |
| Desk profile | `src/lib/spyProfile.ts`: labels, API base, key prefix, the decision timeframe. Both desks run the same engine, desk, auto and route modules; the profile is the only thing that differs. |
| Cron | `vercel.json`: `/api/spy-wwv/auto-run` at 21:30 UTC on weekdays with a 22:30 UTC retry (same pattern as `/api/spy/auto-run`; always after 16:15 ET). Bearer `CRON_SECRET` (the same secret), exact-path bypass in `src/proxy.ts`. Four crons in total, so the Vercel plan must allow that many. |

**Fully isolated from `/spy`:** own practice position and journal (`polarito:spy-wwv:desk:v1`), own Auto switch (**default OFF**), own audit log and own run lock (`polarito:spy-wwv:auto-*:v1`). Every key goes through `scopeKey`, so the two desks can never read, write or lock each other's state; tests prove no key is shared and that a WWV run writes nothing under the monthly prefix.

### How the daily WWV reading is defined

- **Bars:** daily SPY SIP bars (about 200 calendar days). Direction of a bar: **close above the previous close = up, below = down, equal = it continues the wave that is running** (an equal close never starts or ends a wave). The gap between the previous close and the open does not matter. The first loaded bar has no direction.
- **Waves:** a wave is a run of same-direction bars. Wave volume is the sum of the bars' volume in the wave and **restarts at each turn; the turning bar belongs to the NEW wave** (standard Weis). Example: closes 10, 11, 12, 11, 10 with volumes 1, 2, 3, 4, 5 give an up wave of 5 (bars 2 and 3) and a down wave of 9 (bars 4 and 5).
- **Reading:** counts only when the **latest daily candle colour** (close vs open) and the **current wave direction** agree: green candle + up wave = **Drive** (call only), red candle + down wave = **Reverse** (put only); anything else, including a flat candle, is **Neutral** (the trader decides manually).
- **Shown on the page:** current wave direction, wave volume so far, previous wave volume, candle colour, the bar date and the as-of time. The previous wave is context only; if it cannot be trusted it says why and does not block the reading.
- **Which bar:** the newest bar must be the session expected right now (the same stale test as `/spy`). During the session that bar is still **in progress** (its close is the last price, the reading can flip until 16:00 ET and the page says so). After the close it is final. The auto run only acts from 16:15 ET, so it always reads a final bar.
- **Never a guess:** malformed bars, a stale or missing newest bar, a missing session inside the current wave (or the bar before it), a zero or missing volume inside the current wave, or no wave at all (every close equal) make the reading **Data unavailable** with the reason; nothing is traded or recorded on it.

Everything else is identical to `/spy`: SPY options only, nearest listed expiry of at least 365 days, delta 0.80 or better else the cheapest usable |delta| of at least 0.60 flagged FALLBACK DELTA, calls on Drive and puts on Reverse, practice only (entry at the ask, close at the bid, 1 contract), manual open and close, the Analyze guard with the server re-check, the 5 s refresh with the same cadences, auto open/close with idempotency, KV lock and audit log. No order code (`tests/no-order-code.test.ts` still passes).

## No order code, live switches kept off

After the cleanup the Alpaca adapter (`src/lib/broker/alpacaPaper.ts`) has no method that creates, changes or cancels an order: it sends only `GET`, and tests (`tests/no-order-code.test.ts`, plus the SPY engine and desk tests) fail if an order function, a non-GET Alpaca call or a new POST appears.

The old live-cash switches are kept, inert, so a future live SPY options executor starts from fail-closed settings. Nothing reads them to send an order today.

| Variable | Behaviour |
| --- | --- |
| `POLARITO_LIVE_ACCOUNT=1` | Opt in to the live account (live keys, live host). Read-only on its own. Exactly `"1"`, anything else is OFF. |
| `POLARITO_LIVE_TRADING_ENABLED=1` | Would allow real orders. Exactly `"1"`, anything else is OFF. Leave it unset. The SPY engine and desk never read it (a test proves it). |
| `POLARITO_BROKER_KILL` | Shared kill switch; any value other than empty/0/false/no/off kills. |
| Live Auto (`POST /api/broker/live/auto`) | Persisted on/off in the KV store, **OFF by default**. Turning it ON needs the live opt-in and a store; turning it OFF is refused unless the live account is flat with no working orders (checked against Alpaca, fails closed). It sends no order and nothing consumes it today. |

Code: `src/lib/broker/liveConfig.ts`, `src/lib/broker/config.ts`, `src/lib/liveAutoStore.ts`, `src/lib/liveAutoGuard.ts`.

## Alpaca key diagnostic (`GET /api/diag/alpaca-keys`)

When the data says "Alpaca rejected the API key ID/secret", sign in and open `/api/diag/alpaca-keys` in the address bar. It is read-only, behind the login gate and refuses cross-site requests. It never returns a secret or a full key ID and places no order. For each key pair the app knows it reports presence, the first two characters and length of the key ID (AK = live, PK = paper), the secret length, flags for whitespace, quotes, newlines, non-ASCII, swapped values and unusual lengths, makes one real read call per pair, and returns the HTTP status and Alpaca's message plus the deployment (`VERCEL_ENV`, short commit SHA) and plain-language hints.

## Scripts

- `npm run dev` / `npm run build` / `npm start`: the Node app
- `npm test`: unit tests (SPY engine, chain, desk, polarity, auth, live switches, no-order checks)
- `npm run lint`

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
