# #1851 local causal binding checkpoint

This is local unfinished work, not an authorization receipt. Fresh protected main was `1a8bb3b261f8e4ac242499a93287da6c370ed4b3`. Existing partial changes are preserved in `/workspace/nusa-1851-actionability` and `/workspace/evidence/1851-oidc-pre-reconvergence-20261030.patch`; the working copy is `/workspace/nusa-1851-latest`. #1854 is closed and its old branch must not be revived.

The local prototype independently verifies GitHub OIDC publisher identity and GitHub publisher/source runs, hashes a random per-dispatch capability, and registers/claims/verifies bindings atomically in the existing ExecutionCoordinator. A claimed publisher run/attempt survives coordinator reconstruction; unclaimed capability rotation is bounded by acquisition generation. Mismatched source, publisher, capability, expired lease, static token, GitHub failure, and replay fail closed. The selected workflow opportunity now must match the request's run and SHA, and scheduled leases record the SHA. The dispatch-event artifact sanitizer removes the capability. A fixed finite truth-table observer exists but is neither an authenticated receipt nor evidence of why a CI run failed. These functions are not wired to a production route or used to produce CODE_ACTIONABLE. Focused OIDC/binding/coordinator/bridge/scheduled/CodingRunner/contract tests: 168/168 PASS; sanitizer 2/2; typecheck PASS.

Remaining before any commit: claimed-generation retry and receipt deduplication; GitHub-verified source attempt; authenticated capability delivery and log redaction; workflow and server integration; trusted deterministic source-run-bound causal producer/verifier; positive and negative end-to-end regression; full local gates. A workflow failure or a verified publisher alone is never causal proof. Preserve PAPER_ONLY, liveAuthority=NONE, productionMutationAllowed=false, realOrderAuthority=false, realTransferAuthority=false, and aiAuthority=ZERO_AUTHORITY.

## 2026-10-31 KST continuation

Local development now includes optional capability transport in the existing GitHub dispatch, an OIDC-only Worker claim endpoint, dispatch artifact redaction, and a signed-OIDC-to-Worker integration fixture. These prove a prototype publisher/source claim path only. The scheduled admission path does not call the bound dispatch helper, and generic workflow failures remain eligible in the existing scheduler. No causal result has been authorized or published.

A push-main CI observation job is also a local prototype. Its JSON artifact and client-supplied fingerprints are not independently authenticated, and an observed truth-table mismatch does not establish the cause of a source CI failure. In particular, source code executing in the producer context can affect its output. Do not treat the artifact, a successful claim, or GitHub run identity alone as CODE_ACTIONABLE. A trusted isolated producer/verification contract, source-run causal binding, replay/deduplication and an integrated admission gate remain necessary. Claimed-generation retries remain fail closed.

Fresh `git ls-remote` observed protected main still at `1a8bb3b261f8e4ac242499a93287da6c370ed4b3`. Script regression tests passed 9/9 and `git diff --check` passed in this continuation. No commit, deployment, audit, release, or merge was performed. Full current-head validation and the production-equivalent positive path are not established.

## Local admission safety gate — 2026-10-31 KST

The existing scheduled workflow-failure route now abstains before lease acquisition and dispatch while causal evidence is unverified. A focused negative test confirms a generic failed CI run cannot acquire a lease or dispatch. This is local WIP, not a deployment or an implemented positive receipt path. After this change, the scheduled suite has four known failing legacy cases that expect generic CI failures to dispatch, suppress a duplicate through acquisition, pin an acquired lease, or dispatch after provider wait. Those cases remain in place pending production-equivalent trusted receipt fixtures and restoration of legitimate duplicate, lease and provider-wait behavior. Do not report the previous 188/188 as current validation. Other entrypoints, causal verifier, receipt provenance and positive path remain unverified; commit remains forbidden.

## 2026-10-31 continuation — isolated Worker crypto and producer attestation

- Fresh protected `main` remains `1a8bb3b261f8e4ac242499a93287da6c370ed4b3`; issue #1851 is open; no open implementation PR was found.
- In `/tmp/sigstore-worker-probe` only, a per-entity DSSE signature adapter made the full Sigstore `Verifier.verify()` pass in Wrangler for the upstream valid DSSE bundle. Signature and payload mutations were rejected at the crypto primitive; a wrong Rekor key failed inclusion-promise verification; 12 parallel probes gave 6 valid / 6 reject. This is isolated compatibility evidence, not NUSA signer authorization.
- Existing publisher/source/coordinator/replay/OIDC WIP tests passed 28/28 via the preserved dependency symlink target and temporary `tsx`; causal observation tests 3/3 and workflow trust-boundary tests 3/3 passed. Workflow action pin/input validators and YAML parse passed.
- Local branch `codex/1851-attested-causal-producer-20261031` now separates the existing main-push observation job from an attestor job. Only the attestor has `id-token`, `attestations`, and `artifact-metadata` write permissions; it has no checkout, accepts only an exact same-run main-push `OBSERVED_MISMATCH`, validates run/ref/SHA/workflow/job/fingerprints, signs with pinned `actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6`, and uploads the bundle separately.
- No actual protected-main attestation has been produced; no server-side bundle verification, allowed signer policy, causal receipt, or `CODE_ACTIONABLE` exists. No commit, PR, deploy, or production mutation was performed.
- Next: integrate and adversarially test Worker bundle verification against this exact producer policy; keep admission fail-closed until a real protected-main positive attestation is verifiable.

## 2026-10-31 continuation — Worker bundle policy path

- Protected main freshly fetched as `f144b940925dc04df7c0849fbaad9e5f14f5befe`; local WIP HEAD remains `1a8bb3b261f8e4ac242499a93287da6c370ed4b3`. #1851 is open, #1854 remains closed, and no open replacement implementation PR was found. The worktree and root `node_modules` symlink were preserved.
- Connected an optional Sigstore bundle to the existing bounded Worker causal-claim request. A supplied bundle is verified with the Worker Sigstore verifier, pinned NUSA signer/workflow policy, exact source identity, predicate contract and subject digest before the claim is accepted. The consumer workflow can download only the named attestation artifact from the cited source run/attempt and sends it for verification. A missing bundle can only produce a provenance-only claim (`causalAttestationVerified=false`); this grants no causal receipt or `CODE_ACTIONABLE` authority.
- Evidence: TypeScript PASS; focused Worker/causal/OIDC/coordinator tests 24/24; workflow/observer/claim-script tests 10/10; consumer workflow YAML parse PASS; `git diff --check` PASS. The upstream valid generic fixture is rejected for its non-NUSA signer; this exercises the negative identity gate, not an authorized producer positive path.
- `pnpm run preflight` did not reach its scripts: pnpm attempted to remove the preserved `node_modules` symlink target and aborted because the command had no TTY. The symlink remains unchanged; no retry was made.
- Still absent: real protected-main NUSA attestation, producer job/artifact cross-check, causal classification, durable one-time receipt/replay consumption and `CODE_ACTIONABLE` integration. Static trusted-root refresh is also unresolved. No commit, PR, CI request, deployment, or production change was made.
- Next transition: obtain a genuine NUSA attestation only after governed inclusion, then verify producer job/artifact identity and exact source run before implementing durable causal receipt/replay semantics. Keep PAPER_ONLY and zero-authority boundaries unchanged.

## 2026-10-31 18:48 KST continuation — producer job/artifact API cross-check

- Fresh GitHub: protected `main` and WIP `HEAD` both `1a8bb3b261f8e4ac242499a93287da6c370ed4b3`; ahead/behind `0/0`; Issue #1851 open; #1854 closed; no open replacement #1851 implementation PR. WIP inventory remains 43 and the root `node_modules` symlink target is unchanged.
- Added server checks for exact source-attempt producer/attestor jobs and same-run artifact metadata. Workflow-failure scheduled admission abstains before lease/dispatch; the consumer requires the bundle and positive server verification for `gha:` failures.
- Frozen install used `/tmp/nusa-1851-validation-modules` with lifecycle scripts disabled, preserving the existing symlink. Node 24.19 preflight, TypeScript, build and `validate:full` passed. Workflow/claim tests passed 14/14; lint passed with 0 errors and 47 warnings.
- Focused causal/scheduled tests are 133/137. Four legacy positives still expect generic failed-CI dispatch and remain failing; no expectations or gates were weakened. The isolated full repository test suite remains in progress.
- Security gate failed on high joi advisory 1244009 and package metadata unavailable to the scanner through the preserved root dependency symlink. Open PR #2954 covers the joi advisory. New Sigstore package metadata/license could not be confirmed by the repository scanner in this environment; this remains a gate failure, not a waiver.
- `git diff --check` passed. No commit, PR publication, Audit, Release, merge, deploy or production mutation occurred. `CODE_ACTIONABLE=NOT_ISSUED`, `COMMIT_GATE=NOT_MET`, `L1=PARTIAL`, `L2=HOLD`.
- Next: finish full regression and review the staged candidate. A genuine protected-main attestation requires governed staged inclusion; no direct protected-main change is authorized.

## 2026-10-31 19:15 KST — current-main and staging recheck

- Fresh protected `main`: `9ea80540b718367758634de1fbd990eff45017a0`. Issue #1851 is open; #1854 is closed and remains retired; GitHub search found no open replacement PR. The WIP branch exists locally at `1a8bb3b261f8e4ac242499a93287da6c370ed4b3`, has no remote branch, and is 0/3 commits ahead/behind (`HEAD` ancestry only; working changes are uncommitted). No rebase/reset was performed.
- The three-commit main delta touches `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and `tests/security-gate.test.js`. The staged WIP tree contains current-main content for those files while retaining Sigstore dependencies and #1851 changes. The full WIP inventory is 48 including the preserved root `node_modules` symlink to `/workspace/nusa-1851-actionability/node_modules`; target exists and is unchanged.
- Security gate passed in an isolated temporary worktree based on exact current main plus the local tracked patch and untracked WIP files, using the frozen isolated dependency tree and running the repository postinstall security backports there: high/critical findings 0, license findings 0, secrets 0. No dependency symlink in the WIP was replaced.
- Previously run on this unchanged source WIP: typecheck, build, `validate:full`, and lint (0 errors / 47 warnings) passed. Focused causal/scheduled tests remain 4/137 failing; compiled scheduled suite 6/16 failing. These failures still reflect absent authenticated positive causal evidence and old generic-failure dispatch expectations; no test or safety gate was relaxed.
- Current architecture evidence: isolated Sigstore crypto and 28/28 identity/source/replay tests pass, but genuine protected NUSA attestation, durable causal receipt, and positive `CODE_ACTIONABLE` path are absent. A real protected-main attestation depends on governed staged inclusion; inducing a deliberate main regression or fabricating evidence is not permitted. Because the work-order commit gate also requires a positive path before commit, this ordering is unresolved and commit remains forbidden.
- No source edit, commit, push, PR, merge, Audit, Release, deploy, or production mutation occurred. `PAPER_ONLY`, zero authority, and fail-closed behavior remain unchanged.
- Next canonical transition: authorized governance resolves staged-inclusion sequencing; after lawful inclusion, run the genuine protected producer and verify its attestation and exact source binding. Keep workflow-failure admission closed until a real positive receipt path is established.

### Validation environment correction — 2026-10-31 19:18 KST

`pnpm run validate:full` was attempted after the AIPOS update, but pnpm began dependency reconciliation (`Packages +7 -1`) before any validation scripts ran. The command was interrupted immediately. The WIP root `node_modules` symlink path and target remain the same and the target still resolves, but the target directory mtime changed and Sigstore links are present; prior target contents cannot be asserted unchanged. No cleanup or guessed rollback was performed. `validate:full` is therefore NOT_RUN, not PASS. Its constituent preflight, architecture, AIPOS, and safety scripts were then run directly in the isolated current-main-plus-WIP validation worktree and all passed. The earlier isolated security gate PASS remains separate evidence. On the canonical WIP, `git diff --check` and AIPOS YAML parsing pass; subsequent validation must keep using an isolated worktree/dependency directory.

## 2026-10-31 19:22 KST — direct CodingRunner route audit

- Fresh protected main: `9ea80540b718367758634de1fbd990eff45017a0`; local WIP HEAD: `1a8bb3b261f8e4ac242499a93287da6c370ed4b3`, 0/3 ahead/behind. Issue #1851 remains OPEN; #1854 is CLOSED; GitHub search found no open replacement PR. Local WIP remains uncommitted and preserved.
- Audit found that provenance-only `/coding/causal/claim` did not protect direct `/coding/execute`, `/coding/propose`, and `/coding/publish` routes. Workflow-failure `gha:` reasons could reach those paths with static token or OIDC authentication without a causal receipt.
- Added a shared classifier and fail-closed denial on those three routes before lease acquisition, proposal/AI execution, or publication. Existing canonical issue/backlog reasons remain eligible. No causal receipt or `CODE_ACTIONABLE` is created.
- Validation: full TypeScript compilation PASS; CodingRunner 91/91; `/coding/execute` 19/19; Worker proposal/publish 10/10. Causal + scheduled set 31/35; four legacy scheduled positives still expect generic workflow failure admission and remain failing without relaxed assertions. `git diff --check` PASS; AIPOS YAML PASS (541 files).
- No commit, push, PR, Audit, Release, merge, deployment, Oracle change, or production mutation. The positive causal path still requires a genuine protected-main NUSA attestation and governed staging; no fixture was fabricated.


## 2026-10-31 20:01 KST — governance-authorized fail-closed bootstrap order

- Governance owner explicitly authorized staged inclusion of a fail-closed bootstrap before real positive attestation. This waives only the positive-attestation prerequisite for the first bootstrap inclusion; it does not permit unsigned/missing/invalid evidence, workflow-derived `CODE_ACTIONABLE`, direct workflow-failure bypass on execute/propose/publish, or authority expansion. Backlog/issue admission remains intact.
- Fresh protected `main` is `cc03c39fe631777c2253d08bace03897e62f31b8`. It advanced from `b087468e…` by four non-overlapping files (two risk behavior tests and two AIPOS records); exact-main validation must be rerun.
- GitHub confirms #1851 OPEN, #1854 CLOSED/DRAFT and not merged. Its remote `fix/evolve-workflow-actionability-1851` branch at `121e7bcd…` is retained as historical closed-PR branch and will not be revived. No open replacement #1851 PR was found. The preserved local WIP remains at `1a8bb3b…`; its 54 changes and original `node_modules` symlink remain preserved, with dependency provenance UNKNOWN/UNVERIFIED.
- On prior main `b087468e…`, full isolated tests passed 1316/1316; autopilot compiled tests passed 705/705; preflight and validate:full constituents passed; security passed; mobile typecheck passed; lint passed at 0 errors/47 warnings with an identical warning multiset on the clean same-main baseline. These are historical after main advanced.
- Reconstructed the minimal bootstrap candidate on fresh `cc03c39f…` without copying generated audit reports, extraction experiments, or dependency symlinks from the original WIP. Current-main validation is pending. No commit, push, PR, CODE_ACTIONABLE receipt, protected-main mutation, or production mutation has occurred.
- Next: finish focused/full validation on `cc03c39f…`; after local gates pass, create a successor SHA and obtain exact-head CI/companion checks plus independent review. Positive causal attestation remains mandatory after protected inclusion and before any causal receipt or CODE_ACTIONABLE admission.

## 2026-10-31 20:10 KST — fresh-main bootstrap candidate validation

- Fresh protected main remained `cc03c39fe631777c2253d08bace03897e62f31b8`; Issue #1851 is OPEN, PR #1854 is CLOSED, and no open replacement implementation PR was found. The original 54-item local WIP and its `node_modules` symlink were preserved; the symlink target remains `UNKNOWN/UNVERIFIED` and was not used as validation evidence.
- Reconstructed candidate is based exactly on current main. The 4-commit main delta was reviewed: it adds two AIPOS/risk records and two cloud behavior tests, with no overlap in the bootstrap source paths.
- Current-main candidate validations: isolated full test suite 1318/1318; targeted autopilot/causal/cloud suite 744/744; root and mobile typecheck PASS; build PASS; validate:full constituent gates PASS; security gate PASS; AIPOS YAML/provenance PASS; diff check PASS.
- Lint on the clean exact-main baseline and candidate each reports 0 errors/47 warnings; warning multiset comparison reports zero added/removed warnings.
- `pnpm run typecheck` was not used because pnpm attempted dependency reconciliation against the isolated symlink before running scripts and safely aborted. Equivalent root/mobile TypeScript compiler commands ran directly and passed. The preserved original dependency symlink was not touched.
- Workflow-failure admission remains fail-closed at scheduled and direct execute/propose/publish paths; no causal positive receipt or `CODE_ACTIONABLE` is emitted. Backlog/issue admission remains separately guarded. No commit, push, PR, protected-main update, Audit, Release, merge, Oracle, or production mutation has occurred.
- Next: create a minimal successor SHA from this validated candidate, then run exact-head CI/companions and governed independent review. A real protected producer attestation and positive causal path remain mandatory after staged inclusion and before any workflow-failure admission.


## 2026-10-31 20:12 KST — protected main advanced during final validation

- Fresh GitHub API and `git ls-remote` now report protected `main` at `a92e37d59d5532b74715f32775740cdd23bef683`. The prior fetch first observed `9ea80540…`; an explicit refspec fetch then confirmed `a92e37d5…`. The current main is three commits beyond validated `cc03c39f…`, touching only mobile island UI/model/tests, with no file overlap against the #1851 bootstrap candidate.
- All `cc03c39f…` validation results are now historical. A fresh candidate was reconstructed on exact `a92e37d5…`; no source reset, branch force update, or protected-main mutation occurred. Original WIP and its unverified `node_modules` symlink remain preserved.
- Revalidate the reconstructed candidate against `a92e37d5…` before creating any successor SHA. No commit, push, PR, CODE_ACTIONABLE, Audit, Release, merge, Oracle or production mutation has occurred.


## 2026-10-31 20:18 KST — exact-current-main bootstrap validation completed

- Protected main stayed at `a92e37d59d5532b74715f32775740cdd23bef683` through validation. Candidate base equals this exact SHA.
- Isolated full suite: `PASS 1318 isolated test files`. Root and mobile TypeScript checks, fresh root build, all `validate:full` constituent checks, security gate, desktop/mobile lint, AIPOS YAML/provenance and `git diff --check` passed. Lint comparison against a clean worktree at the same exact main: 0 errors, 47 warnings in both, zero added/removed warnings.
- `pnpm run typecheck` was not used because it tried to reconcile the preserved dependency symlink before scripts executed. Equivalent direct TypeScript compiler checks passed using the isolated dependency tree. No lockfile or original dependency symlink was changed.
- The old `isolated-test-failure.txt` diagnostic was preserved. The safe local harness wrote any new diagnostic only under `/tmp` and all 1318 test files passed.
- Candidate remains fail-closed: no workflow-failure CODE_ACTIONABLE, no direct execute/propose/publish workflow-failure bypass, backlog/issue route preserved. Genuine protected-main NUSA attestation and positive causal admission remain absent; `CODE_ACTIONABLE=NOT_ISSUED`.
- Next: mint a successor SHA from this validated minimum bootstrap set. Exact-head CI/companions and independent review remain pending; no Audit, Release, merge, deployment, Oracle or production mutation is authorized by this validation.


## 2026-10-31 20:19 KST — validated local bootstrap successor created

- Created local branch `codex/1851-failclosed-bootstrap-20261031` from the fully validated `a92e37d59d5532b74715f32775740cdd23bef683` candidate and committed the 46-file coherent fail-closed bootstrap set. The successor SHA is recorded by Git; remote publication and exact-head CI remain pending.
- The commit includes the producer/verifier bootstrap and explicit workflow-failure denial guards, while keeping the positive causal path absent. `CODE_ACTIONABLE` remains unissued. The unverified original `node_modules` symlink, generated audit reports and safe test-runner scratch file are not part of the commit.
- No protected-main update, direct merge, Audit, Release, Oracle operation or production mutation occurred.
- Next: publish this feature branch and create its canonical draft PR to trigger exact-head CI/companions; then use independent review. Do not mark the commit accepted or advance to governance gates based on local tests alone.
