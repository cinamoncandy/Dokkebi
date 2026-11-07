import React, { useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { LiveReadinessMonitorViewProps } from "./liveReadinessMonitorView";
import { buildLiveGates } from "./liveGateModel";
import { liveUnavailableMessage } from "./fieldScreensModel";
import { buildSafetyScreen } from "./safetyScreenModel";
import { GateDots } from "./gateDots";
import { SafetyCircuit } from "./safetyCircuit";
import { InstrumentHero, PressScale, Reveal, SectionLabel, useReducedMotion } from "./instrumentKit";
import { CalmRow } from "./uiKit";
import { calmColors } from "./uiKitModel";
import { readableFont } from "./designSystem";

/** "실거래" — spot-only LIVE tab; futures limits live on the 선물 tab. Read-only: it has no action that enables LIVE or mutates anything. */
export function SafetyView({ snapshot, unavailableReason, unavailableKind = "FAILED", refreshing, onRefresh }: LiveReadinessMonitorViewProps) {
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();
  const gates = buildLiveGates(snapshot);
  const model = buildSafetyScreen(gates, snapshot?.blockers ?? []);
  return <ScrollView style={styles.screen} contentContainerStyle={styles.content} refreshControl={<RefreshControl tintColor={calmColors.text} refreshing={refreshing} onRefresh={() => { void onRefresh(); }} />} testID="safety-view">
    <InstrumentHero index="03 / 실거래" lines={[{ text: "실제 돈은" }, { text: "안 움직여요" }]} />
    <SafetyCircuit />
    <View style={styles.list}>
      <SectionLabel left="현물 실거래 준비" right="읽기 전용" />
      {model.rows.filter((row) => row.label === "실거래" || row.label === "AI").map((row, i) => <Reveal key={row.label} index={i} reducedMotion={reduced}><CalmRow label={row.label} hint={row.hint} value={row.value} tone={row.tone} /></Reveal>)}
      {gates == null ? null : <GateDots gates={gates} reducedMotion={reduced} />}
      {snapshot == null ? <CalmRow label="실거래 준비 정보" hint={liveUnavailableMessage(unavailableKind)} value="받지 못함" tone="ATTENTION" /> : null}
    </View>
    <PressScale accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={styles.fold} testID="safety-advanced-toggle">
      <Text style={styles.foldText}>고급 진단 (영문 원문·코드)</Text><Text style={styles.foldText}>{open ? "접기" : "펼치기"}</Text>
    </PressScale>
    {open ? <View style={styles.advanced} testID="safety-advanced">
      {model.advanced.map((line) => <Text key={line} style={styles.code}>{line}</Text>)}
      {unavailableReason ? <Text style={styles.code}>reason: {unavailableReason}</Text> : null}
      <Text style={styles.code}>liveAuthority=NONE · productionMutationAllowed=false · AI=ZERO_AUTHORITY</Text>
    </View> : null}
    <Text style={styles.footer}>이 화면은 읽기만 해요. 실거래를 켜는 버튼은 없어요.</Text>
  </ScrollView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: calmColors.ground },
  content: { paddingBottom: 40, width: "100%", maxWidth: 720, alignSelf: "center" },
  list: { marginTop: 18, paddingHorizontal: 20 },
  section: { marginTop: 16 },
  fold: { marginHorizontal: 20, minHeight: 48, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: calmColors.line },
  foldText: { color: calmColors.muted, fontSize: readableFont(13) },
  advanced: { marginHorizontal: 20, gap: 6, paddingBottom: 8 },
  code: { color: calmColors.muted, fontSize: readableFont(12), fontFamily: "monospace" },
  footer: { color: calmColors.muted, fontSize: readableFont(12), paddingHorizontal: 20, marginTop: 20 },
});
