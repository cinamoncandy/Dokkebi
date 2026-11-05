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
