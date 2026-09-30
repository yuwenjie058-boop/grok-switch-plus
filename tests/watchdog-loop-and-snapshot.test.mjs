// Regression gate for the two guardian paths that had no executable test:
//
//   * cliBundleSnapshot() must refuse to certify a host bundle whose file
//     identity moved between its two lstats. The official updater swaps
//     host-main.cjs while we read it, and a snapshot of that torn state would
//     later authorize a replacement of bytes nobody ever verified.
//   * cliWatchdogRun(), the daemon main loop, must really stand down when the
//     build on disk changes, publish why, and release the daemon lock so the
//     keeper can relaunch the current build. Only its decision function had
//     assertions; the loop that calls it (and the lock it holds) never did.
//
// Both run in the same vm fixture the other guardian tests use: src/*.cjs is
// loaded into a context whose GROK_SWITCH_DIR / GROK_SWITCH_HOST /
// GROK_SWITCH_PROC / GROK_SWITCH_SUPERVISOR_DIR point at a temp directory. No
// host process, no network and no real time: the loop's 30s sleep is replaced
// by a controllable stand-in that only fires when the test says so.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "0.8.4-cloud.3";
const STOCK = 'var BasePromptExecutor, BasePromptBuilder;\nfunction createCursorSandInference() {}\nfunction createHostInference() { return {}; }\n';
const SELF = "// GROK_SWITCH_PAYLOAD_BEGIN\n// fixture payload\n// GROK_SWITCH_PAYLOAD_END\n";
const HOST_NAME = "host-main.cjs";
const require = createRequire(import.meta.url);

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-loop-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, "cfg");
  const host = path.join(dir, HOST_NAME);
  const proc = path.join(dir, "proc");
  const sup = path.join(dir, "sup");
  for (const p of [cfg, proc, sup]) fs.mkdirSync(p);
  fs.writeFileSync(path.join(proc, "stat"), "btime 1\n");
  fs.writeFileSync(path.join(cfg, "config.json"), JSON.stringify({ active: "relay", providers: { relay: { protocol: "openai-chat", baseUrl: "https://relay.invalid/v1", model: "gpt-6-astra", apiKey: "fixture-secret-never-log" } } }));
  const self = path.join(dir, "self.cjs");
  fs.writeFileSync(self, overrides.selfText || SELF);
  const stdoutLines = [];
  const signals = [];
  const handlers = {};
  const context = vm.createContext({
    require: overrides.require || require,
    module: { exports: {} }, __filename: self, console, URL, Buffer,
    setTimeout: overrides.setTimeout || setTimeout,
    clearTimeout: overrides.clearTimeout || clearTimeout,
    process: {
      ...process,
      env: { ...process.env, GROK_SWITCH_DIR: cfg, GROK_SWITCH_HOST: host, GROK_SWITCH_PROC: proc, GROK_SWITCH_SUPERVISOR_DIR: sup },
      // A real process here would make the daemon install signal handlers on
      // the test runner; record them instead so the loop's cleanup is visible.
      on(name, handler) { signals.push(["on", name]); handlers[name] = handler; },
      removeListener(name) { signals.push(["off", name]); },
      stdout: { on() {}, write(chunk) { stdoutLines.push(String(chunk)); } },
      stderr: { write() {} }
    }
  });
  for (const name of ["maintenance.cjs", "runtime.cjs", "watchdog.cjs", "cli.cjs"]) {
    const p = path.join(ROOT, "src", name);
    if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, "utf8").replaceAll("__GROK_SWITCH_VERSION__", VERSION).replaceAll("__GROK_SWITCH_RUNTIME_VERSION__", VERSION), context, { filename: name });
  }
  // CliError is a lexical class declaration, so it is not a property of the
  // context (and instanceof fails across the realm); read its identity in-realm.
  vm.runInContext("function cliErrorTag(error) { return error != null && error.constructor != null ? error.constructor.name : null; }", context);
  fs.writeFileSync(host, context.cliBuildPatched(STOCK));
  const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
  return {
    context, dir, cfg, host, self, signals, handlers,
    lockDir: path.join(cfg, "watchdog-daemon.lock"),
    maintenanceLockDir: path.join(cfg, "maintenance.lock"),
    beat: () => readJson(path.join(cfg, "watchdog-daemon.beat.json")),
    events: () => { const p = path.join(cfg, "watchdog.log"); return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []; },
    output: () => stdoutLines.join("")
  };
}

// Yields the event loop without using timers: the loop under test is parked on
// a stand-in timer, so nothing else can advance it.
async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function withDeadline(promise, ms, message) {
  let timer = null;
  try {
    await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

// Stands in for the loop's `setTimeout(..., 30000)`: the sleep only ends when
// the test fires it, so "the loop reached its sleep" is an observable state
// rather than a 30-second wait. The budget keeps a loop that never stands down
// from spinning forever.
function fakeClock() {
  const pending = [];
  const state = { calls: 0, interval: null };
  return {
    state,
    setTimeout(fn, ms) {
      state.calls += 1;
      state.interval = ms;
      if (state.calls > 64) throw new Error("the daemon loop armed " + state.calls + " sleeps without standing down");
      pending.push(fn);
      return { unref() {}, ref() {} };
    },
    clearTimeout() {},
    fireNext(what) {
      const fn = pending.shift();
      assert.ok(fn, "expected the daemon loop to be parked in a sleep (" + what + ")");
      fn();
    }
  };
}

// --------------------------------------------------------------- snapshot ---

test("a host bundle that changes between its two lstats is never certified", (t) => {
  // Positive control: with nothing writing, the snapshot is taken and hashed.
  const clean = fixture(t);
  const snapshot = clean.context.cliBundleSnapshot();
  assert.equal(snapshot.size, fs.statSync(clean.host).size);
  assert.equal(snapshot.hash, crypto.createHash("sha256").update(fs.readFileSync(clean.host)).digest("hex"));
  assert.equal(snapshot.mtimeMs, fs.statSync(clean.host).mtimeMs);

  // The official updater replaces the bundle in place: the first lstat sees the
  // old identity, the read copies the file, the second lstat sees the new one.
  let hostLstats = 0;
  const swapping = {
    ...fs,
    lstatSync(target, ...args) {
      const stat = fs.lstatSync(target, ...args);
      if (path.basename(String(target)) !== HOST_NAME) return stat;
      hostLstats += 1;
      if (hostLstats !== 2) return stat;
      // Same inode, new size/mtime/ctime - a landed replacement, not a torn read.
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: stat.size + 4096, mtimeMs: stat.mtimeMs + 1000, ctimeMs: stat.ctimeMs + 1000 });
    }
  };
  const f = fixture(t, { require: (id) => (id === "node:fs" ? swapping : require(id)) });
  const thrown = (() => { try { f.context.cliBundleSnapshot(); return null; } catch (error) { return error; } })();
  assert.ok(thrown, "a bundle that moved under the snapshot must not be certified");
  assert.equal(f.context.cliErrorTag(thrown), "CliError", "the refusal is a grok-switch error, not a raw fs error");
  assert.match(thrown.message, /host bundle changed while taking its snapshot/);
  assert.match(thrown.message, /retry after the official update finishes/);
  assert.equal(hostLstats, 2, "the guard compared exactly the before and after lstats");
});

// ------------------------------------------------------------ daemon loop ---

test("the daemon loop stands down on a changed build, publishes it and drops its lock", async (t) => {
  const clock = fakeClock();
  const f = fixture(t, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const run = f.context.cliWatchdogRun();
  const settlement = run.then(() => "resolved", (error) => { throw error; });

  await settle();
  assert.equal(clock.state.calls, 1, "the loop observed once and armed one sleep");
  assert.equal(clock.state.interval, 30000, "and observes every 30s");
  assert.match(f.output(), /watchdog daemon started; observes every 30s/);
  assert.equal(fs.existsSync(f.lockDir), true, "the daemon lock is held while it runs");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.lockDir, "owner.json"), "utf8")).pid, process.pid);
  assert.equal(fs.existsSync(f.maintenanceLockDir), false, "but the maintenance lock is not held while it idles");
  const first = f.beat();
  assert.ok(first, "the first observation published a heartbeat");
  assert.equal(first.event, "disabled");
  assert.equal(first.ticks, 1);

  // A second daemon started while this one runs is refused, and the refusal
  // must not disturb the live daemon's lock.
  await assert.rejects(() => f.context.cliWatchdogRun(), /watchdog daemon already running/);
  assert.equal(fs.existsSync(f.lockDir), true, "the live daemon keeps its lock");
  assert.equal(fs.existsSync(f.maintenanceLockDir), false, "and the refused start cleans up the maintenance lock it took");

  // A build that did not change is not a stand-down: iteration 2 must run.
  clock.fireNext("iteration 1");
  await settle();
  assert.equal(clock.state.calls, 2, "the loop kept observing instead of standing down");

  // Now replace the half the daemon fingerprints (everything after the payload
  // marker) exactly as `install` rewrites the bundle, and let it observe again.
  // The replacement has to land between two sweeps, not inside one: each sweep
  // reads its baseline and the on-disk copy back to back with no await between
  // them, so only the gap between sweeps (30s in production, one fired sleep
  // here) is a real window - which is exactly the window `install` writes in.
  fs.appendFileSync(f.self, "// rebuilt bundle: the half the daemon fingerprints\n");
  clock.fireNext("iteration 2");
  await withDeadline(settlement, 3000, "the daemon loop did not stand down on a changed build");

  const last = f.beat();
  assert.ok(last, "the stand-down published a heartbeat");
  assert.equal(last.event, "stale_build", "the heartbeat an outside observer reads names the reason");
  // Two observations completed (the two sleeps the test fired); the sweep that
  // found the replacement stands down without counting as a third observation.
  assert.equal(last.ticks, 2, "the stand-down itself is not counted as an observation");
  assert.equal(Number.isFinite(last.lastTickAtMs), true, "and the last completed observation is still dated");
  const logged = f.events();
  assert.deepEqual(logged.map((entry) => entry.event), ["stale_build"], "and the event log records it once");
  assert.equal(logged[0].phase, "stale_build");
  assert.equal(logged[0].enabled, true, "for a guardian that is still enabled");
  assert.match(f.output(), /build changed or became unreadable on disk; standing down so the keeper relaunches the current build/);
  assert.equal(fs.existsSync(f.lockDir), false, "the daemon released its lock so the keeper can relaunch");
  assert.deepEqual(f.signals, [["on", "SIGTERM"], ["on", "SIGINT"], ["off", "SIGTERM"], ["off", "SIGINT"]], "and unhooked its signal handlers");
});

test("a signal stops the daemon loop instead of standing it down", async (t) => {
  const clock = fakeClock();
  const f = fixture(t, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const run = f.context.cliWatchdogRun();

  await settle();
  assert.equal(clock.state.calls, 1, "the loop is parked in its sleep");
  f.handlers.SIGTERM();
  await withDeadline(run, 3000, "the daemon loop did not stop when signalled");
  assert.equal(clock.state.calls, 1, "a stop does not wait out the 30s sleep before it ends");
  assert.deepEqual(f.events(), [], "a manual stop is not a stand-down and is not logged as one");
  assert.equal(fs.existsSync(f.lockDir), false, "and it still releases the lock");
  assert.deepEqual(f.signals, [["on", "SIGTERM"], ["on", "SIGINT"], ["off", "SIGTERM"], ["off", "SIGINT"]]);
});
