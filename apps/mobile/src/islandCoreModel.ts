import { type WavePulse } from "./waveCoreModel";

/**
 * Pure model for the Now tab's island (owner-chosen 2026-10-28; NUSA means "island"): stacked hairlines drawn as a small island over
 * the sea, seen in perspective. Rows run from the back (d = 0, near the horizon) to the front (d = 1). The same real signals drive it
 * as the wave did: a decision rise sends a band of light from the front row to the back (pink for an order), a fill washes the island
 * white, and without data it sinks flat and grey. Presentation only; it draws counts the screen already has and invents nothing.
 */
export const ISLAND_ROWS = 32;
export const ISLAND_STEPS = 90;
/** Vertical layout as shares of the box height: horizon of the back row, the shoreline (front row) and the end of the sea ripples. */
export const ISLAND_HORIZON = 0.2;
export const ISLAND_SHORE = 0.66;
export const ISLAND_SEA_END = 0.84;
/** A row is land where its height (in px) is above this share of its own height scale; below it the row is open sea and is not drawn. */
export const ISLAND_LAND_EPS = 0.035;

interface Peak { readonly u: number; readonly d: number; readonly su: number; readonly sd: number; readonly h: number }
const PEAKS: readonly Peak[] = [
  { u: 0.46, d: 0.55, su: 0.17, sd: 0.32, h: 1.2 },
  { u: 0.62, d: 0.65, su: 0.1, sd: 0.2, h: 0.5 },
  { u: 0.8, d: 0.8, su: 0.05, sd: 0.08, h: 0.35 },
];

/** Row baseline y share (0..1 of the box) for depth d: rows pack toward the horizon. */
export const rowBase = (d: number): number => ISLAND_HORIZON + (ISLAND_SHORE - ISLAND_HORIZON) * Math.pow(d, 1.6);
/** Row x span as shares of the width: back rows are narrower. */
export function rowSpan(d: number): readonly [number, number] {
  const m = 0.13 * (1 - d) * (1 - d);
  return [m, 1 - m];
}
/** Height scale of a row as a share of the box height: nearer rows rise taller. */
export const rowLift = (d: number): number => (12 + 58 * Math.pow(d, 1.15)) / 281;

/** Island height (0 = sea) at u (0..1 across) and depth d, breathing with phase, scaled by amp, plus a band of light per swell. */
export function islandHeight(u: number, d: number, phase: number, amp: number, swells: readonly { readonly pos: number; readonly k: number }[]): number {
  let h = 0;
  for (const p of PEAKS) {
    const a = (u - p.u - Math.sin(phase * 0.3 + p.h * 4) * 0.015) / p.su, b = (d - p.d) / p.sd;
    h += p.h * Math.exp(-a * a - b * b);
  }
  h += 0.06 * Math.sin(u * 22 + d * 9 + phase) + 0.04 * Math.sin(u * 41 - d * 13 + phase * 1.6);
  h = Math.max(0, h) * Math.max(0, amp);
  for (const s of swells) {
    const dd = (d - s.pos) / 0.07;
    h += s.k * Math.exp(-dd * dd) * Math.exp(-Math.pow((u - 0.5) / 0.3, 2)) * (h > 0 ? 1 : 0);
  }
  return h * Math.pow(Math.sin(Math.PI * Math.max(0, Math.min(1, u))), 1.6);
}

/** How long a band of light takes from the front row to the back; slower than the wave it replaced so it reads as a glide. */
export const ISLAND_PULSE_MS = 2600;

/** Where a pulse's band of light is, as a depth 0..1 (it travels from the front row to the back, easing in and out); null outside its life. */
export function swellDepth(p: WavePulse, now: number): number | null {
  const k = (now - p.born) / ISLAND_PULSE_MS;
  if (k < 0 || k > 1) return null;
  return 1 - k * k * (3 - 2 * k);
}

/** How strongly a row at depth d is lit by a band at depth pos (0 when far). */
export function rowLight(d: number, pos: number | null): number {
  if (pos == null) return 0;
  const x = (d - pos) / 0.07;
  return Math.exp(-x * x);
}

/** Seconds for the idle tide to cross the island once. Much slower than a decision's band (2.6 s) so it never reads as a signal. */
export const ISLAND_TIDE_PERIOD_S = 18;

/**
 * Idle tide: a very faint band of light that drifts slowly from the back of the island to the front while it is live, so a quiet island
 * is never still. Its strength is capped at 0.16, far below a real decision's band (1.0), and it is 0 when `live` is false or the
 * island is grey, so it can never be mistaken for a decision, an order or a fill.
 */
export function tideLight(d: number, phase: number, live: boolean): number {
  if (!live || !Number.isFinite(phase)) return 0;
  const pos = ((phase / ISLAND_TIDE_PERIOD_S) % 1 + 1) % 1;
  const x = (d - pos) / 0.18;
  return 0.16 * Math.exp(-x * x);
}

/** How long the sea keeps the flash of a new decision (ms). */
export const SEA_FLASH_MS = 900;

/** The sea answers a new decision: brightest as its band leaves the front row, fading out over SEA_FLASH_MS. 0..1, never negative. */
export function seaFlash(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > SEA_FLASH_MS) return 0;
  const k = ageMs / SEA_FLASH_MS;
  return (1 - k) * (1 - k);
}

/** Sideways drift of a whole contour row in px, so the lines slide a little against each other (parallax) and the island never looks rigid. */
export function rowShiftPx(phase: number, d: number, width: number): number {
  return Math.sin(phase * 0.45 + d * 5.5) * width * 0.004 * (0.4 + 0.6 * Math.max(0, Math.min(1, d)));
}

/** Move `current` towards `target` at `rate` per second (exponential, never overshoots); used to glide the summit badge. */
export function easeToward(current: number, target: number, dt: number, rate: number): number {
  if (!Number.isFinite(current)) return Number.isFinite(target) ? target : 0;
  if (!Number.isFinite(target)) return current;
  const f = 1 - Math.exp(-Math.max(0, rate) * Math.max(0, Math.min(0.1, dt)));
  return current + (target - current) * f;
}

/** A slow twinkle (0.7..1) for star i: stars glint at their own pace and never blink. */
export function starTwinkle(i: number, phase: number): number {
  return 0.85 + 0.15 * Math.sin(phase * 0.8 + i * 1.7);
}

/** Share of the island's width over which its two ends fade into the sea. */
export const ISLAND_END_FADE = 0.14;

/** Lines of sea under the island, from the shore (t = 0) towards the viewer (t = 1). */
export const SEA_LINES = 9;

/**
 * Vertical offset in px of a sea line at u (0..1 across): two waves of different length and opposite drift interfere, and the swing
 * grows towards the viewer (perspective), so the sea reads as water instead of a ruled line. Bounded by seaWaveReach(t).
 */
export function seaWave(u: number, t: number, k: number, phase: number): number {
  const reach = 0.5 + 1.8 * Math.max(0, Math.min(1, t));
  return reach * (0.65 * Math.sin(u * 11 + k * 0.9 + phase * 1.6) + 0.35 * Math.sin(u * 23 - phase * 2.4 + k * 1.7));
}
export const seaWaveReach = (t: number): number => 0.5 + 1.8 * Math.max(0, Math.min(1, t));

/** A slow shimmer (0.64..1) that multiplies a sea line's opacity so the water glints without blinking. */
export function seaShimmer(k: number, phase: number): number {
  return 0.82 + 0.18 * Math.sin(phase * 1.1 + k * 1.3);
}

/** Points of light that drift and glint on the water. */
export const SEA_GLINTS = 14;
const frac = (x: number): number => x - Math.floor(x);

/**
 * One glint on the sea: where it sits (depth t from the shore, across u), and how bright it is right now. Each glint drifts slowly
 * sideways and swells and fades smoothly (a cubed half-sine, so it is mostly dim and briefly bright, never a hard blink).
 * Deterministic in (i, phase): nothing random, so every frame follows the last.
 */
export function seaGlint(i: number, phase: number): { readonly t: number; readonly u: number; readonly a: number } {
  const t = frac(i * 0.61803 + 0.13);
  const u = frac(i * 0.37 + 0.21 + phase * (0.012 + 0.006 * (i % 3)));
  const swell = Math.max(0, Math.sin(phase * (0.55 + 0.17 * (i % 4)) + i * 2.1));
  return { t, u, a: swell * swell * swell };
}

/** A soft highlight that slowly travels along the shoreline: centre (0..1 across) and strength (0.25..1). */
export function shoreShine(phase: number): { readonly x: number; readonly a: number } {
  return { x: 0.5 + 0.5 * Math.sin(phase * 0.21), a: 0.625 + 0.375 * Math.sin(phase * 0.13 + 1) };
}

/** Stroke width of a sea line: thicker next to the shore where the island is reflected, finer towards the viewer. */
export const seaLineWidth = (t: number): number => 0.7 + 0.5 * (1 - Math.max(0, Math.min(1, t)));

/**
 * The lowest part of a contour fades by HEIGHT, smoothly and with one stroke per row: the line is painted with a vertical gradient that
 * is fully transparent at `eps * 0.5` above the row's base and fully opaque from `eps * 4.5`, so a contour fades into the sea instead of being
 * cut into pieces (the cut left stray dashes that appeared and vanished as the island breathed). `base` and `lift` are in px; returns the two
 * y positions of the gradient, or null for a negative eps (a grey island draws everything at full strength).
 */
export function lowFadeY(base: number, lift: number, eps: number): { readonly y0: number; readonly y1: number } | null {
  if (!Number.isFinite(base) || !Number.isFinite(lift) || lift <= 0 || !Number.isFinite(eps) || eps < 0) return null;
  return Object.freeze({ y0: base - eps * 0.5 * lift, y1: base - eps * 4.5 * lift });
}

/** The band of light plus a softer, wider tail behind it (toward the front), so the light reads as a glide with a wake and not a dot. */
export function rowGlow(d: number, pos: number | null): number {
  if (pos == null) return 0;
  const tail = (d - (pos + 0.1)) / 0.12;
  return Math.min(1, rowLight(d, pos) + 0.35 * Math.exp(-tail * tail));
}

/** Parallax: front rows drift a little faster than back rows, so the island has depth while it moves. */
export function rowPhase(phase: number, d: number): number {
  return phase * (0.8 + 0.4 * Math.max(0, Math.min(1, d)));
}

/** A slow overall breath (about 3% in height) so a settled island is never perfectly frozen. */
export function islandBreath(phase: number): number {
  return 1 + 0.03 * Math.sin(phase * 0.6);
}

/** Index runs [start, end] of consecutive land points (height above the threshold); open sea between them is not drawn. */
export function landRuns(heights: readonly number[], threshold: number): readonly (readonly [number, number])[] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < heights.length; i += 1) {
    const land = heights[i] > threshold;
    if (land && start < 0) start = i;
    if (!land && start >= 0) { if (i - 1 > start) out.push([start, i - 1]); start = -1; }
  }
  if (start >= 0 && heights.length - 1 > start) out.push([start, heights.length - 1]);
  return out;
}

const hex = (c: readonly number[]): string => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
const STOPS: readonly (readonly [number, readonly number[]])[] = [[0, [88, 52, 180]], [0.35, [124, 84, 255]], [0.65, [72, 118, 255]], [1, [70, 215, 255]]];
/** Row colour by depth: deep violet at the back through blue to cyan at the front; mixed toward `toward` by t. */
export function rowColor(d: number, toward: readonly number[] | null = null, t = 0): string {
  let c: readonly number[] = STOPS[STOPS.length - 1][1];
  for (let i = 1; i < STOPS.length; i += 1) {
    if (d <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i], k = (d - a) / (b - a);
      c = ca.map((v, j) => v + (cb[j] - v) * k);
      break;
    }
  }
  if (toward != null && t > 0) c = c.map((v, j) => v + (toward[j] - v) * Math.min(1, t));
  return hex(c);
}

/** Row opacity: fog toward the back, every fifth row a little stronger, a lit row brighter. */
export const rowOpacity = (d: number, index: number, light: number): number =>
  Math.min(1, (index % 5 === 4 ? 1.25 : 1) * (0.18 + 0.82 * Math.pow(d, 0.9)) + 0.35 * light);

/** A still island for screens that are not the Now tab: how high it stands (0..1), whether it is grey, and the summit badge. */
/** A still island: fixed height, colour and badge from real values. `breathe` lets its contour lines drift slowly (decoration only; it adds no signal). */
export interface IslandStill { readonly lift: number; readonly grey: boolean; readonly badge: string | null; readonly breathe?: boolean }

/** How fast a breathing still island drifts: slower than the live island at rest (0.4), so it reads as calm, not active. */
export const ISLAND_STILL_DRIFT = 0.22;

/** 실거래: the island rises with the share of LIVE readiness gates that pass, and stays grey while LIVE is locked. Real counts only. */
export function liveIsland(passed: number | null, total: number | null): IslandStill {
  if (passed == null || total == null || !Number.isSafeInteger(passed) || !Number.isSafeInteger(total) || total <= 0 || passed < 0 || passed > total) {
    return { lift: 0, grey: true, badge: null };
  }
  return { lift: 0.15 + 0.85 * (passed / total), grey: true, badge: `관문 ${passed} / ${total} 통과`, breathe: true };
}

/** 선물: a low grey island before PAPER futures start; coloured once the server reports it running; no badge text the server did not send. */
export function futuresIsland(started: boolean, headline: readonly [string, string]): IslandStill {
  return started ? { lift: 0.75, grey: false, badge: `${headline[0]} ${headline[1]}`, breathe: true } : { lift: 0.25, grey: true, badge: `${headline[0]} ${headline[1]}`, breathe: true };
}

/** Frame-time smoothing: irregular callbacks would make the drift stutter, so the step used for motion follows the real gap through a low-pass (never above 0.1 s, never negative). */
export function smoothDt(previous: number, raw: number): number {
  const r = Math.max(0, Math.min(0.1, Number.isFinite(raw) ? raw : 0));
  const p = Math.max(0, Math.min(0.1, Number.isFinite(previous) ? previous : 0));
  return p === 0 ? r : p + (r - p) * 0.25;
}

/** How finely each contour line is sampled: full detail while the device keeps up, fewer points when callbacks run long, so a slow phone holds its frame rate instead of dropping it. */
export function islandSteps(averageGapMs: number): number {
  return averageGapMs <= 20 ? ISLAND_STEPS : averageGapMs <= 25 ? 72 : 54;
}

/** Draw every display frame (0) while the device keeps up; hold a steady 33 ms once the average gap between display callbacks passes 25 ms. */
export function islandMinFrameGapMs(averageGapMs: number): number {
  return averageGapMs > 25 ? 33 : 0;
}
