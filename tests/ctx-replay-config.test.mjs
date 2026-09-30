import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createWorld, baseConfig, textPart, objectPart } from "./support/ctx-compact-harness.mjs";

const section = readFileSync(new URL("../src/ctx-compact.cjs", import.meta.url), "utf8");

test("shared oversized objects are refused before an unbounded digest walk", (t) => {
  const world = createWorld(section, "bounded-replay-digest");
  t.after(() => world.cleanup());
  world.setConfig(baseConfig());
  let value = { stdout: "q".repeat(100000) };
  for (let depth = 0; depth < 26; depth++) value = [value, value];
  world.api.auditMessages = [objectPart(value)];
  // A VM timeout bounds the regression itself; shared objects are not cycles.
  const result = vm.runInContext("grokSwitchCompactMessages(auditMessages, grokSwitchCompactConfig())",
    world.api, { timeout: 2000 });
  assert.equal(result.messages, world.api.auditMessages);
  assert.equal(result.stats.folded, 0);
  assert.equal(world.ledgerExists(), false);
});

test("deep legacy-hashable results retain their recorded replay domain", (t) => {
  const world = createWorld(section, "legacy-deep-replay");
  t.after(() => world.cleanup());
  world.setConfig(baseConfig());
  // The established scanner stops at depth 24; the digest examines depth 32.
  // A new digest node cap would reject values accepted by earlier releases.
  let deep = Array(200001).fill(1);
  for (let depth = 0; depth < 24; depth++) deep = { child: deep };
  const messages = [objectPart({ stdout: "q".repeat(100000), deep })];
  const first = world.run(messages);
  assert.equal(first.stats.folded, 1);
  vm.runInContext(section, world.api);
  const replay = world.run(messages);
  assert.equal(replay.stats.frozen, 1);
  assert.equal(replay.stats.unhashable, 0);
  assert.equal(JSON.stringify(replay.messages), JSON.stringify(first.messages));
});

for (const shape of ["text", "object"]) {
  for (const change of [
    { name: "raised threshold", opts: { thresholdChars: 200000 } },
    { name: "larger head and tail", opts: { freshHeadChars: 70000, freshTailChars: 70000 } },
    { name: "zero head and tail", initial: { freshHeadChars: 0, freshTailChars: 0 }, opts: {} }
  ]) {
    test(`${shape}: replay keeps frozen bytes after ${change.name}`, (t) => {
      const world = createWorld(section, "replay-config");
      t.after(() => world.cleanup());
      world.setConfig(baseConfig(change.initial));
      const value = shape === "text" ? "q".repeat(100000) : { stdout: "q".repeat(100000) };
      const messages = [shape === "text" ? textPart(value) : objectPart(value)];
      const first = world.run(messages);
      assert.equal(first.stats.folded, 1);

      // Restart the module while retaining its on-disk ledger, then edit config.
      vm.runInContext(section, world.api);
      world.setConfig(baseConfig({ ...change.opts, protectRecentMessages: 0 }));
      const replay = world.run(messages);
      assert.ok(JSON.stringify(replay.messages) === JSON.stringify(first.messages),
        "provider prefix bytes must not change when configuration changes");
      assert.equal(replay.stats.frozen, 1);
      assert.equal(replay.stats.folded, 0);
    });
  }
}

for (const shape of ["text", "object"]) {
  for (const change of [
    { name: "raised threshold", opts: { thresholdChars: 200000 } },
    { name: "larger head and tail", opts: { freshHeadChars: 70000, freshTailChars: 70000 } }
  ]) {
    test(`${shape}: ${change.name} still governs unrecorded first sends`, (t) => {
      const world = createWorld(section, "first-send-config");
      t.after(() => world.cleanup());
      world.setConfig(baseConfig(change.opts));
      const value = shape === "text" ? "q".repeat(100000) : { stdout: "q".repeat(100000) };
      const messages = [shape === "text" ? textPart(value) : objectPart(value)];
      const run = world.run(messages);
      assert.equal(run.messages, messages);
      assert.equal(run.stats.folded, 0);
      assert.equal(run.stats.frozen, 0);
      assert.equal(world.ledgerExists(), false);
    });
  }
}

test("object replay uses the recorded threshold for every leaf", (t) => {
  const world = createWorld(section, "replay-leaves");
  t.after(() => world.cleanup());
  world.setConfig(baseConfig());
  const messages = [objectPart({ stdout: "a".repeat(70000), stderr: "b".repeat(100000) })];
  const first = world.run(messages);
  assert.equal(first.stats.parts, 2);
  vm.runInContext(section, world.api);
  world.setConfig(baseConfig({ thresholdChars: 80000, protectRecentMessages: 0 }));
  const replay = world.run(messages);
  assert.ok(JSON.stringify(replay.messages) === JSON.stringify(first.messages));
  assert.equal(replay.stats.parts, 2);
  assert.equal(replay.stats.frozen, 1);
});

for (const change of [
  { name: "disabled compaction", opts: { enabled: false } },
  { name: "object opt-out", opts: { objectResults: false } },
  { name: "dry-run", opts: { mode: "dry-run" } }
]) {
  test(`${change.name} still leaves a recorded object result untouched`, (t) => {
    const world = createWorld(section, "replay-opt-out");
    t.after(() => world.cleanup());
    world.setConfig(baseConfig());
    const messages = [objectPart({ stdout: "q".repeat(100000) })];
    assert.equal(world.run(messages).stats.folded, 1);
    const ledgerBefore = readFileSync(world.ledgerPath, "utf8");
    vm.runInContext(section, world.api);
    world.setConfig(baseConfig(change.opts));
    const run = world.run(messages);
    assert.equal(run.messages, messages);
    assert.equal(run.stats.frozen, 0);
    assert.equal(readFileSync(world.ledgerPath, "utf8"), ledgerBefore);
  });
}
