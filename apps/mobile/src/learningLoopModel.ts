/**
 * Real learning-loop numbers for the 학습 tab. The server copies measured integers from the closed-learning status
 * (PersonalPaperLearningLoop); this file turns them into drawable rows. Nothing is invented: a value that is missing, not an
 * integer, out of range or inconsistent with its partner is dropped and its panel says the server has not sent it.
 */
export interface WaterfallRow {
  readonly label: string;
  /** Basis points per trade, signed. */
  readonly bp: number;
  readonly kind: "GAIN" | "LOSS" | "COST" | "RESULT";
}

export interface CostWallPanel {
  readonly rows: readonly WaterfallRow[];
  readonly trades: number;
  readonly winRatePercent: number | null;
  /** Largest absolute value, for scaling the bars. */
  readonly scaleBp: number;
  readonly summary: string;
}

export interface PaperResultPanel {
  readonly periods: number | null;
  readonly netBp: number | null;
  readonly excessBp: number | null;
  readonly scaleBp: number;
  readonly summary: string;
}

export interface OverfitPanel {
  readonly discoveryPasses: number;
  readonly holdoutPasses: number;
  readonly configurations: number | null;
  readonly experiments: number | null;
  readonly overfitRatePercent: number | null;
  readonly summary: string;
}

/** One null comparator next to the baseline shadow: the difference (baseline minus the null) in basis points, or "no data" with the reason. */
export interface NullComparisonRow {
  readonly label: string;
  /** Baseline minus the null, signed basis points; null when it cannot be measured (never a zero stand-in). */
  readonly diffBp: number | null;
  readonly detail: string;
}

/** Comparison with rules that have no signal. A comparison on the same bars and fee model, NOT PAPER evidence and never a promotion input. */
export interface NullComparisonPanel {
  readonly rows: readonly NullComparisonRow[];
  readonly scaleBp: number;
  readonly summary: string;
}

export interface LearningLoopPanels {
  readonly cost: CostWallPanel | null;
  readonly paper: PaperResultPanel | null;
  readonly overfit: OverfitPanel | null;
  readonly comparison: NullComparisonPanel | null;
}

const nonNeg = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const signed = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && Math.abs(v) <= 10_000_000 ? v : null);
const one = (n: number): string => n.toFixed(1);
const sign = (n: number): string => (n > 0 ? `+${one(n)}` : one(n));

export function buildLearningLoopPanels(raw: unknown): LearningLoopPanels {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return Object.freeze({ cost: null, paper: null, overfit: null, comparison: null });
  const r = raw as Record<string, unknown>;

  let cost: CostWallPanel | null = null;
  const trades = nonNeg(r.shadowTrades); const wins = nonNeg(r.shadowWins); const gain = nonNeg(r.shadowGrossGainBp); const loss = nonNeg(r.shadowGrossLossBp); const fee = nonNeg(r.shadowFeeBp);
  if (trades != null && trades > 0 && gain != null && loss != null && fee != null && (wins == null || wins <= trades)) {
    const perGain = gain / trades; const perLoss = loss / trades; const perFee = fee / trades;
    const result = perGain - perLoss - perFee;
    const scale = Math.max(perGain, perLoss, perFee, Math.abs(result), 1);
    const gross = perGain - perLoss;
    cost = Object.freeze({
      trades, winRatePercent: wins == null ? null : (wins / trades) * 100, scaleBp: scale,
      rows: Object.freeze([
        Object.freeze({ label: "거래당 이익 기여", bp: perGain, kind: "GAIN" as const }),
        Object.freeze({ label: "거래당 손실 기여", bp: -perLoss, kind: "LOSS" as const }),
        Object.freeze({ label: "수수료", bp: -perFee, kind: "COST" as const }),
        Object.freeze({ label: "거래당 순결과", bp: result, kind: "RESULT" as const }),
      ]),
      summary: gross <= 0 ? `수수료를 빼기 전에도 거래당 ${sign(gross)}bp예요. 수수료까지 내면 ${sign(result)}bp예요.` : `수수료 전 거래당 ${sign(gross)}bp, 수수료 ${one(perFee)}bp를 내면 ${sign(result)}bp예요.`,
    });
  }

  let paper: PaperResultPanel | null = null;
  const net = signed(r.paperNetBp); const excess = signed(r.paperExcessBp); const periods = nonNeg(r.paperPeriodsConsumed);
  if (net != null || excess != null) {
    const scale = Math.max(Math.abs(net ?? 0), Math.abs(excess ?? 0), 1);
    const parts: string[] = [];
    if (net != null) parts.push(`모의투자 순결과 ${net > 0 ? "+" : ""}${net}bp`);
    if (excess != null) parts.push(`전부 사기 대비 ${excess > 0 ? "+" : ""}${excess}bp`);
    paper = Object.freeze({ periods, netBp: net, excessBp: excess, scaleBp: scale, summary: `${periods != null ? `${periods}구간 동안 ` : ""}${parts.join(", ")}예요.` });
  }

  let overfit: OverfitPanel | null = null;
  const disc = nonNeg(r.discoveryPasses); const hold = nonNeg(r.holdoutPasses); const cfg = nonNeg(r.configurations); const exp = nonNeg(r.experiments);
  const rate = nonNeg(r.overfitRatePercent);
  if (disc != null && hold != null && hold <= disc && (cfg == null || disc <= cfg) && (rate == null || rate <= 100)) {
    overfit = Object.freeze({
      discoveryPasses: disc, holdoutPasses: hold, configurations: cfg, experiments: exp, overfitRatePercent: rate,
      summary: disc === 0 ? "1차를 통과한 전략이 아직 없어요." : hold === 0 ? `1차를 통과한 ${disc}개가 모두 새 데이터에서 탈락했어요.` : `1차 통과 ${disc}개 중 ${hold}개가 새 데이터에서도 통과했어요.`,
    });
  }
  return Object.freeze({ cost, paper, overfit, comparison: buildNullComparison(r) });
}

const NO_DATA = "데이터 없음";

function buildNullComparison(r: Record<string, unknown>): NullComparisonPanel | null {
  const since = nonNeg(r.nullSince);
  if (since == null || since === 0) return null;
  const baseTrades = nonNeg(r.nullBaseTrades); const baseNet = signed(r.nullBaseNetBp);
  const holdMarkets = nonNeg(r.nullHoldMarkets); const holdNet = signed(r.nullHoldNetBp);
  const randTrades = nonNeg(r.nullRandTrades); const randNet = signed(r.nullRandNetBp); const randWins = nonNeg(r.nullRandWins); const skipped = nonNeg(r.nullRandSkipped);
  const baseReady = baseTrades != null && baseTrades > 0 && baseNet != null;
  const verdict = (diff: number): string => (diff > 0 ? `기준 규칙이 ${diff}bp 더 벌었어요` : diff < 0 ? `기준 규칙이 ${-diff}bp 덜 벌었어요` : "기준 규칙과 차이가 없어요");

  const hold: NullComparisonRow = !baseReady
    ? { label: "계속 들고 있기와의 차이", diffBp: null, detail: `${NO_DATA}: 기준 규칙이 아직 거래를 끝내지 않았어요.` }
    : holdMarkets == null || holdMarkets === 0 || holdNet == null
      ? { label: "계속 들고 있기와의 차이", diffBp: null, detail: `${NO_DATA}: 분봉이 아직 부족해요.` }
      : { label: "계속 들고 있기와의 차이", diffBp: baseNet - holdNet, detail: `${verdict(baseNet - holdNet)}. 시장 ${holdMarkets}곳을 처음부터 끝까지 들고 있었을 때와 비교했어요.` };

  // Only a like-for-like count is compared: the random entry must have made the same number of round trips as the baseline.
  const random: NullComparisonRow = !baseReady
    ? { label: "무작위로 사고판 것과의 차이", diffBp: null, detail: `${NO_DATA}: 기준 규칙이 아직 거래를 끝내지 않았어요.` }
    : randTrades == null || randNet == null || randTrades === 0
      ? { label: "무작위로 사고판 것과의 차이", diffBp: null, detail: `${NO_DATA}: 무작위 거래가 아직 없어요.${skipped != null && skipped > 0 ? ` 지난 분봉이 모자라 ${skipped}건을 건너뛰었어요.` : ""}` }
      : randTrades !== baseTrades
        ? { label: "무작위로 사고판 것과의 차이", diffBp: null, detail: `${NO_DATA}: 거래 수가 아직 달라요 (기준 ${baseTrades}건, 무작위 ${randTrades}건).${skipped != null && skipped > 0 ? ` 지난 분봉이 모자라 ${skipped}건을 건너뛰었어요.` : ""}` }
        : { label: "무작위로 사고판 것과의 차이", diffBp: baseNet - randNet, detail: `${verdict(baseNet - randNet)}. 같은 ${baseTrades}번, 같은 보유 시간으로 무작위 시점에 사고팔았을 때와 비교했어요.${randWins == null ? "" : ` 무작위 쪽 이긴 거래는 ${randWins}건이에요.`}` };

  const rows = Object.freeze([Object.freeze(hold), Object.freeze(random)]);
  const scale = Math.max(1, ...rows.map((row) => Math.abs(row.diffBp ?? 0)));
  const measured = rows.filter((row) => row.diffBp != null).length;
  return Object.freeze({
    rows, scaleBp: scale,
    summary: measured === 0 ? "아직 비교할 만큼 데이터가 쌓이지 않았어요. 0으로 채우지 않고 비워 둬요." : "같은 분봉과 같은 수수료(한쪽 0.05%)로 계산한 비교예요. 모의투자 증거가 아니고 승격에도 쓰이지 않아요.",
  });
}
