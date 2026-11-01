# Research rolling holdout reachability handoff — 2026-11-01

## Canonical target

- PR #2973, existing branch `claude/rolling-holdout`.
- Pre-repair head: `e0b3f2766fcea8d835bb2e91a8d2b304a532e077`.
- Protected main observed during the repair: `8b4394cdfd4ad261e3f114a2bfc13309d2fef0de`.
- The main delta is outside the rolling-holdout changed-file set; PR remains mergeable. Do not force-sync for this non-overlapping delta.

## Finding and repair

Exact-head CI on the pre-repair head failed `tests/cloud-unreached-baseline.test.js`: the newly added `researchRollingHoldout.ts` and `researchRollingRunner.ts` were not reachable from production/product/LIVE-boundary entries. The failure reproduced locally. The baseline and guard were preserved.

The fold builder/decision helpers now live in the existing reachable `researchWalkForwardWindows.ts`, and the exported per-fold composition lives in `researchExperimentRunner.ts`. The orchestrator, scheduler, holdout ledger, backfill, `/health`, qualification thresholds, budgets, and authority remain untouched. Tests import the exports from those existing modules. The repair removes the two unreachable modules rather than declaring them exempt.

## Local evidence

On the repair worktree based on `e0b3f2766fcea8d835bb2e91a8d2b304a532e077`:

- Frozen-lockfile dependency install succeeded (Node 24.19.0, pnpm 11.7.0).
- Preflight, typecheck, build passed.
- Reachability baseline: 3/3 passed.
- Rolling helper + runner focused tests: 12/12 passed.
- Combined focused run including baseline: 15/15 passed.
- Full `pnpm test`: 1,322 isolated test files passed.
- `pnpm validate:full`: passed.
- Security gate: passed, zero secrets and no failures.
- Lint: zero errors, 47 warnings (the prior 48 included one unused test constant, removed; now at the reported baseline).
- `git diff --check`: passed.

The security gate generated untracked `docs/audits/*-2026-11-01` reports. Preserve them locally and do not include them in the feature commit; they are not part of the PR scope.

## Next transition

Commit the validated repair to the same `claude/rolling-holdout` branch, set PR #2973 back to Draft before pushing, then verify the successor SHA and exact-head CI. After checks pass, obtain a fresh independent non-author review. No review, Formal Validator, Audit, Release, merge, research-runtime wiring, or learning-loop claim is established by this handoff.

## Safety and scope

`PAPER_ONLY`; `liveAuthority=NONE`; `productionMutationAllowed=false`; `realOrderAuthority=false`; `realTransferAuthority=false`; `aiAuthority=ZERO_AUTHORITY`. No code path issues `CODE_ACTIONABLE`, and no runtime producer/orchestrator wiring was added.
