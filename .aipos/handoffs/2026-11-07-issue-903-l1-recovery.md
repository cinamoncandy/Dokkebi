# CORE handoff — 2026-11-07 — #2039 current-main recovery

Protected main was freshly verified as `01d698b325626e4a2e62b29e8e0b2f99f579ad4a`. PR #2039 remains OPEN/Draft on the existing `agent/903-canonical-portfolio-autopilot` branch; the pre-alignment head was `90726879b4c5dead48327579c59fdfdecda82154`, 315 commits behind and 35 ahead. No branch or PR was duplicated.

The branch was fast-forwarded to the live PR head and current main was merged without rewriting history. The only textual conflicts were two scheduled-coding tests. They were resolved in favor of current-main assertions: an unverified generic workflow failure must remain ABSTAINED and must not acquire a lease or dispatch. No generic failure was turned back into code actionability.

Reviewing the merged Coordinator found that the current-main causal-admission handoff path consumed the trusted binding but retained the shorter producer expiry. The ordinary handoff path already copied the authenticated consumer's bounded `leaseExpiresAt`. Both paths now persist that expiry. A regression covers the causal handoff, replay rejection, and denial of a competing producer while the handed-off lease is active.

The existing #2039 change also contracts logical WIP admission to two. Because the Durable Object may already contain three to eight claims under the previous limit, stored-state validation retains the prior eight-claim bound; new admission is still capped at two, old claims remain visible and block admission until their existing TTL expires, and the state is not mislabeled corrupt.

Local focused and full validation, typecheck/build/security/lint, exact-head CI, and independent review are not yet recorded for this successor. Existing test evidence belongs to earlier SHAs only. The next step is an isolated dependency install and complete local validation, then update this handoff with observed results before publishing. Keep the PR Draft; do not self-review, merge, or mutate production.

Autonomous dogfood remains a separate gate. The accepted owner decision keeps the Codex coding workflow/runner disabled; do not re-enable it. Workers AI execution is only eligible if the canonical causal admission, WIP slot, runtime configuration, and repository permissions are freshly proven. Do not fabricate `CODE_ACTIONABLE` or attestations.

Safety remains `PAPER_ONLY`, `liveAuthority=NONE`, `productionMutationAllowed=false`, `realOrderAuthority=false`, `realTransferAuthority=false`, `aiAuthority=ZERO_AUTHORITY`, fail-closed.
