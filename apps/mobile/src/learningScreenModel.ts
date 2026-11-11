import type { PaperLearningScreenState } from "./paperLearningScreen";
import { calmDeltaTone, type CalmTone } from "./uiKitModel";

/**
 * "학습" screen model for the calm redesign: one sentence on where the PAPER loop is, the loop as a
 * short track built only from stages the server actually reported, and the measured results.
 * Missing data is "—" or "받지 못함", never zero or success.
 */
export type LoopStepState = "DONE" | "BLOCKED" | "NONE";
export interface LoopStep { readonly label: string; readonly state: LoopStepState }
export interface LearningRow { readonly label: string; readonly value: string; readonly tone: CalmTone }
export interface LearningScreenModel {
  readonly tone: CalmTone;
  readonly headline: string;
  readonly sub: string;
  readonly steps: readonly LoopStep[];
  readonly narrowest: string | null;
  readonly rows: readonly LearningRow[];
}

const money = (value: number): string => `${value < 0 ? "−" : value > 0 ? "+" : ""}₩${Math.round(Math.abs(value)).toLocaleString("ko-KR")}`;

export function buildLearningScreen(state: PaperLearningScreenState): LearningScreenModel {
  const connected = state.dataSource !== "NOT_CONFIGURED" && state.dataSource !== "UNAVAILABLE" && state.dataSource !== "PROJECTION_ABSENT";
  const riskBlocked = state.latestRisk?.status === "FAIL";
  const steps: LoopStep[] = [
    { label: "관찰", state: state.latestMarket != null ? "DONE" : "NONE" },
    { label: "신호", state: state.latestSignal != null ? "DONE" : "NONE" },
    { label: "판단", state: state.latestDecision != null ? "DONE" : "NONE" },
    { label: "안전", state: state.latestRisk == null ? "NONE" : riskBlocked ? "BLOCKED" : "DONE" },
    { label: "체결", state: state.latestFill != null ? "DONE" : "NONE" },
    { label: "평가", state: state.latestEvidence?.outcome != null ? "DONE" : "NONE" },
  ];
  const tone: CalmTone = !connected ? "ATTENTION" : state.status === "HALTED" || state.status === "ERROR" ? "LOSS" : state.status === "PAUSED" || riskBlocked ? "ATTENTION" : "NORMAL";
  const headline = !connected ? "학습 정보를 받지 못했어요"
    : state.status === "HALTED" ? "학습이 멈춰 있어요"
    : state.status === "ERROR" ? "학습에 오류가 있어요"
    : state.status === "PAUSED" ? "학습이 잠시 쉬고 있어요"
    : "모의투자로 배우는 중이에요";
  const sub = !connected ? "빈 값은 결과가 없다는 뜻이 아니에요"
    : state.halt != null ? "멈춘 이유는 아래 자세히 보기에 있어요"
    : state.latestEvidence?.outcome == null ? "아직 평가 결론은 없어요" : "최근 평가 결론이 있어요";
  const narrowest = riskBlocked ? `가장 좁아지는 곳: 안전 (${state.latestRisk!.reason})` : null;
  const p = state.performance;
  const rows: LearningRow[] = connected ? [
    { label: "실현 손익", value: money(p.realizedPnL), tone: calmDeltaTone(p.realizedPnL) },
    { label: "수수료", value: `₩${Math.round(p.fees).toLocaleString("ko-KR")}`, tone: "NORMAL" },
    { label: "체결된 사이클", value: `${p.filledCycles} / ${p.completedCycles}`, tone: "NORMAL" },
    { label: "승률", value: p.winRate == null ? "—" : `${Math.round(p.winRate * 100)}%`, tone: "NORMAL" },
    { label: "최대 낙폭", value: `${(p.maxDrawdown * 100).toFixed(1)}%`, tone: p.maxDrawdown > 0 ? "LOSS" : "MUTED" },
  ] : [];
  return Object.freeze({ tone, headline, sub, steps: Object.freeze(steps), narrowest, rows: Object.freeze(rows) });
}

/**
 * Splits a long Korean hero sentence at the space nearest its middle so Android never breaks a word mid-syllable
 * (it wrapped "배우는" as "배우 / 는"). Short text stays on one line. The words are unchanged; only the line split differs.
 */
export function splitHeroLines(text: string): readonly string[] {
  const letters = Array.from(text).filter((ch) => !/\s/.test(ch)).length;
  if (letters <= 6) return Object.freeze([text]);
  const chars = Array.from(text);
  const half = letters / 2;
  let seen = 0;
  let best = -1;
  let bestGap = Number.POSITIVE_INFINITY;
  chars.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      const gap = Math.abs(seen - half);
      if (seen > 0 && seen < letters && gap < bestGap) { best = i; bestGap = gap; }
    } else seen += 1;
  });
  if (best < 0) return Object.freeze([text]);
  return Object.freeze([chars.slice(0, best).join("").trim(), chars.slice(best + 1).join("").trim()].filter((line) => line !== ""));
}

/** The hero type as designed: 54 px with -2 px tracking. */
export const HERO_FONT_SIZE = 54;
const HERO_MIN_FONT_SIZE = 36;

/**
 * One font size for every hero line so the widest line fits the given width on one line (a 7-glyph Korean line at 54 px is
 * wider than a 390 px phone and used to drop its last syllable onto a line of its own). Never grows above the designed size
 * and never shrinks below 36 px; below that the line may wrap. Widths are estimated: a full-width glyph is 1 em, an ASCII
 * glyph 0.62 em, a space 0.3 em, each with the designed tracking (-2 px at 54 px, scaled).
 */
export function heroFontSize(lines: readonly string[], availableWidth: number): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return HERO_FONT_SIZE;
  let widestEm = 0;
  for (const line of lines) {
    let em = 0;
    for (const ch of Array.from(line)) em += (/\s/.test(ch) ? 0.3 : ch.charCodeAt(0) < 0x80 && ch.length === 1 ? 0.62 : 1) - 2 / HERO_FONT_SIZE;
    if (em > widestEm) widestEm = em;
  }
  if (widestEm <= 0) return HERO_FONT_SIZE;
  return Math.max(HERO_MIN_FONT_SIZE, Math.min(HERO_FONT_SIZE, Math.floor(availableWidth / widestEm)));
}
