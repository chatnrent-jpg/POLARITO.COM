# Polarity backtest
Generated 2026-11-03 | feed `sip` | data 2016-01-04 -> 2026-11-02 | tickers: SPY, QQQ, IWM, AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, AMD, JPM, XOM | cost 5 bps per side | 2000 permutations

**Verdict:** INVERSE (edge < 0, p < 0.05; the market tends to do the OPPOSITE of the signal, i.e. mean reversion): Drive (+1) 1D (edge -0.064%, p <0.001); Reverse (-1) 1D (edge -0.070%, p <0.001); Drive (+1) 5D (edge -0.115%, p 0.001); Reverse (-1) 5D (edge -0.124%, p 0.002); Drive (+1) 20D (edge -0.193%, p 0.011); Reverse (-1) 20D (edge -0.209%, p 0.010). The Noise Floor almost never binds: Neutral is only 0.09% of days, so Drive/Reverse is effectively just the candle colour (green = +1, red = -1).

Signal days (post warm-up): Drive 18232, Neutral 30, Reverse 16903.

## 1. Does the signal predict forward returns? (event study)
Entry = **next session open** (the earliest realistic fill: the signal needs the signal-day close). Return is measured in the signal's direction (Reverse is scored as a short). **Edge** = directional return minus the same ticker's average-day return, so a rising market cannot flatter Drive. p-value = two-sided permutation test against randomly chosen days (negative edge = inverse signal).

| Signal | Horizon | n | Mean (dir.) | Edge | Hit rate | t-stat | p-value |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Drive (+1) | 1D | 18231 | -0.021% | -0.064% | 50.3% | -1.64 | <0.001 |
| Drive (+1) | 5D | 18206 | 0.414% | -0.115% | 56.1% | 12.04 | 0.001 |
| Drive (+1) | 20D | 18114 | 2.210% | -0.193% | 61.5% | 29.67 | 0.011 |
| Neutral (0) | 1D | 30 | -0.280% | -0.322% | 46.7% | -1.20 | - |
| Neutral (0) | 5D | 30 | 0.477% | -0.071% | 46.7% | 0.66 | - |
| Neutral (0) | 20D | 30 | 2.479% | -0.010% | 50.0% | 1.36 | - |
| Reverse (-1) | 1D | 16891 | -0.112% | -0.070% | 46.5% | -7.89 | <0.001 |
| Reverse (-1) | 5D | 16864 | -0.657% | -0.124% | 42.4% | -17.46 | 0.002 |
| Reverse (-1) | 20D | 16761 | -2.638% | -0.209% | 36.1% | -33.38 | 0.010 |

Optimistic ceiling: entering at the signal-day close (needs a market-on-close fill):

| Signal | Horizon | n | Mean (dir.) | Edge | Hit rate | t-stat | p-value |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Drive (+1) | 1D | 18231 | 0.080% | -0.041% | 52.5% | 4.85 | - |
| Drive (+1) | 5D | 18206 | 0.517% | -0.091% | 56.9% | 14.32 | - |
| Drive (+1) | 20D | 18114 | 2.317% | -0.169% | 62.2% | 30.64 | - |
| Neutral (0) | 1D | 30 | -0.516% | -0.643% | 40.0% | -1.94 | - |
| Neutral (0) | 5D | 30 | 0.245% | -0.389% | 46.7% | 0.32 | - |
| Neutral (0) | 20D | 30 | 2.214% | -0.365% | 50.0% | 1.25 | - |
| Reverse (-1) | 1D | 16891 | -0.167% | -0.045% | 45.5% | -9.14 | - |
| Reverse (-1) | 5D | 16864 | -0.712% | -0.098% | 42.1% | -18.09 | - |
| Reverse (-1) | 20D | 16761 | -2.698% | -0.183% | 36.4% | -33.68 | - |

## 2. Stability by year (5D, next-open entry, edge)
| Year | Drive n | Drive edge | Drive hit | Reverse n | Reverse edge | Reverse hit |
| --- | --- | --- | --- | --- | --- | --- |
| 2016 | 1610 | -0.070% | 58.2% | 1413 | -0.084% | 38.5% |
| 2017 | 1681 | -0.093% | 61.9% | 1574 | -0.101% | 39.1% |
| 2018 | 1667 | 0.003% | 52.9% | 1592 | 0.001% | 46.7% |
| 2019 | 1709 | -0.197% | 61.0% | 1567 | -0.215% | 36.8% |
| 2020 | 1712 | -0.319% | 56.0% | 1577 | -0.347% | 39.7% |
| 2021 | 1679 | -0.084% | 55.6% | 1590 | -0.095% | 42.7% |
| 2022 | 1613 | -0.247% | 44.8% | 1647 | -0.229% | 52.9% |
| 2023 | 1789 | -0.165% | 58.0% | 1460 | -0.201% | 38.9% |
| 2024 | 1695 | -0.015% | 58.5% | 1581 | -0.016% | 42.9% |
| 2025 | 1694 | -0.287% | 56.3% | 1556 | -0.313% | 41.1% |
| 2026 | 1357 | 0.031% | 52.9% | 1307 | 0.032% | 47.0% |

## 3. Can it be traded? (equal-weight portfolio of all tickers)
Fills: signal trades at the next open, fixed-length holds exit at the close, 5 bps per side, 1x notional, no borrow cost on shorts. Benchmark = equal-weight buy & hold of the same tickers over the same sessions.

| Strategy | Total | CAGR | Vol | Sharpe | Max DD | Trades | Win rate | Profit factor | Expectancy/trade | Exposure | Turnover/yr |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Buy & hold (benchmark) | 1823.3% | 31.7% | 24.1% | 1.26 | -36.4% | - | - | - | - | 100% | - |
| Hold 1d, long/short | -99.0% | -34.6% | 14.3% | -2.91 | -99.0% | 35122 | 45.0% | 0.76 | -0.165% | 99.9% | 503.6 |
| Hold 5d, long-only | -12.6% | -1.2% | 14.2% | -0.02 | -40.5% | 9009 | 41.5% | 1.00 | -0.005% | 77.5% | 129.1 |
| Hold 5d, long/short | -97.0% | -27.9% | 18.2% | -1.71 | -97.1% | 18021 | 37.2% | 0.78 | -0.237% | 100.0% | 258.3 |
| Hold 20d, long/short | -97.0% | -27.9% | 18.2% | -1.71 | -97.1% | 18021 | 37.2% | 0.78 | -0.237% | 100.0% | 258.3 |
| Hold until reversal, long/short | -97.0% | -27.9% | 18.2% | -1.71 | -97.1% | 18021 | 37.2% | 0.78 | -0.237% | 100.0% | 258.3 |

## 4. Per ticker: Sharpe, strategy vs buy & hold
| Ticker | Bars | B&H Sharpe | Hold 1d, long/short | Hold 5d, long-only | Hold 5d, long/short | Hold 20d, long/short | Hold until reversal, long/short |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SPY | 2724 | 0.90 | -2.25 | -0.08 | -1.02 | -1.02 | -1.02 |
| QQQ | 2724 | 0.93 | -2.14 | -0.22 | -1.26 | -1.26 | -1.26 |
| IWM | 2724 | 0.58 | -2.07 | -0.24 | -0.90 | -0.90 | -0.90 |
| AAPL | 2724 | 1.04 | -1.50 | 0.08 | -0.90 | -0.90 | -0.90 |
| MSFT | 2724 | 0.94 | -2.04 | -0.21 | -1.24 | -1.24 | -1.24 |
| NVDA | 2724 | 1.32 | -1.25 | 0.31 | -0.88 | -0.88 | -0.88 |
| AMZN | 2724 | 0.77 | -1.25 | 0.01 | -0.74 | -0.74 | -0.74 |
| GOOGL | 2724 | 0.78 | -1.54 | -0.13 | -0.95 | -0.95 | -0.95 |
| META | 2724 | 0.60 | -1.93 | -0.42 | -1.20 | -1.20 | -1.20 |
| TSLA | 2724 | 0.84 | -1.08 | 0.32 | -0.41 | -0.41 | -0.41 |
| AMD | 2724 | 1.13 | -1.47 | 0.06 | -1.07 | -1.07 | -1.07 |
| JPM | 2724 | 0.84 | -1.74 | 0.18 | -0.58 | -0.58 | -0.58 |
| XOM | 2724 | 0.58 | -1.77 | -0.42 | -1.12 | -1.12 | -1.12 |

## Caveats (read before trusting any number)
- **Feed:** `sip`. The free IEX feed reports only IEX-exchange volume (a small slice of the consolidated tape), so Net Volume is a noisy proxy. Re-run with `--feed=sip` if your plan allows it.
- **Overlapping windows:** 5D and 20D forward returns overlap, so t-stats are overstated; lean on the permutation p-value and the by-year table.
- **Permutation test:** it resamples random days per ticker; it does not model volatility clustering, so p-values are indicative, not exact.
- **Survivorship bias:** the universe is today's liquid names. Companies that failed or were delisted are absent, which flatters long strategies.
- **Costs:** a flat bps cost ignores spread widening, slippage on size and short borrow fees.
- **Multiple comparisons:** many buckets are tested; at p < 0.05 about 1 in 20 will look good by chance.
- **No parameters were fitted** (20-day window and 10% floor are fixed by design), so there is no in-sample tuning, but a clean out-of-sample hold-out is still the stronger test.
