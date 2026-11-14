# Proposal: simplification, step 2 (2026-11-14)

Status: PROPOSAL. Needs a non-author review and owner approval before any phase starts. It does not change
`docs/NUSA_CORE_ARCHITECTURE_PRINCIPLE.md`. It builds on `docs/PROPOSAL_TARGET_ARCHITECTURE_2026-10.md` (read that first)
and does not repeat it. Safety stays as is: PAPER_ONLY, `liveAuthority=NONE`, `productionMutationAllowed=false`,
`aiAuthority=ZERO_AUTHORITY`. Work order: `.aipos/work-orders/WO-ARCH-20261114-SIMPLIFICATION.yaml`.

## 1. Owner decisions (2026-11-14)

1. Cloudflare is not needed. Remove the connection in stages.
2. Make the overall design simple.
3. Only the mobile app is used. The desktop app and its release pipeline are not.

## 2. What the repository shows (read on `main` at 86eff57ce)

| Area | Fact |
| --- | --- |
| Size | 42 workflows, 203 scripts, 1,013 test files, 590 work orders, apps: autopilot, cloud, desktop, execution, mobile |
| Cloudflare | Worker `nusa-autopilot` with the Durable Object `ExecutionCoordinator`. Workflows call it: `autopilot-github-event-bridge` (`/github/webhook`), `autopilot-deterministic-audit-release` (`/control-plane/release-check`), `autopilot-execution-consumer` (`/coding/execute`, `/audit/execute`). Cloudflare workflows: deploy, promote, credential-preflight, runtime-proof (hourly), deployment-readiness |
| Deploy trigger | `autopilot-cloudflare-deploy` runs on every push to `main` that touches `apps/autopilot/**` |
| Mobile | Two paths exist in code. (1) The main app reads a canonical cloud origin from build configuration (`apps/mobile/src/canonicalOrigin.ts`; the code does not fix an address). The repository variable `NUSA_MOBILE_API_BASE_URL` was `https://nusa-api.duckdns.org` when the owner read it on 2026-11-14, so the build input points at the PAPER host through DuckDNS, not Cloudflare. That the installed app uses that value is NOT yet proven (needs the build config and a real device; part of S1). (2) A read-only "local monitor prototype" (`apps/mobile/README.md`) reads the desktop localhost bridge (`apps/desktop/src/mobileBridge.ts`) and is only used when `EXPO_PUBLIC_NUSA_MONITOR_URL` is set |

Consequence: removing the Worker today would stop the release-check and execution calls of the auto-merge path.
Freezing desktop only affects mobile if the monitor-prototype path (2) is in use; S1 below first proves which path the
phone really uses. The phone path (1) does not depend on Cloudflare.

## 3. Target shape (three layers)

1. **Core:** the PAPER host (Oracle), `nusa.service`, research collection and the learning job, as in the 2026-10
   proposal. This is the part that matters.
2. **One verification path:** every PR check runs in GitHub Actions only, one way. No Worker, no Coordinator.
3. **Frozen, not deleted:** desktop app and its release workflows, and other surfaces nobody uses, move behind an
   `attic/` boundary (excluded from builds and required CI) per module, through governed PRs.

Mobile stays. Its data comes from the PAPER host at the canonical origin. A new host route is added only if S1 shows
the phone still needs data that only the desktop bridge provides.

## 4. Phases (each is one PR, each reversible)

| Phase | Change | Exit evidence | Rollback |
| --- | --- | --- | --- |
| S0 | Inventory (read only): for each Worker call in a workflow, what the step decides, what happens if it is moved into Actions, and what the Coordinator WIP cap protects | a table committed under `docs/`; no code change | none needed |
| S1 | Prove the phone path: list every endpoint the shipped app calls and whether the host serves it. Only for a gap, add a host read-only GET route (no order, credential, setting or control route, authenticated, fail closed) | table of app calls vs host routes; gaps closed with adversarial tests | remove a new route; the desktop bridge is untouched |
| S2 | Move each Worker-decided check into Actions and run both in parallel (shadow): the two answers must match on real PRs | 20 consecutive PRs (at least 3 of which touch workflows or release paths) with identical decisions and zero mismatches; any mismatch is root-caused and the count restarts at 0 | keep calling the Worker |
| S3 | Switch each Worker call to its Actions-side replacement (see the conditions below); keep every check, relax none | auto-merge still blocks a bad PR in a rehearsal; Audit/Release unchanged | switch the URLs back |
| S4 | Remove Cloudflare: delete the deploy, promote, preflight, runtime-proof and readiness workflows and `apps/autopilot` through governed PRs; the owner deletes the Worker in the Cloudflare account last | no workflow references `workers.dev`; required checks list updated with owner approval | restore from git history; redeploy by the old workflow |
| S5 | Freeze the desktop app and its release pipeline (only after S1 is confirmed on a real phone) | desktop excluded from CI; mobile unaffected | move back out of `attic/` |

### Conditions that gate S3 (all required, none optional)

The Coordinator enforces more than a count. A single workflow `concurrency` group does **not** reproduce it. S3 does not start until each item below is met and recorded in the S2 evidence:

1. The global active WIP limit stays at most 2 (the Coordinator's policy cap), enforced by one mechanism that every
   workflow in the auto-merge path goes through.
2. Equivalence to the Coordinator: duplicate Claim for the same key is refused, a Lease that expires is released
   and cannot be used after expiry, a retry does not create a second active slot, and two workflows racing for the
   last slot never both win. Each case has a test, and the same cases are run against the existing Coordinator so the
   two answers can be compared.
3. Independent (non-author) review of the equivalence tests, and a rollback rehearsal (S3 -> back to the Worker URLs)
   that passes before the switch.

### What S3 replaces (per call, not a URL swap)

An Actions workflow is not a drop-in server. For each Worker call S0 must name the replacement before S3:

| Worker call | Replacement to be specified in S0 |
| --- | --- |
| `/control-plane/release-check` | a job in the release workflow that computes the same decision from the exact-head checks, with the decision written as a step output and an artifact |
| `/coding/execute`, `/audit/execute` | the existing execution-consumer job runs the step directly; its result is an artifact the Audit step reads |
| `/github/webhook` | a workflow `on:` trigger for the same event |

### S4 rollback is not only a git restore

Deleting the Worker in the Cloudflare account cannot be undone from git. Before the owner deletes it, S4 records: the
Worker name and routes, the Durable Object state that would be lost (the Coordinator records are only a cache of GitHub
state, to be confirmed in S0), the secrets and variables that would have to be set again, and a redeploy rehearsal.
Deleting the Worker is the last step and is done only after at least one full release has run without any `workers.dev`
call.

## 5. Not in scope

LIVE or any real-money authority; relaxing risk, threshold, capital, WIP or Audit/Release gates; deleting evidence;
host changes from an agent session; a big-bang rewrite; deploying or changing any Cloudflare setting before S4 is
approved. The owner's earlier request to set up Cloudflare Access for the Coordinator read is withdrawn by decision 1.

## 5a. Further improvements found while working (2026-11-14)

| # | Improvement | State | Needs |
| --- | --- | --- | --- |
| I1 | Separate switch for the PAPER order path so isolating orders does not stop research collection (the 2026-11-13 stop cost an 18 h data gap) | PR #3115 (`NUSA_PAPER_ORDER_PATH`; only exactly `ON` keeps the path) | review, CI, then a separate owner approval to use it on the host |
| I2 | Off-host health watch so the system, not a person, notices a stopped or unexpectedly started host | PR #3116 (liveness only) | review, CI; richer alarms (collection gap, order without permit evidence) need an authenticated read path first |
| I3 | `CURRENT_TRUTH.md` is regenerated and re-committed by every PR because `tests/aipos-current-truth.test.js` requires the committed bytes to equal the generator output; any merge that changes a work order makes every other open PR stale | PROPOSAL | owner approval and non-author review (governance change) |
| I4 | One small host carries the PAPER service, research collection, backups and the diagnosis runner (1 vCPU, 954 MB in the 2026-10-27 measurement) | PROPOSAL | a fresh measurement; host changes are done by the operator, not by an agent session |
| I5 | The phone origin depends on one free DuckDNS name | RISK RECORDED | no change now |

### I3 in detail

Problem: the file cannot go stale by hand, but it goes stale by every other PR's merge. Open PRs must merge `main` and
regenerate it again and again, and CI fails with a stale-file error that is not a real defect.

Options:
- **A (recommended):** stop committing the generated file. Keep the generator and its determinism tests, add a
  `--stdout` mode, and change the cold-start instruction (`AGENTS.md`, `CLAUDE.md`) from "read the file" to "run the
  generator". The records stay the source of truth, and the output is still derived only from them.
- **B:** keep it committed but check it only on `main` after merge. This needs a bot commit to protected `main`, which
  the release rules do not allow an agent to add.

Safety: neither option removes a validator, relaxes a gate or changes what the records claim. The risk of A is a cold
agent that skips the generator step, so the instruction must be explicit and a test must pin the wording.

### I4 in detail

Move the self-hosted diagnosis runner off the PAPER host first (least risk, largest relief), then re-measure CPU,
memory and disk before deciding on anything larger. Nothing here is started by this proposal.

### I5

If the DuckDNS name stops resolving the phone loses its data source while the host keeps running. The I2 watch reads the
same name, so a name failure would also look like the host being down; the issue text says to check the name as well.

## 6. Open points for the owner

- Answered 2026-11-14: the repository build input for the phone origin is `https://nusa-api.duckdns.org` (DuckDNS, not Cloudflare). That the installed app really connects there is checked in S1 on a real device.
- Answered 2026-11-14: the desktop app may be frozen once S1 proves the phone does not need it (the owner only uses mobile).
