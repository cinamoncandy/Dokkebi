import type { PersonalPaperOrderCommand } from "../../../packages/contracts/src/personalPaperOrderCommand";
import type { MobileDashboardApiInput } from "./mobileDashboardApi";
import {
  PaperTradingExecutionLoop,
  type PaperExecutionResult,
  type PaperExecutionTick,
  type PaperManualOrderContext
} from "./paperTradingExecutionLoop";
import type { CloudPaperRiskGate, CloudPaperRiskRequest } from "./cloudPaperCanonicalRiskGateway";
import { validatePaperCandidateExecutionBinding } from "./cioDecisionEngine";
import { buildPaperExecutionIntent, UPBIT_KRW_MINIMUM_ORDER_KRW, paperExecutionIntentCommandId, validatePaperExecutionIntent } from "./paperExecutionIntent";
import { PaperRuntimeExecutionCostEvidenceError, validatePaperObservedExecutionDepth, validatePaperObservedExecutionQuote } from "./paperRuntimeExecutionCostEvidence";
import { automaticPaperConfidenceAllowsAction } from "./automaticPaperExecutionPolicy";

export interface CloudPaperExecutionBoundaryOptions {
  readonly loop: PaperTradingExecutionLoop;
  readonly riskGate: CloudPaperRiskGate;
  readonly readP0State: () => Readonly<{ openP0: boolean }>;
  readonly maximumMarketAgeMs?: number;
}

export type PaperManualOrderAllocationContext = PaperManualOrderContext & { readonly investmentPercent?: number };

const normalizedHealth = (value: MobileDashboardApiInput["overallHealth"]): CloudPaperRiskRequest["overallHealth"] => value === "HEALTHY" ? "HEALTHY" : "DEGRADED";

/**
 * The only production Cloud PAPER mutation boundary.
 * The underlying execution loop keeps its existing deterministic simulator semantics, but its
 * mutation methods are never invoked here until the canonical risk adapter returns ALLOW.
 */
export class CloudPaperExecutionBoundary {
  private readonly maximumMarketAgeMs: number;

  public constructor(private readonly options: CloudPaperExecutionBoundaryOptions) {
    this.maximumMarketAgeMs = options.maximumMarketAgeMs ?? 30_000;
    if (!Number.isSafeInteger(this.maximumMarketAgeMs) || this.maximumMarketAgeMs < 1_000) throw new Error("cloud PAPER maximum market age is invalid");
  }

  public submitManualOrder(approvedBy: string, command: PersonalPaperOrderCommand, context: PaperManualOrderAllocationContext): PaperExecutionResult {
    const state = this.options.loop.snapshot();
    if (!command.idempotencyKey.trim() || command.authority !== "PAPER_ONLY" || command.productionMutationAllowed !== false || !command.market.trim() || !Number.isFinite(command.quantity) || command.quantity <= 0) {
      return this.options.loop.submitManualOrder(command, context);
    }

    // Preserve the simulator's existing duplicate/conflict semantics without claiming a second
    // canonical idempotency record for a command the PAPER account has already resolved.
    if (state.orders.some((order) => order.idempotencyKey === command.idempotencyKey) || state.processedIdempotencyKeys.includes(command.idempotencyKey)) {
      return this.options.loop.submitManualOrder(command, context);
    }

    if (command.orderType === "LIMIT") {
      const limit = command.limitPrice;
      if (!Number.isFinite(limit) || (limit ?? 0) <= 0) return this.options.loop.submitManualOrder(command, context);
    }

    if (command.side === "BUY") {
      const investmentPercent = context.investmentPercent ?? 100;
      if (!Number.isFinite(investmentPercent) || investmentPercent < 0 || investmentPercent > 100) return this.blocked("INVALID_INVESTMENT_ALLOCATION");
      if (command.market.trim().toUpperCase().startsWith("KRW-") && command.quantity * context.marketPrice < UPBIT_KRW_MINIMUM_ORDER_KRW) return this.rejected("PAPER_ORDER_BELOW_EXCHANGE_MINIMUM");
      // Conservative 0.1% fee buffer keeps the protected cash envelope intact even though the
      // simulator's production fee is currently lower. SELL/exit paths are intentionally unaffected.
      const requiredCash = command.quantity * context.marketPrice * 1.001;
      const investableCash = state.cash * (investmentPercent / 100);
      if (!Number.isFinite(requiredCash) || requiredCash > investableCash + 1e-8) return this.blocked("PAPER_INVESTMENT_ALLOCATION_EXCEEDED");
    }

    const openP0 = this.readOpenP0();
    if (openP0 !== false) return this.blocked(openP0 === true ? "OPEN_P0_ALERT" : "P0_STATE_UNVERIFIABLE");
    const risk = this.options.riskGate.evaluate({
      path: "MANUAL",
      commandId: command.idempotencyKey,
      signalId: command.idempotencyKey,
      clientOrderId: command.idempotencyKey,
      strategyId: "MANUAL",
      market: command.market.trim().toUpperCase(),
      side: command.side,
      quantity: command.quantity,
      price: context.marketPrice,
      now: context.now,
      observedAt: context.observedAt,
      maximumMarketAgeMs: this.maximumMarketAgeMs,
      killSwitchActive: context.killSwitchActive,
      openP0,
      overallHealth: normalizedHealth(context.overallHealth),
      state,
      approvedBy
    });
    if (risk.status !== "ALLOW") return this.riskResult(risk.status, risk.reasonCodes);
    const execution = command.orderType === "LIMIT"
      ? this.options.loop.openLimitOrder(command, context)
      : this.options.loop.submitManualOrder(command, context);
    return this.withRisk(execution, risk);
  }


  public fillWorkingOrder(approvedBy: string, orderId: string, fillQuantity: number, context: PaperManualOrderAllocationContext, fillEventId?: string): PaperExecutionResult {
    const working = (this.options.loop.snapshot().workingOrders ?? []).find((order) => order.id === orderId);
    if (working == null) return this.options.loop.fillWorkingOrder(orderId, fillQuantity, context, fillEventId);
    if (working.executionIntent != null || working.candidateProvenance != null) return this.rejected("PAPER_STRATEGY_WORKING_ORDER_AUTOMATIC_ONLY");
    const openP0 = this.readOpenP0();
    if (openP0 !== false) return this.blocked(openP0 === true ? "OPEN_P0_ALERT" : "P0_STATE_UNVERIFIABLE");
    const risk = this.options.riskGate.evaluate({
      path: "MANUAL", commandId: fillEventId?.trim() || `fill:${orderId}:${working.lifecycle.transitionSequence}`,
      signalId: working.idempotencyKey, clientOrderId: working.id, strategyId: "MANUAL",
      market: working.market, side: working.side, quantity: Math.min(fillQuantity, working.lifecycle.remainingQuantity),
      price: context.marketPrice, now: context.now, observedAt: context.observedAt, maximumMarketAgeMs: this.maximumMarketAgeMs,
      killSwitchActive: context.killSwitchActive, openP0, overallHealth: normalizedHealth(context.overallHealth),
      state: this.options.loop.snapshot(), approvedBy
    });
    if (risk.status !== "ALLOW") return this.riskResult(risk.status, risk.reasonCodes);
    return this.withRisk(this.options.loop.fillWorkingOrder(orderId, fillQuantity, context, fillEventId), risk);
  }

  public cancelWorkingOrder(approvedBy: string, orderId: string, context: PaperManualOrderAllocationContext): PaperExecutionResult {
    const working = (this.options.loop.snapshot().workingOrders ?? []).find((order) => order.id === orderId);
    if (working == null) return this.options.loop.cancelWorkingOrder(orderId, context.now);
    const openP0 = this.readOpenP0();
    if (openP0 !== false) return this.blocked(openP0 === true ? "OPEN_P0_ALERT" : "P0_STATE_UNVERIFIABLE");
    const risk = this.options.riskGate.evaluate({
      path: "MANUAL", commandId: `cancel:${orderId}:${working.lifecycle.transitionSequence}`,
      signalId: working.idempotencyKey, clientOrderId: working.id, strategyId: "MANUAL",
      market: working.market, side: working.side, quantity: working.lifecycle.remainingQuantity,
      price: context.marketPrice, now: context.now, observedAt: context.observedAt, maximumMarketAgeMs: this.maximumMarketAgeMs,
      killSwitchActive: context.killSwitchActive, openP0, overallHealth: normalizedHealth(context.overallHealth),
      state: this.options.loop.snapshot(), approvedBy
    });
    if (risk.status !== "ALLOW") return this.riskResult(risk.status, risk.reasonCodes);
    return this.withRisk(this.options.loop.cancelWorkingOrder(orderId, context.now), risk);
  }

  public processTick(tick: PaperExecutionTick & { readonly investmentPercent?: number }): PaperExecutionResult {
    const stateBeforeDecision = this.options.loop.snapshot();
    const strategyWorkingOrders = (stateBeforeDecision.workingOrders ?? []).filter((order) => order.market === tick.market.trim().toUpperCase() && order.executionIntent != null);
    if (strategyWorkingOrders.length > 1) return this.blocked("PAPER_STRATEGY_WORKING_ORDER_AMBIGUOUS");
    if (strategyWorkingOrders.length === 1) {
      const working = strategyWorkingOrders[0]!;
      let intent;
      try { intent = validatePaperExecutionIntent(working.executionIntent!); }
      catch { return this.blocked("PAPER_STRATEGY_WORKING_INTENT_INVALID"); }
      if (working.candidateProvenance == null) return this.blocked("PAPER_STRATEGY_WORKING_PROVENANCE_REQUIRED");
      let binding;
      try { binding = validatePaperCandidateExecutionBinding(working.candidateProvenance.binding, working.candidateProvenance.decisionAt); }
      catch { return this.blocked("PAPER_STRATEGY_WORKING_PROVENANCE_INVALID"); }
      if (working.idempotencyKey !== paperExecutionIntentCommandId(intent) ||
          working.requestFingerprint !== intent.intentFingerprintSha256 ||
          working.requestedQuantity !== intent.quantity ||
          working.side !== intent.side ||
          working.candidateProvenance.decisionAt !== intent.decisionDecidedAt ||
          binding.candidateId !== intent.candidateId ||
          binding.bindingFingerprintSha256 !== intent.candidateBindingFingerprintSha256) {
        return this.blocked("PAPER_STRATEGY_WORKING_IDENTITY_MISMATCH");
      }
      // A challenger replacement revokes the earlier binding, but its open working order would keep
      // filling inside the new binding's realized window (and block the new challenger, since only
      // one strategy working order may exist per market). When the current decisions for this market
      // are bound to a different candidate binding, the order belongs to a superseded strategy
      // version: cancel it (risk-reducing, no new exposure) instead of continuing it.
      const currentBindings = tick.decisions
        .filter((decision) => decision.symbol === working.market && decision.paperCandidateBinding != null)
        .map((decision) => decision.paperCandidateBinding!.bindingFingerprintSha256);
      if (currentBindings.length > 0 && !currentBindings.includes(binding.bindingFingerprintSha256)) {
        return this.options.loop.cancelWorkingOrder(working.id, tick.now);
      }
      // A BUY restored from before the exchange-minimum rule cannot be sent to the exchange: cancel it
      // (risk-reducing, no new exposure) rather than filling a sub-minimum order.
      if (intent.side === "BUY" && intent.market.startsWith("KRW-") && intent.allocationCapital < UPBIT_KRW_MINIMUM_ORDER_KRW) {
        return this.options.loop.cancelWorkingOrder(working.id, tick.now);
      }
      const openP0 = this.readOpenP0();
      if (openP0 !== false) return this.blocked(openP0 === true ? "OPEN_P0_ALERT" : "P0_STATE_UNVERIFIABLE");
      const lastOrderBookObservedAt = working.lastOrderBookObservedAt ?? 0;
      if (lastOrderBookObservedAt > 0) {
        if (tick.observedQuote?.depth == null || tick.observedQuote.depthFingerprintSha256 == null) {
          return Object.freeze({ status: "WAIT", reason: "PAPER_STRATEGY_WORKING_WAITING_FOR_DEPTH", orders: Object.freeze([]), fills: Object.freeze([]), state: stateBeforeDecision });
        }
        if (tick.observedQuote.observedAt <= lastOrderBookObservedAt) {
          return Object.freeze({ status: "WAIT", reason: "PAPER_STRATEGY_WORKING_WAITING_FOR_NEW_DEPTH", orders: Object.freeze([]), fills: Object.freeze([]), state: stateBeforeDecision });
        }
      }
      const quoteFailure = this.executionQuoteFailure(tick);
      if (quoteFailure != null) return quoteFailure;
      const continuationCommandId = `${working.idempotencyKey}:continue:${working.lifecycle.transitionSequence + 1}`;
      const risk = this.options.riskGate.evaluate({
        path: "STRATEGY",
        commandId: continuationCommandId,
        signalId: working.idempotencyKey,
        clientOrderId: working.id,
        strategyId: intent.candidateId,
        market: working.market,
        side: working.side,
        quantity: working.lifecycle.remainingQuantity,
        price: tick.price,
        now: tick.now,
        observedAt: tick.observedAt,
        maximumMarketAgeMs: this.maximumMarketAgeMs,
        killSwitchActive: tick.killSwitchActive,
        openP0,
        overallHealth: normalizedHealth(tick.overallHealth),
        state: stateBeforeDecision,
        payloadFingerprintSha256: intent.intentFingerprintSha256
      });
      if (risk.status !== "ALLOW") return this.riskResult(risk.status, risk.reasonCodes);
      return this.withRisk(this.options.loop.advanceStrategyWorkingOrder(working.id, tick), risk);
    }

    const actionable = tick.decisions
      .filter((decision) => decision.symbol === tick.market && (decision.action === "BUY" || decision.action === "SELL"))
      .sort((left, right) => left.symbol.localeCompare(right.symbol) || left.action.localeCompare(right.action));
    if (actionable.length === 0) return this.options.loop.processTick(tick);
    if (actionable.length !== 1) return this.blocked("PAPER_EXECUTION_INTENT_AMBIGUOUS");
    if (tick.portfolio == null) return this.blocked("PAPER_PORTFOLIO_EXECUTION_INTENT_REQUIRED");

    const openP0 = this.readOpenP0();
    if (openP0 !== false) return this.blocked(openP0 === true ? "OPEN_P0_ALERT" : "P0_STATE_UNVERIFIABLE");
    const state = stateBeforeDecision;
    const investmentPercent = tick.investmentPercent ?? 100;
    if (!Number.isFinite(investmentPercent) || investmentPercent < 0 || investmentPercent > 100) return this.blocked("INVALID_INVESTMENT_ALLOCATION");

    const decision = actionable[0]!;
    // Generic CIO decisions remain advisory. Automatic PAPER mutation is allowed only when the
    // action is the exact output of an immutable, currently bound Research/League challenger.
    if (decision.paperCandidateBinding == null || decision.paperCandidateStrategyDecision == null) {
      return this.blocked("PAPER_CANDIDATE_BINDING_REQUIRED");
    }
    let candidateBinding;
    try { candidateBinding = validatePaperCandidateExecutionBinding(decision.paperCandidateBinding, decision.decidedAt); }
    catch { return this.blocked("PAPER_CANDIDATE_BINDING_INVALID"); }
    const candidateDecision = decision.paperCandidateStrategyDecision;
    if (candidateBinding.candidateStrategy == null ||
        candidateDecision.action !== decision.action ||
        candidateDecision.score !== decision.score ||
        candidateDecision.confidence !== decision.confidence ||
        !Number.isSafeInteger(candidateDecision.observedAt) ||
        candidateDecision.observedAt < candidateBinding.periodStartAt ||
        candidateDecision.observedAt > decision.decidedAt ||
        !candidateDecision.reason.trim()) {
      return this.blocked("PAPER_CANDIDATE_STRATEGY_DECISION_INVALID");
    }

    // Cloud automatic strategy authority is deliberately PAPER-only and spot-only. An actionable
    // challenger decision must be self-consistent before it is even presented to the canonical risk gate.
    if (tick.mode !== "PAPER" || decision.leverage !== 1 || decision.risk === "HIGH" || decision.risk === "CRITICAL" ||
        !automaticPaperConfidenceAllowsAction(decision.confidence) ||
        !Number.isFinite(decision.allocation) || decision.allocation < 0 || decision.allocation > 1 ||
        (decision.action === "BUY" && decision.allocation <= 0)) {
      return this.blocked("STRATEGY_APPROVAL_REJECTED");
    }

    let executionIntent;
    try {
      executionIntent = buildPaperExecutionIntent({
        now: tick.now,
        market: tick.market,
        referencePrice: tick.price,
        portfolio: tick.portfolio,
        decision,
        state,
        investmentPercent,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "PAPER_EXECUTION_INTENT_INVALID";
      if (reason === "PAPER_EXECUTION_INTENT_ALLOCATION_ZERO") return this.rejected("decision allocation is zero");
      if (reason === "PAPER_EXECUTION_INTENT_POSITION_REQUIRED") return this.rejected("insufficient paper position");
      return this.blocked(reason.startsWith("PAPER_EXECUTION_INTENT_") ? reason : "PAPER_EXECUTION_INTENT_INVALID");
    }

    if (executionIntent.side === "BUY" && executionIntent.market.startsWith("KRW-") && tick.observedQuote != null &&
        executionIntent.quantity * tick.observedQuote.askPrice < UPBIT_KRW_MINIMUM_ORDER_KRW) {
      return this.blocked("PAPER_EXECUTION_INTENT_EXECUTABLE_QUOTE_BELOW_MINIMUM");
    }

    if (executionIntent.side === "BUY") {
      // Owner capital-allocation protection remains an independent outer envelope around the
      // canonical PortfolioPlan target. Portfolio may reduce the intent, but cannot widen this cap.
      const requiredCash = executionIntent.quantity * tick.price * 1.001;
      const investableCash = state.cash * (investmentPercent / 100);
      if (!Number.isFinite(requiredCash) || requiredCash > investableCash + 1e-8) {
        return this.blocked("PAPER_INVESTMENT_ALLOCATION_EXCEEDED");
      }
    }

    const quoteFailure = this.executionQuoteFailure(tick);
    if (quoteFailure != null) return quoteFailure;
    const commandId = paperExecutionIntentCommandId(executionIntent);
    const risk = this.options.riskGate.evaluate({
      path: "STRATEGY",
      commandId,
      signalId: commandId,
      clientOrderId: commandId,
      strategyId: executionIntent.candidateId,
      market: executionIntent.market,
      side: executionIntent.side,
      quantity: executionIntent.quantity,
      price: tick.price,
      now: tick.now,
      observedAt: tick.observedAt,
      maximumMarketAgeMs: this.maximumMarketAgeMs,
      killSwitchActive: tick.killSwitchActive,
      openP0,
      overallHealth: normalizedHealth(tick.overallHealth),
      state,
      payloadFingerprintSha256: executionIntent.intentFingerprintSha256
    });
    if (risk.status !== "ALLOW") return this.riskResult(risk.status, risk.reasonCodes);

    // PortfolioPlan -> immutable intent -> canonical risk -> execution is now one identity chain.
    // LIVE/production mutation authority remains absent by design.
    const execution = this.options.loop.processTick(Object.freeze({
      ...tick,
      quantity: executionIntent.quantity,
      executionIntent,
    }));
    return this.withRisk(execution, risk);
  }

  /** Never admit a production strategy fill into the simulator's incomplete-cost fallback. */
  private executionQuoteFailure(tick: PaperExecutionTick): PaperExecutionResult | null {
    if (tick.observedQuote == null) return this.blocked("INVALID_ORDERBOOK_QUOTE");
    try {
      validatePaperObservedExecutionQuote(tick.observedQuote, tick.market, tick.now);
      if (tick.observedQuote.depth != null || tick.observedQuote.depthFingerprintSha256 != null) {
        validatePaperObservedExecutionDepth(tick.observedQuote, tick.market, tick.now);
      }
      return null;
    } catch (error) {
      return this.blocked(error instanceof PaperRuntimeExecutionCostEvidenceError ? error.code : "INVALID_ORDERBOOK_QUOTE");
    }
  }

  private readOpenP0(): boolean | null {
    try { return this.options.readP0State().openP0; }
    catch { return null; }
  }

  private riskResult(status: "REJECT" | "HALT", reasonCodes: readonly string[]): PaperExecutionResult {
    return Object.freeze({
      status: status === "REJECT" ? "REJECTED" : "BLOCKED",
      reason: `PAPER_RISK_${status}:${reasonCodes.join(",") || "UNSPECIFIED"}`,
      orders: Object.freeze([]),
      fills: Object.freeze([]),
      state: this.options.loop.snapshot(),
      risk: Object.freeze({ status, reasonCodes: Object.freeze([...reasonCodes]) })
    });
  }

  private rejected(reason: string): PaperExecutionResult {
    return Object.freeze({ status: "REJECTED", reason, orders: Object.freeze([]), fills: Object.freeze([]), state: this.options.loop.snapshot() });
  }

  private blocked(reason: string): PaperExecutionResult {
    return Object.freeze({ status: "BLOCKED", reason, orders: Object.freeze([]), fills: Object.freeze([]), state: this.options.loop.snapshot() });
  }

  private withRisk(result: PaperExecutionResult, risk: Readonly<{ readonly status: "ALLOW" | "REJECT" | "HALT"; readonly reasonCodes: readonly string[] }>): PaperExecutionResult {
    return Object.freeze({ ...result, risk: Object.freeze({ status: risk.status, reasonCodes: Object.freeze([...risk.reasonCodes]) }) });
  }
}
