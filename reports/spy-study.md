# SPY-only study
Generated 2026-11-03 | feed `sip` | 2724 bars 2016-01-04 -> 2026-11-02 | development < 2022-01-01 <= hold-out | 10000 permutations | cost 2 bps/side

**Verdict:** No SPY bucket cleared the development bar (30 tests, Bonferroni p < 0.0017). On SPY alone, at any floor from 0.1x to 2.0x, the signal shows no statistically defensible edge in 2016-2021. Caveat: one ticker has limited power, so this rules out medium and large effects, not tiny ones.

## Protocol (fixed before looking at results)
1. Floors 0.1x, 0.5x, 1x, 1.5x, 2x of the 20-day average volume (0.1x = shipped) x Drive/Reverse x 1D/5D/20D = 30 tests.
2. Development only picks candidates: n >= 60, two-sided permutation p < 0.00167 (Bonferroni 0.05 / 30). Direction is data-driven: edge > 0 = follow, edge < 0 = fade.
3. Dev signals whose 20-session forward window reaches 2022-01-01 are purged.
4. Hold-out used once: same sign, p < 0.05, n >= 30.
5. Tradeable = positive net expectancy at 2 and 4 bps per side AND positive net Sharpe in the hold-out.
6. Entry = next session open. Edge = directional return minus SPY's average-day return.

## 1. How often does each floor fire on SPY?
| Floor | Drive | Neutral | Reverse | Drive days | Reverse days |
| --- | --- | --- | --- | --- | --- |
| 0.1x (shipped) | 54.2% | 0.0% | 45.8% | 1465 | 1239 |
| 0.5x | 53.4% | 1.2% | 45.4% | 1444 | 1229 |
| 1x | 18.9% | 59.2% | 21.9% | 511 | 592 |
| 1.5x | 2.3% | 92.5% | 5.2% | 62 | 141 |
| 2x | 0.4% | 98.3% | 1.4% | 10 | 37 |

## 2. Edge by floor: development vs hold-out
Edge > 0: SPY moved WITH the signal; edge < 0: AGAINST it. About 1.5 of 30 buckets would look "significant" at 5% by luck; the dev gate is Bonferroni-corrected for that.

| Floor | Signal | Horizon | Dev n | Dev edge | Dev p | Hold n | Hold edge | Hold p | Candidate | Confirmed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1x | Drive | 1D | 807 | -0.026% | 0.325 | 646 | -0.010% | 0.782 | - | - |
| 0.1x | Drive | 5D | 807 | -0.029% | 0.687 | 643 | -0.116% | 0.173 | - | - |
| 0.1x | Drive | 20D | 807 | -0.188% | 0.215 | 634 | -0.219% | 0.188 | - | - |
| 0.1x | Reverse | 1D | 664 | -0.032% | 0.286 | 566 | -0.011% | 0.762 | - | - |
| 0.1x | Reverse | 5D | 664 | -0.035% | 0.661 | 565 | -0.132% | 0.150 | - | - |
| 0.1x | Reverse | 20D | 664 | -0.234% | 0.160 | 559 | -0.248% | 0.162 | - | - |
| 0.5x | Drive | 1D | 792 | -0.030% | 0.280 | 640 | -0.012% | 0.740 | - | - |
| 0.5x | Drive | 5D | 792 | -0.034% | 0.646 | 637 | -0.137% | 0.107 | - | - |
| 0.5x | Drive | 20D | 792 | -0.184% | 0.227 | 628 | -0.255% | 0.129 | - | - |
| 0.5x | Reverse | 1D | 658 | -0.031% | 0.292 | 563 | -0.007% | 0.850 | - | - |
| 0.5x | Reverse | 5D | 658 | -0.036% | 0.664 | 562 | -0.123% | 0.185 | - | - |
| 0.5x | Reverse | 20D | 658 | -0.233% | 0.166 | 557 | -0.223% | 0.209 | - | - |
| 1x | Drive | 1D | 282 | -0.022% | 0.618 | 224 | -0.028% | 0.647 | - | - |
| 1x | Drive | 5D | 282 | -0.169% | 0.178 | 223 | -0.255% | 0.080 | - | - |
| 1x | Drive | 20D | 282 | -0.194% | 0.451 | 222 | -0.069% | 0.804 | - | - |
| 1x | Reverse | 1D | 303 | -0.068% | 0.125 | 284 | -0.035% | 0.509 | - | - |
| 1x | Reverse | 5D | 303 | 0.025% | 0.839 | 283 | -0.122% | 0.339 | - | - |
| 1x | Reverse | 20D | 303 | 0.010% | 0.970 | 280 | -0.253% | 0.310 | - | - |
| 1.5x | Drive | 1D | 43 | -0.015% | 0.891 | 19 | -0.126% | 0.514 | - | - |
| 1.5x | Drive | 5D | 43 | -0.969% | 0.004 | 19 | 0.292% | 0.562 | - | - |
| 1.5x | Drive | 20D | 43 | -0.808% | 0.214 | 19 | 0.827% | 0.378 | - | - |
| 1.5x | Reverse | 1D | 89 | -0.000% | 0.998 | 51 | -0.266% | 0.040 | - | - |
| 1.5x | Reverse | 5D | 89 | -0.249% | 0.262 | 50 | -0.402% | 0.192 | - | - |
| 1.5x | Reverse | 20D | 89 | 0.546% | 0.235 | 49 | -0.292% | 0.625 | - | - |
| 2x | Drive | 1D | 5 | -0.014% | 0.957 | 5 | -0.974% | 0.021 | - | - |
| 2x | Drive | 5D | 5 | -2.662% | 0.016 | 5 | 1.421% | 0.135 | - | - |
| 2x | Drive | 20D | 5 | -5.630% | 0.015 | 5 | 3.343% | 0.072 | - | - |
| 2x | Reverse | 1D | 31 | 0.125% | 0.346 | 6 | -1.047% | 0.011 | - | - |
| 2x | Reverse | 5D | 31 | -0.104% | 0.770 | 6 | -1.936% | 0.033 | - | - |
| 2x | Reverse | 20D | 31 | 2.462% | 0.004 | 6 | -3.089% | 0.071 | - | - |

## 3. Tradeability of confirmed buckets (hold-out 2022-01-01+)
No bucket confirmed, so no strategy was run (running strategies on unconfirmed buckets would data-mine the hold-out).

## Caveats
- One ticker means about 1465 Drive and 1239 Reverse days at the shipped floor and only dozens at 1.5x+. Small n makes p-values coarse and effects noisy.
- SPY appeared inside the earlier 13-ticker pooled studies, so it has been seen in aggregate (never alone).
- 5D/20D windows overlap; the permutation p-value ignores volatility clustering.
- 2 bps/side is a fair estimate for SPY at the open; short-side borrow (~0.25%/yr) is ignored.
- The hold-out (2022+) contains the 2022 bear market and a strong 2023-2026 rally, but is still one path of history.
