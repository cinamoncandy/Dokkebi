# Recovery triage — 2026-10-30 (static analysis of the repository; nothing here was read on the host)

Author: CORE session. Scope: the owner's recovery work order (TICK_ERROR, Research data, MCP, main-vs-runtime delta, learning loop,
off-host backup). PAPER_ONLY, `liveAuthority=NONE`, `productionMutationAllowed=false`, `aiAuthority=ZERO_AUTHORITY`.
No host access: the read-only diagnosis workflow ran on the runner `nusa-paper-host` (still the OLD host) and was cancelled at its time
limit three times (runs 40998484773, 41038648650 and earlier). The new host has the runner software installed but not registered.

## main vs the running runtime (`c59b522...` -> `603e7c653`)

345 commits, but only 19 non-test cloud source files changed (5 added, 8 modified, 6 deleted as unreachable) plus one contract file.
No schema change (no CREATE/ALTER TABLE, no `PRAGMA user_version`). No change to any qualification-pinned module
(`cloudPaperCanonicalRiskGateway.ts`, `paperTradingExecutionLoop.ts`) or to `moduleQualificationV1.ts`. Runtime-affecting changes:

- Lease: `paperLeaseStartupWindow.ts` (measure the startup window), "renew PAPER lease at startup handoff / after synchronous composition",
  "keep research backfill lease-responsive" (#2873 family). Relevant to PAPER_WRITER_LEASE_LOST restarts.
- Risk: `paperRiskLimitScaling.ts` scales KRW PAPER limits with initial capital (tighten only); closed-learning `riskConfigHash` uses the
  scaled limits. Capital 100,000 KRW is merged but not running on `c59b522`.
- Research evidence: `closedCandleAggregator.ts` accepts per-tick source fingerprints (#2815) and requires complete candle evidence
  provenance (`e456cd0d7`); `researchCandleBackfill.ts`, `researchExperimentComposition.ts`, `researchExperimentOrchestrator.ts` changed.
- Display only: funnel reason codes, `learningPipelineStage.ts`, `learningPipelineAlarm.ts`, `healthExport.ts` (off by default).

Conclusion: moving the runtime to main is not a schema migration and does not touch the pinned risk/execution modules. It still needs the
governed release path (current-main CI, backup/rollback readiness, exact SHA read-back). It must not be forced because the SHAs differ.

## TICK_ERROR: where the cause is already published

`closedLearningProductionRuntime.ts` runs each tick as: `paperRepository.verifyWriterLease()` -> refresh durable cycles -> bootstrap ->
rollover -> meta-learning. Any throw is caught, recorded by `loopStatus.observeError(now, tickErrorClass(error))` and rethrown.
`tickErrorClass` returns a bounded, message-free class (a Node/errno `code`, else the error name, else `UNKNOWN_ERROR`).
`closedLearningLoop.lastErrorClass`, `lastBlockedReason` and `lastBlockedAt` are published in `/health` and the field already exists in
`c59b522`. So the root cause does not need the host journal: read those three fields from the public `/health` of the new host.
Evidence from the 2026-10-29 journal (old host): `[closed-learning] scheduler failed closed: PAPER_WRITER_LEASE_LOST` followed by
`runtime exited code=1 ... restart in 1000ms`. The first statement of a tick is `verifyWriterLease()`, so a lost lease is a candidate
first-broken transition. UNVERIFIED for the new host: only `lastErrorClass` on the new host's `/health` can confirm it.

## Research: manifest = 0 is the materializer refusing, not a missing job

`researchExperimentComposition.ts` calls `materializeResearchDatasetManifest` itself when candle coverage is complete. The materializer
(`researchDatasetManifestMaterializer.ts`) throws unless: every candle has explicit volume; source closes are contiguous (no gap);
every base candle is covered by a raw-source receipt (`MANIFEST_PROVENANCE_REQUIRED`); the derived aggregate hash equals the stored one.
Reported: 53,040 candles, 33,995 without volume, 303 gaps. Each one alone makes the materializer refuse, so manifest = 0 and
`SKIPPED_DATASET_MANIFEST_MANIFEST_NOT_FOUND` follow. Classification (from the code, not from the host):

- volume missing 33,995 (about 64%): SOURCE_MISSING / PROVENANCE_UNKNOWN for the old rows. They were written before volume and
  per-tick receipts were required (`db35ee55d`, `e456cd0d7`), and `c59b522` does not contain those fixes. They must not be filled in.
- 303 gaps: RECOVERABLE where the hourly gap fill (`researchCandleBackfill.ts`, shown in `/health` by `a9be9d4ce`) can fetch the source
  candles again; otherwise EXPECTED_GAP/SOURCE_MISSING. Which of the 303 are which is UNVERIFIED (needs the host database).
- Dataset sealing stays on hold until a contiguous window with volume and receipts exists; do not synthesize candles.

## MCP external client

Not verifiable from the repository or the cloud sandbox (no endpoint, no credential, outbound proxy). Needs an external client run by the
owner: HTTPS -> Bearer -> initialize -> list -> one read-only tool call. Do not paste the Bearer token in chat or logs.

## Not verified / blocked

- Host state of the new server, its running SHA, `/health`, the three `closedLearningLoop` fields: runner not registered on the new host.
- Off-host backup and remote restore: BLOCKED (no approved remote store, no credential).
- Learning loop end to end (market observation -> PAPER fill -> durable evidence -> learning cycle -> restart): not verified.

## Next canonical transitions

1. Owner removes the old `nusa-paper-host` runner and registers the new host's runner with name and label `nusa-paper-host`.
2. Read `/health` of the new host: `sourceCommitSha`, `closedLearningLoop.lastErrorClass/lastBlockedReason/lastBlockedAt`, candle gap fill.
3. Governed release of current main to the new host (backup, rollback readiness, exact SHA read-back); then re-read the same fields.
