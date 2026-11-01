import React from "react";
import { ScrollView, StyleSheet, Text, View, type ScrollViewProps } from "react-native";
import { useTheme } from "./ThemeProvider";
import { visualSystem } from "./visualSystem";
import { readableFont } from "./designSystem";
import { MotionReveal } from "./components";
import { AiShell } from "./aiKit";
import { plainScreenChip } from "./stageTraceModel";

export function ScreenFrame({ children, testID, refreshControl }: Readonly<{
  children: React.ReactNode;
  testID: string;
  refreshControl?: ScrollViewProps["refreshControl"];
}>) {
  const { theme } = useTheme();
  const ui = visualSystem(theme);
  return <AiShell chip={plainScreenChip("MORE")}><ScrollView
    style={{ backgroundColor: "transparent" }}
    contentContainerStyle={[styles.screen, { paddingHorizontal: ui.space.screenX, gap: ui.space.section }]}
    refreshControl={refreshControl}
    testID={testID}
  >{React.Children.toArray(children).map((child, index) => <MotionReveal key={React.isValidElement(child) && child.key != null ? child.key : index} index={index}>{child}</MotionReveal>)}</ScrollView></AiShell>;
}

export function ScreenTitle({ title, detail }: Readonly<{ title: string; detail?: string }>) {
  const { theme } = useTheme();
  const ui = visualSystem(theme);
  return <View style={styles.titleBlock}>
    <Text style={[styles.title, { color: ui.color.text }]}>{title}</Text>
    {detail ? <Text style={[styles.detail, { color: ui.color.textMuted }]}>{detail}</Text> : null}
  </View>;
}

export function Surface({ children, testID }: Readonly<{ children: React.ReactNode; testID?: string }>) {
  const { theme } = useTheme();
  const ui = visualSystem(theme);
  return <View testID={testID} style={[styles.surface, {
    backgroundColor: ui.color.panel,
    borderColor: ui.color.border,
    borderRadius: ui.radius.card,
    padding: ui.space.card,
  }]}>{children}</View>;
}

const styles = StyleSheet.create({
  screen: { paddingTop: 16, paddingBottom: 120 },
  titleBlock: { gap: 3 },
  title: { fontSize: 30, lineHeight: 38, fontWeight: "700", letterSpacing: -0.6 },
  detail: { fontSize: readableFont(11), lineHeight: 17 },
  surface: { borderWidth: 1 },
});
