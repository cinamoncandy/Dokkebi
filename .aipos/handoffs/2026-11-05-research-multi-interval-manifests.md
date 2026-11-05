# CORE handoff — 2026-11-05 — #2815 configured interval manifests

## Fresh ownership and source finding

- Protected main was read from GitHub branch metadata at `185c52c22691a5a35b13fe024cb39d810719a833`.
- #3000 and #3001 are separate OPEN/Draft PRs at their reported exact heads. Neither has submitted reviews or inline review threads. Do not count this CORE session's inspection as an independent review; both PR authors are `cinamoncandy`.
- #2879 is CLOSED/MERGED. Its per-event fingerprint fix is present on main: one stable source is required, valid distinct event fingerprints are accepted, and aggregate identity is deterministic. The module's collector is not connected to the production canonical candle writer.
- The canonical OHLCV writer is `researchCandleBackfill.ts`; it stores explicit Upbit REST minute candles and source-page material receipts. `researchExperimentComposition.ts` currently materializes a manifest only for 1m, while each configured interval asks the manifest store for its own interval key.
- Existing `AggregatedResearchCandleSource` and `materializeResearchDatasetManifest` already provide the read-only aggregation and strict explicit-volume/raw-receipt/content checks needed for longer interval manifests.

## Scope and concurrency

This successor addresses only missing configured-interval manifest materialization under Issue #2815. PR #3001 remains display-only. PR #2975 owns bounded freshness cadence/progress; #2979/#2980 own rolling-holdout changes and also touch `researchExperimentComposition.ts`. Their changes are not incorporated or overwritten here. Before publication, recheck their current heads and reconcile any overlapping changes against latest main.

## Safety and claims

No production data, database, runtime, manifest, Research session, candidate, PAPER state, or learning receipt has been changed. Tests can prove only source-code behavior. Actual candle freshness, runtime manifest presence, Research session creation, and learning cycles remain UNVERIFIED until governed exact-main read-only evidence exists.

`PAPER_ONLY`; `liveAuthority=NONE`; `productionMutationAllowed=false`; `realOrderAuthority=false`; `realTransferAuthority=false`; `aiAuthority=ZERO_AUTHORITY`.

## Implementation and local validation checkpoint

- Implementation reuses the existing verified 1m REST candle store and `AggregatedResearchCandleSource` to materialize manifests for every configured interval after successful backfill or gap-fill. Incomplete leading aggregate candles are omitted; no ticker-derived zero-volume candle or synthetic receipt is introduced.
- Replaying identical source material returns the existing immutable manifest and preserves its original `createdAt`; conflicting canonical content fails closed.
- Focused composition tests: 15/15 PASS, including 1m/15m/60m/240m materialization, partial 240m boundary omission, deterministic replay, and missing receipt rejection.
- Full isolated test suite: 1327 test files PASS. `preflight`, build, typecheck, `validate:full`, `security:gate`, `lint:scripts`, AIPOS truth/index/YAML/provenance validation, and `git diff --check` PASS. Lint: 0 errors / 47 existing baseline warnings.
- The suite removed the tracked `isolated-test-failure.txt` during execution; the exact tracked file was restored from the worktree base. Four untracked audit reports in `docs/audits/` are preserved and excluded from this work.
- Current main was freshly fetched and remains `185c52c22691a5a35b13fe024cb39d810719a833`. PR #2975 is conflicting with main; #2979/#2980 are separate rolling branches. This work does not modify those branches or take their cadence/rolling-holdout scope.
- PR #3000 and #3001 still have zero submitted reviews and no inline review threads. This author session cannot supply their independent review. Their exact-head workflow results were freshly checked earlier in this execution and remain distinct from review/approval.

## Remaining acceptance

Draft PR #3002 was opened from implementation commit `1ccd50f1e39900c679cceeee133ad1c4acd9aaef`. Its exact-head CI run `42041990038` and all five companion workflows (`42041989907`, `42041989956`, `42041990012`, `42041989852`, `42041990302`) passed. The AIPOS handoff update creates a successor SHA, so these checks are predecessor-only; fresh exact-head CI is required again.

PR #3002 has no submitted review or review request yet. An eligible non-author Research/Data reviewer is still required; this CORE author session will not claim independent disposition.

No Oracle runtime, actual candle advancement, manifest persistence on production, Research session, holdout, learning cycle, or #2815 completion is claimed. After successor exact-head CI, obtain independent Research/Data review and then follow the separate Validator/Audit/Release gates.
