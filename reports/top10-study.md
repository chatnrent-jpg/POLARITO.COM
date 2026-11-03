# Top-10 SPY holdings study (daily)
Generated 2026-11-03 | feed `sip` | NVDA, MSFT, AAPL, AMZN, GOOG, META, AVGO, TSLA, BRK.B, JPM | development < 2022-01-01 <= hold-out | cost 2 bps/side

**Verdict:** No bucket cleared the development bar across the 10 stocks (24 tests, date-clustered Bonferroni p < 0.0021). The signal shows no statistically defensible drift-adjusted edge on these names at 1/5/20-day horizons.

## Protocol (fixed before looking at results)
1. Universe (fixed up front, approximating SPY's ten largest holdings): NVDA, MSFT, AAPL, AMZN, GOOG, META, AVGO, TSLA, BRK.B, JPM. GOOG kept, GOOGL excluded (same company).
2. Floors 0.1x, 1x, 1.5x, 2x x Drive/Reverse x 1D/5D/20D = 24 tests. Entry = next open.
3. Directional edge = polarity x (forward return - that ticker's own average forward return in the same sample). > 0: stock moved WITH the signal; < 0: AGAINST it.
4. Pooled across tickers; p-values clustered in blocks of 2H sessions (cross-stock same-day correlation + overlapping windows), Student-t on clusters-1 d.f. Dev bar: Bonferroni 0.0021, n >= 300.
5. Dev signals whose 20-session window reaches 2022-01-01 are purged. Hold-out used once: same sign, p < 0.05, n >= 150.
6. Tradeable = (a) edge per signal minus round-trip cost > 0 at 2 and 4 bps/side, (b) same after removing the best ticker, (c) positive net Sharpe of the equal-weight strategy.

## 1. How often does each floor fire (all 10 stocks)?
| Floor | Drive | Neutral | Reverse |
| --- | --- | --- | --- |
| 0.1x | 51.8% | 0.1% | 48.2% |
| 1x | 19.0% | 61.7% | 19.2% |
| 1.5x | 3.8% | 91.4% | 4.7% |
| 2x | 1.2% | 97.1% | 1.7% |

## 2. Directional edge by floor: development vs hold-out
Expect about 1.2 of 24 buckets to look "significant" at 5% by luck; the dev gate is Bonferroni-corrected.

| Floor | Signal | Horizon | Dev n | Dev edge | Dev p | Hold n | Hold edge | Hold p | Candidate | Confirmed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1x | Drive | 1D | 7651 | -8.3 bps | 0.009 | 6241 | -3.0 bps | 0.510 | - | - |
| 0.1x | Drive | 5D | 7651 | -11.6 bps | 0.355 | 6226 | -10.8 bps | 0.590 | - | - |
| 0.1x | Drive | 20D | 7651 | -25.2 bps | 0.607 | 6158 | -24.3 bps | 0.780 | - | - |
| 0.1x | Reverse | 1D | 7049 | -9.2 bps | 0.010 | 5876 | -3.2 bps | 0.538 | - | - |
| 0.1x | Reverse | 5D | 7049 | -13.1 bps | 0.396 | 5851 | -11.4 bps | 0.557 | - | - |
| 0.1x | Reverse | 20D | 7049 | -27.7 bps | 0.582 | 5769 | -26.2 bps | 0.771 | - | - |
| 1x | Drive | 1D | 2806 | -14.1 bps | 0.004 | 2298 | -7.4 bps | 0.330 | - | - |
| 1x | Drive | 5D | 2806 | -22.1 bps | 0.197 | 2287 | -11.8 bps | 0.654 | - | - |
| 1x | Drive | 20D | 2806 | -48.1 bps | 0.318 | 2263 | -40.7 bps | 0.678 | - | - |
| 1x | Reverse | 1D | 2758 | -10.9 bps | 0.080 | 2405 | -6.5 bps | 0.433 | - | - |
| 1x | Reverse | 5D | 2758 | -14.0 bps | 0.515 | 2392 | -15.3 bps | 0.544 | - | - |
| 1x | Reverse | 20D | 2758 | -18.1 bps | 0.713 | 2361 | -24.2 bps | 0.802 | - | - |
| 1.5x | Drive | 1D | 608 | -27.1 bps | 0.011 | 423 | -21.5 bps | 0.231 | - | - |
| 1.5x | Drive | 5D | 608 | -43.7 bps | 0.186 | 421 | -9.2 bps | 0.808 | - | - |
| 1.5x | Drive | 20D | 608 | -146.5 bps | 0.013 | 420 | -90.9 bps | 0.337 | - | - |
| 1.5x | Reverse | 1D | 756 | -26.7 bps | 0.046 | 509 | -12.5 bps | 0.510 | - | - |
| 1.5x | Reverse | 5D | 756 | -39.4 bps | 0.190 | 499 | -26.3 bps | 0.591 | - | - |
| 1.5x | Reverse | 20D | 756 | -13.8 bps | 0.814 | 494 | -50.2 bps | 0.660 | - | - |
| 2x | Drive | 1D | 185 | -7.6 bps | 0.724 | 144 | -22.8 bps | 0.432 | - | - |
| 2x | Drive | 5D | 185 | 21.1 bps | 0.622 | 142 | -23.3 bps | 0.717 | - | - |
| 2x | Drive | 20D | 185 | -100.0 bps | 0.349 | 142 | -149.5 bps | 0.131 | - | - |
| 2x | Reverse | 1D | 291 | -31.9 bps | 0.095 | 169 | -9.6 bps | 0.681 | - | - |
| 2x | Reverse | 5D | 291 | -71.2 bps | 0.074 | 165 | -16.9 bps | 0.810 | - | - |
| 2x | Reverse | 20D | 291 | 5.6 bps | 0.937 | 164 | -42.8 bps | 0.751 | - | - |

## 3. Tradeability of confirmed buckets (hold-out 2022-01-01+)
No bucket confirmed, so no strategy was run (testing unconfirmed buckets would data-mine the hold-out).

## Caveats
- **Not clean out-of-sample.** NVDA, MSFT, AAPL, AMZN, META, TSLA and JPM (and GOOGL, the twin of GOOG) were in the earlier 13-ticker discovery set, and AVGO was in the earlier 39-stock validation list; all covered the same period. Only BRK.B is untouched. (* in the by-ticker table marks names used before.)
- **Survivorship.** Today's top 10 are mostly the 2016-2026 winners. The drift adjustment removes this from the event study; buy & hold and any long-biased equity curve are still flattered.
- The universe approximates SPY's top 10 and was fixed before testing; live weights were not verified.
- 2 bps/side is a fair estimate for these mega-caps at the open; the earlier broad study used 5 bps. Short-borrow fees are ignored.
- With few clusters at 20D (about 68 blocks over the full sample) p-values are coarse.
- Same-date stocks are correlated, so 10 stocks are worth far fewer than 10 independent samples.
