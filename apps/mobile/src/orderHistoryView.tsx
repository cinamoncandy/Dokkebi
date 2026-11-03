import { AiShell } from "./aiKit";
import { plainScreenChip } from "./stageTraceModel";
import React, { useMemo, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { NusaButton, NusaTextField, StatusChip } from "./components";
import { InlineNotice, ScreenHeader, SegmentedControl } from "./uxPrimitives";
import { useTheme } from "./ThemeProvider";
import { buildOrderHistoryViewModel, type OrderHistoryFilter, type OrderHistoryPeriod, type OrderHistorySort } from "./orderHistory";
import { labelFont, readableFont } from "./designSystem";

interface OrderHistoryViewProps { readonly rawOrders: readonly unknown[] | null; readonly error: string | null; readonly refreshing: boolean; readonly onRefresh: () => void; }
const filters: readonly OrderHistoryFilter[] = ["ALL", "FILLED", "CANCELLED"];
const sorts: readonly OrderHistorySort[] = ["TIME_DESC", "TIME_ASC", "PRICE_DESC", "QUANTITY_DESC"];
const periods: readonly OrderHistoryPeriod[] = ["ALL", "TODAY", "7D", "30D"];
const filterLabels: Readonly<Record<OrderHistoryFilter, string>> = { ALL: "전체", FILLED: "체결", CANCELLED: "취소" };
const sortLabels: Readonly<Record<OrderHistorySort, string>> = { TIME_DESC: "최신순", TIME_ASC: "오래된순", PRICE_DESC: "가격순", QUANTITY_DESC: "수량순" };
const periodLabels: Readonly<Record<OrderHistoryPeriod, string>> = { ALL: "전체", TODAY: "오늘", "7D": "7일", "30D": "30일" };
const filterItems = filters.map((key) => ({ key, label: filterLabels[key] }));
const periodItems = periods.map((key) => ({ key, label: periodLabels[key] }));
const sortItems = sorts.map((key) => ({ key, label: sortLabels[key] }));
function money(value: number): string { return `₩${Math.round(value).toLocaleString("ko-KR")}`; }

function OrderRow({ order, last }: Readonly<{ order: ReturnType<typeof buildOrderHistoryViewModel>["orders"][number]; last: boolean }>) {
  const { theme } = useTheme();
  const statusTone = order.status === "FILLED" ? "success" : order.status === "CANCELLED" ? "warning" : "danger";
  const sideTone = order.side === "BUY" ? theme.colors.success : theme.colors.warning;
  return <View testID={`order-history-${order.id}`} style={[styles.orderRow, !last && { borderBottomColor: theme.colors.border, borderBottomWidth: StyleSheet.hairlineWidth }]}>
    <View style={styles.rowHeader}><View style={styles.marketBlock}><View style={styles.marketLine}><Text style={[styles.market, { color: theme.colors.text }]}>{order.market}</Text><Text style={[styles.side, { color: sideTone }]}>{order.side}</Text></View><Text style={[styles.meta, { color: theme.colors.textMuted }]}>{new Date(order.filledAt).toLocaleString("ko-KR")}</Text></View><StatusChip label={order.status} tone={statusTone} /></View>
    <View style={styles.rowMetrics}><View style={styles.metric}><Text style={[styles.metricLabel, { color: theme.colors.textMuted }]}>수량</Text><Text style={[styles.metricValue, { color: theme.colors.text }]}>{order.quantity}</Text></View><View style={styles.metric}><Text style={[styles.metricLabel, { color: theme.colors.textMuted }]}>체결가</Text><Text style={[styles.metricValue, { color: theme.colors.text }]}>{money(order.price)}</Text></View><View style={styles.metric}><Text style={[styles.metricLabel, { color: theme.colors.textMuted }]}>수수료</Text><Text style={[styles.metricValueSmall, { color: theme.colors.text }]}>{money(order.fee)}</Text></View></View>
    <Text style={[styles.orderId, { color: theme.colors.textMuted }]}>#{order.id}</Text>
    {order.fills.length > 1 ? <View style={styles.fills}><Text style={[styles.fillLabel, { color: theme.colors.textMuted }]}>체결 {order.fills.length}건</Text>{order.fills.map((fill) => <Text key={fill.id} style={[styles.fill, { color: theme.colors.textMuted }]} testID={`fill-detail-${fill.id}`}>{fill.quantity} @ {money(fill.price)}</Text>)}</View> : null}
  </View>;
}

export function OrderHistoryView(props: OrderHistoryViewProps) {
  return <AiShell chip={plainScreenChip("MORE")}><OrderHistoryBody {...props} /></AiShell>;
}

function OrderHistoryBody({ rawOrders, error, refreshing, onRefresh }: OrderHistoryViewProps) {
  const { theme } = useTheme();
  const [query, setQuery] = useState(""); const [filter, setFilter] = useState<OrderHistoryFilter>("ALL"); const [sort, setSort] = useState<OrderHistorySort>("TIME_DESC"); const [page, setPage] = useState(1); const [period, setPeriod] = useState<OrderHistoryPeriod>("ALL");
  const model = useMemo(() => buildOrderHistoryViewModel({ rawOrders, query, filter, sort, page, period }), [filter, page, period, query, rawOrders, sort]);
  const setFilterAndReset = (next: OrderHistoryFilter) => { setFilter(next); setPage(1); };
  const setSortAndReset = (next: OrderHistorySort) => { setSort(next); setPage(1); };
  const setPeriodAndReset = (next: OrderHistoryPeriod) => { setPeriod(next); setPage(1); };

  if (error) return <View style={styles.state} testID="order-history-error"><View style={styles.stateInner}><InlineNotice title="주문 이력을 표시할 수 없습니다" detail={error} tone="danger" /><NusaButton label="다시 불러오기" onPress={onRefresh} /></View></View>;
  if (model.state === "LOADING") return <View style={styles.state} testID="order-history-loading"><ActivityIndicator color={theme.colors.primary} /><Text style={[styles.stateTitle, { color: theme.colors.text }]}>주문 이력을 불러오는 중</Text></View>;
  if (model.state === "ERROR") return <View style={styles.state} testID="order-history-error"><InlineNotice title="주문 데이터 오류" detail={model.error ?? "Unknown order history error."} tone="danger" /></View>;
  if (model.state === "EMPTY") return <View style={styles.state} testID="order-history-empty"><View style={styles.stateInner}><InlineNotice title="조건에 맞는 주문이 없습니다" detail="완료된 PAPER 주문이 생기면 이 화면에 표시됩니다." tone="info" /><NusaButton label="다시 불러오기" onPress={onRefresh} /></View></View>;

  return <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl tintColor={theme.colors.primary} refreshing={refreshing} onRefresh={onRefresh} />} testID="order-history-screen">
    <ScreenHeader eyebrow="PAPER 주문 기록" title="주문 이력" description="서버가 제공한 PAPER 주문·체결 기록만 검색하고 필터링합니다." statusLabel={`${model.total}건`} statusTone="neutral" />
    <NusaTextField label="주문 검색" value={query} onChangeText={(value) => { setQuery(value); setPage(1); }} placeholder="시장 또는 주문 ID" testID="order-history-search" />
    <View style={styles.controlGrid}><View style={styles.controlGroup}><Text style={[styles.controlLabel, { color: theme.colors.textMuted }]}>상태</Text><SegmentedControl items={filterItems} selectedKey={filter} onChange={(key) => setFilterAndReset(key as OrderHistoryFilter)} testID="order-history-filters" /></View><View style={styles.controlGroup}><Text style={[styles.controlLabel, { color: theme.colors.textMuted }]}>기간</Text><SegmentedControl items={periodItems} selectedKey={period} onChange={(key) => setPeriodAndReset(key as OrderHistoryPeriod)} testID="order-history-periods" /></View></View>
    <View style={styles.controlGroup}><Text style={[styles.controlLabel, { color: theme.colors.textMuted }]}>정렬</Text><SegmentedControl items={sortItems} selectedKey={sort} onChange={(key) => setSortAndReset(key as OrderHistorySort)} testID="order-history-sorts" /></View>
    <View style={styles.list} testID="order-history-list">{model.orders.map((order, index) => <OrderRow key={order.id} order={order} last={index === model.orders.length - 1} />)}</View>
    <View style={styles.pagination} testID="order-history-pagination"><NusaButton label="이전" disabled={model.page <= 1} onPress={() => setPage((value) => Math.max(1, value - 1))} tone="neutral" /><Text style={[styles.meta, { color: theme.colors.textMuted }]}>{model.page} / {model.pageCount} 페이지</Text><NusaButton label="다음" disabled={model.page >= model.pageCount} onPress={() => setPage((value) => Math.min(model.pageCount, value + 1))} tone="neutral" /></View>
  </ScrollView>;
}

const styles = StyleSheet.create({ content: { paddingHorizontal: 20, paddingTop: 20, gap: 16, paddingBottom: 40, width: "100%", maxWidth: 920, alignSelf: "center" }, state: { flex: 1, justifyContent: "center", padding: 20, gap: 14, alignItems: "center" }, stateInner: { width: "100%", maxWidth: 720, gap: 12 }, stateTitle: { fontSize: 18, fontWeight: "700" }, meta: { fontSize: readableFont(11), lineHeight: 17, marginTop: 3 }, controlGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 }, controlGroup: { flexGrow: 1, flexBasis: 300, gap: 7 }, controlLabel: { fontSize: labelFont(10), lineHeight: 15, fontWeight: "500", letterSpacing: 1.0 }, list: { marginTop: 4 }, orderRow: { paddingVertical: 17, gap: 11 }, rowHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }, marketBlock: { gap: 1 }, marketLine: { flexDirection: "row", alignItems: "baseline", gap: 8 }, market: { fontSize: 19, lineHeight: 25, fontWeight: "500", letterSpacing: -0.35 }, side: { fontSize: labelFont(11), lineHeight: 16, fontWeight: "500", letterSpacing: 0.6 }, rowMetrics: { flexDirection: "row", flexWrap: "wrap", gap: 18 }, metric: { minWidth: 92, flexGrow: 1 }, metricLabel: { fontSize: labelFont(10), lineHeight: 15, fontWeight: "700", letterSpacing: 0.7 }, metricValue: { marginTop: 3, fontSize: 17, lineHeight: 22, fontWeight: "700", fontVariant: ["tabular-nums"] }, metricValueSmall: { marginTop: 3, fontSize: 14, lineHeight: 21, fontWeight: "700", fontVariant: ["tabular-nums"] }, orderId: { fontSize: readableFont(10), lineHeight: 17, fontVariant: ["tabular-nums"] }, fills: { gap: 2 }, fillLabel: { fontSize: readableFont(10), lineHeight: 17, fontWeight: "500" }, fill: { fontSize: readableFont(11), lineHeight: 17, fontVariant: ["tabular-nums"] }, pagination: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 8 } });
