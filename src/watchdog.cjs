// CLI-only guardian. Constants owned by cli.cjs are resolved when called.
// Never modifies providers, generates model traffic, or rolls a host back.
function cliWatchdogPath(name) {
  return cliPath.join(CLI_CONFIG_DIR, name);
}

function cliWatchdogRead() {
  var text;
  try { text = cliFs.readFileSync(cliWatchdogPath("watchdog.json"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  var state = JSON.parse(text);
  if (state == null || typeof state !== "object" || Array.isArray(state) || state.schemaVersion !== 1 || typeof state.enabled !== "boolean" || state.attempts == null || typeof state.attempts !== "object" || Array.isArray(state.attempts)) {
    throw new CliError("watchdog state is invalid; manual recovery required");
  }
  return state;
}

function cliWatchdogWrite(state) {
  cliFs.mkdirSync(CLI_CONFIG_DIR, { recursive: true, mode: 448 });
  grokSwitchSweepTempFilesThrottled(CLI_CONFIG_DIR, GROK_SWITCH_TMP_PREFIXES);
  var tmp = cliWatchdogPath("watchdog.json." + process.pid + "." + require("node:crypto").randomBytes(8).toString("hex") + ".tmp");
  var fd = cliFs.openSync(tmp, "wx", 384);
  try { cliFs.writeFileSync(fd, JSON.stringify(state, null, 2) + "\n"); cliFs.fsyncSync(fd); }
  finally { cliFs.closeSync(fd); }
  try { cliFs.renameSync(tmp, cliWatchdogPath("watchdog.json")); }
  finally { try { cliFs.unlinkSync(tmp); } catch (_error) {} }
  grokSwitchFsyncDir(CLI_CONFIG_DIR);
}

function cliWatchdogEvent(state, event, now) {
  // Only enumerated reasons and known metadata. Never append raw exceptions,
  // provider objects, configuration text, API responses or credentials.
  var entry = { ts: new Date(now).toISOString(), event: event, phase: state.phase, enabled: state.enabled };
  if (state.repair && state.repair.stockHash) entry.stockHash = state.repair.stockHash;
  if (state.disabledReason) entry.reason = state.disabledReason;
  if (state.suppressedReason) entry.reason = state.suppressedReason;
  cliFs.appendFileSync(cliWatchdogPath("watchdog.log"), JSON.stringify(entry) + "\n", { mode: 384 });
}

function cliWatchdogFail(state, reason, now) {
  state = state || { schemaVersion: 1, attempts: {} };
  state.enabled = false;
  state.phase = "failed";
  state.disabledReason = reason;
  state.disabledAtMs = now;
  if (state.repair && state.attempts[state.repair.stockHash]) state.attempts[state.repair.stockHash].phase = "failed";
  cliWatchdogWrite(state);
  cliWatchdogEvent(state, "disabled", now);
  return state;
}

function cliWatchdogIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

function cliWatchdogSnapshot() {
  var snapshot = cliBundleSnapshot();
  snapshot.identity = cliWatchdogIdentity(snapshot);
  snapshot.info = cliInspectBundle(snapshot.text);
  return snapshot;
}

function cliWatchdogBoundConfig(state) {
  var text = grokSwitchReadConfigText();
  if (text == null || cliHash(text) !== state.configHash) return false;
  var route = grokSwitchResolveRoute();
  return route.kind === "external" && route.provider.name === state.provider;
}


// Official mode is a deliberate, expected state - the operator ran `official` -
// not a fault. Failing closed here used to leave the guardian permanently off,
// so switching back to an external provider needed a manual re-enable.
function cliWatchdogOfficialMode() {
  var text = grokSwitchReadConfigText();
  if (text == null) return false;
  return grokSwitchResolveRoute().kind === "official";
}

function cliWatchdogSuppress(state, now) {
  if (state.phase !== "suppressed") {
    state.phase = "suppressed";
    state.suppressedReason = "official_route";
    state.suppressedAtMs = now;
    delete state.disabledReason;
    delete state.disabledAtMs;
    state.repair = null;
    cliWatchdogWrite(state);
    cliWatchdogEvent(state, "suppressed", now);
  }
  return state;
}

// Rebind to the external route that is live now; later ticks re-observe the host
// and repair it if it needs it. Returns null while official mode is still on.
function cliWatchdogResume(state, now) {
  var text = grokSwitchReadConfigText();
  if (text == null) return null;
  var route = grokSwitchResolveRoute();
  if (route.kind !== "external") return null;
  state.configHash = cliHash(text);
  state.provider = route.provider.name;
  state.observed = null;
  state.repair = null;
  state.phase = "watching";
  delete state.suppressedReason;
  delete state.suppressedAtMs;
  cliWatchdogWrite(state);
  cliWatchdogEvent(state, "resumed", now);
  return state;
}
function cliWatchdogReceipt() {
  try { return JSON.parse(cliFs.readFileSync(cliWatchdogPath("runtime-status.json"), "utf8")); }
  catch (_error) { return null; }
}

// How long a repaired host may stay in "awaiting_traffic" with no matching real
// request before the guardian stops treating the verification as pending. The
// receipt already proved the new pid loaded the patched bundle; real traffic is
// the stronger proof, but an idle deployment must not hold the guardian in
// "verifying" forever (a later stock push is turned into a hard failure there).
var CLI_TRAFFIC_PROOF_TIMEOUT_MS = 15 * 60 * 1000;

// A restart the supervisor never applies because it stays busy (a long turn, or
// a wedged agent.busy flag) must not pin the guardian in "awaiting_restart"
// forever: idleWaitMs only grows while the supervisor is idle, so that phase's
// 120s limit never fires while busy and every other observation stops. Past this
// wall-clock bound the wait is abandoned back to "watching" - the patched bytes
// on disk are still ours, so this is not a host fault and must not latch.
var CLI_RESTART_WAIT_LIMIT_MS = 60 * 60 * 1000;

function cliWatchdogVerifyRepair(state, snapshot, host, now) {
  var repair = state.repair;
  if (!repair || !repair.patchedHash || !Number.isFinite(repair.requestedAtMs)) return cliWatchdogFail(state, "interrupted_repair", now);
  if (snapshot.hash !== repair.patchedHash) return cliWatchdogFail(state, "host_changed_during_repair", now);
  var receipt = cliWatchdogReceipt();
  var pid = host.process && host.process.pid;
  var loaded = pid != null && pid !== repair.oldPid && receipt != null && receipt.pid === pid && receipt.patchVersion === CLI_VERSION && receipt.bundleHash === repair.patchedHash && Number.isFinite(receipt.atMs) && receipt.atMs >= repair.requestedAtMs && !host.supervisor.pending;
  if (!loaded) {
    if (state.phase === "awaiting_traffic") {
      // The host moved again while we were waiting for proof (another restart, or
      // a queued supervisor command). That invalidates this verification but is
      // not a host fault, so re-observe from scratch instead of latching the
      // guardian off until a human notices.
      var interrupted = state.repair;
      state.repair = null;
      state.observed = null;
      state.phase = "watching";
      if (interrupted != null && interrupted.stockHash) delete state.attempts[interrupted.stockHash];
      cliWatchdogWrite(state);
      cliWatchdogEvent(state, "traffic_proof_interrupted", now);
      return state;
    }
    if (!host.supervisor.busy && !repair.wasBusy) repair.idleWaitMs += Math.max(0, now - repair.lastCheckedAtMs);
    repair.wasBusy = host.supervisor.busy;
    repair.lastCheckedAtMs = now;
    if (repair.idleWaitMs >= 120000) return cliWatchdogFail(state, "restart_receipt_timeout", now);
    if (Number.isFinite(repair.requestedAtMs) && now - repair.requestedAtMs >= CLI_RESTART_WAIT_LIMIT_MS) {
      // The restart was never applied and the supervisor being busy is the only
      // reason; stop verifying and watch again instead of waiting forever.
      state.phase = "watching";
      // The patched bytes are on disk, but no receipt ever proved a host loaded
      // them, so they must not be adopted as verified: a null baseline turns the
      // next observation of that same file into a loud "these bytes are not the
      // ones I verified" instead of a silent equality check that stands in for
      // proof nobody obtained.
      state.baselineHash = null;
      if (state.attempts[repair.stockHash] != null) {
        state.attempts[repair.stockHash].phase = "loaded_unverified";
        state.attempts[repair.stockHash].verifiedAtMs = now;
      }
      state.repair = null;
      state.observed = null;
      cliWatchdogWrite(state);
      cliWatchdogEvent(state, "restart_wait_abandoned", now);
      return state;
    }
    state.phase = "awaiting_restart";
    cliWatchdogWrite(state);
    return state;
  }
  if (state.phase !== "awaiting_traffic") {
    state.phase = "awaiting_traffic";
    repair.receiptPid = pid;
    repair.receiptAtMs = receipt.atMs;
    repair.trafficWaitStartMs = now;
    cliWatchdogWrite(state);
    cliWatchdogEvent(state, "runtime_loaded", now);
  }
  var entries = cliReadLog(500);
  var traffic = entries.filter(function (entry) {
    return entry != null && entry.kind !== "test" && (entry.kind === "turn" || entry.kind === "subagent" || entry.kind === "main") && entry.hostPid === pid && entry.patchVersion === CLI_VERSION && entry.provider === state.provider && Date.parse(entry.ts) >= Math.max(repair.requestedAtMs, receipt.atMs);
  });
  var successes = 0;
  var failures = 0;
  var definitive = false;
  for (var t = 0; t < traffic.length; t += 1) {
    var sample = traffic[t];
    var ok = !sample.error && Number.isFinite(sample.status) && sample.status >= 200 && sample.status < 300;
    if (ok) { successes += 1; continue; }
    failures += 1;
    // A 401/403/404 says the route itself is wrong. 429, 5xx and a network error
    // are transient, and the first request after a restart routinely hits one -
    // a single one used to latch the guardian off for good.
    if (!sample.error && Number.isFinite(sample.status) && sample.status >= 400 && sample.status < 500 && sample.status !== 429) definitive = true;
  }
  if (successes === 0 && (definitive || failures > 1)) return cliWatchdogFail(state, "real_request_failed", now);
  if (successes === 0) {
    if (!Number.isFinite(repair.trafficWaitStartMs)) { repair.trafficWaitStartMs = now; cliWatchdogWrite(state); return state; }
    if (now - repair.trafficWaitStartMs < CLI_TRAFFIC_PROOF_TIMEOUT_MS) return state;
    // Nothing to judge and nothing left to wait for: watch the host again (not
    // "healthy" - no request was proven) so a later stock push is repaired
    // instead of inheriting a stale verification.
    state.phase = "watching";
    state.baselineHash = snapshot.hash;
    if (state.attempts[repair.stockHash] != null) {
      state.attempts[repair.stockHash].phase = "loaded_unverified";
      state.attempts[repair.stockHash].verifiedAtMs = now;
    }
    state.repair = null;
    state.observed = null;
    cliWatchdogWrite(state);
    cliWatchdogEvent(state, "traffic_idle_timeout", now);
    return state;
  }
  state.phase = "healthy";
  state.baselineHash = snapshot.hash;
  state.lastHealthyAtMs = now;
  // The timeout branch above guards this same lookup; an unguarded dereference
  // here turned a pruned/absent record into "host_observation_failed", a reason
  // the keeper never re-arms, so the guardian stayed off until a human acted.
  if (state.attempts[repair.stockHash] != null) {
    state.attempts[repair.stockHash].phase = "verified";
    state.attempts[repair.stockHash].verifiedAtMs = now;
  }
  state.repair = null;
  state.observed = null;
  cliWatchdogWrite(state);
  cliWatchdogEvent(state, "traffic_verified", now);
  return state;
}

function cliWatchdogTick(nowMs) {
  var now = nowMs == null ? Date.now() : Number(nowMs);
  if (!Number.isFinite(now)) throw new CliError("watchdog timestamp must be finite");
  return grokSwitchWithMaintenanceLock(function () {
    var state = null;
    var stage = "state_read_failed";
    try {
      state = cliWatchdogRead();
      if (state == null || !state.enabled) return state || { schemaVersion: 1, enabled: false, phase: "disabled", attempts: {} };
      stage = "config_read_failed";
      // Official mode idles the guardian instead of killing it; anything else
      // that stops matching the bound config is still a hard, loud failure.
      if (cliWatchdogOfficialMode()) return cliWatchdogSuppress(state, now);
      if (state.phase === "suppressed") {
        var resumed = cliWatchdogResume(state, now);
        if (resumed == null) return cliWatchdogFail(state, "config_changed", now);
        state = resumed;
      }
      if (!cliWatchdogBoundConfig(state)) return cliWatchdogFail(state, "config_changed", now);
      if (state.phase === "repairing") {
        // A tick that died mid-repair used to disable the guardian for good, which
        // needs a human to notice. Stand back up instead and re-observe the host on
        // the next tick; a genuinely damaged bundle still fails loudly and specifically.
        var abandoned = state.repair;
        state.repair = null;
        state.observed = null;
        state.phase = "watching";
        if (abandoned != null && abandoned.stockHash) delete state.attempts[abandoned.stockHash];
        cliWatchdogWrite(state);
        cliWatchdogEvent(state, "repair_interrupted_recovered", now);
        return state;
      }
      stage = "host_observation_failed";
      var snapshot = cliWatchdogSnapshot();
      var host = cliHostState();
      if (state.phase === "awaiting_restart" || state.phase === "awaiting_traffic") return cliWatchdogVerifyRepair(state, snapshot, host, now);
      if (snapshot.info.patched) {
        var ours = cliPatchIsCurrent(snapshot.info);
        // The exact build we would write, around bytes we already verified.
        if (ours && snapshot.hash === state.baselineHash) {
          if (state.observed != null) { state.observed = null; state.phase = "watching"; cliWatchdogWrite(state); }
          return state;
        }
        // Our current patch, but the file around it is not what we verified: a
        // host we do not know the provenance of. Stay loud and fail closed.
        if (ours) return cliWatchdogFail(state, "patched_host_changed", now);
        // A patch that is not this build (older banner version, or the same
        // banner with a different payload). That is what an upgraded CLI looks
        // like from here, not a host fault: fall through and re-patch like a
        // stock host so an upgrade cannot latch the guardian off until a human
        // re-enables it.
      }
      if (state.observed == null || state.observed.hash !== snapshot.hash || state.observed.identity !== snapshot.identity) {
        state.observed = { hash: snapshot.hash, identity: snapshot.identity, firstSeenAtMs: now };
        state.phase = "stabilizing";
        delete state.notes;
        cliWatchdogWrite(state);
        cliWatchdogEvent(state, snapshot.info.patched ? "patch_drift_observed" : "unpatched_observed", now);
        return state;
      }
      if (now - state.observed.firstSeenAtMs < 30000) return state;
      if (host.supervisor.busy || host.supervisor.pending) return state;
      var priorAttempt = state.attempts[snapshot.hash];
      if (priorAttempt != null) {
        var retryCooldownMs = 6 * 60 * 60 * 1000;
        var priorAtMs = Number.isFinite(priorAttempt.startedAtMs) ? priorAttempt.startedAtMs : 0;
        if (now - priorAtMs < retryCooldownMs) {
          // Cooling down is not a fault: stay enabled and keep observing. Failing
          // closed here stopped every observation for up to six hours, and
          // "stock_already_attempted" is not a reason the keeper re-arms, so only
          // a human could bring the guardian back. The attempt record stays, so
          // the retry is still skipped until the cooldown ages out.
          if (priorAttempt.cooldownObservedAtMs == null) {
            priorAttempt.cooldownObservedAtMs = now;
            state.phase = "watching";
            // Leaving the guardian enabled is not the same as saying the host is
            // healthy: name the wait in the state itself, so `watchdog status`
            // shows it without --json.
            state.notes = "stock repair deferred until " + new Date(priorAtMs + retryCooldownMs).toISOString();
            cliWatchdogWrite(state);
            cliWatchdogEvent(state, "stock_retry_cooling_down", now);
          }
          return state;
        }
        delete state.attempts[snapshot.hash];
        delete state.notes;
      }
      // Recheck every dependency while holding the cooperative maintenance lock.
      if (!cliWatchdogBoundConfig(state)) return cliWatchdogFail(state, "config_changed", now);
      var fresh = cliWatchdogSnapshot();
      if (fresh.hash !== snapshot.hash || fresh.identity !== snapshot.identity) return cliWatchdogFail(state, "host_changed_before_repair", now);
      host = cliHostState();
      if (host.supervisor.busy || host.supervisor.pending) return state;
      var backupPath = cliWatchdogPath("host-before-watchdog-" + snapshot.hash + "-" + now + ".cjs");
      state.phase = "repairing";
      state.repair = { stockHash: snapshot.hash, oldPid: host.process && host.process.pid, startedAtMs: now };
      state.attempts[snapshot.hash] = { phase: "started", startedAtMs: now, backupPath: backupPath };
      cliWatchdogPruneAttempts(state);
      stage = "attempt_persist_failed";
      cliWatchdogWrite(state); // Durable attempt precedes every host write.
      stage = "backup_failed";
      var fd = cliFs.openSync(backupPath, "wx", 384);
      try { cliFs.writeFileSync(fd, snapshot.text); cliFs.fsyncSync(fd); } finally { cliFs.closeSync(fd); }
      stage = "compatibility_check_failed";
      cliAssertPatchable(snapshot.info.stock);
      stage = "patch_failed";
      var stockHashBefore = cliHash(snapshot.info.stock);
      var outcome = cliEnsurePatched(snapshot);
      if (outcome !== "patched" && outcome !== "updated") return cliWatchdogFail(state, "host_changed_before_patch", now);
      var patched = cliWatchdogSnapshot();
      if (!cliPatchIsCurrent(patched.info) || cliHash(patched.info.stock) !== stockHashBefore) return cliWatchdogFail(state, "patch_verification_failed", now);
      if (!cliWatchdogBoundConfig(state)) return cliWatchdogFail(state, "config_changed_after_patch", now);
      stage = "restart_failed";
      var restart = cliRequestRestart("grok-switch watchdog " + snapshot.hash);
      if (!restart.issued) return cliWatchdogFail(state, "restart_command_conflict", now);
      state.repair.patchedHash = patched.hash;
      state.repair.requestedAtMs = now;
      state.repair.restartId = restart.command.id;
      state.repair.idleWaitMs = 0;
      state.repair.lastCheckedAtMs = now;
      state.repair.wasBusy = false;
      state.phase = "awaiting_restart";
      state.attempts[snapshot.hash].phase = "restart_requested";
      cliWatchdogWrite(state);
      cliWatchdogEvent(state, "restart_requested", now);
      return state;
    } catch (_error) {
      // The finite stage code is actionable without leaking exception payloads.
      return cliWatchdogFail(state, stage, now);
    }
  });
}

function cliWatchdogEnable() {
  return grokSwitchWithMaintenanceLock(cliWatchdogEnableLocked);
}

function cliWatchdogEnableLocked() {
  var previous = cliWatchdogRead();
  var configText = grokSwitchReadConfigText();
  var route = grokSwitchResolveRoute();
  if (configText == null || route.kind !== "external") throw new CliError("watchdog enable requires a valid external provider");
  var snapshot = cliWatchdogSnapshot();
  if (!cliPatchIsCurrent(snapshot.info)) throw new CliError("watchdog enable requires the current version and payload already patched; repair manually first");
  var host = cliHostState();
  if (host.process == null || !Number.isFinite(host.process.startedAtMs)) throw new CliError("watchdog enable requires a running host process with a known start time");
  if (host.supervisor.pending) throw new CliError("watchdog enable must wait for the pending supervisor restart or operation");
  var receipt = cliWatchdogReceipt();
  if (receipt == null || receipt.pid !== host.process.pid || receipt.patchVersion !== CLI_VERSION || receipt.bundleHash !== snapshot.hash || !Number.isFinite(receipt.atMs) || receipt.atMs < host.process.startedAtMs) {
    throw new CliError("watchdog enable requires a current-PID runtime receipt matching the running patch version and bundle hash; complete manual recovery first");
  }
  if (previous && previous.enabled) {
    if (previous.configHash !== cliHash(configText) || previous.baselineHash !== snapshot.hash) throw new CliError("watchdog is already enabled with different state; disable and resolve manually first");
    return previous;
  }
  var state = { schemaVersion: 1, enabled: true, phase: "watching", enabledAtMs: Date.now(), configHash: cliHash(configText), provider: route.provider.name, baselineHash: snapshot.hash, observed: null, repair: null, attempts: previous ? previous.attempts : {} };
  cliWatchdogWrite(state);
  cliWatchdogEvent(state, "enabled", Date.now());
  return state;
}

function cliWatchdogReadOrNull() {
  try { return cliWatchdogRead(); } catch (_error) { return null; }
}

// A manual command disables the guardian before it touches anything, and that
// stays off until something re-enables it - normally the box keeper, the only
// automatic path. When the command turns out to be a no-op there is nothing to
// protect against, so put the guardian back instead of leaving the deployment
// guarded only by the keeper. Anything that really moved (configuration, host
// bytes) is left alone: a rebind must stay an explicit act.
function cliWatchdogFailureDetail(error) {
  var text = error == null ? "" : String(error.message || error);
  return text.split("\n")[0].slice(0, 160);
}

// Returns null when there was nothing to restore, {ok:true,state} when the
// guardian is back on, and {ok:false,reason[,detail]} when it was enabled before
// the command and could not be put back. The caller must surface the failure:
// the old bare null covered "not applicable" and "failed" alike, which is how a
// disabled guardian went unnoticed until the keeper happened to retry.
function cliWatchdogRestoreAfterNoop(prior) {
  if (prior == null || prior.enabled !== true) return null;
  try {
    return grokSwitchWithMaintenanceLock(function () {
      var state = cliWatchdogRead();
      if (state == null) return { ok: false, reason: "state_missing" };
      if (state.enabled === true) return { ok: true, state: state };
      var text = grokSwitchReadConfigText();
      if (text == null || cliHash(text) !== prior.configHash) return { ok: false, reason: "config_changed" };
      if (cliWatchdogSnapshot().hash !== prior.baselineHash) return { ok: false, reason: "host_bytes_changed" };
      return { ok: true, state: cliWatchdogEnableLocked() };
    });
  } catch (error) {
    return { ok: false, reason: "enable_refused", detail: cliWatchdogFailureDetail(error) };
  }
}

// "official" is a deliberate, expected route: the guardian's own state machine
// represents it as suppressed (still enabled, quiet) and resumes by itself when
// an external provider comes back. The manual command used to leave it disabled
// instead, which the keeper reads as a disabled guardian on the official route.
function cliWatchdogSuppressAfterOfficial(prior) {
  if (prior == null || prior.enabled !== true) return null;
  try {
    return grokSwitchWithMaintenanceLock(function () {
      var state = cliWatchdogRead();
      if (state == null) return { ok: false, reason: "state_missing" };
      if (state.enabled === true) return { ok: true, state: state };
      if (!cliWatchdogOfficialMode()) return { ok: false, reason: "not_official" };
      state.enabled = true;
      state.attempts = state.attempts || {};
      delete state.disabledReason;
      delete state.disabledAtMs;
      return { ok: true, state: cliWatchdogSuppress(state, Date.now()) };
    });
  } catch (error) {
    return { ok: false, reason: "suppress_refused", detail: cliWatchdogFailureDetail(error) };
  }
}

function cliWatchdogDisable() {
  return grokSwitchWithMaintenanceLock(function () {
    var state = cliWatchdogRead() || { schemaVersion: 1, attempts: {} };
    state.enabled = false;
    state.phase = "disabled";
    state.disabledReason = "manual_disable";
    state.disabledAtMs = Date.now();
    cliWatchdogWrite(state);
    cliWatchdogEvent(state, "disabled", state.disabledAtMs);
    return state;
  });
}

function cliWatchdogAcquireDaemon() {
  return grokSwitchWithMaintenanceLock(cliWatchdogAcquireDaemonLocked);
}

function cliWatchdogAcquireDaemonLocked() {
  grokSwitchAssertMaintenanceLock();
  cliFs.mkdirSync(CLI_CONFIG_DIR, { recursive: true, mode: 448 });
  var dir = cliWatchdogPath("watchdog-daemon.lock");
  var ownerPath = cliPath.join(dir, "owner.json");
  var token = require("node:crypto").randomBytes(16).toString("hex");
  try { cliFs.mkdirSync(dir, { mode: 448 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    var owner;
    try { owner = JSON.parse(cliFs.readFileSync(ownerPath, "utf8")); }
    catch (_error) { throw new CliError("watchdog daemon lock owner unknown; manual intervention required"); }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string") throw new CliError("watchdog daemon lock owner unknown; manual intervention required");
    var dead = false;
    try { process.kill(owner.pid, 0); } catch (probe) { if (probe.code === "ESRCH") dead = true; }
    if (!dead) throw new CliError("watchdog daemon already running or lock owner cannot be verified");
    // Rename a conclusively dead owner's exact directory aside, rather than
    // deleting a path that a second launcher might just have acquired.
    var stale = dir + ".dead-" + token;
    var current = JSON.parse(cliFs.readFileSync(ownerPath, "utf8"));
    if (current.token !== owner.token || current.pid !== owner.pid) throw new CliError("watchdog daemon owner changed during recovery");
    cliFs.renameSync(dir, stale);
    var moved = JSON.parse(cliFs.readFileSync(cliPath.join(stale, "owner.json"), "utf8"));
    if (moved.token !== owner.token || moved.pid !== owner.pid) throw new CliError("watchdog daemon recovery conflict; manual intervention required");
    cliFs.unlinkSync(cliPath.join(stale, "owner.json"));
    cliFs.rmdirSync(stale);
    cliFs.mkdirSync(dir, { mode: 448 });
  }
  cliFs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token: token, atMs: Date.now() }), { flag: "wx", mode: 384 });
  return function () {
    try {
      var owner = JSON.parse(cliFs.readFileSync(ownerPath, "utf8"));
      if (owner.token !== token || owner.pid !== process.pid) return;
      cliFs.unlinkSync(ownerPath);
      cliFs.rmdirSync(dir);
    } catch (_error) {}
  };
}


// The daemon is long-lived, so it keeps running the build it was started from.
// After an upgrade on disk, an old daemon can only misjudge the host: a version
// bump there looks like "someone else edited the host bundle". Hash the half of
// the bundle this process actually executes and stand down when it changes.
function cliWatchdogCodeFingerprint() {
  try {
    var fd = cliFs.openSync(__filename, "r");
    try {
      var before = cliFs.fstatSync(fd);
      var bytes = cliFs.readFileSync(fd);
      var after = cliFs.fstatSync(fd);
      // An in-place rewrite is readable mid-flight, and mtime alone cannot see a
      // rewrite that restored it. Compare the whole identity (including ctime)
      // *and* the number of bytes actually read: a short read is a torn read, and
      // a torn read must never be hashed as if it were the new build - that is a
      // spurious stand-down, and the keeper then relaunches a half-written file.
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
      if (bytes.length !== after.size) return null;
      var pathStat = cliFs.statSync(__filename);
      if (pathStat.dev !== after.dev || pathStat.ino !== after.ino) return null;
      var text = bytes.toString("utf8");
      var end = text.indexOf(CLI_PAYLOAD_END);
      if (end === -1) return null;
      return cliHash(text.slice(end));
    } finally {
      cliFs.closeSync(fd);
    }
  } catch (_error) {
    return null;
  }
}

// What the daemon loop does with one iteration's on-disk fingerprint. A single
// unreadable read keeps the daemon running (the build it started from is the one
// it should trust); a sustained inability to read it is not a transient, so the
// daemon stands down and lets the keeper relaunch the current build.
function cliWatchdogFingerprintDecision(selfFingerprint, onDiskFingerprint, consecutiveUnreadable, limit) {
  if (selfFingerprint != null && onDiskFingerprint != null) return onDiskFingerprint === selfFingerprint ? "ok" : "stale";
  return consecutiveUnreadable >= (limit || 3) ? "stale" : "unstable";
}

// The baseline later reads are compared against. A startup read that failed (a
// torn read, or the bundle momentarily unreadable) used to leave this null for
// the whole process, so every later comparison was null-vs-something and the
// loop stood the daemon down after ~90s even though the file was readable.
// Adopt the first readable fingerprint instead; from then on the comparison is
// real, so a later replacement is still detected and still stands down.
function cliWatchdogFingerprintBaseline(selfFingerprint, onDiskFingerprint) {
  if (selfFingerprint == null && onDiskFingerprint != null) return onDiskFingerprint;
  return selfFingerprint;
}
// Adopting an on-disk fingerprint is a provenance change: the loop may now be
// comparing against a build this process never loaded, so while a later
// replacement is still caught, the daemon can no longer vouch for the bytes it
// started from. That must never be silent - a startup read that failed used to
// leave no trace at all, which is how "running the wrong build" stayed invisible.
function cliWatchdogAdoptFingerprintBaseline(previous, baseline, unreadable) {
  if (previous != null || baseline == null) return false;
  cliPrint("watchdog daemon adopted the on-disk build as its fingerprint baseline after " + unreadable + " unreadable read(s)");
  cliWatchdogEvent({ schemaVersion: 1, enabled: true, phase: "fingerprint_baseline_adopted" }, "fingerprint_baseline_adopted", Date.now());
  cliWatchdogDaemonBeat({ event: "fingerprint_baseline_adopted" });
  return true;
}
// The daemon is long-lived, so a heartbeat on disk is the only way an outside
// observer can tell whether the guardian is actually running, stuck, or gone.
function cliWatchdogDaemonBeat(fields) {
  try {
    var path = cliWatchdogPath("watchdog-daemon.beat.json");
    var entry = { schemaVersion: 1, pid: process.pid, version: CLI_VERSION, atMs: Date.now(), ticks: 0, lastTickAtMs: null, event: null };
    var prev = null;
    try { prev = JSON.parse(cliFs.readFileSync(path, "utf8")); } catch (_ignore) { prev = null; }
    var samePid = prev != null && prev.pid === process.pid;
    if (samePid && Number.isFinite(prev.ticks)) entry.ticks = prev.ticks;
    if (samePid && Number.isFinite(prev.lastTickAtMs)) entry.lastTickAtMs = prev.lastTickAtMs;
    if (fields != null) {
      for (var key in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) entry[key] = fields[key];
      }
    }
    if (fields != null && fields.tick === true) {
      entry.ticks = entry.ticks + 1;
      entry.lastTickAtMs = Date.now();
    }
    delete entry.tick;
    // Replace the heartbeat, never write it in place: watchdog status parses
    // this file and a torn read of a partial write reported a live daemon as
    // DEAD. Same tmp + fsync + rename as cliWatchdogWrite.
    var tmp = path + "." + process.pid + "." + require("node:crypto").randomBytes(8).toString("hex") + ".tmp";
    var fd = cliFs.openSync(tmp, "wx", 384);
    try { cliFs.writeFileSync(fd, JSON.stringify(entry)); cliFs.fsyncSync(fd); }
    finally { cliFs.closeSync(fd); }
    try { cliFs.renameSync(tmp, path); }
    finally { try { cliFs.unlinkSync(tmp); } catch (_error) {} }
    grokSwitchFsyncDir(cliPath.dirname(path));
    grokSwitchSweepTempFilesThrottled(CLI_CONFIG_DIR, GROK_SWITCH_TMP_PREFIXES);
    return entry;
  } catch (_error) {
    return null;
  }
}

// Liveness needs both halves: a pid that answers, and the daemon lock naming that
// same pid. A recycled pid alone would report a dead daemon as alive.
function cliWatchdogDaemonState() {
  var beatPath = cliWatchdogPath("watchdog-daemon.beat.json");
  var beat = null;
  // One retry, belt and braces for the atomic swap above (and for an older
  // deployment that may still write the heartbeat in place).
  for (var read = 0; read < 2 && beat == null; read += 1) {
    try { beat = JSON.parse(cliFs.readFileSync(beatPath, "utf8")); } catch (_ignore) { beat = null; }
  }
  var pid = beat != null && Number.isFinite(beat.pid) ? beat.pid : null;
  var lockPid = null;
  try { lockPid = JSON.parse(cliFs.readFileSync(cliWatchdogPath("watchdog-daemon.lock/owner.json"), "utf8")).pid; } catch (_ignore) { lockPid = null; }
  if (!Number.isFinite(lockPid)) lockPid = null;
  var answers = false;
  if (pid != null) {
    try { process.kill(pid, 0); answers = true; } catch (_error) { answers = false; }
  }
  return {
    pid: pid,
    lockPid: lockPid,
    alive: pid != null && answers && pid === lockPid,
    version: beat != null && beat.version ? beat.version : null,
    ticks: beat != null && Number.isFinite(beat.ticks) ? beat.ticks : null,
    lastTickAgeMs: beat != null && Number.isFinite(beat.lastTickAtMs) ? Date.now() - beat.lastTickAtMs : null,
    lastEvent: beat != null && beat.event ? beat.event : null
  };
}

// A failed attempt used to blacklist a host build forever. Keep the record set
// bounded and let aged ones go, so a platform push can never dead-end here.
function cliWatchdogPruneAttempts(state) {
  var attempts = state.attempts || {};
  var keys = Object.keys(attempts);
  if (keys.length <= 12) return;
  keys.sort(function (a, b) {
    var av = Number.isFinite(attempts[a].startedAtMs) ? attempts[a].startedAtMs : 0;
    var bv = Number.isFinite(attempts[b].startedAtMs) ? attempts[b].startedAtMs : 0;
    return av - bv;
  });
  for (var i = 0; i < keys.length - 12; i += 1) delete attempts[keys[i]];
}
async function cliWatchdogRun() {
  var release = cliWatchdogAcquireDaemon();
  var stopping = false;
  var wake = null;
  var stop = function () { stopping = true; if (wake) wake(); };
  var selfFingerprint = cliWatchdogCodeFingerprint();
  var unreadable = 0;
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    cliPrint("watchdog daemon started; observes every 30s; enable is a separate explicit command");
    cliWatchdogDaemonBeat({ event: "started" });
    while (!stopping) {
      var onDiskFingerprint = cliWatchdogCodeFingerprint();
      var previousBaseline = selfFingerprint;
      selfFingerprint = cliWatchdogFingerprintBaseline(selfFingerprint, onDiskFingerprint);
      cliWatchdogAdoptFingerprintBaseline(previousBaseline, selfFingerprint, unreadable);
      if (selfFingerprint != null && onDiskFingerprint != null) unreadable = 0; else unreadable += 1;
      var fingerprintDecision = cliWatchdogFingerprintDecision(selfFingerprint, onDiskFingerprint, unreadable, 3);
      if (fingerprintDecision === "unstable") {
        if (unreadable === 1) {
          // Not silent: a build we cannot read is a degraded state an outside
          // observer (watchdog status, the keeper log) can see.
          cliWatchdogEvent({ schemaVersion: 1, enabled: true, phase: "unreadable_build" }, "fingerprint_unstable", Date.now());
          cliWatchdogDaemonBeat({ event: "fingerprint_unstable" });
        }
      } else if (fingerprintDecision === "stale") {
        var fingerprintReason = onDiskFingerprint != null && selfFingerprint != null ? "stale_build" : "unreadable_build";
        cliPrint("watchdog daemon build changed or became unreadable on disk; standing down so the keeper relaunches the current build");
        cliWatchdogEvent({ schemaVersion: 1, enabled: true, phase: fingerprintReason }, fingerprintReason, Date.now());
        cliWatchdogDaemonBeat({ event: fingerprintReason });
        stopping = true;
        break;
      }
      var tickState = null;
      try { tickState = await cliWatchdogTick(); }
      catch (_error) { cliPrint("watchdog observation blocked; no host repair attempted outside the maintenance lock"); }
      cliWatchdogDaemonBeat({ event: tickState != null && tickState.phase ? tickState.phase : "observation_blocked", tick: true });
      if (!stopping) await new Promise(function (resolve) {
        var timer = setTimeout(function () { wake = null; resolve(); }, 30000);
        wake = function () { clearTimeout(timer); wake = null; resolve(); };
      });
    }
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    release();
  }
}

// Keeper = the supervisor above the daemon: it relaunches the daemon, gives a
// wedged daemon a kick, and keeps the carrier harness-guard alive. Its heartbeat
// is written once per tick (intervalSec, default 300s), so liveness means "beat
// within two intervals". An open ALERT means the keeper saw something it would
// not fix by itself - that is the whole point of showing it here.
var CLI_KEEPER_VAR_DIR = process.env.GROK_SWITCH_KEEPER_VAR || "/home/box/codex-net";
function cliKeeperPidAlive(pid) {
  try {
    var stat = cliFs.readFileSync(cliPath.join(CLI_PROC_ROOT, String(pid), "stat"), "utf8");
    return !/\)\s*Z/.test(stat);
  } catch (_error) {
    return false;
  }
}
// The heartbeat is written by the keeper itself, so on its own it is a claim, not
// evidence: a recycled pid, or a heartbeat carried over between installs, used to
// read as "keeper: alive" while nothing was relaunching anything. Cross-check the
// pid it names against what that pid actually is. Two independent signals count:
// the argv of a keeper launch (/proc/<pid>/cmdline), or a process start time that
// agrees with the uptime the heartbeat reports. Anything else is "unknown", which
// reads as not alive - the conservative direction.
function cliKeeperPidIdentity(pid, hb) {
  var argv = null;
  try { argv = cliFs.readFileSync(cliPath.join(CLI_PROC_ROOT, String(pid), "cmdline"), "utf8").split("\0"); } catch (_error) { argv = null; }
  if (argv != null) {
    for (var i = 0; i < argv.length; i += 1) {
      if (argv[i] === cliPath.join(GROK_SWITCH_DIR, "watchdog-keeper.cjs") || cliPath.basename(argv[i]) === "watchdog-keeper.cjs") return "cmdline";
    }
  }
  var startedAtMs = cliPidStartedAtMs(pid);
  if (startedAtMs != null && hb != null && Number.isFinite(Number(hb.uptimeSec))) {
    var expectedStartMs = Date.now() - Number(hb.uptimeSec) * 1000;
    if (Math.abs(startedAtMs - expectedStartMs) <= 120000) return "starttime";
  }
  return null;
}
function cliKeeperState() {
  var out = { alive: false, pid: null, ageMs: null, intervalSec: null, alert: null, notes: null, identity: null };
  try {
    var hb = JSON.parse(cliFs.readFileSync(cliPath.join(CLI_KEEPER_VAR_DIR, "grok-switch-keeper.heartbeat.json"), "utf8"));
    out.pid = hb.pid != null ? Number(hb.pid) : null;
    out.intervalSec = hb.intervalSec != null ? Number(hb.intervalSec) : 300;
    if (hb.at) out.ageMs = Math.max(0, Date.now() - Date.parse(hb.at));
    out.notes = hb.notes || null;
    var budget = (out.intervalSec || 300) * 1000 * 2;
    var fresh = out.ageMs != null && out.ageMs <= budget;
    if (fresh && out.pid != null && cliKeeperPidAlive(out.pid)) out.identity = cliKeeperPidIdentity(out.pid, hb);
    out.alive = fresh && out.pid != null && out.identity != null;
  } catch (_error) {}
  try { out.alert = String(cliFs.readFileSync(cliPath.join(CLI_KEEPER_VAR_DIR, "grok-switch-keeper.ALERT"), "utf8")).trim() || null; } catch (_error) {}
  return out;
}
async function cliCommandWatchdog(args) {
  var action = args.positional[1] || "status";
  if (action === "run") return cliWatchdogRun();
  var state;
  if (action === "enable") state = await cliWatchdogEnable();
  else if (action === "disable") state = await cliWatchdogDisable();
  else if (action === "once") state = await cliWatchdogTick();
  else if (action === "status") {
    var statusState = cliWatchdogRead() || { schemaVersion: 1, enabled: false, phase: "disabled", attempts: {} };
    state = Object.assign({}, statusState, { daemon: cliWatchdogDaemonState(), keeper: cliKeeperState() });
  }
  else throw new CliError("usage: watchdog enable | disable | status [--json] | once | run");
  if (args.flags && args.flags.json) cliPrint(JSON.stringify(state, null, 2));
  else {
    cliPrint("watchdog: " + (state.enabled ? "enabled" : "disabled") + " / " + state.phase);
    if (state.provider) cliPrint("bound provider: " + state.provider);
    if (state.disabledReason) cliPrint("reason: " + state.disabledReason + "; resolve manually, then explicitly enable");
    if (state.suppressedReason) cliPrint("suppressed: official Grok selected; watching resumes by itself when an external provider is active again");
    if (state.notes) cliPrint("note: " + state.notes);
    cliPrint("state: " + cliWatchdogPath("watchdog.json"));
    var daemonInfo = state.daemon || cliWatchdogDaemonState();
    cliPrint("daemon: " + (daemonInfo.alive ? "alive" : "DEAD")
      + (daemonInfo.pid != null ? " pid=" + daemonInfo.pid : "")
      + (daemonInfo.ticks != null ? " ticks=" + daemonInfo.ticks : "")
      + (daemonInfo.lastTickAgeMs != null ? " lastTick=" + Math.round(daemonInfo.lastTickAgeMs / 1000) + "s ago" : "")
      + "; if this says DEAD the guardian is not observing anything");
    cliPrint("events: " + cliWatchdogPath("watchdog.log"));
    var keeperInfo = state.keeper || cliKeeperState();
    cliPrint("keeper: " + (keeperInfo.alive ? "alive" : "DEAD")
      + (keeperInfo.pid != null ? " pid=" + keeperInfo.pid : "")
      + (keeperInfo.ageMs != null ? " lastBeat=" + Math.round(keeperInfo.ageMs / 1000) + "s ago" : "")
      + (keeperInfo.intervalSec != null ? " (expects a beat every " + keeperInfo.intervalSec + "s)" : "")
      + (keeperInfo.identity != null ? " identity=" + keeperInfo.identity : "")
      + "; if this says DEAD nothing is relaunching the daemon or the harness-guard");
    if (keeperInfo.alert) cliPrint("ALERT: " + keeperInfo.alert);
  }
  return state;
}
