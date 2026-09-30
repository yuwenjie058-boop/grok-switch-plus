// Tests for the residual-P1 hardening of the guardian surface:
//   * patch identity is the payload, not just the banner version
//   * a drifted (older) patch is a compatible update, not a permanent latch
//   * a single transient 4xx/5xx is not proof the route is broken
//   * the traffic-proof phase is bounded and interruption recovers
//   * the daemon's own build fingerprint detects a torn read
//   * a manual command that changed nothing leaves the guardian on
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
const OLDER = "0.8.4-cloud.2";
const STOCK = 'var BasePromptExecutor, BasePromptBuilder;\nfunction createCursorSandInference() {}\nfunction createHostInference() { return {}; }\n';
const require = createRequire(import.meta.url);
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-harden-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = path.join(dir, "cfg");
  const host = path.join(dir, "host-main.cjs");
  const proc = path.join(dir, "proc");
  const sup = path.join(dir, "sup");
  for (const p of [cfg, proc, sup]) fs.mkdirSync(p);
  fs.writeFileSync(path.join(proc, "stat"), "btime 1\n");
  const configPath = path.join(cfg, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ active: "relay", providers: { relay: { protocol: "openai-chat", baseUrl: "https://relay.invalid/v1", model: "gpt-6-astra", apiKey: "fixture-secret-never-log" } } }));
  const self = path.join(dir, "self.cjs");
  fs.writeFileSync(self, overrides.selfText || "// GROK_SWITCH_PAYLOAD_BEGIN\n// fixture payload\n// GROK_SWITCH_PAYLOAD_END\n");
  const stdoutLines = [];
  const context = vm.createContext({
    require: overrides.require || require,
    module: { exports: {} }, __filename: self, console, setTimeout, clearTimeout, URL, Buffer,
    process: { ...process, env: { ...process.env, GROK_SWITCH_DIR: cfg, GROK_SWITCH_HOST: host, GROK_SWITCH_PROC: proc, GROK_SWITCH_SUPERVISOR_DIR: sup }, stdout: { on() {}, write(chunk) { stdoutLines.push(String(chunk)); } }, stderr: { write() {} } }
  });
  for (const name of ["maintenance.cjs", "runtime.cjs", "watchdog.cjs", "cli.cjs"]) {
    const p = path.join(ROOT, "src", name);
    if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, "utf8").replaceAll("__GROK_SWITCH_VERSION__", VERSION).replaceAll("__GROK_SWITCH_RUNTIME_VERSION__", VERSION), context, { filename: name });
  }
  fs.writeFileSync(host, context.cliBuildPatched(STOCK));
  const statePath = path.join(cfg, "watchdog.json");
  const state = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
  const events = () => { const p = path.join(cfg, "watchdog.log"); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; };
  function pid(value, startedAtMs = Date.now() - 1000) {
    for (const p of fs.readdirSync(proc)) if (/^\d+$/.test(p)) fs.rmSync(path.join(proc, p), { recursive: true });
    const p = path.join(proc, String(value));
    fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, "cmdline"), `node\0${host}\0`);
    const fields = Array(40).fill("0"); fields[19] = String(Math.floor((startedAtMs - 1000) / 10));
    fs.writeFileSync(path.join(p, "stat"), `${value} (node) ${fields.join(" ")}`);
  }
  pid(4242);
  const command = (name, flags = {}) => context.cliCommandWatchdog({ positional: ["watchdog", name], flags });
  const tick = (now) => context.cliWatchdogTick(now);
  const update = (suffix = "v2") => fs.writeFileSync(host, STOCK + `// ${suffix}\n`);
  const receipt = (now, receiptPid = 4243, hash = context.cliHash(fs.readFileSync(host, "utf8"))) => fs.writeFileSync(path.join(cfg, "runtime-status.json"), JSON.stringify({ pid: receiptPid, patchVersion: VERSION, bundleHash: hash, atMs: now }));
  receipt(Date.now(), 4242);
  const log = (entry) => fs.appendFileSync(path.join(cfg, "requests.log"), JSON.stringify(entry) + "\n");
  const age = (ms) => { const past = new Date(Date.now() - ms); fs.utimesSync(host, past, past); };
  const output = () => stdoutLines.join("");
  return { context, dir, cfg, host, sup, configPath, statePath, state, events, command, tick, update, pid, receipt, log, age, self, output };
}

// Brings a fixture to "a repaired host just restarted and is waiting for proof".
async function awaitingTraffic(f) {
  await f.command("enable");
  f.update();
  await f.tick(100000);
  await f.tick(130000);
  fs.unlinkSync(path.join(f.sup, "command.json"));
  f.pid(4243);
  f.receipt(140000);
  await f.tick(140000);
  assert.equal(f.state().phase, "awaiting_traffic");
}

const traffic = (f, status, extra = {}) => f.log({
  ts: new Date(extra.at || 150000).toISOString(), kind: "turn", status, hostPid: 4243, patchVersion: VERSION, provider: "relay", ...extra.entry
});

// ---------------------------------------------------------------- identity ---

test("a payload change under an unmoved banner version still reaches the host", (t) => {
  const f = fixture(t);
  const built = f.context.cliInspectBundle(fs.readFileSync(f.host, "utf8"));
  assert.equal(built.patched, true);
  assert.equal(built.version, VERSION);
  assert.equal(typeof built.patchBlock, "string", "the inspector reports the patch block it found");
  // Same banner, different payload: exactly the case a version-only comparison
  // reads as "unchanged".
  fs.writeFileSync(f.self, "// GROK_SWITCH_PAYLOAD_BEGIN\n// fixture payload v2\n// GROK_SWITCH_PAYLOAD_END\n");
  const before = fs.readFileSync(f.host, "utf8");
  const outcome = f.context.grokSwitchWithMaintenanceLock(() => f.context.cliEnsurePatched());
  assert.equal(outcome, "updated", "a same-version payload drift is an update, not 'unchanged'");
  const after = fs.readFileSync(f.host, "utf8");
  assert.notEqual(after, before);
  assert.equal(f.context.cliInspectBundle(after).version, VERSION);
  assert.match(after, /fixture payload v2/, "the new payload is what the host now carries");
  assert.equal(f.context.grokSwitchWithMaintenanceLock(() => f.context.cliEnsurePatched()), "unchanged", "and it is idempotent afterwards");
});

test("enable refuses a host carrying the same banner with a different payload", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.self, "// GROK_SWITCH_PAYLOAD_BEGIN\n// fixture payload v2\n// GROK_SWITCH_PAYLOAD_END\n");
  await assert.rejects(async () => f.command("enable"), /payload|patch/i);
});

test("a drifted (older) patch is re-patched as a compatible update, not latched off", async (t) => {
  const f = fixture(t);
  await f.command("enable");
  const patched = fs.readFileSync(f.host, "utf8");
  fs.writeFileSync(f.host, patched.replace("// GROK_SWITCH_BEGIN " + VERSION, "// GROK_SWITCH_BEGIN " + OLDER));
  await f.tick(100000);
  assert.equal(f.state().enabled, true, "an upgraded CLI does not disable the guardian");
  assert.equal(f.state().phase, "stabilizing");
  assert.match(f.events(), /patch_drift_observed/);
  await f.tick(130000);
  assert.equal(f.state().phase, "awaiting_restart", "the host is re-patched and gets the one restart");
  assert.equal(f.context.cliInspectBundle(fs.readFileSync(f.host, "utf8")).version, VERSION);
  assert.equal(fs.existsSync(path.join(f.sup, "command.json")), true, "exactly one restart is requested");
  fs.unlinkSync(path.join(f.sup, "command.json"));
  f.pid(4243);
  f.receipt(140000);
  await f.tick(140000);
  assert.equal(f.state().phase, "awaiting_traffic");
  traffic(f, 200);
  await f.tick(150000);
  assert.equal(f.state().phase, "healthy");
  assert.equal(f.state().enabled, true);
});

test("our current patch with edited bytes around it still fails closed", async (t) => {
  const f = fixture(t);
  await f.command("enable");
  fs.appendFileSync(f.host, "\n// someone edited the patched host\n");
  await f.tick(100000);
  assert.equal(f.state().enabled, false);
  assert.equal(f.state().phase, "failed");
  assert.equal(f.state().disabledReason, "patched_host_changed");
});

// ------------------------------------------------------------ traffic proof ---

test("one transient failure is not proof the route is broken", async (t) => {
  const f = fixture(t);
  await awaitingTraffic(f);
  traffic(f, 429, { entry: { error: "rate limited" } });
  await f.tick(160000);
  assert.equal(f.state().enabled, true, "a single 429 must not latch the guardian off");
  assert.equal(f.state().phase, "awaiting_traffic");
});

test("a definitive 4xx still latches immediately and never rolls the host back", async (t) => {
  const f = fixture(t);
  await awaitingTraffic(f);
  const patched = fs.readFileSync(f.host, "utf8");
  traffic(f, 401);
  await f.tick(160000);
  assert.equal(f.state().enabled, false);
  assert.equal(f.state().phase, "failed");
  assert.equal(f.state().disabledReason, "real_request_failed");
  assert.equal(fs.readFileSync(f.host, "utf8"), patched, "no rollback and no second restart");
  assert.equal(fs.existsSync(path.join(f.sup, "command.json")), false);
});

test("repeated transient failures latch, but one success in the window wins", async (t) => {
  const f = fixture(t);
  await awaitingTraffic(f);
  traffic(f, 500, { entry: { error: "upstream" } });
  traffic(f, 503, { entry: { error: "upstream" } });
  f.log({ ts: new Date(151000).toISOString(), kind: "turn", status: 200, hostPid: 4243, patchVersion: VERSION, provider: "relay" });
  await f.tick(160000);
  assert.equal(f.state().phase, "healthy", "a 200 proves the route works; the failures are noise");
  const g = fixture(t);
  await awaitingTraffic(g);
  traffic(g, 500, { entry: { error: "upstream" } });
  traffic(g, 503, { entry: { error: "upstream" } });
  await g.tick(160000);
  assert.equal(g.state().disabledReason, "real_request_failed", "sustained failures with no success still latch");
});

test("quiet traffic cannot hold the guardian in verifying forever", async (t) => {
  const f = fixture(t);
  await awaitingTraffic(f);
  await f.tick(600000);
  assert.equal(f.state().phase, "awaiting_traffic", "still waiting inside the proof window");
  await f.tick(1040000);
  assert.equal(f.state().phase, "watching", "an idle deployment returns to watching, not healthy");
  assert.equal(f.state().enabled, true);
  assert.match(f.events(), /traffic_idle_timeout/);
  f.update("later-stock-push");
  await f.tick(1100000);
  await f.tick(1130000);
  assert.equal(f.context.cliInspectBundle(fs.readFileSync(f.host, "utf8")).patched, true, "a later stock push is still repaired");
});

test("an interrupted verification re-observes instead of latching the guardian off", async (t) => {
  const f = fixture(t);
  await awaitingTraffic(f);
  fs.unlinkSync(path.join(f.cfg, "runtime-status.json"));
  await f.tick(160000);
  assert.equal(f.state().enabled, true);
  assert.equal(f.state().phase, "watching");
  assert.match(f.events(), /traffic_proof_interrupted/);
});

// -------------------------------------------------------------- fingerprint ---

test("a torn read of our own build is reported unreadable, not hashed as a new build", (t) => {
  const selfText = "// GROK_SWITCH_PAYLOAD_BEGIN\n// fixture payload\n// GROK_SWITCH_PAYLOAD_END\n" + "// tail\n".repeat(200);
  const tornFs = {
    ...fs,
    readFileSync(target, ...args) {
      const data = fs.readFileSync(target, ...args);
      if (typeof target === "number" && Buffer.isBuffer(data)) return data.subarray(0, data.length - 24);
      return data;
    }
  };
  const f = fixture(t, { selfText, require: (id) => (id === "node:fs" ? tornFs : require(id)) });
  const full = fs.readFileSync(f.self, "utf8");
  const cut = full.slice(full.indexOf("// GROK_SWITCH_PAYLOAD_END"));
  const torn = full.slice(0, full.length - 24);
  const tornCut = torn.slice(torn.indexOf("// GROK_SWITCH_PAYLOAD_END"));
  assert.equal(torn.includes("// GROK_SWITCH_PAYLOAD_END"), true, "the torn read still contains the payload marker");
  assert.notEqual(sha256(tornCut), sha256(cut), "so a torn read would have looked like a changed build");
  assert.equal(f.context.cliWatchdogCodeFingerprint(), null, "the byte-count guard refuses to hash it");
  assert.equal(f.context.cliWatchdogFingerprintDecision("self", null, 1, 3), "unstable", "one unreadable read keeps the daemon running");
  assert.equal(f.context.cliWatchdogFingerprintDecision("self", null, 3, 3), "stale", "a sustained unreadable build stands the daemon down");
  const g = fixture(t, { selfText });
  assert.equal(g.context.cliWatchdogFingerprintDecision(g.context.cliWatchdogCodeFingerprint(), g.context.cliWatchdogCodeFingerprint(), 0, 3), "ok");
  assert.notEqual(g.context.cliWatchdogCodeFingerprint(), null, "a clean read still produces a fingerprint");
});

// ------------------------------------------------------- manual maintenance ---

test("install that changed nothing leaves the guardian enabled", async (t) => {
  const f = fixture(t);
  await f.command("enable");
  f.age(60 * 60 * 1000);
  assert.equal(f.state().enabled, true);
  await f.context.cliCommandInstall({ positional: ["install"], flags: { "no-ui": true } });
  const state = f.state();
  assert.equal(state.enabled, true, "a no-op install must not leave the deployment guarded only by the keeper");
  assert.equal(state.phase, "watching");
  assert.equal(fs.existsSync(path.join(f.sup, "command.json")), false, "and it must not request a restart");
  assert.match(f.output(), /guardian left enabled; nothing about the host or the route changed/, "a restored guardian is still announced");
});

test("official leaves the guardian suppressed, not disabled", (t) => {
  const f = fixture(t);
  f.context.cliWatchdogWrite({ schemaVersion: 1, enabled: true, phase: "watching", attempts: { kept: { phase: "verified" } } });
  f.context.cliCommandOfficial();
  const state = f.state();
  assert.equal(state.enabled, true, "the official route is represented as suppressed, as the tick does");
  assert.equal(state.phase, "suppressed");
  assert.equal(state.suppressedReason, "official_route");
  assert.deepEqual(Object.keys(state.attempts), ["kept"]);
  assert.equal(JSON.parse(fs.readFileSync(f.configPath, "utf8")).active, null);
  assert.match(f.output(), /guardian suppressed for the official route/, "the official command now announces the suppression it performed");
});

// ------------------------------------------------------- residual P2 --------

test("install reports a guardian it could not put back, and the CLI exits non-zero", async (t) => {
  const f = fixture(t);
  await f.command("enable");
  f.age(60 * 60 * 1000);
  // Re-enabling needs a current-PID receipt; without one the restore fails, and
  // the old code returned the same bare null as "nothing to restore" - silent.
  fs.unlinkSync(path.join(f.cfg, "runtime-status.json"));
  f.context.cliCommandExitCodeArmed = true;
  await f.context.cliCommandInstall({ positional: ["install"], flags: { "no-ui": true } });
  assert.equal(f.state().enabled, false, "the guardian really is left off");
  assert.match(f.output(), /warning: the guardian was not restored \(enable_refused/, "so the operator is told");
  assert.match(f.output(), /receipt/, "with the reason it was refused");
  assert.match(f.events(), /guardian_restore_failed/, "and it lands in the persistent event log");
  assert.equal(f.context.process.exitCode, 1, "the command line owns a failure exit status");
  // The panel runs the same command in-process and must not inherit an exit status.
  f.context.process.exitCode = undefined;
  f.context.cliCommandExitCodeArmed = false;
  await f.context.cliCommandInstall({ positional: ["install"], flags: { "no-ui": true } });
  assert.equal(f.context.process.exitCode, undefined, "the panel path does not set an exit status");
  assert.match(f.output(), /warning: the guardian was not restored/, "the failure is still loud there");
});

test("install says so when the guardian verified different host bytes", async (t) => {
  const f = fixture(t);
  await f.command("enable");
  f.age(60 * 60 * 1000);
  // The guardian's baseline is the bytes it verified; install only compares the
  // patch block. Make them disagree the way a restore from an older backup does.
  const s = f.state();
  s.baselineHash = "hash-from-an-earlier-verification";
  f.context.cliWatchdogWrite(s);
  await f.context.cliCommandInstall({ positional: ["install"], flags: { "no-ui": true } });
  assert.match(f.output(), /note: the guardian last verified different host bytes/, "install names the stricter guardian rule");
  assert.match(f.output(), /warning: the guardian was not restored \(host_bytes_changed\)/, "and the restore refuses to rebind it implicitly");
  assert.equal(f.state().enabled, false, "the guardian stays off rather than silently adopting unverified bytes");
});

test("an official restore that cannot run reports failure instead of a bare null", (t) => {
  const f = fixture(t);
  const prior = { schemaVersion: 1, enabled: true, phase: "watching", configHash: "config", baselineHash: "host" };
  assert.equal(f.context.cliWatchdogSuppressAfterOfficial(null), null, "nothing to restore stays silent");
  const missing = f.context.cliWatchdogSuppressAfterOfficial(prior);
  assert.equal(missing.ok, false, "a missing state file is a failure, not a no-op");
  assert.equal(missing.reason, "state_missing");
  f.context.cliWatchdogWrite({ schemaVersion: 1, enabled: true, phase: "watching", attempts: {} });
  assert.equal(f.context.cliWatchdogSuppressAfterOfficial(prior).ok, true, "an already-enabled guardian counts as restored");
});

test("a stock hash inside its retry cooldown keeps observing, then retries", async (t) => {
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
  assert.equal(f.state().enabled, true, "cooling down must not latch the guardian off");
  assert.equal(f.state().phase, "watching");
  assert.equal(f.context.cliInspectBundle(fs.readFileSync(f.host, "utf8")).patched, false, "and it must not repair inside the cooldown");
  assert.equal(f.events().split("stock_retry_cooling_down").length - 1, 1, "the cooldown is announced once, not on every tick");
  await f.tick(250000);
  assert.equal(f.events().split("stock_retry_cooling_down").length - 1, 1, "and still only once");
  await f.tick(startedAtMs + 6 * 60 * 60 * 1000 + 1);
  assert.equal(f.context.cliInspectBundle(fs.readFileSync(f.host, "utf8")).patched, true, "past the cooldown the same stock hash is repaired");
  assert.equal(f.state().phase, "awaiting_restart");
});

test("a supervisor that never goes idle cannot pin the restart wait forever", async (t) => {
  const f = fixture(t);
  await f.command("enable");
  f.update();
  await f.tick(100000);
  await f.tick(130000);
  assert.equal(f.state().phase, "awaiting_restart");
  fs.writeFileSync(path.join(f.sup, "agent.busy"), "busy");
  await f.tick(200000);
  assert.equal(f.state().phase, "awaiting_restart", "inside the bound it still waits");
  const command = fs.readFileSync(path.join(f.sup, "command.json"), "utf8");
  await f.tick(130000 + 60 * 60 * 1000 + 1);
  assert.equal(f.state().enabled, true, "a busy supervisor is not a host fault and must not latch the guardian off");
  assert.equal(f.state().phase, "watching", "the wait is abandoned back to observation");
  assert.equal(f.state().repair, null);
  assert.match(f.events(), /restart_wait_abandoned/);
  assert.equal(fs.readFileSync(path.join(f.sup, "command.json"), "utf8"), command, "no second restart is requested");
  const patched = fs.readFileSync(f.host, "utf8");
  await f.tick(130000 + 60 * 60 * 1000 + 40000);
  assert.equal(fs.readFileSync(f.host, "utf8"), patched, "and the abandoned repair does not rewrite the host");
  // Abandoning the wait is not proof that the patched bytes ever ran: a null
  // baseline makes the next observation of that same file fail closed instead of
  // matching an equality check that a human would read as "verified".
  assert.equal(f.state().baselineHash, null, "an abandoned restart wait adopts no baseline");
  assert.equal(f.state().enabled, false, "the unproven bytes are not silently accepted");
  assert.equal(f.state().phase, "failed");
  assert.equal(f.state().disabledReason, "patched_host_changed");
  assert.equal(fs.readFileSync(f.host, "utf8"), patched, "still no rollback and no rewrite");
});

test("a startup fingerprint that failed is repaired by the next readable read", (t) => {
  const f = fixture(t);
  assert.equal(f.context.cliWatchdogFingerprintBaseline(null, "on-disk"), "on-disk", "the daemon adopts the first readable build as its baseline");
  assert.equal(f.context.cliWatchdogFingerprintBaseline(null, null), null, "with nothing readable it still has no baseline");
  assert.equal(f.context.cliWatchdogFingerprintBaseline("self", "on-disk"), "self", "an established baseline is never replaced");
  const adopted = f.context.cliWatchdogFingerprintBaseline(null, "on-disk");
  assert.equal(f.context.cliWatchdogFingerprintDecision(adopted, "on-disk", 3, 3), "ok", "so unreadable startup rounds no longer stand the daemon down");
  assert.equal(f.context.cliWatchdogFingerprintDecision(adopted, "changed", 0, 3), "stale", "while a later replacement still does");
});

test("the daemon heartbeat is swapped into place, never written in place", (t) => {
  const beatName = "watchdog-daemon.beat.json";
  const writes = [];
  const renames = [];
  const hookedFs = {
    ...fs,
    writeFileSync(target, ...args) {
      if (typeof target === "string" && target.includes(beatName)) writes.push(target);
      return fs.writeFileSync(target, ...args);
    },
    renameSync(from, to) {
      if (String(to).includes(beatName)) renames.push(String(from));
      return fs.renameSync(from, to);
    }
  };
  const f = fixture(t, { require: (id) => (id === "node:fs" ? hookedFs : require(id)) });
  const entry = f.context.cliWatchdogDaemonBeat({ event: "started" });
  assert.equal(entry.event, "started");
  assert.deepEqual(writes, [], "the heartbeat must never be written in place");
  assert.equal(renames.length, 1, "it is renamed into place");
  assert.equal(renames[0].includes(beatName), true, "the temp file lives beside the target");
  const state = f.context.cliWatchdogDaemonState();
  assert.equal(state.version, VERSION, "the reader still parses the heartbeat");
  assert.equal(state.lastEvent, "started");
});

test("the patch block is remembered instead of re-reading the bundle each call", (t) => {
  const reads = [];
  const hookedFs = {
    ...fs,
    readFileSync(target, ...args) {
      if (typeof target === "string" && target.endsWith("self.cjs")) reads.push(target);
      return fs.readFileSync(target, ...args);
    }
  };
  const f = fixture(t, { require: (id) => (id === "node:fs" ? hookedFs : require(id)) });
  // The fixture already built a host (which reads the bundle once), so start from
  // a known state and count reads per call.
  const readsDuring = (calls) => { const start = reads.length; for (let i = 0; i < calls; i += 1) f.context.cliPatchBlock(); return reads.length - start; };
  f.context.cliPatchBlockMemo = null;
  const before = reads.length;
  const block = f.context.cliPatchBlock();
  assert.equal(reads.length - before, 1, "the first call reads the bundle once");
  assert.equal(readsDuring(2), 0, "later calls are served from the remembered block");
  assert.equal(f.context.cliPatchBlock(), block);
  fs.writeFileSync(f.self, "// GROK_SWITCH_PAYLOAD_BEGIN\n// changed payload v2\n// GROK_SWITCH_PAYLOAD_END\n");
  assert.equal(readsDuring(1), 1, "a rewritten bundle is re-read");
  assert.notEqual(f.context.cliPatchBlock(), block);
});
