import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "0.8.4-cloud.3";
const STOCK = 'var BasePromptExecutor, BasePromptBuilder;\nfunction createCursorSandInference() {}\nfunction createHostInference() { return {}; }\n';
const require = createRequire(import.meta.url);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-watchdog-"));
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
  fs.writeFileSync(self, "// GROK_SWITCH_PAYLOAD_BEGIN\n// fixture payload\n// GROK_SWITCH_PAYLOAD_END\n");
  const context = vm.createContext({
    require, module: { exports: {} }, __filename: self, console, setTimeout, clearTimeout, URL,
    process: { ...process, env: { ...process.env, GROK_SWITCH_DIR: cfg, GROK_SWITCH_HOST: host, GROK_SWITCH_PROC: proc, GROK_SWITCH_SUPERVISOR_DIR: sup }, stdout: { on() {}, write() {} }, stderr: { write() {} } }
  });
  for (const name of ["maintenance.cjs", "runtime.cjs", "watchdog.cjs", "cli.cjs"]) {
    const p = path.join(ROOT, "src", name);
    if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, "utf8").replaceAll("__GROK_SWITCH_VERSION__", VERSION).replaceAll("__GROK_SWITCH_RUNTIME_VERSION__", VERSION), context, { filename: name });
  }
  assert.equal(typeof context.cliCommandWatchdog, "function", "watchdog commands must be implemented");
  fs.writeFileSync(host, context.cliBuildPatched(STOCK));
  const statePath = path.join(cfg, "watchdog.json");
  const state = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
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
  return { context, dir, cfg, host, sup, configPath, statePath, state, command, tick, update, pid, receipt, log };
}

test("disabled guardian leaves a replaced official host untouched", async (t) => {
  const f = fixture(t); f.update(); const before = fs.readFileSync(f.host, "utf8");
  await f.tick(100000); assert.equal(fs.readFileSync(f.host, "utf8"), before);
  assert.equal(fs.existsSync(path.join(f.sup, "command.json")), false);
});

test("enable refuses official route and refuses an already unpatched host", async (t) => {
  const f = fixture(t); const config = JSON.parse(fs.readFileSync(f.configPath));
  config.active = null; fs.writeFileSync(f.configPath, JSON.stringify(config));
  await assert.rejects(async () => f.command("enable"), /external|official/i);
  config.active = "relay"; fs.writeFileSync(f.configPath, JSON.stringify(config)); f.update();
  await assert.rejects(async () => f.command("enable"), /patch/i);
});

test("a changing host must remain equal for thirty seconds before repair", async (t) => {
  const f = fixture(t); await f.command("enable"); f.update();
  await f.tick(100000); await f.tick(129999);
  assert.equal(f.context.cliInspectBundle(fs.readFileSync(f.host, "utf8")).patched, false);
  f.update("v3"); await f.tick(130000); await f.tick(159999);
  assert.equal(f.context.cliInspectBundle(fs.readFileSync(f.host, "utf8")).patched, false);
  await f.tick(160000);
  assert.equal(f.context.cliInspectBundle(fs.readFileSync(f.host, "utf8")).patched, true);
});

test("busy agents and pending official commands prevent repair without consuming an attempt", async (t) => {
  const f = fixture(t); await f.command("enable"); f.update(); await f.tick(100000);
  fs.writeFileSync(path.join(f.sup, "agent.busy"), "busy"); await f.tick(130000);
  assert.equal(f.context.cliInspectBundle(fs.readFileSync(f.host, "utf8")).patched, false);
  fs.unlinkSync(path.join(f.sup, "agent.busy")); fs.writeFileSync(path.join(f.sup, "command.json"), JSON.stringify({ id: "official-update" }));
  await f.tick(160000); assert.equal(JSON.parse(fs.readFileSync(path.join(f.sup, "command.json"))).id, "official-update");
  assert.equal(Object.keys(f.state().attempts || {}).length, 0);
  fs.unlinkSync(path.join(f.sup, "command.json")); await f.tick(190000);
  assert.equal(f.context.cliInspectBundle(fs.readFileSync(f.host, "utf8")).patched, true);
});

test("a compatible update preserves config, saves stock and requests only one restart", async (t) => {
  const f = fixture(t); await f.command("enable"); const cfg = fs.readFileSync(f.configPath, "utf8");
  f.update(); const stock = fs.readFileSync(f.host, "utf8"); await f.tick(100000); await f.tick(130000);
  const command = fs.readFileSync(path.join(f.sup, "command.json"), "utf8");
  await f.tick(160000); assert.equal(fs.readFileSync(path.join(f.sup, "command.json"), "utf8"), command);
  assert.equal(fs.readFileSync(f.configPath, "utf8"), cfg);
  const attempt = Object.values(f.state().attempts)[0];
  assert.equal(fs.readFileSync(attempt.backupPath, "utf8"), stock);
  assert.equal(Object.keys(f.state().attempts).length, 1);
  assert.doesNotMatch(fs.readFileSync(f.statePath, "utf8"), /fixture-secret/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.cfg, "watchdog.log"), "utf8"), /fixture-secret/);
});

test("a manual configuration change disables automatic repair before any host write", async (t) => {
  const f = fixture(t); await f.command("enable"); f.update(); await f.tick(100000);
  const config = JSON.parse(fs.readFileSync(f.configPath)); config.providers.relay.model = "gpt-5.6-sol"; fs.writeFileSync(f.configPath, JSON.stringify(config));
  await f.tick(130000); assert.equal(f.state().enabled, false);
  assert.equal(f.context.cliInspectBundle(fs.readFileSync(f.host, "utf8")).patched, false);
});

for (const failure of ["contract", "syntax", "restart"]) test(`${failure} failure latches off and subsequent ticks do not retry`, async (t) => {
  const f = fixture(t); await f.command("enable"); f.update();
  if (failure === "contract") fs.writeFileSync(f.host, "module.exports = {};\n");
  if (failure === "syntax") fs.appendFileSync(f.host, "\nsyntax ! invalid {\n");
  await f.tick(100000);
  if (failure === "restart") { fs.rmSync(f.sup, { recursive: true }); fs.writeFileSync(f.sup, "not a directory"); }
  await f.tick(130000); assert.equal(f.state().enabled, false);
  assert.equal(f.state().phase, "failed"); const stopped = fs.readFileSync(f.host, "utf8");
  await f.tick(190000); assert.equal(fs.readFileSync(f.host, "utf8"), stopped);
});

test("a persisted interrupted repair stands the guardian back up instead of latching it off", async (t) => {
  const f = fixture(t); await f.command("enable"); f.update();
  const state = f.state(); state.phase = "repairing"; state.repair = { stockHash: f.context.cliHash(fs.readFileSync(f.host, "utf8")) };
  state.observed = { firstSeenAtMs: 1, hash: state.repair.stockHash };
  state.attempts[state.repair.stockHash] = { phase: "started", startedAtMs: 100000 }; fs.writeFileSync(f.statePath, JSON.stringify(state));
  await f.tick(130000);
  const recovered = f.state();
  // A tick that dies mid-repair used to disable the guardian for good. It now
  // stands back up and re-observes, so the guardian is never silently dead.
  assert.equal(recovered.enabled, true, "the guardian stays enabled");
  assert.equal(recovered.phase, "watching", "and returns to watching");
  assert.equal(recovered.repair, null, "the abandoned repair record is dropped");
  assert.equal(recovered.observed, null, "observation restarts from scratch");
  assert.equal(Object.keys(recovered.attempts).length, 0, "the abandoned attempt does not blacklist the build forever");
  assert.equal(f.context.cliInspectBundle(fs.readFileSync(f.host, "utf8")).patched, false, "no half-done repair is written");
  assert.match(fs.readFileSync(path.join(f.cfg, "watchdog.log"), "utf8"), /repair_interrupted_recovered/, "the recovery is recorded, not silent");
  // Recovery is not a permanent stop: the guardian still reaches a repair.
  await f.tick(160000); await f.tick(190000);
  assert.equal(f.context.cliInspectBundle(fs.readFileSync(f.host, "utf8")).patched, true, "the guardian still repairs on a later tick");
});

test("restart verification needs new PID and matching receipt; quiet traffic never means healthy", async (t) => {
  const f = fixture(t); await f.command("enable"); f.update(); await f.tick(100000); await f.tick(130000);
  fs.unlinkSync(path.join(f.sup, "command.json")); f.receipt(140000, 4242); await f.tick(140000);
  assert.equal(f.state().phase, "awaiting_restart");
  f.pid(4243); f.receipt(150000, 4243, "wrong-hash"); await f.tick(150000); assert.equal(f.state().phase, "awaiting_restart");
  f.receipt(160000); await f.tick(160000); assert.equal(f.state().phase, "awaiting_traffic");
  f.log({ ts: new Date(170000).toISOString(), kind: "test", status: 200, hostPid: 4243, patchVersion: VERSION, provider: "relay" });
  f.log({ ts: new Date(180000).toISOString(), kind: "turn", status: 200, hostPid: 4242, patchVersion: VERSION, provider: "relay" });
  await f.tick(600000); assert.equal(f.state().phase, "awaiting_traffic"); assert.equal(f.state().enabled, true);
  f.log({ ts: new Date(610000).toISOString(), kind: "turn", status: 200, hostPid: 4243, patchVersion: VERSION, provider: "relay" });
  await f.tick(620000); assert.equal(f.state().phase, "healthy");
});

test("sustained request errors latch for manual action and never cause another restart or rollback", async (t) => {
  const f = fixture(t); await f.command("enable"); f.update(); await f.tick(100000); await f.tick(130000);
  fs.unlinkSync(path.join(f.sup, "command.json")); f.pid(4243); f.receipt(140000); await f.tick(140000);
  const patched = fs.readFileSync(f.host, "utf8");
  // One transient failure is no longer proof (see watchdog-hardening.test.mjs);
  // a failure that keeps repeating with no success in the window still latches.
  f.log({ ts: new Date(150000).toISOString(), kind: "turn", status: 429, error: "fixture-secret-never-log", hostPid: 4243, patchVersion: VERSION, provider: "relay" });
  f.log({ ts: new Date(151000).toISOString(), kind: "turn", status: 503, error: "fixture-secret-never-log", hostPid: 4243, patchVersion: VERSION, provider: "relay" });
  await f.tick(160000); assert.equal(f.state().enabled, false); assert.equal(f.state().phase, "failed");
  assert.equal(fs.readFileSync(f.host, "utf8"), patched); assert.equal(fs.existsSync(path.join(f.sup, "command.json")), false);
  assert.doesNotMatch(fs.readFileSync(f.statePath, "utf8"), /fixture-secret/);
});

test("restart timeout counts idle time and does not issue repeated requests while busy", async (t) => {
  const f = fixture(t); await f.command("enable"); f.update(); await f.tick(100000); await f.tick(130000);
  fs.writeFileSync(path.join(f.sup, "agent.busy"), "busy"); await f.tick(900000); assert.equal(f.state().enabled, true);
  fs.unlinkSync(path.join(f.sup, "agent.busy")); await f.tick(930000); assert.equal(f.state().enabled, true);
  await f.tick(1060000); assert.equal(f.state().enabled, false); assert.equal(f.state().phase, "failed");
});

test("explicit enable preserves attempted stock history and holds off the repeat repair", async (t) => {
  const f = fixture(t); await f.command("enable"); f.update(); const stock = fs.readFileSync(f.host, "utf8"); await f.tick(100000); await f.tick(130000);
  await f.command("disable"); fs.unlinkSync(path.join(f.sup, "command.json")); f.pid(4243); f.receipt(Date.now()); await f.command("enable");
  fs.writeFileSync(f.host, stock); await f.tick(200000); await f.tick(230000);
  // The attempt history is still respected - the same stock hash is not repaired
  // again inside its six hour cooldown - but that is not a fault any more: the
  // guardian stays on and keeps observing (see the F7 fix).
  assert.equal(f.state().enabled, true); assert.equal(f.state().phase, "watching");
  assert.equal(fs.readFileSync(f.host, "utf8"), stock);
});

for (const mismatch of ["missing_process", "pending_restart", "missing_receipt", "wrong_pid", "wrong_version", "wrong_hash", "stale_receipt"]) test(`enable preserves a failure latch when runtime proof has ${mismatch}`, async (t) => {
  const f = fixture(t); await f.command("enable");
  const state = f.state(); state.enabled = false; state.phase = "failed"; state.disabledReason = "restart_receipt_timeout";
  fs.writeFileSync(f.statePath, JSON.stringify(state));
  const receiptPath = path.join(f.cfg, "runtime-status.json");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  if (mismatch === "missing_process") fs.rmSync(path.join(f.dir, "proc", "4242"), { recursive: true });
  else if (mismatch === "pending_restart") fs.writeFileSync(path.join(f.sup, "command.json"), JSON.stringify({ id: "restart-still-pending" }));
  else if (mismatch === "missing_receipt") fs.unlinkSync(receiptPath);
  else {
    if (mismatch === "wrong_pid") receipt.pid = 4243;
    if (mismatch === "wrong_version") receipt.patchVersion = "0.8.4-cloud.2";
    if (mismatch === "wrong_hash") receipt.bundleHash = "outdated-bundle";
    if (mismatch === "stale_receipt") receipt.atMs = 0;
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  }
  const previousState = fs.readFileSync(f.statePath, "utf8");
  await assert.rejects(async () => f.command("enable"), /runtime|receipt|process|restart/i);
  assert.equal(fs.readFileSync(f.statePath, "utf8"), previousState, "failed re-enable must preserve the prior failure state");
});

test("daemon startup is serialized by the maintenance lock and never takes an ambiguous owner", async (t) => {
  const f = fixture(t);
  await f.context.grokSwitchWithMaintenanceLock(async () => {
    assert.throws(() => f.context.cliWatchdogAcquireDaemon(), /maintenance|lock/i);
  });
  const lock = path.join(f.cfg, "watchdog-daemon.lock");
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "owner.json"), "{}");
  assert.throws(() => f.context.cliWatchdogAcquireDaemon(), /unknown|intervention/i);
  assert.equal(fs.readFileSync(path.join(lock, "owner.json"), "utf8"), "{}");
});

test("daemon allows one live instance and recovers only a conclusively dead owner", async (t) => {
  const f = fixture(t); const release = f.context.cliWatchdogAcquireDaemon();
  assert.throws(() => f.context.cliWatchdogAcquireDaemon(), /already|running|owner/i);
  release();
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" }); assert.equal(dead.status, 0);
  const lock = path.join(f.cfg, "watchdog-daemon.lock"); fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: dead.pid, token: "old-owner" }));
  const newRelease = f.context.cliWatchdogAcquireDaemon();
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"))).pid, process.pid);
  newRelease(); assert.equal(fs.existsSync(lock), false);
});

test("a conflicting update after the stable observation is not patched", async (t) => {
  const f = fixture(t); await f.command("enable"); f.update(); await f.tick(100000);
  const realEnsure = f.context.cliEnsurePatched;
  f.context.cliEnsurePatched = (expected) => { f.update("v3-arrived-after-observation"); return realEnsure(expected); };
  await f.tick(130000);
  assert.equal(f.state().enabled, false);
  assert.equal(fs.readFileSync(f.host, "utf8"), STOCK + "// v3-arrived-after-observation\n");
  assert.equal(fs.existsSync(path.join(f.sup, "command.json")), false);
});

const setActive = (f, name) => {
  const config = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
  config.active = name;
  fs.writeFileSync(f.configPath, JSON.stringify(config));
};

test("official mode suppresses the guardian instead of killing it, then resumes by itself", async (t) => {
  const f = fixture(t);
  await f.command("enable");
  assert.equal(f.state().phase, "watching");
  const patched = fs.readFileSync(f.host, "utf8");
  const events = () => fs.readFileSync(path.join(f.cfg, "watchdog.log"), "utf8");

  setActive(f, null);
  await f.tick(100000);
  const suppressed = f.state();
  assert.equal(suppressed.enabled, true, "official mode must not disable the guardian");
  assert.equal(suppressed.phase, "suppressed");
  assert.equal(suppressed.suppressedReason, "official_route");
  assert.equal(suppressed.disabledReason, undefined);
  assert.equal(fs.readFileSync(f.host, "utf8"), patched, "official mode must leave the host alone");
  assert.match(events(), /"event":"suppressed"/);

  await f.tick(130000);
  assert.equal(f.state().phase, "suppressed", "staying in official mode stays quiet");

  setActive(f, "relay");
  await f.tick(160000);
  const resumed = f.state();
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.phase, "watching");
  assert.equal(resumed.suppressedReason, undefined);
  assert.match(events(), /"event":"resumed"/);

  f.update("after-official");
  await f.tick(200000);
  assert.equal(f.state().enabled, true);
  await f.tick(230000);
  assert.equal(f.context.cliInspectBundle(fs.readFileSync(f.host, "utf8")).patched, true, "a resumed guardian still repairs");
});

test("suppression is only for official mode; a genuine config change still fails closed", async (t) => {
  const f = fixture(t);
  await f.command("enable");
  const config = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
  config.providers.relay2 = { ...config.providers.relay, baseUrl: "https://relay2.invalid/v1" };
  config.active = "relay2";
  fs.writeFileSync(f.configPath, JSON.stringify(config));
  await f.tick(100000);
  assert.equal(f.state().enabled, false);
  assert.equal(f.state().phase, "failed");
  assert.equal(f.state().disabledReason, "config_changed");
});
