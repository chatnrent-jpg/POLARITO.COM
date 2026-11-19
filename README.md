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

## Auto simulation and risk guard

The **Auto · Simulated** panel enters and closes the analyzed ticker in the paper ledger using the same polarity gate as manual orders. It is on by default and can be turned off.

- **Fill model.** *Next open* (default) acts on the last completed bar and fills at the following bar's open, with 0.05% slippage per side. *Signal-day close* is the legacy behavior.
- **Sizing.** Fixed shares, or risk-based (percent of equity risked per trade against an assumed 3% stop).
- **Risk guard (always on, `src/lib/risk.ts`).** New entries halt after a 2% daily realized loss and lock after a 4% daily gain. Size halves after each straight loss from the second on. One position is capped at 25% of equity, total exposure at 100%, and never above available cash. Closes are never blocked. Stale (older than 5 days) or malformed data is never traded.

## Alpaca paper trading (server side, no orders are placed automatically yet)

`src/lib/broker/` holds a paper-only broker adapter and an order executor. Nothing calls the executor from the app yet; it is the foundation for a scheduled runner. Set the `ALPACA_PAPER_*` and `POLARITO_*` variables from `.env.example`, then sign in and open `/api/broker/paper/status` to check the connection (read-only).

Safety properties: hard-coded paper host; orders need `POLARITO_PAPER_TRADING_ENABLED=1` and an off kill switch; deterministic client order ids make retries idempotent; positions are reconciled against the broker before any order; closes flatten the broker's actual quantity; every error path returns a result instead of throwing, and credentials never appear in errors.

## Scripts

- `npm run test` — unit tests (including session auth)
- `npm run build` / `npm start` — production Node app
- `npm run package:namecom` — static `/out` + PHP bars bridge

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
