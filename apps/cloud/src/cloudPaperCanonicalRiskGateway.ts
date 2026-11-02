import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../../../packages/storage/src/index";
import { SqliteRiskSafetyPersistence } from "../../../packages/storage/src/index";
import type { PreTradeRiskRequest } from "../../../packages/contracts/src/riskGateway";
import { CanonicalRiskSafetyGate } from "../../../packages/contracts/src/risk-safety-integration";
import { paperTradingDayKey, paperTradingDayStartedAt } from "./paperTradingDay";
import { evaluatePreTradeRisk, type IndependentRiskLimits, type RiskIdentityState } from "./independentRiskGateway";
import { RUNTIME_EXCHANGE_CAPABILITIES } from "./runtimeExchangeCapabilities";
import type { PaperAccountState } from "./paperTradingExecutionLoop";
import { AccountScopedRiskPersistence, SessionPeakStore, resolveRiskAccountId } from "./cloudPaperRiskAccountScope";

const MANUAL_APPROVAL_TTL_MS = 60_000;

/** Owner-approved Cloud spot PAPER policy; only the consecutive-loss veto is disabled. */
export const CLOUD_PAPER_RISK_LIMITS: IndependentRiskLimits = Object.freeze({
  maxOrderNotional: 2_000_000,
  maxPositionNotional: 2_000_000,
  maxOpenOrders: 1,
  maxOrdersPerSecond: 1,
  maxOrdersPerMinute: 60,
  maxSameSideStreak: 10,
  maxSymbolExposureNotional: 2_000_000,
  maxPortfolioExposureNotional: 2_000_000,
  maxDailyBuyNotional: 2_000_000,
  maxDailySellNotional: 2_000_000,
  maxDailyLoss: 1_000_000,
  maxConsecutiveLosses: 3,
  consecutiveLossLimitEnabled: false,
  maxSessionDrawdownRatio: 0.2,
  maxPriceDeviationRatio: 0.05
});

export interface CloudPaperRiskRequest {
  readonly path: "MANUAL" | "STRATEGY";
  readonly commandId: string;
  readonly signalId: string;
  readonly clientOrderId: string;
  readonly strategyId: string;
  readonly market: string;
  readonly side: "BUY" | "SELL";
  readonly quantity: number;
  readonly price: number;
  readonly now: number;
  readonly observedAt: number;
  readonly maximumMarketAgeMs: number;
  readonly killSwitchActive: boolean;
  readonly openP0: boolean;
  readonly overallHealth: "HEALTHY" | "DEGRADED" | "CRITICAL" | "UNKNOWN";
  readonly state: PaperAccountState;
  readonly approvedBy?: string;
  /** Exact immutable request identity supplied by the upstream canonical execution boundary. */
  readonly payloadFingerprintSha256?: string;
}

export interface CloudPaperRiskGate {
  evaluate(input: CloudPaperRiskRequest): Readonly<{ status: "ALLOW" | "REJECT" | "HALT"; reasonCodes: readonly string[] }>;
}

/**
 * Display-only counts and explicit enforcement policy, as of the latest risk evaluation: today's (KST) completed sell
 * orders, how many of them lost, the current losing streak and the configured limit. Integers only (no money, market or id).
 */
export interface CloudPaperLossSessionSnapshot {
  readonly consecutiveLossLimitEnabled?: boolean;
  readonly evaluatedAt: number;
  readonly consecutiveLossCount: number;
  readonly maxConsecutiveLosses: number;
  readonly todayCompletedSells: number;
  readonly todayLosingSells: number;
  /** Trading-day key (Asia/Seoul) the counts belong to, the start of that day, and the fill time of the loss that last extended the streak (null at 0). */
  readonly periodIdentity: string;
  readonly periodStartedAt: number;
  readonly lastIncrementAt: number | null;
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
// One canonical trading day (Asia/Seoul) for every daily limit here, the same one CanonicalRiskSafetyGate and the closed-learning
// rollover already use (paperTradingDay delegates to tradingDayKey). A local UTC day would let two different "today"s disagree
// inside a single risk evaluation.
const dayOf = (timestamp: number): string => paperTradingDayKey(timestamp);
const dayStartedAt = (dayKey: string): number => paperTradingDayStartedAt(dayKey);

function validateLimits(limits: IndependentRiskLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (name === "consecutiveLossLimitEnabled") {
      if (typeof value !== "boolean") throw new Error("cloud PAPER loss enforcement policy is invalid");
      continue;
    }
    if (!Number.isFinite(value) || value < 0) throw new Error(`cloud PAPER risk limit ${name} is invalid`);
  }
  if (limits.maxOrdersPerSecond < 1 || limits.maxOrdersPerMinute < 1 || limits.maxSameSideStreak < 1 || limits.maxConsecutiveLosses < 1) {
    throw new Error("cloud PAPER rate/loss limits must be positive");
  }
  if (limits.maxSessionDrawdownRatio > 1 || limits.maxPriceDeviationRatio > 1) throw new Error("cloud PAPER ratio limit is invalid");
}

function databaseHealthy(database: SqliteDatabase): boolean {
  try {
    // SqliteDatabase already performs the fail-closed full-file quick_check once when the
    // canonical connection is opened. Repeating that O(database-size) scan on every PAPER
    // risk evaluation can block the Node event loop longer than the renewable writer lease.
    // Keep the hot-path probe O(1): prove the already-open connection responds, then prove
    // every canonical Risk table is still addressable. Individual persistence operations
    // continue to fail closed on any SQLite error.
    const probe = database.connection.prepare("SELECT 1 AS ready").get() as Record<string, unknown> | undefined;
    if (Number(probe?.ready ?? 0) !== 1) return false;
    const required = ["risk_paper_approvals", "risk_daily_loss_state", "risk_idempotency_records", "risk_order_state"];
    for (const table of required) {
      const row = database.connection.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(table) as Record<string, unknown> | undefined;
      if (row == null) return false;
    }
    return true;
  } catch { return false; }
}

function stateHealthy(state: PaperAccountState): boolean {
  try {
    if (state.version !== 1 || !Number.isFinite(state.cash) || state.cash < 0 || !Number.isFinite(state.equity) || state.equity < 0) return false;
    const projected = state.cash + state.positions.reduce((sum, position) => sum + position.quantity * position.markPrice, 0);
    const tolerance = Math.max(1e-6, Math.abs(projected) * 1e-8);
    if (!Number.isFinite(projected) || Math.abs(projected - state.equity) > tolerance) return false;
    if (new Set(state.processedIdempotencyKeys).size !== state.processedIdempotencyKeys.length) return false;
    if (new Set(state.orders.map((order) => order.id)).size !== state.orders.length) return false;
    if (new Set(state.fills.map((fill) => fill.id)).size !== state.fills.length) return false;
    if (!state.fills.every((fill) => Number.isFinite(fill.quantity) && fill.quantity > 0 && Number.isFinite(fill.price) && fill.price > 0 && Number.isFinite(fill.fee) && fill.fee >= 0 && Number.isSafeInteger(fill.filledAt) && fill.filledAt >= 0)) return false;
    // An executed terminal order must retain its fills; absent/truncated accounting is not safe.
    const quantities = new Map<string, number>();
    for (const fill of state.fills) quantities.set(fill.orderId, (quantities.get(fill.orderId) ?? 0) + fill.quantity);
    if (!state.orders.every((order) => {
      const quantity = quantities.get(order.id) ?? 0;
      return Number.isFinite(order.quantity) && Math.abs(quantity - order.quantity) <= 1e-8;
    })) return false;
    return state.positions.every((position) => Number.isFinite(position.quantity) && position.quantity >= 0 && Number.isFinite(position.markPrice) && position.markPrice >= 0);
  } catch { return false; }
}

function rateState(state: PaperAccountState, now: number, side: "BUY" | "SELL"): Readonly<{ ordersInLastSecond: number; ordersInLastMinute: number; sameSideStreak: number }> {
  let ordersInLastSecond = 0;
  let ordersInLastMinute = 0;
  const second = new Set<string>();
  const minute = new Set<string>();
  const seen = new Set<string>();
  // Cancellation removes only the unfilled remainder, never an observed execution.
  const fills = [...state.fills].sort((a, b) => b.filledAt - a.filledAt);
  for (const fill of fills) {
    const age = now - fill.filledAt;
    if (age < 1_000) second.add(fill.orderId);
    if (age < 60_000) minute.add(fill.orderId);
  }
  ordersInLastSecond = second.size;
  ordersInLastMinute = minute.size;
  let sameSideStreak = 0;
  for (const fill of fills) {
    if (seen.has(fill.orderId)) continue;
    seen.add(fill.orderId);
    if (fill.side !== side) break;
    sameSideStreak += 1;
  }
  return Object.freeze({ ordersInLastSecond, ordersInLastMinute, sameSideStreak });
}

function dailyNotional(state: PaperAccountState, now: number): Readonly<{ dailyBuyNotional: number; dailySellNotional: number }> {
  const day = dayOf(now);
  let dailyBuyNotional = 0;
  let dailySellNotional = 0;
  for (const fill of state.fills) {
    if (dayOf(fill.filledAt) !== day) continue;
    const notional = fill.quantity * fill.price;
    if (fill.side === "BUY") dailyBuyNotional += notional;
    else dailySellNotional += notional;
  }
  return Object.freeze({ dailyBuyNotional, dailySellNotional });
}

function realizedLossState(state: PaperAccountState, now: number): Readonly<{ dailyRealizedPnL: number; consecutiveLossCount: number; todayCompletedSells: number; todayLosingSells: number; lastIncrementAt: number | null }> {
  const positions = new Map<string, { quantity: number; averageEntryPrice: number }>();
  const sells: Array<{ pnl: number; filledAt: number }> = [];
  const sellOrders = new Map<string, { pnl: number; filledAt: number }>();
  for (const order of [...state.fills].reverse().sort((a, b) => a.filledAt - b.filledAt)) {
    const prior = positions.get(order.market) ?? { quantity: 0, averageEntryPrice: 0 };
    if (order.side === "BUY") {
      const nextQuantity = prior.quantity + order.quantity;
      const nextAverage = nextQuantity <= 0 ? 0 : (prior.averageEntryPrice * prior.quantity + order.quantity * order.price + order.fee) / nextQuantity;
      positions.set(order.market, { quantity: nextQuantity, averageEntryPrice: nextAverage });
      continue;
    }
    if (order.quantity > prior.quantity + Number.EPSILON) return Object.freeze({ dailyRealizedPnL: Number.NaN, consecutiveLossCount: Number.MAX_SAFE_INTEGER, todayCompletedSells: 0, todayLosingSells: 0, lastIncrementAt: null });
    const pnl = (order.price - prior.averageEntryPrice) * order.quantity - order.fee;
    const nextQuantity = Math.max(0, prior.quantity - order.quantity);
    positions.set(order.market, { quantity: nextQuantity, averageEntryPrice: nextQuantity === 0 ? 0 : prior.averageEntryPrice });
    sells.push({ pnl, filledAt: order.filledAt });
    const previous = sellOrders.get(order.orderId);
    sellOrders.set(order.orderId, { pnl: (previous?.pnl ?? 0) + pnl, filledAt: order.filledAt });
  }
  const today = dayOf(now);
  const dailyRealizedPnL = sells.filter((sell) => dayOf(sell.filledAt) === today).reduce((sum, sell) => sum + sell.pnl, 0);
  // The streak is scoped to the current trading day (Asia/Seoul), like the daily loss limit. Counting the
  // whole history made the limit permanent: once tripped, no order could run to produce the
  // winning sell that would clear it. The owner chose a daily reset on 2026-10-01.
  let consecutiveLossCount = 0;
  const completed = [...sellOrders.values()].filter((sell) => dayOf(sell.filledAt) === today).sort((a, b) => a.filledAt - b.filledAt);
  for (let index = completed.length - 1; index >= 0; index -= 1) {
    if (completed[index]!.pnl >= 0) break;
    consecutiveLossCount += 1;
  }
  const lastIncrementAt = consecutiveLossCount === 0 ? null : completed[completed.length - 1]!.filledAt;
  return Object.freeze({ dailyRealizedPnL, consecutiveLossCount, todayCompletedSells: completed.length, todayLosingSells: completed.filter((sell) => sell.pnl < 0).length, lastIncrementAt });
}

export interface CloudPaperCanonicalRiskGatewayOptions {
  readonly database: SqliteDatabase;
  readonly initialCapital: number;
  readonly sourceCommitSha: string;
  readonly limits?: IndependentRiskLimits;
  /** The real PAPER account id the risk rows belong to; defaults to the id derived from the initial capital. */
  readonly accountId?: string;
}

/**
 * Cloud adapter over the existing independent gateway + CanonicalRiskSafetyGate.
 * It owns no broker mutation. A separate production execution boundary may mutate PAPER
 * state only after this returns ALLOW.
 */
export class CloudPaperCanonicalRiskGateway implements CloudPaperRiskGate {
  private readonly persistence: SqliteRiskSafetyPersistence;
  private readonly canonical: CanonicalRiskSafetyGate;
  private readonly limits: IndependentRiskLimits;
  private readonly fingerprints: Readonly<{ strategy: string; config: string; runtime: string; riskPolicy: string }>;
  private readonly accountId: string;
  private readonly peakStore: SessionPeakStore;
  private peakEquity: number;
  private persistedPeak = Number.NaN;
  private peakVerified = false;
  private lastLossSession: CloudPaperLossSessionSnapshot | null = null;

  public constructor(private readonly options: CloudPaperCanonicalRiskGatewayOptions) {
    if (!Number.isFinite(options.initialCapital) || options.initialCapital <= 0) throw new Error("cloud PAPER initial capital is invalid");
    if (!options.sourceCommitSha.trim()) throw new Error("cloud PAPER source commit is required");
    this.limits = Object.freeze({ ...(options.limits ?? CLOUD_PAPER_RISK_LIMITS) });
    validateLimits(this.limits);
    this.accountId = resolveRiskAccountId(options.initialCapital, options.accountId);
    this.persistence = new SqliteRiskSafetyPersistence(options.database);
    this.canonical = new CanonicalRiskSafetyGate(new AccountScopedRiskPersistence(this.persistence, this.accountId));
    this.peakStore = new SessionPeakStore(this.persistence, this.accountId, options.initialCapital);
    this.peakEquity = options.initialCapital;
    this.restorePeak();
    this.fingerprints = Object.freeze({
      strategy: hash("cloud-paper-cio-v1"),
      config: hash({ initialCapital: options.initialCapital }),
      runtime: hash(options.sourceCommitSha.trim()),
      riskPolicy: hash(this.limits)
    });
  }

  /** Restores the persisted drawdown peak. Unreadable or invalid means unknown: evaluations halt until a valid peak is read. */
  private restorePeak(): void {
    try {
      const stored = this.peakStore.read();
      if (stored.status === "INVALID") { this.peakVerified = false; return; }
      if (stored.status === "OK") { this.peakEquity = Math.max(this.peakEquity, stored.peak); this.persistedPeak = stored.peak; }
      this.peakVerified = true;
    } catch { this.peakVerified = false; }
  }

  /** The loss-limit counts from the latest evaluation, or null before any. Display only; never used for a decision. */
  public lossSession(): CloudPaperLossSessionSnapshot | null {
    return this.lastLossSession;
  }

  public evaluate(input: CloudPaperRiskRequest): Readonly<{ status: "ALLOW" | "REJECT" | "HALT"; reasonCodes: readonly string[] }> {
    const persistent = databaseHealthy(this.options.database);
    const reconciled = stateHealthy(input.state);
    if (!reconciled) return Object.freeze({ status: "HALT", reasonCodes: Object.freeze(["RECONCILIATION_FAILED"]) });
    if (!this.peakVerified) this.restorePeak();
    if (!this.peakVerified) return Object.freeze({ status: "HALT", reasonCodes: Object.freeze(["PERSISTENCE_UNHEALTHY"]) });
    const payloadFingerprint = input.payloadFingerprintSha256 ?? hash({
      path: input.path,
      commandId: input.commandId,
      signalId: input.signalId,
      clientOrderId: input.clientOrderId,
      strategyId: input.strategyId,
      market: input.market,
      side: input.side,
      quantity: input.quantity,
      price: input.price,
      observedAt: input.observedAt,
    });
    if (!/^[a-f0-9]{64}$/.test(payloadFingerprint)) {
      return Object.freeze({ status: "HALT", reasonCodes: Object.freeze(["IDEMPOTENCY_FINGERPRINT_INVALID"]) });
    }
    const marketAge = input.now - input.observedAt;
    const marketStatus = !Number.isSafeInteger(input.observedAt) || input.observedAt < 0 || input.observedAt > input.now
      ? "INVALID" as const
      : marketAge >= input.maximumMarketAgeMs ? "STALE" as const : "HEALTHY" as const;
    const position = input.state.positions.find((item) => item.market === input.market);
    const symbolExposureNotional = (position?.quantity ?? 0) * input.price;
    const portfolioExposureNotional = input.state.positions.reduce((sum, item) => sum + item.quantity * item.markPrice, 0);
    const notionals = dailyNotional(input.state, input.now);
    const lossState = realizedLossState(input.state, input.now);
    if (Number.isFinite(lossState.dailyRealizedPnL)) {
      this.lastLossSession = Object.freeze({ evaluatedAt: input.now, consecutiveLossCount: lossState.consecutiveLossCount, maxConsecutiveLosses: this.limits.maxConsecutiveLosses, consecutiveLossLimitEnabled: this.limits.consecutiveLossLimitEnabled !== false, todayCompletedSells: lossState.todayCompletedSells, todayLosingSells: lossState.todayLosingSells, periodIdentity: dayOf(input.now), periodStartedAt: dayStartedAt(dayOf(input.now)), lastIncrementAt: lossState.lastIncrementAt });
    }
    const currentEquity = input.state.cash + input.state.positions.reduce((sum, item) => sum + item.quantity * (item.market === input.market ? input.price : item.markPrice), 0);
    this.peakEquity = Math.max(this.peakEquity, currentEquity);
    if (!(this.peakEquity <= this.persistedPeak)) {
      try { this.peakStore.write(this.peakEquity, input.now); this.persistedPeak = this.peakEquity; }
      catch { return Object.freeze({ status: "HALT", reasonCodes: Object.freeze(["PERSISTENCE_UNHEALTHY"]) }); }
    }
    const identity: RiskIdentityState = Object.freeze({
      strategyFingerprint: this.fingerprints.strategy,
      configFingerprint: this.fingerprints.config,
      runtimeFingerprint: this.fingerprints.runtime,
      riskPolicyFingerprint: this.fingerprints.riskPolicy,
      seenSignalIds: new Set(input.state.processedIdempotencyKeys),
      seenCommandIds: new Set(input.state.processedIdempotencyKeys),
      seenClientOrderIds: new Set(input.state.processedIdempotencyKeys)
    });
    const independentRequest: PreTradeRiskRequest = {
      schemaVersion: 1,
      requestId: `${this.options.sourceCommitSha}:${input.path}:${input.commandId}`,
      signalId: input.signalId,
      commandId: input.commandId,
      clientOrderId: input.clientOrderId,
      strategyFingerprint: this.fingerprints.strategy,
      configFingerprint: this.fingerprints.config,
      runtimeFingerprint: this.fingerprints.runtime,
      riskPolicyFingerprint: this.fingerprints.riskPolicy,
      symbol: input.market,
      side: input.side,
      quantity: input.quantity,
      referencePrice: input.price,
      requestedAt: input.now,
      marketDataState: { status: marketStatus, price: marketStatus === "HEALTHY" ? input.price : null },
      accountState: { cash: input.state.cash, positionQuantity: position?.quantity ?? 0, openOrderCount: 0 },
      controlState: { killSwitchActive: input.killSwitchActive, liveCapabilityDetected: RUNTIME_EXCHANGE_CAPABILITIES.liveTrading, privateApiCapabilityDetected: RUNTIME_EXCHANGE_CAPABILITIES.authenticatedMutation },
      approvalState: { approved: true, expiresAt: input.now + 1, symbols: [input.market] },
      persistenceState: { healthy: persistent },
      reconciliationState: { healthy: reconciled, openP0: input.openP0 },
      deploymentState: { integrityVerified: persistent },
      rateState: rateState(input.state, input.now, input.side),
      exposureState: { symbolExposureNotional, portfolioExposureNotional, dailyBuyNotional: notionals.dailyBuyNotional, dailySellNotional: notionals.dailySellNotional },
      sessionState: { dailyRealizedPnL: lossState.dailyRealizedPnL, consecutiveLossCount: lossState.consecutiveLossCount, sessionPeakEquity: this.peakEquity, sessionEquity: currentEquity }
    };
    const independent = evaluatePreTradeRisk(independentRequest, identity, this.limits);
    if (independent.status !== "ALLOW") return Object.freeze({ status: independent.status === "REJECT" ? "REJECT" : "HALT", reasonCodes: independent.reasonCodes });

    const strategyId = input.path === "MANUAL" ? "MANUAL" : input.strategyId.trim();
    const approvedBy = input.path === "MANUAL" ? input.approvedBy?.trim() : "CIO_PAPER";
    if (!approvedBy || !strategyId) return Object.freeze({ status: "HALT", reasonCodes: Object.freeze(["APPROVAL_MISSING"]) });
    let approvalId: string | undefined;
    {
      approvalId = `cloud-paper-${hash({ account: this.accountId, commandId: input.commandId, approvedBy, strategyId, market: input.market, side: input.side, policy: this.fingerprints.riskPolicy }).slice(0, 32)}`;
      try {
        this.canonical.saveApproval({
          approvalId,
          mode: "PAPER",
          symbol: input.market,
          strategyId,
          policyFingerprint: this.fingerprints.riskPolicy,
          side: input.side,
          commandId: input.commandId,
          expiresAtMs: input.now + MANUAL_APPROVAL_TTL_MS,
          approvedBy,
          approvedAtMs: input.now
        });
      } catch { return Object.freeze({ status: "HALT", reasonCodes: Object.freeze(["PERSISTENCE_UNHEALTHY"]) }); }
    }

    const canonical = this.canonical.evaluate({
      accountId: this.accountId,
      requestId: `${input.path}:${input.commandId}`,
      boundary: input.path,
      mode: "PAPER",
      symbol: input.market,
      side: input.side,
      strategyId,
      policyFingerprint: this.fingerprints.riskPolicy,
      ...(approvalId === undefined ? {} : { approvalId }),
      nowMs: input.now,
      currentEquity,
      marketDataFresh: marketStatus === "HEALTHY",
      marketHealthy: marketStatus === "HEALTHY" && input.overallHealth === "HEALTHY",
      killSwitchActive: input.killSwitchActive,
      liveMutationAllowed: false,
      recoveryReady: persistent && reconciled && !input.openP0,
      persistenceHealthy: persistent,
      maxDailyLoss: this.limits.maxDailyLoss,
      maxOpenOrders: this.limits.maxOpenOrders,
      idempotency: { accountId: this.accountId, commandId: input.commandId, signalId: input.signalId, clientOrderId: input.clientOrderId, payloadFingerprint, createdAtMs: input.now }
    });
    if (approvalId !== undefined) {
      try { this.canonical.revokeApproval(approvalId, "single-use manual approval evaluated"); } catch { return Object.freeze({ status: "HALT", reasonCodes: Object.freeze(["PERSISTENCE_UNHEALTHY"]) }); }
    }
    return Object.freeze({
      status: canonical.status === "APPROVED" ? "ALLOW" : canonical.status === "REJECTED" ? "REJECT" : "HALT",
      reasonCodes: Object.freeze([...independent.reasonCodes, ...canonical.reasonCodes])
    });
  }
}
