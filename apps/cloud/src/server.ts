import { learningPipelineProjection, type LearningPipelineProjection } from "./learningPipelineStage";
import { learningLoopVerdict, type LearningLoopVerdict } from "./learningLoopVerdict";
import { LearningPipelineAlarmTracker, type LearningPipelineAlarmSnapshot } from "./learningPipelineAlarm";
import { createHash, randomUUID } from "node:crypto";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  authorizeDashboardReadRequest,
  dashboardJsonResponse,
  handleMobileDashboardHttp,
  type DashboardHttpRequest,
  type DashboardHttpResponse,
  type DashboardPrincipal,
  type DashboardTokenVerifier,
  type MobileDashboardHttpDependencies
} from "./mobileDashboardHttp";
import {
  handlePersonalPaperOperationsHttp,
  type PersonalPaperOperationsHttpDependencies
} from "./personalPaperOperationsHttp";
import { handleShadowOperationsHttp, type ShadowOperationsHttpDependencies } from "./shadowOperationsHttp";
import { handleRealReadOnlyOperationsHttp, type RealReadOnlyOperationsHttpDependencies } from "./realReadOnlyOperationsHttp";
import { handlePersonalPaperOrderHttp, type PersonalPaperOrderHttpDependencies } from "./personalPaperOrderHttp";
import { operationalLog } from "./structuredOperationalLog";
import { handleInvestmentAllocationHttp } from "./investmentAllocationHttp";
import type { InvestmentAllocationSettingsRepository } from "./cloudInvestmentAllocationSettings";
import { handleOperatorUserAccessHttp } from "./operatorUserAccessHttp";
import { isUserAllowed, SqliteNusaUserAccessRepository, type NusaUserAccessRepository } from "./operatorUserAccess";
import { SqliteDatabase } from "../../../packages/storage/src/index";
import { BoundedHttpRateLimiter, rateLimitIdentity } from "./httpRateLimiter";
import { DesktopSessionService } from "./desktopSessionService";
import {
  handleDesktopBootstrapHttp,
  handleDesktopBootstrapIssueHttp,
  handleDesktopMeHttp,
  handleDesktopSessionRefreshHttp,
  handleDesktopSessionRevokeHttp
} from "./desktopSessionHttp";
import { MobileSessionService } from "./mobileSessionService";
import { OwnerDeviceCredentialService } from "./ownerCredential/ownerDeviceCredentialService";
import {
  handleOwnerDeviceCredentialAuthenticationChallengeHttp,
  handleOwnerDeviceCredentialAuthenticationCompleteHttp,
  handleOwnerDeviceCredentialRegistrationActivateHttp,
  handleOwnerDeviceCredentialRegistrationChallengeHttp,
  handleOwnerDeviceCredentialRevokeHttp,
  handleOwnerPasswordChangeHttp,
  handleOwnerPasswordSignInHttp,
  handleMobileBootstrapHttp,
  handleMobileBootstrapIssueHttp,
  handleMobileEnrollmentHttp,
  handleMobileMeHttp,
  handleMobilePairingApproveHttp,
  handleMobilePairingExchangeHttp,
  handleMobilePairingStartHttp,
  handleMobilePairingStatusHttp,
  handleMobileSessionRefreshHttp,
  handleMobileSessionRevokeHttp
} from "./mobileSessionHttp";
import { handlePublicUpbitQuotationHttp, isPublicUpbitQuotationPath } from "./publicUpbitQuotationHttp";
import { anonymousObservationEnabled, createAnonymousObservationScope, hasAuthorizationHeader, isAnonymousObservationRoute, type AnonymousObservationScope } from "./observation/anonymousObservationScope";
import { handleLiveReadinessHttp, type LiveReadinessHttpDependencies } from "./liveReadinessHttp";
import { handleEngineeringOperationsHttp, type EngineeringOperationsHttpDependencies } from "./engineeringOperationsHttp";
import { handleEvolutionLearningSupervisorHttp, type EvolutionLearningSupervisorHttpDependencies } from "./evolutionLearningSupervisorHttp";
import { handleUxTelemetryEventHttp } from "./uxTelemetryHttp";
import type { UxTelemetryStorage } from "./uxTelemetryJournal";
import { COMPONENT_HEALTH_STATES, type ComponentHealthResult } from "./componentHealth";

/**
 * Evidence that the continuous PAPER runtime is alive, not merely that the process answers HTTP.
 *
 * The PAPER execution loop is driven by a persistent Upbit public ticker subscription, so it either
 * runs continuously or it does not run at all. Nothing exposed that distinction: `/health` said
 * `{ok:true}` whenever the HTTP listener was up, and `/ready` reports database and migration
 * readiness. A stalled market feed, a loop that had stopped deciding, or a runtime that had been
 * serving for hours without a single tick all looked identical from outside.
 *
 * Only timestamps, counters and a coded error are carried. No price, balance, position, order
 * detail or credential appears here, because `/health` is unauthenticated by design.
 */
export interface CloudRuntimeLivenessSnapshot {
  readonly startedAt: number;
  readonly lastHeartbeatAt: number;
  readonly lastMarketEventAt: number | null;
  readonly lastPaperDecisionAt: number | null;
  readonly lastPaperOrderAt: number | null;
  readonly lastPaperFillAt: number | null;
  readonly eventCount: number;
  readonly decisionCount: number;
  readonly paperOrderCount: number;
  readonly paperFillCount: number;
  /** Coded `STATUS:REASON` of the latest PAPER boundary decision, e.g. `BLOCKED:PAPER_INVESTMENT_ALLOCATION_EXCEEDED`. */
  readonly lastPaperDecisionOutcome?: string | null;
  readonly lastError: string | null;
  /** Why the previous runtime process stopped, when a failure record exists. */
  readonly previousStop?: string;
  /** Display-only event-loop stall measurement (milliseconds, a count and a timestamp), present when the runtime measures it. */
  readonly eventLoopMaxStallMs?: number;
  readonly eventLoopStallCount?: number;
  readonly lastEventLoopStallAt?: number | null;
  /** Display-only research candle collection status (a code and two counts), present when the runtime reports it. */
  readonly researchCollectionStatus?: "COLLECTING" | "DISABLED" | "INVALID" | "UNAVAILABLE";
  readonly researchCandleCount?: number;
  readonly researchRequiredCandles?: number;
  /** Cumulative PAPER decision-funnel counts since the runtime started: fixed codes and integer counts only. */
  readonly paperFunnel?: { readonly since: number; readonly counts: Readonly<Record<string, number>> };
  /** Counts behind the consecutive-loss limit as of the latest risk evaluation: integers and one timestamp only. */
  /** Today's completed and losing sells per strategy family code (fixed codes, integers only). */
  readonly paperLossAttribution?: { readonly evaluatedAt: number; readonly byFamily: Readonly<Record<string, { readonly completedSells: number; readonly losingSells: number }>> };
  /** Research experiment outcome counts since start (fixed codes, integers) and the latest tick status. */
  /** Research-only microstructure recorder counters (see marketMicrostructureRecorder.ts). */
  readonly dataIntegrity?: Readonly<Record<string, string | number>>;
  readonly orderBookCollector?: { readonly rounds: number; readonly markets: number; readonly samplesStored: number; readonly failures: number; readonly rejected?: number; readonly lastRoundAt?: number };
  readonly futuresCollector?: { readonly rounds: number; readonly marksStored: number; readonly fundingStored: number; readonly klinesStored: number; readonly failures: number; readonly rejected: number; readonly lastRoundAt?: number };
  readonly microstructureRecorder?: { readonly orderBookSamples: number; readonly tradeTicks: number; readonly writeFailures: number; readonly rejectedRows?: number; readonly lastRecordedAt?: number };
  readonly researchExperimentTicks?: { readonly lastTickAt: number; readonly lastStatus: string; readonly ticks: number; readonly sessionsStarted: number; readonly counts: Readonly<Record<string, number>> };
  /** Display-only outcome of the hourly REST gap fill (the candle series head writer): fixed codes and integers. */
  readonly researchGapFill?: { readonly lastRunAt?: number; readonly runs: number; readonly deferred: number; readonly counts: Readonly<Record<string, number>>; readonly lastErrorCode?: string };
  /** The same research experiment summaries keyed by bar length ("1m", "15m", "60m", "240m"). */
  readonly researchExperimentTicksByInterval?: Readonly<Record<string, { readonly lastTickAt: number; readonly lastStatus: string; readonly ticks: number; readonly sessionsStarted: number; readonly counts: Readonly<Record<string, number>> }>>;
  /** Canonical PAPER ledger identity: a 64-hex fingerprint of ledger truth and integer counts/times only. */
  readonly paperLedger?: { readonly ledgerFingerprintSha256: string; readonly fillCount: number; readonly openPositionCount: number; readonly lastFillAt?: number; readonly ledgerUpdatedAt: number };
  /** Production closed-learning loop status: fixed codes and integers only. */
  readonly closedLearningLoop?: Readonly<Record<string, string | number | undefined | Readonly<Record<string, string | number | undefined>>>>;
  /** Full lowercase 40-hex build commit of the running process; omitted when absent or malformed. */
  readonly sourceCommitSha?: string;
  readonly paperLossSession?: { readonly evaluatedAt: number; readonly consecutiveLossCount: number; readonly maxConsecutiveLosses: number; readonly consecutiveLossLimitEnabled?: boolean; readonly todayCompletedSells: number; readonly todayLosingSells: number; readonly periodIdentity?: string; readonly periodStartedAt?: number; readonly lastIncrementAt?: number | null };
}

export interface CloudReadinessSnapshot {
  readonly ok: boolean;
  readonly checks: Readonly<{
    database: boolean;
    migrations: boolean;
    dashboardPersistence: boolean;
    runtimeRecovery: boolean;
  }>;
}

export interface CloudDashboardServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly tokenVerifier: DashboardTokenVerifier;
  readonly loadDashboard: MobileDashboardHttpDependencies["loadDashboard"];
  readonly loadPaperOperations?: PersonalPaperOperationsHttpDependencies["loadSnapshot"];
  readonly loadShadowOperations?: ShadowOperationsHttpDependencies["loadSnapshot"];
  readonly loadRealReadOnlyOperations?: RealReadOnlyOperationsHttpDependencies["loadSnapshot"];
  readonly loadLiveReadiness?: LiveReadinessHttpDependencies["loadSnapshot"];
  readonly loadEngineeringOperations?: EngineeringOperationsHttpDependencies["loadSnapshot"];
  readonly loadEvolutionLearning?: EvolutionLearningSupervisorHttpDependencies["loadSnapshot"];
  readonly submitPaperOrder?: PersonalPaperOrderHttpDependencies["submitOrder"];
  readonly investmentAllocationSettings?: InvestmentAllocationSettingsRepository;
  readonly uxTelemetryStorage?: UxTelemetryStorage;
  readonly userAccessRepository?: NusaUserAccessRepository;
  readonly desktopSessionService?: DesktopSessionService;
  readonly mobileSessionService?: MobileSessionService;
  readonly ownerDeviceCredentialService?: OwnerDeviceCredentialService;
  readonly readiness?: () => CloudReadinessSnapshot;
  /** Continuous PAPER runtime liveness, surfaced on /health so 24-hour operation is observable. */
  readonly runtimeLiveness?: () => CloudRuntimeLivenessSnapshot;
  /** Deterministic process/workload health; HTTP 200 alone never implies workload health. */
  readonly runtimeHealth?: () => Readonly<{ process: ComponentHealthResult; workload: ComponentHealthResult }>;
  /** Legacy shared limiter override. New callers should inject lanes explicitly. */
  readonly rateLimiter?: BoundedHttpRateLimiter;
  /** Bounds unauthenticated traffic without consuming authenticated-user capacity. */
  readonly anonymousRateLimiter?: BoundedHttpRateLimiter;
  /** Reserved limiter lane for a successfully verified approved-user session. */
  readonly authenticatedRateLimiter?: BoundedHttpRateLimiter;
  /** Reserved bounded lane for exact mobile refresh requests, which authenticate in the body after metering. */
  readonly mobileSessionRefreshRateLimiter?: BoundedHttpRateLimiter;
}

export interface CloudDashboardServerHandle {
  readonly port: number;
  readonly host: string;
  /** Display only: re-evaluates the learning-pipeline alarm from the current liveness (the runtime calls it once a minute). */
  observeLearningPipeline(): LearningPipelineAlarmSnapshot | undefined;
  stop(): Promise<void>;
}

const write = (res: ServerResponse, result: Readonly<{ status: number; headers: Readonly<Record<string, string>>; body: string }>): void => {
  res.writeHead(result.status, result.headers as Record<string, string>);
  res.end(result.body);
};
const unavailable = (): CloudReadinessSnapshot => Object.freeze({ ok: false, checks: Object.freeze({ database: false, migrations: false, dashboardPersistence: false, runtimeRecovery: false }) });
const MAX_REQUEST_BODY_BYTES = 10_000;

class RequestBodyTooLargeError extends Error {
  public constructor() {
    super("request body too large");
    this.name = "RequestBodyTooLargeError";
  }
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  const declaredLength = req.headers["content-length"];
  if (typeof declaredLength === "string") {
    const length = Number(declaredLength);
    if (Number.isSafeInteger(length) && length > MAX_REQUEST_BODY_BYTES) {
      req.resume();
      return Promise.reject(new RequestBodyTooLargeError());
    }
  }

  return new Promise<string>((resolve, reject) => {
    let value = "";
    let byteLength = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      req.resume();
      reject(error);
    };
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      if (settled) return;
      byteLength += Buffer.byteLength(chunk, "utf8");
      if (byteLength > MAX_REQUEST_BODY_BYTES) {
        fail(new RequestBodyTooLargeError());
        return;
      }
      value += chunk;
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(value);
    });
    req.on("error", (error) => fail(error));
  });
}

// A client-supplied correlation id is echoed into operational logs and keys the rate
// limiter's idempotency memo, so it is accepted only in a bounded, printable form.
const MAX_CORRELATION_ID_LENGTH = 128;
const SAFE_CORRELATION_ID = /^[\w.:-]{1,128}$/;

const correlationId = (req: IncomingMessage): string => {
  const raw = req.headers["x-correlation-id"] ?? req.headers["x-request-id"];
  const value = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  const candidate = value?.trim();
  if (candidate && candidate.length <= MAX_CORRELATION_ID_LENGTH && SAFE_CORRELATION_ID.test(candidate)) return candidate;
  return randomUUID();
};

/** Only a syntactically valid bearer value is considered for the pre-limit identity check. */
const bearerToken = (req: IncomingMessage): string | undefined => {
  const authorization = req.headers.authorization ?? req.headers.Authorization;
  if (typeof authorization !== "string") return undefined;
  return /^Bearer\s+([^\s]+)$/i.exec(authorization.trim())?.[1];
};

const actorRef = (userId: string | undefined): string | undefined => userId == null
  ? undefined
  : createHash("sha256").update(userId, "utf8").digest("hex").slice(0, 16);

const auditHttpResponse = (
  requestId: string,
  request: DashboardHttpRequest,
  route: string,
  response: Readonly<{ status: number }>,
  principal: DashboardPrincipal | undefined
): void => {
  const severity = response.status >= 500 ? "ERROR" : response.status >= 400 ? "WARN" : "INFO";
  operationalLog(severity, `cloud.http.${route}`, requestId, {
    actorRef: actorRef(principal?.userId) ?? "ANONYMOUS",
    method: request.method.toUpperCase(),
    responseStatus: response.status,
    evidence: "HTTP_RESPONSE",
    ...(route === "paper_order" ? { authority: "PAPER_ONLY" } : {})
  });
};

const PUBLIC_LIVENESS_TIMESTAMPS = ["startedAt", "lastHeartbeatAt", "lastMarketEventAt", "lastPaperDecisionAt", "lastPaperOrderAt", "lastPaperFillAt"] as const;
const PUBLIC_LIVENESS_COUNTERS = ["eventCount", "decisionCount", "paperOrderCount", "paperFillCount"] as const;
const PUBLIC_LIVENESS_ERROR_CODE = /^[A-Z0-9_.:-]{1,160}$/;
const PUBLIC_DECISION_OUTCOME_CODE = /^[A-Z]{3,12}:[A-Z0-9_.:+-]{1,100}$/;
// The runtime's own failure phrases ("paper account persistence failed: <detail>"). Only the phrase before the first colon can
// become public, and only when it is plain lowercase words starting with "paper": no digits, so no values, ids or keys, and the
// detail after the colon never leaves the authenticated route.
const PUBLIC_PAPER_FAILURE_PHRASE = /^paper [a-z ]{2,70}$/;
function publicLivenessErrorClass(raw: string): string | undefined {
  const separator = raw.indexOf(":");
  const phrase = (separator < 0 ? raw : raw.slice(0, separator)).trim();
  return PUBLIC_PAPER_FAILURE_PHRASE.test(phrase) ? phrase.toUpperCase().replace(/ +/g, "_") : undefined;
}

/**
 * `/health` is unauthenticated, so the runtime object is rebuilt here from a fixed allowlist instead
 * of being passed through. A liveness source that grows an extra field -- a token, an account
 * identifier, a price -- cannot make it public, and an error that is not a bare code is replaced by
 * a fixed code rather than published as free text.
 */
/**
 * Period evidence for the loss session is published only as one coherent tuple: a date key, exactly the start of that Asia/Seoul day,
 * and the time of the last loss that extended the streak (null at 0), ordered start <= lastIncrementAt <= evaluatedAt. Anything partial or
 * contradictory is omitted whole, so public health data never reports an impossible loss period.
 */
function periodEvidence(raw: Record<string, unknown>): Record<string, unknown> {
  const { periodIdentity, periodStartedAt, lastIncrementAt, evaluatedAt } = raw;
  if (typeof periodIdentity !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(periodIdentity)) return {};
  if (!Number.isSafeInteger(periodStartedAt) || Number(periodStartedAt) !== Date.parse(`${periodIdentity}T00:00:00+09:00`)) return {};
  if (!Number.isSafeInteger(evaluatedAt) || Number(periodStartedAt) > Number(evaluatedAt)) return {};
  if (lastIncrementAt !== null) {
    if (!Number.isSafeInteger(lastIncrementAt) || Number(lastIncrementAt) < Number(periodStartedAt) || Number(lastIncrementAt) > Number(evaluatedAt)) return {};
  }
  return { periodIdentity, periodStartedAt: Number(periodStartedAt), lastIncrementAt: lastIncrementAt === null ? null : Number(lastIncrementAt) };
}

function publicRuntimeLiveness(value: CloudRuntimeLivenessSnapshot): CloudRuntimeLivenessSnapshot {
  const source = value as unknown as Record<string, unknown>;
  const timestamp = (key: string): number | null => {
    const raw = source[key];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
  };
  const counter = (key: string): number => {
    const raw = source[key];
    return Number.isSafeInteger(raw) && Number(raw) >= 0 ? Number(raw) : 0;
  };
  const rawError = source.lastError;
  const lastError = rawError === null || rawError === undefined
    ? null
    : typeof rawError === "string" && PUBLIC_LIVENESS_ERROR_CODE.test(rawError) ? rawError
      : (typeof rawError === "string" ? publicLivenessErrorClass(rawError) : undefined) ?? "LIVENESS_ERROR_UNCLASSIFIED";
  const timestamps = Object.fromEntries(PUBLIC_LIVENESS_TIMESTAMPS.map((key) => [key, timestamp(key)]));
  const counters = Object.fromEntries(PUBLIC_LIVENESS_COUNTERS.map((key) => [key, counter(key)]));
  const rawPreviousStop = source.previousStop;
  const previousStop = typeof rawPreviousStop === "string" && PUBLIC_LIVENESS_ERROR_CODE.test(rawPreviousStop) ? rawPreviousStop : undefined;
  const rawOutcome = source.lastPaperDecisionOutcome;
  const lastPaperDecisionOutcome = typeof rawOutcome === "string" && PUBLIC_DECISION_OUTCOME_CODE.test(rawOutcome) ? rawOutcome : undefined;
  // Optional stall measurement: published only as finite non-negative numbers, and only when the source supplies them.
  const optionalNumber = (key: string): number | undefined => {
    const raw = source[key];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
  };
  const maxStall = optionalNumber("eventLoopMaxStallMs");
  const stallCount = optionalNumber("eventLoopStallCount");
  const lastStallAt = source.lastEventLoopStallAt === null ? null : optionalNumber("lastEventLoopStallAt");
  const stall = {
    ...(maxStall === undefined ? {} : { eventLoopMaxStallMs: maxStall }),
    ...(stallCount === undefined ? {} : { eventLoopStallCount: Math.trunc(stallCount) }),
    ...(lastStallAt === undefined ? {} : { lastEventLoopStallAt: lastStallAt }),
  };
  // Research collection status: one of four fixed codes plus two counts, nothing else (no market, time or detail).
  // Decision funnel: keys are fixed stage/status/reason codes and values are integers, at most 80 keys; anything else is dropped.
  const FUNNEL_KEY = /^(OTHER|[A-Z][A-Z_]{1,23}:(PASS|SKIP|FAIL)(:[A-Z][A-Z0-9_]{1,47})?)$/;
  const rawFunnel = source.paperFunnel as { since?: unknown; counts?: unknown } | null | undefined;
  let funnel: { paperFunnel?: { since: number; counts: Record<string, number> } } = {};
  if (rawFunnel != null && typeof rawFunnel === "object" && typeof rawFunnel.since === "number" && Number.isFinite(rawFunnel.since) && rawFunnel.since >= 0 && rawFunnel.counts != null && typeof rawFunnel.counts === "object" && !Array.isArray(rawFunnel.counts)) {
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(rawFunnel.counts as Record<string, unknown>)) {
      if (Object.keys(counts).length >= 80) break;
      if (FUNNEL_KEY.test(key) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) counts[key] = value;
    }
    funnel = { paperFunnel: { since: rawFunnel.since, counts } };
  }
  // Loss-limit counts: exactly five non-negative integers (one of them a timestamp), or nothing; plus optional bounded period evidence.
  const rawLoss = source.paperLossSession as Record<string, unknown> | null | undefined;
  const LOSS_KEYS = ["evaluatedAt", "consecutiveLossCount", "maxConsecutiveLosses", "todayCompletedSells", "todayLosingSells"] as const;
  const lossSession = rawLoss != null && typeof rawLoss === "object" && LOSS_KEYS.every((key) => Number.isSafeInteger(rawLoss[key]) && Number(rawLoss[key]) >= 0)
    ? {
        paperLossSession: {
          ...Object.fromEntries(LOSS_KEYS.map((key) => [key, Number(rawLoss[key])])),
          ...(typeof rawLoss.consecutiveLossLimitEnabled === "boolean" ? { consecutiveLossLimitEnabled: rawLoss.consecutiveLossLimitEnabled } : {}),
          ...periodEvidence(rawLoss),
        },
      }
    : {};
  // Loss attribution: at most 8 fixed family codes, each with two non-negative integers.
  const FAMILY_CODE = /^(SMA_CROSSOVER|RSI_MEAN_REVERSION|DONCHIAN_BREAKOUT|OTHER_FAMILY|UNATTRIBUTED)$/;
  const rawAttribution = source.paperLossAttribution as { evaluatedAt?: unknown; byFamily?: unknown } | null | undefined;
  let lossAttribution: { paperLossAttribution?: { evaluatedAt: number; byFamily: Record<string, { completedSells: number; losingSells: number }> } } = {};
  if (rawAttribution != null && typeof rawAttribution === "object" && Number.isSafeInteger(rawAttribution.evaluatedAt) && Number(rawAttribution.evaluatedAt) >= 0 && rawAttribution.byFamily != null && typeof rawAttribution.byFamily === "object" && !Array.isArray(rawAttribution.byFamily)) {
    const byFamily: Record<string, { completedSells: number; losingSells: number }> = {};
    for (const [key, value] of Object.entries(rawAttribution.byFamily as Record<string, unknown>)) {
      if (Object.keys(byFamily).length >= 8) break;
      const entry = value as { completedSells?: unknown; losingSells?: unknown } | null;
      if (FAMILY_CODE.test(key) && entry != null && typeof entry === "object" && Number.isSafeInteger(entry.completedSells) && Number.isSafeInteger(entry.losingSells) && Number(entry.losingSells) >= 0 && Number(entry.completedSells) >= Number(entry.losingSells)) {
        byFamily[key] = { completedSells: Number(entry.completedSells), losingSells: Number(entry.losingSells) };
      }
    }
    lossAttribution = { paperLossAttribution: { evaluatedAt: Number(rawAttribution.evaluatedAt), byFamily } };
  }
  // Research experiment ticks: a fixed status code, three integers and at most 40 code-keyed integer counts.
  const publicTicks = (raw: Record<string, unknown> | null | undefined): { lastTickAt: number; lastStatus: string; ticks: number; sessionsStarted: number; counts: Record<string, number> } | undefined => {
    if (raw == null || typeof raw !== "object" || typeof raw.lastStatus !== "string" || !["OK", "RECOVERY_NOT_READY", "ERROR"].includes(raw.lastStatus)
      || !["lastTickAt", "ticks", "sessionsStarted"].every((key) => Number.isSafeInteger(raw[key]) && Number(raw[key]) >= 0)
      || raw.counts == null || typeof raw.counts !== "object" || Array.isArray(raw.counts)) return undefined;
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw.counts as Record<string, unknown>)) {
      if (Object.keys(counts).length >= 40) break;
      if (/^[A-Z][A-Z0-9_]{1,47}$/.test(key) && Number.isSafeInteger(value) && Number(value) >= 0) counts[key] = Number(value);
    }
    return { lastTickAt: Number(raw.lastTickAt), lastStatus: raw.lastStatus, ticks: Number(raw.ticks), sessionsStarted: Number(raw.sessionsStarted), counts };
  };
  const ticksSummary = publicTicks(source.researchExperimentTicks as Record<string, unknown> | null | undefined);
  const experimentTicks = ticksSummary === undefined ? {} : { researchExperimentTicks: ticksSummary };
  // Research gap fill: three integers, an optional timestamp, at most 12 code-keyed integer counts and one optional code.
  const rawGap = source.researchGapFill as Record<string, unknown> | null | undefined;
  let researchGapFill: { researchGapFill?: Record<string, unknown> } = {};
  if (rawGap != null && typeof rawGap === "object" && !Array.isArray(rawGap) && Number.isSafeInteger(rawGap.runs) && Number(rawGap.runs) >= 0 && Number.isSafeInteger(rawGap.deferred) && Number(rawGap.deferred) >= 0
    && rawGap.counts != null && typeof rawGap.counts === "object" && !Array.isArray(rawGap.counts)) {
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(rawGap.counts as Record<string, unknown>)) {
      if (Object.keys(counts).length >= 12) break;
      if (/^[A-Z][A-Z0-9_]{1,47}$/.test(key) && Number.isSafeInteger(value) && Number(value) >= 0) counts[key] = Number(value);
    }
    researchGapFill = { researchGapFill: {
      runs: Number(rawGap.runs), deferred: Number(rawGap.deferred), counts,
      ...(Number.isSafeInteger(rawGap.lastRunAt) && Number(rawGap.lastRunAt) >= 0 ? { lastRunAt: Number(rawGap.lastRunAt) } : {}),
      ...(typeof rawGap.lastErrorCode === "string" && /^[A-Z][A-Z0-9_]{1,47}$/.test(rawGap.lastErrorCode) ? { lastErrorCode: rawGap.lastErrorCode } : {}),
    } };
  }
  // The same summary per research bar length; only the declared lengths are accepted as keys.
  const rawByInterval = source.researchExperimentTicksByInterval as Record<string, unknown> | null | undefined;
  let experimentTicksByInterval: { researchExperimentTicksByInterval?: Record<string, ReturnType<typeof publicTicks>> } = {};
  if (rawByInterval != null && typeof rawByInterval === "object" && !Array.isArray(rawByInterval)) {
    const byInterval: Record<string, ReturnType<typeof publicTicks>> = {};
    for (const [key, value] of Object.entries(rawByInterval)) {
      const summary = /^(1|15|60|240)m$/.test(key) ? publicTicks(value as Record<string, unknown> | null) : undefined;
      if (summary !== undefined) byInterval[key] = summary;
    }
    if (Object.keys(byInterval).length > 0) experimentTicksByInterval = { researchExperimentTicksByInterval: byInterval };
  }
  // Closed-learning loop: integers for the counters and the tick time, fixed codes for the steps; nothing else.
  const rawLoop = source.closedLearningLoop as Record<string, unknown> | null | undefined;
  let closedLearningLoop: { closedLearningLoop?: Record<string, string | number | Record<string, string | number>> } = {};
  const LOOP_INTS = ["lastTickAt", "ticks", "cyclesEvaluated", "deployments"] as const;
  const LOOP_CODES = ["bootstrap", "rollover", "rolloverReason", "lastCycleStatus", "lastCycleOutcome", "lastBlockedReason", "lastErrorClass"] as const;
  if (rawLoop != null && typeof rawLoop === "object" && LOOP_INTS.every((key) => Number.isSafeInteger(rawLoop[key]) && Number(rawLoop[key]) >= 0)
    && typeof rawLoop.bootstrap === "string" && typeof rawLoop.rollover === "string") {
    const loop: Record<string, string | number | Record<string, string | number>> = {};
    for (const key of LOOP_INTS) loop[key] = Number(rawLoop[key]);
    for (const key of LOOP_CODES) { const value = rawLoop[key]; if (typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value)) loop[key] = value; }
    if ((loop.rollover === "BLOCKED" || loop.rollover === "ERROR") && typeof rawLoop.currentBlockedReason === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(rawLoop.currentBlockedReason)) loop.currentBlockedReason = rawLoop.currentBlockedReason;
    const eligibleAt = rawLoop.nextEvaluationEligibleAt;
    const cadence = rawLoop.evaluationPeriodMs;
    if (cadence === 3_600_000 || cadence === 86_400_000) loop.evaluationPeriodMs = cadence;
    const periodStart = (rawLoop.evidence as Record<string, unknown> | null)?.openPeriodStartAt;
    const isHourlyBoundary = cadence === 3_600_000 && Number.isSafeInteger(periodStart) && Number(periodStart) >= 0 && Number(periodStart) <= Number(loop.lastTickAt) && Number(eligibleAt) === Number(periodStart) + cadence;
    if (["WAITING_FOR_KST_DAY_ROLLOVER", "WAITING_FOR_EVALUATION_WINDOW"].includes(String(loop.rollover)) && Number.isSafeInteger(eligibleAt) && Number(eligibleAt) > Number(loop.lastTickAt)
      && Number(eligibleAt) <= Number(loop.lastTickAt) + 86_400_000 && Number(eligibleAt) <= 8_640_000_000_000_000 && (isHourlyBoundary || Number(eligibleAt) % 86_400_000 === 54_000_000)) loop.nextEvaluationEligibleAt = Number(eligibleAt);
    if (loop.lastBlockedReason !== undefined && Number.isSafeInteger(rawLoop.lastBlockedAt) && Number(rawLoop.lastBlockedAt) >= 0) loop.lastBlockedAt = Number(rawLoop.lastBlockedAt);
    else delete loop.lastBlockedReason;
    // Correlation identities: fixed keys only; identifiers, 64-hex fingerprints, KRW markets and integers.
    const rawEvidence = rawLoop.evidence as Record<string, unknown> | null | undefined;
    if (rawEvidence != null && typeof rawEvidence === "object" && !Array.isArray(rawEvidence)) {
      const ID = /^[A-Za-z0-9_.:\/#@-]{1,160}$/;
      const HEX = /^[a-f0-9]{64}$/;
      const rules: Record<string, (value: unknown) => boolean> = {
        openPeriodId: (v) => typeof v === "string" && ID.test(v), openMarket: (v) => typeof v === "string" && /^KRW-[A-Z0-9]{1,15}$/.test(v),
        openCandidateId: (v) => typeof v === "string" && ID.test(v), realizedPeriodId: (v) => typeof v === "string" && ID.test(v),
        cycleId: (v) => typeof v === "string" && ID.test(v), cycleEvidenceId: (v) => typeof v === "string" && ID.test(v),
        decisionId: (v) => typeof v === "string" && ID.test(v), decisionReference: (v) => typeof v === "string" && ID.test(v),
        decisionCandidateId: (v) => typeof v === "string" && ID.test(v), deploymentId: (v) => typeof v === "string" && ID.test(v),
        realizedOutcomeFingerprint: (v) => typeof v === "string" && HEX.test(v), realizedCostEvidenceFingerprint: (v) => typeof v === "string" && HEX.test(v),
        cycleEvidenceFingerprint: (v) => typeof v === "string" && HEX.test(v),
        latestFailureId: (v) => typeof v === "string" && ID.test(v), latestFailurePeriodId: (v) => typeof v === "string" && ID.test(v),
        latestFailureEvidenceId: (v) => typeof v === "string" && ID.test(v), latestFailureEvidenceFingerprint: (v) => typeof v === "string" && HEX.test(v),
        latestFailureSourceCommitSha: (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v), latestFailureRuntimeSourceCommitSha: (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v),
        latestFailureStage: (v) => typeof v === "string" && /^(IDENTITY|CYCLE|FINALIZE)$/.test(v), latestFailureCode: (v) => typeof v === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(v),
        latestFailureRecordedAt: (v) => Number.isSafeInteger(v) && Number(v) >= 0, failuresRecorded: (v) => Number.isSafeInteger(v) && Number(v) >= 0,
        openPeriodStartAt: (v) => Number.isSafeInteger(v) && Number(v) >= 0, openObservations: (v) => Number.isSafeInteger(v) && Number(v) >= 0,
        openFilledObservations: (v) => Number.isSafeInteger(v) && Number(v) >= 0, realizedPeriods: (v) => Number.isSafeInteger(v) && Number(v) >= 0,
        baselineObservations: (v) => Number.isSafeInteger(v) && Number(v) >= 0,
        realizedPeriodEndAt: (v) => Number.isSafeInteger(v) && Number(v) >= 0,
        // Rule-replay parity: one period id, counts, and SIGNED basis points (returns can be negative); no amount or price.
        replayPeriodId: (v) => typeof v === "string" && ID.test(v), replayBars: (v) => Number.isSafeInteger(v) && Number(v) >= 0,
        replayTrades: (v) => Number.isSafeInteger(v) && Number(v) >= 0, replayClosedNetBp: (v) => Number.isSafeInteger(v) && Math.abs(Number(v)) < 1_000_000,
        replayOpenMarkBp: (v) => Number.isSafeInteger(v) && Math.abs(Number(v)) < 1_000_000, replayPaperNetBp: (v) => Number.isSafeInteger(v) && Math.abs(Number(v)) < 1_000_000,
        cyclesRecorded: (v) => Number.isSafeInteger(v) && Number(v) >= 0, lastCycleRecordedAt: (v) => Number.isSafeInteger(v) && Number(v) >= 0,
        // Baseline shadow totals: counts and basis points as non-negative integers; no amount or price.
        shadowSince: (v) => Number.isSafeInteger(v) && Number(v) >= 0, shadowTrades: (v) => Number.isSafeInteger(v) && Number(v) >= 0,
        shadowWins: (v) => Number.isSafeInteger(v) && Number(v) >= 0, shadowGrossGainBp: (v) => Number.isSafeInteger(v) && Number(v) >= 0,
        shadowGrossLossBp: (v) => Number.isSafeInteger(v) && Number(v) >= 0, shadowFeeBp: (v) => Number.isSafeInteger(v) && Number(v) >= 0,
        // Null comparators (buy-and-hold, seeded random entry): counts and SIGNED basis points; no amount or price.
        nullSince: (v) => Number.isSafeInteger(v) && Number(v) >= 0, nullSeed: (v) => Number.isSafeInteger(v) && Number(v) >= 0,
        nullBaseTrades: (v) => Number.isSafeInteger(v) && Number(v) >= 0, nullBaseNetBp: (v) => Number.isSafeInteger(v) && Math.abs(Number(v)) <= 10_000_000,
        nullHoldMarkets: (v) => Number.isSafeInteger(v) && Number(v) >= 0, nullHoldNetBp: (v) => Number.isSafeInteger(v) && Math.abs(Number(v)) <= 10_000_000,
        nullRandTrades: (v) => Number.isSafeInteger(v) && Number(v) >= 0, nullRandWins: (v) => Number.isSafeInteger(v) && Number(v) >= 0,
        nullRandNetBp: (v) => Number.isSafeInteger(v) && Math.abs(Number(v)) <= 10_000_000, nullRandSkipped: (v) => Number.isSafeInteger(v) && Number(v) >= 0,
      };
      const evidence: Record<string, string | number> = {};
      for (const [key, accept] of Object.entries(rules)) { const value = rawEvidence[key]; if (accept(value)) evidence[key] = value as string | number; }
      if (Object.keys(evidence).length > 0) loop.evidence = evidence;
    }
    // Meta-learning: integers, fixed dimension/combination codes and code lists only.
    const rawMeta = rawLoop.metaLearning as Record<string, unknown> | null | undefined;
    if (rawMeta != null && typeof rawMeta === "object" && !Array.isArray(rawMeta)) {
      const ints = ["experiments", "configurations", "discoveryPasses", "holdoutPasses", "nextHoldoutBarMicros", "runtimeEntries", "liveForwardEntries", "longBarTickEvery"] as const;
      const LIST = /^$|^[A-Za-z]+=[A-Z_]+(,[A-Za-z]+=[A-Z_]+)*$/;
      const PREREQ = /^$|^COLLECT_[A-Z]+(,COLLECT_[A-Z]+)*$/;
      const COMBO = /^[A-Z]+\+[A-Z]+\+[A-Z_]+\+[A-Z]+$/;
      if (ints.every((key) => Number.isSafeInteger(rawMeta[key]) && Number(rawMeta[key]) >= 0)
        && typeof rawMeta.validKnowledgePer100Configs === "number" && Number.isFinite(rawMeta.validKnowledgePer100Configs) && rawMeta.validKnowledgePer100Configs >= 0 && rawMeta.validKnowledgePer100Configs <= 100
        && typeof rawMeta.exhausted === "string" && LIST.test(rawMeta.exhausted) && rawMeta.exhausted.length <= 400
        && typeof rawMeta.recommendedPrerequisites === "string" && PREREQ.test(rawMeta.recommendedPrerequisites)
        && (rawMeta.steeringMode === "NORMAL" || rawMeta.steeringMode === "DEPRIORITIZE_EXHAUSTED")) {
        const meta: Record<string, string | number> = {};
        for (const key of ints) meta[key] = Number(rawMeta[key]);
        meta.validKnowledgePer100Configs = rawMeta.validKnowledgePer100Configs;
        meta.exhausted = rawMeta.exhausted;
        meta.recommendedPrerequisites = rawMeta.recommendedPrerequisites;
        meta.steeringMode = rawMeta.steeringMode;
        if (Number.isSafeInteger(rawMeta.paperPeriodsConsumed) && Number(rawMeta.paperPeriodsConsumed) >= 0) meta.paperPeriodsConsumed = Number(rawMeta.paperPeriodsConsumed);
        for (const key of ["paperNetBp", "paperExcessBp"] as const) if (Number.isSafeInteger(rawMeta[key]) && Math.abs(Number(rawMeta[key])) <= 1_000_000) meta[key] = Number(rawMeta[key]);
        if (typeof rawMeta.paperEvidenceFingerprint === "string" && /^[a-f0-9]{64}$/.test(rawMeta.paperEvidenceFingerprint)) meta.paperEvidenceFingerprint = rawMeta.paperEvidenceFingerprint;
        if (Number.isSafeInteger(rawMeta.overfitRatePercent) && Number(rawMeta.overfitRatePercent) >= 0 && Number(rawMeta.overfitRatePercent) <= 100) meta.overfitRatePercent = Number(rawMeta.overfitRatePercent);
        if (typeof rawMeta.recommended === "string" && COMBO.test(rawMeta.recommended)) meta.recommended = rawMeta.recommended;
        loop.metaLearning = meta;
      }
    }
    if (loop.bootstrap !== undefined && loop.rollover !== undefined) closedLearningLoop = { closedLearningLoop: loop };
  }
  // Microstructure recorder: non-negative integer counters and one timestamp only.
  const rawMicro = source.microstructureRecorder as Record<string, unknown> | null | undefined;
  let microstructure: { microstructureRecorder?: Record<string, number> } = {};
  if (rawMicro != null && typeof rawMicro === "object" && ["orderBookSamples", "tradeTicks", "writeFailures"].every((key) => Number.isSafeInteger(rawMicro[key]) && Number(rawMicro[key]) >= 0)) {
    microstructure = { microstructureRecorder: { orderBookSamples: Number(rawMicro.orderBookSamples), tradeTicks: Number(rawMicro.tradeTicks), writeFailures: Number(rawMicro.writeFailures), ...(Number.isSafeInteger(rawMicro.rejectedRows) && Number(rawMicro.rejectedRows) >= 0 ? { rejectedRows: Number(rawMicro.rejectedRows) } : {}), ...(Number.isSafeInteger(rawMicro.lastRecordedAt) && Number(rawMicro.lastRecordedAt) > 0 ? { lastRecordedAt: Number(rawMicro.lastRecordedAt) } : {}) } };
  }
  // All-KRW order-book collector: non-negative integer counters and one timestamp only.
  const rawCollector = source.orderBookCollector as Record<string, unknown> | null | undefined;
  let orderBookCollector: { orderBookCollector?: Record<string, number> } = {};
  if (rawCollector != null && typeof rawCollector === "object" && ["rounds", "markets", "samplesStored", "failures"].every((key) => Number.isSafeInteger(rawCollector[key]) && Number(rawCollector[key]) >= 0)) {
    orderBookCollector = { orderBookCollector: { rounds: Number(rawCollector.rounds), markets: Number(rawCollector.markets), samplesStored: Number(rawCollector.samplesStored), failures: Number(rawCollector.failures), ...(Number.isSafeInteger(rawCollector.rejected) && Number(rawCollector.rejected) >= 0 ? { rejected: Number(rawCollector.rejected) } : {}), ...(Number.isSafeInteger(rawCollector.lastRoundAt) && Number(rawCollector.lastRoundAt) > 0 ? { lastRoundAt: Number(rawCollector.lastRoundAt) } : {}) } };
  }
  // Public futures collector: non-negative integer counters and one timestamp only.
  const rawFutures = source.futuresCollector as Record<string, unknown> | null | undefined;
  let futuresCollector: { futuresCollector?: Record<string, number> } = {};
  const futuresKeys = ["rounds", "marksStored", "fundingStored", "klinesStored", "failures", "rejected"];
  if (rawFutures != null && typeof rawFutures === "object" && futuresKeys.every((key) => Number.isSafeInteger(rawFutures[key]) && Number(rawFutures[key]) >= 0)) {
    futuresCollector = { futuresCollector: { ...Object.fromEntries(futuresKeys.map((key) => [key, Number(rawFutures[key])])), ...(Number.isSafeInteger(rawFutures.lastRoundAt) && Number(rawFutures.lastRoundAt) > 0 ? { lastRoundAt: Number(rawFutures.lastRoundAt) } : {}) } };
  }
  // Stored-data integrity probe: a fixed status plus non-negative integers only.
  const rawIntegrity = source.dataIntegrity as Record<string, unknown> | null | undefined;
  let dataIntegrity: { dataIntegrity?: Record<string, string | number> } = {};
  if (rawIntegrity != null && typeof rawIntegrity === "object" && !Array.isArray(rawIntegrity) && (rawIntegrity.status === "PASS" || rawIntegrity.status === "WARN" || rawIntegrity.status === "FAIL")) {
    const value: Record<string, string | number> = { status: rawIntegrity.status };
    for (const [key, field] of Object.entries(rawIntegrity).slice(0, 40)) if (key !== "status" && /^[a-zA-Z0-9]{1,40}$/.test(key) && Number.isSafeInteger(field) && Number(field) >= 0) value[key] = Number(field);
    dataIntegrity = { dataIntegrity: value };
  }
  const rawResearch = source.researchCollectionStatus;
  const research = typeof rawResearch === "string" && ["COLLECTING", "DISABLED", "INVALID", "UNAVAILABLE"].includes(rawResearch)
    ? {
      researchCollectionStatus: rawResearch,
      ...(optionalNumber("researchCandleCount") === undefined ? {} : { researchCandleCount: Math.trunc(optionalNumber("researchCandleCount") as number) }),
      ...(optionalNumber("researchRequiredCandles") === undefined ? {} : { researchRequiredCandles: Math.trunc(optionalNumber("researchRequiredCandles") as number) }),
    }
    : {};
  // Ledger identity: a 64-hex fingerprint and non-negative integers; no amount is ever published.
  const rawLedger = source.paperLedger as Record<string, unknown> | null | undefined;
  const nonNegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  const paperLedger = rawLedger != null && typeof rawLedger === "object" && typeof rawLedger.ledgerFingerprintSha256 === "string" && /^[a-f0-9]{64}$/.test(rawLedger.ledgerFingerprintSha256)
    && nonNegative(rawLedger.fillCount) && nonNegative(rawLedger.openPositionCount) && nonNegative(rawLedger.ledgerUpdatedAt) && (rawLedger.lastFillAt === undefined || nonNegative(rawLedger.lastFillAt))
    ? { paperLedger: { ledgerFingerprintSha256: rawLedger.ledgerFingerprintSha256, fillCount: rawLedger.fillCount, openPositionCount: rawLedger.openPositionCount, ...(rawLedger.lastFillAt === undefined ? {} : { lastFillAt: rawLedger.lastFillAt }), ledgerUpdatedAt: rawLedger.ledgerUpdatedAt } }
    : {};
  // Build identity: only a full lowercase 40-hex commit is published, never other text.
  const sourceCommitSha = typeof source.sourceCommitSha === "string" && /^[0-9a-f]{40}$/.test(source.sourceCommitSha) ? { sourceCommitSha: source.sourceCommitSha } : {};
  return Object.freeze({ ...sourceCommitSha, ...paperLedger, ...timestamps, ...counters, ...(lastPaperDecisionOutcome === undefined ? {} : { lastPaperDecisionOutcome }), lastError, ...(previousStop === undefined ? {} : { previousStop }), ...stall, ...research, ...funnel, ...lossSession, ...lossAttribution, ...experimentTicks, ...experimentTicksByInterval, ...researchGapFill, ...closedLearningLoop, ...microstructure, ...orderBookCollector, ...futuresCollector, ...dataIntegrity }) as unknown as CloudRuntimeLivenessSnapshot;
}

const PUBLIC_HEALTH_REASONS = new Set(["EVIDENCE_HEALTHY", "EVIDENCE_DEGRADED", "EVIDENCE_FAILED", "EVIDENCE_STALE", "EVIDENCE_MISSING", "EVIDENCE_INVALID_TIME", "RECOVERY_NOT_VERIFIED"]);
function publicComponentHealth(value: ComponentHealthResult, componentId: "PAPER_PROCESS" | "PAPER_WORKLOAD"): ComponentHealthResult | null {
  if (value == null || typeof value !== "object") return null;
  const provenance = componentId === "PAPER_PROCESS" ? "cloud-runtime-heartbeat" : "cloud-paper-market-events";
  const evidencePrefix = componentId === "PAPER_PROCESS" ? "heartbeat" : "market-event";
  if (value.componentId !== componentId || !COMPONENT_HEALTH_STATES.includes(value.state)
    || !PUBLIC_HEALTH_REASONS.has(value.reasonCode) || !Number.isSafeInteger(value.evaluatedAt)
    || value.evaluatedAt < 0 || typeof value.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.fingerprint)) return null;
  if (value.observedAt !== undefined && (!Number.isSafeInteger(value.observedAt) || value.observedAt < 0 || value.observedAt > value.evaluatedAt)) return null;
  if (value.provenance !== undefined && value.provenance !== provenance) return null;
  if (value.evidenceId !== undefined && (typeof value.evidenceId !== "string" || !new RegExp(`^${evidencePrefix}:\\d+:\\d+(?::\\d+)?$`).test(value.evidenceId))) return null;
  return Object.freeze({ componentId, state: value.state, reasonCode: value.reasonCode,
    evaluatedAt: value.evaluatedAt, ...(value.observedAt === undefined ? {} : { observedAt: value.observedAt }),
    ...(value.provenance === undefined ? {} : { provenance }),
    ...(value.evidenceId === undefined ? {} : { evidenceId: value.evidenceId }), fingerprint: value.fingerprint });
}
function publicRuntimeHealth(value: ReturnType<NonNullable<CloudDashboardServerOptions["runtimeHealth"]>> | undefined): ReturnType<NonNullable<CloudDashboardServerOptions["runtimeHealth"]>> | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const process = publicComponentHealth(value.process, "PAPER_PROCESS");
  const workload = publicComponentHealth(value.workload, "PAPER_WORKLOAD");
  return process === null || workload === null ? undefined : Object.freeze({ process, workload });
}

export function startCloudDashboardServer(options: CloudDashboardServerOptions): CloudDashboardServerHandle {
  if (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error("invalid cloud dashboard server port");
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host.toLowerCase() !== "localhost") throw new Error("cloud dashboard server must bind to localhost");
  // Keep the legacy injection point for existing tests, but production uses separate bounded
  // lanes. Anonymous scanning must never fill the registry needed by a verified mobile session.
  const anonymousRateLimiter = options.anonymousRateLimiter ?? options.rateLimiter ?? new BoundedHttpRateLimiter();
  const authenticatedRateLimiter = options.authenticatedRateLimiter ?? options.rateLimiter ?? new BoundedHttpRateLimiter();
  const mobileSessionRefreshRateLimiter = options.mobileSessionRefreshRateLimiter ?? options.rateLimiter ?? new BoundedHttpRateLimiter();

  let ownedUserDb: SqliteDatabase | undefined;
  let userAccessRepository = options.userAccessRepository;
  if (userAccessRepository == null) {
    const pathname = process.env.NUSA_CLOUD_STATE_DB_PATH?.trim() || ":memory:";
    ownedUserDb = new SqliteDatabase(pathname);
    userAccessRepository = new SqliteNusaUserAccessRepository(ownedUserDb);
  }
  const desktopSessionService = options.desktopSessionService ?? (ownedUserDb == null ? undefined : new DesktopSessionService(ownedUserDb, userAccessRepository));
  const mobileSessionService = options.mobileSessionService ?? (ownedUserDb == null ? undefined : new MobileSessionService(ownedUserDb, userAccessRepository));
  const ownerDeviceCredentialService = options.ownerDeviceCredentialService ?? (ownedUserDb == null || mobileSessionService == null ? undefined : new OwnerDeviceCredentialService(ownedUserDb, userAccessRepository, mobileSessionService));
  const anonymousObservation: AnonymousObservationScope | null = anonymousObservationEnabled() ? createAnonymousObservationScope() : null;

  const ownerPrincipal = options.tokenVerifier.ownerPrincipal;
  if (ownerPrincipal != null) {
    if (!ownerPrincipal.userId.trim() || !ownerPrincipal.email?.trim()) throw new Error("owner principal identity is incomplete");
    userAccessRepository.ensureOwner({
      id: ownerPrincipal.userId.trim(),
      email: ownerPrincipal.email.trim(),
      ...(ownerPrincipal.displayName?.trim() ? { displayName: ownerPrincipal.displayName.trim() } : {})
    });
  }

  const resolveTokenPrincipal = (token: string): DashboardPrincipal | undefined => {
    try {
      // Session verifiers intentionally fail closed by throwing for malformed or
      // unknown session material. Keep the legacy shared-secret verifier reachable
      // when no mobile/desktop session matches, without treating a verifier error
      // as permission to bypass the remaining checks. This phase is identity-only:
      // it must not register/touch user state because it is also used before metering.
      let principal: DashboardPrincipal | undefined;
      try { principal = mobileSessionService?.verifyAccess(token); } catch { principal = undefined; }
      if (principal == null) {
        try { principal = desktopSessionService?.verifyAccess(token); } catch { principal = undefined; }
      }
      if (principal == null) {
        try { principal = options.tokenVerifier.verify(token); } catch { principal = undefined; }
      }
      const userId = principal?.userId.trim();
      const email = principal?.email?.trim().toLowerCase();
      if (!principal || !userId || !email) return undefined;
      return Object.freeze({
        ...principal,
        userId,
        email,
        ...(principal.displayName?.trim() ? { displayName: principal.displayName.trim() } : {})
      });
    } catch {
      return undefined;
    }
  };

  const authorizeResolvedPrincipal = (principal: DashboardPrincipal, mutateUserState: boolean): DashboardPrincipal | undefined => {
    try {
      const principalEmail = principal.email?.trim().toLowerCase();
      if (!principal.userId.trim() || !principalEmail) return undefined;
      let actor = userAccessRepository.get(principal.userId.trim());
      if (actor == null) {
        if (!mutateUserState) return undefined;
        actor = userAccessRepository.registerUser({
          id: principal.userId.trim(),
          email: principalEmail,
          ...(principal.displayName?.trim() ? { displayName: principal.displayName.trim() } : {})
        });
      } else if (actor.email !== principalEmail) {
        return undefined;
      }
      if (!isUserAllowed(actor)) return undefined;
      if (mutateUserState) {
        try { userAccessRepository.markSeen(actor.id); } catch { return undefined; }
      }
      return principal;
    } catch {
      return undefined;
    }
  };

  const accessControlledTokenVerifier: DashboardTokenVerifier = Object.freeze({
    ...(ownerPrincipal == null ? {} : { ownerPrincipal }),
    verify(token: string) {
      const principal = resolveTokenPrincipal(token);
      return principal == null ? undefined : authorizeResolvedPrincipal(principal, true);
    }
  });

  const server: Server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = correlationId(req);
    const path = (() => { try { return new URL(req.url ?? "/", "http://localhost").pathname; } catch { return req.url ?? "/"; } })();
    // The exemption must be exactly as narrow as the /health handler below, which matches the
    // raw URL. Exempting the normalized path instead would let "/health?x" skip the limiter
    // and then fall through to ordinary routing as an unmetered request.
    let preverifiedBearerToken: string | undefined;
    let preverifiedBearerPrincipal: DashboardPrincipal | undefined;
    if (req.url !== "/health") {
      // A malformed or unknown bearer remains in the anonymous lane. Pre-limit classification
      // is deliberately side-effect free: it may read/verify an existing approved identity, but
      // user registration and markSeen happen only inside the authenticated handler path. Exact
      // mobile refresh requests authenticate in the body after metering, so they keep a separate
      // bounded lane without pre-reading refresh secrets.
      const presentedToken = bearerToken(req);
      const resolvedPrincipal = presentedToken == null ? undefined : resolveTokenPrincipal(presentedToken);
      const authenticatedPrincipal = resolvedPrincipal == null ? undefined : authorizeResolvedPrincipal(resolvedPrincipal, false);
      if (authenticatedPrincipal != null && presentedToken != null) {
        preverifiedBearerToken = presentedToken;
        preverifiedBearerPrincipal = authenticatedPrincipal;
      }
      const mobileSessionRefresh = req.url === "/v1/mobile/session/refresh" && (req.method ?? "GET").toUpperCase() === "POST";
      const limiter = authenticatedPrincipal != null
        ? authenticatedRateLimiter
        : mobileSessionRefresh
          ? mobileSessionRefreshRateLimiter
          : anonymousRateLimiter;
      const identity = authenticatedPrincipal == null
        ? rateLimitIdentity(undefined, req.socket.remoteAddress)
        : `principal:${actorRef(authenticatedPrincipal.userId)}`;
      const bucket = `${path}|${identity}`;
      const decision = limiter.evaluate(bucket, requestId, req.method === "POST" || req.method === "PUT" ? 4 : 1);
      if (!decision.allowed) {
        req.resume();
        operationalLog("WARN", "cloud.rate_limit.blocked", requestId, { path, reason: decision.reason ?? "rate limit exceeded", authority: "PAPER_ONLY" });
        const base = dashboardJsonResponse(429, { error: "RATE_LIMITED" });
        write(res, Object.freeze({ ...base, headers: Object.freeze({ ...base.headers, "retry-after": String(decision.retryAfterSeconds ?? 1) }) }));
        return;
      }
    }
    let requestPrincipal: DashboardPrincipal | undefined;
    const requestTokenVerifier: DashboardTokenVerifier = Object.freeze({
      ...(ownerPrincipal == null ? {} : { ownerPrincipal }),
      verify(token: string) {
        const principal = preverifiedBearerToken === token && preverifiedBearerPrincipal != null
          ? authorizeResolvedPrincipal(preverifiedBearerPrincipal, true)
          : accessControlledTokenVerifier.verify(token);
        requestPrincipal = principal;
        return principal;
      }
    });
    const respond = (route: string, result: DashboardHttpResponse): void => {
      auditHttpResponse(requestId, { method: req.method ?? "GET", headers: Object.freeze({ ...req.headers } as Record<string, string | undefined>) }, route, result, requestPrincipal);
      write(res, result);
    };
    try {
      if (req.url === "/health") {
        if (req.method !== "GET") { respond("health", dashboardJsonResponse(405, { error: "METHOD_NOT_ALLOWED" })); return; }
        // `ok` keeps its existing meaning -- the HTTP listener answers -- so existing probes are
        // unaffected. `capabilities` and `runtime` are both additive: neither replaces a field the
        // other side introduced, so the merge keeps both rather than choosing between them.
        // `runtime` appears only when a liveness source is wired, and carries the counters that
        // show whether the continuous PAPER loop is actually ticking.
        // `learningPipeline` and `learningPipelineAlarm` are derived only from the already-public `runtime` object.
        const pipeline = observePipeline();
        const runtimeHealth = publicRuntimeHealth(options.runtimeHealth?.());
        respond("health", dashboardJsonResponse(200, {
          ok: true,
          observedAt: new Date().toISOString(),
          capabilities: { passwordSignIn: mobileSessionService?.ownerPasswordConfigured() === true },
          ...(pipeline ?? {}),
          ...(runtimeHealth === undefined ? {} : { runtimeHealth })
        }));
        return;
      }

      if (isPublicUpbitQuotationPath(path)) {
        respond("public_upbit_quotation", await handlePublicUpbitQuotationHttp(req.url ?? path, req.method ?? "GET"));
        return;
      }

      const body = req.method === "POST" || req.method === "PUT" ? await readRequestBody(req) : undefined;
      const dashboardRequest: DashboardHttpRequest & { readonly body?: string } = Object.freeze({ method: req.method ?? "GET", headers: Object.freeze({ ...req.headers } as Record<string, string | undefined>), ...(body === undefined ? {} : { body }) });

      const servedAnonymously = anonymousObservation != null && isAnonymousObservationRoute(req.url) && !hasAuthorizationHeader(dashboardRequest.headers);
      const observationRequest: DashboardHttpRequest = servedAnonymously && anonymousObservation != null
        ? Object.freeze({ ...dashboardRequest, headers: Object.freeze({ ...dashboardRequest.headers, authorization: `Bearer ${anonymousObservation.sentinel}` }) })
        : dashboardRequest;
      const observationTokenVerifier: DashboardTokenVerifier = Object.freeze({
        ...(ownerPrincipal == null ? {} : { ownerPrincipal }),
        verify(token: string) {
          if (servedAnonymously && anonymousObservation != null && token === anonymousObservation.sentinel) { requestPrincipal = anonymousObservation.principal; return anonymousObservation.principal; }
          return requestTokenVerifier.verify(token);
        }
      });

      if (desktopSessionService != null && req.url === "/api/operator/desktop-bootstrap") {
        respond("desktop_bootstrap_issue", handleDesktopBootstrapIssueHttp(dashboardRequest, { sessionService: desktopSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository }));
        return;
      }
      if (desktopSessionService != null && req.url === "/v1/desktop/bootstrap") {
        respond("desktop_bootstrap", handleDesktopBootstrapHttp(dashboardRequest, { sessionService: desktopSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository }));
        return;
      }
      if (desktopSessionService != null && req.url === "/v1/desktop/session/refresh") {
        respond("desktop_session_refresh", handleDesktopSessionRefreshHttp(dashboardRequest, { sessionService: desktopSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository }));
        return;
      }
      if (desktopSessionService != null && req.url === "/v1/desktop/session/revoke") {
        respond("desktop_session_revoke", handleDesktopSessionRevokeHttp(dashboardRequest, { sessionService: desktopSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository }));
        return;
      }
      if (desktopSessionService != null && req.url === "/v1/desktop/me") {
        const token = dashboardRequest.headers.authorization ?? dashboardRequest.headers.Authorization;
        if (typeof token === "string") {
          const raw = /^Bearer\s+([^\s]+)$/i.exec(token.trim())?.[1];
          if (raw) requestPrincipal = desktopSessionService.verifyAccess(raw);
        }
        respond("desktop_me", handleDesktopMeHttp(dashboardRequest, { sessionService: desktopSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository }));
        return;
      }

      if (mobileSessionService != null && req.url === "/api/operator/mobile-bootstrap") {
        respond("mobile_bootstrap_issue", handleMobileBootstrapIssueHttp(dashboardRequest, { sessionService: mobileSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository }));
        return;
      }
      if (mobileSessionService != null && req.url === "/v1/mobile/bootstrap") {
        respond("mobile_bootstrap", handleMobileBootstrapHttp(dashboardRequest, { sessionService: mobileSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository }));
        return;
      }
      if (mobileSessionService != null && req.url === "/v1/mobile/enroll") {
        respond("mobile_enroll", handleMobileEnrollmentHttp(dashboardRequest, { sessionService: mobileSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository }));
        return;
      }
      if (mobileSessionService != null && req.url === "/v1/mobile/session/password") {
        respond("mobile_session_password", handleOwnerPasswordSignInHttp(dashboardRequest, { sessionService: mobileSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository })); return;
      }
      if (mobileSessionService != null && req.url === "/v1/mobile/session/password/change") {
        respond("mobile_session_password_change", handleOwnerPasswordChangeHttp(dashboardRequest, { sessionService: mobileSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository })); return;
      }
      if (mobileSessionService != null && req.url === "/v1/mobile/owner-device/registration/challenge") {
        respond("owner_device_registration_challenge", handleOwnerDeviceCredentialRegistrationChallengeHttp(dashboardRequest, { sessionService: mobileSessionService, ownerDeviceCredentialService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository })); return;
      }
      if (mobileSessionService != null && req.url === "/v1/mobile/owner-device/registration/activate") {
        respond("owner_device_registration_activate", handleOwnerDeviceCredentialRegistrationActivateHttp(dashboardRequest, { sessionService: mobileSessionService, ownerDeviceCredentialService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository })); return;
      }
      if (mobileSessionService != null && req.url === "/v1/mobile/owner-device/authentication/challenge") {
        respond("owner_device_authentication_challenge", handleOwnerDeviceCredentialAuthenticationChallengeHttp(dashboardRequest, { sessionService: mobileSessionService, ownerDeviceCredentialService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository })); return;
      }
      if (mobileSessionService != null && req.url === "/v1/mobile/owner-device/authentication/complete") {
        respond("owner_device_authentication_complete", handleOwnerDeviceCredentialAuthenticationCompleteHttp(dashboardRequest, { sessionService: mobileSessionService, ownerDeviceCredentialService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository })); return;
      }
      if (mobileSessionService != null && req.url === "/v1/mobile/owner-device/revoke") {
        respond("owner_device_revoke", handleOwnerDeviceCredentialRevokeHttp(dashboardRequest, { sessionService: mobileSessionService, ownerDeviceCredentialService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository })); return;
      }
      if (mobileSessionService != null && req.url === "/v1/mobile/pairing/start") {
        respond("mobile_pairing_start", handleMobilePairingStartHttp(dashboardRequest, { sessionService: mobileSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository })); return;
      }
      if (mobileSessionService != null && req.url === "/v1/mobile/pairing/status") {
        respond("mobile_pairing_status", handleMobilePairingStatusHttp(dashboardRequest, { sessionService: mobileSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository })); return;
      }
      if (mobileSessionService != null && req.url === "/v1/mobile/pairing/exchange") {
        respond("mobile_pairing_exchange", handleMobilePairingExchangeHttp(dashboardRequest, { sessionService: mobileSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository })); return;
      }
      if (mobileSessionService != null && req.url === "/api/operator/mobile-pairing/approve") {
        respond("mobile_pairing_approve", handleMobilePairingApproveHttp(dashboardRequest, { sessionService: mobileSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository })); return;
      }
      if (mobileSessionService != null && req.url === "/v1/mobile/session/refresh") {
        respond("mobile_session_refresh", handleMobileSessionRefreshHttp(dashboardRequest, { sessionService: mobileSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository }));
        return;
      }
      if (mobileSessionService != null && req.url === "/v1/mobile/session/revoke") {
        respond("mobile_session_revoke", handleMobileSessionRevokeHttp(dashboardRequest, { sessionService: mobileSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository }));
        return;
      }
      if (mobileSessionService != null && req.url === "/v1/mobile/me") {
        const token = dashboardRequest.headers.authorization ?? dashboardRequest.headers.Authorization;
        if (typeof token === "string") {
          const raw = /^Bearer\s+([^\s]+)$/i.exec(token.trim())?.[1];
          if (raw) requestPrincipal = mobileSessionService.verifyAccess(raw);
        }
        respond("mobile_me", handleMobileMeHttp(dashboardRequest, { sessionService: mobileSessionService, legacyTokenVerifier: options.tokenVerifier, userAccessRepository }));
        return;
      }

      if (req.url === "/ready") {
        const authorization = authorizeDashboardReadRequest(dashboardRequest, requestTokenVerifier);
        if (!authorization.ok) { respond("readiness", authorization.response); return; }
        try {
          const readiness = options.readiness?.() ?? unavailable();
          const checks = Object.freeze({ database: readiness.checks.database === true, migrations: readiness.checks.migrations === true, dashboardPersistence: readiness.checks.dashboardPersistence === true, runtimeRecovery: readiness.checks.runtimeRecovery === true });
          const ok = readiness.ok === true && Object.values(checks).every(Boolean);
          operationalLog(ok ? "INFO" : "WARN", "cloud.readiness", requestId, { ok, checks });
          respond("readiness", dashboardJsonResponse(ok ? 200 : 503, { ok, checks }));
        } catch { const readiness = unavailable(); operationalLog("ERROR", "cloud.readiness", requestId, { ok: readiness.ok, checks: readiness.checks }); respond("readiness", dashboardJsonResponse(503, readiness)); }
        return;
      }

      if (req.url === "/api/paper-orders") {
        let payload: unknown = null;
        if ((req.method ?? "GET").toUpperCase() === "POST") {
          try { payload = JSON.parse(body ?? ""); }
          catch { respond("paper_order", dashboardJsonResponse(400, { error: "INVALID_JSON" })); return; }
        }
        respond("paper_order", handlePersonalPaperOrderHttp(dashboardRequest, payload, {
          tokenVerifier: requestTokenVerifier,
          submitOrder: options.submitPaperOrder ?? (() => { throw new Error("PAPER order submission not configured"); }),
          loadSnapshot: options.loadPaperOperations
        }));
        return;
      }
      if (req.url === "/api/ux-telemetry" && options.uxTelemetryStorage != null) {
        let payload: unknown = null;
        if ((req.method ?? "GET").toUpperCase() === "POST") {
          try { payload = JSON.parse(body ?? ""); }
          catch { respond("ux_telemetry", dashboardJsonResponse(400, { error: "INVALID_JSON" })); return; }
        }
        respond("ux_telemetry", await handleUxTelemetryEventHttp(dashboardRequest, payload, {
          tokenVerifier: requestTokenVerifier,
          storage: options.uxTelemetryStorage
        }));
        return;
      }
      if (req.url === "/api/paper-operations") { respond("paper_operations", handlePersonalPaperOperationsHttp(observationRequest, { tokenVerifier: observationTokenVerifier, loadSnapshot: options.loadPaperOperations ?? (() => { throw new Error("PAPER operations snapshot not configured"); }) })); return; }
      if (req.url === "/api/shadow-operations") { respond("shadow_operations", handleShadowOperationsHttp(observationRequest, { tokenVerifier: observationTokenVerifier, loadSnapshot: options.loadShadowOperations ?? (() => { throw new Error("SHADOW operations snapshot not configured"); }) })); return; }
      if (req.url === "/api/real-readonly-operations") { respond("real_readonly_operations", handleRealReadOnlyOperationsHttp(dashboardRequest, { tokenVerifier: requestTokenVerifier, loadSnapshot: options.loadRealReadOnlyOperations ?? (() => { throw new Error("REAL_READ_ONLY operations snapshot not configured"); }) })); return; }
      if (req.url === "/api/live-readiness") { respond("live_readiness", handleLiveReadinessHttp(observationRequest, { tokenVerifier: observationTokenVerifier, loadSnapshot: options.loadLiveReadiness ?? (() => { throw new Error("LIVE readiness source not configured"); }) })); return; }
      if (req.url === "/api/engineering-operations") { respond("engineering_operations", handleEngineeringOperationsHttp(observationRequest, { tokenVerifier: observationTokenVerifier, loadSnapshot: options.loadEngineeringOperations ?? (() => { throw new Error("Engineering OS snapshot not configured"); }) })); return; }
      if (req.url === "/api/evolution-learning") { respond("evolution_learning", handleEvolutionLearningSupervisorHttp(observationRequest, { tokenVerifier: observationTokenVerifier, loadSnapshot: options.loadEvolutionLearning ?? (() => { throw new Error("Evolution learning snapshot not configured"); }) })); return; }
      if (req.url === "/api/dashboard") { respond("dashboard", handleMobileDashboardHttp(observationRequest, { tokenVerifier: observationTokenVerifier, loadDashboard: options.loadDashboard })); return; }
      if (req.url === "/api/operator/users") { respond("operator_users", handleOperatorUserAccessHttp(dashboardRequest, { tokenVerifier: requestTokenVerifier, repository: userAccessRepository })); return; }
      if (req.url === "/api/settings/investment-allocation" && options.investmentAllocationSettings != null) {
        let payload: unknown = null;
        if (["PUT", "POST"].includes((req.method ?? "GET").toUpperCase())) {
          try { payload = JSON.parse(body ?? ""); }
          catch { respond("investment_allocation", dashboardJsonResponse(400, { error: "INVALID_JSON" })); return; }
        }
        respond("investment_allocation", handleInvestmentAllocationHttp(dashboardRequest, payload, { tokenVerifier: requestTokenVerifier, repository: options.investmentAllocationSettings }));
        return;
      }
      respond("unknown_route", dashboardJsonResponse(404, { error: "NOT_FOUND" }));
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        respond("request_body", dashboardJsonResponse(413, { error: "REQUEST_BODY_TOO_LARGE" }));
        return;
      }
      operationalLog("ERROR", "cloud.http.unavailable", requestId, { method: req.method ?? null, path: req.url ?? null });
      if (!res.headersSent) respond("server_error", dashboardJsonResponse(503, { error: "DASHBOARD_SERVER_UNAVAILABLE" })); else res.destroy();
    }
  });
  const pipelineAlarm = new LearningPipelineAlarmTracker();
  const observePipeline = (): { runtime: CloudRuntimeLivenessSnapshot; learningPipeline: LearningPipelineProjection; learningPipelineAlarm: LearningPipelineAlarmSnapshot; learningLoopVerdict: LearningLoopVerdict } | undefined => {
    const liveness = options.runtimeLiveness?.();
    if (liveness === undefined) return undefined;
    const now = Date.now();
    const runtime = publicRuntimeLiveness(liveness);
    const learningPipeline = learningPipelineProjection(runtime as unknown as Readonly<Record<string, unknown>>, now);
    return { runtime, learningPipeline, learningPipelineAlarm: pipelineAlarm.update(learningPipeline, now), learningLoopVerdict: learningLoopVerdict(runtime as unknown as Readonly<Record<string, unknown>>, learningPipeline) };
  };
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(options.port, host);

  let stopping: Promise<void> | undefined;
  return {
    port: options.port,
    host,
    observeLearningPipeline: () => { try { return observePipeline()?.learningPipelineAlarm; } catch { return undefined; } },
    stop(): Promise<void> {
      if (stopping) return stopping;
      stopping = new Promise((resolve) => {
        server.close(() => { try { ownedUserDb?.close(); } finally { resolve(); } });
        for (const socket of sockets) socket.destroy();
      });
      return stopping;
    }
  };
}
