import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('offline demo measures real compaction, stable replay and storage-failure fallback', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/demo.mjs', import.meta.url)), '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.inputKind, 'synthetic-tool-result');
  assert.equal(report.networkRequests, 0);
  assert.ok(report.beforeChars > 100000);
  assert.ok(report.afterChars < report.beforeChars / 2);
  assert.equal(report.replayStable, true);
  assert.equal(report.originalRecoverable, true);
  assert.equal(report.failedLedgerSendsOriginal, true);
  assert.equal(report.temporaryDataRemoved, true);
});
