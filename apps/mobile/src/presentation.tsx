/**
 * Presentation boundary for the mobile app.
 *
 * App.tsx imports every screen presenter, shared primitive and theme provider from here and
 * nowhere else (enforced by tests/mobile-presentation-boundary.test.js). Screen presenters receive
 * already-derived screen models (for example buildHomeFieldInput, buildPaperFieldHeader,
 * buildLiveFieldHeader) and design tokens (designSystem.ts: fieldPalette, fieldMotion; fieldFonts),
 * so a future redesign replaces presenters here without touching data, safety or navigation.
 *
 * The current presenters are the "calm-v1" whole-app redesign (지금 · 기록 · 학습 · 안전). See docs/UI_ARCHITECTURE.md.
 */
export const PRESENTATION = Object.freeze({ id: "calm-v1", status: "INTERIM" as const });

export { NowView as HomeView } from "./nowView";
export type { HomeDestination } from "./homeView";
export { LearningView as PaperShadowMonitorView } from "./learningView";
export { SafetyView as LiveReadinessMonitorView } from "./safetyView";
export { RecordsView as MoreMenuView } from "./recordsView";
export { FuturesView } from "./futuresView";
export { TabTransition } from "./tabTransition";
export { PortfolioView } from "./portfolioView";
export { NotificationView } from "./notificationView";
export { SettingsView } from "./settingsView";
export { OrderHistoryView } from "./orderHistoryView";
export { StrategiesView } from "./strategiesView";
export { MoreDetailView, type TruthfulMoreDetail } from "./moreDetailView";
export { PrimaryNavigation } from "./primaryNavigation";
export { AiShell } from "./aiKit";
export { plainScreenChip } from "./stageTraceModel";
export { SafetyLine } from "./safetyLine";
export { EventBanner } from "./eventBanner";
export { PerformanceView } from "./performanceView";
// Shared primitives and theming the shell renders directly.
export { NusaButton, NusaCard, StatusChip, WaveMark } from "./components";
export { ThemeProvider, useTheme, type ThemePreference } from "./ThemeProvider";
