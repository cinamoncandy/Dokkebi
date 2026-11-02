# ORDERBOOK study outcome — 2026-10-31 (read-only checks on the new host, reported by the owner's operator; not re-read by CORE)

Study: `ML_ORDERBOOK_60M_20261029` (`WO-RESEARCH-20261014-ORDERBOOK-STUDY`, script `scripts/run-orderbook-study.js`).
PAPER_ONLY, `liveAuthority=NONE`, `productionMutationAllowed=false`, `aiAuthority=ZERO_AUTHORITY`. Nothing was changed on the host, no rule was
changed, no result file was created.

## What was observed (operator's read-only report; CORE did not read the host)

- `nusa-research.timer` is enabled and active, runs daily 09:15 KST; the last service run exited 0.
- The service journal holds `ORDERBOOK_STUDY {"status":"INSUFFICIENT_DATA","markets":301,"eligible":0}` for 2026-10-30 and 2026-10-31.
- `orderbook-study-result.json` does not exist on the new host. By design (`run-orderbook-study.js`, `researchStudyResult.ts`) it is written only for
  `HOLDOUT_PASS` / `HOLDOUT_FAIL`, so `/health` `orderBookStudy` is `null`.
- `research_orderbook_samples` holds about 5.96 million rows over 301 markets (KRW-XRP about 254 thousand).
- Pre-registered eligibility needs a book in >= 90% of training decision hours (192 h, 2026-10-15..10-23) and median training spread <= 20 bp.
  KRW-XRP recomputed with the same rule: complete hours 115 / 192 (59.9%), median spread 5.66 bp. The spread passes; the hour coverage fails (77 missing hours, several long gaps).
- The identical 115 / 192 result was computed on the migration snapshot (`/var/lib/nusa/.migration-final/state.sqlite`), so the gap predates the
  move to the new host; it was not lost in the migration.
- The old host is offline, so a result file or the 2026-10-29 journal line on it could not be read. UNVERIFIED.

## Reading

The study stopped at its own pre-registered data condition (`eligible = 0` -> `INSUFFICIENT_DATA`); it never reached a holdout verdict. This is a defined
terminal status of the study, not a PASS or FAIL, and it is not an experiment in the ledger's configuration/holdout count.
FIRST_BROKEN_TRANSITION: order-book hour coverage in the training window (59.9% against 90%) -> eligible markets 0 -> no holdout -> no result file ->
`orderBookStudy = null` -> the app says the server has not sent a result.

## Not allowed

Lowering the 90% coverage or the spread rule, shortening the training window, filling the 77 missing hours with generated or interpolated books, copying or
writing a result file by hand, or re-running the study with changed rules. The missing hours may only be repaired from original data that carries its
source receipt (UNVERIFIED that any exists: public order books are snapshots, so a past book is normally not retrievable).

## Open choices for the owner

1. Close the study honestly as `INSUFFICIENT_DATA` (recommended) and, if a new order-book study is wanted, pre-register a new one on data collected from now
   on, with a coverage check first.
2. Check the old host's disk (when it is reachable) for a result file or the 2026-10-29 journal line. Copy a file unchanged only if it exists.
3. App wording: today the 호가 row says the server has not sent a result after the verdict time. The truth is "the study ran and ended for lack of data".
   A display-only status object from the research service (not an input to the ledger) would let the app say so. This touches a host script, so it needs an
   explicit owner decision.
