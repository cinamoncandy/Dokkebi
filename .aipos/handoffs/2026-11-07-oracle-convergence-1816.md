# CORE handoff — 2026-11-07 — #1816 Exact-Main Oracle Convergence

## Fresh canonical state

- Protected main was fetched as `0209466469fe45b7f90dbeefb96d4a9e27cfb3b2`.
- Existing PR #3000 is OPEN/Draft, current remote head `3966f8ba1bc192ffd3d80ff8429d129c4733df48`, base `2224d7f8e2f58081cf3edcd2597ea7048e07f70a`; PR and Issue #1816 were reused.
- Local implementation branch `fix/oracle-convergence-host-evidence-1816` was fast-forwarded to that remote PR head and current protected main was merged. The only textual conflict was generated `.aipos/CURRENT_TRUTH.md`; it was regenerated with the repository generator. The merge and repair are still uncommitted.
- Four untracked `docs/audits/*2026-11-05*` artifacts are preserved and excluded from the change.

## Current repair

- The receipt verifier now requires both the deployed `/opt/nusa/current` SHA and `runtime.sourceCommitSha` from the successful Host Diagnose `/health` response to equal protected main and the successful Release SHA.
- It downloads the current, non-expired, bounded release artifact and verifies the downloaded ZIP SHA-256 against GitHub's artifact digest. It records run/attempt/job IDs and hashes of the Release and Host Diagnose job-log archives.
- The Watchdog invokes the same read-only verifier before dispatching the existing receipt workflow. It refuses if the checked-out watchdog source differs from main, the Oracle evidence is incomplete, or protected main moved. It still never dispatches a Release or accesses/mutates the host.
- `RELEASE_PROVENANCE_UNKNOWN` remains unchanged. No readiness, trading, risk, or authority policy was changed.

## Read-only runtime evidence

- Exact-main Oracle PAPER Release `42310426982`, attempt 1, succeeded for `0209466469fe45b7f90dbeefb96d4a9e27cfb3b2`; its non-expired `nusa-paper-release` artifact was ID `13547234011`, 25,098,146 bytes, digest `sha256:73741e5ce29c2b856e4b45390bd88ac3c36b11569683d5ed66101a4d1082abd1`.
- Read-only Host Diagnose `42313636735`, attempt 1, succeeded later on runner ID 24. Its `/health` response at `2026-11-06T23:42:13.591Z` reported `runtime.sourceCommitSha=0209466469fe45b7f90dbeefb96d4a9e27cfb3b2`; the `current_release` read-link named the same SHA.
- The older Convergence run `42312068928` failed before the Release completed. No post-Release machine-readable Convergence receipt has been issued; the read-only records above are not a canonical receipt.

## Validation and next step

- Focused Oracle convergence tests: 14/14 PASS, including artifact digest/expiry, runtime SHA mismatch, wrong/stale Host Diagnose, run-attempt mismatch, API failure redaction, main movement, and Watchdog ordering.
- Full suite, typecheck, build, `validate:full`, security, lint, workflow/AIPOS checks and exact-head CI have not yet been run on this merged repair state.
- Complete the specified validation, inspect the exact diff, commit and push only to the existing #3000 branch, then verify exact-head CI/companions. A fresh separate Validator must review that successor SHA; no Review, Formal Validator, Audit, Release authorization, merge, new deployment, or readiness PASS is claimed here.

Safety remains `PAPER_ONLY`, `liveAuthority=NONE`, `productionMutationAllowed=false`, `realOrderAuthority=false`, `realTransferAuthority=false`, `aiAuthority=ZERO_AUTHORITY`.
