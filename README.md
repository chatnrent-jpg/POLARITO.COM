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

Fail-closed: if any of the three are missing, sign-in is refused and everything stays locked. `src/proxy.ts` gates every page and API route (the one exception is `/api/spy/auto-run`, which refuses everything without the `CRON_SECRET` bearer). **Sign out** is the button at the top right of `/spy`; it clears the httpOnly `polarito_session` cookie.

## SPY desk (`/spy`)

Off unless the server has `POLARITO_SPY_DESK=1`. It shows the four period-to-date readings (monthly, quarterly, 6-month, yearly), the decision on the chosen timeframe, the contract the engine would pick (nearest listed expiry of at least 365 days, primary delta 0.80, floor 0.60, then the cheapest at or above the floor), a **manual dry-run ticket** (any reading, labelled MANUAL), a manual Close and the **Auto practice trader** (below). Manual and automatic actions change only the saved dry-run record, and every trade record says AUTO or MANUAL.

| Piece | Where |
| --- | --- |
| Page and routes | `src/app/spy/page.tsx`, `src/app/api/spy/{desk,ticket,close,auto,auto-run}` (POST routes are same-origin only; `auto-run` is the only cookie-free path and needs the `CRON_SECRET` bearer) |
| Engine, chain, desk logic | `src/lib/spy*.ts`, `src/lib/optionsSelect.ts`, `src/lib/longPolarity.ts`, `src/lib/polarity.ts` |
| Read-only Alpaca client | `src/lib/alpacaReadOnly.ts` (GET allowlist: account, option contracts, latest trade, option snapshots, bars) |
| Dry-run record | Redis-over-HTTPS (Upstash / Vercel KV): `KV_REST_API_URL`, `KV_REST_API_TOKEN`. Without it the readings show and the manual actions say they are off. `SPY_DESK_STORE=memory` is for local development only and is refused in production. |

### Auto practice trader (default OFF)

Switch it on or off with the Auto card on `/spy` (stored in the same KV store; no key or an unreadable value means OFF). Vercel Cron (`vercel.json`) calls `GET /api/spy/auto-run` at 21:30 UTC on weekdays, with a 22:30 UTC retry (always after 16:15 ET, summer and winter). The route needs `Authorization: Bearer $CRON_SECRET`; **you set `CRON_SECRET` yourself** in Vercel, Project, Settings, Environment Variables, Production (at least 32 characters, e.g. `openssl rand -hex 32`); Vercel Cron then sends it automatically. Unset or short means the route refuses everything. Append `?dry=1` to see what a run would do without saving anything.

Rules: no position and Drive opens the call chosen by the contract rules, Reverse opens a put, Neutral does nothing (you decide). If Auto holds a position and the reading turns opposite it closes at the re-fetched bid and opens the other side in the same run if the rules allow. Neutral while holding leaves the position and `/spy` shows a banner. A MANUAL position is never touched by Auto, and a manual action today makes Auto stand aside for the session. Stale, crossed or missing data, or unavailable polarity: refuse and log. Every decision, including "no action" and why, is in the audit log on `/spy`. One lock around every run (manual actions use it too), settled sessions are not run twice. Details and defaults: `docs/spy-monthly-options-plan.md`.

Settings: `SPY_DECISION_TIMEFRAME` (M, Q, H, Y; default M), `SPY_LIVE_BUDGET`, `SPY_STOCK_FEED`, `SPY_OPTIONS_FEED`. Data keys are `ALPACA_LIVE_KEY_ID` / `ALPACA_LIVE_SECRET_KEY` or `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` (read-only use).

Two manual GitHub workflows run the same code without the website (no schedule, GET only, keys never printed): `SPY options chain (read-only)` and `SPY options dry run (no orders)` (`scripts/spy-options-chain.ts`, `scripts/spy-options-engine.ts`).

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
