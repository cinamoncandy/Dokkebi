# CORE handoff — 2026-11-07 — #2039 current-main recovery

Protected main was freshly verified as `01d698b325626e4a2e62b29e8e0b2f99f579ad4a`. PR #2039 remains OPEN/Draft on the existing `agent/903-canonical-portfolio-autopilot` branch; the pre-alignment head was `90726879b4c5dead48327579c59fdfdecda82154`, 315 commits behind and 35 ahead. No branch or PR was duplicated.

The branch was fast-forwarded to the live PR head and current main was merged without rewriting history. The only textual conflicts were two scheduled-coding tests. They were resolved in favor of current-main assertions: an unverified generic workflow failure must remain ABSTAINED and must not acquire a lease or dispatch. No generic failure was turned back into code actionability.

Reviewing the merged Coordinator found that the current-main causal-admission handoff path consumed the trusted binding but retained the shorter producer expiry. The ordinary handoff path already copied the authenticated consumer's bounded `leaseExpiresAt`. Both paths now persist that expiry. A regression covers the causal handoff, replay rejection, and denial of a competing producer while the handed-off lease is active.

The existing #2039 change also contracts logical WIP admission to two. Because the Durable Object may already contain three to eight claims under the previous limit, stored-state validation retains the prior eight-claim bound; new admission is still capped at two, old claims remain visible and block admission until their existing TTL expires, and the state is not mislabeled corrupt.

Local validation on the aligned candidate passed: preflight; focused coordinator/scheduled regressions 60/60; build; typecheck; isolated full suite 1,335/1,335 test files; validate:full; security:gate; lint with 0 errors and 47 existing baseline warnings; and diff check. The first full-suite attempt failed because the mounted `/tmp` filesystem was full (`ENOSPC`); the identical suite passed with `TMPDIR=/workspace/nusa-2039-tmp`. The original tracked `isolated-test-failure.txt` and both run outputs were preserved. These are local results only; exact-head CI, companion checks, fresh independent Validator, Formal Validator, Audit, and Release remain pending.

Autonomous dogfood remains a separate gate. Fresh check confirms the Codex workflow is `disabled_manually` by owner decision; do not re-enable it. Read-only GitHub Actions variable access for `NUSA_AUTOPILOT_CODING_ENABLED` returns 403, so Workers AI configuration/dispatch remains unverified. No authorized Workers AI/Sandbox dispatch interface is available here. Do not fabricate `CODE_ACTIONABLE` or attestations. No actual AI coding E2E was run by this session.

The validation record update changes only AIPOS/handoff metadata. Re-run AIPOS/preflight and the full validation suite with this metadata before committing or publishing the resulting candidate. Keep the PR Draft and wait for exact-head CI and one fresh non-author Validator review.

Safety remains `PAPER_ONLY`, `liveAuthority=NONE`, `productionMutationAllowed=false`, `realOrderAuthority=false`, `realTransferAuthority=false`, `aiAuthority=ZERO_AUTHORITY`, fail-closed.
