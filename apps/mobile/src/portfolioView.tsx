import { AiShell } from "./aiKit";
import { plainScreenChip } from "./stageTraceModel";
import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { NusaButton } from "./components";
import { useTheme } from "./ThemeProvider";
import { createCashInvestmentEnvelope } from "./capitalAllocationGuard";
import { buildPortfolioViewModel, type PortfolioAccountResponse, type PortfolioViewModel } from "./portfolioViewModel";
import type { UpbitReadOnlyAccountSnapshot, UpbitReadOnlyConnectionStatus } from "./upbitReadOnlyAccount";
import { buildLocalPortfolio, isLocalPaperActive } from "./localPaperLedger";
import { isLocalPaperLedgerDisplayable } from "./localPaperLedger";
import { useLocalPaperMarkPrice, useLocalPaperSnapshot } from "./localPaperLedgerHooks";
import { AuthorityRail, FactRow, IntelligenceSection, MetricStrip, ScreenLead, StateNotice } from "./intelligenceOs";
import { labelFont, readableFont } from "./designSystem";

export type { PortfolioAccountResponse } from "./portfolioViewModel";
export interface PortfolioViewProps {
  readonly snapshot: PortfolioAccountResponse | null;
  readonly investmentPercent: number;
  readonly error: string | null;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly upbitSnapshot?: UpbitReadOnlyAccountSnapshot | null;
  readonly upbitStatus?: UpbitReadOnlyConnectionStatus;
  readonly upbitError?: string | null;
  readonly onOpenPaperLearning?: () => void;
}

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `₩${Math.round(value).toLocaleString("ko-KR")}`;
}
function signedMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${money(Math.abs(value))}`;
}
function buildModel(snapshot: PortfolioAccountResponse | null): PortfolioViewModel | null {
  if (snapshot == null) return null;
  try { return buildPortfolioViewModel(snapshot); } catch { return null; }
}

export function PortfolioView(props: PortfolioViewProps) {
  return <AiShell chip={plainScreenChip("MORE")}><PortfolioBody {...props} /></AiShell>;
}

function PortfolioBody({ snapshot, investmentPercent, error, refreshing, onRefresh, upbitSnapshot = null, upbitStatus = "DISCONNECTED", upbitError = null, onOpenPaperLearning }: PortfolioViewProps) {
  const { theme } = useTheme();
  const { width } = useWindowDimensions();
  const tablet = width >= 768;
  const localPaperActive = snapshot === null && isLocalPaperActive() && isLocalPaperLedgerDisplayable();
  const localTradingSnapshot = useLocalPaperSnapshot();
  const localMarkPrice = useLocalPaperMarkPrice(localPaperActive);
  const localPortfolio = localPaperActive ? buildLocalPortfolio(localTradingSnapshot, localMarkPrice) : null;
  const effectiveSnapshot = snapshot ?? localPortfolio;
  const usingLocalPaper = snapshot === null && localPortfolio !== null;
  const model = buildModel(effectiveSnapshot);
  const allocation = model == null ? null : createCashInvestmentEnvelope(model.cash, investmentPercent);
  const position = model?.position ?? null;
  const upbitConnected = upbitStatus === "READY" && upbitSnapshot != null && upbitError == null;

  return <ScrollView style={{ backgroundColor: "transparent" }} contentContainerStyle={[styles.content, { maxWidth: tablet ? 1080 : 720 }]} refreshControl={<RefreshControl tintColor={theme.colors.primary} refreshing={refreshing} onRefresh={onRefresh} />} showsVerticalScrollIndicator={false} testID="portfolio-screen">
    <AuthorityRail detail="PAPER 자산 · 실계좌와 분리 · LIVE 없음" status={model ? (usingLocalPaper ? "이 기기 모의투자" : "서버 연결됨") : error ? "일부 불가" : "받지 못함"} tone={model ? "success" : "warning"} testID="portfolio-authority-rail" />
    <ScreenLead eyebrow="포트폴리오" title="모의투자 자산과 결과" detail="총자산과 누적 손익을 먼저 보고, 자본 배분·노출·회계 근거를 아래에서 확인해요." badge="모의투자" badgeTone="primary" />
    {error ? <StateNotice title="PAPER 자산 정보 일부 불완전" detail={error} tone="danger" /> : null}
    {!model ? <StateNotice title="모의투자 자산 정보 없음" detail="서버에 연결하거나 이 기기에서 모의투자 결과가 생기면 자산과 손익을 보여줘요. 모르는 값은 0으로 표시하지 않습니다." tone="warning" /> : null}
    <MetricStrip testID="portfolio-supervisor-summary" items={[{ label: "PAPER 자산", value: money(model?.totalEquity) }, { label: "총 손익", value: signedMoney(model?.totalPnl), tone: model == null ? "neutral" : model.totalPnl >= 0 ? "success" : "danger" }, { label: "현금", value: money(model?.cash) }, { label: "보유 비중", value: money(model?.assetValue) }]} />
    <View style={tablet ? styles.columns : styles.stack}>
    {model && allocation ? <IntelligenceSection style={tablet ? styles.column : undefined} title="자본 배분" kicker="자본" tone="primary" testID="portfolio-allocation-rail">
      <FactRow label="투자 한도" value={`${allocation.investmentPercent}%`} /><FactRow label="투자 가능 현금" value={money(allocation.investableCash)} testID="portfolio-investable-cash" /><FactRow label="보호 현금" value={money(allocation.reservedCash)} tone="success" testID="portfolio-reserved-cash" />
      <View style={[styles.allocationRail, { backgroundColor: theme.colors.surfaceRaised }]}><View style={[styles.allocationFill, { backgroundColor: theme.colors.primary, width: `${allocation.investmentPercent}%` as `${number}%` }]} /></View><Text style={[styles.note, { color: theme.colors.textMuted }]}>보호 현금은 신규 PAPER 매수 한도에서 제외됩니다.</Text>
    </IntelligenceSection> : null}
    <IntelligenceSection style={tablet ? styles.column : undefined} title="현재 노출" kicker="PAPER 보유" tone={position ? "info" : "neutral"} testID={position ? "portfolio-position" : "portfolio-empty"}>
      {position ? <><FactRow label="종목" value={position.market} /><FactRow label="수량" value={String(position.quantity)} /><FactRow label="평균 단가" value={money(position.averagePrice)} /><FactRow label="현재가" value={money(position.currentPrice)} /><FactRow label="평가 손익" value={signedMoney(position.unrealizedPnl)} tone={position.unrealizedPnl >= 0 ? "success" : "danger"} /><FactRow label="실현 손익" value={signedMoney(position.realizedPnl)} tone={position.realizedPnl >= 0 ? "success" : "danger"} /></> : <StateNotice title="보유 종목 없음" detail={model ? "현재 PAPER 시장 노출이 없습니다. 현금 대기 상태입니다." : "포지션 데이터를 확인할 수 없습니다."} tone="info" />}
    </IntelligenceSection>
    </View>
    <View style={tablet ? styles.columns : styles.stack}>
    <IntelligenceSection style={tablet ? styles.column : undefined} title="PAPER 회계" kicker="회계" tone="success" testID="portfolio-account-breakdown">
      <FactRow label="미체결 주문" value={model == null ? "—" : String(model.openOrderCount)} /><FactRow label="시장 노출" value={money(model?.assetValue)} /><FactRow label="PAPER 결과" value={signedMoney(model?.totalPnl)} tone={model == null ? "neutral" : model.totalPnl >= 0 ? "success" : "danger"} />
      {onOpenPaperLearning ? <NusaButton label="학습 / 평가 근거 보기" tone="neutral" onPress={onOpenPaperLearning} testID="portfolio-paper-learning" /> : null}
    </IntelligenceSection>
    <IntelligenceSection style={tablet ? styles.column : undefined} title="실계좌 기준선" kicker="실계좌 · 읽기 전용" tone="info" testID="portfolio-upbit-read-only">
      <FactRow label="연결" value={String(upbitStatus)} tone={upbitConnected ? "success" : upbitError ? "danger" : "neutral"} /><FactRow label="원화 사용 가능" value={money(upbitSnapshot?.cash.available)} /><FactRow label="원화 묶임" value={money(upbitSnapshot?.cash.locked)} /><FactRow label="보유 자산" value={upbitSnapshot ? String(upbitSnapshot.assets.length) : "—"} />
      {upbitError ? <StateNotice title="실계좌 정보 일부 불완전" detail={upbitError} tone="warning" testID="portfolio-upbit-monitor-error" /> : null}
      <Text style={[styles.note, { color: theme.colors.textMuted }]}>실계좌 잔고는 감독용 기준선이며 PAPER 성과와 절대 합산하지 않습니다.</Text>
    </IntelligenceSection>
    </View>
    <Text style={[styles.footer, { color: theme.colors.textMuted }]}>PAPER ONLY · LIVE NONE · AI ZERO AUTHORITY</Text>
  </ScrollView>;
}

const styles = StyleSheet.create({ content: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 96, gap: 14, width: "100%", alignSelf: "center" }, columns: { flexDirection: "row", alignItems: "stretch", gap: 16 }, stack: { gap: 14 }, column: { flex: 1, minWidth: 0 }, allocationRail: { height: 8, borderRadius: 999, overflow: "hidden" }, allocationFill: { height: "100%", borderRadius: 999 }, note: { fontSize: readableFont(11), lineHeight: 17 }, footer: { textAlign: "center", fontSize: labelFont(9), lineHeight: 15, fontWeight: "600", letterSpacing: 1.05, paddingTop: 4 } });
