# PAPER service restart runbook (2026-11-14)

Status: PROCEDURE, not an approval. Nothing in this file starts, releases or changes anything. Every step that touches the
host or runs a release needs the owner's approval at that time. Safety stays: PAPER_ONLY, `liveAuthority=NONE`,
`productionMutationAllowed=false`, `aiAuthority=ZERO_AUTHORITY`, Release=HOLD.

Background: the `nusa` service was stopped on 2026-11-13 (inactive, `NRestarts=0`) and the owner confirmed it stays
stopped (verified 17:18 KST 2026-11-14). A PAPER order path was running without permit evidence (#3108, still blocked).
Stopping the whole service also stopped research collection (an 18 h gap). The `NUSA_PAPER_ORDER_PATH` switch (merged in #3115)
lets collection run while the order path is off, so the restart is split into two stages.

## Roles

| Who | Does |
| --- | --- |
| Agent session | PRs, reviews, evidence reading (read-only host diagnose), updating this checklist. Never merges, approves, releases or edits the host. |
| Owner | approves each stage, dispatches the release workflow, approves host changes. |
| Operator (authorized, on the host) | sets the env value, runs `systemctl`, reports the outputs. |

## Stage 0: preconditions (all must be true; record the evidence for each)

| # | Condition | Evidence |
| --- | --- | --- |
| 0.1 | The switch is on `main` and in a released build: `NUSA_PAPER_ORDER_PATH` exists in the running `sourceCommitSha` (#3115 merged; release needs the owner to dispatch `oracle-paper-release.yml` for the current protected `main` SHA; exact-source CI must be success; backup about 30 min; the run must not be cancelled) | release run URL; `/health` or diagnose shows `sourceCommitSha` equal to released `main` |
| 0.2 | `deploy/health-watch.json` `expectedState` is changed to `RUNNING` in a reviewed PR that merges before the start (else the watch raises `UNEXPECTED_UP`) | merged PR |
| 0.3 | A fresh backup exists and the disk has free space (the host was 90% used in October; re-measure) | diagnose output |
| 0.4 | The owner states the start date, so research studies can be re-pre-registered with the real span | owner message |

## Stage A: collection ON, order path OFF (resumes research data, no orders)

1. Operator sets `NUSA_PAPER_ORDER_PATH=OFF` in `/etc/nusa/cloud-runtime.env` (`0600`). Any value other than exactly `ON` also disables orders.
2. Owner approves the start. Operator runs `sudo systemctl start nusa.service`.
3. Verify (agent reads via `oracle-host-diagnose.yml` with `health_only`; read-only):
   - `ActiveState=active`, `NRestarts=0`, `/health` returns `ok: true`.
   - `lastMarketEventAt` and the research row counts (order book, trade ticks) are advancing.
   - `paperOrderCount` and fill counts do not rise (no order path).
4. Stay in Stage A until the evidence is read at two points at least one hour apart. If any check fails: stop (rollback below).

## Stage B: order path ON (only after the permit fix)

Preconditions in addition to Stage 0:

| # | Condition | Evidence |
| --- | --- | --- |
| B.1 | The #3108 permit fix is merged through the normal path (draft PR, independent review, exact-head CI, Audit) and released (same release rules as 0.1) | PR, review, release run |
| B.2 | The Release HOLD and WIP evidence source is known. The Coordinator read path was never proven; after the Cloudflare removal (#3118 inventory) the source is the replacement chosen in S1. Until then #3108 stays `BLOCKED_WIP_UNKNOWN` and Stage B does not start | work order status |
| B.3 | The owner approves turning orders on, in writing, at that time | owner message |

1. Operator sets `NUSA_PAPER_ORDER_PATH=ON` (or removes the line) and restarts the service.
2. Verify, read-only: orders now carry permit evidence; a rejection is recorded when the permit is missing (the rejection evidence the owner asked for), `ORDER_INTENT` is not failing for an unexplained reason, and no order exists without permit evidence.
3. If an order appears without permit evidence: set OFF and stop immediately, open a P0 issue.

## Rollback (any stage)

1. Operator: set `NUSA_PAPER_ORDER_PATH=OFF`, `sudo systemctl stop nusa.service`.
2. Agent: set `expectedState` back to `STOPPED` in a PR (until it merges the watch may open an issue; it is read-only and restarts nothing).
3. Record the stop time. Research studies treat the stop as a gap (see `docs/research-ledger`).

## After the start

- Re-pre-register the trade-flow study with the real span (`docs/RESEARCH_PREREG_2026-11-14_TRADEFLOW_60M_V2.md` is the template). Release the tooling change (#3110) before the new holdout, never during a holdout.
- Daily: confirm the service stays in the expected state; an unexpected start or stop is abnormal.

## Not covered here

LIVE trading or any real-money authority, changing risk, threshold, capital or writer-lease settings, deploying Cloudflare, and any host change by an agent session.
