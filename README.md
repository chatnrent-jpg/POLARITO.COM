# Polarito

Next.js polarity transmission dashboard (Alpaca daily bars). Local / Node hosting uses a login gate; Name.com static export still uses the PHP bars bridge.

## Getting Started

```bash
cp .env.example .env.local
# Fill Alpaca keys + Polarito login env (see below), then:
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Unauthenticated visitors are redirected to `/login`.

## Login gate (local / Node / Vercel)

The app is closed until someone signs in. Credentials live in **server env only** (never `NEXT_PUBLIC_*`, never a default password in the repo):

| Variable | Purpose |
| --- | --- |
| `POLARITO_AUTH_USER` | Username |
| `POLARITO_AUTH_PASSWORD` | Password (choose a strong one yourself) |
| `POLARITO_AUTH_SECRET` | Cookie signing secret (`openssl rand -hex 32`, ≥16 chars) |

Fail-closed: if any of the three are missing, sign-in is refused and the dashboard stays locked.

After a successful login, `src/components/PageRefresher.tsx` full-reloads the home page every **5 seconds**. Sign out clears the httpOnly `polarito_session` cookie.

This gate runs in `src/proxy.ts` for `next dev` / `next start` / Node hosts. The Name.com static HTML export has no Node runtime; protect that host separately (or run Node) if you need the same gate there.

## Auto simulation

The **Auto · Simulated** panel has two controls: on/off and shares. The paper position follows the polarity of the analyzed ticker: +1 = long, 0 = flat, -1 = short, filled at the latest bar's close with no added cost. Manual Review / Close still work.

Underneath, two plain protections remain: it never buys more than the account's available cash, and new entries pause after a 2% daily loss (closes are never blocked). Stale or malformed data is never traded. The richer options (risk-based sizing, next-open fills, slippage) still exist in the code for the server runner but are not on the page.

## Alpaca paper trading (server side)

`src/lib/broker/` holds a paper-only broker adapter and an order executor; `src/lib/paperRunner.ts` is the scheduled cycle that drives them. Set the `ALPACA_PAPER_*`, `POLARITO_*` and `CRON_SECRET` variables from `.env.example`.

- **Status.** Sign in and open `/api/broker/paper/status` (read-only) to check the connection.
- **Schedule.** `vercel.json` calls `/api/cron/paper-run` on weekdays at 21:30 UTC (after the close, in both EST and EDT). The route skips the browser login gate and instead requires `Authorization: Bearer $CRON_SECRET`; with no secret set it refuses everyone.
- **Observe until switched on.** With credentials set but `POLARITO_PAPER_TRADING_ENABLED` not `1`, every scheduled run only observes: it decides and logs what it would do and sends nothing. The kill switch and missing credentials still stop it completely.
- **Dry run.** `GET /api/cron/paper-run?dry=1` (with the bearer header) computes and audits every decision but sends no order. It works with credentials alone, before you enable trading.
- **What a cycle does.** Per ticker in `POLARITO_PAPER_WATCHLIST` (max 5): load daily bars, drop any bar still forming (New York time), compute polarity, make the same decision as the browser sim, then send at most one DAY market order that queues for the next open. Equity, cash and positions come from the Alpaca paper account, not the browser.
- **Risk.** Same risk guard as the sim, with the daily loss/profit boundary taken from the broker's equity vs. last close. Entries across tickers in one cycle are tracked so they cannot oversubscribe the account. Closes are never blocked.
- **Known limits.** Losing-streak scale-down is not applied on the server (it needs closed-trade history). A flip closes first and re-enters at the next session once the broker confirms flat. Positions in tickers outside the watchlist count toward exposure but are never managed.

Safety properties: hard-coded paper host; orders need `POLARITO_PAPER_TRADING_ENABLED=1` and an off kill switch; deterministic client order ids make retries idempotent; positions are reconciled against the broker before any order; closes flatten the broker's actual quantity; every error path returns a result instead of throwing, and credentials never appear in errors.

## Audit log (server only)

The scheduled runner writes one structured JSON line per decision to the server log (`{"audit":{...}}`), searchable in Vercel logs, and returns the same records in its response. Records only contain whitelisted, length-capped fields, so credentials never appear.

## Scripts

- `npm run test` — unit tests (including session auth)
- `npm run build` / `npm start` — production Node app
- `npm run package:namecom` — static `/out` + PHP bars bridge

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
