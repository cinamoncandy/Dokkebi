import React, { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, Text, useWindowDimensions, View, type PressableProps, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { Canvas, Path, Skia } from "@shopify/react-native-skia";
import { calmColors } from "./uiKitModel";
import { HERO_FONT_SIZE, heroFontSize } from "./learningScreenModel";
import { fieldFonts } from "./fieldFonts";
import { aiIslandMotion, readableFont } from "./designSystem";

/**
 * Instrument kit (redesign 2026-10-20, owner-chosen "계기판" direction): hairline panels with corner ticks, mono section labels,
 * a rolling odometer and a scrolling heartbeat trace. Presentation only. Every loop runs on the native driver and stops entirely
 * when the OS reduce-motion setting is on.
 */
/** null until the OS answers: nothing loops and no entrance plays before then, so a reduce-motion user never sees motion. */
export function useReducedMotion(): boolean | null {
  const [reduced, setReduced] = useState<boolean | null>(null);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (mounted) setReduced(v); }).catch(() => { if (mounted) setReduced(false); });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => { mounted = false; sub.remove(); };
  }, []);
  return reduced;
}

/** Mono section heading. The hairline under it draws in from the left; `live` puts a pulsing dot before the right-hand text. */
export function SectionLabel({ left, right = null, live = false }: { readonly left: string; readonly right?: string | null; readonly live?: boolean }) {
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const draw = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced === null) return undefined;
    if (reduced) { draw.setValue(1); return undefined; }
    const anim = Animated.timing(draw, { toValue: 1, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [reduced, draw]);
  // Scale about the left edge: scaleX around the centre plus a translateX that pins the left side.
  const lineStyle = { transform: [{ translateX: draw.interpolate({ inputRange: [0, 1], outputRange: [-width / 2, 0] }) }, { scaleX: draw }] };
  return <View style={styles.labelWrap} onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}>
    <View style={styles.label}>
      <Text style={styles.labelLeft} numberOfLines={2}>{left}</Text>
      <View style={styles.labelRightRow}>
        {live ? <LivePulse reducedMotion={reduced} /> : null}
        {right == null ? null : <Text style={styles.labelRight}>{right}</Text>}
      </View>
    </View>
    {width > 0 ? <Animated.View pointerEvents="none" style={[styles.labelLine, lineStyle]} /> : null}
  </View>;
}

/** A small dot that breathes while the runtime is live. Still under reduce-motion. */
export function LivePulse({ reducedMotion }: { readonly reducedMotion: boolean | null }) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reducedMotion !== false) { v.setValue(1); return undefined; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 0.25, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(v, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [reducedMotion, v]);
  return <Animated.View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.pulse, { opacity: v }]} />;
}

/** A Pressable that dips to 97% when pressed and springs back. Everything else (testID, role, label, style) passes through. */
export function PressScale({ children, style, onPressIn, onPressOut, ...rest }: PressableProps) {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const to = (value: number) => { if (reduced === false) Animated.spring(scale, { toValue: value, speed: 40, bounciness: value === 1 ? 10 : 0, useNativeDriver: true }).start(); };
  return <Animated.View style={{ transform: [{ scale }] }}>
    <Pressable {...rest} style={style} onPressIn={(e) => { to(0.97); onPressIn?.(e); }} onPressOut={(e) => { to(1); onPressOut?.(e); }}>{children}</Pressable>
  </Animated.View>;
}

export function Panel({ children, style, scan = false }: { readonly children: React.ReactNode; readonly style?: StyleProp<ViewStyle>; /** One bright scan line sweeps across the panel on entry (not under reduce-motion). */ readonly scan?: boolean }) {
  const reduced = useReducedMotion();
  const [panelWidth, setPanelWidth] = useState(0);
  const sweep = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!scan || reduced !== false || panelWidth <= 0) return undefined;
    sweep.setValue(0);
    const anim = Animated.timing(sweep, { toValue: 1, duration: 700, delay: 250, easing: Easing.inOut(Easing.cubic), useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [scan, reduced, panelWidth, sweep]);
  const k = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced === null) return undefined;
    if (reduced) { k.setValue(1); return undefined; }
    const anim = Animated.spring(k, { toValue: 1, speed: 24, bounciness: 14, delay: 120, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [reduced, k]);
  const grow = { opacity: k, transform: [{ scale: k.interpolate({ inputRange: [0, 1], outputRange: [3, 1] }) }] };
  return <View style={[styles.panel, style]} onLayout={scan ? (e) => setPanelWidth(Math.round(e.nativeEvent.layout.width)) : undefined}>
    {children}
    {scan && reduced === false && panelWidth > 0 ? <Animated.View pointerEvents="none" style={[styles.scan, { opacity: sweep.interpolate({ inputRange: [0, 0.1, 0.9, 1], outputRange: [0, 1, 1, 0] }), transform: [{ translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [0, panelWidth] }) }] }]} /> : null}
    <Animated.View pointerEvents="none" style={[styles.tick, styles.tickTopLeft, grow]} />
    <Animated.View pointerEvents="none" style={[styles.tick, styles.tickBottomRight, grow]} />
  </View>;
}

/** A hero line rises a few pixels and fades in once (about 0.55 s, softly decelerating). Settled text under reduce-motion; hidden until the OS has answered. */
function HeroLine({ text, style, reduced, order = 0 }: { readonly text: string; readonly style: StyleProp<TextStyle>; readonly reduced: boolean | null; readonly order?: number }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced === null) return undefined;
    if (reduced) { v.setValue(1); return undefined; }
    v.setValue(0);
    const anim = Animated.timing(v, { toValue: 1, duration: 550, delay: 80 + order * 110, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [text, reduced, order, v]);
  return <Animated.View style={{ opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] }}>
    <Text style={style}>{text}</Text>
  </Animated.View>;
}

/** Each digit is a 0-9 column that rolls to its value, ones place first. A changed value rolls again. */
export function Odometer({ value, size, color = calmColors.text, reducedMotion }: { readonly value: number; readonly size: number; readonly color?: string; readonly reducedMotion: boolean | null }) {
  const chars = value.toLocaleString("en-US").split("");
  return <View style={styles.odo} accessible accessibilityLabel={value.toLocaleString("en-US")}>
    {chars.map((ch, i) => /\d/.test(ch)
      ? <OdometerDigit key={`d${chars.length - 1 - i}`} digit={Number(ch)} size={size} color={color} delay={(chars.length - 1 - i) * 70} reducedMotion={reducedMotion} />
      : <Text key={`${value}-${i}`} style={[fieldFonts.displayStrong, { fontSize: size, lineHeight: size * 1.08, height: size * 1.08, color }]}>{ch}</Text>)}
  </View>;
}

function OdometerDigit({ digit, size, color, delay, reducedMotion }: { readonly digit: number; readonly size: number; readonly color: string; readonly delay: number; readonly reducedMotion: boolean | null }) {
  const h = size * 1.08;
  const y = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reducedMotion === null) return undefined;
    if (reducedMotion) { y.setValue(-digit * h); return undefined; }
    // The digit keeps its place (keyed by position from the right), so a change rolls from the old digit to the new one instead of restarting at 0.
    const anim = Animated.timing(y, { toValue: -digit * h, duration: 700, delay, easing: Easing.bezier(...aiIslandMotion.curve), useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [digit, h, delay, reducedMotion, y]);
  return <View style={{ height: h, overflow: "hidden" }} importantForAccessibility="no-hide-descendants">
    <Animated.View style={{ transform: [{ translateY: y }] }}>
      {Array.from({ length: 10 }, (_, k) => <Text key={k} style={[fieldFonts.displayStrong, { fontSize: size, lineHeight: h, height: h, color, fontVariant: ["tabular-nums"] }]}>{k}</Text>)}
    </Animated.View>
  </View>;
}

// One heartbeat period in a 200-wide box, 44 tall: flat, a small bump, the spike, a recovery bump, flat.
const BEAT: readonly (readonly [number, number])[] = [[0, 24], [30, 24], [34, 21], [38, 24], [62, 24], [66, 28], [71, 8], [77, 38], [82, 24], [110, 24], [115, 20], [121, 24], [200, 24]];
export const HEARTBEAT_HEIGHT = 44;

/** Builds two heartbeat periods across 2 * width so a translateX of -width loops seamlessly. */
export function heartbeatPath(width: number): string {
  const sx = width / 200;
  const pts = [0, 1].flatMap((k) => BEAT.map(([x, y]) => [(x + k * 200) * sx, y] as const));
  return pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y}`).join(" ");
}

/** A heartbeat trace that scrolls while the runtime is deciding: it says "alive", not a measured signal. */
export function Heartbeat({ width, reducedMotion }: { readonly width: number; readonly reducedMotion: boolean | null }) {
  const x = useRef(new Animated.Value(0)).current;
  const path = useMemo(() => (width > 0 ? Skia.Path.MakeFromSVGString(heartbeatPath(width)) : null), [width]);
  useEffect(() => {
    if (reducedMotion !== false || width <= 0) { x.setValue(0); return undefined; }
    const loop = Animated.loop(Animated.timing(x, { toValue: -width, duration: 1400, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [reducedMotion, width, x]);
  if (width <= 0 || path == null) return <View style={styles.beat} />;
  return <View style={styles.beat} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Animated.View style={{ width: width * 2, height: HEARTBEAT_HEIGHT, transform: [{ translateX: x }] }}>
      <Canvas style={{ width: width * 2, height: HEARTBEAT_HEIGHT }}><Path path={path} style="stroke" strokeWidth={1.4} color={calmColors.text} /></Canvas>
    </Animated.View>
  </View>;
}

/** Fast entrance: fades up 10 px in 260 ms on the native driver, staggered by `index`. A reduce-motion user gets it settled at once. */
export function Reveal({ index = 0, reducedMotion, children, style }: { readonly index?: number; readonly reducedMotion: boolean | null; readonly children: React.ReactNode; readonly style?: StyleProp<ViewStyle> }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reducedMotion === null) return undefined;
    if (reducedMotion) { v.setValue(1); return undefined; }
    const anim = Animated.timing(v, { toValue: 1, duration: 260, delay: index * 55, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [index, reducedMotion, v]);
  return <Animated.View style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }]}>{children}</Animated.View>;
}

export const instrumentType = StyleSheet.create({
  index: { color: calmColors.muted, fontSize: readableFont(12), letterSpacing: 0.2 },
  heroLine: { color: calmColors.text, fontSize: 54, lineHeight: 58, fontWeight: "700", letterSpacing: -2 },
  sub: { color: calmColors.muted, fontSize: readableFont(14), lineHeight: 21, marginTop: 10, maxWidth: 320 },
});

const styles = StyleSheet.create({
  labelWrap: { marginBottom: 10 },
  label: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", paddingBottom: 4 },
  labelRightRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  labelLine: { height: StyleSheet.hairlineWidth, backgroundColor: calmColors.line },
  pulse: { width: 6, height: 6, borderRadius: 3, backgroundColor: calmColors.order },
  labelLeft: { flexShrink: 1, color: calmColors.muted, fontSize: readableFont(13), fontWeight: "500" },
  labelRight: { color: calmColors.text, fontSize: readableFont(13), fontWeight: "500" },
  panel: { borderWidth: StyleSheet.hairlineWidth, borderColor: calmColors.line, padding: 14 },
  scan: { position: "absolute", left: 0, top: 0, bottom: 0, width: 2, backgroundColor: calmColors.text, opacity: 0.9 },
  tick: { position: "absolute", width: 8, height: 8, borderColor: calmColors.text, opacity: 0.7 },
  tickTopLeft: { left: -1, top: -1, borderLeftWidth: 1, borderTopWidth: 1 },
  tickBottomRight: { right: -1, bottom: -1, borderRightWidth: 1, borderBottomWidth: 1 },
  odo: { flexDirection: "row", alignItems: "flex-start" },
  beat: { height: HEARTBEAT_HEIGHT, overflow: "hidden", marginTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: calmColors.line },
});

/** Screen opener of the instrument design: a mono index ("03 / 안전") over a large two-line statement. */
export function InstrumentHero({ index, lines, label }: { readonly index: string; readonly lines: readonly { readonly text: string; readonly amber?: boolean; readonly color?: string }[]; readonly label?: string }) {
  const reduced = useReducedMotion();
  // Shrink all lines together until the widest fits the screen, so no syllable is left alone on an extra line.
  const { width } = useWindowDimensions();
  const size = heroFontSize(lines.map((l) => l.text), width - 40);
  const fit = size === HERO_FONT_SIZE ? null : { fontSize: size, lineHeight: Math.round(size * 58 / HERO_FONT_SIZE), letterSpacing: -2 * size / HERO_FONT_SIZE };
  return <View style={heroStyles.wrap}>
    <Text style={instrumentType.index}>{index}</Text>
    <View style={heroStyles.lines} accessible accessibilityRole="header" accessibilityLabel={label ?? lines.map((l) => l.text).join(" ")}>
      {lines.map((l, order) => <HeroLine key={`${order}:${l.text}`} text={l.text} reduced={reduced} order={order} style={[instrumentType.heroLine, fit, l.amber ? { color: calmColors.attention } : l.color ? { color: l.color } : null]} />)}
    </View>
  </View>;
}

const heroStyles = StyleSheet.create({
  wrap: { paddingHorizontal: 20, paddingTop: 12 },
  lines: { marginTop: 14 },
});
