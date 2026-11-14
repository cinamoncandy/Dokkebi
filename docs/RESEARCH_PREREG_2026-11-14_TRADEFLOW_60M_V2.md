# Pre-registration: TRADES+INTRADAY+ALL_KRW+ML 60m, second run on a later span (PAPER research)

Status: **PRE-REGISTERED, 2026-11-14 (KST), before any trade-tick VALUE of the span below was examined.** Nothing here may change once this
file is on main; any change starts a new pre-registration with a new date.
Work order: `WO-RESEARCH-20261114-TRADEFLOW-PREREG-V2`. Study id: `ML_TRADEFLOW_60M_20261114`.
First run it parallels (not replaces): `ML_TRADEFLOW_60M_20261113` (`docs/RESEARCH_PREREG_2026-11-13_TRADEFLOW_60M.md`).

Scope: PAPER research only. No order, no account, no runtime wiring, no limit change. A PASS makes the rule eligible for a forward SHADOW test;
it is **not** promotion evidence.

## 1. Why a second pre-registration (a data gap, not a result)
- The PAPER runtime service `nusa` was inactive from about 2026-11-13 19:00 KST until the release of 2026-11-14 13:20 KST (about 18 hours; `NRestarts` 0,
  the service log for that period is not readable by the diagnosis account, so the cause is **not known**). The collector that records ticks and
  books runs inside that service, so nothing was recorded in that period. Counts from `/health` afterwards (presence only):
  `orderBookCoverage` 164 of 192 hours, longest empty run 18 hours.
- The first trade-flow run trains on 2026-11-07..11-14, so about 14 hours of that gap fall inside its training span, on top of the earlier empty
  hours already counted (`/health tradeTickCoverage`, 2026-11-13: 188 of 192 hours for the first research market). Its eligibility bar is 152 of 168 training
  hours, so that run will most likely end `INSUFFICIENT_DATA`. This is an expectation from counts, not a verdict: per-market coverage can differ and the
  first run is still allowed to run and report. Its rules are **not** changed.
- This document is written **before** that run reports, so its outcome cannot influence anything below. No price, volume or side of any tick
  of either span has been examined; only hour presence and row totals.
- The earlier disclosure still applies in full: trade flow failed once on 2026-10-13 (`ML_TRADES_FLOW_15M_20261013`: 144 holdout trades, -0.532% per trade
  against -0.279% for the universe, p 0.998), and the first run of this family is itself not blind to that. The prior stays low.

## 2. Rules: identical to the first run, except the span, the study id and the hypothesis count
Hypothesis, features (exactly the six of section 4 of the first document, including the total order of ticks and the market-code tie-break),
eligibility (book at >= 90% of training decision hours, a tick in (t - 1 h, t] at >= 90%, median training spread <= 20 bp), execution (buy at the
best ask at t, sell at the best bid at t + 60 minutes, a decision with no book at t or t + 60m is dropped), costs (fee 0.05% per side; stress 2x fee plus
5 bp per side), model (L2 logistic regression, full batch, 2,000 steps, rate 0.1, zero init, lambda in {0.1, 1, 10} chosen by validation mean net per
trade), selection (top 3 eligible markets per hour, equal weight, hold 60 minutes) and standardisation are the ones of the first document and of
`scripts/run-tradeflow-study.js` as merged at commit `324768cd4837fd62a50a1975eeb989f5f489ef0f`. No threshold, bar or gate is loosened or tightened.

## 3. Span (fixed now, almost entirely in the future)
| Part | From (UTC) | To (UTC) |
|---|---|---|
| Train | 2026-11-15T06:00Z | 2026-11-22T06:00Z |
| Validation | 2026-11-22T06:00Z | 2026-11-24T06:00Z |
| Holdout | 2026-11-24T06:00Z | 2026-11-28T06:00Z |
- Training is 7 days, 168 decision hours; the 90% bar is 152 hours. Collection resumed at 2026-11-14T04:20Z, so even the 24-hour window of `volRatio`
  (read from 2026-11-14T06:00Z) lies after the restart.
- Decision rows whose 60-minute exit would cross into the next part are dropped.
- Nobody may read tick values from 2026-11-15T06:00Z on before the run, and the run may not start before 2026-11-28T06:30Z (the first daily Research
  run after that is 2026-11-29T00:16Z). Counting hours that hold a tick is allowed: it shows no value.
- If the service is down again, the gap is **not** repaired and not filled; it counts against the 90% bars exactly as in the first run.

## 4. Multiple comparisons and the PASS rule
- Hypothesis count K = 201: the 198 of the first run (kept, so that both runs of this family are corrected as one) plus 3 lambdas here.
  PASS needs p < 0.05 / 201 (about 2.49e-4). Counting both runs together is the conservative choice; any looser choice needs a new
  pre-registration and is the owner's decision.
- PASS on the holdout only if all hold: >= 50 trades; mean net per trade > 0; one-sided z-test p < 0.05 / 201; mean net under stress costs > 0; mean net beats
  buying every eligible market at the same hours. Nothing is tuned on the holdout.
- `INSUFFICIENT_DATA` if fewer than 3 markets are eligible or the holdout has fewer than 50 trades. The rules are not changed and this span is not re-run.

## 5. Preconditions for running it
- The study script must know this study id (a constants change guarded by the id, plus its test and a hook that can run both ids) and must be
  released before 2026-11-28. A release runs a backup that stalls `/health` for about half an hour and so costs about one hour of collection; it is
  allowed once inside this span (one hour is far below the 16-hour allowance of the bars) and must not happen during the holdout.
- Until then the first run's script and hook stay as they are.

## 6. Recording
- The result line `TRADEFLOW_STUDY {...}` (fixed status code plus numbers and booleans, dataset identity) is read from the service journal by the
  host diagnosis and recorded in the work order and in `docs/research-ledger/experiments.json`. A PASS is recorded as eligible for a SHADOW test only.

## 7. What this document does not do
- It does not change the first run, the order-book study, the service, any limit, threshold, risk, capital or authority, and writes no study code.
