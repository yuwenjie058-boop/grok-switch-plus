// Tests for what the guardian's writes and its own health claims must survive:
//   * a rename that a power loss could roll back (directory fsync, R9)
//   * an adopted fingerprint baseline (an unproven provenance change, R10)
//   * a busy-supervisor restart wait that is abandoned without proof (R11)
//   * a deferred stock repair that must not read as "healthy" (R12)
//   * a keeper heartbeat that names a pid which is not the keeper (R13)
//   * tmp files a killed writer left behind (R20)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "0.8.4-cloud.6";
const STOCK = 'var BasePromptExecutor, BasePromptBuilder;\nfunction createCursorSandInference() {}\nfunction createHostInference() { return {}; }\n';
const require = createRequire(import.meta.url);
const KEEPER_SCRIPT = "/workspace/grok-switch/watchdog-keeper.cjs";
const TMP_PREFIXES = ["watchdog.json.", "watchdog-daemon.beat.json."];

// `dirFsyncFails` emulates a platform or filesystem that refuses to open a
// directory - the write must still succeed there.
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-durable-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, "cfg");
  const host = path.join(dir, "host-main.cjs");
  const proc = path.join(dir, "proc");
  const sup = path.join(dir, "sup");
  const varDir = path.join(dir, "keeper-var");
  for (const p of [cfg, proc, sup, varDir]) fs.mkdirSync(p);
  fs.writeFileSync(path.join(proc, "stat"), "btime 1\n");
  const configPath = path.join(cfg, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ active: "relay", providers: { relay: { protocol: "openai-chat", baseUrl: "https://relay.invalid/v1", model: "gpt-6-astra", apiKey: "fixture-secret-never-log" } } }));
  const self = path.join(dir, "self.cjs");
  fs.writeFileSync(self, "// GROK_SWITCH_PAYLOAD_BEGIN\n// fixture payload\n// GROK_SWITCH_PAYLOAD_END\n");

  // Records what a POSIX-style writer would have done with a directory fd, so
  // the fsync is observable on platforms that cannot open a directory at all.
  const ops = [];
  const hookedFs = {
    ...fs,
    openSync(target, ...args) {
      if (typeof target === "string") {
        let stat = null;
        try { stat = fs.statSync(target); } catch (_error) {}
        if (stat != null && stat.isDirectory()) {
          ops.push({ op: "openDir", target });
          return { __dir: target };
        }
      }
      return fs.openSync(target, ...args);
    },
    fsyncSync(fd) {
      if (fd != null && typeof fd === "object" && fd.__dir != null) {
        ops.push({ op: "fsyncDir", target: fd.__dir });
        if (overrides.dirFsyncFails) { const error = new Error("EINVAL: invalid argument, fsync"); error.code = "EINVAL"; throw error; }
        return;
      }
      return fs.fsyncSync(fd);
    },
    closeSync(fd) {
      if (fd != null && typeof fd === "object" && fd.__dir != null) { ops.push({ op: "closeDir", target: fd.__dir }); return; }
      return fs.closeSync(fd);
    },
    renameSync(from, to) { ops.push({ op: "rename", target: String(to) }); return fs.renameSync(from, to); }
  };

  const stdoutLines = [];
  const env = { ...process.env, GROK_SWITCH_DIR: cfg, GROK_SWITCH_HOST: host, GROK_SWITCH_PROC: proc, GROK_SWITCH_SUPERVISOR_DIR: sup, GROK_SWITCH_KEEPER_VAR: varDir };
  const context = vm.createContext({
    require: (id) => (id === "node:fs" ? hookedFs : require(id)),
    module: { exports: {} }, __filename: self, console, setTimeout, clearTimeout, URL, Buffer,
    process: { ...process, env, stdout: { on() {}, write(chunk) { stdoutLines.push(String(chunk)); } }, stderr: { write() {} } }
  });
  for (const name of ["maintenance.cjs", "runtime.cjs", "watchdog.cjs", "cli.cjs"]) {
    const p = path.join(ROOT, "src", name);
    if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, "utf8").replaceAll("__GROK_SWITCH_VERSION__", VERSION).replaceAll("__GROK_SWITCH_RUNTIME_VERSION__", VERSION), context, { filename: name });
  }
  fs.writeFileSync(host, context.cliBuildPatched(STOCK));
  const statePath = path.join(cfg, "watchdog.json");
  const state = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
  const eventsPath = path.join(cfg, "watchdog.log");
  const events = () => fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8") : "";
  // The existing fixtures key /proc/<pid>/stat's starttime off "btime 1", so a
  // process that started at T reports a start of 1000 + floor((T-1000)/10)*10.
  function pid(value, startedAtMs = Date.now() - 1000, cmdline = "node\0" + host + "\0") {
    for (const p of fs.readdirSync(proc)) if (/^\d+$/.test(p)) fs.rmSync(path.join(proc, p), { recursive: true });
    const p = path.join(proc, String(value));
    fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, "cmdline"), cmdline);
    const fields = Array(40).fill("0"); fields[19] = String(Math.floor((startedAtMs - 1000) / 10));
    fs.writeFileSync(path.join(p, "stat"), value + " (node) " + fields.join(" "));
  }
  pid(4242);
  const command = (name, flags = {}) => context.cliCommandWatchdog({ positional: ["watchdog", name], flags });
  const tick = (now) => context.cliWatchdogTick(now);
  const update = (suffix = "v2") => fs.writeFileSync(host, STOCK + "// " + suffix + "\n");
  const receipt = (now, receiptPid = 4243, hash = context.cliHash(fs.readFileSync(host, "utf8"))) => fs.writeFileSync(path.join(cfg, "runtime-status.json"), JSON.stringify({ pid: receiptPid, patchVersion: VERSION, bundleHash: hash, atMs: now }));
  receipt(Date.now(), 4242);
  const heartbeat = (fields) => fs.writeFileSync(path.join(varDir, "grok-switch-keeper.heartbeat.json"), JSON.stringify(Object.assign({ schemaVersion: 2, at: new Date().toISOString(), intervalSec: 300 }, fields)));
  const output = () => stdoutLines.join("");
  const opsFor = (from) => ops.slice(from).map((op) => op.op);
  const tmpPath = (dirPath, name) => path.join(dirPath, name);
  const writeTmp = (target, ageMs) => {
    fs.writeFileSync(target, "a killed writer left this behind\n");
    if (ageMs != null) { const past = new Date(Date.now() - ageMs); fs.utimesSync(target, past, past); }
  };
  const countAdoptions = () => events().split('"event":"fingerprint_baseline_adopted"').length - 1;
  return { context, dir, cfg, host, proc, sup, varDir, self, statePath, configPath, state, events, ops, opsFor, command, tick, update, pid, receipt, heartbeat, output, tmpPath, writeTmp, countAdoptions };
}

// ------------------------------------------------------------------- R9 ---

test("a state write fsyncs the directory that now holds the new name", (t) => {
  const f = fixture(t);
  const from = f.ops.length;
  f.context.cliWatchdogWrite({ schemaVersion: 1, enabled: true, phase: "watching", attempts: {} });
  assert.deepEqual(f.opsFor(from), ["rename", "openDir", "fsyncDir", "closeDir"], "the rename is durable before the write is reported done");
  assert.equal(f.ops[f.ops.length - 2].target, f.cfg, "the directory fsynced is the one holding the state file");
});

test("the heartbeat, the runtime receipt, the host bundle and a manual disable are all made durable", (t) => {
  const f = fixture(t);
  // A manual disable rewrites an existing state; with no state file it is a no-op.
  f.context.cliWatchdogWrite({ schemaVersion: 1, enabled: true, phase: "watching", attempts: {} });
  const cases = [
    ["heartbeat", () => f.context.cliWatchdogDaemonBeat({ event: "test" }), f.cfg],
    ["runtime receipt", () => f.context.grokSwitchPublishRuntimeReceipt(), f.cfg],
    ["manual disable", () => f.context.grokSwitchWithMaintenanceLock(() => f.context.grokSwitchDisableWatchdog("test")), f.cfg],
    ["host bundle", () => f.context.grokSwitchWithMaintenanceLock(() => { const s = f.context.cliBundleSnapshot(); f.context.cliWriteBundle(s.text, s); }), path.dirname(f.host)]
  ];
  for (const [label, run, expectedDir] of cases) {
    const from = f.ops.length;
    run();
    assert.deepEqual(f.opsFor(from), ["rename", "openDir", "fsyncDir", "closeDir"], label + ": the rename is followed by a directory fsync");
    assert.equal(f.ops[f.ops.length - 2].target, expectedDir, label + ": the directory fsynced is the one holding the file");
  }
});

test("a directory that cannot be opened or fsynced does not break the write", (t) => {
  const f = fixture(t, { dirFsyncFails: true });
  const from = f.ops.length;
  f.context.cliWatchdogWrite({ schemaVersion: 1, enabled: true, phase: "watching", attempts: {} });
  assert.deepEqual(f.opsFor(from), ["rename", "openDir", "fsyncDir", "closeDir"], "the attempt is still made");
  assert.equal(f.state().phase, "watching", "and the state file still holds the new state");
  assert.equal(f.context.cliWatchdogRead().enabled, true);
});

// ------------------------------------------------------------------ R10 ---

test("adopting an on-disk fingerprint as the baseline leaves a trace", (t) => {
  const f = fixture(t);
  const before = f.countAdoptions();
  assert.equal(f.context.cliWatchdogAdoptFingerprintBaseline(null, "fingerprint-of-the-build-on-disk", 2), true, "a baseline adopted after unreadable reads is reported");
  assert.equal(f.countAdoptions(), before + 1, "exactly one adoption event lands in watchdog.log");
  assert.match(f.events(), /fingerprint_baseline_adopted/);
  const beat = JSON.parse(fs.readFileSync(path.join(f.cfg, "watchdog-daemon.beat.json"), "utf8"));
  assert.equal(beat.event, "fingerprint_baseline_adopted", "and the heartbeat an outside observer reads says so too");
  assert.equal(f.context.cliWatchdogAdoptFingerprintBaseline("already-established", "fingerprint-of-the-build-on-disk", 0), false, "an established baseline is never re-adopted");
  assert.equal(f.context.cliWatchdogAdoptFingerprintBaseline(null, null, 3), false, "nothing readable is not an adoption");
  assert.equal(f.countAdoptions(), before + 1, "neither case adds a second event");
});

test("the adopted baseline is the build on disk, and a later replacement still stands down", (t) => {
  const f = fixture(t);
  // The process loaded build A; the startup read failed; the first readable read
  // is build B. The baseline becomes B - a build this process never loaded.
  const adopted = f.context.cliWatchdogFingerprintBaseline(null, "build-B");
  assert.equal(adopted, "build-B");
  assert.notEqual(adopted, "build-A");
  assert.equal(f.context.cliWatchdogFingerprintDecision(adopted, "build-B", 0, 3), "ok");
  assert.equal(f.context.cliWatchdogFingerprintDecision(adopted, "build-C", 0, 3), "stale", "a replacement after adoption is still detected");
  assert.equal(f.context.cliWatchdogFingerprintDecision(adopted, null, 1, 3), "unstable");
  assert.equal(f.context.cliWatchdogFingerprintDecision(adopted, null, 3, 3), "stale");
});

// ------------------------------------------------------------------ R12 ---

test("a deferred stock repair is named in the state and in the human status", async (t) => {
  const f = fixture(t);
  await f.command("enable");
  f.update("v2");
  const stockHash = f.context.cliHash(fs.readFileSync(f.host, "utf8"));
  const startedAtMs = 100000;
  const s = f.state();
  s.phase = "watching";
  s.repair = null;
  s.observed = null;
  s.attempts = { [stockHash]: { phase: "restart_requested", startedAtMs: startedAtMs, backupPath: "fixture" } };
  f.context.cliWatchdogWrite(s);
  await f.tick(200000);
  await f.tick(230000);
  const state = f.state();
  assert.equal(state.enabled, true, "cooling down is not a fault");
  assert.equal(state.phase, "watching");
  assert.match(state.notes, /^stock repair deferred until \d{4}-\d\d-\d\dT[\d:.]+Z$/, "the state names the wait instead of leaving a bare 'watching'");
  assert.match(state.notes, new RegExp(new Date(startedAtMs + 6 * 60 * 60 * 1000).toISOString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "and it names the moment the retry becomes possible");
  await f.command("status");
  assert.match(f.output(), /\nnote: stock repair deferred until /, "the human-readable status prints it as a note");
  await f.tick(startedAtMs + 6 * 60 * 60 * 1000 + 1);
  assert.equal(f.state().notes, undefined, "the note goes away once the wait is over");
});

// ------------------------------------------------------------------ R13 ---

test("a keeper heartbeat naming a pid that is not the keeper is not 'alive'", (t) => {
  const f = fixture(t);
  // A recycled pid: the heartbeat is fresh and the pid answers, but nothing about
  // it says keeper - the old check called that "alive".
  f.pid(4242, Date.now() - 1000, "node\0/tmp/some-unrelated-process.cjs\0");
  f.heartbeat({ pid: 4242, uptimeSec: 999999 });
  const recycled = f.context.cliKeeperState();
  assert.equal(recycled.identity, null, "no signal ties that pid to the keeper");
  assert.equal(recycled.alive, false, "so it must not read as alive");

  f.pid(4243, Date.now() - 300000, "node\0" + KEEPER_SCRIPT + "\0run\0");
  f.heartbeat({ pid: 4243, uptimeSec: 300 });
  const byCmdline = f.context.cliKeeperState();
  assert.equal(byCmdline.identity, "cmdline", "a keeper launch is identified from its argv");
  assert.equal(byCmdline.alive, true);

  // An unrelated argv, but a start time that agrees with the reported uptime.
  f.pid(4244, Date.now() - 300000, "node\0/tmp/some-unrelated-process.cjs\0");
  f.heartbeat({ pid: 4244, uptimeSec: 300 });
  const byStart = f.context.cliKeeperState();
  assert.equal(byStart.identity, "starttime", "the start time is the fallback signal");
  assert.equal(byStart.alive, true);

  f.heartbeat({ pid: 4244, uptimeSec: 30000 });
  assert.equal(f.context.cliKeeperState().alive, false, "an uptime that disagrees with the pid's start time is not the keeper");
});

// ------------------------------------------------------------------ R20 ---

test("stale tmp files from a killed writer are swept, live ones are left alone", (t) => {
  const f = fixture(t);
  const stale = 2 * 60 * 60 * 1000;
  const staleState = f.tmpPath(f.cfg, "watchdog.json.999.deadbeef.tmp");
  const staleBeat = f.tmpPath(f.cfg, "watchdog-daemon.beat.json.999.deadbeef.tmp");
  const freshState = f.tmpPath(f.cfg, "watchdog.json.999.fresh.tmp");
  const notTmp = f.tmpPath(f.cfg, "watchdog.json.bak");
  const staleBundle = f.tmpPath(path.dirname(f.host), "host-main.cjs.grok-switch-999.deadbeef.tmp.cjs");
  for (const target of [staleState, staleBeat, freshState, notTmp, staleBundle]) f.writeTmp(target);
  f.writeTmp(staleState, stale);
  f.writeTmp(staleBeat, stale);
  f.writeTmp(staleBundle, stale);
  fs.mkdirSync(f.tmpPath(f.cfg, "watchdog.json.999.dir.tmp"));
  f.context.cliWatchdogWrite({ schemaVersion: 1, enabled: true, phase: "watching", attempts: {} });
  assert.equal(fs.existsSync(staleState), false, "a tmp file a killed writer left an hour ago is collected");
  assert.equal(fs.existsSync(staleBeat), false);
  assert.equal(fs.existsSync(freshState), true, "a tmp file a live writer may still be holding is not");
  assert.equal(fs.existsSync(notTmp), true, "a name that is not a tmp file is never touched");
  assert.equal(fs.existsSync(f.tmpPath(f.cfg, "watchdog.json.999.dir.tmp")), true, "and neither is a directory that merely looks like one");
  assert.equal(fs.existsSync(staleBundle), true, "the host directory is a separate sweep");
  f.context.grokSwitchWithMaintenanceLock(() => { const s = f.context.cliBundleSnapshot(); f.context.cliWriteBundle(s.text, s); });
  assert.equal(fs.existsSync(staleBundle), false, "the stale host bundle candidate is collected where it is left");
});
