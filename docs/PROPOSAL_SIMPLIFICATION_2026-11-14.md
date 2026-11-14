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
| Mobile | Two paths exist in code. (1) The main app reads the canonical cloud origin (`apps/mobile/src/canonicalOrigin.ts`, set from the GitHub variable `NUSA_MOBILE_API_BASE_URL` = `https://nusa-api.duckdns.org`, read by the owner on 2026-11-14), i.e. the PAPER host directly, through DuckDNS, not Cloudflare. (2) A read-only "local monitor prototype" (`apps/mobile/README.md`) reads the desktop localhost bridge (`apps/desktop/src/mobileBridge.ts`) and is only used when `EXPO_PUBLIC_NUSA_MONITOR_URL` is set |

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
| S2 | Move each Worker-decided check into Actions and run both in parallel (shadow): the two answers must match on real PRs | N consecutive PRs with identical decisions, mismatches listed | keep calling the Worker |
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

## 6. Open points for the owner

- Answered 2026-11-14: the phone reaches the PAPER host at `https://nusa-api.duckdns.org` (DuckDNS), not through Cloudflare.
- Answered 2026-11-14: the desktop app may be frozen once S1 proves the phone does not need it (the owner only uses mobile).
