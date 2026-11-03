# Noise Floor study
Generated 2026-11-03 | feed `sip` | 13 tickers | development < 2023-01-01 <= hold-out | 5000 permutations | cost 5 bps/side

**Verdict:** LEAD (not proof): Reverse 1D @ 1.5x (fade) confirmed out-of-sample and stayed profitable after costs. Next: paper-trade it and re-test on fresh data before risking capital.

## Protocol (fixed before looking at results)
1. Floors tested: 0.1x, 0.5x, 1x, 1.5x, 2x of the 20-day average volume (0.1x is the shipped setting, shown for reference and excluded from the search).
2. **Development only** picks candidates: n >= 200 and two-sided permutation p < 0.0021 (Bonferroni: 0.05 / 24 tests).
3. Dev signals whose 20-session forward window reaches 2023-01-01 are purged, so no development statistic uses hold-out prices.
4. **Hold-out used once** to confirm: same sign, p < 0.05, n >= 100.
5. Tradeable only if the matching strategy has positive net expectancy and Sharpe in the hold-out (direction = sign of the dev edge) AND stays positive after removing the single best ticker. (The concentration condition was added after the first run, once one ticker was seen carrying three of four buckets. It only tightens the gate.)
6. Entry is always the next session open. Edge = directional return minus the ticker's average-day return.

## 1. How often does each floor fire?
| Floor (x avg vol) | Drive | Neutral | Reverse |
| --- | --- | --- | --- |
| 0.1x (shipped) | 51.8% | 0.1% | 48.1% |
| 0.5x | 51.1% | 1.6% | 47.3% |
| 1x | 19.1% | 61.0% | 19.9% |
| 1.5x | 3.6% | 91.7% | 4.7% |
| 2x | 1.1% | 97.4% | 1.5% |

## 2. Edge by floor: development vs hold-out
Edge > 0 means the market moved WITH the signal; edge < 0 means against it (mean reversion). Expect about 1.2 of 24 buckets to look "significant" at 5% by luck alone, which is why the dev gate is Bonferroni-corrected.

| Floor | Signal | Horizon | Dev n | Dev edge | Dev p | Hold n | Hold edge | Hold p | Candidate | Confirmed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1x | Drive | 1D | 11554 | -0.076% | <0.001 | 6560 | -0.044% | 0.031 | ref | - |
| 0.1x | Drive | 5D | 11554 | -0.128% | 0.004 | 6535 | -0.101% | 0.074 | ref | - |
| 0.1x | Drive | 20D | 11554 | -0.169% | 0.074 | 6443 | -0.274% | 0.028 | ref | - |
| 0.1x | Reverse | 1D | 10817 | -0.082% | <0.001 | 5931 | -0.049% | 0.029 | ref | - |
| 0.1x | Reverse | 5D | 10817 | -0.137% | 0.004 | 5904 | -0.112% | 0.065 | ref | - |
| 0.1x | Reverse | 20D | 10817 | -0.179% | 0.071 | 5801 | -0.306% | 0.022 | ref | - |
| 0.5x | Drive | 1D | 11359 | -0.079% | <0.001 | 6478 | -0.050% | 0.020 | YES | YES |
| 0.5x | Drive | 5D | 11359 | -0.135% | 0.003 | 6453 | -0.106% | 0.067 | - | - |
| 0.5x | Drive | 20D | 11359 | -0.164% | 0.076 | 6361 | -0.289% | 0.023 | - | - |
| 0.5x | Reverse | 1D | 10613 | -0.079% | <0.001 | 5879 | -0.049% | 0.029 | YES | YES |
| 0.5x | Reverse | 5D | 10613 | -0.133% | 0.005 | 5852 | -0.115% | 0.060 | - | - |
| 0.5x | Reverse | 20D | 10613 | -0.154% | 0.119 | 5751 | -0.299% | 0.025 | - | - |
| 1x | Drive | 1D | 4309 | -0.147% | <0.001 | 2399 | -0.064% | 0.074 | YES | - |
| 1x | Drive | 5D | 4309 | -0.329% | <0.001 | 2386 | -0.082% | 0.396 | YES | - |
| 1x | Drive | 20D | 4309 | -0.305% | 0.044 | 2360 | -0.275% | 0.196 | - | - |
| 1x | Reverse | 1D | 4455 | -0.074% | 0.008 | 2453 | -0.107% | 0.002 | - | - |
| 1x | Reverse | 5D | 4455 | -0.097% | 0.170 | 2436 | -0.256% | 0.005 | - | - |
| 1x | Reverse | 20D | 4455 | -0.040% | 0.789 | 2392 | -0.226% | 0.247 | - | - |
| 1.5x | Drive | 1D | 846 | -0.244% | <0.001 | 410 | -0.234% | 0.010 | YES | YES |
| 1.5x | Drive | 5D | 846 | -0.424% | 0.022 | 407 | -0.020% | 0.932 | - | - |
| 1.5x | Drive | 20D | 846 | -0.721% | 0.070 | 406 | -0.439% | 0.388 | - | - |
| 1.5x | Reverse | 1D | 1146 | -0.197% | <0.001 | 506 | -0.257% | <0.001 | YES | YES |
| 1.5x | Reverse | 5D | 1146 | -0.288% | 0.044 | 494 | -0.617% | 0.003 | - | - |
| 1.5x | Reverse | 20D | 1146 | -0.372% | 0.209 | 485 | -0.524% | 0.217 | - | - |
| 2x | Drive | 1D | 246 | -0.290% | 0.032 | 130 | -0.274% | 0.072 | - | - |
| 2x | Drive | 5D | 246 | -0.204% | 0.575 | 128 | 0.351% | 0.377 | - | - |
| 2x | Drive | 20D | 246 | -0.538% | 0.466 | 128 | 0.294% | 0.732 | - | - |
| 2x | Reverse | 1D | 380 | -0.243% | 0.008 | 138 | -0.058% | 0.677 | - | - |
| 2x | Reverse | 5D | 380 | -0.326% | 0.195 | 133 | -0.738% | 0.050 | - | - |
| 2x | Reverse | 20D | 380 | 0.133% | 0.801 | 132 | -0.465% | 0.555 | - | - |

## 3. Tradeability of confirmed buckets (hold-out 2023-01-01+)
| Strategy | Gross total | Net total | Net Sharpe | Net max DD | Trades | Win rate | Expectancy/trade | Exposure | Tradeable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Buy & hold (benchmark) | - | 273.4% | 1.73 | -24.8% | - | - | - | 100% | - |
| Drive 1D @ 0.5x (fade) | -9.1% | -44.8% | -1.45 | -47.4% | 6491 | 44.9% | -0.115% | 51.9% | no |
| Reverse 1D @ 0.5x (fade) | 65.5% | 5.3% | 0.17 | -17.9% | 5879 | 49.5% | 0.017% | 47.0% | no |
| Drive 1D @ 1.5x (fade) | 5.0% | 1.7% | 0.15 | -3.2% | 410 | 50.2% | 0.061% | 3.3% | no |
| Reverse 1D @ 1.5x (fade) | 12.9% | 8.6% | 0.48 | -4.2% | 506 | 46.0% | 0.223% | 4.0% | YES |

## 4. Concentration check (hold-out, net of costs)
A real effect should be broad, not carried by one ticker.

| Strategy | Expectancy/trade | Without best ticker | Best ticker (share of P&L) | Worst ticker | Tickers profitable |
| --- | --- | --- | --- | --- | --- |
| Drive 1D @ 0.5x (fade) | -0.115% | -0.131% | TSLA (n/a) | AAPL | 1 of 13 |
| Reverse 1D @ 0.5x (fade) | 0.017% | -0.008% | TSLA (143%) | IWM | 7 of 13 |
| Drive 1D @ 1.5x (fade) | 0.061% | -0.039% | NVDA (161%) | AAPL | 5 of 13 |
| Reverse 1D @ 1.5x (fade) | 0.223% | 0.150% | NVDA (38%) | MSFT | 10 of 13 |

## Caveats
- **Read the 0.5x rows with suspicion.** A 0.5x floor fires on ~98% of days, so it is the same candle-colour signal as the shipped 0.1x floor, which backtest.ts had already examined on the full sample. Its "confirmation" is not independent evidence. Only the 1.0x and above floors are genuinely new.
- Even a "tradeable" bucket earns far less in total return than buy & hold in a bull market; its value would be as a low-exposure, low-drawdown add-on, not a replacement for holding the stocks.
- The hold-out runs from 2023-01-01 to the latest data (under 4 years) and is dominated by one market regime (a strong bull market); a pass here is evidence, not proof.
- Universe is today's liquid names (survivorship bias flatters long exposure).
- Overlapping 5D/20D windows overstate t-stats; the permutation p-value is the figure to use, and it ignores volatility clustering.
- Costs are a flat 5 bps per side: no spread widening, slippage on size, or short-borrow fees.
- Only the floor ratio was varied. The 20-day window and candle-colour direction rule were not touched.
