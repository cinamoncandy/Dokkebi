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
| Mobile | `apps/mobile` is a read-only monitor. Its only data source is the desktop localhost bridge (`apps/desktop/src/mobileBridge.ts`: `/health`, `/api/status`, `/api/account`, `/api/market`, `/api/markets`, `/api/candles`, `/api/events`) |

Consequence: freezing the desktop app today would leave the mobile app without data, and removing the Worker today
would stop the release-check and execution calls of the auto-merge path.

## 3. Target shape (three layers)

1. **Core:** the PAPER host (Oracle), `nusa.service`, research collection and the learning job, as in the 2026-10
   proposal. This is the part that matters.
2. **One verification path:** every PR check runs in GitHub Actions only, one way. No Worker, no Coordinator.
3. **Frozen, not deleted:** desktop app and its release workflows, and other surfaces nobody uses, move behind an
   `attic/` boundary (excluded from builds and required CI) per module, through governed PRs.

Mobile stays. Its data comes from a new read-only status route on the PAPER host (GET only, no order, credential,
setting or control route), replacing the desktop bridge as the source.

## 4. Phases (each is one PR, each reversible)

| Phase | Change | Exit evidence | Rollback |
| --- | --- | --- | --- |
| S0 | Inventory (read only): for each Worker call in a workflow, what the step decides, what happens if it is moved into Actions, and what the Coordinator WIP cap protects | a table committed under `docs/`; no code change | none needed |
| S1 | Host read-only status route for mobile (same fixed GET set as the desktop bridge, from the host's own state, authenticated, fail closed) | mobile app reads the same fields from the host; no write route exists; adversarial tests | remove the route; the desktop bridge is untouched |
| S2 | Move each Worker-decided check into Actions and run both in parallel (shadow): the two answers must match on real PRs | N consecutive PRs with identical decisions, mismatches listed | keep calling the Worker |
| S3 | Switch the workflow URLs to the Actions-side check; keep every check, relax none | auto-merge still blocks a bad PR in a rehearsal; Audit/Release unchanged | switch the URLs back |
| S4 | Remove Cloudflare: delete the deploy, promote, preflight, runtime-proof and readiness workflows and `apps/autopilot` through governed PRs; the owner deletes the Worker in the Cloudflare account last | no workflow references `workers.dev`; required checks list updated with owner approval | restore from git history; redeploy by the old workflow |
| S5 | Freeze the desktop app and its release pipeline (only after S1 is confirmed on a real phone) | desktop excluded from CI; mobile unaffected | move back out of `attic/` |

The WIP cap that the Coordinator enforces must be replaced by an equivalent limit (for example a workflow
concurrency group) in S2 before S3. It is never dropped.

## 5. Not in scope

LIVE or any real-money authority; relaxing risk, threshold, capital, WIP or Audit/Release gates; deleting evidence;
host changes from an agent session; a big-bang rewrite; deploying or changing any Cloudflare setting before S4 is
approved. The owner's earlier request to set up Cloudflare Access for the Coordinator read is withdrawn by decision 1.

## 6. Open points for the owner

- Is the PAPER host reachable from the phone today (for the S1 route)? Which path should the phone use?
- Confirm that the desktop app may be frozen after S1 is proven.
