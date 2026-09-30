// Anti-silent-revert guard for the watchdog keeper surface.
//
// These symbols arrived with the keeper/daemon patch (the "keeper-surface" step
// of the cloud.11 chain: CLI_KEEPER_VAR_DIR/cliKeeperState, the daemon
// fingerprint + beat, the attempt pruning, the 6h retry cooldown, and the
// daemon/keeper rows in `watchdog status`). They lived only in the deployed
// bundle for a while, so building from this repo silently reverted them - the
// guardian could report "healthy" while nothing was observing or relaunching it.
//
// This test is deliberately about the *built* artifact, not the source: dist/
// grok-switch.cjs is what gets deployed, and the regression being guarded (a
// source tree without the keeper) is invisible in any src-only assertion.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dist = readFileSync(new URL("../dist/grok-switch.cjs", import.meta.url), "utf8");

// Hunk h29: daemon self-fingerprint, heartbeat, liveness, bounded attempts.
// Hunk h30: the daemon loop writes the beat and stands down on a stale build.
// Hunk h31/h32: `watchdog status` reports daemon and keeper, including ALERT.
// Hunk h27: a failed attempt is retried after six hours, not blacklisted forever.
const REQUIRED = [
  ["h29 keeper var dir", 'var CLI_KEEPER_VAR_DIR = process.env.GROK_SWITCH_KEEPER_VAR || "/home/box/codex-net";'],
  ["h29 keeper pid liveness", "function cliKeeperPidAlive("],
  ["h29 keeper state", "function cliKeeperState("],
  ["h29 keeper heartbeat file", 'cliPath.join(CLI_KEEPER_VAR_DIR, "grok-switch-keeper.heartbeat.json")'],
  ["h29 keeper alert file", 'cliPath.join(CLI_KEEPER_VAR_DIR, "grok-switch-keeper.ALERT")'],
  ["h29 daemon fingerprint", "function cliWatchdogCodeFingerprint("],
  ["h29 daemon fingerprint compares payload hash", "return cliHash(text.slice(end));"],
  ["h29 daemon fingerprint refuses a moving file", "if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;"],
  ["h33 daemon fingerprint refuses a torn read", "if (bytes.length !== after.size) return null;"],
  ["h33 daemon fingerprint refuses a swapped path", "if (pathStat.dev !== after.dev || pathStat.ino !== after.ino) return null;"],
  ["h33 sustained unreadable build stands down", "return consecutiveUnreadable >= (limit || 3) ? \"stale\" : \"unstable\";"],
  ["h33 patch identity is the payload", "return info != null && info.patched === true && info.version === CLI_VERSION && info.patchBlock === cliPatchBlock();"],
  ["h33 drifted patch is a compatible update", 'cliWatchdogEvent(state, snapshot.info.patched ? "patch_drift_observed" : "unpatched_observed", now);'],
  ["h33 traffic proof is bounded", "var CLI_TRAFFIC_PROOF_TIMEOUT_MS = 15 * 60 * 1000;"],
  ["h33 interrupted proof re-observes", 'cliWatchdogEvent(state, "traffic_proof_interrupted", now);'],
  ["h33 no-op install restores the guardian", "function cliWatchdogRestoreAfterNoop(prior) {"],
  ["h33 official restores suppression", "function cliWatchdogSuppressAfterOfficial(prior) {"],
  ["h29 daemon beat writer", "function cliWatchdogDaemonBeat("],
  ["h29 daemon liveness needs pid and lock", "function cliWatchdogDaemonState("],
  ["h29 daemon liveness requires the lock to name the pid", "alive: pid != null && answers && pid === lockPid,"],
  ["h29 bounded attempt history", "function cliWatchdogPruneAttempts("],
  ["h29 attempt ceiling is twelve", "if (keys.length <= 12) return;"],
  ["h27 retry cooldown is six hours", "var retryCooldownMs = 6 * 60 * 60 * 1000;"],
  ["h27 a cooled attempt keeps observing, not latched", "if (priorAttempt.cooldownObservedAtMs == null) {"],
  ["h27 the cooldown expires into a retry", "delete state.attempts[snapshot.hash];"],
  ["h34 a busy supervisor cannot pin the restart wait", "var CLI_RESTART_WAIT_LIMIT_MS = 60 * 60 * 1000;"],
  ["h34 the restart wait is abandoned for observation", 'cliWatchdogEvent(state, "restart_wait_abandoned", now);'],
  ["h34 a failed startup fingerprint adopts the next read", "selfFingerprint = cliWatchdogFingerprintBaseline(selfFingerprint, onDiskFingerprint);"],
  ["h34 the heartbeat is swapped into place", "try { cliFs.renameSync(tmp, path); }"],
  ["h34 a failed guardian restore is reported", "function cliGuardianReport(restored, successLine) {"],
  ["h34 install reports a guardian provenance mismatch", "function cliGuardianProvenanceWarning(guardian) {"],
  ["h27 pruning is wired into the tick", "cliWatchdogPruneAttempts(state);"],
  ["h26 interrupted repair is recovered", 'cliWatchdogEvent(state, "repair_interrupted_recovered", now);'],
  ["h26 recovery clears the abandoned attempt", "if (abandoned != null && abandoned.stockHash) delete state.attempts[abandoned.stockHash];"],
  ["h30 daemon announces it started", 'cliWatchdogDaemonBeat({ event: "started" });'],
  ["h30 stale build stands the daemon down", "standing down so the keeper relaunches the current build"],
  ["h30 every tick writes a beat", '"observation_blocked", tick: true });'],
  ["h31 status carries the daemon snapshot", "daemon: cliWatchdogDaemonState(), keeper: cliKeeperState()"],
  ["h32 status prints the daemon row", 'cliPrint("daemon: "'],
  ["h32 status prints the keeper row", 'cliPrint("keeper: "'],
  ["h32 status surfaces an open keeper alert", 'cliPrint("ALERT: "'],
  ["h32 dead daemon is called out", "if this says DEAD the guardian is not observing anything"],
  ["h32 dead keeper is called out", "if this says DEAD nothing is relaunching the daemon or the harness-guard"]
];

test("the built bundle still carries the watchdog keeper surface", () => {
  const missing = REQUIRED.filter(([, needle]) => !dist.includes(needle)).map(([label]) => label);
  assert.deepEqual(missing, [], "the build silently reverted the keeper surface; missing: " + missing.join(", "));
});

test("the keeper surface is declared, not merely mentioned", () => {
  // A stray mention would satisfy includes() but not a deployment: pin the
  // declarations and the status wiring to the exact shapes the box runs.
  for (const [, needle] of REQUIRED) {
    assert.equal(dist.split(needle).length - 1 >= 1, true, "missing: " + needle);
  }
  assert.equal(dist.split("function cliKeeperState(").length - 1, 1, "exactly one cliKeeperState declaration");
  assert.equal(dist.split("function cliWatchdogCodeFingerprint(").length - 1, 1, "exactly one fingerprint declaration");
  assert.match(dist, /cliWatchdogDaemonState\(\)/, "the status command resolves daemon liveness at call time");
});
