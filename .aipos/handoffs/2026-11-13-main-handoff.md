# CORE handoff — learning loop LL1, trade-flow study, release discipline (2026-11-13)

Observed: `2026-11-13` (Asia/Seoul). Everything below is what the records claim at about 15:00 KST; re-verify on GitHub and `/health` before acting.

## Canonical state

- Protected `main`: `12e5542357a8e66923a4fb2a4f5f53be7bdad620` (merge of #3102) plus later docs/defensive merges #3103 and #3094. The host runs `12e554235` (released 2026-11-13 13:33-14:11 KST, restarts 0). #3103 (comment/defensive code only) is merged but **not released on purpose** (see Release discipline).
- Safety is unchanged: PAPER_ONLY, `liveAuthority=NONE`, `productionMutationAllowed=false`, `aiAuthority=ZERO_AUTHORITY`. Nothing in this period touched a limit, threshold, gate, risk setting or capital.
- `/health runtime.closedLearningLoop` (2026-11-13): realized periods 239 (all owner baseline), `cyclesEvaluated=0`, `deployments=0`, `bootstrap=RESEARCH_NOT_DEPLOYABLE`, `bootstrapReasons` = `ALLOCATION_NO_ALLOCATABLE_CANDIDATES`, `NO_ALLOCATION_ADVISORY`; 5 judged candidates, all `donchian`, all rejected by the qualification gates. The first 9 candidates (all `sma`) were also all rejected. The gates work; the blocker is candidate supply.

## What landed (2026-11-11 to 11-13)

- Research data: #3090 15m/60m datasets accept only exchange-proven 1m absences; the known 299-minute candle gap (2026-11-09) ages out about 2026-11-21 KST.
- Release path: #3091/#3092 (CI lookups no longer filter `status=completed`, which hid newest runs). P0 #1461 is closed.
- `/health` diagnostics (fixed codes only, allow-listed): #3093/#3095/#3096/#3097 bootstrap reasons, qualification counts and rejection codes, candidate families; #3098 `futuresCollector.lastFailureClass` (`HTTP_451`: Binance futures is region-blocked, nothing stored; any workaround is an owner decision); #3099 `tradeTickCoverage` (hours with a tick, no study bar).
- Study: #3100 pre-registration `docs/RESEARCH_PREREG_2026-11-13_TRADEFLOW_60M.md` (`ML_TRADEFLOW_60M_20261113`; **it repeats a hypothesis that already failed on 2026-10-13**, `ML_TRADES_FLOW_15M_20261013`, disclosed in the document); #3101 `scripts/run-tradeflow-study.js` + tests; #3102 service hook and host-diagnosis line `tradeflow_study`.
- Docs: #3094 `docs/LEARNING_LOOP_LEVELS_20261112.md` (LL1..LL8, owner approved, independent review accepted). Future LL7 criteria need a record schema before implementation.

## Schedule (KST unless stated)

- The research timer runs once a day at about 00:16 UTC (09:16 KST). Study lines therefore appear once a day.
- **2026-11-14 09:17**: first `TRADEFLOW_STUDY` line; it must be `WAITING_DATA`. Read it with `oracle-host-diagnose.yml` (`health_only=true` is enough; the line is `tradeflow_study=`).
- 2026-11-14..11-20: trade-flow validation and holdout hours (UTC 11-14 00:00 to 11-20 00:00). **Do not release in this window**: the release backup stalls tick collection for about 30 minutes and a gap counts against the 90% bars. Nobody may read trade-tick values from 2026-11-14T00:00Z until the run.
- 2026-11-18 11:00 and after: second order-book study verdict (the line also appears once a day, so possibly 11-19 09:17).
- **2026-11-21 09:17**: first run that can produce the trade-flow result (the 11-20 run at 09:16 is before END + 30 min and prints `WAITING_DATA`). Record the result in `docs/research-ledger/experiments.json` and a work order. Order-book rows are kept about 14 days, so the first training hour may lose a few rows; the bar is 152 of 168 hours.
- After 11-21: one release carries #3103 and anything later.

## Release discipline and gotchas learned

- `oracle-paper-release.yml` (manual dispatch, full 40-character main SHA) needs: main CI and Cloudflare deploy success on that SHA, main quiet >= 10 minutes, `/health` 200 under 3 s twice, no release running, P0 #1461 closed. The backup step stalls `/health` for 25-30 minutes; that is normal. **Do not cancel it.** During this period the workflow was disabled (`disabled_manually`) twice and one release was cancelled at the backup step by something other than this session; the owner attributed it to a Codex task. If it recurs, check Settings -> Audit log.
- If a PR has green CI but no audit run, re-run the `Autopilot GitHub Event Bridge` workflow_run job once; the Worker then dispatches the audit. Auto-merge in the UI needs the confirm click.
- `.aipos/CURRENT_TRUTH.md` goes stale whenever another PR merges first (work-order counts); regenerate with `node scripts/generate-aipos-current-truth.js` after merging main. A `test` gate failing with `[ "cancelled" = "success" ]` is an old head cancelled by a newer push.
- `gh pr view`/GraphQL is blocked in this sandbox; use the GitHub MCP tools or REST (`gh run list`, `gh workflow enable`).
- Times: say KST to the owner. The sandbox clock is UTC; do not mix them (an earlier hour label in this session was wrong by that).

## Open items and owner-only decisions

- Owner decisions, not mine: K for the trade-flow study is 198 (pooled with the order-book family; a looser choice needs a new pre-registration); any region-block workaround for futures; `mutationAllowed=false` and the 12-file scope of the FORGE execution envelope; coding engine/cost/keys; widening sandbox scope.
- FORGE L2 stages 1 and 2 (`docs/FORGE_L2_ROADMAP_20261111.md`): no honest wiring or deletion is available for the 6 + 6 ledger functions; held for an owner structure decision. Do not wire fake callers to shrink the ledger.
- #3081 (owner's draft) revalidates absence for 1m only; after it merges, 15m/60m need the same follow-up.
- Daily host check (`trig_01EsThfZSo7b3Qog4fDVGb19`, about 09:28 KST): report only abnormal state. Known: one 299-minute candle gap; `TICK_ERROR PAPER_WRITER_LEASE_LOST` last blocked 2026-11-12 15:34 KST; many `MAX_DAILY_BUY_NOTIONAL` rejections under the owner's 3x limit; event-loop stalls of up to 29 s were seen on 11-12 during research manifest builds.

## Not verified

- Whether the trade ticks from 2026-11-06 stay readable until 2026-11-21 (the store caps 2,000,000 ticks per market and has no time-based prune; this was reasoned from code, not read from the host).
- Why the first-run `TRADEFLOW_STUDY` line is absent now: reasoned as "the daily timer has not run since the 13:33 release", to be confirmed on 11-14 09:17.
