# CORE handoff — service stop and restart, second trade-flow pre-registration, closed drafts (2026-11-14)

Observed: `2026-11-14` (Asia/Seoul), about 14:20 KST. Everything below is what the records claim; re-verify on GitHub and `/health` before acting. This supersedes `2026-11-13-main-handoff.md` for the host state, the trade-flow schedule and the release rules.

## Canonical state

- Protected `main`: `8868dfc6d` (merge of #3110). The host runs `324768cd4` (release #289, 2026-11-14 13:20-13:23 KST; `nusa` and `nusa-autopilot` active, `NRestarts` 0, `/health` ok). That release carries #3103, #3106 (streamed, verified SQLite recovery snapshots) and #3107 (per-market gap-fill health, market key length capped at 32).
- Merged after the release, **not on the host yet**: #3110 (study script, research hook and host diagnosis for the second trade-flow study). It takes effect with the next release.
- Safety is unchanged: PAPER_ONLY, `liveAuthority=NONE`, `productionMutationAllowed=false`, `aiAuthority=ZERO_AUTHORITY`. Nothing in this period touched a limit, threshold, gate, risk setting or capital.

## What happened

- The `nusa` service was stopped from about 2026-11-13 19:00 KST until the release of 2026-11-14 13:20 KST (about 18 hours). The collector for ticks and order books runs inside it, so nothing was recorded; `/health orderBookCoverage` showed 164 of 192 hours and a longest gap of 18 hours. The service came back through release #289; the release workflow had been disabled and was re-enabled with `gh workflow enable` (owner: "1").
- The first trade-flow run (`ML_TRADEFLOW_60M_20261113`) now has about 14 gap hours inside its 168-hour training span (bar: 152 hours). It will most likely end `INSUFFICIENT_DATA`; that is an expectation from counts, not a result. Its rules are unchanged.
- Second pre-registration merged (#3109): `docs/RESEARCH_PREREG_2026-11-14_TRADEFLOW_60M_V2.md`, study id `ML_TRADEFLOW_60M_20261114`, same rules, train 2026-11-15T06:00Z..11-22T06:00Z, validation ..11-24T06:00Z, holdout ..11-28T06:00Z, K = 201 (p < 0.05/201). Nobody may read tick values from 2026-11-15T06:00Z before the run.
- Revived and merged: #3105 (workflow guard against unknown `with:` keys), #3106, #3107. Closed as superseded or stale: #3001, #3014, #2948, #2975, #2976, #2998, #3004, #3007, #3018 and the ten oldest drafts (#1994, #1962, #1943, #1942, #1941, #1923, #1909, #1818, #1814, #1812).

## Schedule

- 2026-11-14 09:17 KST: the first `TRADEFLOW_STUDY` line was `WAITING_DATA` (7 days collected), as expected.
- 2026-11-15 09:16 KST: next Research run (refreshes the candle freshness, which shows `CANDLES_STALE` after the stop).
- 2026-11-21 09:16 KST: first possible result of the first trade-flow study; record it in `docs/research-ledger/experiments.json` and a work order. The order-book study 2 verdict is read on the 2026-11-19 09:17 run (or 11-18 11:00 KST or later).
- After the first trade-flow result is recorded on 2026-11-21 (not before), perform at most one release before 2026-11-24T06:00Z (15:00 KST), carrying #3110 so that the second study runs. A release backup stalls collection for about 30 minutes; one release inside the span is acceptable (the bar allows 16 missing hours), **none during the holdout** (2026-11-24T06:00Z..11-28T06:00Z). The second study cannot be read before 2026-11-28T06:30Z (first Research run after that: 2026-11-29 09:16 KST).
- During the research span (to 2026-11-28) a stop or restart of the host services leaves a gap that cannot be repaired; announce any planned stop first.

## Release path notes

- `oracle-paper-release.yml` takes only the current protected-main SHA, so it cannot redeploy an older release; it ships whatever main holds. It needs successful exact-source CI; the backup step runs about 30 minutes and must not be cancelled.
- A workflow that is `disabled_manually` cannot be dispatched; the owner's mobile view shows no enable button, and an agent can re-enable it with `gh workflow enable` only when the owner states it explicitly.

## Open items and owner-only decisions

- #2955 (daily security-gate watch workflow, needs `issues: write`): held for an owner decision on that permission. #3008 (canary tools, no caller), #3000 and #2996 (release evidence path) are left open and untouched during the research span.
- FORGE L2 stages 1 and 2 stay held for an owner structure decision; no fake callers.
- Owner-only as before: coding engine and keys, `NUSA_AUTOPILOT_CODING_ENABLED`, sandbox scope, any region-block workaround for futures, the FORGE envelope scope.
- Daily host check (`trig_01EsThfZSo7b3Qog4fDVGb19`): report only abnormal state. After the stop: `candleStaleSeries` 1 and `CANDLES_STALE` until the next Research run.

## Not verified

- Whether `nusa` stays up after the restart: an evening check is scheduled for 17:30 KST.
- The per-market eligibility result of the first study (needs the run on 11-21).
