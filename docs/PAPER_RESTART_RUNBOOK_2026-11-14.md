# PAPER service restart runbook (2026-11-14)

Status: PROCEDURE, not an approval. Nothing in this file starts, releases or changes anything. Every step that touches the
host or runs a release needs the owner's approval at that time. Safety stays: PAPER_ONLY, `liveAuthority=NONE`,
`productionMutationAllowed=false`, `aiAuthority=ZERO_AUTHORITY`, Release=HOLD.

Background: the `nusa` service was stopped on 2026-11-13 (inactive, `NRestarts=0`) and the owner confirmed it stays
stopped (verified 17:18 KST 2026-11-14). A PAPER order path was running without permit evidence (#3108, still blocked).
Stopping the whole service also stopped research collection (an 18 h gap). The `NUSA_PAPER_ORDER_PATH` switch (merged in #3115)
lets collection run while the order path is off, so the restart is split into two stages. Review round 1 (REJECT) found that a release starts the service itself and that its rollback target does not know the switch; both are handled below.

## Roles

| Who | Does |
| --- | --- |
| Agent session | PRs, reviews, evidence reading (read-only host diagnose), updating this checklist. Never merges, approves, releases or edits the host. |
| Owner | approves each stage, dispatches the release workflow, approves host changes. |
| Operator (authorized, on the host) | sets the env value, runs `systemctl`, reports the outputs. |

## What a release does to a stopped service (read in `deploy/oracle/nusa-release-step.sh`, 2026-11-14)

The release `activate` verb enables and **restarts** `nusa.service` and `nusa-autopilot.service` and starts the research timer, then
requires both units to be active, passes the readiness check and holds a stability soak of about 180 s. If any check fails
the release rolls back, and the rollback also restarts the services. Consequences:

1. A release dispatched while the service is stopped **is the first start**. There is no separate "release, then start".
2. The first start runs with whatever is in `/etc/nusa/cloud-runtime.env` at that moment. Unset means the order path is ON.
3. A failed activation rolls back to the previous build, which does not know `NUSA_PAPER_ORDER_PATH` (the switch is new). That
   build would start with the order path ON and the missing-permit defect. **This hazard is not resolved yet** (see 0.5).

## Stage 0: preconditions (all must be true; record the evidence for each; the first release is blocked until 0.5 is decided)

| # | Condition | Evidence |
| --- | --- | --- |
| 0.1 | `main` contains the switch (#3115) and the SHA to release is the current protected `main` SHA with exact-source CI success | PR, CI run |
| 0.2 | `deploy/health-watch.json` `expectedState` is `RUNNING` in a reviewed PR that merged BEFORE the release (else `UNEXPECTED_UP`) | merged PR |
| 0.3 | A fresh backup exists and the disk has free space (the host was 90% used in October; re-measure). The release backup takes about 30 min and must not be cancelled | diagnose output |
| 0.4 | The owner states the start date so research studies can be re-pre-registered with the real span | owner message |
| 0.5 | The rollback hazard is closed by PROOF, never by accepting the risk. The release rollback (`rollback_and_restore`) restarts the previous build, which does not know the switch. Required: a code reference and a passing test showing that the previous build cannot create an order path with the env file as it will be at release time, or a separate blocking mechanism that has itself been verified. Candidate mechanism (NOT yet proven; it needs a test on the build that will be the rollback target): leave `NUSA_CLOUD_PAPER_INITIAL_CAPITAL_KRW` unset so no PAPER execution loop is created. The owner cannot waive this condition, and the first release does not start until it passes | code reference, test output, operator output of the env file (values redacted if sensitive) |
| 0.6 | `NUSA_PAPER_ORDER_PATH=OFF` is already written in `/etc/nusa/cloud-runtime.env` (`0600`) BEFORE the release is dispatched. Verified by the operator reading the file, not by starting the service | operator output |
| 0.7 | The readiness and soak checks pass with the order path off (the readiness script requires `ok: true` and all checks true; whether a paper-runtime check is among them is NOT yet read). If a check requires the order path, the release would fail and roll back (see 3 above), so this stays blocked until it is read | read of `scripts/oracle-readiness-check.js` and the `/ready` checks |

## Stage A: collection ON, order path OFF (resumes research data, no orders)

1. Owner approves dispatching `oracle-paper-release.yml` for the exact SHA, knowing it starts the service (see above).
2. After the release reports success, the agent reads the state (read-only `oracle-host-diagnose.yml` with `health_only`).
3. Three different kinds of evidence are needed; none replaces another:
   - **Structure:** the running build has the switch and the env value is `OFF` (diagnose output of the build SHA; no order boundary exists, from the code and `tests/cloud-runtime-order-path-switch.test.js`).
   - **Behaviour:** an attempt that would produce an order does not. The decision-driven test now exists (PR #3120: `tests/cloud-runtime-order-path-switch-e2e.test.js`, ON control produces a FILL, OFF produces none). Stage A stays BLOCKED until that test has passed in exact-head CI AND is contained in the release SHA that Stage A deploys. Its scope is the tick-driven path of the CURRENT build; it does not cover every order entry point and it is not proof for the previous (rollback target) build, which is condition 0.5.
   - **Observation:** `paperOrderCount` and fill counts do not rise, and `lastMarketEventAt` and the research row counts do rise, read at two points at least one hour apart. Field names were not read from a running host; if a field is missing the check does not pass and the stage stays blocked.
4. If any check fails: stop the service first, confirm it is inactive, then follow the rollback.

### A failed release is not a stopped service

Read in `activate` (`deploy/oracle/nusa-release-step.sh`): when readiness or the soak fails, the script either restores the previous
build and restarts it, or, if the previous build cannot open the migrated database (`rollback_schema_compatible` fails), **keeps the
new build running** ("keeping $1 active (no rollback)") and exits with an error. So after any failed or ambiguous release the
agent must not assume the service is down:

1. Operator stops the service FIRST, without waiting for any report: `sudo systemctl stop nusa.service`, then confirms `ActiveState=inactive`
   and reports the output. Waiting for a status report while an order path may be alive is not allowed.
2. After the stop, the operator reports `readlink -f /opt/nusa/current` (the active SHA is still readable when the service is stopped) and the
   agent reads that the service is inactive. A running service is restarted only under a new owner approval and a complete Stage A evidence set.
3. Only then are the cause and the next release discussed. A failure message in the workflow log is never taken as proof that no order path is running.

## Stage B: order path ON (only after the permit fix; separate approval, separate release)

Preconditions in addition to Stage 0 (re-checked at that time, not carried over):

| # | Condition | Evidence |
| --- | --- | --- |
| B.1 | The #3108 permit fix is merged through the normal path (draft PR, independent review, exact-head CI, Audit) and released (same release rules) | PR, review, release run |
| B.2 | The Release HOLD and WIP evidence source is known. The Coordinator read path was never proven; after the Cloudflare removal (#3118) the source is the replacement chosen in S1. Until then #3108 stays `BLOCKED_WIP_UNKNOWN` and Stage B does not start | work order status |
| B.3 | The owner approves turning orders on, in writing, at that time | owner message |

1. The value is set to exactly `ON`. Deleting the line is NOT allowed (an unset value also enables orders, so a forgotten edit would not be an explicit decision).
2. The service is restarted only after B.1-B.3 are re-verified.
3. Verify, read-only: orders carry permit evidence; a rejection is recorded when the permit is missing (the rejection evidence the owner asked for); `ORDER_INTENT` is not failing for an unexplained reason; no order exists without permit evidence.
4. If an order appears without permit evidence: **stop the service first** and confirm it is inactive; only then set OFF and open a P0 issue. Changing the env file does not turn the order path off in a process that is already running. No restart without a new owner approval.

## Rollback (any stage)

1. Operator: `sudo systemctl stop nusa.service`; confirm `ActiveState=inactive` (the agent reads it).
2. Operator: set `NUSA_PAPER_ORDER_PATH=OFF` (and keep capital unset if 0.5 chose that).
3. Agent: set `expectedState` back to `STOPPED` in a PR (until it merges the watch may open an issue; it is read-only and restarts nothing).
4. Record the stop time. Research studies treat the stop as a gap (see `docs/research-ledger`).
5. A new start needs a new owner approval.

## After the start

- Re-pre-register the trade-flow study with the real span (`docs/RESEARCH_PREREG_2026-11-14_TRADEFLOW_60M_V2.md` is the template). Release the tooling change (#3110) before the new holdout, never during a holdout.
- Daily: confirm the service stays in the expected state; an unexpected start or stop is abnormal.

## Not covered here

LIVE trading or any real-money authority, changing risk, threshold, capital or writer-lease settings, deploying Cloudflare, and any host change by an agent session.
