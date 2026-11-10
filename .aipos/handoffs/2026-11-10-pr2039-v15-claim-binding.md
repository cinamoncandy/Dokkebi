# CORE handoff — 2026-11-10 — #2039 V15 claim binding

Canonical ownership remains Issue #903 and existing Draft PR #2039. Fresh GitHub verification observed protected main `91959182a10abcf6176cc5b40304838724a01fa5` and PR #2039 OPEN/Draft at `ad669b83bff7ef3297561a1984770df45a853539`; that remote PR commit contains the current main as an ancestor. No remote write, merge, deploy, dispatch, claim, or lease mutation was performed.

In an isolated detached worktree based on the latest PR head, the V15 implementation adds bound fields to atomic active-WIP claims (`taskId`, `protectedMainSha`, `taskSnapshotDigest`, `leaseOwnerIdentity`, `leaseExpiresAt`), validates the coordinator's returned receipt, revalidates scheduled backlog task snapshots before dispatch, and adds an authenticated Codex pre-run verification step that checks current main, inventory status, task digest, and live claim receipt. If persistent admission fails or its response is ambiguous after an active-WIP claim, cleanup attempts exact persistent and active-WIP release; a regression test covers both attempts even if one cleanup fails. The workflow has not been run. Cursor inventory still lacks point-in-time proof, so selection/admission remains fail-closed.

Latest focused Autopilot coordinator, WIP, OIDC, scheduled lease, selector/client and workflow regression tests pass after the cleanup repair; build passes. The first full isolated suite attempt exposed a stale global AIPOS base anchor: `f875980e4ff9111ab576f1e93294fae510d07167` is not an ancestor of protected main `91959182a10abcf6176cc5b40304838724a01fa5`. The top-level current base anchor was aligned to the verified protected main; historical WO-0057 merge evidence remains unchanged. Standard `pnpm test` then passed preflight, build, and all 1,343 isolated test files.

Current operational WIP claims and writer lease remain `UNKNOWN`; no authenticated read-only receipt is available in this session. Actual Codex runner availability/login and a real automated coding E2E remain unverified/not run. No independent review, Formal Validator, Audit, Release, or merge authorization is claimed.

Next: after final diff review, create a local successor commit; immediately before any push, refresh protected main and PR HEAD and require the existing remote HEAD to remain `ad669b83…` with current main already in its ancestry. Publish only as a normal fast-forward to the existing Draft PR, then verify new exact-head CI and await the existing independent review handoff. Keep PAPER_ONLY, ZERO_AUTHORITY, and fail-closed behavior.

## Latest-main reconciliation update

Immediately before publication, fresh GitHub reads showed PR #2039 still at `ad669b83bff7ef3297561a1984770df45a853539`, while protected main had advanced from the PR base `91959182a10abcf6176cc5b40304838724a01fa5` to `3377b6ce2d4c4f34935e668e5fe22e76aeec69ce` (PR #3048, causal-attestation signer SAN verification). Publication was stopped. The latest main was merged locally into the isolated successor; this creates a new validation target. Previous full-suite and focused results are evidence for the prior PR-base candidate only and are not carried forward. The global AIPOS base anchor now points to `3377b6ce…`; generated CURRENT_TRUTH must be refreshed. The existing PR remote head has not changed, no remote write or dispatch occurred, and all untracked audit reports remain preserved and unstaged.

## Second latest-main reconciliation update

A second fresh read found protected main advanced again to `77f9ab88833f3bd11742aaf4e6c98082a4f63135` via PR #3049 while PR #2039 remained at `ad669b83bff7ef3297561a1984770df45a853539`. The main delta changes `apps/autopilot/wrangler.jsonc` to open the owner-approved isolated causal-verification attempt-3 window after the #3048 signer fix. This exact current main was merged into the local candidate; no operational workflow was dispatched and no deployment occurred. The previous `1,343/1,343` test result belongs to the candidate before this integration; verification is being rerun. No remote PR update has occurred.

## Validation after PR #3049 main integration

The local candidate containing protected main `77f9ab88833f3bd11742aaf4e6c98082a4f63135` passed `pnpm test` (1,343 isolated test files), `pnpm run typecheck`, `pnpm run validate:full`, `pnpm run security:gate`, `pnpm run lint` (0 errors, 48 baseline warnings), AIPOS YAML/provenance/CURRENT_TRUTH checks, and `git diff --check`. These are local results only; exact-head remote CI and independent review remain pending. No runner dispatch, claim/lease mutation, deployment, or main merge occurred.

## Protected main PR #3050 update

After the published head's CI completed, main advanced to `a2f69042d6c8b16ea6c461f1ad8aa330ec9aeb9b` through PR #3050. Its sole change restores `NUSA_ISOLATED_CAUSAL_VERIFICATION_ENABLED` to `false` after the authorized attempt-3 window. That latest main was merged locally into the successor and the AIPOS base anchor updated. The already-published `e8f6d882…` CI remains valid for that exact SHA, but the new local successor needs fresh validation and publication before it can be treated as current-main aligned. No deployment or isolated verification dispatch occurred.

## Validation after PR #3050 main integration

The candidate including latest main `a2f69042d6c8b16ea6c461f1ad8aa330ec9aeb9b` passed `pnpm test` (1,343 isolated test files), typecheck, `validate:full`, security gate, lint (0 errors, 48 baseline warnings), AIPOS YAML/provenance/generated-truth checks, and `git diff --check`. This local result does not replace exact-head CI; the published `e8f6d882…` CI is successful only for that older SHA. The latest successor is being prepared for a non-force fast-forward to existing PR #2039. No deployment, dispatch, claim/lease mutation, or merge was performed.


## Third latest-main reconciliation and validation

After PR #3050, protected main advanced to `c02eec0a3650139eb8df6e8dc33631fe35925472` through PR #3051. The delta adds bounded and sanitized rejection-stage evidence to the existing isolated verification path (`apps/autopilot/src/worker.ts`, its test, and the receipt consumer). It overlaps the PR's Worker file but merged without conflict; the PR's claim/verify/release paths remain present. The AIPOS current base anchor was advanced to `c02eec0…` and CURRENT_TRUTH regenerated.

On this integrated local candidate, the focused rejection-projection tests passed 5/5; `pnpm test` passed all 1,343 isolated test files; typecheck, `validate:full`, security gate, AIPOS YAML/provenance/generated truth/drift/conformance, lint (0 errors, 48 existing warnings), and `git diff --check` passed. The earlier exact-head CI for `10a413c…` passed, but belongs only to that older SHA. The current merged successor still needs publication and exact-head CI. Untracked audit reports remain preserved and unstaged. Inventory point-in-time completeness remains UNVERIFIED; WIP/lease receipts remain UNKNOWN; no actual runner E2E, independent review, Formal Validator, Audit, Release, merge, deployment, dispatch, or operational claim occurred.
