import { AiShell } from "./aiKit";
import { plainScreenChip } from "./stageTraceModel";
import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { DataRow, StatusChip } from "./components";
import { InlineNotice, ScreenHeader } from "./uxPrimitives";
import { useTheme } from "./ThemeProvider";
import type { SettingsRepository } from "./settings";
import { MobileNotificationCenter } from "./notificationCenter";
import { labelFont } from "./designSystem";

export function NotificationView(props: Readonly<{ repository: SettingsRepository }>) {
  return <AiShell chip={plainScreenChip("MORE")}><NotificationBody {...props} /></AiShell>;
}

function NotificationBody({ repository }: Readonly<{ repository: SettingsRepository }>) {
  const { theme } = useTheme();
  void repository;

  return <ScrollView style={{ backgroundColor: "transparent" }} contentContainerStyle={styles.content} testID="notifications-screen">
    <ScreenHeader eyebrow="기기 알림" title="알림" description="실제로 연결된 이벤트만 표시합니다." statusLabel="미연결" statusTone="neutral" />
    <View style={styles.emptyState} testID="notifications-empty-state">
      <Text style={[styles.emptyEyebrow, { color: theme.colors.textMuted }]}>알림 소스 없음</Text>
      <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>알림 이벤트 수집이 아직 연결되지 않았습니다</Text>
      <Text style={[styles.emptyCopy, { color: theme.colors.textMuted }]}>아직 표시할 알림이 없습니다. 실제 이벤트가 연결되기 전에는 목록을 만들지 않습니다.</Text>
      <Text style={[styles.emptyCopy, { color: theme.colors.textMuted }]}>실제 이벤트가 연결되기 전에는 알림 목록이나 동작하지 않는 알림 설정을 제공하지 않습니다.</Text>
      <View style={styles.statusRow}><StatusChip label="PAPER" tone="primary" testID="notifications-paper" /><StatusChip label="미연결" tone="neutral" testID="notifications-disconnected" /><StatusChip label="READ ONLY" tone="info" /><StatusChip label="푸시 꺼짐" tone="neutral" /></View>
      <View style={styles.runtimeRows}><DataRow label="운영 모드" value="PAPER" emphasis /><DataRow label="권한" value="읽기 전용" /><DataRow label="현재 상태" value="이벤트 수집 미연결" /></View>
    </View>
    <InlineNotice title="가짜 알림을 만들지 않습니다" detail="이벤트 소스가 연결되기 전에는 예시 거래·가격·AI 알림을 실제 데이터처럼 표시하지 않습니다." tone="info" />
  </ScrollView>;
}

const styles = StyleSheet.create({ content: { paddingHorizontal: 20, paddingTop: 20, gap: 20, paddingBottom: 40, width: "100%", maxWidth: 820, alignSelf: "center" }, emptyState: { paddingVertical: 26, gap: 10 }, emptyEyebrow: { fontSize: labelFont(10), lineHeight: 15, fontWeight: "500", letterSpacing: 1.2 }, emptyTitle: { fontSize: 27, lineHeight: 34, fontWeight: "500", letterSpacing: -0.8 }, emptyCopy: { maxWidth: 620, fontSize: 14, lineHeight: 22 }, statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 4 }, runtimeRows: { gap: 2, marginTop: 8 } });

export { MobileNotificationCenter };
