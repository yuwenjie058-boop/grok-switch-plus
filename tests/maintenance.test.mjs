import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stock = '"use strict";\nvar BasePromptBuilder, BasePromptExecutor;\nfunction createCursorSandInference() {}\nfunction createHostInference(options) { return options; }\n';
const config = { active: "relay", providers: { relay: { baseUrl: "https://example.test/v1", model: "gpt-6-astra", apiKey: "fixture-key", protocol: "openai-chat" } } };
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-maintenance-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hostPath = path.join(dir, "host-main.cjs");
  fs.writeFileSync(hostPath, stock);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  const filename = path.join(dir, "fixture-cli.cjs");
  fs.writeFileSync(filename, "// GROK_SWITCH_PAYLOAD_BEGIN\nfunction createHostInference(options) { return __grokSwitchOriginalCreateHostInference(options); }\n// GROK_SWITCH_PAYLOAD_END\n");
  const proc = Object.create(process);
  const stdout = new PassThrough();
  Object.defineProperty(proc, "stdout", { value: stdout });
  t.after(() => stdout.destroy());
  proc.env = { ...process.env, GROK_SWITCH_DIR: dir, GROK_SWITCH_HOST: hostPath, GROK_SWITCH_SUPERVISOR_DIR: path.join(dir, "supervisor"), GROK_SWITCH_PROC: path.join(dir, "proc") };
  const context = vm.createContext({
    process: proc, module: {}, __filename: filename, Buffer, URL, URLSearchParams, AbortController, TextDecoder, TextEncoder, crypto, console, setTimeout, clearTimeout,
    require(id) {
      if (id === "node:fs" && overrides.writeHook) return { ...fs, writeFileSync(file, ...args) { fs.writeFileSync(file, ...args); overrides.writeHook(file, dir); } };
      if (id === "node:child_process" && overrides.checkHook) return { ...childProcess, spawnSync(...args) { overrides.checkHook(hostPath); return childProcess.spawnSync(...args); } };
      return require(id);
    }
  });
  for (const file of ["maintenance.cjs", "runtime.cjs", "watchdog.cjs", "ui.cjs", "cli.cjs"]) {
    const sourcePath = path.join(root, "src", file);
    if (!fs.existsSync(sourcePath)) continue;
    const source = fs.readFileSync(sourcePath, "utf8").replaceAll("__GROK_SWITCH_RUNTIME_VERSION__", "0.8.4-cloud.3").replaceAll("__GROK_SWITCH_VERSION__", "0.8.4-cloud.3");
    vm.runInContext(source, context, { filename: sourcePath });
  }
  context.cliSink = [];
  return { dir, hostPath, filename, context, readConfig: () => JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")) };
}

test("maintenance ownership excludes nested and concurrent async mutations until release", async (t) => {
  const { context: c, dir } = fixture(t);
  assert.equal(typeof c.grokSwitchWithMaintenanceLock, "function", "shared maintenance lock must exist");
  let release;
  const pending = c.grokSwitchWithMaintenanceLock(() => new Promise((resolve) => { release = resolve; }));
  assert.throws(() => c.grokSwitchWithMaintenanceLock(() => {}), /maintenance.*busy/i);
  assert.ok(fs.existsSync(path.join(dir, "maintenance.lock")));
  release(17);
  assert.equal(await pending, 17);
  assert.equal(c.grokSwitchWithMaintenanceLock(() => 23), 23);
  assert.throws(() => c.grokSwitchWithMaintenanceLock(() => { throw new Error("fixture failure"); }), /fixture failure/);
  assert.equal(c.grokSwitchWithMaintenanceLock(() => 29), 29);
});

test("a live or ambiguous maintenance owner cannot be removed", (t) => {
  const { context: c, dir } = fixture(t);
  assert.equal(typeof c.grokSwitchWithMaintenanceLock, "function");
  const lock = path.join(dir, "maintenance.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "someone-else" }));
  assert.throws(() => c.grokSwitchWithMaintenanceLock(() => {}), /maintenance.*busy/i);
  fs.writeFileSync(path.join(lock, "owner.json"), "{");
  assert.throws(() => c.grokSwitchWithMaintenanceLock(() => {}), /maintenance.*busy/i);
  assert.ok(fs.existsSync(lock));
});

// The lock used to be permanent: an interrupted operation left it behind and
// every later mutation refused until a human removed it. A lock whose owner is
// provably gone is now reclaimed, but only then.
test("a lock whose owner is provably gone is reclaimed and the operation retried", (t) => {
  const { context: c, dir } = fixture(t);
  const lock = path.join(dir, "maintenance.lock");
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 999999, token: "dead-owner" }));
  const originalKill = c.process.kill;
  c.process.kill = () => {
    const error = new Error("ESRCH");
    error.code = "ESRCH";
    throw error;
  };
  try {
    assert.equal(c.grokSwitchWithMaintenanceLock(() => 41), 41, "the dead owner lock is reclaimed and the body runs");
  } finally {
    c.process.kill = originalKill;
  }
  assert.equal(fs.existsSync(lock), false, "the lock directory is gone after release");
  assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("maintenance.lock.dead-")).length, 0, "the quarantine directory is cleaned up");
});

test("an owner-less lock is only reclaimed after the grace window", (t) => {
  const { context: c, dir } = fixture(t);
  const lock = path.join(dir, "maintenance.lock");
  fs.mkdirSync(lock);
  assert.throws(() => c.grokSwitchWithMaintenanceLock(() => {}), /maintenance.*busy/i, "a fresh claim may legitimately be between mkdir and its first write");
  assert.ok(fs.existsSync(lock), "the fresh lock is left alone");
  const aged = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(lock, aged, aged);
  assert.equal(c.grokSwitchWithMaintenanceLock(() => 43), 43, "past the window an interrupted claim is reclaimed");
  assert.equal(fs.existsSync(lock), false, "and released normally afterwards");
});

test("manual official suppresses the guardian after the mutation; runtime chat switches disable it", (t) => {
  const { context: c, dir, readConfig } = fixture(t);
  const guardPath = path.join(dir, "watchdog.json");
  const initial = { schemaVersion: 1, enabled: true, phase: "watching", attempts: { preserved: { ok: true } } };
  fs.writeFileSync(guardPath, JSON.stringify(initial));
  c.cliCommandOfficial();
  let state = JSON.parse(fs.readFileSync(guardPath));
  // The guardian is still switched off before the mutation; the command then
  // puts it back in the state the tick uses for official mode (enabled, quiet),
  // instead of leaving the box keeper to notice a disabled guardian.
  assert.equal(state.enabled, true);
  assert.equal(state.phase, "suppressed");
  assert.equal(state.suppressedReason, "official_route");
  assert.deepEqual(state.attempts, initial.attempts);
  assert.equal(readConfig().active, null);
  fs.writeFileSync(guardPath, JSON.stringify(initial));
  c.grokSwitchCommandReply("/gs use relay");
  state = JSON.parse(fs.readFileSync(guardPath));
  assert.equal(state.enabled, false);
  assert.equal(readConfig().providers.relay.model, "gpt-6-astra");
});

test("stale CLI and runtime config snapshots cannot overwrite a newer manual selection", (t) => {
  for (const reader of ["cliReadRawConfig", "grokSwitchReadRawConfig"]) {
    const { context: c, dir, readConfig } = fixture(t);
    const stale = c[reader]();
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ ...config, active: null }));
    const write = () => c[reader === "cliReadRawConfig" ? "cliWriteConfig" : "grokSwitchWriteConfig"](stale);
    const operation = () => typeof c.grokSwitchWithMaintenanceLock === "function" ? c.grokSwitchWithMaintenanceLock(write) : write();
    assert.throws(operation, /config.*changed/i);
    assert.equal(readConfig().active, null);
  }
});

test("panel provider edits disable guardian while preserving working model fields", async (t) => {
  const { context: c, dir, readConfig } = fixture(t);
  fs.writeFileSync(path.join(dir, "watchdog.json"), JSON.stringify({ enabled: true }));
  c.uiState = () => ({});
  await c.uiHandleApi("POST", "/api/providers", { name: "relay", model: "gpt-6-astra", test: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "watchdog.json"))).enabled, false);
  assert.equal(readConfig().providers.relay.apiKey, "fixture-key");
});

test("official replacement during node syntax check is preserved and patch fails", (t) => {
  const replacement = stock + "// official release changed during validation\n";
  const { context: c, hostPath } = fixture(t, { checkHook(file) { fs.writeFileSync(file, replacement); } });
  const operation = () => typeof c.grokSwitchWithMaintenanceLock === "function" ? c.grokSwitchWithMaintenanceLock(() => c.cliEnsurePatched()) : c.cliEnsurePatched();
  assert.throws(operation, /host.*changed/i);
  assert.equal(fs.readFileSync(hostPath, "utf8"), replacement);
});

test("guardian cannot patch a later stock release that was never observed stable", (t) => {
  const { context: c, hostPath } = fixture(t);
  const stable = c.cliBundleSnapshot();
  const replacement = stock + "// a newer release after the guardian stability check\n";
  fs.writeFileSync(hostPath, replacement);
  assert.throws(() => c.grokSwitchWithMaintenanceLock(() => c.cliEnsurePatched(stable)), /host.*changed/i);
  assert.equal(fs.readFileSync(hostPath, "utf8"), replacement);
});

test("an official restart command arriving during staging is never overwritten", (t) => {
  const official = { id: "official-command", kind: "restart" };
  const { context: c, dir } = fixture(t, {
    writeHook(file, location) {
      const commandPath = path.join(location, "supervisor", "command.json");
      if (typeof file === "string" && file.startsWith(commandPath + ".")) fs.writeFileSync(commandPath, JSON.stringify(official));
    }
  });
  const result = c.grokSwitchWithMaintenanceLock(() => c.cliRequestRestart("fixture"));
  assert.equal(result.issued, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "supervisor", "command.json"))), official);
});

test("runtime receipt is emitted only by the host factory and logs identify its PID", (t) => {
  const { context: c, dir, filename } = fixture(t);
  const receiptPath = path.join(dir, "runtime-status.json");
  assert.equal(fs.existsSync(receiptPath), false, "loading CLI source is not host health evidence");
  c.grokSwitchAppendLog({ kind: "test", status: 200 });
  assert.equal(fs.existsSync(receiptPath), false, "probes must not publish a host receipt");
  c.grokSwitchWrapHostInference({ createSession() {} });
  assert.ok(fs.existsSync(receiptPath), "factory must publish the loaded host receipt");
  const receipt = JSON.parse(fs.readFileSync(receiptPath));
  assert.equal(receipt.pid, process.pid);
  assert.equal(receipt.patchVersion, "0.8.4-cloud.3");
  assert.equal(receipt.bundleHash, hash(fs.readFileSync(filename)));
  assert.ok(Number.isFinite(receipt.atMs));
  fs.writeFileSync(filename, "// overwritten by official updater after load\n");
  c.grokSwitchWrapHostInference({ createSession() {} });
  assert.equal(JSON.parse(fs.readFileSync(receiptPath)).bundleHash, receipt.bundleHash, "factory reuse must not claim newly overwritten disk bytes were loaded");
  c.grokSwitchAppendLog({ kind: "chat", status: 200 });
  const records = fs.readFileSync(path.join(dir, "requests.log"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(records[0].hostPid, undefined);
  assert.equal(records[1].hostPid, process.pid);
  assert.equal(records[1].patchVersion, "0.8.4-cloud.3");
});
