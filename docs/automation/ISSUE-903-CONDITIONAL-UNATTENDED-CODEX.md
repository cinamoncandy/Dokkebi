# Issue #903 — conditional unattended Codex development gate (proposal; disabled)

Status: **PROPOSED / NOT ENABLED**. This is an implementation contract for the existing NUSA autonomous development control plane, **not** a new orchestrator, execution permission, credential grant, or accepted release. The OWNER requested a conditional unattended development loop on 2026-11-11. Reuse existing #903, #1851, #2118, #1605, #2760, #2039, #2772 and existing FORGE/Autopilot dispatch infrastructure. Follow `AGENTS.md`, `docs/NUSA_CORE_MASTER_INSTRUCTIONS.md`, AIPOS, and the release bot.

## Hard boundaries

- PAPER_ONLY; `liveAuthority=NONE`; `productionMutationAllowed=false`; `realOrderAuthority=false`; `aiAuthority=ZERO_AUTHORITY`.
- No AI self-approval, self-review counted as independent, protected-main direct push, self-merge, release-bot bypass, production deployment, credential access expansion, real orders, transfers, withdrawals, or LIVE activation.
- Fail closed on missing, stale, unverifiable or conflicting evidence. A passing CI workflow does not imply independent review, Audit, Release, runtime health, holdout, or L1 acceptance.
- Maximum **two** concurrently admitted coding work items; a single canonical owner per work item. Reuse the existing Issue/PR/branch when possible; never dispatch duplicates or create a second control plane.
- Bounded repair: at most **three** root-cause-based attempts per exact-head failure, then HOLD with evidence. Never blindly rerun or lower safety/test gates.

## Admission (all conditions required)

1. Read the canonical issue/work order, current AIPOS state, architecture, exact latest protected main SHA and the selected existing PR head/base; reconcile with current owner and writer lease.
2. Confirm work order READY, authority impact explicitly classified, no conflicting WIP or lease, existing ownership/heartbeat/TTL and takeover rules unchanged.
3. Create a fresh `executionId` and `dedupeKey`, bound to work order + exact main SHA + selected PR head SHA + allowed scope. Reject replay and stale-head dispatch.
4. Require the established trusted GitHub OIDC -> canonical Worker -> sandbox route and existing scoped capabilities; no user-provided long-lived tokens. Any route/credential ambiguity -> HOLD.
5. Select a low-risk, non-authority change first; changes touching Risk, broker, credential, execution, accounting, persistence, security or LIVE boundaries require the full AIPOS path and explicit existing authority gates.

## Coding and evidence

1. Codex operates only inside the established isolated development sandbox on the selected branch. Read `AGENTS.md` and canonical AIPOS before edits.
2. Minimal scoped patch; focused regression, build/typecheck, validate:full, security and lint as applicable; preserve actual failures.
3. Commit to a non-protected branch; create/update the **existing canonical Draft PR**. Record exact base/head, execution ID, work order, changed paths, validation commands, results and failure reason in durable evidence.
4. Run required **six exact-head CI workflows**. Treat absent, queued, skipped where required, cancelled, stale-head, or failed checks as NOT PASS. Recheck after every SHA change.
5. Require a genuinely independent non-author review on the **current exact head**, with actionable P0/P1 resolved and reviewed again. No self-certified approval.
6. Require Formal Validator, deterministic Audit and release-bot authorization independently, including any current main/base alignment checks. The AI **never invokes merge directly**; only the existing release path may merge when its existing policy permits. First fresh dogfood PR is evidence-only and **never auto-merged**.
7. After authorized integration, separately verify latest main and required read-only PAPER runtime/Research/Worker OFF receipts. No production mutation from this workflow.

## Failure / HOLD reason codes

`STALE_MAIN`, `STALE_HEAD`, `DUPLICATE`, `WIP_LIMIT`, `LEASE_CONFLICT`, `OIDC_UNVERIFIED`, `SANDBOX_UNAVAILABLE`, `TEST_FAILED`, `CI_FAILED`, `REVIEW_PENDING`, `P0_P1_OPEN`, `VALIDATOR_PENDING`, `AUDIT_PENDING`, `RELEASE_NOT_AUTHORIZED`, `RUNTIME_EVIDENCE_MISSING`, `EXTERNAL_BLOCKER`.

On HOLD, persist the first broken transition and immutable references, release only legitimately owned leases via existing rules, and report a bounded next action. Never invent a receipt or silently retry indefinitely.

## Activation checklist (not yet satisfied by this document)

- [ ] Inspect and reuse the current Autopilot/FORGE dispatcher and #903 canonical ownership; confirm no duplicate scheduler.
- [ ] Confirm GitHub Actions/Worker/Codex sandbox authentication and scoped permissions **without exposing secrets**.
- [ ] Implement deterministic admission and dedupe checks in the existing control plane with tests for stale head, duplicate, WIP>2, lease conflict and authority denial.
- [ ] Implement immutable exact-head CI/review/Validator/Audit/Release receipt correlation and negative tests.
- [ ] Prove one **fresh** low-risk event -> executionId/dedupeKey -> main SHA -> repository_dispatch -> OIDC -> Worker -> sandbox -> patch -> branch -> PR -> exact-head CI PASS, with no merge.
- [ ] Independent non-author review of the automation itself and Formal Validator/Audit/Release acceptance before enabling any unattended dispatch.

**Current result: proposal only.** Do not set an enable flag, schedule unattended Codex work, or claim the end-to-end dogfood proof on the strength of this file.
