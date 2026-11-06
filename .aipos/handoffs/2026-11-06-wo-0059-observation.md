# WO-0059 PAPER Observation Handoff — 2026-11-06

## Scope and owner

- Work order: `WO-0059-PAPER-OBSERVATION-20261106`
- Canonical PR: #3006, branch `WO-0059-PAPER-OBSERVATION-20261106`
- Scope: bounded, read-only observation of natural PAPER Decision and execution evidence. No runtime authority, order path, readiness threshold, or Research collection change.
- Safety remains `PAPER_ONLY`, `liveAuthority=NONE`, `productionMutationAllowed=false`, `realOrderAuthority=false`, `realTransferAuthority=false`, `aiAuthority=ZERO_AUTHORITY`, fail-closed.

## Current exact-head evidence

- Protected main and PR base: `2224d7f8e2f58081cf3edcd2597ea7048e07f70a`.
- PR head: `537f3d8e48e32c7ca63b01a7610076fa501cffa9`; PR #3006 is OPEN, Ready, and mergeable.
- Exact-head CI `42208707239` and five companion workflows `42208707210`, `42208707179`, `42208707184`, `42208707263`, `42208707379` are terminal SUCCESS (6/6).
- Local focused tests 34/34 and full isolated suite 1,335 files passed at this source head; typecheck, `validate:full`, security, AIPOS/workflow validation, diff-check passed; lint has 0 errors and 47 baseline warnings.
- Fresh read-only `NUSA_AGENT_ROLE=validator` technical disposition `5799431551` is ACCEPTED for the scoped harness, P0/P1/P2=0, with no review threads. The validator session is separate, but GitHub identity `cinamoncandy` is also the PR author. This is not a non-author APPROVE, Formal Validator receipt, Audit, or Release authorization.

## PAPER observation and root-cause boundary

Run `42208707379`, artifact `13498272063`, is bound to exact head `537f3d8e48e32c7ca63b01a7610076fa501cffa9`. Artifact digest: `sha256:8f0ba7dfc83bfed04e2a6372a46634a8747d7a54d8adff7d93dfaeb3207079e4`.

The real Upbit PUBLIC KRW-BIRB observation lasted 60.866 seconds and recorded 54 natural Decision cycles; all recorded decisions were WAIT/INSUFFICIENT_HISTORY, with final reason `INSUFFICIENT_SMA_OBSERVATIONS:1/20`. There were no PAPER orders or fills and no account/PnL change. SIGNAL and RISK were NOT_OBSERVED; PERMISSION was observed as skipped. The 250-event evidence boundary was reached, so the artifact marks evidence truncated and remains `INCOMPLETE_NO_AUTONOMOUS_ORDER_FILL_PNL`.

For this isolated E2E run, `scripts/actual-paper-runtime-e2e.js:632` deletes and recreates its `state.sqlite` working directory. `apps/cloud/src/ownerBaselinePaperStrategy.ts:98` uses SMA 5/20, `apps/cloud/src/paperCandidateStrategy.ts:90-91` returns WAIT until 20 observations exist, and `apps/cloud/src/paperMinuteBars.ts:8-27` uses only completed one-minute closes with no forward fill. The 1/20 result is therefore `WARMUP_NOT_COMPLETED` for this fresh isolated run, not a proven strategy defect. Do not shorten warm-up or synthesize market data, signals, orders, fills, or PnL.

This does not establish history in the canonical deployed PAPER database. A fresh read-only host check found `nusa.service` active on `nusa-datascale`, while `/opt/nusa/current` resolves to release `185c52c22691a5a35b13fe024cb39d810719a833`, behind protected main `2224d7f8e2f58081cf3edcd2597ea7048e07f70a`. The service data path is `/var/lib/nusa`, outside the current SentinelX read allowlist. The enrolled `nusa-paper-codex` host is offline. Canonical runtime candle history therefore remains `UNVERIFIED`; the isolated GitHub run cannot replace a production DB read.

## Event cap

The observation path conservatively sets `event_evidence_truncated` when the read-only projection reaches its 250-event boundary and cannot return observation `PASS` while truncation is set. The actual artifact preserves this limitation explicitly. No exact omitted-event count is available without a cursor/counter delta; do not infer one or increase the cap without a bounded-summary contract.

## Next permitted action

Obtain an approved read-only query or existing safe read-only API for the deployed PAPER market's completed one-minute candle count, timestamp range, gaps, and source provenance. Do not widen SentinelX paths, access or mutate the database directly, deploy/restart, or change readiness semantics. Keep formal validation, Audit, Release authorization, governed merge, production runtime acceptance, and PAPER readiness as separate pending gates.
