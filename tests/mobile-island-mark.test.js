"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { islandMarkStrokes, ISLAND_MARK_GRADIENT } = require("../dist/apps/mobile/src/islandMarkModel.js");
const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");

test("the in-app island mark stays on its 24 grid with nested domes that never cross", () => {
  const strokes = islandMarkStrokes(3);
  assert.equal(strokes.length, 5, "three domes, the horizon and one ripple");
  for (const s of strokes) for (const n of s.d.match(/-?\d+(\.\d+)?/g).map(Number)) assert.ok(n >= 0 && n <= 24);
  const peaks = strokes.slice(0, 3).map((s) => Number(s.d.match(/C[\d.]+,[\d.]+ [\d.]+,([\d.]+)/)[1]));
  assert.ok(peaks[0] < peaks[1] && peaks[1] < peaks[2], "each inner dome peaks lower than the one outside it");
  assert.deepEqual([...ISLAND_MARK_GRADIENT], ["#7C54FF", "#4F7BFF", "#46D7FF"]);
});

test("the launcher drawables are exactly what the island icon generator writes", () => {
  const res = "apps/mobile/android/app/src/main/res";
  const files = ["drawable/ic_nusa_logo_foreground.xml", "drawable/ic_nusa_logo.xml", "drawable/ic_nusa_splash.xml", "drawable/ic_nusa_logo_monochrome.xml", "drawable/ic_nusa_notification.xml", "mipmap-anydpi-v24/ic_launcher.xml", "mipmap-anydpi-v24/ic_launcher_round.xml"];
  const before = files.map((f) => read(`${res}/${f}`));
  execFileSync(process.execPath, ["scripts/generate-island-icon.js"], { stdio: "ignore" });
  assert.deepEqual(files.map((f) => read(`${res}/${f}`)), before, "regenerate with node scripts/generate-island-icon.js");
});

test("the brand row and learning cards carry the island mark; learning cards keep no aura parts", () => {
  assert.match(read("apps/mobile/src/nowView.tsx"), /<View style=\{styles\.brandLeft\}><IslandMark size=\{18\} \/><Text style=\{styles\.brand\}>NUSA<\/Text><\/View>/);
  const learning = read("apps/mobile/src/learningPanels.tsx");
  assert.equal((learning.match(/<Deco \/>/g) || []).length, 5);
  assert.match(learning, /<IslandMark size=\{40\} opacity=\{0\.32\} \/>/);
  assert.doesNotMatch(learning, /auraKit|AuraCard/);
});
