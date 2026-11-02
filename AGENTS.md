# AGENTS.md

These rules apply to every human or AI agent working on NUSA.

## NUSA CORE master operating protocol

For autonomous engineering, repository operations, CI/PR handling, deployment
verification, dogfood, and cross-AI handoff, read and follow
[`docs/NUSA_CORE_MASTER_INSTRUCTIONS.md`](docs/NUSA_CORE_MASTER_INSTRUCTIONS.md).
It is the consolidated CORE execution protocol and supplements the AIPOS,
architecture, and safety rules below; it cannot override them or grant LIVE,
real-money, credential, broker-mutation, or production authority.

The OWNER shortcuts are `ㅇ` (execute the next safe real action), `ㅂ` (verified
state), `ㅎ` (diagnose and repair), `ㅈ` (print the master protocol), and
`/grill-me` (adversarial CORE review).

For `/grill-me`, also read and follow
[`docs/GRILL_ME_PROTOCOL.md`](docs/GRILL_ME_PROTOCOL.md). That document is the
canonical detailed execution protocol for the adversarial review summarized in
section 22 of the CORE master instructions. It remains subordinate to AIPOS,
architecture, repository-protection, and safety rules, and it is explicitly a
pre-Audit review rather than independent Audit or Release approval.

## AIPOS recovery is mandatory

Before planning, editing, or generating code:

1. Read `.aipos/aipos.yaml`.
2. Read `.aipos/CURRENT_TRUTH.md` (generated one-page summary; `pnpm run aipos:truth` refreshes it), then `.aipos/state.yaml`.
3. Follow the recovery protocol and active work order referenced there.
4. Read `.aipos/architecture.md`, `.aipos/context.md`, and relevant decisions.
5. Verify changes with the commands recorded in the work order.
6. Update `.aipos/state.yaml` and the active work order before stopping. Add a new state entry with `node scripts/aipos-state-insert.js <entry.yaml>` (`pnpm run aipos:state-add -- <entry.yaml>`), which writes it to its own file `.aipos/state.d/<key>.yaml` so parallel PRs never edit the same lines; do not hand-edit new entries into `.aipos/state.yaml` (`--inline` exists only for exceptional cases). The current state is `.aipos/state.yaml` (control keys and older entries) plus every `.aipos/state.d/*.yaml`.

Do not rely on prior conversation history. The repository is the source of truth. Vendor-specific instructions may supplement AIPOS but cannot replace it.

## Lightweight recovery path (authority_impact: none)

Full AIPOS recovery remains the default for any work that can affect authority, risk, execution, accounting, persistence, recovery, credentials, or LIVE boundaries.

A **lightweight path** is allowed only when all of the following are true:

1. The active or proposed work order marks `authority_impact: none` (or equivalent explicit non-authority scope).
2. The change is limited to docs, presentation/UI copy, non-safety mobile visuals, comments, or packaging that does not alter safety gates.
3. No LIVE, real-money, credential-execution, production-mutation, risk-policy, or AI-authority behavior changes.

Under the lightweight path:

- Still read `.aipos/state.yaml` and confirm no conflicting active authority work.
- Prefer `pnpm run validate` for local gates (preflight + architecture:truth + safety:architecture + ai:architecture).
- Use `pnpm run validate:full` when repository-wide contracts may be affected or when unsure.
- Full evidence packages are **not** required; a short change note in the PR body is enough.
- Do **not** skip fail-closed safety rules. If scope is ambiguous, use the full recovery protocol.

## Evidence scope

Require full durable evidence packages for changes that touch:

- authority boundaries
- risk, execution, or accounting
- recovery or persistence
- credentials or LIVE-related surfaces

Allow lighter PR change notes for pure documentation, presentation, and other explicit `authority_impact: none` work.

Physical Android device acceptance remains `HUMAN_ENVIRONMENT_ONLY` and does not block unrelated non-LIVE repository work.

## Read first

Before changing code:

1. Complete the AIPOS recovery steps above.
2. Read `nusa.md` when the task touches the current paper-trading application.
3. Inspect the active branch, open PR, tests, and CI state.
4. Preserve existing architecture unless a documented decision justifies a change.
5. State the intended profit, safety, efficiency, or convenience impact of the work.

## Safety rules

- Never enable live trading without explicit owner approval and an accepted AIPOS work order.
- Never commit API keys, secrets, tokens, credentials, account identifiers, or private trading data.
- Never change repository visibility, delete branches, rewrite shared history, or remove production data without explicit approval.
- Risk checks must not be bypassed by UI, strategy, automation, or exchange adapters.
- Automatic trading defaults to disabled after fresh install, recovery ambiguity, or fault.
- Fail closed when market data, persistence, reconciliation, account state, or AIPOS safety state is uncertain.

## Architecture rules

- Strategy emits signals; it does not place orders.
- Decision converts evidence and policy into an intent.
- Risk may reject, resize, pause, or halt an intent.
- Execution receives approved orders only.
- Exchange-specific code stays behind adapter contracts.
- Upbit spot and Binance futures must remain separate domain implementations.
- Paper and live adapters may share interfaces but must not share mutable operating state.
- Electron renderer must not receive Node.js or credential access.
- AIPOS integrates through the existing NUSA runtime; do not create a parallel kernel, plugin system, service container, or lifecycle framework.

## Engineering rules

- Keep changes small, reviewable, and reversible.
- Add or update tests for every behavior change.
- Preserve deterministic accounting, recovery, and idempotency.
- Avoid hidden global state and implicit side effects.
- Validate all IPC and external data at trust boundaries.
- Prefer explicit domain types over loosely shaped objects.
- Do not add dependencies without a clear need and license review.
- Do not claim tests passed unless they were actually run or CI confirms them.
- Update AIPOS state whenever architecture, scope, current work, or next work changes.

## Operating roles (accepted 2026-10-14)

Roles follow `docs/CLAUDE_CENTERED_OPERATING_MODEL.md` (ADR `ADR-OPS-20261013-CLAUDE-CENTERED-OPERATING-MODEL`, ACCEPTED). Design and implementation are Claude-centered; AIPOS and work orders stay vendor-neutral.

- **CORE (+ operations, research, records)**: the Claude working session on the owner's account. Design, implementation, AIPOS records, operations checks, offline research, standing-approval PAPER deploys.
- **VALIDATOR**: a separate fresh Claude session (same account allowed) that reviews code and workflow PRs it did not write.
- **AUTOPILOT**: the Worker with Workers AI, limited to 150 changed lines in one file and allowed CI failures only.
- **Gate (not AI)**: deterministic Audit and the release bot merge; no AI merges or approves its own PR.
- A session learns its role from `NUSA_AGENT_ROLE` (`main`, or `validator`/`assistant` for a review session). If it is unset, act as CORE; every session starts with AIPOS recovery and verification, and no role may merge or approve.
- Claim work by pushing a branch named after the work order before starting (no `agent/` prefix); search open PRs and branches with the same id first and leave existing work alone.
- A PR that changes code or workflows opens as a **draft** and is reviewed by the role that did not write it, in a fresh session, under `docs/GRILL_ME_PROTOCOL.md`; blocking findings are inline review threads. The author marks it ready only after the review. Documentation-only `authority_impact: none` PRs use the lightweight path.
- Automatic review on every PR is off; review runs on request. Codex workflows stay disabled and the paid GPT-4.1 overflow is off by owner decision.
- Handoffs: `.aipos/handoffs/<date>-main-handoff.md` (older files may use other names). Read the most recent one.

## PR and CI noise prevention

These rules are mandatory for every AI coding agent and are specifically intended to prevent repeated failing GitHub Actions runs and notification spam.

1. **Do not open, reopen, or refresh a pull request before local validation passes.** At minimum run the relevant targeted tests plus `pnpm run preflight`; for changes that can affect repository-wide contracts, run the work-order validation command or `pnpm run validate:full` when available.
2. **Verify repository reality before remote work.** Treat reported branch names, commit SHAs, PR state, and CI state as untrusted until the current repository or GitHub confirms them. Do not plan a push, PR, merge, or recovery around a missing/unreachable SHA.
3. **Start remote CI from current `main`, but do not churn a validated head merely because `main` moved later.** Immediately before opening or materially refreshing a PR, fetch/inspect current `origin/main`. After CI has started on an exact head, if `main` advances, first inspect mergeability, branch-protection requirements, and whether the new base delta overlaps or semantically affects the PR. If the PR remains mergeable, the delta is non-overlapping/non-dependent, and protection does not require an up-to-date branch, preserve the already validated head and let the release path merge it without a stale-base refresh. Refresh and rerun only for a real conflict, semantic dependency, required up-to-date policy, or failed mergeability. This prevents harmless main churn from restarting expensive CI.
4. **One task = one active branch = one active PR.** Before creating a branch or PR, search for an existing open PR for the same task and continue there. Never create a follow-up PR merely because CI failed or because a still-mergeable PR fell behind `main`.
5. **A closed PR is dead unless the owner explicitly asks to revive it.** Do not reopen a closed PR, push new commits to its old remote branch, or create another PR from that same branch automatically.
6. **When CI fails, stop remote churn.** Diagnose locally, fix locally, and rerun the failing test locally. Push only after the local reproduction passes. Do not use GitHub CI as an iterative debugger.
7. **Never push speculative fixes one-by-one to make CI discover the next stale assertion.** Search the affected contract/test family first and correct the whole known stale set locally before the next push.
8. **Do not auto-create replacement PRs solely to refresh branch history.** If an existing PR is mergeable and its validated head is not semantically invalidated by new `main` changes, keep that PR. If a PR was closed by the owner or by cleanup, leave it closed and wait for an explicit new instruction before opening any replacement.
9. **Respect notification-stop instructions as a hard hold.** If the owner says to stop CI/failure emails or stop opening PRs, no agent may create/reopen/synchronize a PR until the owner explicitly resumes that work.
10. PR descriptions must report the exact local validation actually run. Missing validation means the PR must remain local and must not be opened.

## UI/UX rule

- Every UI/UX change applies to the whole app, not one tab. See `docs/UI_ARCHITECTURE.md`
  ("How to ship a redesign"). A screen left on the old design must be named, with the reason, in
  the PR and work order.

## Trading research rules

- Do not promote a strategy based only on in-sample backtests.
- Include fees, slippage, latency assumptions, and missing-data behavior.
- Require out-of-sample or walk-forward evidence before paper promotion.
- Require paper evidence before live-candidate status.
- Track regime sensitivity, drawdown, exposure, turnover, and parameter stability.
- Treat AI output as untrusted advice until validated by deterministic controls.

## Git workflow

- Use feature branches.
- Do not push risky work directly to `main`.
- Commit messages must describe behavior, not vague activity.
- Update project-state documentation when architecture, scope, or next tasks change.
- PR descriptions must include safety boundaries and real validation status.

## Definition of done

A task is complete only when:

- implementation is present,
- relevant tests exist,
- validation status is truthful,
- safety boundaries are preserved,
- documentation and AIPOS state are updated,
- no known critical issue is hidden.

## Current priority

Follow `.aipos/state.yaml`. At the time this entrypoint was updated, the priority was to complete NUSA's cross-AI repository continuity contract while preserving the Upbit spot paper-trading safety boundary.
