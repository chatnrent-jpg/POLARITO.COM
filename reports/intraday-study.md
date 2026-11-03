# SPY intraday (5-minute) study
Generated 2026-11-03 | feed `sip` | 2702 sessions (22 dropped) | 210756 bars | development < 2022-01-01 <= hold-out | cost 1 bp/side

**Verdict:** 3 bucket(s) confirmed out-of-sample as statistically real, but none is tradeable: after 1 bp/side (and the doubled stress) the matching strategy does not stay positive with a positive Sharpe.

## Protocol (fixed before looking at results)
1. Signal = the live `netVolume()` + `gate()` on each 5-min bar. Noise floor = ratio x mean volume of the same time slot over the previous 20 sessions.
2. Floors 0.1x, 1x, 2x, 3x (0.1x = the daily-chart default) x Drive/Reverse x 5 min / 30 min = 16 tests.
3. Entry = open of the next bar; exit = close of bar s+H; no overnight holds.
4. Edge = forward return minus the same-time-slot average in the same sample. p-values are day-clustered, two-sided; dev bar = Bonferroni 0.0031, n >= 1000.
5. Hold-out used once: same sign, p < 0.05, n >= 400.
6. Tradeable = positive net expectancy at 1 bp and 2 bp per side AND positive net Sharpe (non-overlapping simulation). Entry delay is a diagnostic only.

## 1. How often does each floor fire?
| Floor | Drive | Neutral | Reverse |
| --- | --- | --- | --- |
| 0.1x | 50.9% | 0.7% | 48.3% |
| 1x | 18.2% | 63.7% | 18.1% |
| 2x | 3.6% | 92.6% | 3.8% |
| 3x | 1.2% | 97.6% | 1.2% |

## 2. Edge by floor: development vs hold-out
Edge = raw forward return after the signal minus the same-time-slot average (> 0: SPY rose more than usual; < 0: fell). It is NOT direction-adjusted: after a Drive signal a negative edge means a fade (short) would profit; after a Reverse signal a positive edge means a fade (long) would profit.

| Floor | Signal | Hold | Dev n | Dev edge | Dev p | Hold n | Hold edge | Hold p | Candidate | Confirmed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1x | Drive | 5m | 57823 | -0.13 bps | <0.001 | 47376 | -0.11 bps | 0.017 | YES | YES |
| 0.1x | Drive | 30m | 54184 | -0.21 bps | 0.174 | 44382 | 0.04 bps | 0.827 | - | - |
| 0.1x | Reverse | 5m | 54647 | 0.14 bps | <0.001 | 45189 | 0.11 bps | 0.012 | YES | YES |
| 0.1x | Reverse | 30m | 50962 | 0.23 bps | 0.155 | 42177 | -0.05 bps | 0.820 | - | - |
| 1x | Drive | 5m | 20085 | -0.25 bps | 0.001 | 17408 | -0.21 bps | 0.022 | YES | YES |
| 1x | Drive | 30m | 18685 | -0.57 bps | 0.053 | 16240 | -0.12 bps | 0.767 | - | - |
| 1x | Reverse | 5m | 19665 | 0.11 bps | 0.144 | 17615 | 0.10 bps | 0.266 | - | - |
| 1x | Reverse | 30m | 18254 | 0.28 bps | 0.358 | 16378 | 0.02 bps | 0.959 | - | - |
| 2x | Drive | 5m | 4857 | -0.47 bps | 0.031 | 2686 | -0.27 bps | 0.381 | - | - |
| 2x | Drive | 30m | 4628 | -1.32 bps | 0.028 | 2562 | 0.42 bps | 0.764 | - | - |
| 2x | Reverse | 5m | 5023 | 0.18 bps | 0.316 | 2873 | 0.25 bps | 0.438 | - | - |
| 2x | Reverse | 30m | 4764 | 0.36 bps | 0.550 | 2719 | -0.03 bps | 0.981 | - | - |
| 3x | Drive | 5m | 1644 | -0.54 bps | 0.111 | 762 | 0.10 bps | 0.911 | - | - |
| 3x | Drive | 30m | 1600 | -1.99 bps | 0.040 | 745 | 0.81 bps | 0.795 | - | - |
| 3x | Reverse | 5m | 1715 | 0.23 bps | 0.507 | 797 | 1.63 bps | 0.052 | - | - |
| 3x | Reverse | 30m | 1655 | 0.65 bps | 0.485 | 773 | 2.09 bps | 0.529 | - | - |

## 3. Tradeability of confirmed buckets (hold-out 2022-01-01+)
| Strategy | Gross / signal | Net @1bp | Net @2bp | Net @4bp | Net p | Sim trades | Win rate | Net total | Net Sharpe | Exposure | Tradeable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Buy & hold SPY | - | - | - | - | - | - | - | 68.8% | 0.73 | 100% | - |
| Drive 5min @ 0.1x (fade) | 0.09 bps | -1.91 bps | -3.91 bps | -7.91 bps | <0.001 | 47376 | 35.6% | -100.0% | -17.93 | 50.32% | no |
| Reverse 5min @ 0.1x (fade) | 0.13 bps | -1.87 bps | -3.87 bps | -7.87 bps | <0.001 | 45189 | 38.3% | -100.0% | -18.01 | 48.00% | no |
| Drive 5min @ 1x (fade) | 0.19 bps | -1.81 bps | -3.81 bps | -7.81 bps | <0.001 | 17408 | 38.6% | -95.8% | -8.15 | 18.49% | no |

### Diagnostics
| Strategy | Gross (normal entry) | Gross (1-bar-late entry) | Net @1bp (1-bar-late) | Gross first 30m (n) | Gross midday (n) | Gross last 30m (n) |
| --- | --- | --- | --- | --- | --- | --- |
| Drive 5min @ 0.1x (fade) | 0.09 bps | 0.03 bps | -1.97 bps | 0.05 bps (3720) | 0.10 bps (40662) | 0.07 bps (2994) |
| Reverse 5min @ 0.1x (fade) | 0.13 bps | 0.06 bps | -1.94 bps | -0.13 bps (3504) | 0.15 bps (38673) | 0.07 bps (3012) |
| Drive 5min @ 1x (fade) | 0.19 bps | 0.10 bps | -1.90 bps | -0.16 bps (1469) | 0.23 bps (14771) | 0.17 bps (1168) |

### Gross directional return per signal, by year (n)
| Strategy | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Drive 5min @ 0.1x (fade) | -0.0 bps (8870) | 0.0 bps (9824) | 0.3 bps (9623) | 0.1 bps (9738) | 0.2 bps (9804) | 0.0 bps (9964) | 0.3 bps (9715) | -0.1 bps (9818) | 0.1 bps (9825) | 0.0 bps (9852) | 0.1 bps (8166) |
| Reverse 5min @ 0.1x (fade) | 0.2 bps (8610) | 0.1 bps (9033) | 0.1 bps (9377) | 0.2 bps (9181) | 0.3 bps (9132) | 0.1 bps (9314) | 0.2 bps (9481) | 0.0 bps (9201) | 0.1 bps (9272) | 0.1 bps (9260) | 0.1 bps (7975) |
| Drive 5min @ 1x (fade) | -0.0 bps (2987) | 0.1 bps (3261) | 0.2 bps (3653) | 0.4 bps (3070) | 0.5 bps (3432) | 0.1 bps (3682) | 0.5 bps (3806) | 0.2 bps (3649) | 0.2 bps (3404) | 0.1 bps (3665) | -0.0 bps (2884) |

## Caveats
- Entry at the next bar's open ignores real latency; the entry-delay diagnostic shows how fast any edge decays.
- 1 bp/side is a flat estimate for SPY with marketable orders; no queue position, adverse selection, or fees beyond that.
- 22 sessions were dropped for not having exactly 78 clean regular-hours bars (early closes, gaps, malformed prints); none were patched.
- Same-slot averages need 20 prior sessions, so the first 20 sessions are warm-up only.
- One ticker, one bar size, one split. A pass is a lead to forward-test, not proof.
