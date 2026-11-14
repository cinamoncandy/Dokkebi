# Health watch v2 design: read the deeper signals safely (2026-11-14)

Status: DESIGN PROPOSAL. Builds on the liveness-only watch (`.github/workflows/health-watch.yml`, merged in #3116). It changes no code,
workflow, secret or host setting. Any later step that adds a secret, a host setting or a write permission needs the owner's approval
and a non-author review. Safety stays: PAPER_ONLY, `liveAuthority=NONE`, `productionMutationAllowed=false`,
`aiAuthority=ZERO_AUTHORITY`.

## 1. What v1 cannot see

v1 reads the public `/health` route and only asks "does the host answer". On 2026-11-13/14 the two real problems were deeper:
the research collection stopped for 18 h, and orders were produced without permit evidence (#3108). Neither shows in a liveness probe.

## 2. Signals worth watching (from the code, not yet read from a running host)

| Signal | Where the code produces it | Alarm rule (proposal) |
| --- | --- | --- |
| Market data freshness | `lastMarketEventAt` in the runtime heartbeat | older than a fixed window while `expectedState` is RUNNING |
| Research collection | research row counts (order book, trade ticks) in the research status | no growth between two reads |
| Order without permit evidence | In `apps/cloud/src/runtime.ts` every cycle records a `PERMISSION` event (today always `SKIP` with `NO_CANONICAL_TRADE_PERMISSION_EVIDENCE`, because no permit evidence is produced yet, #3108), and `ORDER_INTENT` with status `PASS` only when the result is `FILLED`, `SKIP` when `WAIT`, `FAIL` otherwise; fills are recorded as `FILL` P0 only when it is CONFIRMED: in one cycle there is an `ORDER_INTENT` with status `PASS` or a `FILL`, AND the same cycle's `PERMISSION` event is present with a status other than `PASS` (`SKIP` or `FAIL`). A cycle with `PERMISSION SKIP` and `ORDER_INTENT FAIL` (or `SKIP`) is a normal refusal and is NOT an alarm. A cycle whose `PERMISSION` event is missing is NOT classified as a confirmed violation and NOT as safe: it is an observation failure (next row). After the #3108 fix the same rules hold, because a legitimate order then has a `PERMISSION PASS` |
| Observation incomplete | the learning timeline can be truncated or an event can be missing | a separate "observation failure" alarm when a cycle has an `ORDER_INTENT PASS` or `FILL` and its `PERMISSION` event is absent, when the returned window is incomplete or empty while orders exist, or when a cycle id cannot be linked. It says "evidence missing", never "violation confirmed" and never "OK"; a missing state is not treated as proof that the order was safe |
| Order path expected OFF | order and fill counters while the operator has the order path OFF (`NUSA_PAPER_ORDER_PATH`) | any increase |

All field names above must be read from a real response of a running host before any rule is written (the service is stopped now, so
this cannot be done today). A missing field is an alarm, never a pass.

## 3. The authentication problem (found 2026-11-14)

The deeper signals live behind the authenticated route `/api/paper-operations`. The only credential the runtime knows today,
`NUSA_CLOUD_DASHBOARD_TOKEN`, carries the scopes `dashboard:read`, `paper:trade`, `settings:read`, `settings:write` and `users:manage`
(`apps/cloud/src/cloudRuntimeConfig.ts`). **That token must never be stored as a GitHub Actions secret for a watch**: a leak would
grant trade, settings and user-management scopes.

Required first: a separate monitor credential with exactly `dashboard:read`, accepted only for a fixed allow-list of GET routes
(for example `/api/paper-operations`), and rejected everywhere else. This is a host code change (reviewed PR, test that a monitor
token cannot reach any other route or method, test that it never gains a write scope) plus an operator step (set the new variable in
the host env file) plus an owner step (store the same value as an Actions secret). Rotation and revocation are written into the same PR.

## 4. Watch behaviour

1. Same schedule and the same single issue per title as v1; the expected state still comes from `deploy/health-watch.json`.
2. The workflow gains `secrets` use, so `.github/workflow-authority-map.json` and its test must list it for that job (a governed change).
3. The token is passed only through the environment of one step, never echoed, never in an issue, a comment or an artifact. The issue text stays
   fixed text plus a reason code plus the run URL; no value from the response is copied.
4. Fail closed: an unreachable route, a non-200 answer, a malformed body or a missing field while the host is expected RUNNING is an alarm.
   While expected STOPPED the watch does not call the authenticated route at all.
5. The watch only reads. It never restarts, deploys or changes anything.

### Token handling requirements (all tested in W2/W3)

- The monitor token is sent only in an `Authorization` header from one step's environment; never in a URL, a query string or a command-line argument.
- An authentication failure never prints the token or the header, and the step does not run with shell tracing on.
- The token and the response body are never written to an artifact, a debug output, a comment or an issue (the issue text stays fixed text, a reason code and the run URL). A regression test greps the workflow for any echo of the secret and the issue builder for any response field.
- On the host the monitor credential is rejected for every route and method outside the fixed GET allow-list, and it never gains a write scope; both are tested.
- Revoking or rotating the credential makes the watch fail closed (an alarm), never a silent pass; the rotation steps are written in the W2 PR.

## 5. Order of work (each one PR)

| Step | Change | Needs |
| --- | --- | --- |
| W1 | Read the field names from a running host (after the owner restarts it) and record them | restart approval (runbook Stage A) |
| W2 | Monitor-credential code and tests on the host (section 3) | non-author review; release; operator and owner steps |
| W3 | Watch v2 workflow with the rules of section 2 and the authority map entry | owner approval for the secret and `secrets` permission; non-author review |

W1 depends on the service running, so until the restart (blocked by the runbook preconditions) it cannot start. W2 (host code and tests) does not depend on W1 and can start at once.

W3 is complete only when all of these hold: the W2 code passed an independent review and is released; the monitor token's read-only scope and route limit are verified; W1 confirmed the real response fields; the owner approved storing the Actions secret; and the W3 PR has exact-head CI and an independent review.

## 6. Not in scope

LIVE trading, any real-money authority, relaxing risk, threshold, capital or gate settings, using the broad dashboard token anywhere
outside the host, and any host change from an agent session.
