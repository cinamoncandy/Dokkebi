import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Canvas, Group, LinearGradient, Path, RadialGradient, Rect, Skia, vec } from "@shopify/react-native-skia";
import { aiIslandMotion, aiIslandPalette, readableFont } from "./designSystem";
import { fieldFonts } from "./fieldFonts";
import { calmColors } from "./uiKitModel";
import { AiShellContext } from "./aiShellContext";
import { ForceDarkTheme } from "./ThemeProvider";
import { useReducedMotion } from "./instrumentKit";
import type { AiChip, TraceStep } from "./stageTraceModel";

/**
 * AI island kit (owner-chosen 2026-10-29): the backdrop, frosted glass panels, the status chip and the stage trace that every screen
 * shares, so the whole app moves and looks like the island on "지금". Presentation only: each part shows what it is given and invents
 * nothing. All motion uses aiIslandMotion and stops under the OS reduce-motion setting (or before the OS answers).
 */
export const aiEase = Easing.bezier(...aiIslandMotion.curve);

const GRID_STEP = 34;

/** The deep navy ground with a soft glow at the top and a faint coordinate grid that fades out towards the edges. */
export function AiBackdrop({ width, height }: { readonly width: number; readonly height: number }) {
  const grid = useMemo(() => {
    const p = Skia.Path.Make();
    for (let x = GRID_STEP; x < width; x += GRID_STEP) { p.moveTo(x, 0); p.lineTo(x, height); }
    for (let y = GRID_STEP; y < height; y += GRID_STEP) { p.moveTo(0, y); p.lineTo(width, y); }
    return p;
  }, [width, height]);
  if (width <= 0 || height <= 0) return null;
  return <Canvas style={[StyleSheet.absoluteFill, { width, height }]} pointerEvents="none">
    <Rect x={0} y={0} width={width} height={height} color={aiIslandPalette.ground} />
    <Rect x={0} y={0} width={width} height={height}>
      <RadialGradient c={vec(width / 2, 0)} r={Math.max(width, height * 0.6)} colors={[aiIslandPalette.groundGlow, "transparent"]} />
    </Rect>
    {/* layer: the dstIn mask must apply to the grid alone, not to the ground and glow drawn before it. */}
    <Group layer>
      <Path path={grid} style="stroke" strokeWidth={1} color={aiIslandPalette.grid} />
      <Rect x={0} y={0} width={width} height={height} blendMode="dstIn">
        <RadialGradient c={vec(width / 2, height * 0.32)} r={width * 0.8} colors={["black", "transparent"]} />
      </Rect>
    </Group>
  </Canvas>;
}

/** Fades in and rises by aiIslandMotion.riseDistance, staggered by index. Shown at once under reduce-motion. */
export function AiRise({ index = 0, reducedMotion, style, children, testID }: { readonly index?: number; readonly reducedMotion: boolean | null; readonly style?: StyleProp<ViewStyle>; readonly children: React.ReactNode; readonly testID?: string }) {
  const v = useRef(new Animated.Value(reducedMotion === false ? 0 : 1)).current;
  useEffect(() => {
    if (reducedMotion !== false) { v.setValue(1); return undefined; }
    const anim = Animated.timing(v, { toValue: 1, duration: aiIslandMotion.transitionMs * 2, delay: Math.min(index, 6) * aiIslandMotion.staggerMs, easing: aiEase, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [reducedMotion, index, v]);
  const translateY = v.interpolate({ inputRange: [0, 1], outputRange: [aiIslandMotion.riseDistance, 0] });
  return <Animated.View testID={testID} style={[style, { opacity: v, transform: [{ translateY }] }]}>{children}</Animated.View>;
}

/** A frosted glass panel: a faint fill, a hairline edge, rounded corners. */
export function GlassPanel({ children, style, strong = false, testID }: { readonly children: React.ReactNode; readonly style?: StyleProp<ViewStyle>; readonly strong?: boolean; readonly testID?: string }) {
  return <View testID={testID} style={[styles.glass, strong && styles.glassStrong, style]}>{children}</View>;
}

/** The small mono label inside a panel, with an optional right-hand value. */
export function PanelLabel({ left, right = null, rightColor }: { readonly left: string; readonly right?: string | null; readonly rightColor?: string }) {
  return <View style={styles.panelLabel}>
    <Text style={[fieldFonts.mono, styles.panelLabelText]} numberOfLines={1}>{left}</Text>
    {right == null ? null : <Text style={[fieldFonts.mono, styles.panelLabelText, rightColor ? { color: rightColor } : null]}>{right}</Text>}
  </View>;
}

/** The status chip at the top: a breathing dot and a short label. `live` false shows it grey and still. */
export function AiStatusChip({ text, live, reducedMotion, testID = "ai-status-chip" }: { readonly text: string; readonly live: boolean; readonly reducedMotion: boolean | null; readonly testID?: string }) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!live || reducedMotion !== false) { v.setValue(1); return undefined; }
    const half = aiIslandMotion.breathMs / 2;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 0.3, duration: half, easing: aiEase, useNativeDriver: true }),
      Animated.timing(v, { toValue: 1, duration: half, easing: aiEase, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [live, reducedMotion, v]);
  const color = live ? aiIslandPalette.accentEnd : aiIslandPalette.label;
  return <View testID={testID} style={[styles.chip, live ? styles.chipLive : styles.chipIdle]} accessible accessibilityLabel={text}>
    <Animated.View style={[styles.chipDot, { backgroundColor: color, opacity: v, transform: [{ scale: v.interpolate({ inputRange: [0.3, 1], outputRange: [0.6, 1] }) }] }]} />
    <Text style={[fieldFonts.mono, styles.chipText, { color }]} numberOfLines={1}>{text}</Text>
  </View>;
}

/** 시세 → 판단 → 주문 → 체결: passed stages joined by the accent line, the broken one lit, the rest faint. */
export function StageTrace({ steps, testID = "stage-trace" }: { readonly steps: readonly TraceStep[]; readonly testID?: string }) {
  return <View style={styles.trace} testID={testID} importantForAccessibility="no-hide-descendants">
    {steps.map((s, i) => <React.Fragment key={s.id}>
      <Text style={[fieldFonts.mono, styles.traceLabel, s.state === "BROKEN" ? styles.traceBroken : s.state === "AHEAD" ? styles.traceAhead : null]}>{s.label}</Text>
      {i === steps.length - 1 ? null : <View style={[styles.traceLine, s.state !== "PASSED" && styles.traceLineIdle]}>
        {s.state === "PASSED" ? <Canvas style={StyleSheet.absoluteFill}><Rect x={0} y={0} width={64} height={3}><LinearGradient start={vec(0, 0)} end={vec(32, 0)} colors={[aiIslandPalette.accentStart, aiIslandPalette.accentEnd]} /></Rect></Canvas> : null}
      </View>}
    </React.Fragment>)}
  </View>;
}

/**
 * The common frame of every tab screen: the navy backdrop, a fixed top bar with the status chip, and the screen below it. The NUSA
 * name and island mark live in the app header (and on 지금), so the shell does not draw them again.
 * Scroll views placed inside must use a transparent background so the backdrop shows through.
 */
export function AiShell({ chip, children, testID }: { readonly chip: AiChip; readonly children: React.ReactNode; readonly testID?: string }) {
  const reduced = useReducedMotion();
  const [size, setSize] = useState({ width: 0, height: 0 });
  return <View testID={testID} style={styles.shell} onLayout={(e) => setSize({ width: Math.round(e.nativeEvent.layout.width), height: Math.round(e.nativeEvent.layout.height) })}>
    <AiBackdrop width={size.width} height={size.height} />
    <View style={styles.topBar}>
      <AiStatusChip text={chip.text} live={chip.live} reducedMotion={reduced} />
    </View>
    <View style={styles.shellBody}><AiShellContext.Provider value><ForceDarkTheme>{children}</ForceDarkTheme></AiShellContext.Provider></View>
  </View>;
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: aiIslandPalette.ground },
  shellBody: { flex: 1 },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6 },
  glass: { backgroundColor: aiIslandPalette.glass, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: aiIslandPalette.glassEdge, paddingHorizontal: 16, paddingVertical: 14 },
  glassStrong: { backgroundColor: aiIslandPalette.glassStrong },
  panelLabel: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  panelLabelText: { color: aiIslandPalette.label, fontSize: readableFont(11), letterSpacing: 1 },
  chip: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  chipLive: { backgroundColor: aiIslandPalette.chipFill, borderColor: aiIslandPalette.chipEdge },
  chipIdle: { backgroundColor: aiIslandPalette.idleFill, borderColor: aiIslandPalette.idleEdge },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { fontSize: readableFont(11), letterSpacing: 0.6 },
  trace: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  traceLabel: { color: aiIslandPalette.accentStart, fontSize: readableFont(11) },
  traceBroken: { color: calmColors.text, fontWeight: "700" },
  traceAhead: { color: aiIslandPalette.label, opacity: 0.6 },
  traceLine: { width: 28, height: 3, borderRadius: 2, overflow: "hidden" },
  traceLineIdle: { backgroundColor: aiIslandPalette.traceIdle },
});
