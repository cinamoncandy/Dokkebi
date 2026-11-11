import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RESEARCH_REFRESH_MIN_AVAILABLE_MEMORY_BYTES, RESEARCH_REFRESH_RECORD_FILE, ResearchSnapshotRefresher, parseMemAvailableBytes } from "./researchSnapshotRefresher";

function harness(startAt = 1_000) {
  const dir = mkdtempSync(path.join(tmpdir(), "nusa-refresh-"));
  let now = startAt;
  let free = 900 * 1024 * 1024;
  const lowered: number[] = [];
  const spawned: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv; child: EventEmitter & { pid: number; kill: () => boolean; killed: boolean } }> = [];
  const make = () => new ResearchSnapshotRefresher({
    cloudStateDbPath: path.join(dir, "state.sqlite"),
    cwd: "/opt/nusa/current",
    executable: "/usr/bin/node",
    env: { NUSA_MODE: "PAPER", NODE_OPTIONS: "--max-old-space-size=4096 --enable-source-maps" },
    now: () => now,
    minIntervalMs: 100,
    availableMemoryBytes: () => free,
    lowerPriority: (pid) => { lowered.push(pid); },
    spawn: (command, args, options) => {
      const child = Object.assign(new EventEmitter(), { pid: 4242, killed: false, kill() { this.killed = true; return true; } });
      spawned.push({ command, args, env: options.env, child });
      return child as never;
    },
  });
  return { dir, spawned, lowered, make, advance: (ms: number) => { now += ms; }, setFree: (bytes: number) => { free = bytes; } };
}

test("a refresh never starts when the shared host is low on memory, and is capped and deprioritised when it does", () => {
  const { spawned, lowered, make, setFree } = harness();
  const refresher = make();
  setFree(300 * 1024 * 1024);
  assert.equal(refresher.requestIfDue(), "LOW_MEMORY");
  assert.equal(spawned.length, 0);
  setFree(900 * 1024 * 1024);
  assert.equal(refresher.requestIfDue(), "STARTED", "a low-memory skip is not counted as an attempt");
  assert.equal(spawned[0]!.env.NODE_OPTIONS, "--enable-source-maps --max-old-space-size=256", "the whole Research process tree inherits the heap cap");
  assert.deepEqual(lowered, [4242]);
});

test("runs the canonical Research entrypoint once and never concurrently", () => {
  const { spawned, make } = harness();
  const refresher = make();
  assert.equal(refresher.requestIfDue(), "STARTED");
  assert.equal(refresher.requestIfDue(), "RUNNING");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.command, "/usr/bin/node");
  assert.deepEqual(spawned[0]!.args, [path.join("/opt/nusa/current", "scripts", "run-cloud-research-snapshot.js")]);
});

test("is rate limited across restarts and records the outcome", () => {
  const { dir, spawned, make, advance } = harness();
  const first = make();
  first.requestIfDue();
  spawned[0]!.child.emit("exit", 1);
  const record = JSON.parse(readFileSync(path.join(dir, RESEARCH_REFRESH_RECORD_FILE), "utf8"));
  assert.equal(record.status, "FAILED");
  const restarted = make();
  assert.equal(restarted.requestIfDue(), "NOT_DUE", "a restart must not re-run Research immediately");
  advance(100);
  assert.equal(restarted.requestIfDue(), "STARTED");
  spawned[1]!.child.emit("exit", 0);
  assert.equal(JSON.parse(readFileSync(path.join(dir, RESEARCH_REFRESH_RECORD_FILE), "utf8")).status, "COMPLETED");
});

test("a spawn failure never throws and stop terminates a running refresh", () => {
  const unavailable = new ResearchSnapshotRefresher({ cloudStateDbPath: ":memory:" });
  assert.equal(unavailable.requestIfDue(), "UNAVAILABLE");
  const { dir } = harness();
  const throwing = new ResearchSnapshotRefresher({ cloudStateDbPath: path.join(dir, "state.sqlite"), availableMemoryBytes: () => 900 * 1024 * 1024, spawn: () => { throw new Error("EAGAIN"); } });
  assert.equal(throwing.requestIfDue(), "UNAVAILABLE");
  const { spawned, make } = harness();
  const refresher = make();
  refresher.requestIfDue();
  refresher.stop();
  assert.equal(spawned[0]!.child.killed, true);
  assert.equal(refresher.requestIfDue(), "UNAVAILABLE");
});

test("the memory floor is 350 MB of available memory, checked at the boundary", () => {
  const { spawned, make, setFree } = harness();
  const refresher = make();
  assert.equal(RESEARCH_REFRESH_MIN_AVAILABLE_MEMORY_BYTES, 350 * 1024 * 1024);
  setFree(RESEARCH_REFRESH_MIN_AVAILABLE_MEMORY_BYTES - 1);
  assert.equal(refresher.requestIfDue(), "LOW_MEMORY");
  setFree(RESEARCH_REFRESH_MIN_AVAILABLE_MEMORY_BYTES);
  assert.equal(refresher.requestIfDue(), "STARTED");
  assert.equal(spawned.length, 1);
});

test("MemAvailable is parsed from /proc/meminfo, and anything unusable is rejected", () => {
  const sample = "MemTotal:         977000 kB\nMemFree:           64000 kB\nMemAvailable:     405000 kB\nBuffers:           10000 kB\n";
  assert.equal(parseMemAvailableBytes(sample), 405000 * 1024, "the host reading from the diagnosis: free is tiny, available is not");
  assert.equal(parseMemAvailableBytes("MemTotal: 1 kB\nMemFree: 1 kB\n"), undefined);
  assert.equal(parseMemAvailableBytes("MemAvailable: lots kB\n"), undefined);
  assert.equal(parseMemAvailableBytes(""), undefined);
});
