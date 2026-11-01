/**
 * Learning funnel for the 학습 screen (redesign 2026-10-19): candidates tested -> passed discovery -> passed the independent
 * holdout. Read-only presentation of the server's integers; anything missing, malformed or inconsistent shows nothing rather
 * than a guessed number.
 */
export interface LearningFunnelStage {
  readonly label: string;
  readonly value: number;
  /** Width of the bar relative to the first stage, 0.18..1 (a zero stage keeps a visible sliver). */
  readonly width: number;
  readonly tone: "NORMAL" | "ATTENTION";
}

export interface LearningFunnelModel {
  readonly headline: string;
  readonly sub: string;
  /** Where the learning loop stands, in one plain sentence: whether a learning cycle (a candidate run against the baseline) has been evaluated and what it waits for. */
  readonly loop: string;
  /** The server's loop verdict in one plain sentence, or null when the server did not send a recognisable one. */
  readonly verdictLine: string | null;
  readonly stages: readonly LearningFunnelStage[];
}

const int = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * A learning cycle runs a candidate that passed the independent holdout against the baseline in PAPER, so with no holdout pass there is
 * nothing to evaluate and the cycle count stays at 0. Says so, and never reads as a failure of the loop itself.
 */
export function loopLine(holdoutPasses: number, cyclesEvaluated: number): string {
  if (cyclesEvaluated > 0) return `학습 한 바퀴를 이번 실행에서 ${cyclesEvaluated.toLocaleString("en-US")}번 평가했어요`;
  return holdoutPasses === 0
    ? "학습 한 바퀴(후보를 기준 규칙과 비교하는 평가)는 아직 안 돌았어요. 독립 검증을 통과한 후보가 있어야 돌아요"
    : "독립 검증을 통과한 후보가 있어요. 학습 한 바퀴는 아직 평가 전이에요";
}

const STAGE_KO: Readonly<Record<string, string>> = Object.freeze({
  MARKET: "시세", DECISION: "판단", ORDER: "주문", FILL: "체결", CANDLES: "캔들 기록", DATASET: "연구 데이터 봉인", EXPERIMENT: "연구 실험", LEARNING: "학습 평가",
});
const REASON_KO: Readonly<Record<string, string>> = Object.freeze({
  CANDLES_STALE: "캔들이 오래됐어요",
  DATASET_MANIFEST_MISSING: "연구 데이터 봉인이 아직 없어요",
  DATASET_NO_SESSION: "연구 세션이 아직 시작되지 않았어요",
  MARKET_STALE: "시세가 오래됐어요",
  MARKET_NO_EVENT: "시세가 아직 들어오지 않았어요",
  DECISION_NONE: "판단이 아직 없어요",
  ORDER_NONE: "주문이 아직 없어요",
  ORDER_INTENT_FAILING: "주문 직전에 계속 막혀요",
  FILL_NONE: "체결이 아직 없어요",
  LEARNING_NOT_EVALUATED: "학습 평가가 아직 안 됐어요",
});
const VERDICTS = ["LOOP_VERIFIED", "PARTIAL", "BLOCKED", "FAILED", "UNKNOWN"];
const WAITS = ["NONE", "NO_DEPLOYABLE_CANDIDATE", "EVALUATION_WINDOW", "UNKNOWN"];

/**
 * The server's verdict for the whole loop in one sentence. Only the fixed labels and codes the server publishes are accepted; anything
 * else (a missing field, an unknown label, free text) shows nothing instead of a guess. Never says the loop is broken unless the server says FAILED.
 */
export function verdictLine(raw: unknown): string | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.verdict !== "string" || !VERDICTS.includes(v.verdict) || typeof v.cycleWaitingFor !== "string" || !WAITS.includes(v.cycleWaitingFor)) return null;
  if (typeof v.firstBrokenTransition !== "string" || typeof v.firstBrokenCode !== "string") return null;
  const stage = STAGE_KO[v.firstBrokenTransition];
  const reason = REASON_KO[v.firstBrokenCode] ?? (stage == null ? null : `${stage} 단계에서 멈췄어요`);
  switch (v.verdict) {
    case "LOOP_VERIFIED": return "학습 폐루프가 끝까지 돌았어요 (시세부터 학습 평가 기록까지)";
    case "PARTIAL": return stage == null || reason == null ? "모의 거래는 끝까지 돌고 있어요. 연구나 학습 쪽은 아직 안 닫혔어요" : `모의 거래는 끝까지 돌고 있어요. ${stage} 단계가 아직 안 닫혔어요: ${reason}`;
    case "BLOCKED": return stage == null || reason == null ? "모의 거래 단계에서 막혀 있어요" : `${stage} 단계에서 막혀 있어요: ${reason}`;
    case "FAILED": return "학습 폐루프에 지금 오류가 있어요. 서버 상태를 확인해야 해요";
    default: return "서버가 폐루프 상태를 아직 판정하지 못했어요";
  }
}

export function buildLearningFunnel(raw: unknown): LearningFunnelModel | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const tested = int(r.configurations); const discovered = int(r.discoveryPasses); const passed = int(r.holdoutPasses); const cycles = int(r.cyclesEvaluated);
  if (tested == null || discovered == null || passed == null || cycles == null || tested === 0 || discovered > tested || passed > discovered) return null;
  const fmt = (n: number) => n.toLocaleString("en-US");
  const width = (n: number) => Math.max(0.18, Math.sqrt(n / tested));
  return Object.freeze({
    headline: passed === 0 ? `전략 ${fmt(tested)}개를 시험했고\n끝까지 통과한 건 0개예요` : `전략 ${fmt(tested)}개 중\n${fmt(passed)}개가 독립 검증을 통과했어요`,
    sub: passed === 0 ? "과거 데이터에선 맞아도 새 데이터에선 틀렸어요. 기준은 낮추지 않아요." : `이번 실행에서 평가한 학습 사이클 ${fmt(cycles)}번`,
    loop: loopLine(passed, cycles),
    verdictLine: verdictLine(r.loopVerdict),
    stages: Object.freeze([
      Object.freeze({ label: "시험한 전략", value: tested, width: 1, tone: "NORMAL" as const }),
      Object.freeze({ label: "1차 통과", value: discovered, width: width(discovered), tone: "NORMAL" as const }),
      Object.freeze({ label: "독립 검증 합격", value: passed, width: width(passed), tone: passed === 0 ? "ATTENTION" as const : "NORMAL" as const }),
    ]),
  });
}
