/**
 * The exported functions in `apps/autopilot/src` that no running code calls, and a ratchet that
 * stops the number from growing.
 *
 * Every one of these is reached only by its own test file. A passing test suite is not evidence
 * that the system runs a function, and this repository has been caught by that repeatedly: a guard
 * gets written, tested, reviewed and merged, and nothing ever invokes it. `adviseConcurrency` was
 * the clearest case -- complete, fail-closed, and with no caller because nothing produced the
 * evidence it consumes.
 *
 * The split in `autonomousExecutionState.ts` is the one worth reading twice. `createExecutionState`,
 * `acquireExecutionLease` and `transitionExecution` are wired; `applyExecutionHold`,
 * `clearExecutionHold`, `authorizeMergeReady`, `recoverExpiredLease` and `isDuplicateExecution` are
 * not. What is wired is the happy path. What is not wired is every guard. The live spine
 * (`productionExecutionSpine.ts`, 99 lines, imported by `index.ts` and `scheduledRuntime.ts`)
 * advances the state to CODING_DISPATCHED and returns, so no status after that is ever entered.
 *
 * This is not a claim that any gate is bypassed. HOLD, Audit and Release are enforced by branch
 * protection, the CI workflows and the `nusa-release-authority` App, none of which depend on this
 * module. The narrower and still important consequence is that this state machine is not the
 * control plane's state of record: anything keyed off it -- throughput accounting, WIP admission,
 * adaptive concurrency, time-in-AUDIT, rework attribution -- would be reading a value that never
 * changes.
 *
 * Wiring all of them at once is the obvious fix and the wrong move: each one needs a caller that
 * makes sense, and several are waiting on execution paths that do not exist yet (#2117's worker
 * runner among them). So the count is held and made visible instead.
 * `tests/autopilot-control-plane-wiring.test.js` requires this list to match the tree exactly.
 * Adding an unwired export fails. Wiring one and leaving it listed fails too -- which is the point:
 * the list can only shrink, and the diff that shrinks it is the record of the work.
 *
 * Entries are `<file>#<exportedFunction>`, relative to `apps/autopilot/src`.
 */

export const UNWIRED_CONTROL_PLANE_DEBT: readonly string[] = Object.freeze([
  "autonomousExecutionState.ts#applyExecutionHold",
  "autonomousExecutionState.ts#authorizeMergeReady",
  "autonomousExecutionState.ts#clearExecutionHold",
  "autonomousExecutionState.ts#isDuplicateExecution",
  "autonomousExecutionState.ts#recoverExpiredLease",
  "evolveAutonomousSelector.ts#selectNonConflictingEvolutionOpportunities",
  "evolveCircuitBreaker.ts#canAttemptCircuitRecovery",
  "evolveCircuitBreaker.ts#resetCircuitBreaker",
  "evolveLearningConfidenceBridge.ts#projectLearningMemoryToConfidence",
  "evolvePaperCalibrationDecision.ts#projectPaperCalibrationLearningDecision",
  "evolvePromotion.ts#decidePaperCalibratedEvolutionPromotion",
  "evolveRanking.ts#rankEvolutionOpportunity",
  "evolveRuntimeEvidenceAdapter.ts#adaptRuntimeEvidenceToLifecycle",
  "evolveScheduledOpportunityBridge.ts#coordinateScheduledEvolution",
  "evolveStrategyLifecyclePolicy.ts#decideStrategyCalibrationContainment",
  "evolveStrategyLifecyclePolicy.ts#decideStrategyEdgeDecayContainment",
  "evolveValidation.ts#createEvolutionValidationResult",
  "executionCoordinator.ts#clearPersistentControlPlaneHold",
  "opportunityPlanner.ts#planOpportunity",
  "opportunityPlanner.ts#rankOpportunities",
  // #2185 intentionally lands the deterministic provider-local primitive before runtime wiring;
  // these entries are removed only when the canonical provider caller consumes the state machine.
  "providerBackpressure.ts#admitProviderRequest",
  "providerBackpressure.ts#createProviderBackpressureState",
  "providerBackpressure.ts#recordProviderCompletion",
  "providerBackpressure.ts#recordProviderRateLimit",
  "providerBackpressure.ts#recordProviderSuccess",
  "outcomeFeedback.ts#assessOutcome",
  "referenceIntelligenceIssueHandoff.ts#buildReferenceOwnerIssueDraft",
  // #2128 states plainly that the worker pool creates no branches, worktrees or side effects, so
  // these having no caller yet is the declared design rather than a missed wiring. They stay listed
  // because the ledger is a measurement, not a judgement: #2117's runner integration is what removes
  // them, and leaving them out would hide exactly the work this issue is tracking.
  // #2117 now has a real evidence producer and adviseConcurrency is therefore wired. The
  // production evaluation boundary still waits on the worker-runner outcome stream; inventing a
  // synthetic ThroughputWindow here would turn missing measurements into fake runtime evidence.
  "workerThroughputEvidence.ts#evaluateWorkerPoolConcurrency",
  "worktreeWorkerPool.ts#admitWorkerTask",
  "worktreeWorkerPool.ts#completeWorkerClaim",
  "worktreeWorkerPool.ts#createWorkerPoolState",
  "worktreeWorkerPool.ts#renewWorkerLease",
  "worktreeWorkerPool.ts#startWorkerClaim",
]);
