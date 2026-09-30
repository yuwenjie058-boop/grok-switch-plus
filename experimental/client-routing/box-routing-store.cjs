// Embedded in the version-checked coordinator patch. No credentials or prompts
// are persisted: only confirmed box agent UUIDs and bounded health metadata.
function __gsRoutingDir(options = {}) {
  return typeof options.dataDir === 'string' && options.dataDir.length > 0
    ? options.dataDir : null;
}
function __gsBoxRouting(dataDir) {
  try {
    if (!__gsRoutingDir({ dataDir })) return false;
    return require('node:fs').existsSync(require('node:path').join(
      __gsRoutingDir({ dataDir }), 'grok-switch-box-routing'));
  } catch { return false; }
}
function __gsAtomicJson(file, value) {
  const fs = require('node:fs'), tmp = file + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return null;
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    return typeof error?.code === 'string' ? error.code : 'write_failed';
  }
}
function __gsAgentId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
function __gsReadPins(file) {
  const fs = require('node:fs');
  if (fs.statSync(file).size > 2 * 1024 * 1024) throw { code: 'cache_too_large' };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || data.version !== 1 || !Array.isArray(data.agentIds) || data.agentIds.length > 10000
      || !data.agentIds.every(__gsAgentId)) throw { code: 'invalid_cache' };
  return data.agentIds;
}
function __gsRoutingClock() {
  return { schedule(delay, callback) {
    const handle = setTimeout(callback, delay); handle.unref?.();
    return { dispose: () => clearTimeout(handle) };
  } };
}
function Rb(__gsOptions = {}) {
  const __gsDir = __gsRoutingDir(__gsOptions);
  const __gsEnabled = __gsBoxRouting(__gsDir);
  const __gsPinsFile = __gsDir && require('node:path').join(__gsDir, 'grok-switch-box-agents.json');
  const __gsStatusFile = __gsDir && require('node:path').join(__gsDir, 'grok-switch-routing-status.json');
  let harnesses = new Map(), requiredAgents = new Set(), activeAgentId, boxAgents = __gsEnabled ? new Set() : null;
  const __gsClock = __gsOptions.clock || __gsRoutingClock();
  let __gsWriteRetry = null, __gsWriteFailures = 0, __gsStopped = false;
  const __gsHealth = { patchVersion: 'box-routing-v4', pid: process.pid,
    startedAt: new Date().toISOString(), enabled: __gsEnabled, loadedCount: 0 };
  if (__gsEnabled) {
    try {
      for (const id of __gsReadPins(__gsPinsFile)) { boxAgents.add(id); harnesses.set(id, 'box'); }
      __gsHealth.loadedCount = boxAgents.size;
    } catch (error) {
      if (error?.code !== 'ENOENT') __gsHealth.cacheReadError = error?.code || 'invalid_cache';
    }
  }
  function __gsStatus(extra = {}) {
    if (!__gsEnabled) return;
    Object.assign(__gsHealth, extra, { boxCount: boxAgents.size, updatedAt: new Date().toISOString() });
    delete __gsHealth.statusWriteError;
    const error = __gsAtomicJson(__gsStatusFile, __gsHealth);
    if (error) __gsHealth.statusWriteError = error;
  }
  function __gsSavePins() {
    if (!__gsEnabled) return;
    __gsWriteRetry?.dispose(); __gsWriteRetry = null;
    const fs = require('node:fs'), lockFile = __gsPinsFile + '.lock';
    let lock, error;
    try {
      // Never steal a lock based on age: an active owner may be suspended.
      // An abandoned lock requires operator cleanup with all clients stopped.
      lock = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      let saved;
      try {
        saved = __gsReadPins(__gsPinsFile);
        // Serialize read/merge/write so overlapping coordinators cannot erase
        // IDs learned by the other process after our startup snapshot.
        for (const id of saved) { boxAgents.add(id); harnesses.set(id, 'box'); requiredAgents.delete(id); }
      } catch (caught) {
        if (caught?.code !== 'ENOENT') __gsHealth.cacheReadError = caught?.code || 'invalid_cache';
      }
      const ids = [...boxAgents].filter(__gsAgentId).sort();
      if (!ids.length) return;
      const unchanged = saved && JSON.stringify([...saved].sort()) === JSON.stringify(ids);
      error = ids.length > 10000 ? 'cache_too_large'
        : unchanged ? null : __gsAtomicJson(__gsPinsFile, { version: 1, agentIds: ids });
    } catch (caught) { error = caught?.code || 'write_failed'; }
    finally {
      if (lock !== undefined) {
        try { fs.closeSync(lock); } catch {}
        try { fs.unlinkSync(lockFile); } catch {}
      }
    }
    if (error) {
      __gsHealth.cacheWriteError = error;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(__gsWriteFailures++, 5));
      __gsHealth.cacheRetryMs = __gsStopped ? null : delay;
      if (!__gsStopped) __gsWriteRetry = __gsClock.schedule(delay, () => {
        __gsWriteRetry = null; __gsSavePins(); __gsStatus();
      });
    } else {
      __gsWriteFailures = 0;
      delete __gsHealth.cacheWriteError; delete __gsHealth.cacheReadError;
      delete __gsHealth.cacheRetryMs;
    }
  }
  __gsStatus();
  return {
    __gsOwnsBox: n => boxAgents !== null && boxAgents.has(n),
    __gsStatus,
    __gsStop() {
      __gsStopped = true;
      if (__gsWriteRetry) { __gsSavePins(); __gsStatus(); }
      __gsWriteRetry?.dispose(); __gsWriteRetry = null;
    },
    requiredAgents,
    harnessOf: n => boxAgents !== null && boxAgents.has(n) ? 'box' : harnesses.get(n),
    noteRoster({ agents: n }) {
      if (!Array.isArray(n)) return false;
      let o = false;
      for (let a of n) {
        if (!G(a) || typeof a.id !== 'string') continue;
        let i = a.id, l = LD({ raw: a.harness, previous: harnesses.get(i) });
        if (boxAgents !== null) {
          if (a.harness === undefined) {
            boxAgents.add(i); l = 'box';
          } else if (boxAgents.has(i)) { l = 'box'; }
        }
        harnesses.set(i, l);
        if (l === 'temporal') { o ||= !requiredAgents.has(i); requiredAgents.add(i); }
        else requiredAgents.delete(i);
      }
      __gsSavePins();
      __gsStatus({ lastRosterCount: n.length });
      return o;
    },
    noteGatewaySession({ payload: n }) {
      if (G(n) && typeof n.activeAgentId === 'string') activeAgentId = n.activeAgentId;
    },
    gatewayTranscript({ payload: n, legacyServerActive: o }) {
      if (!G(n)) return o ? null : n;
      let a = n.type === 'snapshot' ? n.activeAgentId : n.agentId;
      if (a !== undefined && (typeof a !== 'string' || a.length === 0)) return null;
      let i = a ?? activeAgentId;
      if (o && !(boxAgents !== null && boxAgents.has(i))) return null;
      let l = [...harnesses.values()].some(u => u !== 'box');
      if (i === undefined && l) return null;
      let c = i === undefined ? undefined : harnesses.get(i);
      return c === 'temporal' || c === 'unsupported' ? null
        : i !== undefined && n.type !== 'snapshot' && n.agentId === undefined && l
          ? { ...n, agentId: i } : n;
    }
  };
}

// Coalesces seed requests, retries until recovery, and discards stale responses
// after a transport reset. This helper is exercised with a deterministic clock.
function __gsRosterSeed({ read, install, report = () => {}, clock }) {
  clock ||= __gsRoutingClock();
  let active = false, stopped = false, epoch = 0, inFlight = null, timer = null;
  let failures = 0, attempts = 0;
  function cancelTimer() { timer?.dispose(); timer = null; }
  function reset() {
    active = false; epoch++; inFlight = null; cancelTimer(); failures = 0;
    report({ seedState: stopped ? 'stopped' : 'disconnected', seedAttempts: attempts, nextRetryMs: null });
  }
  function request() {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight.promise;
    active = true; cancelTimer();
    const ticket = { epoch, promise: null }; inFlight = ticket;
    ticket.promise = Promise.resolve().then(async () => {
      if (!active || stopped || ticket.epoch !== epoch) return;
      attempts++;
      report({ seedState: 'loading', seedAttempts: attempts, nextRetryMs: null });
      try {
        const rows = await read();
        if (!active || stopped || ticket.epoch !== epoch) return;
        if (!Array.isArray(rows)) throw { code: 'invalid_roster' };
        install(rows); failures = 0;
        report({ seedState: 'ready', seedAttempts: attempts, seedCount: rows.length,
          seedFailure: null, nextRetryMs: null });
      } catch (error) {
        if (!active || stopped || ticket.epoch !== epoch) return;
        failures++;
        const delay = Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5));
        report({ seedState: 'retrying', seedAttempts: attempts,
          seedFailure: typeof error?.code === 'string' ? error.code : 'read_failed', nextRetryMs: delay });
        timer = clock.schedule(delay, () => { timer = null; request(); });
      } finally { if (inFlight === ticket) inFlight = null; }
    });
    return ticket.promise;
  }
  return { request, reset, stop() { stopped = true; reset(); } };
}
