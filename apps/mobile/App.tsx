import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, BackHandler, Pressable, StyleSheet, Text, View, type AppStateStatus } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AuthContext, useAuth, type AuthStatus } from "./src/authContext";
// Screen presenters come only from the presentation boundary (docs/UI_ARCHITECTURE.md).
import {
  FuturesView, HomeView, LiveReadinessMonitorView, MoreDetailView, MoreMenuView, NotificationView, NusaButton, NusaCard, OrderHistoryView,
  AiShell, EventBanner, PaperShadowMonitorView, PerformanceView, PortfolioView, PrimaryNavigation, SafetyLine, SettingsView, StatusChip, StrategiesView, TabTransition, ThemeProvider, useTheme, WaveMark,
  plainScreenChip, type HomeDestination, type ThemePreference, type TruthfulMoreDetail,
} from "./src/presentation";
import { getHomeVisualProfile } from "./src/homeVisualProfile";
import { WatchlistRepository } from "./src/watchlist";
import { DEFAULT_SETTINGS, normalizeSettings, type ThemeSetting } from "./src/settings";
import { VersionedSettingsRepository } from "./src/persistenceRepositories";
import { resumePaperConnection } from "./src/paperConnectionSession";
import { buildSafetyLine } from "./src/safetyLineModel";
import { clearCachedSnapshot, useCachedSnapshot } from "./src/useCachedSnapshot";
import { markStartup } from "./src/startupTiming";
import { registerConnectionWarmup, warmConnection } from "./src/connectionWarmup";
import { displaySessionState, graceNotConfigured, LAUNCH_GRACE_MS, launchSettling, RESUME_GRACE_MS } from "./src/sessionDisplayModel";
import { buildPerformanceScreen } from "./src/performanceModel";
import { InMemoryDashboardCredentialSession } from "./src/dashboardCredentialSession";
import { createCloudInvestmentAllocationClient } from "./src/cloudInvestmentAllocationClient";
import { beginPaperConnectionRecovery, clearPaperConnectionVerification, getConfiguredPaperEndpoint, getPaperSessionState, armWarmResumeCutoff, isPaperConnectionVerified, isWarmResumeFresh, restoreConfiguredPaperSession, setConfiguredPaperEndpoint, subscribePaperSessionVerified, type PaperSessionState } from "./src/paperConnectionSession";
import { mobileApprovedSession } from "./src/mobileApprovedSessionBoundary";
import { loadPersonalPaperOperations, type PersonalPaperOperationsLoadResult } from "./src/personalPaperOperationsClient";
import { loadAnonymousPaperObservation } from "./src/observation/anonymousObservationClient";
import { loadShadowOperations, type ShadowOperationsLoadResult } from "./src/shadowOperationsClient";
import { loadRealReadOnlyOperations, type RealReadOnlyOperationsLoadResult } from "./src/realReadOnlyOperationsClient";
import { loadLiveReadinessOperations, type LiveReadinessOperationsLoadResult } from "./src/liveReadinessOperationsClient";
import { MobileRuntimeCoordinator, initialMobileRuntimeSnapshot, type MobileRuntimeEvent, type MobileRuntimeSnapshot } from "./src/mobileRuntime";
import { resetUpbitReadOnlyState, useUpbitReadOnlyState } from "./src/upbitReadOnlyAccount";
import { loadUpbitPublicCandles, loadUpbitPublicMarkets, UpbitPublicQuotationError, type PublicQuotationDiagnostic } from "./src/upbitPublicQuotationClient";
import { UpbitPublicWebSocketClient } from "./src/upbitPublicWebSocketClient";
// PaperLearningMonitorView remains the canonical PAPER monitor rendered by PaperShadowMonitorView.
import { buildPaperLearningScreen } from "./src/paperLearningScreen";
import { getLocalPaperLearningReadiness, recordLocalPaperPublicMarkets } from "./src/localPaperLearningProjection";
import { effectivePaperEndpoint, resolveCanonicalCloudOrigin } from "./src/canonicalOrigin";
import type { PublicCandle } from "./src/chartViewModel";
import type { WatchlistMarket } from "./src/watchlist";
import { emitUxTelemetryEvent } from "./src/uxTelemetryClient";
import { screenIdForNavigationState, createUxTelemetrySessionId } from "./src/uxTelemetryScreenTracking";
import { resolveAndroidBackNavigation } from "./src/androidBackNavigation";
import { ownerDeviceCredential } from "./src/ownerDeviceCredential";
import { getOrCreateInstallationId } from "./src/installationIdentity";
import { type MoreDestination, type PrimaryDestination } from "./src/navigationContract";
import { labelFont, readableFont } from "./src/designSystem";

/** Start of the cold-start timing shown in Settings (advanced); first call wins. */
markStartup("appStart");
/** Lets the first server request reuse a connection that was opened while the saved session was being read. */
registerConnectionWarmup((url, init) => fetch(url, init as RequestInit));

type UtilityView = "NOTIFICATIONS" | "SETTINGS" | null;
type DetailSurface = "Strategies" | "Portfolio" | "Order" | TruthfulMoreDetail | null;
const utilityLabels: Readonly<Record<Exclude<UtilityView, null>, string>> = { NOTIFICATIONS: "알림", SETTINGS: "설정" };
const CHART_MARKET = "KRW-BTC";
const PAPER_REFRESH_INTERVAL_MS = 5000;
const PUBLIC_REFRESH_INTERVAL_MS = 30_000;
const settingsRepository = new VersionedSettingsRepository(AsyncStorage);
const theme = { container: { flex: 1 } } as const;

type PublicMarketsStatus = "LOADING" | "READY" | "STALE" | "ERROR";
interface PublicMarketsState {
  readonly status: PublicMarketsStatus;
  readonly markets: readonly WatchlistMarket[] | null;
  readonly candles: readonly PublicCandle[] | null;
  readonly currentPrice: number | null;
  readonly error: string | null;
  readonly chartError: string | null;
  /** Set only when chartError came from a real Upbit request/response, for the read-only
   * NETWORK DIAGNOSTICS panel -- see ChartView. Never set for any other failure. */
  readonly chartErrorDiagnostic: PublicQuotationDiagnostic | null;
}

const initialPublicMarketsState = (): PublicMarketsState => ({ status: "LOADING", markets: null, candles: null, currentPrice: null, error: null, chartError: null, chartErrorDiagnostic: null });

function themePreference(value: ThemeSetting): ThemePreference { return value === "SYSTEM" ? "system" : value === "LIGHT" ? "light" : "dark"; }

function PersistedThemeBridge({ children }: Readonly<{ children: React.ReactNode }>) {
  const { setMode } = useTheme();
  useEffect(() => {
    let active = true;
    void settingsRepository.load().then((stored) => {
      if (!active) return;
      const settings = normalizeSettings(stored ?? DEFAULT_SETTINGS);
      const canonical = resolveCanonicalCloudOrigin();
      // Never apply the raw saved value: "" would transiently unset the canonical origin and read as
      // an explicit endpoint change that destroys the encrypted PAPER session.
      setConfiguredPaperEndpoint(effectivePaperEndpoint(settings.paperEndpoint, canonical));
      setMode(themePreference(settings.theme));
    }).catch(() => { if (active) setMode("dark"); });
    return () => { active = false; };
  }, [setMode]);
  return <>{children}</>;
}

function DashboardConnectionRequired({ reason, onGoSettings }: Readonly<{ reason: string; onGoSettings: () => void }>) {
  const { theme: appTheme } = useTheme();
  return <AiShell chip={plainScreenChip("PAPER")}><View style={styles.connectionState} testID="dashboard-connection-required"><View style={styles.connectionStateInner}><NusaCard raised>
    <View style={styles.cardHeader}><View><Text style={[styles.cardEyebrow, { color: appTheme.colors.warning }]}>PAPER CONNECTION</Text><Text style={[styles.cardTitle, { color: appTheme.colors.text }]}>PAPER 서버 연결 필요</Text></View><StatusChip label="연결 안 됨" tone="warning" /></View>
    <Text style={[styles.body, { color: appTheme.colors.textMuted }]}>{reason}</Text>
    <Text style={[styles.meta, { color: appTheme.colors.textMuted }]}>Settings에서 Cloud endpoint와 메모리 전용 세션 토큰을 검증한 뒤 PAPER 데이터와 운용 감독 기능을 사용할 수 있습니다.</Text>
    <NusaButton label="설정에서 연결" onPress={onGoSettings} testID="dashboard-open-settings" />
  </NusaCard></View></View></AiShell>;
}

export default function App() { return <SafeAreaProvider><ThemeProvider initialMode="system"><PersistedThemeBridge><AuthContextProvider><AuthenticatedApp /></AuthContextProvider></PersistedThemeBridge></ThemeProvider></SafeAreaProvider>; }

/** Shown by read-only monitors while the first canonical refresh is still in flight. */
const EMPTY_EVENTS: readonly never[] = [];
const PENDING_REASON = "서버 상태를 확인하는 중입니다.";

function AuthContextProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const [status, setStatus] = useState<AuthStatus>("CHECKING");
  const value = useMemo(() => ({ status, signIn: () => setStatus("SIGNED_IN"), signOut: () => setStatus("SIGNED_OUT") }), [status]);
  useEffect(() => {
    let active = true;
    // Release builds already carry the canonical Cloud origin. Start its DNS/TCP/TLS warm-up
    // immediately instead of waiting for AsyncStorage, while the saved settings read continues in
    // parallel. This is transport-only: it sends no credential and grants no PAPER authority.
    const canonicalAtLaunch = resolveCanonicalCloudOrigin();
    if (canonicalAtLaunch.status === "READY") warmConnection(canonicalAtLaunch.origin);
    void settingsRepository.load().then((stored) => {
      const settings = normalizeSettings(stored ?? DEFAULT_SETTINGS);
      const canonical = canonicalAtLaunch;
      const endpoint = settings.paperEndpoint || (canonical.status === "READY" ? canonical.origin : null);
      if (endpoint == null) return false;
      setConfiguredPaperEndpoint(endpoint);
      // A configured endpoint already means SIGNED_IN whatever the restore returns (see below), so
      // open the shell now instead of holding the splash until the network restore settles. The
      // restore keeps running and the session state reads RECOVERING until it does.
      if (active) setStatus("SIGNED_IN");
      // Cold start and the first launch after an app update use the registered DeviceKey too.
      const native = ownerDeviceCredential();
      if (native == null) return restoreConfiguredPaperSession(endpoint);
      return getOrCreateInstallationId(AsyncStorage)
        .then((deviceId) => restoreConfiguredPaperSession(endpoint, { deviceId, native }))
        .catch(() => restoreConfiguredPaperSession(endpoint));
    }).then((restored) => {
      if (active) setStatus(restored || getConfiguredPaperEndpoint() != null ? "SIGNED_IN" : "SIGNED_OUT");
    }).catch(() => { if (active) { mobileApprovedSession().clearMemory(); setStatus(getConfiguredPaperEndpoint() != null ? "SIGNED_IN" : "SIGNED_OUT"); } });
    return () => { active = false; };
  }, []);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function AuthenticatedApp() {
  const { status: authStatus, signIn, signOut } = useAuth();
  const { theme: appTheme } = useTheme();
  const upbitState = useUpbitReadOnlyState();
  const [activeTab, setActiveTab] = useState<PrimaryDestination>("Home");
  const [detailSurface, setDetailSurface] = useState<DetailSurface>(null);
  const [paperLearningOpen, setPaperLearningOpen] = useState(false);
  const [utilityView, setUtilityView] = useState<UtilityView>(null);
  const [utilityMenuOpen, setUtilityMenuOpen] = useState(false);
  const [operations, setOperations] = useState<PersonalPaperOperationsLoadResult>({ status: "NOT_CONFIGURED", reason: "PAPER connection is not configured." });
  const [initialPaperProjectionResolved, setInitialPaperProjectionResolved] = useState(false);
  const [paperSessionState, setPaperSessionState] = useState<PaperSessionState>("NOT_CONFIGURED");
  // Resume grace (presentation only): remember whether the session was verified when recovery began.
  const resumeGrace = useRef<{ verified: boolean; since: number } | null>(null);
  const lastSessionState = useRef<PaperSessionState>("NOT_CONFIGURED");
  // App launch counts like a resume: a paired device is expected to come up connected.
  const launchPending = useRef(true);
  const [, setGraceTick] = useState(0);
  if (paperSessionState === "RECOVERING" && resumeGrace.current == null) resumeGrace.current = { verified: lastSessionState.current === "VERIFIED" || launchPending.current, since: Date.now() };
  if (paperSessionState !== "RECOVERING") resumeGrace.current = null;
  if (paperSessionState !== "NOT_CONFIGURED") launchPending.current = false;
  lastSessionState.current = paperSessionState;
  useEffect(() => {
    if (paperSessionState !== "RECOVERING") return;
    const timer = setTimeout(() => setGraceTick((tick) => tick + 1), RESUME_GRACE_MS + 50);
    return () => clearTimeout(timer);
  }, [paperSessionState]);
  const shownSessionState = displaySessionState(paperSessionState, resumeGrace.current?.verified === true, resumeGrace.current == null ? 0 : Date.now() - resumeGrace.current.since);
  // Inside the resume grace the transient not-configured projection that RECOVERING leaves behind
  // stays quiet (see graceNotConfigured); genuine read failures are never hidden.
  const launchedAt = useRef(Date.now());
  const launchQuiet = launchSettling(Date.now() - launchedAt.current);
  useEffect(() => {
    if (!launchQuiet) return;
    const remaining = Math.max(0, LAUNCH_GRACE_MS - (Date.now() - launchedAt.current)) + 50;
    const timer = setTimeout(() => setGraceTick((tick) => tick + 1), remaining);
    return () => clearTimeout(timer);
  }, [launchQuiet]);
  const resumingQuietly = shownSessionState !== paperSessionState || launchQuiet;
  const [shadowOperations, setShadowOperations] = useState<ShadowOperationsLoadResult>({ status: "NOT_CONFIGURED", reason: "SHADOW observability is not configured." });
  const [realReadOnlyOperations, setRealReadOnlyOperations] = useState<RealReadOnlyOperationsLoadResult>({ status: "NOT_CONFIGURED", reason: "REAL_READ_ONLY observability is not configured." });
  const [liveReadinessOperations, setLiveReadinessOperations] = useState<LiveReadinessOperationsLoadResult>({ status: "NOT_CONFIGURED", reason: "LIVE readiness observability is not configured." });
  const [refreshing, setRefreshing] = useState(false);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<MobileRuntimeSnapshot>(() => initialMobileRuntimeSnapshot());
  // Last-known values for the launch screen only; never a live reading. Called before any early return so the hook order never changes.
  useEffect(() => { if (operations.status === "READY") markStartup("firstData"); }, [operations.status]);
  const cachedSnapshot = useCachedSnapshot(getConfiguredPaperEndpoint() ?? null, operations.status === "READY" ? operations.snapshot : null, appState !== "active");
  const [publicMarkets, setPublicMarkets] = useState<PublicMarketsState>(() => initialPublicMarketsState());
  const [publicRefreshing, setPublicRefreshing] = useState(false);
  const [investmentPercent, setInvestmentPercent] = useState(DEFAULT_SETTINGS.capitalAllocation.investmentPercent);
  const credentialSession = useMemo(() => new InMemoryDashboardCredentialSession(), []);
  const investmentAllocationClient = useMemo(() => createCloudInvestmentAllocationClient({ credentialProvider: credentialSession.credentialProvider }), [credentialSession]);
  const uxTelemetrySessionId = useMemo(() => createUxTelemetrySessionId(), []);
  const [usageTelemetryEnabled, setUsageTelemetryEnabled] = useState(false);
  const watchlistRepository = useMemo(() => new WatchlistRepository(AsyncStorage), []);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshGenerationRef = useRef(0);
  const supplementalRefreshGenerationRef = useRef(0);
  const lastSupplementalRefreshKeyRef = useRef<string>("");
  const publicRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const publicRefreshGenerationRef = useRef(0);
  const publicMarketsRef = useRef<PublicMarketsState>(initialPublicMarketsState());
  const liveMarketsKeyRef = useRef<string>("");
  const runtimeCoordinator = useMemo(() => new MobileRuntimeCoordinator({ load: () => undefined, save: setRuntimeSnapshot }), []);
  const dispatchRuntime = useCallback((event: MobileRuntimeEvent): void => {
    try {
      runtimeCoordinator.dispatch(event);
    } catch {
      try { runtimeCoordinator.dispatch({ type: "RECOVERY_FAILED", reason: "mobile runtime state transition failed" }); } catch { /* remain blocked by the last known state */ }
    }
  }, [runtimeCoordinator]);

  useEffect(() => {
    let active = true;
    void settingsRepository.load().then((stored) => { if (active) setInvestmentPercent(normalizeSettings(stored ?? DEFAULT_SETTINGS).capitalAllocation.investmentPercent); }).catch(() => { if (active) setInvestmentPercent(DEFAULT_SETTINGS.capitalAllocation.investmentPercent); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void settingsRepository.load().then((stored) => { if (active) setUsageTelemetryEnabled(normalizeSettings(stored ?? DEFAULT_SETTINGS).usageTelemetry.enabled); }).catch(() => { if (active) setUsageTelemetryEnabled(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const screenId = paperLearningOpen
      ? "PAPER_EVIDENCE"
      : detailSurface !== null
        ? `MORE_${detailSurface.toUpperCase()}`
        : screenIdForNavigationState(activeTab, utilityView);
    const endpoint = getConfiguredPaperEndpoint();
    void emitUxTelemetryEvent(
      { kind: "SCREEN_VIEW", screenId },
      { baseUrl: endpoint ?? "", credentialProvider: credentialSession.credentialProvider, sessionId: uxTelemetrySessionId, enabled: usageTelemetryEnabled && Boolean(endpoint) }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, detailSurface, paperLearningOpen, utilityView, usageTelemetryEnabled, uxTelemetrySessionId]);

  const refresh = useCallback((): Promise<void> => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const generation = refreshGenerationRef.current;
    const endpoint = getConfiguredPaperEndpoint();
    const sessionState = getPaperSessionState();
    setPaperSessionState(sessionState);
    if (endpoint == null || !isPaperConnectionVerified(endpoint)) {
      // A foreground DeviceKey restore intentionally clears the process-local VERIFIED flag while
      // it proves possession again. RECOVERING is therefore not a configuration loss: preserve
      // the last verified PAPER projections while the runtime remains trading-blocked, then let
      // subscribePaperSessionVerified() refresh them as soon as the proof completes.
      if (endpoint != null && sessionState === "RECOVERING") {
        dispatchRuntime({ type: "RECOVERY_STARTED" });
        return Promise.resolve();
      }
      setOperations({ status: "NOT_CONFIGURED", reason: "PAPER endpoint must be verified in Settings before dashboard credentials can be used." });
      setShadowOperations({ status: "NOT_CONFIGURED", reason: "PAPER endpoint must be verified before SHADOW reads." });
      setRealReadOnlyOperations({ status: "NOT_CONFIGURED", reason: "PAPER endpoint must be verified before REAL_READ_ONLY reads." });
      setLiveReadinessOperations({ status: "NOT_CONFIGURED", reason: "PAPER endpoint must be verified before LIVE readiness reads." });
      const observation = (async () => {
        const result = await loadAnonymousPaperObservation();
        if (generation !== refreshGenerationRef.current) return;
        const current = getConfiguredPaperEndpoint();
        if (current != null && isPaperConnectionVerified(current)) return;
        if (result.status === "READY") setOperations({ status: "READY", snapshot: result.snapshot });
      })();
      const clearObservation = () => { if (refreshInFlightRef.current === observation) refreshInFlightRef.current = null; };
      refreshInFlightRef.current = observation;
      void observation.then(clearObservation, clearObservation);
      return observation;
    }
    dispatchRuntime({ type: "RECOVERY_STARTED" });
    const request = (async () => {
      let result: PersonalPaperOperationsLoadResult;
      try {
        result = await loadPersonalPaperOperations({ baseUrl: endpoint, credentialProvider: credentialSession.credentialProvider });
      } catch (error) {
        dispatchRuntime({ type: "NETWORK_OFFLINE" });
        throw error;
      }
      if (generation !== refreshGenerationRef.current) return;
      const currentEndpoint = getConfiguredPaperEndpoint();
      if (currentEndpoint !== endpoint || !isPaperConnectionVerified(endpoint)) return;
      setOperations(result);
      if (result.status === "READY") {
        const nextVersion = runtimeCoordinator.current().lastPersistedVersion + 1;
        dispatchRuntime({ type: "RECOVERY_MATCHED", version: nextVersion });
      } else {
        dispatchRuntime({ type: "RECOVERY_FAILED", reason: result.reason || "PAPER recovery is unavailable" });
      }
    })();
    refreshInFlightRef.current = request;
    const clearIfCurrent = () => { if (refreshInFlightRef.current === request) refreshInFlightRef.current = null; };
    void request.then(clearIfCurrent, clearIfCurrent);
    return request;
  }, [credentialSession, dispatchRuntime, runtimeCoordinator]);

  const refreshSupplemental = useCallback((force = false): Promise<void> => {
    const endpoint = getConfiguredPaperEndpoint();
    if (endpoint == null || !isPaperConnectionVerified(endpoint)) return Promise.resolve();
    const surface = paperLearningOpen || activeTab === "Paper" ? "PAPER" : activeTab === "Live" ? "LIVE" : null;
    if (surface == null) return Promise.resolve();
    const key = `${endpoint}:${surface}`;
    if (!force && lastSupplementalRefreshKeyRef.current === key) return Promise.resolve();
    lastSupplementalRefreshKeyRef.current = key;
    const generation = ++supplementalRefreshGenerationRef.current;
    const request = (async () => {
      if (surface === "PAPER") {
        // SHADOW and REAL_READ_ONLY are secondary projections. Fetch them only when the PAPER
        // monitor is actually visible and in parallel, so unavailable PAPER_ONLY surfaces cannot
        // delay the HOME cold-start path or the canonical PAPER projection. A 503 is retained as
        // the current unavailable result and is not automatically retried by the 5s PAPER poll.
        const [shadowResult, realResult] = await Promise.all([
          loadShadowOperations({ baseUrl: endpoint, credentialProvider: credentialSession.credentialProvider }),
          loadRealReadOnlyOperations({ baseUrl: endpoint, credentialProvider: credentialSession.credentialProvider }),
        ]);
        if (generation !== supplementalRefreshGenerationRef.current || getConfiguredPaperEndpoint() !== endpoint || !isPaperConnectionVerified(endpoint)) return;
        setShadowOperations(shadowResult);
        setRealReadOnlyOperations(realResult);
        return;
      }
      // LIVE readiness is likewise lazy: HOME/PAPER launch must never wait on a surface that is
      // informational only and carries no activation authority.
      const liveResult = await loadLiveReadinessOperations({ baseUrl: endpoint, credentialProvider: credentialSession.credentialProvider });
      if (generation !== supplementalRefreshGenerationRef.current || getConfiguredPaperEndpoint() !== endpoint || !isPaperConnectionVerified(endpoint)) return;
      setLiveReadinessOperations(liveResult);
    })();
    return request;
  }, [activeTab, credentialSession, paperLearningOpen]);

  const refreshPublicMarkets = useCallback((): Promise<void> => {
    if (publicRefreshInFlightRef.current) return publicRefreshInFlightRef.current;
    const generation = publicRefreshGenerationRef.current;
    const previous = publicMarketsRef.current;
    setPublicRefreshing(true);
    // A refresh in flight is not a stale feed: keep READY until a request actually fails (STALE is set in the failure branch below).
    setPublicMarkets({ ...previous, status: previous.markets === null ? "LOADING" : previous.status, error: null });
    const request = (async () => {
      const [tickerResult, candleResult] = await Promise.allSettled([
        loadUpbitPublicMarkets(),
        loadUpbitPublicCandles({ market: CHART_MARKET }),
      ]);
      if (generation !== publicRefreshGenerationRef.current) return;
      const tickerError = tickerResult.status === "rejected" ? (tickerResult.reason instanceof Error ? tickerResult.reason.message : "Public ticker data is unavailable.") : null;
      if (tickerResult.status === "rejected") {
        const next = previous.markets === null
          ? { ...previous, status: "ERROR" as const, error: tickerError, chartError: null, chartErrorDiagnostic: null }
          : { ...previous, status: "STALE" as const, error: null, chartError: null, chartErrorDiagnostic: null };
        publicMarketsRef.current = next;
        setPublicMarkets(next);
        return;
      }
      const markets = tickerResult.value;
      const selected = markets.find((market) => market.market === CHART_MARKET) ?? null;
      const chartError = candleResult.status === "rejected" ? (candleResult.reason instanceof Error ? candleResult.reason.message : "Public candle data is unavailable.") : null;
      const chartErrorDiagnostic = candleResult.status === "rejected" && candleResult.reason instanceof UpbitPublicQuotationError
        ? candleResult.reason.diagnostic
        : null;
      const next: PublicMarketsState = {
        status: "READY",
        markets,
        candles: candleResult.status === "fulfilled" ? candleResult.value : null,
        currentPrice: selected?.price ?? null,
        error: null,
        chartError,
        chartErrorDiagnostic,
      };
      publicMarketsRef.current = next;
      setPublicMarkets(next);
    })();
    publicRefreshInFlightRef.current = request;
    const clearIfCurrent = () => { if (publicRefreshInFlightRef.current === request) publicRefreshInFlightRef.current = null; setPublicRefreshing(false); };
    void request.then(clearIfCurrent, clearIfCurrent);
    return request;
  }, []);

  const handleLiveTicker = useCallback((ticker: WatchlistMarket): void => {
    recordLocalPaperPublicMarkets([ticker]);
    const previous = publicMarketsRef.current;
    if (previous.markets === null) return;
    const index = previous.markets.findIndex((market) => market.market === ticker.market);
    if (index === -1) return;
    const markets = previous.markets.map((market, position) => (position === index ? ticker : market));
    const next: PublicMarketsState = { ...previous, status: "READY", markets: Object.freeze(markets), currentPrice: ticker.market === CHART_MARKET ? ticker.price : previous.currentPrice };
    publicMarketsRef.current = next;
    setPublicMarkets(next);
  }, []);
  const liveTickerClient = useMemo(() => new UpbitPublicWebSocketClient(handleLiveTicker), [handleLiveTicker]);

  const closeUtility = useCallback(() => setUtilityView(null), []);
  const goSettings = useCallback(() => { setUtilityMenuOpen(false); setUtilityView("SETTINGS"); }, []);
  const navigateHome = useCallback((destination: HomeDestination) => { setUtilityMenuOpen(false); setUtilityView(null); setDetailSurface(null); setActiveTab(destination); }, []);
  const openPaperEvidence = useCallback(() => { setUtilityMenuOpen(false); setUtilityView(null); setActiveTab("More"); setDetailSurface(null); setPaperLearningOpen(true); }, []);
  const openPaperLearning = useCallback(() => { setUtilityMenuOpen(false); setUtilityView(null); setPaperLearningOpen(true); }, []);
  const handleSignOut = useCallback(() => {
    refreshGenerationRef.current += 1; publicRefreshGenerationRef.current += 1; credentialSession.clear(); clearPaperConnectionVerification(); resetUpbitReadOnlyState(); setRefreshing(false); setPublicRefreshing(false);
    const initialPublicState = initialPublicMarketsState(); publicMarketsRef.current = initialPublicState; setPublicMarkets(initialPublicState); liveMarketsKeyRef.current = "";
    setOperations({ status: "NOT_CONFIGURED", reason: "PAPER connection is not configured." }); setShadowOperations({ status: "NOT_CONFIGURED", reason: "SHADOW observability is not configured." }); setRealReadOnlyOperations({ status: "NOT_CONFIGURED", reason: "REAL_READ_ONLY observability is not configured." }); setLiveReadinessOperations({ status: "NOT_CONFIGURED", reason: "LIVE readiness observability is not configured." }); setUtilityMenuOpen(false); setUtilityView(null); setPaperLearningOpen(false); setActiveTab("Home"); void clearCachedSnapshot(); signOut();
  }, [credentialSession, signOut]);

  useEffect(() => {
    if (authStatus !== "SIGNED_IN") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (detailSurface !== null) {
        setDetailSurface(null);
        return true;
      }
      const action = resolveAndroidBackNavigation({
        paperLearningOpen,
        utilityViewOpen: utilityView !== null,
        utilityMenuOpen,
        activeTab,
      });
      if (action === "CLOSE_PAPER_LEARNING") {
        setPaperLearningOpen(false);
        return true;
      }
      if (action === "CLOSE_UTILITY_VIEW") {
        setUtilityView(null);
        return true;
      }
      if (action === "CLOSE_UTILITY_MENU") {
        setUtilityMenuOpen(false);
        return true;
      }
      if (action === "GO_HOME") {
        setUtilityMenuOpen(false);
        setUtilityView(null);
        setPaperLearningOpen(false);
        setActiveTab("Home");
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [activeTab, authStatus, detailSurface, paperLearningOpen, utilityMenuOpen, utilityView]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      setAppState(nextState);
      dispatchRuntime({ type: nextState === "active" ? "APP_FOREGROUND" : "APP_BACKGROUND" });
      // The restore retry backs off to 30s and Android suspends timers while backgrounded, so a
      // long background spell leaves the PAPER session unrestored with no timer due. Resuming asks
      // for it again immediately. No token and no owner action: the approved rotating session is
      // already in secure storage, and a genuinely lapsed one still fails closed.
      if (nextState === "active") {
        // Screen unlock can render before AsyncStorage returns the installation id needed for the
        // silent DeviceKey proof. Project that interval as recovery, not lost configuration.
        // A session proven within WARM_RESUME_MS stays VERIFIED while it re-proves in the background.
        if (getConfiguredPaperEndpoint() != null) {
          if (isWarmResumeFresh()) armWarmResumeCutoff();
          else {
            beginPaperConnectionRecovery();
            setPaperSessionState("RECOVERING");
          }
        }
        const native = ownerDeviceCredential();
        if (native == null) resumePaperConnection();
        else void getOrCreateInstallationId(AsyncStorage).then((deviceId) => resumePaperConnection({ deviceId, native })).catch(() => resumePaperConnection());
      }
      if (nextState === "active" && runtimeCoordinator.current().recovery === "READY") dispatchRuntime({ type: "RECOVERY_STARTED" });
    });
    return () => subscription.remove();
  }, [dispatchRuntime, runtimeCoordinator]);
  useEffect(() => {
    if (authStatus !== "SIGNED_IN") return;
    // Re-project as soon as a background restore verifies, instead of waiting for the next poll.
    // Reset the lazy-surface key because the same endpoint now belongs to a newly proven session.
    return subscribePaperSessionVerified(() => {
      lastSupplementalRefreshKeyRef.current = "";
      void Promise.all([refresh(), refreshSupplemental()]).catch(() => undefined);
    });
  }, [authStatus, refresh, refreshSupplemental]);
  useEffect(() => {
    if (authStatus !== "SIGNED_IN" || appState !== "active") return;
    // Secondary observation is navigation-driven, not part of the 5s startup/polling critical path.
    void refreshSupplemental().catch(() => undefined);
  }, [appState, authStatus, refreshSupplemental]);

  useEffect(() => {
    refreshGenerationRef.current += 1;
    if (authStatus !== "SIGNED_IN" || appState !== "active") return;
    const generation = refreshGenerationRef.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleNext = () => { if (cancelled || generation !== refreshGenerationRef.current) return; timer = setTimeout(() => { timer = null; void refresh().catch(() => undefined).finally(() => { setInitialPaperProjectionResolved(true); scheduleNext(); }); }, PAPER_REFRESH_INTERVAL_MS); };
    void refresh().catch(() => undefined).finally(() => { setInitialPaperProjectionResolved(true); scheduleNext(); });
    return () => { cancelled = true; refreshGenerationRef.current += 1; if (timer !== null) clearTimeout(timer); };
  }, [appState, authStatus, refresh]);

  useEffect(() => {
    publicRefreshGenerationRef.current += 1;
    // Public quotation data is read-only and does not require a Cloud/bootstrap session.
    if (authStatus === "CHECKING" || appState !== "active") return;
    const generation = publicRefreshGenerationRef.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleNext = () => { if (cancelled || generation !== publicRefreshGenerationRef.current) return; timer = setTimeout(() => { timer = null; void refreshPublicMarkets().catch(() => undefined).finally(scheduleNext); }, PUBLIC_REFRESH_INTERVAL_MS); };
    void refreshPublicMarkets().catch(() => undefined).finally(scheduleNext);
    return () => { cancelled = true; publicRefreshGenerationRef.current += 1; if (timer !== null) clearTimeout(timer); };
  }, [appState, authStatus, refreshPublicMarkets]);

  useEffect(() => {
    if (authStatus === "CHECKING" || appState !== "active") { liveTickerClient.disconnect(); return; }
    void liveTickerClient.connect();
    return () => liveTickerClient.disconnect();
  }, [appState, authStatus, liveTickerClient]);
  useEffect(() => {
    if (publicMarkets.markets === null) return;
    const codes = publicMarkets.markets.map((market) => market.market).sort();
    const key = codes.join(",");
    if (key === liveMarketsKeyRef.current) return;
    liveMarketsKeyRef.current = key;
    liveTickerClient.setMarkets(codes);
  }, [publicMarkets.markets, liveTickerClient]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([refresh(), refreshSupplemental(true)]);
    } finally {
      await refreshPublicMarkets().catch(() => undefined);
      setRefreshing(false);
    }
  }, [refresh, refreshPublicMarkets, refreshSupplemental]);

  const entryProfile = getHomeVisualProfile(appTheme.preset);
  if (authStatus === "CHECKING") return <SafeAreaView style={[styles.container, { backgroundColor: appTheme.colors.background }]}><View style={[styles.authContent, { padding: entryProfile.screen.horizontalPadding }]}><WaveMark /><Text style={[styles.brand, { color: appTheme.colors.text }]}>NUSA</Text></View></SafeAreaView>;
  if (authStatus !== "SIGNED_IN") return <SafeAreaView style={[styles.container, { backgroundColor: appTheme.colors.background }]}><View style={[styles.authContent, { padding: entryProfile.screen.horizontalPadding }]}><View style={[styles.authPanel, { maxWidth: entryProfile.screen.maxWidth, gap: entryProfile.density.contentGap }]}><View style={styles.authBrand}><WaveMark /><View><Text style={[styles.brand, { color: appTheme.colors.text }]}>NUSA</Text><Text style={[styles.eyebrow, { color: appTheme.colors.primary }]}>PERSONAL INTELLIGENCE</Text></View></View><Text style={[styles.authHeading, { color: appTheme.colors.text, fontSize: entryProfile.hero.balanceSize * 0.66, letterSpacing: entryProfile.hero.balanceLetterSpacing * 0.35 }]}>개인 PAPER 모드</Text><Text style={[styles.subtitle, { color: appTheme.colors.textMuted, fontSize: entryProfile.type.body, lineHeight: entryProfile.type.bodyLineHeight }]}>개인 기기에서 PAPER 작업공간으로 진입합니다. 서버 자격 증명은 Settings에서 별도로 검증합니다.</Text><View style={[styles.entryBadges, { gap: entryProfile.density.metricGap }]}><StatusChip label="LOCAL ENTRY" tone="neutral" /><StatusChip label="PAPER ONLY" tone="primary" /><StatusChip label="LIVE NONE" tone="info" /></View><NusaButton accessibilityLabel="Start personal mode" label="개인 모드 시작" onPress={signIn} testID="local-entry-submit" /><Text style={[styles.meta, { color: appTheme.colors.textMuted, fontSize: entryProfile.type.meta }]}>이 진입 단계는 계정 인증이 아닙니다. 사용자 신원을 검증하지 않으며 비밀번호를 수집하거나 저장하지 않습니다.</Text></View></View></SafeAreaView>;

  // Do not render owner-action/SETUP projections from placeholder NOT_CONFIGURED state before
  // the first canonical PAPER refresh has classified the configured endpoint/session. Instead of
  // blocking the whole app behind a full-screen gate, the shell renders at once and the pending
  // projection reads as "checking" (no snapshot, no setup prompt, no error). Projection-only: it
  // grants no credential or transport authority.
  const paperProjectionPending = !initialPaperProjectionResolved;

  const snapshot = operations.status === "READY" ? operations.snapshot : null;
  const readOnlyError = !paperProjectionPending && operations.status === "UNAVAILABLE"
    ? operations.failure == null
      ? operations.reason
      : `${operations.reason} [${operations.failure.category} ${operations.failure.route}${operations.failure.httpStatus == null ? "" : ` HTTP ${operations.failure.httpStatus}`} @ ${new Date(operations.failure.observedAt).toISOString()}]`
    : null;
  // Applied once at the source so HOME, PAPER and every screen agree during the resume grace.
  const notConfigured = graceNotConfigured(!paperProjectionPending && operations.status === "NOT_CONFIGURED" ? operations.reason : null, resumingQuietly);
  const marketConnectionState = snapshot?.operations.transport === "ONLINE" ? "CONNECTED" : "UNKNOWN";
  const publicMarketConnectionState = publicMarkets.status === "READY" || publicMarkets.status === "STALE" ? "CONNECTED" : "UNKNOWN";
  const stale = snapshot == null || snapshot.health !== "HEALTHY";
  const ai = snapshot?.ai ?? null;
  const accountCash = snapshot?.portfolio?.account.cash ?? 0;
  const requiresDashboardConnection = notConfigured !== null && utilityView === null && detailSurface === null && activeTab === "Paper";
  const homeShellActive = utilityView === null && detailSurface === null && activeTab === "Home";
  const localPaperReadiness = getLocalPaperLearningReadiness();
  const paperLearningRuntimeStatus = snapshot?.paperLearning?.events?.length ? snapshot.paperLearning.runtimeStatus : snapshot?.paperLearning?.runtimeStatus === "HALTED" || snapshot?.paperLearning?.runtimeStatus === "ERROR" ? snapshot.paperLearning.runtimeStatus : localPaperReadiness.status;
  const paperLearningServerSource = paperProjectionPending ? "PROJECTION_ABSENT" as const : operations.status === "NOT_CONFIGURED" ? "NOT_CONFIGURED" as const : operations.status === "UNAVAILABLE" ? "UNAVAILABLE" as const : snapshot?.paperLearning == null ? "PROJECTION_ABSENT" as const : (snapshot.paperLearning.events?.length ?? 0) > 0 ? "SERVER_STREAM" as const : "PROJECTION_EMPTY" as const;
  const paperLearningState = buildPaperLearningScreen(snapshot?.paperLearning?.events ?? [], paperLearningRuntimeStatus, paperLearningServerSource, snapshot == null ? null : { runtimeHaltReasons: snapshot.operations.runtimeHaltReasons, killSwitchActive: snapshot.operations.killSwitchActive, lastError: snapshot.operations.heartbeat?.lastError });

  return <SafeAreaView style={[styles.container, { backgroundColor: appTheme.colors.background }]}>
    {!homeShellActive ? <View style={[styles.header, { borderBottomColor: appTheme.colors.border }]}><View style={styles.headerInner}><View style={styles.headerBrand}><WaveMark compact /><Text style={[styles.brand, { color: appTheme.colors.text }]}>NUSA</Text></View><Pressable accessibilityLabel="도구" accessibilityRole="button" accessibilityState={{ expanded: utilityMenuOpen, selected: utilityMenuOpen || utilityView !== null }} onPress={() => { if (utilityView !== null) { setUtilityView(null); setUtilityMenuOpen(true); return; } setUtilityMenuOpen((current) => !current); }} style={[styles.utilityButton, { borderColor: utilityMenuOpen || utilityView !== null ? appTheme.colors.primary : "transparent", backgroundColor: utilityMenuOpen || utilityView !== null ? appTheme.colors.primarySoft : "transparent" }]} testID="header-tools-menu"><Text style={[styles.utilityText, { color: utilityMenuOpen || utilityView !== null ? appTheme.colors.primary : appTheme.colors.textMuted }]}>도구</Text></Pressable></View></View> : null}
    {!homeShellActive && utilityMenuOpen ? <View style={[styles.utilityMenu, { backgroundColor: appTheme.colors.surface, borderBottomColor: appTheme.colors.border }]} testID="header-tools-tray"><View style={styles.utilityMenuInner}>{(["NOTIFICATIONS", "SETTINGS"] as const).map((view) => <Pressable key={view} accessibilityLabel={utilityLabels[view]} accessibilityRole="button" onPress={() => { setUtilityMenuOpen(false); setUtilityView(view); }} style={[styles.utilityMenuButton, { borderColor: appTheme.colors.border, backgroundColor: appTheme.colors.surfaceSunken }]} testID={view === "NOTIFICATIONS" ? "header-notifications" : "header-settings"}><Text style={[styles.utilityText, { color: appTheme.colors.text }]}>{view === "NOTIFICATIONS" ? "알림" : "설정"}</Text></Pressable>)}</View></View> : null}
    {utilityView ? <View style={[styles.utilityNavigation, { borderBottomColor: appTheme.colors.border }]} testID="utility-navigation"><View style={styles.utilityNavigationInner}><Text style={[styles.utilityTitle, { color: appTheme.colors.text }]}>{utilityLabels[utilityView]}</Text><Pressable accessibilityLabel={`${utilityLabels[utilityView]} 닫기`} accessibilityRole="button" onPress={closeUtility} style={[styles.utilityClose, { borderColor: "transparent", backgroundColor: "transparent" }]} testID="utility-close"><Text style={[styles.utilityText, { color: appTheme.colors.text }]}>닫기</Text></Pressable></View></View> : null}

    <SafetyLine line={buildSafetyLine({ sessionState: paperSessionState, resuming: shownSessionState !== paperSessionState, runtimeHalted: snapshot?.paperLearning?.runtimeStatus === "HALTED", dataUnconfirmed: !paperProjectionPending && (snapshot == null || snapshot.health !== "HEALTHY") })} />
    <EventBanner ready={!paperProjectionPending && snapshot?.paperLearning != null} sourceKey={getConfiguredPaperEndpoint() ?? ""} events={snapshot?.paperLearning?.events ?? EMPTY_EVENTS} halted={snapshot?.paperLearning?.runtimeStatus === "HALTED"} />
    <TabTransition transitionKey={`${activeTab}:${detailSurface ?? ""}:${utilityView ?? ""}:${paperLearningOpen ? "learning" : ""}`}>{paperLearningOpen ? <PaperShadowMonitorView paper={paperLearningState} learningFunnel={snapshot?.operations.heartbeat?.learningFunnel ?? null} learningLoop={snapshot?.operations.heartbeat?.learningLoop ?? null} orderBookStudy={snapshot?.operations.heartbeat?.orderBookStudy ?? null} shadow={shadowOperations.status === "READY" ? shadowOperations.snapshot : null} shadowReason={shadowOperations.status === "READY" ? undefined : paperProjectionPending ? PENDING_REASON : shadowOperations.reason} real={realReadOnlyOperations.status === "READY" ? realReadOnlyOperations.snapshot : null} realReason={realReadOnlyOperations.status === "READY" ? undefined : paperProjectionPending ? PENDING_REASON : realReadOnlyOperations.reason} refreshing={refreshing} onRefresh={onRefresh} onClose={() => setPaperLearningOpen(false)} />
      : requiresDashboardConnection ? <DashboardConnectionRequired reason={notConfigured ?? "PAPER 서버 연결이 필요합니다."} onGoSettings={goSettings} />
      : utilityView === "NOTIFICATIONS" ? <NotificationView repository={settingsRepository} />
      : utilityView === "SETTINGS" ? <SettingsView canonicalEndpoint={getConfiguredPaperEndpoint()} credentialSession={credentialSession} exchangeCash={accountCash} onCloudInvestmentPercentSave={investmentAllocationClient.save} onInvestmentPercentChanged={setInvestmentPercent} onSignOut={handleSignOut} repository={settingsRepository} />
      : detailSurface === "Strategies" ? <StrategiesView presentation={{ champion: null, challenger: null, evidenceStatus: "UNAVAILABLE" }} />
      : detailSurface === "Portfolio" ? <PortfolioView error={readOnlyError} investmentPercent={investmentPercent} onOpenPaperLearning={openPaperLearning} onRefresh={onRefresh} refreshing={refreshing} snapshot={snapshot?.portfolio ?? null} upbitError={upbitState.error} upbitSnapshot={upbitState.snapshot} upbitStatus={upbitState.status} />
      : detailSurface === "Order" ? <OrderHistoryView error={readOnlyError} onRefresh={onRefresh} rawOrders={snapshot?.orders ?? null} refreshing={refreshing} />
      : detailSurface === "Performance" ? <PerformanceView screen={buildPerformanceScreen(paperLearningState.performance, paperLearningState.dataSource === "SERVER_STREAM")} onClose={() => setDetailSurface(null)} />
      : detailSurface === "Risk" || detailSurface === "SystemStatus" || detailSurface === "Help" ? <MoreDetailView destination={detailSurface} onClose={() => setDetailSurface(null)} />
      : activeTab === "Paper" ? <PaperShadowMonitorView paper={paperLearningState} learningFunnel={snapshot?.operations.heartbeat?.learningFunnel ?? null} learningLoop={snapshot?.operations.heartbeat?.learningLoop ?? null} orderBookStudy={snapshot?.operations.heartbeat?.orderBookStudy ?? null} shadow={shadowOperations.status === "READY" ? shadowOperations.snapshot : null} shadowReason={shadowOperations.status === "READY" ? undefined : paperProjectionPending ? PENDING_REASON : shadowOperations.reason} real={realReadOnlyOperations.status === "READY" ? realReadOnlyOperations.snapshot : null} realReason={realReadOnlyOperations.status === "READY" ? undefined : paperProjectionPending ? PENDING_REASON : realReadOnlyOperations.reason} refreshing={refreshing} onRefresh={onRefresh} onClose={() => setActiveTab("Home")} />
      : activeTab === "Futures" ? <FuturesView futures={stale ? null : (snapshot?.operations.heartbeat as { readonly futures?: unknown } | null | undefined)?.futures ?? null} />
      : activeTab === "Live" ? <LiveReadinessMonitorView snapshot={liveReadinessOperations.status === "READY" ? liveReadinessOperations.snapshot : null} unavailableReason={liveReadinessOperations.status === "READY" ? undefined : paperProjectionPending ? PENDING_REASON : liveReadinessOperations.reason} unavailableKind={paperProjectionPending ? "PENDING" : liveReadinessOperations.status === "NOT_CONFIGURED" ? "SETUP" : "FAILED"} refreshing={refreshing} onRefresh={onRefresh} />
      : activeTab === "More" ? <MoreMenuView heartbeat={stale ? null : snapshot?.operations.heartbeat ?? null} onOpen={(destination: MoreDestination) => {
          if (destination === "Strategies") setDetailSurface("Strategies");
          else if (destination === "Portfolio") setDetailSurface("Portfolio");
          else if (destination === "PaperEvidence") { setDetailSurface(null); setPaperLearningOpen(true); }
          else if (destination === "OrderHistory") setDetailSurface("Order");
          else if (destination === "Notifications") setUtilityView("NOTIFICATIONS");
          else if (destination === "Settings") setUtilityView("SETTINGS");
          else if (destination === "Risk" || destination === "Performance" || destination === "SystemStatus" || destination === "Help") setDetailSurface(destination);
        }} />
      : <HomeView snapshot={snapshot} cachedSnapshot={cachedSnapshot} investmentPercent={investmentPercent} readOnlyError={readOnlyError} notConfigured={notConfigured} sessionRecovering={shownSessionState === "RECOVERING"} refreshing={refreshing} publicMarket={CHART_MARKET} publicMarkets={publicMarkets.markets} publicCandles={publicMarkets.candles} publicCurrentPrice={publicMarkets.currentPrice} publicMarketConnectionState={publicMarketConnectionState} publicMarketStale={publicMarkets.status !== "READY"} onRefresh={onRefresh} onGoSettings={goSettings} onNavigate={navigateHome} onOpenPaperLearning={openPaperLearning} />}</TabTransition>

    <PrimaryNavigation activeDestination={activeTab} obscured={paperLearningOpen || utilityView !== null || detailSurface !== null} onNavigate={(destination) => { setUtilityMenuOpen(false); setUtilityView(null); setDetailSurface(null); setPaperLearningOpen(false); setActiveTab(destination); }} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  container: theme.container,
  authContent: { flex: 1, justifyContent: "center", padding: 24, alignItems: "center" }, authPanel: { width: "100%", maxWidth: 640, gap: 16 }, authBrand: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 8 }, authHeading: { fontSize: 29, fontWeight: "700", letterSpacing: -0.8 }, subtitle: { fontSize: 14, lineHeight: 21 }, entryBadges: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  header: { minHeight: 50, borderBottomWidth: StyleSheet.hairlineWidth, alignItems: "center" }, headerInner: { width: "100%", maxWidth: 1080, paddingHorizontal: 18, paddingVertical: 3, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, headerBrand: { flexDirection: "row", alignItems: "center", gap: 8 }, brand: { fontSize: 18, fontWeight: "600", letterSpacing: 1.8 }, eyebrow: { fontSize: labelFont(8), fontWeight: "500", letterSpacing: 1.35, marginTop: -1 },
  utilityButton: { minWidth: 48, minHeight: 48, paddingHorizontal: 10, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" }, utilityText: { fontSize: readableFont(11), fontWeight: "500" }, utilityMenu: { minHeight: 52, borderBottomWidth: 1, alignItems: "center" }, utilityMenuInner: { width: "100%", maxWidth: 1080, paddingHorizontal: 20, paddingVertical: 6, flexDirection: "row", gap: 8, alignItems: "center" }, utilityMenuButton: { flex: 1, minHeight: 48, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" }, utilityNavigation: { minHeight: 48, borderBottomWidth: 1, alignItems: "center" }, utilityNavigationInner: { width: "100%", maxWidth: 1080, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, utilityTitle: { fontSize: 14, fontWeight: "700" }, utilityClose: { minWidth: 48, minHeight: 48, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  connectionState: { flex: 1, justifyContent: "center", padding: 20, alignItems: "center" }, connectionStateInner: { width: "100%", maxWidth: 720 }, cardHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10 }, cardEyebrow: { fontSize: labelFont(10), fontWeight: "500", letterSpacing: 1.2, marginBottom: 4 }, cardTitle: { fontSize: 18, fontWeight: "700", letterSpacing: -0.4 }, body: { fontSize: 13, lineHeight: 20 }, meta: { fontSize: 12, lineHeight: 18 },
  navigationFrame: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0, alignItems: "center" }, navigation: { width: "100%", maxWidth: 720, borderTopWidth: StyleSheet.hairlineWidth, borderWidth: 0, borderRadius: 0, alignItems: "center", shadowOpacity: 0, shadowRadius: 0, shadowOffset: { width: 0, height: 0 }, elevation: 0 }, navigationInner: { width: "100%", flexDirection: "row", padding: 0, gap: 0 }, navItem: { flex: 1, minHeight: 50, borderRadius: 0, alignItems: "center", justifyContent: "center", gap: 4, paddingHorizontal: 4 }, navIndicator: { height: 2, width: 20, borderRadius: 999 }, navLabel: { fontSize: readableFont(11), fontWeight: "700", letterSpacing: 0 }, navLabelActive: { fontWeight: "600", letterSpacing: 0 },
});
