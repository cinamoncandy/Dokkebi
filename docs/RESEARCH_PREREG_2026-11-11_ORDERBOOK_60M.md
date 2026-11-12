# Pre-registration: ORDERBOOK+INTRADAY+ALL_KRW+ML 60m, second run (PAPER research)

Status: **PRE-REGISTERED, 2026-11-11 (KST), before any order-book VALUE of the span below was examined.** Nothing here may change once this
file is on main; any change starts a new pre-registration with a new date.
Work order: `WO-RESEARCH-20261111-ORDERBOOK-PREREG`. Supersedes the closed `ML_ORDERBOOK_60M_20261029`
(`WO-RESEARCH-20261014-ORDERBOOK-STUDY`, closed 2026-10-31 as `INSUFFICIENT_DATA`).

Scope: PAPER research only. No order, no account, no runtime wiring, no limit change. A PASS makes the rule eligible for a forward SHADOW test;
it is **not** promotion evidence.

## 1. Why a second run, and why the rules do not change
- The first run never produced a result: `status=INSUFFICIENT_DATA`, 115 of 192 training hours had a book (59.9%, bar >= 90%). No holdout or
  validation number was ever seen, so there is nothing to tune against. Re-running the same rules on new data is not a reaction to a result.
- Since then the collector has run steadily (301 markets, about 430k rows per day, 0 failures). On 2026-11-11 08:00Z `/health` reported
  `orderBookCoverage` for KRW-XRP: 185 of 192 hours (96.4%), longest gap 3 h. Only the presence of rows was counted, never their values.

## 2. Rules: identical to `scripts/run-orderbook-study.js` as merged, except the span
Every feature, window offset, eligibility rule, model, execution, cost, selection rule and PASS condition is the one written in that file's
header comment (decision every hour on the hour; book at t = last sample in (t - 2 min, t]; features and standardisation; buy at the best ask,
sell at the best bid 60 minutes later; fee 0.05% per side, stress 2x fee plus 5 bp per side; L2 logistic regression with lambda in {0.1, 1, 10}
chosen by validation mean net per trade; top 3 eligible markets per hour, equal weight; eligible = a book at >= 90% of training decision hours
and median training spread <= 20 bp). The hypothesis count stays K = 195 (192 configurations + 3 lambdas); the PASS bar stays p < 0.05 / 195.

## 3. The only new numbers: the span (fixed now, partly in the future on purpose)
| Part | From (UTC) | To (UTC) |
|---|---|---|
| Train | 2026-11-04T00:00Z | 2026-11-12T00:00Z |
| Validation | 2026-11-12T00:00Z | 2026-11-14T00:00Z |
| Holdout | 2026-11-14T00:00Z | 2026-11-18T00:00Z |

- Decision rows whose 60-minute exit would cross into the next part are dropped, as before.
- The validation and holdout hours do not exist yet. That makes the holdout a true forward test. Nobody may read order-book values from
  2026-11-14T00:00Z on before the run, and the run may not start before 2026-11-18T00:30Z.
- Data comes from the live table and the study archive (`scripts/lib/orderBookSource.js`), read-only, as in the first run.

## 4. Preconditions and what happens when they fail
- The run reports `INSUFFICIENT_DATA` exactly as before if a market is not eligible; it never fills, generates or interpolates a missing hour.
- If fewer than 3 markets are eligible, or the holdout has fewer than 50 trades, the result is `HOLDOUT_FAIL` / `INSUFFICIENT_DATA` and is recorded as such. The
  rules are not changed and the study is not re-run on the same span.
- Any host stall that leaves a gap is not repaired afterwards. Releases that run a backup stall `/health` and may interrupt collection for
  about half an hour; avoid releasing during the span if it can be helped (a gap only counts against the 90% eligibility bar, nothing else).

## 5. Recording
- The result line `ORDERBOOK_STUDY {...}` is read from the service journal by the read-only host diagnosis, as in the first run, and recorded
  in the work order and the ledger. The dataset identity (sha256, row count, range) is part of the line.
- A PASS is recorded as eligible for a SHADOW test only. A FAIL is recorded in the ledger like any other failed configuration.

## 6. What this document does not do
- It does not change the study script, the service, any limit, threshold, risk, capital or authority.
- Making the script accept this span (a constants change guarded by the study id) is a separate PR that must land before 2026-11-18.
