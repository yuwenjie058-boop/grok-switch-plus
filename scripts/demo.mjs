// Offline demonstration of the actual engine. No provider, account or host is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const directory = fs.mkdtempSync(join(tmpdir(), 'grok-switch-plus-demo-'));
const source = fs.readFileSync(new URL('../src/ctx-compact.cjs', import.meta.url), 'utf8');
const options = { enabled: true, mode: 'apply', thresholdChars: 60000, freshHeadChars: 8000,
  freshTailChars: 4000, protectRecentMessages: 6, errorExempt: true, objectResults: true,
  ledgerMaxEntries: 20000, ledgerRefreshMs: 3600000 };
const engine = { require: createRequire(import.meta.url), process, Buffer,
  GROK_SWITCH_DIR: directory, grokSwitchFs: () => fs };
vm.createContext(engine);
vm.runInContext(source, engine, { filename: 'ctx-compact.cjs' });
const messages = value => [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'demo-call', toolName: 'demo_command', result: value }] }];
const size = value => JSON.stringify(value).length;
let report;
try {
  const original = { stdout: 'synthetic output line\n'.repeat(8000), exitCode: 0 };
  const input = messages(original);
  const baseline = engine.grokSwitchCompactMessages(input, { ...options, enabled: false });
  const folded = engine.grokSwitchCompactMessages(input, options);
  const replayed = engine.grokSwitchCompactMessages(input, { ...options, freshHeadChars: 2000, freshTailChars: 1000 });
  // The cache format is part of the recoverability contract; find the actual
  // written original, rather than presenting a hand-computed estimate.
  const originals = fs.readdirSync(join(directory, 'ctx-cache')).map(name => fs.readFileSync(join(directory, 'ctx-cache', name), 'utf8'));
  const recovered = originals.some(text => { try { return JSON.parse(text).stdout === original.stdout; } catch { return false; } });
  const faultyFs = Object.create(fs);
  faultyFs.writeFileSync = (file, ...args) => {
    if (String(file).includes('ctx-compact-ledger.json.tmp')) throw Error('demonstration: ledger storage unavailable');
    return fs.writeFileSync(file, ...args);
  };
  engine.grokSwitchFs = () => faultyFs;
  const next = messages({ stdout: 'another synthetic line\n'.repeat(8000), exitCode: 0 });
  const failed = engine.grokSwitchCompactMessages(next, options);
  report = { inputKind: 'synthetic-tool-result', networkRequests: 0,
    beforeChars: size(baseline.messages), afterChars: size(folded.messages),
    replayStable: JSON.stringify(folded.messages) === JSON.stringify(replayed.messages),
    originalRecoverable: recovered,
    failedLedgerSendsOriginal: failed.stats.ledgerWriteFailed === 1 && JSON.stringify(failed.messages) === JSON.stringify(next),
    temporaryDataRemoved: false };
  assert.ok(report.afterChars < report.beforeChars && report.replayStable && report.originalRecoverable && report.failedLedgerSendsOriginal);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
report.temporaryDataRemoved = !fs.existsSync(directory);
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report) + '\n');
else {
  console.log('Offline demo: same synthetic object, compaction disabled -> enabled');
  console.log(`Serialized message characters: ${report.beforeChars} -> ${report.afterChars}`);
  console.log(`Stable replay after settings change: ${report.replayStable ? 'PASS' : 'FAIL'}`);
  console.log(`Original output recoverable: ${report.originalRecoverable ? 'PASS' : 'FAIL'}`);
  console.log(`Ledger failure preserves original output: ${report.failedLedgerSendsOriginal ? 'PASS' : 'FAIL'}`);
  console.log(`Temporary data removed: ${report.temporaryDataRemoved ? 'PASS' : 'FAIL'}`);
  console.log('No API calls. Character counts are not token, cost or task-quality measurements.');
}
