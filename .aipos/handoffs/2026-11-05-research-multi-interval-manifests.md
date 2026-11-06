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

## Fresh convergence update — 2026-11-06 03:47 UTC

### Exact-head and local worktree

- Protected main is still `185c52c22691a5a35b13fe024cb39d810719a833`.
- Existing PR #3002 is OPEN/Draft/mergeable at exact head `6c85aaa7f7add65913a7150ba91df28b67b7fce5`, based on protected main. CI run `42155288545` and seven companions `42155288647`, `42155284831`, `42155288527`, `42155288495`, `42155288520`, `42155288636`, `42155288773` are terminal SUCCESS. The causal attestation, causal contract, and audit-dispatch checks are SKIPPED and are not positive causal evidence.
- This worktree was fast-forwarded to the existing remote #3002 branch. Four pre-existing untracked `docs/audits/` reports were preserved and excluded.
- Local `pnpm run build` passed. The focused candle/backfill/composition/retry/progress suite passed 45/45 after build generated the ignored `dist/` output. An earlier direct `node --test` invocation before build failed because the tests load `dist`; the failure disappeared after the canonical build, with no source edits.
- The original description and work-order snapshot still incorrectly say the integrated changes are unpublished and CI-pending. Correct the PR description and append a superseding AIPOS checkpoint before inviting reviewers. A metadata successor changes SHA-bound evidence, so refresh exact-head checks before review.

### Issue #2815 and production read-back

- #2879's per-event fingerprint aggregation correction is already merged; do not reimplement it. `closedCandleAggregator` is not the canonical OHLCV writer. `researchCandleBackfill.ts` writes explicit Upbit REST OHLCV and source-page receipts.
- Current exact-main `/health` read at `2026-11-06T03:47:19.530Z` reports runtime SHA `185c52c22691a5a35b13fe024cb39d810719a833`, `researchCollectionStatus=COLLECTING`, 62,633 candles / 15,840 required, and the Research pipeline stages CANDLES/DATASET/EXPERIMENT as PASS.
- The same bounded health result reports 1m `sessionsStarted=10`; 15m and 60m each report `sessionsStarted=10` but have 120 cumulative `SKIPPED_DATASET_MANIFEST_MANIFEST_NOT_FOUND` counts. These counters do not expose durable manifest IDs or session receipts.
- `dataIntegrity.status=PASS` is not fresh evidence: its embedded observation time is `2026-11-06T00:18:51Z`, over three hours before the health observation. Learning remains `LEARNING_NOT_EVALUATED`, `cyclesEvaluated=0`, `cyclesRecorded=0`, `holdoutPasses=0`; pending reasons include `NO_DEPLOYABLE_CANDIDATE` and `REALIZED_TRADE`.
- Gap-fill reports `lastMaterializeMs=6047`, `maxMaterializeMs=7173`, and `eventLoopMaxStallMs=7123` at nearly the same timestamp. This is a correlated performance signal, not a proven root cause. The new multi-interval synchronous materialization cost must be explicitly assessed before release.
- The host's read allowlist does not include `/var/lib/nusa` or `/var/backups/nusa`; no direct DB access, DB mutation, deployment, restart, or timer trigger was performed. Durable candle continuity, manifest persistence, and source receipts remain UNVERIFIED.

### FORGE L1 scope and related governance

- The canonical L1 scope is the open Issue #1851 acceptance plus owner checkpoint comment `6545892314`, and the active AIPOS work order `WO-AUTOPILOT-20261030-1851-CAUSAL-ADMISSION`. L1 is the isolated, trusted workflow-failure causal admission path through existing CodingRunner; general Research/Learning completion is a separate operating track unless a canonical dependency says otherwise.
- Current main now contains `causalRegressionAdmission.ts`, the `REPOSITORY_CODE_REGRESSION`/`CODE_ACTIONABLE` classification boundary, Worker/coordinator integration, and related tests. Therefore the Nov-3 `docs/FORGE_STATUS_20261103.md` statement that no such code exists is stale. However, no genuine protected-producer positive attestation or end-to-end verification-domain `CODE_ACTIONABLE`/CodingRunner receipt is established; L1 remains PARTIAL.
- PR #2994 is the current isolated verification lane, OPEN/Draft/mergeable but behind main. Its exact head is `89fb28c4e3bfbd172af3df3a998ca4f460e46dad`; its latest checks are from Nov-4 and it has no current exact-head non-author human review. Do not count prior-head Codex/author comments as terminal acceptance.
- PR #3000 is OPEN/Draft at `6bbcc3bc46e3a03905f8c3f369aa13f16d7e1276`; retain existing handoff comment `6652709639` and do not create a duplicate. It has no submitted review. PR #3001 is OPEN/Draft at `2be201ee011256abd77ca0d448b6f87563bff0ed`; CI passes, but it is display-only gap-fill health and has no review. Neither is operating acceptance.
- PR #2975 remains OPEN/Draft and conflicting on an old base; active P1 thread `PRRT_kwDOTUbne86yW75k` has no independent disposition. #3002 incorporates the bounded cursor behavior but must not resolve or declare the #2975 thread superseded.
- Fresh collaborator enumeration returns only `cinamoncandy`, the PR author. A requested non-author review/validator requiring a distinct write-enabled human cannot be supplied by this CORE session; automated review comments are technical input only, not Formal Validator, Audit, Release, or merge approval.

### Safety and next transition

`PAPER_ONLY`; `liveAuthority=NONE`; `productionMutationAllowed=false`; `realOrderAuthority=false`; `realTransferAuthority=false`; `aiAuthority=ZERO_AUTHORITY`; fail-closed. No production `CODE_ACTIONABLE`, deployment, restart, database mutation, or evidence fabrication occurred.

Next: correct #3002's stale scope/validation metadata on its existing branch, run AIPOS/full-contract validation, and publish a single metadata-only successor. Refresh exact-head CI, update the PR description without changing the head, then request a focused exact-head technical review covering Research/Data correctness, work bounds, synchronous materialization cost, and the #2975 predecessor finding. Keep the PR Draft. Human non-author disposition, Formal Validator, Audit, Release, merge, and runtime evidence remain separate gates.
