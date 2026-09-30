'use strict';
// Only synthetic profiles, harness resolver, IDs and deterministic clocks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const runtime = fs.readFileSync(path.join(__dirname, 'box-routing-store.cjs'), 'utf8');
const stubs = `
function G(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function LD({raw, previous}) { return raw === undefined ? previous ?? 'box'
  : raw === 'box' || raw === 'temporal' ? raw : 'unsupported'; }
`;
const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'];

function clock() {
  const jobs = [];
  return { jobs, schedule(delay, callback) {
    const job = { delay, callback, cancelled: false }; jobs.push(job);
    return { dispose() { job.cancelled = true; } };
  }, fire() {
    const job = jobs.find(item => !item.cancelled);
    assert.ok(job, 'missing retry'); job.cancelled = true; job.callback(); return job.delay;
  }, pending() { return jobs.filter(job => !job.cancelled).length; } };
}

function fixture(t, enabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (enabled) fs.writeFileSync(path.join(root, 'grok-switch-box-routing'), '');
  const context = vm.createContext({ require, process, setTimeout, clearTimeout });
  vm.runInContext(stubs + runtime, context);
  const c = clock(), api = context.Rb({ dataDir: root, clock: c });
  t.after(() => api.__gsStop());
  const pins = path.join(root, 'grok-switch-box-agents.json');
  const status = path.join(root, 'grok-switch-routing-status.json');
  return { root, api, context, c, pins, status,
    saved() { return JSON.parse(fs.readFileSync(pins)).agentIds; },
    health() { return JSON.parse(fs.readFileSync(status)); } };
}

test('confirmed box routes and transcripts survive later harness marks', t => {
  const f = fixture(t);
  f.api.noteRoster({ agents: [{ id: ids[0] }, { id: ids[1], harness: 'temporal' }] });
  f.api.noteRoster({ agents: [{ id: ids[0], harness: 'future-harness' }] });
  assert.equal(f.api.harnessOf(ids[0]), 'box');
  assert.equal(f.api.requiredAgents.has(ids[0]), false);
  assert.equal(f.api.harnessOf(ids[1]), 'temporal');
  assert.equal(f.api.requiredAgents.has(ids[1]), true);
  const payload = { type: 'append', agentId: ids[0] };
  assert.equal(f.api.gatewayTranscript({ payload, legacyServerActive: true }), payload);
  assert.equal(f.api.gatewayTranscript({ payload: { type: 'append', agentId: ids[1] }, legacyServerActive: true }), null);
  assert.deepEqual(f.saved(), [ids[0]]);
});

test('marker kill switch preserves native routing and performs no profile writes', t => {
  const f = fixture(t, false);
  f.api.noteRoster({ agents: [{ id: ids[0] }] });
  f.api.noteRoster({ agents: [{ id: ids[0], harness: 'temporal' }] });
  assert.equal(f.api.harnessOf(ids[0]), 'temporal');
  assert.equal(f.api.__gsOwnsBox(ids[0]), false);
  assert.equal(fs.existsSync(f.pins), false);
  assert.equal(fs.existsSync(f.status), false);
});

test('missing explicit profile fails closed', t => {
  const f = fixture(t);
  const api = f.context.Rb(); t.after(() => api.__gsStop());
  api.noteRoster({ agents: [{ id: ids[0] }, { id: ids[0], harness: 'temporal' }] });
  assert.equal(api.harnessOf(ids[0]), 'temporal');
});

test('pins persist across processes before the first gateway seed', t => {
  const f = fixture(t);
  f.api.noteRoster({ agents: [{ id: ids[0] }] }); f.api.__gsStop();
  const child = path.join(f.root, 'restart.cjs');
  fs.writeFileSync(child, `const assert=require('node:assert/strict');\n` + stubs + runtime +
    `\nconst api=Rb({dataDir:process.argv[2]});
     api.noteRoster({agents:[{id:${JSON.stringify(ids[0])},harness:'temporal'}]});
     assert.equal(api.harnessOf(${JSON.stringify(ids[0])}),'box');api.__gsStop();`);
  const result = spawnSync(process.execPath, [child, f.root], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const other = path.join(f.root, 'other-profile'); fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'grok-switch-box-routing'), '');
  const api = f.context.Rb({ dataDir: other }); t.after(() => api.__gsStop());
  api.noteRoster({ agents: [{ id: ids[0], harness: 'temporal' }] });
  assert.equal(api.harnessOf(ids[0]), 'temporal');
});

test('write failure retries durable pins without waiting for another roster', t => {
  const f = fixture(t), rename = fs.renameSync; let faults = 1;
  fs.renameSync = (from, to) => {
    if (to === f.pins && faults-- > 0) throw Object.assign(new Error('synthetic lock'), { code: 'EACCES' });
    return rename(from, to);
  };
  t.after(() => { fs.renameSync = rename; });
  f.api.noteRoster({ agents: [{ id: ids[0] }] });
  assert.equal(fs.existsSync(f.pins), false); assert.equal(f.health().cacheWriteError, 'EACCES');
  assert.equal(f.c.fire(), 1000);
  assert.deepEqual(f.saved(), [ids[0]]);
  assert.equal(f.health().cacheWriteError, undefined); assert.equal(f.c.pending(), 0);
  fs.renameSync = rename;
});

test('same roster repairs a corrupt cache and clears read errors', t => {
  const f = fixture(t);
  f.api.noteRoster({ agents: [{ id: ids[0] }] });
  fs.writeFileSync(f.pins, '{broken');
  f.api.noteRoster({ agents: [{ id: ids[0] }] });
  assert.deepEqual(f.saved(), [ids[0]]);
  assert.equal(f.health().cacheReadError, undefined);
});

test('overlapping coordinator snapshots merge instead of dropping new pins', t => {
  const f = fixture(t), other = f.context.Rb({ dataDir: f.root, clock: f.c });
  t.after(() => other.__gsStop());
  other.noteRoster({ agents: [{ id: ids[1] }] });
  f.api.noteRoster({ agents: [{ id: ids[0] }] });
  assert.deepEqual(f.saved(), [ids[0], ids[1]].sort());
  assert.equal(f.api.harnessOf(ids[1]), 'box');
});

test('an active old lock is never stolen and retry recovers when released', t => {
  const f = fixture(t), lock = f.pins + '.lock';
  const owner = JSON.stringify({ pid: process.pid, startedAt: 'synthetic' });
  fs.writeFileSync(lock, owner); const old = new Date(Date.now() - 120000); fs.utimesSync(lock, old, old);
  f.api.noteRoster({ agents: [{ id: ids[0] }] });
  assert.equal(fs.readFileSync(lock, 'utf8'), owner); assert.equal(fs.existsSync(f.pins), false);
  assert.equal(f.health().cacheWriteError, 'EEXIST');
  fs.unlinkSync(lock); f.c.fire();
  assert.deepEqual(f.saved(), [ids[0]]); assert.equal(f.health().cacheWriteError, undefined);
});

test('unknown abandoned locks require manual recovery regardless of age', t => {
  const f = fixture(t), lock = f.pins + '.lock';
  fs.writeFileSync(lock, ''); const old = new Date(0); fs.utimesSync(lock, old, old);
  f.api.noteRoster({ agents: [{ id: ids[0] }] });
  assert.equal(fs.existsSync(lock), true); assert.equal(f.health().cacheWriteError, 'EEXIST');
  f.api.__gsStop(); assert.equal(f.c.pending(), 0);
});

test('shutdown flushes pending pins and cancels persistence retries', t => {
  const f = fixture(t), rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === f.pins) throw Object.assign(new Error('synthetic'), { code: 'EACCES' });
    return rename(from, to);
  };
  t.after(() => { fs.renameSync = rename; });
  f.api.noteRoster({ agents: [{ id: ids[0] }] }); assert.equal(f.c.pending(), 1);
  fs.renameSync = rename; f.api.__gsStop();
  assert.equal(f.c.pending(), 0); assert.deepEqual(f.saved(), [ids[0]]);
});

test('successful status writes clear prior health errors', t => {
  const f = fixture(t), rename = fs.renameSync; let faults = 1;
  fs.renameSync = (from, to) => {
    if (to === f.status && faults-- > 0) throw Object.assign(new Error('synthetic'), { code: 'EACCES' });
    return rename(from, to);
  };
  t.after(() => { fs.renameSync = rename; });
  f.api.__gsStatus(); f.api.__gsStatus(); fs.renameSync = rename;
  assert.equal(f.health().statusWriteError, undefined);
});

const flush = () => new Promise(resolve => setImmediate(resolve));

test('seed requests coalesce and retry until recovery', async t => {
  const f = fixture(t), c = clock(), installed = [], reports = []; let reads = 0;
  const seed = f.context.__gsRosterSeed({ clock: c, read: async () => {
    if (++reads < 3) throw { code: 'synthetic_offline' }; return [{ id: ids[0] }];
  }, install: rows => installed.push(rows), report: state => reports.push(state) });
  t.after(() => seed.stop());
  const first = seed.request(); assert.equal(first, seed.request()); await first;
  assert.equal(c.fire(), 1000); await flush(); assert.equal(c.fire(), 2000); await flush();
  assert.equal(reads, 3); assert.equal(installed.length, 1);
  assert.equal(reports.at(-1).seedState, 'ready'); assert.equal(reports.at(-1).seedFailure, null);
  assert.equal(c.pending(), 0);
});

test('reset drops stale in-flight seed responses and stop cancels retries', async t => {
  const f = fixture(t), c = clock(), installed = []; let resolveOld, resolveNew, reads = 0;
  const seed = f.context.__gsRosterSeed({ clock: c,
    read: () => new Promise(resolve => { if (++reads === 1) resolveOld = resolve; else resolveNew = resolve; }),
    install: rows => installed.push(rows) });
  const old = seed.request(); await flush(); seed.reset(); const current = seed.request(); await flush();
  resolveNew([{ id: ids[1] }]); await current; resolveOld([{ id: ids[0] }]); await old;
  assert.deepEqual(installed, [[{ id: ids[1] }]]);
  seed.stop(); await seed.request(); assert.equal(reads, 2); assert.equal(c.pending(), 0);
});

test('early reset avoids stale reads, invalid rosters retry, and null failures are bounded', async t => {
  const f = fixture(t), c = clock(), reports = []; let reads = 0;
  const seed = f.context.__gsRosterSeed({ clock: c, read: async () => { reads++; return {}; },
    install: () => assert.fail('invalid roster installed'), report: state => reports.push(state) });
  const abandoned = seed.request(); seed.reset(); await abandoned; assert.equal(reads, 0);
  await seed.request(); assert.equal(reports.at(-1).seedFailure, 'invalid_roster');
  seed.stop(); assert.equal(c.pending(), 0);
  const failing = f.context.__gsRosterSeed({ clock: c, read: async () => { throw null; },
    install: () => assert.fail(), report: state => reports.push(state) });
  await failing.request(); assert.equal(reports.at(-1).seedFailure, 'read_failed'); failing.stop();
  assert.equal(c.pending(), 0);
});
