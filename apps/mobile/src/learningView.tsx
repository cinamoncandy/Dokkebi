import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { PaperShadowMonitorView } from "./paperShadowMonitorView";
import { buildLearningScreen, splitHeroLines } from "./learningScreenModel";
import { buildLearningFunnel } from "./learningFunnelModel";
import { LearningFunnel } from "./learningFunnel";
import { AiShell } from "./aiKit";
import { plainScreenChip } from "./stageTraceModel";
import { InstrumentHero, PressScale, Reveal, SectionLabel, useReducedMotion } from "./instrumentKit";
import { CalmRow } from "./uiKit";
import { calmColors, calmToneColor } from "./uiKitModel";
import { readableFont } from "./designSystem";
import { CostWaterfall, NullComparison, OverfitGate, PaperResultBars, StudyTimeline } from "./learningPanels";

type Props = React.ComponentProps<typeof PaperShadowMonitorView> & { /** Server heartbeat learningFunnel (display only); null when stale or absent. */ readonly learningFunnel?: unknown; /** Server heartbeat learningLoop (display only): measured numbers for the panels; null when absent. */ readonly learningLoop?: unknown; /** Server heartbeat orderBookStudy (display only): the pre-registered study result; null when absent. */ readonly orderBookStudy?: unknown };

/**
 * "학습" — calm redesign of the PAPER tab. The summary is new; the full read-only monitors
 * (운영/학습/재현/실계좌) stay available behind "자세히 보기" so no evidence is removed.
 */
export function LearningView(props: Props) {
  const [details, setDetails] = useState(false);
  const reduced = useReducedMotion();
  const { learningFunnel, learningLoop, orderBookStudy, ...monitorProps } = props;
  const model = buildLearningScreen(props.paper);
  const funnel = buildLearningFunnel(learningFunnel);
  if (details) return <AiShell chip={plainScreenChip("LEARN")}><View style={styles.screen}>
    <Pressable accessibilityRole="button" onPress={() => setDetails(false)} style={styles.back} testID="learning-summary-back"><Text style={styles.backText}>‹ 학습 요약</Text></Pressable>
    <PaperShadowMonitorView {...monitorProps} embedded />
  </View></AiShell>;
  return <AiShell chip={plainScreenChip("LEARN")}><ScrollView style={styles.screen} contentContainerStyle={styles.content} testID="learning-view">
    {funnel ? <LearningFunnel model={funnel} /> : <>
      <InstrumentHero index="02 / 학습" lines={splitHeroLines(model.headline).map((text) => ({ text, color: calmToneColor(model.tone) }))} label={model.headline} />
      {model.sub ? <Reveal index={1} reducedMotion={reduced}><Text style={styles.sub}>{model.sub}</Text></Reveal> : null}
    </>}
    <PressScale accessibilityRole="button" onPress={() => setDetails(true)} style={styles.fold} testID="learning-details">
      <Text style={styles.foldText}>자세히 보기 (운영 · 학습 · 재현 · 실계좌)</Text><Text style={styles.foldText}>›</Text>
    </PressScale>
    <View style={styles.labelWrap}><SectionLabel left="루프 · 모의투자" right={`${model.steps.filter((x) => x.state === "DONE").length} / ${model.steps.length}`} /></View>
    <View style={styles.track} accessibilityLabel={model.steps.map((s) => `${s.label} ${s.state === "DONE" ? "확인" : s.state === "BLOCKED" ? "막힘" : "없음"}`).join(", ")}>
      {model.steps.map((step) => <View key={step.label} style={styles.step}>
        <View style={[styles.node, step.state === "DONE" ? styles.done : step.state === "BLOCKED" ? styles.blocked : null]} />
        <Text style={styles.stepLabel}>{step.label}</Text>
      </View>)}
    </View>
    {model.narrowest ? <Text style={styles.narrow}>{model.narrowest}</Text> : null}
    {model.rows.length === 0 ? null : <View style={styles.labelWrap}><SectionLabel left="성과 · 모의투자" right={`${model.rows.length}`} /></View>}
    <View style={styles.list}>{model.rows.map((row, i) => <Reveal key={row.label} index={2 + i} reducedMotion={reduced}><CalmRow label={row.label} value={row.value} tone={row.tone} /></Reveal>)}</View>
    <CostWaterfall raw={learningLoop} />
    <NullComparison raw={learningLoop} />
    <PaperResultBars raw={learningLoop} />
    <OverfitGate raw={learningLoop} />
    <StudyTimeline nowMs={Date.now()} orderBookStudy={orderBookStudy} />
  </ScrollView></AiShell>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "transparent" },
  content: { paddingBottom: 40, width: "100%", maxWidth: 720, alignSelf: "center" },
  sub: { color: calmColors.muted, fontSize: readableFont(14), lineHeight: 21, paddingHorizontal: 20, marginTop: 10, marginBottom: 8 },
  labelWrap: { paddingHorizontal: 20, marginTop: 10 },
  track: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 14 },
  step: { alignItems: "center", gap: 6, flex: 1 },
  node: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: calmColors.muted },
  done: { backgroundColor: calmColors.text, borderColor: calmColors.text },
  blocked: { borderColor: calmColors.attention },
  stepLabel: { color: calmColors.muted, fontSize: readableFont(12) },
  narrow: { color: calmColors.attention, fontSize: readableFont(14), lineHeight: 21, marginHorizontal: 20, marginBottom: 6 },
  list: { paddingHorizontal: 20 },
  fold: { marginHorizontal: 20, marginTop: 8, minHeight: 52, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: calmColors.line },
  foldText: { color: calmColors.text, fontSize: readableFont(14) },
  back: { minHeight: 44, justifyContent: "center", paddingHorizontal: 16, backgroundColor: "transparent" },
  backText: { color: calmColors.muted, fontSize: readableFont(14) },
});
