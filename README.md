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
- **What a cycle does.** Per ticker in `POLARITO_PAPER_WATCHLIST` (max 10): load daily bars, drop any bar still forming (New York time), compute polarity, make the same decision as the browser sim, then send at most one DAY market order that queues for the next open. Equity, cash and positions come from the Alpaca paper account, not the browser.
- **Risk.** Same risk guard as the sim, with the daily loss/profit boundary taken from the broker's equity vs. last close. Entries across tickers in one cycle are tracked so they cannot oversubscribe the account. Closes are never blocked.
- **Known limits.** Losing-streak scale-down is not applied on the server (it needs closed-trade history). A flip closes first and re-enters at the next session once the broker confirms flat. Positions in tickers outside the watchlist count toward exposure but are never managed.

### Options mode (paper)

Set `POLARITO_PAPER_INSTRUMENT=options` to run `src/lib/optionsRunner.ts` instead of the stock cycle. Per ticker, at most one option at a time:

- **+1 Drive** buys a call, **-1 Reverse** buys a put, **0 / unready / stale data** holds nothing. The executor re-checks this from the contract's own OCC symbol, so no other entry can be sent.
- Entries use the nearest expiry at least 365 days out and the strike closest to the last close, as a DAY limit order at the ask (rounded up to the 5-cent tick). Entries are refused when the quote is missing, stale or crossed, when the bid/ask gap is over 15% of the price, when one position would cost over 10% of equity, or when the premium exceeds available cash.
- **Daily loss stop.** If the account is down 1% or more on the day (`POLARITO_OPTIONS_DAILY_LOSS_PCT`, default 1, allowed 0.25-10; a bad value falls back to 1), every option is sold to close and nothing is bought; an option closed that day is not bought back until the next session. The after-close run checks this, and `/api/cron/loss-check` checks it during the session. That route reads no signal and buys nothing. `.github/workflows/loss-check.yml` calls it every 30 minutes on weekdays and needs one repository secret, `POLARITO_CRON_SECRET`, with the same value as `CRON_SECRET` in Vercel. It does nothing outside 09:30-16:00 New York.
- Exits are sell-to-close: on Neutral, on a flip (the new option is bought next session once flat is confirmed), or when the option is within 60 days of expiry. They use a limit at the bid, or a market order when no usable quote exists. Closes are never blocked by risk limits.
- The loss on a bought option is limited to the premium. `POLARITO_OPTIONS_CONTRACTS` sets contracts per entry (default 1, max 10).
- Contracts come live from Alpaca's contract list; quotes use Alpaca's indicative option feed. The paper account must have options trading enabled.
- Polarity is read once per weekday after the close, so polarity exits and entries happen at that check. Only the 1% loss stop runs during the session.
- Plain stock positions are never touched in this mode. Close any leftover stock orders or positions in the watchlist first.

### Live mirror mode (paper)

Set `POLARITO_PAPER_INSTRUMENT=mirror` to make the Alpaca paper account move in lockstep with POLARITO's SPY signal. This is the same idea as the dashboard's Auto sim, run on the server because the sim itself lives in the browser's localStorage.

- **Same code, no extras.** `src/lib/mirrorRunner.ts` imports `computePolaritySeries`, `buildAutoSimInput` and `decideAuto` and runs them exactly as the dashboard does: live bars including today's forming bar, `signal-close`, fixed shares. It adds no delay, confirmation, hold or filter. A flip closes and enters the other side in the same tick; Neutral closes; an aligned position is left alone.
- **Instrument.** Only plain SPY shares. Option positions are never touched. Options mode is still available (`POLARITO_PAPER_INSTRUMENT=options`) and is off while mirror is on; the daily after-close run does nothing in mirror mode.
- **Size and rails.** `POLARITO_MIRROR_QTY` shares (default 10, like the dashboard), never above `POLARITO_MIRROR_MAX_SHARES` (default 100). The shared risk caps from `risk.ts` still apply. If the account is down `POLARITO_MIRROR_DAILY_LOSS_PCT` (default 2%) on the day, SPY is flattened and the mirror stands aside until the next session. Orders are sent only 09:30-16:00 New York, never on a bar that is not today's, and never while an SPY order is still working. `POLARITO_PAPER_TRADING_ENABLED=1` and the kill switch work as before; until enabled, every tick only observes and audits. The loss check counts the whole paper account, so leftover option positions can trip it.
- **Ticks.** `GET /api/cron/mirror-run` (Bearer `CRON_SECRET`) runs one tick; `?ticks=N` (max 12) runs N ticks 5s apart, the dashboard's refresh rate. `?dry=1` decides and audits without sending orders.
- **Trigger.** Vercel Hobby only allows daily crons, and a per-minute entry in `vercel.json` would fail a Hobby deploy, so none is added. Vercel Pro can run a cron every minute. Here `.github/workflows/mirror-run.yml` starts before the open and loops inside the job, calling the endpoint every 10s until just after the close (it reads the New York clock, so daylight saving needs no change). It stops after 5.5h and starts the next run itself, because a job is limited to 6h; a concurrency group keeps runs from overlapping. Add the repository secret `POLARITO_CRON_SECRET` (same value as `CRON_SECRET` in Vercel) and, optionally, the repository variable `POLARITO_BASE_URL` (default `https://www.polarito.com`). Start it by hand from the Actions tab (Run workflow).
- **Cost.** Free on a public repository. On a private one it uses about 400 Actions minutes per trading day (about 8,400 a month) against 2,000 (Free) or 3,000 (Pro) included, roughly $50-65 a month at $0.008/min.

Safety properties: hard-coded paper host (the live host is reachable only through the opt-in live path below); orders need `POLARITO_PAPER_TRADING_ENABLED=1` and an off kill switch; deterministic client order ids make retries idempotent; positions are reconciled against the broker before any order; closes flatten the broker's actual quantity; every error path returns a result instead of throwing, and credentials never appear in errors.

## Live cash trading (real money, shipped OFF)

One stock a day from a 10-name watchlist, on a real Alpaca account (decided: $1,000 account, 50% per-position cap, long-only at this size, 1% daily account stop, no re-entry after a stop-out). Everything is off until you set the variables in `.env.example` under "LIVE CASH". **With none of them set the app behaves exactly as before** (paper, options, mirror, cron, UI, Daily candle): the live keys are never read, the live host is never contacted, and the page renders no live panel. The polarity engine, Daily candle logic and the browser sim are untouched; the live code only calls them.

### The two switches and the keys

| Variable | Effect |
| --- | --- |
| `ALPACA_LIVE_KEY_ID`, `ALPACA_LIVE_SECRET_KEY` | Live keys. Separate from `ALPACA_PAPER_*`, which are never used for live (and these are never used for paper). |
| `POLARITO_LIVE_ACCOUNT=1` | Switch 1. Uses the live keys and `https://api.alpaca.markets`. Read-only on its own: the pick observes and audits, the site shows the live account. |
| `POLARITO_LIVE_TRADING_ENABLED=1` | Switch 2. Allows real orders. `POLARITO_BROKER_KILL` (shared) still stops everything. `POLARITO_PAPER_TRADING_ENABLED` has no effect on live. |
| `POLARITO_PAPER_INSTRUMENT=pick` | Selects the pick runner. This is the deployment-wide instrument switch, so the daily paper/options/mirror runs do nothing on that deployment (use a second Vercel project if you want paper options to keep running). |

Sizing and rail variables (`POLARITO_LIVE_WATCHLIST`, `_QTY`, `_MAX_POSITION_PCT`, `_DAILY_LOSS_PCT`, `_PICK_START`, `_FLATTEN_AT`, `_LONG_ONLY_FALLBACK`) are documented in `.env.example`. The live watchlist is its own variable; `POLARITO_PAPER_WATCHLIST` is never used for live.

### How a day works (`src/lib/pickRunner.ts`)

- **Loop.** `.github/workflows/pick-run.yml` calls `GET /api/cron/pick-run` about every 10s (same loop as the mirror; it exits at once while live is off). Each tick reads the live account, positions, working orders and today's orders, derives the day's state from those orders (no database), and re-checks everything before any order.
- **Pick.** Before the first entry, each tick ranks the watchlist by `|netVolume| / noiseFloor` of the latest bar (how far the reading sits outside the Neutral band; Neutral scores 0) and takes the first eligible name, logging one line for every name it skipped and why. Eligible: bars ready and today's, not Neutral, side allowed, asset active and tradable (a short also needs `shortable` and an easy-to-borrow `borrow_status`), and at least one share under the cap and cash. A name that rounds to zero shares (price over half of equity, for example) is skipped to the next.
- **GOOGL and GOOG are one company.** They are collapsed into one candidate (ranked by the better of the two). The more liquid class (20-day dollar volume, then alphabetical so `GOOG` before `GOOGL`) is tried first, the other class second if the first fails; one day only ever holds one of them.
- **One stock a day.** Once the first entry exists (`e01`), the day is locked to that stock; later re-entries are for it only, even if another stock now reads stronger.
- **Long only below $2,000.** Alpaca does not allow shorting under $2,000 of equity, so a Reverse reading is not tradable at $1,000. The short path exists and is gated on equity of at least $2,000, `shorting_enabled` on the account, and the asset checks above. If the top-ranked reading is a Reverse that cannot be traded, the default is to stand aside for the day (`POLARITO_LIVE_LONG_ONLY_FALLBACK=aside`); set `next` to take the next eligible Drive stock instead.
- **Cap.** Entry size is `POLARITO_LIVE_QTY` shares (default 1) reduced by the shared risk engine (`src/lib/risk.ts`) with a 50% per-position cap on current equity, 100% total exposure and available cash. Only the live path passes this cap; the browser sim stays at 25%.
- **Re-entry has no count limit.** There is no cap on entries per day. After a close (by the automation or by hand) the stock is re-entered whenever its polarity reading is aligned again, exactly as the dashboard sim does, and not otherwise. Only a stop-out, the end-of-day flatten or the 3-attempt close circuit breaker (below) stop it, and so does Auto OFF. A rejected entry does not block anything: the next tick tries again under the next entry number. If Alpaca keeps rejecting entries for a reason that does not go away (for example buying power), that retry repeats every tick (about 10 seconds), so watch the logs and turn Auto OFF or set the kill switch; the Alpaca order ids then run to `e12`, `e13` and so on.
- **Follow the signal.** A held stock follows its own polarity like the dashboard sim: Neutral closes, a flip closes then enters the other side of the same stock (waiting for the close to fill).
- **1% stop.** Each tick, if the account is down 1% on the day (equity vs `last_equity`) the managed stock is flattened with a stop-out order and nothing is entered for the rest of the day, by the automation or by hand. A manual close at a loss counts: if it puts the day at -1% or worse the automation stays out; a smaller loss still allows re-entry. A stop does not limit gap losses (a 10% gap on one share of a $300 stock is about $30).
- **End of day.** At 15:55 New York (`POLARITO_LIVE_FLATTEN_AT`; `off` holds overnight) the managed stock is flattened and entries stop. 
- **Auto is the on/off for everything signal-driven** (next section; it can be turned OFF only when the account is flat with no working orders). With Auto OFF the runner places no entries, no re-entries, no Neutral closes and no flip closes; it only logs "Would ...". Still running with Auto OFF: the 1% stop-out, the end-of-day flatten, the loss-check backstop and the manual Close button.
- **Backstop.** The existing `loss-check.yml` (every 30 minutes) calls `/api/cron/loss-check`; in pick mode that route runs only the stop-out and end-of-day flatten (no signal, no entry), in case the 10s loop is not running.
- **Only watchlist stocks are managed.** Other positions (and option positions) are never touched; they count toward exposure and cash.

### Order ids (idempotent; Alpaca never reuses a `client_order_id`)

| Order | Id |
| --- | --- |
| Entry number N | `pol-{YYYYMMDD}-e{NN}-{TICKER}` e.g. `pol-20261120-e02-NVDA` |
| Close of entry N, attempt K (auto and manual share it) | `pol-{YYYYMMDD}-c{NN}-a{K}-{TICKER}` |
| Stop-out flatten, attempt K (also the "stopped today" marker) | `pol-{YYYYMMDD}-s{NN}-a{K}-{TICKER}` |

A retry or a parallel run computes the same id, so a double click, the automation and a stop-out cannot sell the same position twice. A duplicate-id refusal (HTTP 422) is treated as "already placed" only after the order is found by its id; otherwise it is an error. A close that ended canceled or rejected moves to the next attempt number; after 3 failed attempts a circuit breaker stops automatic tries and new entries and logs an error (close it in Alpaca's own dashboard). A position held overnight is closed under `c00`.

### Live Auto: a real on/off on polarito.com

The live panel has a **Live Auto** control (`POST /api/broker/live/auto`, behind the same login gate as Close, same-origin only, and only when `POLARITO_LIVE_ACCOUNT=1`). It defaults to **OFF at deploy** and is the single switch for the automation's signal-driven orders.

| Auto OFF (default) | Auto ON |
| --- | --- |
| No entries, no re-entries, no Neutral or flip closes. Each tick only logs "Would ..." plus "Live Auto is OFF". | The runner enters, closes and re-enters by polarity as described above (only while `POLARITO_LIVE_TRADING_ENABLED=1` and the kill switch is off). |
| **Still runs:** the 1% daily stop-out, the 15:55 end-of-day flatten, the 30-minute loss-check backstop, and the manual **Close** button. | Same backstops. |

**Auto can only be turned OFF when the account is flat with no working orders (option B plus Henry's order rule).** `POST /api/broker/live/auto` with `{"auto": false}` asks Alpaca for the live positions and the open orders first, on the server, so the rule holds for any caller and not only the button:

- **Any open position refuses OFF** (HTTP 409, `POSITIONS_OPEN`, "Close all positions first"). Every position counts: a stock off the watchlist or an option position blocks it too, because nothing may be left open without the signal-driven exits.
- **Any working (unfilled) order refuses OFF** (HTTP 409, `ORDERS_OPEN`, "Cancel or let working orders finish first"). This is every order Alpaca lists as open (`status=open`: new, accepted, partially filled, pending and so on), whatever its ticker or who placed it. If a position and an order are both open the answer is `POSITIONS_OPEN` and the message gives both counts.
- **Never auto-cancels.** The app does not cancel, replace or send any order for this: wait for the order to fill or expire, or cancel it yourself in Alpaca, then try again.
- **Unreadable positions or orders refuse OFF** (HTTP 502, `POSITIONS_UNREADABLE` / `ORDERS_UNREADABLE`; no live keys is 503 `NO_BROKER`; a malformed list counts as unreadable). Auto stays as it was and the error is shown. It fails closed.
- **Race guard.** After writing OFF the server reads positions and orders again; if a position or order appeared in that instant it writes ON back and refuses (the answer says whether ON was confirmed).
- **Turning ON** needs no Alpaca call and works with positions or orders open. While Auto is ON and positions are open, nothing changes.
- **Panel.** The "Turn Auto OFF" button is disabled while Auto is ON and anything is open, with the message "Close all positions first (N open at Alpaca)" and/or "Cancel or let working orders finish first (N working at Alpaca)". The counts come from `GET /api/broker/live/status` (`auto.openPositions`, `auto.openOrders`); if Alpaca cannot be read the status call errors and the control is hidden, and the server refuses anyway.

**How this interacts with the rails.** Because OFF needs a flat account with nothing working, the signal exits, the 1% stop-out and the 15:55 flatten only matter while Auto is ON. Once the account is flat, nothing is working and Auto is OFF, nothing runs: no entries and no orders, only observation. A stop-out or the flatten does not turn Auto OFF; after one, Auto stays ON and the lockout rules (no re-entry after a stop-out today; no entries after 15:55) keep the day flat, so you can then turn OFF once any stop or flatten order has filled. Because a working order also blocks OFF, the late-fill gap (an entry filling after OFF) can no longer arise from the button.

How it is stored: the repo has no database and a Vercel function has no durable disk, so Auto lives in one key (`polarito:live:auto:v1`) of a Redis-over-HTTPS store. Add **Upstash Redis** from the Vercel Marketplace to the project; it injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` (`UPSTASH_REDIS_REST_URL`/`_TOKEN` also work). No new npm dependency, no secrets in the client. The runner reads the key every tick, so a click takes effect on the next tick (about 10 seconds).

It fails closed: Auto is ON only when the store answers and says so. No store configured, an unreachable store or a malformed value all mean OFF, and the panel says why. Without a store the button is disabled and Auto simply stays OFF (so the automation never places a signal-driven order); you can still use Close and the stop-out. Turning Auto ON asks for a second click to confirm; the route writes, reads the value back, and the panel shows what the store holds, never a change that was not saved. Each change is audited (`source: live-auto`).

The browser's own Auto toggle still drives only the browser simulation. Auto OFF never closes or cancels anything and is refused while positions or working orders are open; to get out, use Close (and let or make orders finish) first, then turn Auto OFF. For an emergency `POLARITO_BROKER_KILL=1` stops all live orders including the stop-out, so use it only with the position already flat or handled by hand.

### Closing on polarito.com for the live account

With `POLARITO_LIVE_ACCOUNT=1` the page shows a "LIVE account (real cash)" panel read from Alpaca (`GET /api/broker/live/status`), never from the browser ledger. **Close** calls `POST /api/broker/live/close` (behind the login gate, same-origin only), which sells a long or buys to cover a short for the broker's own quantity. The panel says "closed" only after Alpaca accepted the order and its own position list no longer shows the stock; if the order is accepted but not filled it says so and the position stays shown as open; if Alpaca rejects it (for example wash-trade protection while an entry is still working) the error is shown and the position stays open. Working entries are not cancelled automatically: wait for the fill, then close. With live orders off (observe mode) Close sends nothing and says "would close". The browser's Auto toggle only drives the browser simulation and has no effect on the live account; stop the live automation with the Live Auto control above (or, for an emergency, `POLARITO_BROKER_KILL=1` in Vercel and a redeploy).

### Go-live checklist (one action per step; nothing sends a real order until the steps that set `POLARITO_LIVE_TRADING_ENABLED=1` and turn Live Auto ON)

A. Decide and fund
1. Write down the decisions in "Decisions for Henry" below (or accept the defaults).
2. Open (or confirm) an individual live Alpaca account. Do not fund it yet.
3. Turn on two-factor sign-in on the Alpaca account.
4. Fund $1,000 by ACH at least two trading days before step 27, so `last_equity` exists.
5. From now on do not deposit or withdraw during market hours.

B. Check the facts (no trading)
6. In Alpaca, check whether margin and shorting show as enabled. Under $2,000 they will be off and Reverse readings will not be traded.
7. For each of AAPL, MSFT, NVDA, AMZN, AVGO, GOOGL, GOOG, TSLA, JPM, WMT, look up the asset in Alpaca and write down `tradable`, `shortable`, `fractionable` and `borrow_status`. Short columns matter only from $2,000 of equity; the app accepts `easy_to_borrow` or `ETB` as a good `borrow_status`, so check the exact value Alpaca returns.
8. Read Alpaca's fee schedule once for sell-side regulatory fees.

C. Deploy the code (paper stays the default)
9. Merge this change. Nothing changes until you set live variables.
10. Make sure the repository secret `POLARITO_CRON_SECRET` exists (same value as `CRON_SECRET` in Vercel).
11. In Vercel add the Upstash Redis integration (Storage, Marketplace) to this project, so `KV_REST_API_URL` and `KV_REST_API_TOKEN` exist.
12. On the paper account, send the same `client_order_id` twice (for example `curl -X POST https://paper-api.alpaca.markets/v2/orders` with your PAPER keys, `{"symbol":"WMT","qty":"1","side":"buy","type":"market","time_in_force":"day","client_order_id":"pol-test-dup-1"}`) and confirm the second answer is HTTP 422 "client_order_id must be unique".

D. Observe on live keys (no orders possible)
13. Create live Alpaca API keys.
14. In Vercel set `ALPACA_LIVE_KEY_ID` and `ALPACA_LIVE_SECRET_KEY` (never in chat or the repo).
15. In Vercel set `POLARITO_LIVE_WATCHLIST=AAPL,MSFT,NVDA,AMZN,AVGO,GOOGL,GOOG,TSLA,JPM,WMT`.
16. In Vercel set `POLARITO_PAPER_INSTRUMENT=pick`.
17. In Vercel set `POLARITO_BROKER_KILL=0`, and leave `POLARITO_LIVE_TRADING_ENABLED` unset.
18. In Vercel set `POLARITO_LIVE_ACCOUNT=1`, then redeploy.
19. Sign in and confirm the "LIVE account" panel shows your real equity and positions.
20. Confirm the panel says "Live Auto: OFF" (it must be OFF after every deploy until you turn it on).
21. During the session call `GET /api/cron/pick-run?dry=1` with the `Authorization: Bearer $CRON_SECRET` header. Read the ranked list, the skip reasons and the "Would enter" line in the response.
22. In the Actions tab run the "Pick run" workflow by hand (it is also scheduled). It stays in observe mode.
23. Leave it for at least 5 sessions.
24. Each evening read the Vercel logs (`"source":"pick-runner"`) and write down the top-ranked stock, who was skipped and why, the "Would enter" line and each "Would close".
25. On one day click Close on the live panel in observe mode and confirm it says "would close" with the right side and that nothing was sent.
26. Check on screen that polarito.com shows the same polarity for the picked stock and for the skipped ones.

E. First real orders (1 share) and the close-then-re-enter test
27. On a day you can watch, set `POLARITO_LIVE_QTY=1` and `POLARITO_LIVE_TRADING_ENABLED=1` in Vercel and redeploy.
28. Click "Turn Auto ON" on the live panel and confirm with "Confirm Auto ON"; the panel must then say "Live Auto: ON".
29. Watch the first entry in Alpaca's dashboard and the logs: one order, correct side, 1 share, id `pol-{date}-e01-{TICKER}`.
30. After `e01` fills, click Close on the live panel and confirm in Alpaca a real sell (long) or buy-to-cover (short) for 1 share with id `...-c01-a1-...`, and that the panel said "closed" only after Alpaca accepted it.
31. Wait for the next ticks without touching anything. If the signal is still aligned and the day is above -1%, confirm `e02` for the same stock, 1 share, and never two entries; if not aligned, confirm nothing is placed and the reason is logged. This also shows how fast sale proceeds are usable again on a small cash account.
32. Click Close again on the same position and confirm the second click is a no-op (same id) and nothing doubles.
33. Rejected-close drill: while an entry order is still working, click Close and confirm Alpaca rejects it, the panel shows the error, the position stays open and nothing re-enters; then close once the entry has filled.
34. Auto-OFF refusal drill: with Auto ON and a position open, confirm the panel's "Turn Auto OFF" is disabled with "Close all positions first". (Optional: `curl -X POST .../api/broker/live/auto -d '{"auto":false}'` with your session cookie and confirm HTTP 409 `POSITIONS_OPEN` or `ORDERS_OPEN`.)
35. While an entry order is still working (before it fills), confirm the same button is disabled and says "Cancel or let working orders finish first" with the count.
36. Click Close and wait until the panel shows no positions. If "Turn Auto OFF" is still disabled with "Cancel or let working orders finish first", an order is still working: let it fill or expire, or cancel it yourself in Alpaca (the app never cancels), and confirm the button stays disabled until it is gone.
37. Click "Turn Auto OFF" and confirm on the next ticks that the logs say "Live Auto is OFF", nothing is entered or re-entered, and Close still works. Then turn Auto ON again if you want to continue.
38. After the session confirm the account is flat or matches the logged position, the day's entries are numbered in order (`e01`, `e02`, ...) and each one matches a polarity reading in the logs, and the day's loss is inside 1%.
39. If anything surprises you, click Close on every open position and let or make working orders finish first (Auto OFF is refused while any position or order is open), then "Turn Auto OFF"; if you cannot wait, set `POLARITO_BROKER_KILL=1` and redeploy (this stops all live orders including the stop-out, so close by hand in Alpaca), then ask questions.
40. Run 5 sessions at 1 share before raising anything; change one thing a week.

### Decisions for Henry (chosen by the safest option where the plan left them open; change any with one variable)

1. Down-day fallback: **stand aside** when the strongest reading is a Reverse that cannot be traded (`POLARITO_LIVE_LONG_ONLY_FALLBACK=aside`); `next` takes a weaker Drive stock.
2. "Strongest" is `|netVolume| / noiseFloor` (relative volume outside the Neutral band). The repo's studies found no edge in following polarity and nothing backtests this ranking. Alphabet rule as above; no way to force one class.
3. Skip-to-next when a name is unaffordable, not tradable or not shortable: yes, one logged line per skip. Neutral and stale names are skipped the same way.
4. No cooldown after a manual close: the automation re-enters on the next tick if aligned and the day is above -1%.
5. Entries per day: **no limit** (Henry's call): re-entry follows market polarity only, as in the current app. `POLARITO_LIVE_MAX_ENTRIES` was removed rather than kept as an optional cap. The one exception is the 3-attempt circuit breaker on a single failing close. Pick start 10:00 New York. Flatten at 15:55 New York (overnight hold needs `POLARITO_LIVE_FLATTEN_AT=off`).
6. Live Auto: a working on/off on polarito.com, **OFF at deploy**, stored in an Upstash Redis key through the Vercel Marketplace (the repo has no database and Alpaca has no place to keep a flag; an env var needs a redeploy and is not a control). It needs `KV_REST_API_URL` and `KV_REST_API_TOKEN`; without them Auto stays OFF and the button is disabled. It fails closed: any store error means OFF.
   **Resolved (Henry): Auto cannot be turned OFF while any live position is open OR any working (unfilled) order exists.** Checked on the server against Alpaca (not only the UI); every position counts (stock, option, off-watchlist) and every `status=open` order counts; unreadable or malformed positions or orders refuse OFF; ON is unchanged; nothing is ever cancelled by the app (distinct codes `POSITIONS_OPEN` / `ORDERS_OPEN`). A write is re-checked and ON restored if a position or order appears mid-change. Consequence: the stop-out and 15:55 flatten only matter while Auto is ON; once flat, nothing working and OFF, nothing runs. Trade-off to know: a stuck working order (for example a GTC order you placed by hand) will keep OFF disabled until you cancel it in Alpaca.
7. Quantity 1 share. The shared risk engine's +4% daily profit lock also stops new entries for the day.
8. One deployment with flags (a second Vercel project is cleaner if you want paper options to keep running, because `POLARITO_PAPER_INSTRUMENT=pick` switches the other runners off).
9. Working entry orders are not cancelled by the app; a close during one is rejected by Alpaca and shown as an error.
10. The stop-out order id carries an attempt number too (`s{NN}-a{K}`) so a rejected stop can be retried; a flat account that is already at -1% (for example after a manual loss) is locked out by the equity check rather than by a marker order.
11. Unverified until you check (checklist 7, 31): the exact `borrow_status` values Alpaca returns, and how fast sale proceeds free up buying power on a sub-$2,000 account.
12. Accept the risk: the repo's back-tests found no edge in following polarity, $1,000 of real cash can be lost, and a 1% stop does not cap gap losses.

## Audit log (server only)

The scheduled runner writes one structured JSON line per decision to the server log (`{"audit":{...}}`), searchable in Vercel logs, and returns the same records in its response. Records only contain whitelisted, length-capped fields, so credentials never appear.

## Scripts

- `npm run test` — unit tests (including session auth)
- `npm run build` / `npm start` — production Node app
- `npm run package:namecom` — static `/out` + PHP bars bridge

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
