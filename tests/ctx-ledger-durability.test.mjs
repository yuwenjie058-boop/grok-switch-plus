import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createWorld, baseConfig, textPart } from './support/ctx-compact-harness.mjs';
const source = readFileSync(new URL('../src/ctx-compact.cjs', import.meta.url), 'utf8');

function world(t) {
  const w = createWorld(source, 'ledger-durable');
  w.setConfig(baseConfig());
  t.after(() => w.cleanup());
  return w;
}

test('ledger fsync failure cannot publish a provisional fold', t => {
  const w = world(t), real = w.api.grokSwitchFs(), shim = Object.create(real), paths = new Map();
  shim.openSync = (file, ...args) => { const fd = real.openSync(file, ...args); paths.set(fd, String(file)); return fd; };
  shim.fsyncSync = fd => {
    if (paths.get(fd)?.includes('ctx-compact-ledger.json.tmp')) throw Error('ledger flush failed');
    return real.fsyncSync(fd);
  };
  w.api.grokSwitchFs = () => shim;
  const input = [textPart('a'.repeat(100000))], result = w.run(input);
  assert.equal(result.messages[0].content[0].result, input[0].content[0].result);
  assert.equal(result.stats.folded, 0);
  assert.equal(result.stats.ledgerWriteFailed, 1);
  assert.equal(w.ledgerExists(), false);
  assert.equal(readdirSync(w.dir).some(name => name.includes('.tmp') || name.endsWith('.lock')), false);
});

test('busy ledger writer never overwrites another process claim', t => {
  const w = world(t);
  mkdirSync(w.ledgerPath + '.lock');
  const result = w.run([textPart('b'.repeat(100000))]);
  assert.equal(result.stats.folded, 0);
  assert.equal(result.stats.ledgerWriteFailed, 1);
  assert.equal(w.ledgerExists(), false);
  assert.ok(readdirSync(w.dir).includes('ctx-compact-ledger.json.lock'));
});

test('a second process committing during a fold is preserved instead of overwritten', t => {
  const w = world(t), real = w.api.grokSwitchFs(), shim = Object.create(real);
  const winner = { winner: { shape: 'full', t: 1 } };
  let injected = false;
  shim.writeFileSync = (file, ...args) => {
    if (!injected && String(file).includes('ctx-cache')) {
      injected = true;
      const child = spawnSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', w.ledgerPath, JSON.stringify(winner)]);
      assert.equal(child.status, 0);
    }
    return real.writeFileSync(file, ...args);
  };
  w.api.grokSwitchFs = () => shim;
  const result = w.run([textPart('c'.repeat(100000))]);
  assert.deepEqual(w.ledger(), winner);
  assert.equal(result.stats.folded, 0);
  assert.equal(result.stats.ledgerWriteFailed, 1);
});

test('a corrupt ledger is not silently replaced with a newly folded history', t => {
  const w = world(t);
  writeFileSync(w.ledgerPath, '{broken');
  const result = w.run([textPart('d'.repeat(100000))]);
  assert.equal(readFileSync(w.ledgerPath, 'utf8'), '{broken');
  assert.equal(result.stats.folded, 0);
});

test('capacity pruning never returns a new fold without its replay record', t => {
  const w = world(t);
  w.setConfig(baseConfig({ ledgerMaxEntries: 1 }));
  const input = [textPart('e'.repeat(100000)), textPart('f'.repeat(100000))];
  const result = w.run(input);
  const ledger = w.ledger();
  for (let i = 0; i < input.length; i++) {
    if (result.messages[i].content[0].result !== input[i].content[0].result) {
      assert.equal(ledger[w.api.grokSwitchContentDigest(input[i].content[0].result)]?.shape, 'folded');
    }
  }
  assert.equal(result.stats.folded, 1);
});

test('directory flush uncertainty after rename stops the request', { skip: process.platform === 'win32' }, t => {
  const w = world(t), real = w.api.grokSwitchFs(), shim = Object.create(real), paths = new Map();
  shim.openSync = (file, ...args) => { const fd = real.openSync(file, ...args); paths.set(fd, String(file)); return fd; };
  shim.fsyncSync = fd => {
    if (paths.get(fd) === w.dir) throw Error('directory flush failed');
    return real.fsyncSync(fd);
  };
  w.api.grokSwitchFs = () => shim;
  assert.throws(() => w.run([textPart('g'.repeat(100000))]), { code: 'GROK_SWITCH_COMPACT_COMMIT_UNCERTAIN' });
});
