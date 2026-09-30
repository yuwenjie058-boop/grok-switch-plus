// Shared by the injected host and CLI. All names stay in the grokSwitch
// namespace. Only cooperating writers honor this lock; the official updater
// requires a separate snapshot recheck immediately before file replacement.
var GROK_SWITCH_RUNTIME_VERSION = "__GROK_SWITCH_RUNTIME_VERSION__";
var grokSwitchMaintenanceHeld = false;
var grokSwitchConfigSnapshots = new WeakMap();
var grokSwitchRuntimeReceipt = null;
// Capture once during module evaluation, before a later disk update can be
// mistaken for the bytes loaded by this process. CLI loading does not publish.
var grokSwitchLoadedBundleHash = (function () {
  try {
    return require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(__filename)).digest("hex");
  } catch (_error) {
    return null;
  }
})();

function grokSwitchHash(value) {
  return require("node:crypto").createHash("sha256").update(value).digest("hex");
}

function grokSwitchUniqueSuffix() {
  return process.pid + "-" + require("node:crypto").randomBytes(12).toString("hex");
}

// The atomic tmp+rename dance only protects a reader if the new name survives a
// crash: fsyncSync flushes a file's contents, not the directory entry that points
// at it, so a power loss can still roll the rename back and silently restore the
// previous file - exactly the "the phase/beat went backwards" symptom the swap
// was introduced to end. Best effort by design: a filesystem that will not open a
// directory, or a platform without directory fds, must never turn a completed
// write into an error.
function grokSwitchFsyncDir(dirPath) {
  var fs = grokSwitchFs();
  var fd = null;
  try {
    fd = fs.openSync(dirPath, "r");
    fs.fsyncSync(fd);
  } catch (_error) {
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_closeError) {} }
  }
}

// A process killed between "write the tmp file" and "rename it into place"
// (SIGKILL, power loss, a full disk) leaves that tmp file behind, and nothing
// ever collected them. An hour is far past any live writer, and these prefixes
// are names only these writers use. The tmp name is not always suffixed ".tmp"
// (the host bundle candidate ends in ".tmp.cjs"), so a match is "starts with one
// of our prefixes and mentions .tmp", not "ends with .tmp".
var GROK_SWITCH_TMP_PREFIXES = ["watchdog.json.", "watchdog-daemon.beat.json."];
var GROK_SWITCH_TMP_MAX_AGE_MS = 60 * 60 * 1000;
var grokSwitchTempSweepAtMs = Object.create(null);

function grokSwitchSweepTempFiles(dirPath, prefixes, nowMs) {
  var fs = grokSwitchFs();
  var now = Number.isFinite(nowMs) ? nowMs : Date.now();
  var names;
  var removed = 0;
  try { names = fs.readdirSync(dirPath); } catch (_error) { return 0; }
  for (var i = 0; i < names.length; i += 1) {
    var name = names[i];
    var matched = false;
    for (var p = 0; p < prefixes.length; p += 1) if (name.indexOf(prefixes[p]) === 0) matched = true;
    if (!matched) continue;
    if (name.indexOf(".tmp") === -1) continue;
    var target = dirPath + "/" + name;
    try {
      var stat = fs.lstatSync(target);
      if (!stat.isFile()) continue; // never follow a link, never remove a directory
      if (now - stat.mtimeMs < GROK_SWITCH_TMP_MAX_AGE_MS) continue;
      fs.unlinkSync(target);
      removed += 1;
    } catch (_error) {}
  }
  return removed;
}

// Called from every state write and heartbeat, so it sweeps at most once an hour
// per directory: these leftovers only matter to the next start.
function grokSwitchSweepTempFilesThrottled(dirPath, prefixes, nowMs) {
  var now = Number.isFinite(nowMs) ? nowMs : Date.now();
  var last = grokSwitchTempSweepAtMs[dirPath];
  if (last != null && now - last < GROK_SWITCH_TMP_MAX_AGE_MS) return 0;
  grokSwitchTempSweepAtMs[dirPath] = now;
  return grokSwitchSweepTempFiles(dirPath, prefixes, now);
}

function grokSwitchAssertMaintenanceLock() {
  if (!grokSwitchMaintenanceHeld) throw new Error("grok-switch: maintenance lock required for mutation");
}

// Only a lock whose owner is provably gone may be reclaimed; anything ambiguous
// is left for a human, exactly as before.
function grokSwitchReclaimDeadMaintenanceLock(fs, lock) {
  var ownerPath = lock + "/owner.json";
  var owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  } catch (_readError) {
    // The claim was interrupted before it was recorded. Wait out the window in
    // which a live process could legitimately be between mkdir and its first write.
    var stat = null;
    try { stat = fs.statSync(lock); } catch (_statError) { return; }
    if (Date.now() - stat.mtimeMs < 60000) return;
    owner = null;
  }
  if (owner != null) {
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return;
    var dead = false;
    try { process.kill(owner.pid, 0); } catch (probe) { if (probe.code === "ESRCH") dead = true; }
    if (!dead) return;
  }
  var stale = lock + ".dead-" + process.pid + "-" + Date.now();
  try { fs.renameSync(lock, stale); } catch (_renameError) { return; }
  var moved = null;
  try { moved = JSON.parse(fs.readFileSync(stale + "/owner.json", "utf8")); } catch (_movedError) { moved = null; }
  if (owner != null && moved != null && (moved.pid !== owner.pid || moved.token !== owner.token)) {
    try { fs.renameSync(stale, lock); } catch (_restoreError) {}
    return;
  }
  try { fs.unlinkSync(stale + "/owner.json"); } catch (_unlinkError) {}
  try { fs.rmdirSync(stale); } catch (_rmdirError) {}
}
function grokSwitchWithMaintenanceLock(fn) {
  if (grokSwitchMaintenanceHeld) throw new Error("grok-switch: maintenance busy; retry after the current operation finishes");
  var fs = grokSwitchFs();
  fs.mkdirSync(GROK_SWITCH_DIR, { recursive: true, mode: 448 });
  var lock = GROK_SWITCH_DIR + "/maintenance.lock";
  try {
    fs.mkdirSync(lock, { mode: 448 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    grokSwitchReclaimDeadMaintenanceLock(fs, lock);
    try {
      fs.mkdirSync(lock, { mode: 448 });
    } catch (retryError) {
      if (retryError.code === "EEXIST") throw new Error("grok-switch: maintenance busy; inspect " + lock + " if an interrupted operation left the lock behind");
      throw retryError;
    }
  }
  var ownerPath = lock + "/owner.json";
  var token = grokSwitchUniqueSuffix();
  try {
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token: token, atMs: Date.now() }), { mode: 384, flag: "wx" });
  } catch (error) {
    // A partial owner record is deliberately retained: it is ambiguous and
    // must never be silently stolen by another process.
    throw error;
  }
  grokSwitchMaintenanceHeld = true;
  var released = false;
  function release() {
    if (released) return;
    released = true;
    grokSwitchMaintenanceHeld = false;
    var owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (owner.token !== token || owner.pid !== process.pid) throw new Error("grok-switch: maintenance lock ownership changed; lock retained");
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lock);
  }
  try {
    var result = fn();
    if (result != null && typeof result.then === "function") {
      return Promise.resolve(result).then(function (value) { release(); return value; }, function (error) { release(); throw error; });
    }
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}

function grokSwitchDisableWatchdog(reason) {
  grokSwitchAssertMaintenanceLock();
  var fs = grokSwitchFs();
  var file = GROK_SWITCH_DIR + "/watchdog.json";
  var state;
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error("grok-switch: watchdog state is unreadable; resolve it before changing configuration");
  }
  if (state == null || typeof state !== "object" || Array.isArray(state)) throw new Error("grok-switch: watchdog state is invalid; mutation stopped");
  state.enabled = false;
  state.disabledReason = String(reason || "manual maintenance");
  state.disabledAtMs = Date.now();
  grokSwitchSweepTempFilesThrottled(GROK_SWITCH_DIR, GROK_SWITCH_TMP_PREFIXES);
  var tmp = file + "." + grokSwitchUniqueSuffix() + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 384, flag: "wx" });
    fs.renameSync(tmp, file);
    grokSwitchFsyncDir(GROK_SWITCH_DIR);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function grokSwitchWithManualMaintenance(reason, fn) {
  return grokSwitchWithMaintenanceLock(function () {
    grokSwitchDisableWatchdog(reason);
    return fn();
  });
}

function grokSwitchTrackConfig(config, text) {
  grokSwitchConfigSnapshots.set(config, text);
  return config;
}

function grokSwitchWriteConfigCAS(config) {
  grokSwitchAssertMaintenanceLock();
  if (!grokSwitchConfigSnapshots.has(config)) throw new Error("grok-switch: config snapshot missing; reread configuration before writing");
  var expected = grokSwitchConfigSnapshots.get(config);
  function check() {
    if (grokSwitchReadConfigText() !== expected) throw new Error("grok-switch: config changed during maintenance; newer configuration preserved");
  }
  check();
  grokSwitchDisableWatchdog("manual configuration change");
  var fs = grokSwitchFs();
  fs.mkdirSync(GROK_SWITCH_DIR, { recursive: true, mode: 448 });
  try { fs.chmodSync(GROK_SWITCH_DIR, 448); } catch (_error) {}
  var text = JSON.stringify(config, null, 2) + "\n";
  var tmp = GROK_SWITCH_CONFIG_PATH + "." + grokSwitchUniqueSuffix() + ".tmp";
  try {
    fs.writeFileSync(tmp, text, { mode: 384, flag: "wx" });
    check();
    fs.renameSync(tmp, GROK_SWITCH_CONFIG_PATH);
    if (grokSwitchReadConfigText() !== text) throw new Error("grok-switch: config changed after replacement; manual inspection required");
    grokSwitchConfigSnapshots.set(config, text);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function grokSwitchPublishRuntimeReceipt() {
  if (grokSwitchRuntimeReceipt != null || grokSwitchLoadedBundleHash == null) return;
  var receipt = { pid: process.pid, patchVersion: GROK_SWITCH_RUNTIME_VERSION, bundleHash: grokSwitchLoadedBundleHash, atMs: Date.now() };
  var fs = grokSwitchFs();
  var file = GROK_SWITCH_DIR + "/runtime-status.json";
  var tmp = file + "." + grokSwitchUniqueSuffix() + ".tmp";
  try {
    fs.mkdirSync(GROK_SWITCH_DIR, { recursive: true, mode: 448 });
    // The host publishes this once, at startup: the cheapest place to collect the
    // tmp files a killed predecessor left in the same directory.
    grokSwitchSweepTempFilesThrottled(GROK_SWITCH_DIR, GROK_SWITCH_TMP_PREFIXES);
    fs.writeFileSync(tmp, JSON.stringify(receipt) + "\n", { mode: 384, flag: "wx" });
    fs.renameSync(tmp, file);
    grokSwitchFsyncDir(GROK_SWITCH_DIR);
    grokSwitchRuntimeReceipt = receipt;
  } catch (_error) {
    // Failing to publish must not prevent ordinary host startup. The guardian
    // will remain unable to establish boot proof and latch for intervention.
  } finally {
    try { fs.unlinkSync(tmp); } catch (_error) {}
  }
}
