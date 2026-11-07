import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { SectionLabel } from "./instrumentKit";
import { IslandMark } from "./islandMark";
import { calmColors, calmToneColor } from "./uiKitModel";
import { readableFont } from "./designSystem";
import { buildStudyTimeline } from "./learningPanelsModel";
import { buildLearningLoopPanels } from "./learningLoopModel";

const fmt = (n: number): string => (n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1));
const rowColor = (kind: "GAIN" | "LOSS" | "COST" | "RESULT", bp: number): string =>
  kind === "RESULT" ? (bp < 0 ? calmColors.attention : calmColors.text) : kind === "GAIN" ? calmColors.text : calmColors.muted;

/** Registered studies: a vertical line, one dot per study, the next verdict highlighted. Dates are the frozen designs' verdict times. */
export function StudyTimeline({ nowMs, orderBookStudy }: { readonly nowMs: number; /** Server heartbeat orderBookStudy (display only); untrusted, null when absent. */ readonly orderBookStudy?: unknown }) {
  const rows = buildStudyTimeline(nowMs, undefined, orderBookStudy);
  return <View style={styles.block} testID="learning-studies" accessibilityLabel={rows.map((r) => `${r.id} ${r.dateLabel} ${r.status}`).join(". ")}>
    <SectionLabel left="사전 등록 연구" right="사전 등록" />
    <View style={styles.tl}>
      <View style={styles.tlLine} />
      {rows.map((r) => <View key={r.id} style={styles.ev}>
        <View style={[styles.dot, r.next ? styles.dotNext : null]} />
        <Text style={styles.date}>{r.dateLabel}</Text>
        <Text style={styles.evName}>{r.name}</Text>
        <Text style={[styles.evStatus, { color: calmToneColor(r.tone) }]}>{r.status}</Text>
      </View>)}
    </View>
    <Text style={styles.note}>대부분의 연구가 실패할 가능성이 높아요. 실패도 그대로 기록해요.</Text>
  </View>;
}

/** One signed bar on a zero axis: positive to the right, negative to the left. */
function SignedBar({ bp, scaleBp, color }: { readonly bp: number; readonly scaleBp: number; readonly color: string }) {
  const half = Math.min(1, Math.abs(bp) / scaleBp) * 50;
  return <View style={styles.axis} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <View style={styles.zero} />
    <View style={[styles.signed, bp >= 0 ? { left: "50%", width: `${half}%` } : { right: "50%", width: `${half}%` }, { backgroundColor: color }]} />
  </View>;
}

/** The cost wall, measured: what an average shadow trade of the owner baseline gains, loses and pays in fees, and what is left. */
export function CostWaterfall({ raw }: { readonly raw: unknown }) {
  const { cost } = buildLearningLoopPanels(raw);
  if (cost == null) return <Missing title="그림자 거래 한 번의 손익" />;
  return <View style={styles.block} testID="learning-cost-waterfall" accessibilityLabel={`그림자 거래 한 번의 손익. 모의투자 주문이 아닌 기준 거래예요. 거래 ${cost.trades}건 기준. ${cost.rows.map((r) => `${r.label} ${fmt(r.bp)}bp`).join(", ")}. ${cost.summary}`}>
    <Deco />
    <SectionLabel left="그림자 거래 한 번의 손익" right={`${cost.trades.toLocaleString("en-US")}건 · bp`} />
    <View style={styles.rows}>
      {cost.rows.map((r) => <View key={r.label} style={styles.row}>
        <View style={styles.rowHead}>
          <Text style={[styles.rowLabel, r.kind === "RESULT" ? styles.rowLabelStrong : null]}>{r.label}</Text>
          <Text style={[styles.rowValue, { color: rowColor(r.kind, r.bp) }]}>{fmt(r.bp)}</Text>
        </View>
        <SignedBar bp={r.bp} scaleBp={cost.scaleBp} color={rowColor(r.kind, r.bp)} />
      </View>)}
    </View>
    <Text style={styles.note}>{cost.summary}{cost.winRatePercent == null ? "" : ` 이긴 비율은 ${cost.winRatePercent.toFixed(0)}%예요.`}</Text>
  </View>;
}

/** The baseline shadow next to two rules with no signal (hold, random entry): baseline minus each, or "no data" instead of a zero. Not PAPER evidence. */
export function NullComparison({ raw }: { readonly raw: unknown }) {
  const { comparison } = buildLearningLoopPanels(raw);
  if (comparison == null) return <Missing title="아무 규칙 없이 한 것과 비교" />;
  return <View style={styles.block} testID="learning-null-comparison" accessibilityLabel={`아무 규칙 없이 한 것과 비교. 모의투자 증거가 아니에요. ${comparison.rows.map((r) => `${r.label} ${r.diffBp == null ? "데이터 없음" : `${r.diffBp > 0 ? "+" : ""}${r.diffBp}bp`}. ${r.detail}`).join(" ")} ${comparison.summary}`}>
    <Deco />
    <SectionLabel left="아무 규칙 없이 한 것과 비교" right="모의투자 증거 아님 · bp" />
    <View style={styles.rows}>
      {comparison.rows.map((r) => <View key={r.label} style={styles.row}>
        <View style={styles.rowHead}>
          <Text style={styles.rowLabel}>{r.label}</Text>
          <Text style={[styles.rowValue, { color: r.diffBp == null ? calmColors.muted : r.diffBp < 0 ? calmColors.attention : calmColors.text }]}>{r.diffBp == null ? "데이터 없음" : r.diffBp > 0 ? `+${r.diffBp}` : `${r.diffBp}`}</Text>
        </View>
        {r.diffBp == null ? null : <SignedBar bp={r.diffBp} scaleBp={comparison.scaleBp} color={r.diffBp < 0 ? calmColors.attention : calmColors.text} />}
        <Text style={styles.note}>{r.detail}</Text>
      </View>)}
    </View>
    <Text style={styles.note}>{comparison.summary}</Text>
  </View>;
}

/** The owner baseline's PAPER result over the periods the learner consumed, and against buying everything. */
export function PaperResultBars({ raw }: { readonly raw: unknown }) {
  const { paper } = buildLearningLoopPanels(raw);
  if (paper == null) return <Missing title="모의투자 성과" />;
  const rows = [paper.netBp == null ? null : { label: "모의투자 순결과", bp: paper.netBp }, paper.excessBp == null ? null : { label: "전부 사기 대비", bp: paper.excessBp }].filter((x): x is { label: string; bp: number } => x != null);
  return <View style={styles.block} testID="learning-paper-result" accessibilityLabel={`모의투자 성과. ${paper.summary}`}>
    <Deco />
    <SectionLabel left="모의투자 성과" right={paper.periods == null ? "bp" : `${paper.periods}구간 · bp`} />
    <View style={styles.rows}>
      {rows.map((r) => <View key={r.label} style={styles.row}>
        <View style={styles.rowHead}><Text style={styles.rowLabel}>{r.label}</Text><Text style={[styles.rowValue, { color: r.bp < 0 ? calmColors.attention : calmColors.text }]}>{r.bp > 0 ? `+${r.bp}` : `${r.bp}`}</Text></View>
        <SignedBar bp={r.bp} scaleBp={paper.scaleBp} color={r.bp < 0 ? calmColors.attention : calmColors.text} />
      </View>)}
    </View>
    <Text style={styles.note}>{paper.summary}</Text>
  </View>;
}

/** First screen passes against the independent holdout: the number that survived new data. */
export function OverfitGate({ raw }: { readonly raw: unknown }) {
  const { overfit } = buildLearningLoopPanels(raw);
  if (overfit == null) return <Missing title="새 데이터에서의 결과" />;
  const total = Math.max(overfit.discoveryPasses, 1);
  return <View style={styles.block} testID="learning-overfit-gate" accessibilityLabel={`새 데이터에서의 결과. ${overfit.summary}`}>
    <Deco />
    <SectionLabel left="새 데이터에서의 결과" right={overfit.overfitRatePercent == null ? null : `탈락 ${overfit.overfitRatePercent}%`} />
    <View style={styles.gate} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.gatePassed, { flex: overfit.holdoutPasses / total }]} />
      {overfit.discoveryPasses > 0 ? <View style={[styles.gateLost, { flex: (total - overfit.holdoutPasses) / total }]} /> : null}
    </View>
    <View style={styles.gateLegend}>
      <Text style={styles.rowLabel}>1차 통과 {overfit.discoveryPasses}개</Text>
      <Text style={[styles.rowValue, { color: overfit.holdoutPasses === 0 ? calmColors.attention : calmColors.text }]}>독립 검증 합격 {overfit.holdoutPasses}개</Text>
    </View>
    <Text style={styles.note}>{overfit.summary} 기준은 낮추지 않아요.</Text>
  </View>;
}

/** A faint island mark at the top right of a learning card (owner-approved island design 2026-10-28). Decoration only. */
function Deco() {
  return <View style={styles.deco} pointerEvents="none" importantForAccessibility="no-hide-descendants"><IslandMark size={40} opacity={0.32} /></View>;
}

function Missing({ title }: { readonly title: string }) {
  return <View style={styles.block} accessibilityLabel={`${title}. 서버에서 아직 받지 못했어요`}>
    <Deco />
    <SectionLabel left={title} right={null} />
    <Text style={styles.note}>서버에서 아직 받지 못했어요. 값을 지어내지 않고 비워 둬요.</Text>
  </View>;
}

const styles = StyleSheet.create({
  block: { paddingHorizontal: 20, marginTop: 22, gap: 12 },
  deco: { position: "absolute", right: 16, top: -8 },
  note: { color: calmColors.muted, fontSize: readableFont(12), lineHeight: 18 },
  tl: { paddingLeft: 26, gap: 20, marginTop: 6 },
  tlLine: { position: "absolute", left: 5, top: 8, bottom: 8, width: StyleSheet.hairlineWidth, backgroundColor: calmColors.line },
  ev: { gap: 2 },
  dot: { position: "absolute", left: -26, top: 9, width: 11, height: 11, borderRadius: 6, borderWidth: 1.5, borderColor: calmColors.muted, backgroundColor: calmColors.ground },
  dotNext: { borderColor: calmColors.order, backgroundColor: calmColors.order },
  date: { color: calmColors.text, fontSize: 34, fontWeight: "500", letterSpacing: -0.5, fontVariant: ["tabular-nums"] },
  evName: { color: calmColors.text, fontSize: readableFont(14), fontWeight: "500" },
  evStatus: { fontSize: readableFont(12) },
  rows: { gap: 14 },
  row: { gap: 6 },
  rowHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 10 },
  rowLabel: { color: calmColors.muted, fontSize: readableFont(13) },
  rowLabelStrong: { color: calmColors.text },
  rowValue: { fontSize: readableFont(15), fontWeight: "500", fontVariant: ["tabular-nums"] },
  axis: { height: 10, justifyContent: "center" },
  zero: { position: "absolute", left: "50%", top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: calmColors.muted },
  signed: { position: "absolute", top: 2, height: 6, borderRadius: 1 },
  gate: { flexDirection: "row", height: 10, borderRadius: 2, overflow: "hidden", backgroundColor: calmColors.line },
  gatePassed: { backgroundColor: calmColors.order },
  gateLost: { backgroundColor: calmColors.attention, opacity: 0.55 },
  gateLegend: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
});
