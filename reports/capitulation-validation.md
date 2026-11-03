# Capitulation fade: out-of-sample replication
Generated 2026-11-03 | feed `sip` | 39 stocks never used in discovery | rule: Reverse day (red candle) on volume > 1.5x 20-day avg -> buy next open, sell that close | cost 5 bps/side | 5000 permutations

**Verdict:** EDGE IS REAL BUT NOT ROBUSTLY TRADEABLE. The fade direction replicated out-of-sample in both periods, but it failed: 4. Net expectancy > 0 at 10 bps/side (costs doubled). The effect is about the size of round-trip costs on typical stocks, so it does not clear the bar.

## Pre-registered checks (new stocks)
| Check | Result | Detail |
| --- | --- | --- |
| 1. Fade edge > 0 and p < 0.05 (all years) | PASS | fade edge 0.096%, p <0.001, n 4765 |
| 2. Fade edge > 0 in both periods | PASS | pre-2023 0.063% (n 3156); 2023+ 0.164% (n 1609) |
| 3. Net expectancy > 0 at 5 bps/side | PASS | 0.023% per trade over 4765 trades |
| 4. Net expectancy > 0 at 10 bps/side (costs doubled) | FAIL | -0.077% per trade |
| 5. Breadth: >half of tickers profitable and positive without best ticker | PASS | 22 of 39 tickers profitable; best TXN (52% of P&L); without best 0.011% |

## 1. Event study (1D, next-open entry; FADE edge = how much more than an average day the stock rises after a Reverse signal)
| Group / period | n | Mean next-day return | Fade edge | Next-day up | t-stat (fade) | p-value |
| --- | --- | --- | --- | --- | --- | --- |
| New stocks, all years | 4765 | 0.123% | 0.096% | 52.7% | 4.23 | <0.001 |
| New stocks, before 2023 | 3156 | 0.086% | 0.063% | 51.8% | 2.46 | 0.019 |
| New stocks, 2023+ | 1609 | 0.197% | 0.164% | 54.5% | 3.73 | <0.001 |
| ETFs (DIA, XLF, XLE, XLK, XLV, GLD), all years | 848 | -0.021% | -0.040% | 49.9% | -0.40 | 0.234 |

## 2. Tradeable? (equal-weight portfolio of new stocks, net of costs)
| Scenario | Total | CAGR | Sharpe | Max DD | Trades | Win rate | Expectancy/trade | Profit factor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Buy & hold, same stocks (all years) | 518.8% | 18.5% | 1.08 | -32.7% | - | - | - | - |
| Fade @ 5 bps/side | 2.6% | 0.2% | 0.12 | -6.0% | 4765 | 49.4% | 0.023% | 1.03 |
| Fade @ 10 bps/side | -9.2% | -0.9% | -0.39 | -11.0% | 4765 | 46.8% | -0.077% | 0.90 |
| Fade @ 20 bps/side | -28.9% | -3.1% | -1.42 | -29.4% | 4765 | 41.4% | -0.277% | 0.67 |
| Fade @ 5 bps, before 2023 | -1.3% | -0.2% | -0.07 | -6.0% | 3156 | 48.4% | -0.014% | 0.98 |
| Fade @ 5 bps, 2023+ | 4.0% | 1.0% | 0.49 | -2.8% | 1609 | 51.2% | 0.097% | 1.15 |

Portfolio returns are averaged across ALL tickers each day, so total return looks small: capital is idle most days. Expectancy per trade is the cleaner figure.

## 3. Breadth and by-year stability (net of 5 bps)
| Year | Trades | Net expectancy/trade |
| --- | --- | --- |
| 2016 | 380 | 0.047% |
| 2017 | 439 | -0.109% |
| 2018 | 488 | -0.095% |
| 2019 | 434 | -0.084% |
| 2020 | 554 | 0.340% |
| 2021 | 474 | -0.206% |
| 2022 | 387 | -0.062% |
| 2023 | 408 | 0.113% |
| 2024 | 413 | 0.050% |
| 2025 | 448 | 0.258% |
| 2026 | 340 | -0.075% |

## 4. Sensitivity: nearby floors (report only; the 1.5x spec is NOT re-picked)
| Floor | Fade edge before 2023 | p | n | Fade edge 2023+ | p | n |
| --- | --- | --- | --- | --- | --- | --- |
| 1.25x | 0.054% | 0.005 | 6272 | 0.094% | <0.001 | 3247 |
| 1.5x | 0.063% | 0.008 | 3156 | 0.164% | <0.001 | 1609 |
| 1.75x | 0.046% | 0.176 | 1797 | 0.180% | <0.001 | 974 |
| 2x | 0.000% | 0.991 | 1085 | 0.125% | 0.050 | 617 |

A real effect should degrade smoothly across neighbouring floors, not appear at only one value.

## Caveats
- Market-wide events (March 2020, 2022 bear market) hit all tickers at once, so cross-ticker replication is not fully independent evidence.
- Survivorship bias: today's liquid names only.
- Daily-bar volume is the final consolidated total; confirm in forward testing that the live pre-open number matches (late prints can change it).
- Assumes a fill at the official next open and exit at the close, 1x notional, no short borrow (this is long-only).
