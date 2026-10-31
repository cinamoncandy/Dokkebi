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
    stages: Object.freeze([
      Object.freeze({ label: "시험한 전략", value: tested, width: 1, tone: "NORMAL" as const }),
      Object.freeze({ label: "1차 통과", value: discovered, width: width(discovered), tone: "NORMAL" as const }),
      Object.freeze({ label: "독립 검증 합격", value: passed, width: width(passed), tone: passed === 0 ? "ATTENTION" as const : "NORMAL" as const }),
    ]),
  });
}
