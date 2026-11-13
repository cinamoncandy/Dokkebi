# Pre-registration: TRADES+INTRADAY+ALL_KRW+ML 60m (trade-flow replication on live-recorded ticks, PAPER research)

Status: **PRE-REGISTERED, 2026-11-13 (KST), before any trade-tick VALUE of the span below was examined.** Nothing here may change once this
file is on main; any change starts a new pre-registration with a new date.
Work order: `WO-RESEARCH-20261113-TRADEFLOW-PREREG`. Study id: `ML_TRADEFLOW_60M_20261113`.
Design draft this replaces: `docs/DRAFT_TRADEFLOW_STUDY_DESIGN_20261112.md` (corrected there: trade flow is not a new signal type).

Scope: PAPER research only. No order, no account, no runtime wiring, no limit change. A PASS makes the rule eligible for a forward SHADOW test;
it is **not** promotion evidence.

## 1. Disclosure: this repeats a hypothesis that already failed once
- `ML_TRADES_FLOW_15M_20261013` (`WO-RESEARCH-20261013-TRADES-FLOW`, 3 configurations, 7 days of public Upbit ticks, 30 markets, splits 4/1/2 days)
  ended `HOLDOUT FAIL`: 144 holdout trades, -0.532% per trade against -0.279% for the universe, win rate 33.3%, p 0.998, stress -0.731%.
- That result was seen before this document was written, so this is **not** a blind test: the failure is a reason the prior is low. The reasons to
  try again are data and power, not a hope that the earlier number was noise: (a) the earlier splits were tiny (1-day validation, 2-day holdout);
  (b) these ticks are recorded live by the host collector for the whole span and have been counted, not read (`/health tradeTickCoverage` for the first
  research market, 2026-11-13: 188 of the last 192 full hours have a tick, longest empty run 4 h); (c) execution uses the order book (best ask in, best
  bid out) as in the order-book study, not a trade price.
- Only **presence** was counted: hours with at least one tick, row totals and column structure. No price, volume or side of any tick was examined.

## 2. Hypothesis
For one KRW market, the signed taker-flow imbalance over the preceding 15 and 60 minutes predicts whether buying at the next full hour and selling 60
minutes later is profitable after costs. Null: the trade-flow features carry no information about the 60-minute net return after costs.

## 3. Rules: identical to `scripts/run-orderbook-study.js` as merged, except the features, the span and one tie-break
Decision every full hour; buy at the best ask at t, sell at the best bid at t+60m (a decision with no book at t or t+60m is dropped); fee 0.05% per
side, stress 2x fee plus 5 bp per side; label = net return after base costs > 0; L2 logistic regression (full batch, 2,000 steps, rate 0.1, zero init)
with lambda in {0.1, 1, 10}, chosen by validation mean net per trade; features standardised with training mean and deviation; top 3 eligible
markets per hour by predicted probability, equal weight, hold 60 minutes. A "book at t" is the last sample in (t - 2 min, t], as in that script. Standardisation uses the mean and the population deviation (divide by n)
of each feature over the training rows of all eligible markets pooled; a feature with deviation 0 is divided by 1. Ties in the predicted probability within one
hour are broken by market code ascending. **This is the one deliberate deviation from the order-book script**, which sorts by score only and so keeps its
input order on a tie. It is written out here because the new script has no earlier behaviour to inherit; it applies in every part (validation and holdout). It changes no
threshold, and exact ties of a floating-point probability are not expected.

## 4. Features (exhaustive; nothing outside this list is used)
Ticks of market m in a window (a, b] are those with `traded_at_ms` in that interval. `side = BID` is a taker buy, `ASK` a taker sell. V_BID and
V_ASK are the volume sums of the two sides.
1. `imb15` = (V_BID - V_ASK) / (V_BID + V_ASK) over (t - 15 min, t]; 0 if the denominator is 0.
2. `imb60` = the same over (t - 60 min, t].
3. `valImb60` = the same with price x volume as the weight, over (t - 60 min, t].
4. `logCount15` = ln(1 + number of ticks in (t - 15 min, t]).
5. `rv60` = sqrt(sum of squared ln(p_i / p_{i-1}) over consecutive ticks in (t - 60 min, t]); 0 if fewer than 2 ticks. "Consecutive" follows one
   fixed total order of the ticks: `traded_at_ms` ascending, then `price` ascending, then `volume` ascending, then `side` ascending (`ASK` before `BID`).
   Ticks of one market that share a timestamp are therefore ordered by that rule, never by storage order. The first tick of the window has no predecessor
   inside the window (the predecessor is not looked up outside it).
6. `volRatio` = ln((V60 + 1e-9) / (V24 / 24 + 1e-9)), V60 = total volume in (t - 60 min, t], V24 = total volume in (t - 24 h, t].
A decision needs at least one tick in (t - 60 min, t], a book at t and a book at t + 60m. There is exactly one feature set: no feature subset
is searched, so the only tuned quantity is lambda.

## 5. Eligibility (training data only)
A market is eligible if all hold: a book at >= 90% of the training decision hours; at least one tick in (t - 1 h, t] at >= 90% of the training
decision hours; median training spread <= 20 bp.

## 6. Span (fixed now, partly in the future on purpose)
| Part | From (UTC) | To (UTC) |
|---|---|---|
| Train | 2026-11-07T00:00Z | 2026-11-14T00:00Z |
| Validation | 2026-11-14T00:00Z | 2026-11-16T00:00Z |
| Holdout | 2026-11-16T00:00Z | 2026-11-20T00:00Z |
- Training is 7 days (168 decision hours; the 90% bar is 152 hours). The 24 h window of `volRatio` reads ticks from 2026-11-06T00:00Z, which is
  inside the counted coverage (the first research market was covered from about 2026-11-05T10:00Z).
- Decision rows whose 60-minute exit would cross into the next part are dropped.
- Validation and holdout hours do not exist yet, so the holdout is a true forward test. Nobody may read tick values from 2026-11-14T00:00Z on
  before the run, and the run may not start before 2026-11-20T00:30Z. Counting hours that hold a tick (`tradeTickCoverage`) is allowed: it shows no value.
- Ticks and books are read read-only from `research_trade_ticks_v2` and `research_orderbook_samples` (and the order-book archive helper), as in the
  order-book study.

## 7. Multiple comparisons and the PASS rule
- Hypothesis count K = 198: 195 (the order-book study's count: 192 ledger configurations plus 3 lambdas, kept for both order-book runs) plus 3 lambdas here.
  The earlier trade-flow run's 3 configurations are already inside the ledger's 192. Counting this study into the same family is the conservative
  choice (it is stricter than counting it alone, K = 6). Whether to pool differently is the owner's decision, and any looser choice needs a new
  pre-registration.
- PASS on the holdout only if all hold: >= 50 trades; mean net per trade > 0; one-sided z-test p < 0.05 / 198 (about 2.53e-4); mean net under stress
  costs > 0; mean net beats buying every eligible market at the same hours. Nothing is tuned on the holdout.

## 8. Preconditions and what happens when they fail
- `INSUFFICIENT_DATA` if fewer than 3 markets are eligible or the holdout has fewer than 50 trades; the rules are not changed and the study is not
  re-run on the same span. A missing hour is never filled, generated or interpolated.
- A host stall that leaves a gap is not repaired afterwards (it only counts against the 90% bars). Releases that run a backup stall `/health` for
  about half an hour; avoid releasing during the span if possible.
- The run fails closed with `DATA_INTEGRITY_FAIL` if any stored tick is stamped more than 5 s after the run time, as in the order-book study.

## 9. Recording
- The result line `TRADEFLOW_STUDY {...}` carries a fixed status code plus numbers and booleans only, and the dataset identity (sha256 over the
  per-hour feature rows in canonical order, row count, observed range). The read-only host diagnosis prints it; it is recorded in the work order and
  in `docs/research-ledger/experiments.json`. A PASS is recorded as eligible for a SHADOW test only; a FAIL is recorded like any other failed configuration.

## 10. What this document does not do
- It does not change the order-book study, the service, any limit, threshold, risk, capital or authority, and it writes no study code.
- The study script (guarded by the study id above), its test and the service hook are a separate PR that must land before 2026-11-20 and may
  implement only what is written here.
