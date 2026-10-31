import React, { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { Canvas, Picture, Skia, createPicture } from "@shopify/react-native-skia";
import { calmColors } from "./uiKitModel";
import { readableFont } from "./designSystem";
import { fieldFonts } from "./fieldFonts";
import type { LearningFunnelModel } from "./learningFunnelModel";
import { buildWaffle } from "./learningWaffleModel";
import { Odometer, Panel, SectionLabel, useReducedMotion } from "./instrumentKit";

// 학습 hero (redesign 2026-10-20, owner-chosen 계기판 design): the holdout passes as a big number over the tested count, then a unit
// chart with one cell per tested strategy. Discovery passers are lit, the filtered ones stay dim and holdout passers take the order
// colour; the amber rule under the grid is the last gate. The grid is one static Skia picture revealed by a native-driver wipe; it
// is drawn at once when the OS reduce-motion setting is on. Counts are the server's integers only.
const GAP = 4;

export function LearningFunnel({ model }: { readonly model: LearningFunnelModel }) {
  const reducedMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const [tested = 0, discovery = 0, holdout = 0] = model.stages.length === 3 ? model.stages.map((s) => s.value) : [];
  const waffle = useMemo(() => buildWaffle(tested, discovery, holdout), [tested, discovery, holdout]);
  const wipe = useRef(new Animated.Value(0)).current;
  const inner = Math.max(0, width - 28);
  const cell = waffle ? Math.max(2, (inner - (waffle.cols - 1) * GAP) / waffle.cols) : 0;
  const gridH = waffle ? waffle.rows * (cell + GAP) - GAP : 0;

  const picture = useMemo(() => {
    if (!waffle || inner <= 0) return null;
    const dim = Skia.Paint(); dim.setColor(Skia.Color(calmColors.text)); dim.setAlphaf(0.16);
    const lit = Skia.Paint(); lit.setColor(Skia.Color(calmColors.text));
    const pass = Skia.Paint(); pass.setColor(Skia.Color(calmColors.order));
    return createPicture((canvas) => {
      waffle.cells.forEach((c, i) => {
        const x = (i % waffle.cols) * (cell + GAP), y = Math.floor(i / waffle.cols) * (cell + GAP);
        canvas.drawRect({ x, y, width: cell, height: cell }, c === 2 ? pass : c === 1 ? lit : dim);
      });
    }, { width: inner, height: gridH });
  }, [waffle, inner, cell, gridH]);

  useEffect(() => {
    if (reducedMotion === null || inner <= 0) return undefined;
    if (reducedMotion) { wipe.setValue(1); return undefined; }
    wipe.setValue(0);
    const a = Animated.timing(wipe, { toValue: 1, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [reducedMotion, inner, wipe]);

  const zero = holdout === 0;
  if (model.stages.length !== 3) return null;
  return <View style={styles.wrap} testID="learning-funnel" onLayout={(e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width) - 40)}>
    <Text style={styles.index}>02 / 학습</Text>
    <View style={styles.hero} accessible accessibilityRole="header" accessibilityLabel={model.headline.replace(/\n/g, " ")}>
      <Odometer value={holdout} size={84} color={zero ? calmColors.attention : calmColors.text} reducedMotion={reducedMotion} />
      <Text style={[fieldFonts.displayStrong, styles.of]}>{` / ${tested.toLocaleString("en-US")}`}</Text>
    </View>
    <Text style={styles.caption}>끝까지 통과한 전략</Text>
    <Text style={styles.sub}>{model.sub}</Text>
    <Text style={styles.loop} testID="learning-loop-line">{model.loop}</Text>

    {waffle ? <View style={styles.section}>
      <SectionLabel left={waffle.unit === 1 ? "전략 1개 = 1칸" : `1칸 ≈ 전략 ${waffle.unit}개`} right={tested.toLocaleString("en-US")} />
      <Panel>
        <View style={{ height: gridH + 12, overflow: "hidden" }} accessible accessibilityRole="image" accessibilityLabel={model.stages.map((s) => `${s.label} ${s.value}`).join(", ")}>
          {picture ? <Canvas style={{ width: inner, height: gridH }}><Picture picture={picture} /></Canvas> : null}
          {reducedMotion === false ? <Animated.View pointerEvents="none" style={[styles.wipe, { width: inner, height: gridH, transform: [{ translateX: wipe.interpolate({ inputRange: [0, 1], outputRange: [0, inner] }) }] }]} /> : null}
          <View style={[styles.gate, { top: gridH + 8 }]} />
        </View>
        <View style={styles.legend}>
          <Legend swatch={styles.swLit} text={`1차 통과 ${discovery.toLocaleString("en-US")}`} />
          <Legend swatch={styles.swDim} text={`걸러짐 ${(tested - discovery).toLocaleString("en-US")}`} />
          <Legend swatch={zero ? styles.swGate : styles.swPass} text={`최종 합격 ${holdout.toLocaleString("en-US")}`} />
        </View>
      </Panel>
    </View> : null}
  </View>;
}

function Legend({ swatch, text }: { readonly swatch: object; readonly text: string }) {
  return <View style={styles.legendItem}><View style={[styles.sw, swatch]} /><Text style={styles.legendText}>{text}</Text></View>;
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 20, marginTop: 8, marginBottom: 8 },
  index: { color: calmColors.muted, fontSize: readableFont(12), letterSpacing: 0.2 },
  hero: { flexDirection: "row", alignItems: "flex-end", marginTop: 12 },
  of: { color: calmColors.muted, fontSize: 30, lineHeight: 40, marginLeft: 4 },
  caption: { color: calmColors.text, fontSize: readableFont(15), marginTop: 2 },
  sub: { color: calmColors.muted, fontSize: readableFont(13), lineHeight: 19, marginTop: 6 },
  loop: { color: calmColors.text, fontSize: readableFont(13), lineHeight: 19, marginTop: 8 },
  section: { marginTop: 22 },
  wipe: { position: "absolute", left: 0, top: 0, backgroundColor: calmColors.ground },
  gate: { position: "absolute", left: 0, right: 0, height: 2, backgroundColor: calmColors.attention },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 14, marginTop: 12 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  sw: { width: 9, height: 9 },
  swLit: { backgroundColor: calmColors.text },
  swDim: { backgroundColor: calmColors.text, opacity: 0.2 },
  swPass: { backgroundColor: calmColors.order },
  swGate: { backgroundColor: calmColors.attention },
  legendText: { color: calmColors.muted, fontSize: readableFont(11) },
});
