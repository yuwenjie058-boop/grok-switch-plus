// Behavioural suite for the v4.1 fixes that cloud.11 shipped on top of the v4
// engine (src/ctx-compact.cjs is byte-for-byte the deployed v4.1 region; the
// engine stamps itself stats.version === 5).
//
// The five numbered v4.1 changes are all about the *numbers* an operator reads
// before and after flipping dry-run -> apply, never about the folded bytes:
//
//   G1  dry-run and apply agree on the error exemption (the promise apply keeps)
//   G2  dry-run counts objects (it used to be 0 in the one mode that runs today)
//   G3  a cyclic value is refused, not measured as a multiple of itself
//   G4  a value apply cannot fold is refused in dry-run too, with one explanation
//   G5  a value past the digest's depth is not promised as savings
//   G6  the dead keepHeadChars/keepTailChars are reported, not silently ignored
//   G7  the terminal-guard hold refuses the fold in both modes
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createWorld, baseConfig, textPart, objectPart, shellObject } from "./support/ctx-compact-harness.mjs";

const section = readFileSync(new URL("../src/ctx-compact.cjs", import.meta.url), "utf8");
const stable = (value) => JSON.stringify(value);

function withWorld(label, cfg, fn) {
  const world = createWorld(section, label);
  world.setConfig(cfg);
  try {
    return fn(world);
  } finally {
    world.cleanup();
  }
}

const result = (run, index = 0) => run.messages[index].content[0].result;

test("G1 dry-run and apply refuse the same error-looking text result", () => {
  const errText = "Traceback (most recent call last):\n" + "e".repeat(120000);
  const seen = {};
  for (const mode of ["dry-run", "apply"]) {
    withWorld("v41-parity-" + mode, baseConfig({ protectRecentMessages: 20, mode }), (world) => {
      const run = world.run([textPart(errText, "e1")]);
      seen[mode] = run.stats;
      assert.equal(run.stats.errorExempt, 1, "G1 " + mode + " exempts the error report: " + stable(run.stats));
      assert.equal(run.stats.parts, 0, "G1 " + mode + " promises no savings on an exempt result: " + stable(run.stats));
      assert.equal(run.stats.savedChars, 0, "G1 " + mode + " reports no characters saved: " + stable(run.stats));
      assert.equal(result(run), errText, "G1 " + mode + " leaves the bytes alone");
    });
  }
  assert.equal(seen["dry-run"].parts, seen.apply.parts, "G1 the two modes cannot disagree about parts");
  assert.equal(seen["dry-run"].errorExempt, seen.apply.errorExempt, "G1 the two modes cannot disagree about the exemption");
});

test("G2 dry-run counts objects and their measurement", () => {
  const value = shellObject("W".repeat(70000));
  withWorld("v41-objects-dry", baseConfig({ protectRecentMessages: 20, mode: "dry-run" }), (world) => {
    const run = world.run([objectPart(value, "w1")]);
    assert.equal(run.stats.objects, 1, "G2 dry-run counts the object it measured: " + stable(run.stats));
    assert.equal(run.stats.savedChars, 2 * (70000 - 12000), "G2 dry-run measures both big leaves: " + stable(run.stats));
    assert.equal(result(run), value, "G2 dry-run changes nothing");
  });
  withWorld("v41-objects-apply", baseConfig({ protectRecentMessages: 20, mode: "apply" }), (world) => {
    const run = world.run([objectPart(value, "w1")]);
    assert.equal(run.stats.objects, 1, "G2 apply counts the same object: " + stable(run.stats));
    assert.equal(run.stats.folded, 1, "G2 and folds it");
    assert.equal(typeof result(run), "object", "G2 the folded result stays an object");
  });
});

test("G3 a cyclic value is refused instead of being measured as a multiple of itself", () => {
  for (const mode of ["dry-run", "apply"]) {
    withWorld("v41-cycle-" + mode, baseConfig({ protectRecentMessages: 20, mode }), (world) => {
      const cyclic = shellObject("C".repeat(70000));
      cyclic.self = cyclic;
      const run = world.run([objectPart(cyclic, "c1")]);
      assert.equal(run.stats.unstable, 1, "G3 " + mode + " reports the cycle: " + stable(run.stats));
      assert.equal(run.stats.unhashable, 0, "G3 " + mode + " does not report it twice");
      assert.equal(run.stats.parts, 0, "G3 " + mode + " promises nothing for a cycle: " + stable(run.stats));
      assert.equal(run.stats.savedChars, 0, "G3 " + mode + " reports no savings for a cycle: " + stable(run.stats));
      assert.equal(result(run), cyclic, "G3 " + mode + " leaves the cyclic value untouched");
    });
  }
});

test("G4 a value apply cannot fold is refused in dry-run with the same explanation", () => {
  const explained = {};
  for (const mode of ["dry-run", "apply"]) {
    withWorld("v41-bigint-" + mode, baseConfig({ protectRecentMessages: 20, mode }), (world) => {
      const value = shellObject("B".repeat(70000));
      value.count = BigInt(7);
      const run = world.run([objectPart(value, "b1")]);
      explained[mode] = run.stats;
      assert.equal(run.stats.unhashable, 1, "G4 " + mode + " refuses an unhashable value: " + stable(run.stats));
      assert.equal(run.stats.guardHold, 0, "G4 " + mode + " does not blame the guard: " + stable(run.stats));
      assert.equal(run.stats.parts, 0, "G4 " + mode + " promises nothing: " + stable(run.stats));
    });
  }
  assert.equal(explained["dry-run"].unhashable, explained.apply.unhashable, "G4 both modes give one explanation");
});

test("G5 a value past the digest depth is never promised as savings", () => {
  for (const mode of ["dry-run", "apply"]) {
    withWorld("v41-deep-" + mode, baseConfig({ protectRecentMessages: 20, mode }), (world) => {
      const deep = {};
      let node = deep;
      for (let i = 0; i < 33; i += 1) { node.child = {}; node = node.child; }
      node.stdout = "D".repeat(90000);
      const run = world.run([objectPart(deep, "d1")]);
      assert.equal(run.stats.parts, 0, "G5 " + mode + " promises nothing past the digest depth: " + stable(run.stats));
      assert.equal(run.stats.savedChars, 0, "G5 " + mode + " reports no savings: " + stable(run.stats));
      assert.equal(result(run), deep, "G5 " + mode + " leaves the value untouched");
    });
  }
});

test("G6 the dead keepHeadChars and keepTailChars are reported instead of silently ignored", () => {
  withWorld("v41-legacy", baseConfig({ protectRecentMessages: 20, keepHeadChars: 111, keepTailChars: 222 }), (world) => {
    const run = world.run([textPart("A".repeat(120000), "a1")]);
    assert.equal(run.stats.ignoredKeys, "keepHeadChars,keepTailChars", "G6 both dead keys are named: " + stable(run.stats));
    assert.equal(run.stats.folded, 1, "G6 and the fold still happens");
  });
  withWorld("v41-legacy-one", baseConfig({ protectRecentMessages: 20, keepHeadChars: 111 }), (world) => {
    const run = world.run([textPart("A".repeat(120000), "a1")]);
    assert.equal(run.stats.ignoredKeys, "keepHeadChars", "G6 only what was configured is reported: " + stable(run.stats));
  });
  withWorld("v41-legacy-none", baseConfig({ protectRecentMessages: 20 }), (world) => {
    const run = world.run([textPart("A".repeat(120000), "a1")]);
    assert.equal(run.stats.ignoredKeys, undefined, "G6 nothing is reported when nothing is ignored: " + stable(run.stats));
  });
});

test("G7 the terminal-guard hold refuses the fold in both modes", () => {
  const carrier = { stdout: '"tool": "Task" ' + "G".repeat(70000), inputSchema: {} };
  for (const mode of ["dry-run", "apply"]) {
    withWorld("v41-guard-" + mode, baseConfig({ protectRecentMessages: 20, mode }), (world) => {
      const run = world.run([objectPart(carrier, "g1")]);
      assert.equal(run.stats.guardHold, 1, "G7 " + mode + " refuses a result the guard reads back: " + stable(run.stats));
      assert.equal(run.stats.parts, 0, "G7 " + mode + " promises nothing: " + stable(run.stats));
      assert.equal(result(run), carrier, "G7 " + mode + " leaves the guard-readable bytes intact");
    });
  }
});
