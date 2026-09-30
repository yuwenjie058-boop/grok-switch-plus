// Behavioural suite for the shipped ctx-compact v4.1 engine (src/ctx-compact.cjs,
// which is byte-for-byte the v4 region the live bundle carries).
//
//   A  object results are folded, stay objects, and replay byte for byte
//   B  string results are byte-for-byte what the v3 baseline produced
//   C  identity is key-order independent
//   D  dry-run measures without touching the payload
//   E  the build carries the engine and its call site in the deployed order
//   F  the blind spots: protocol pairing round trip, the underscore part type,
//      the depth and node budgets, and ledger capacity
//
// Ported from outputs/payload/ctx-compact/tests/check-ctx-compact-v4.mjs, which
// only ran as a standalone script. That file was later rewritten for the v4.1
// draft whose bytes are now the shipped ones; this suite is pinned to the
// shipped v4.1 semantics (stats.version === 5, plus the refusal counters).
// The file name is kept so the mutation suite's targets stay stable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createWorld, readV3Baseline, baseConfig, textPart, objectPart, typedPart, shellObject, reorderKeys
} from "./support/ctx-compact-harness.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const section = readFileSync(join(here, "..", "src", "ctx-compact.cjs"), "utf8");
const baseline = readV3Baseline();
const chat = require("../src/protocols/openai-chat.cjs");

const stable = (value) => JSON.stringify(value);
const folded = (message) => /folded here to save context/.test(stable(message));
/** Run a world with the section under test, always cleaning the temp dir up. */
function withWorld(label, fn) {
  const world = createWorld(section, label);
  try {
    return fn(world);
  } finally {
    world.cleanup();
  }
}

// ---------------------------------------------------------------------------
// A. Object results
// ---------------------------------------------------------------------------
test("A1-A8 an object result folds, survives as an object, and replays byte for byte", () => {
  withWorld("v4-object", (world) => {
    world.setConfig(baseConfig({ protectRecentMessages: 1 }));
    const big = "L".repeat(120000);
    const value = shellObject(big);
    const first = world.run([objectPart(value, "obj-1")]);
    const part = first.messages[0].content[0];

    assert.equal(first.stats.savedChars, 2 * (120000 - 12000), "A1 savedChars: " + stable(first.stats));
    assert.equal(first.stats.folded, 1, "A1 folded");
    assert.equal(first.stats.objects, 1, "A1 objects");
    assert.ok(typeof part.result === "object" && part.result !== null, "A2 the result is still an object");
    assert.ok(
      part.result.isBackground === false &&
        part.result.success.command === "sleep 1; cat big.log" &&
        part.result.success.outputLocation.lineCount === 4 &&
        Object.keys(part.result).length === 2 &&
        Object.keys(part.result.success).length === 4,
      "A3 every other key and type survives untouched"
    );
    assert.ok(
      part.result.success.stdout.startsWith("L".repeat(8000)) &&
        part.result.success.stdout.endsWith("L".repeat(4000)) &&
        /\[grok-switch: 108000 characters of result\.success\.stdout folded here to save context/.test(part.result.success.stdout),
      "A4 the folded leaf is head + marker + tail of the original"
    );
    const cache = world.cacheFiles();
    assert.ok(cache.length === 1 && cache[0].name.endsWith(".json"), "A5 the full value is written aside as JSON, once: " + stable(cache));
    const entry = Object.values(world.ledger())[0];
    assert.ok(
      entry.shape === "folded" && entry.k === "object" && entry.h === 8000 && entry.tl === 4000 && entry.lm === 60000,
      "A6 the ledger freezes the shape with its own head/tail/leafMin: " + stable(entry)
    );

    // Replay after the object has slid out of the fresh window.
    world.setConfig(baseConfig({ protectRecentMessages: 0 }));
    const second = world.run([objectPart(value, "obj-1")]);
    assert.ok(
      stable(second.messages[0].content[0].result) === stable(first.messages[0].content[0].result) && second.stats.frozen === 1,
      "A7 replay on a later request is byte-identical to the first fold"
    );

    // The host rebuilding the identical object with a different key order must
    // not move a single byte.
    const third = world.run([objectPart(reorderKeys(value), "obj-1")]);
    assert.ok(
      stable(third.messages[0].content[0].result) === stable(first.messages[0].content[0].result) && third.stats.frozen === 1,
      "A8 a reordered rebuild replays byte-identically instead of flipping to raw: " + stable(third.stats)
    );
  });
});
// A9..A14: gates that must stay shut.
test("A9-A14 the object gates: thresholds, structured errors, the opt-out, and unhashable values", () => {
  withWorld("v4-gates", (world) => {
    world.setConfig(baseConfig({ protectRecentMessages: 5 }));

    const manySmall = { success: { chunks: Array.from({ length: 200 }, () => "m".repeat(400)) } };
    const smallRun = world.run([objectPart(manySmall, "small-1")]);
    assert.ok(smallRun.stats.parts === 0 && !folded(smallRun.messages[0]), "A9 an object with no leaf over the threshold is left alone");

    const failure = { failure: { stderr: "E".repeat(90000) }, isBackground: false };
    const failureRun = world.run([objectPart(failure, "fail-1")]);
    assert.ok(
      failureRun.stats.errorExempt === 1 && !folded(failureRun.messages[0]) && Object.values(world.ledger())[0].k === "object",
      "A10 a structured failure is exempt and recorded as full: " + stable(failureRun.stats)
    );
    const successFalse = world.run([objectPart({ success: false, message: "N".repeat(90000) }, "fail-2")]);
    assert.ok(successFalse.stats.errorExempt === 1 && !folded(successFalse.messages[0]), "A10b success:false is exempt too");

    const flagged = objectPart({ success: { stdout: "P".repeat(90000) } }, "err-1");
    flagged.content[0].isError = true;
    const flaggedRun = world.run([flagged]);
    assert.ok(flaggedRun.stats.errorExempt === 1 && !folded(flaggedRun.messages[0]), "A10c part.isError is exempt too");

    const off = createWorld(section, "v4-objectoff");
    try {
      off.setConfig(baseConfig({ protectRecentMessages: 5, objectResults: false }));
      const offRun = off.run([objectPart({ success: { stdout: "Q".repeat(90000) } }, "off-1")]);
      assert.ok(offRun.stats.parts === 0 && !folded(offRun.messages[0]), "A11 objectResults:false falls back to v3's string-only behaviour");
    } finally {
      off.cleanup();
    }

    // Failsafe: values the digest cannot walk are skipped, never thrown on.
    const cyclic = { success: { stdout: "C".repeat(90000) } };
    cyclic.self = cyclic;
    const cycleRun = world.run([objectPart(cyclic, "cyc-1")]);
    assert.ok(cycleRun.stats.parts === 0 && cycleRun.messages[0].content[0].result === cyclic, "A12 a cyclic value is skipped without folding and without throwing");
    const bigintRun = world.run([objectPart({ n: 10n, s: "B".repeat(90000) }, "big-1")]);
    assert.ok(bigintRun.stats.parts === 0, "A13 a BigInt value is skipped without folding and without throwing");

    // Determinism: the fold is a pure function of (value, head, tail, leafMin,
    // digest). The marker names the cache directory, so the same value folded
    // under a different GROK_SWITCH_DIR is intentionally a different string.
    const value = shellObject("D".repeat(100000) + "e".repeat(30000));
    const blankStats = () => ({ parts: 0, savedChars: 0, objects: 0 });
    const once = world.api.grokSwitchFoldToolObject(value, 8000, 4000, 60000, { mode: "dry-run" }, blankStats(), "deadbeefdeadbeef");
    const twice = world.api.grokSwitchFoldToolObject(value, 8000, 4000, 60000, { mode: "dry-run" }, blankStats(), "deadbeefdeadbeef");
    assert.equal(stable(once), stable(twice), "A14 the folded shape is deterministic");
  });
});

// A15: fail-closed -- an object fold whose ledger record cannot be written must
// never reach the wire.
test("A15-A18 fail-closed: an unrecordable object fold is reverted", () => {
  const seed = createWorld(section, "v4-failclosed-seed");
  try {
    seed.setConfig(baseConfig({ protectRecentMessages: 1 }));
    const seeded = seed.run([objectPart(shellObject("S".repeat(80000)), "seed-1")]);
    assert.ok(seeded.stats.folded === 1 && Object.keys(seed.ledger()).length === 1, "A15 seed turn folds and records an object");
  } finally {
    seed.cleanup();
  }

  const world = createWorld(section, "v4-failclosed", { failWrite: "ctx-compact-ledger.json.tmp" });
  try {
    world.setConfig(baseConfig({ protectRecentMessages: 1 }));
    world.run([objectPart(shellObject("S".repeat(80000)), "seed-1")]);
    const fresh = world.run([objectPart(shellObject("T".repeat(70000)), "new-1")]);
    assert.equal(fresh.stats.ledgerWriteFailed, 1, "A16 a ledger write failure is reported: " + stable(fresh.stats));
    assert.ok(
      typeof fresh.messages[0].content[0].result === "object" && !folded(fresh.messages[0]),
      "A17 the unrecorded object fold is reverted, type intact"
    );
    assert.ok(fresh.stats.folded === 0 && fresh.stats.frozen === 0, "A18 nothing new is frozen while the ledger is unwritable");
  } finally {
    world.cleanup();
  }
});
// ---------------------------------------------------------------------------
// B. String results, differential against the shipped v3 baseline.
//    Same turns, same config, same ledger evolution: every byte of every result
//    and every counter must match v3 exactly.
// ---------------------------------------------------------------------------
test("B1-B4 string results are byte-for-byte what the v3 baseline produced", () => {
  const bigA = "A".repeat(120000);
  const bigB = "B".repeat(90000);
  const errText = "Traceback (most recent call last):\n" + "e".repeat(120000);
  const turns = [
    { name: "fresh big string folds", cfg: { protectRecentMessages: 20 }, msgs: () => [textPart(bigA, "a1")] },
    { name: "same string replays from the ledger", cfg: { protectRecentMessages: 0 }, msgs: () => [textPart(bigA, "a1")] },
    { name: "unseen string outside the window stays raw", cfg: { protectRecentMessages: 0 }, msgs: () => [textPart(bigB, "b1")] },
    { name: "both strings, one replayed one raw", cfg: { protectRecentMessages: 0 }, msgs: () => [textPart(bigA, "a1"), textPart(bigB, "b1")] },
    { name: "below threshold is ignored", cfg: { protectRecentMessages: 20 }, msgs: () => [textPart("y".repeat(59999), "s2")] },
    { name: "error-ish string is exempt", cfg: { protectRecentMessages: 20 }, msgs: () => [textPart(errText, "e1")] },
    { name: "recorded exemption replays as full", cfg: { protectRecentMessages: 0 }, msgs: () => [textPart(errText, "e1"), textPart(bigA, "a1")] },
    { name: "window slide", cfg: { protectRecentMessages: 1 }, msgs: () => [textPart(bigA, "a1"), textPart(bigB, "b1"), textPart("z".repeat(80000), "z1")] },
    { name: "config band changes must not move folded bytes", cfg: { protectRecentMessages: 0, freshHeadChars: 500, freshTailChars: 100 }, msgs: () => [textPart(bigA, "a1"), textPart(bigB, "b1")] },
    { name: "disabled is a no-op", cfg: { protectRecentMessages: 20, enabled: false }, msgs: () => [textPart(bigA, "a1")] },
    { name: "dry-run measures and changes nothing", cfg: { protectRecentMessages: 20, mode: "dry-run" }, msgs: () => [textPart(bigA, "a1")] }
  ];

  const worlds = { baseline: createWorld(baseline, "diff-v3"), patched: createWorld(section, "diff-v4") };
  try {
    // The two worlds live in different temp directories and the fold marker
    // names the cache directory, so the install path is normalised away.
    const stripDir = (value, dir) => stable(value).split(JSON.stringify(dir).slice(1, -1)).join("<GROK_SWITCH_DIR>");
    // v4 added a version stamp and an object counter; v4.1 added the refusal
    // counters and the ignoredKeys report. Every counter that existed in v3 must
    // still be identical, and the added ones are checked separately below instead
    // of being silently normalised away.
    const strip = (stats) => {
      const copy = Object.assign({}, stats);
      delete copy.version;
      delete copy.objects;
      delete copy.guardHold;
      delete copy.unhashable;
      delete copy.unstable;
      delete copy.ignoredKeys;
      return stable(copy);
    };
    const refusals = (stats) =>
      (Number(stats.guardHold) || 0) + (Number(stats.unhashable) || 0) + (Number(stats.unstable) || 0);
    let mismatches = 0;
    const details = [];
    for (const turn of turns) {
      for (const which of ["baseline", "patched"]) worlds[which].setConfig(baseConfig(turn.cfg));
      const b = worlds.baseline.run(turn.msgs());
      const p = worlds.patched.run(turn.msgs());
      const same = stripDir(b.messages, worlds.baseline.dir) === stripDir(p.messages, worlds.patched.dir) && strip(b.stats) === strip(p.stats);
      // A pure-string turn must never touch v4.1's refusal paths or its legacy-key
      // report: those are new behaviour, not a silent difference in the v3 parity.
      assert.equal(refusals(p.stats), 0, "B1 no refusal counter engages on a string turn: " + turn.name);
      assert.equal(p.stats.ignoredKeys, undefined, "B1 no legacy key is reported when none is configured: " + turn.name);
      if (!same) {
        mismatches += 1;
        details.push(turn.name + ": v3=" + strip(b.stats) + " v4=" + strip(p.stats));
      }
    }
    assert.equal(mismatches, 0, "B1 all " + turns.length + " string turns are byte-identical to the baseline (payload + counters): " + details.join(" | "));

    const shape = (ledger) => {
      const out = {};
      for (const key of Object.keys(ledger).sort()) {
        const entry = Object.assign({}, ledger[key]);
        delete entry.t;
        out[key] = entry;
      }
      return stable(out);
    };
    assert.equal(shape(worlds.baseline.ledger()), shape(worlds.patched.ledger()), "B2 the resulting ledger is byte-identical to the baseline's");
    const l3 = worlds.baseline.ledger();
    assert.ok(Object.values(l3).some((e) => e.shape === "folded"), "B3 the baseline really did fold in this sequence (not a vacuous pass)");

    // A mixed turn: the string half must still match v3 byte for byte, while the
    // object half is the *new* measurement (v3 cannot see it at all).
    const mixed = [textPart(bigA, "a1"), objectPart(shellObject("W".repeat(70000)), "w1")];
    for (const which of ["baseline", "patched"]) worlds[which].setConfig(baseConfig({ protectRecentMessages: 5, mode: "dry-run" }));
    const bMixed = worlds.baseline.run(mixed);
    const pMixed = worlds.patched.run(mixed);
    assert.ok(
      stripDir(bMixed.messages, worlds.baseline.dir) === stripDir(pMixed.messages, worlds.patched.dir) &&
        bMixed.stats.savedChars === 108000 &&
        pMixed.stats.savedChars === 108000 + 2 * (70000 - 12000),
      "B4 the mixed turn changes nothing in the payload and only adds the object measurement: v3=" + stable(bMixed.stats) + " v4=" + stable(pMixed.stats)
    );
  } finally {
    worlds.baseline.cleanup();
    worlds.patched.cleanup();
  }
});
// ---------------------------------------------------------------------------
// C. Key-order independent identity
// ---------------------------------------------------------------------------
test("C1-C5 identity is key-order independent", () => {
  withWorld("v4-digest", (world) => {
    const { grokSwitchStableDigest, grokSwitchContentDigest } = world.api;
    const a = { alpha: 1, beta: { gamma: [1, 2, { delta: "x" }], epsilon: null }, zeta: true };
    const b = reorderKeys(a);
    assert.equal(grokSwitchStableDigest(a), grokSwitchStableDigest(b), "C1 the same value in a different key order has one digest");
    assert.notEqual(grokSwitchContentDigest(JSON.stringify(a)), grokSwitchContentDigest(JSON.stringify(b)), "C1b v3's identity is order dependent (the defect this replaces)");
    assert.notEqual(grokSwitchStableDigest([1, 2]), grokSwitchStableDigest([2, 1]), "C2 array order still matters");
    assert.notEqual(grokSwitchStableDigest({ a: "x" }), grokSwitchStableDigest({ a: "y" }), "C3 a different value has a different digest");
    assert.equal(grokSwitchStableDigest(a), grokSwitchStableDigest(reorderKeys(a)), "C4 the digest is deterministic");

    // Upstream fed this check from an 18 MB capture of real transcripts. The
    // assertion only needs many real-shaped objects, so they are generated here:
    // the digest has to be blind to key order for every one of them.
    const realObjects = Array.from({ length: 40 }, (_, i) =>
      shellObject((String.fromCharCode(65 + (i % 26)) + i).repeat(300 + i), {
        seq: i,
        nested: { lineCount: i, tail: ["x".repeat(i), { deep: i }] }
      })
    );
    let equal = 0;
    for (const row of realObjects) {
      if (grokSwitchStableDigest(row) === grokSwitchStableDigest(reorderKeys(row))) equal += 1;
    }
    assert.equal(equal, realObjects.length, "C5 all " + realObjects.length + " real objects hash the same after a deep key reorder");
  });
});

// ---------------------------------------------------------------------------
// D. dry-run
// ---------------------------------------------------------------------------
test("D1-D7 dry-run measures exactly what apply would do, and changes nothing", () => {
  withWorld("v4-dryrun", (world) => {
    const value = shellObject("R".repeat(200000));
    const messages = [textPart("t".repeat(150000), "d1"), objectPart(value, "d2")];
    const frozenInput = stable(messages);
    world.setConfig(baseConfig({ protectRecentMessages: 2, mode: "dry-run" }));
    const dry = world.run(messages);

    assert.ok(dry.stats.mode === "dry-run" && dry.stats.savedChars > 0 && dry.stats.parts > 0, "D1 dry-run reports what it would fold: " + stable(dry.stats));
    assert.equal(dry.messages, messages, "D2 dry-run returns the very same message objects it was given");
    assert.equal(stable(dry.messages), frozenInput, "D3 the payload is byte-identical to the input");
    assert.ok(!world.ledgerExists(), "D4 dry-run writes no ledger");
    assert.equal(world.cacheFiles().length, 0, "D5 dry-run writes no cache file");
    assert.equal(dry.stats.savedChars, 138000 + 2 * (200000 - 12000), "D6 dry-run counts the object leaf too: " + stable(dry.stats));

    const applyWorld = createWorld(section, "v4-dryrun-apply");
    try {
      applyWorld.setConfig(baseConfig({ protectRecentMessages: 2, mode: "apply" }));
      const applied = applyWorld.run(messages);
      assert.equal(applied.stats.savedChars, dry.stats.savedChars, "D7 dry-run matches what apply then actually saves");
      assert.equal(applied.stats.parts, dry.stats.parts, "D7 dry-run part count matches apply");
    } finally {
      applyWorld.cleanup();
    }
  });
});

// A payload that contains an exempt (failure) result must be counted the same
// way in dry-run and in apply: the dry run must not promise a fold the apply run
// would refuse.
test("D8 dry-run and apply agree on an exempt failure result", () => {
  const withFailure = [objectPart(shellObject("F".repeat(90000)), "d3"), objectPart({ failure: { stderr: "E".repeat(90000) } }, "d4")];
  const dryWorld = createWorld(section, "v4-dryrun-parity-dry");
  const applyWorld = createWorld(section, "v4-dryrun-parity-apply");
  try {
    dryWorld.setConfig(baseConfig({ protectRecentMessages: 2, mode: "dry-run" }));
    applyWorld.setConfig(baseConfig({ protectRecentMessages: 2, mode: "apply" }));
    const dryFailure = dryWorld.run(withFailure);
    const appliedFailure = applyWorld.run(withFailure);
    assert.equal(dryFailure.stats.savedChars, appliedFailure.stats.savedChars, "D8 savedChars agree");
    assert.equal(dryFailure.stats.parts, appliedFailure.stats.parts, "D8 parts agree");
    assert.equal(dryFailure.stats.errorExempt, appliedFailure.stats.errorExempt, "D8 errorExempt agrees");
    assert.equal(appliedFailure.stats.errorExempt, 1, "D8 the failure really was exempt");
  } finally {
    dryWorld.cleanup();
    applyWorld.cleanup();
  }
});
// ---------------------------------------------------------------------------
// E. Build wiring
// ---------------------------------------------------------------------------
test("E1 the build carries the v4.1 engine, and the probe precedes it, ahead of the adapters", () => {
  const dist = readFileSync(join(here, "..", "dist", "grok-switch.cjs"), "utf8");
  const banner = "// " + "-".repeat(75) + "\n";
  const probeAt = dist.indexOf(banner + "// [ctx-probe]");
  const compactAt = dist.indexOf(banner + "// [ctx-compact v4.1]");
  const adaptersAt = dist.indexOf(banner + "// Adapters\n");
  assert.ok(compactAt > 0, "dist embeds the ctx-compact v4.1 section");
  assert.ok(!dist.includes("// [ctx-compact v3]"), "the superseded v3 banner is gone");
  assert.ok(probeAt > 0 && probeAt < compactAt, "the probe section precedes the engine, as on the box");
  assert.ok(adaptersAt > compactAt, "both sections sit inside the runtime region, ahead of the adapters");
  assert.ok(dist.includes("grokSwitchCompactMessages(messages, compactOpts)"), "dist calls the engine from grokSwitchStream");
  assert.ok(dist.includes("try { grokSwitchAppendProfile(entry, messages); } catch (_ctxProfile) {}"), "dist calls the probe from grokSwitchStream");
});

// ---------------------------------------------------------------------------
// F. The blind spots the standalone harness only covered for the v4.1 draft.
// ---------------------------------------------------------------------------
test("F1 a folded object still pairs with its tool_call through the Chat Completions builder", () => {
  withWorld("v4-pairing", (world) => {
    world.setConfig(baseConfig({ protectRecentMessages: 1 }));
    const foldedResult = world.run([objectPart(shellObject("P".repeat(90000)), "call_p")]).messages[0].content[0].result;
    assert.equal(typeof foldedResult, "object");
    const history = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_p", toolName: "run_terminal_command_v2", args: { cmd: "cat big.log" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_p", toolName: "run_terminal_command_v2", result: foldedResult }] }
    ];
    const body = chat.buildRequest({ model: "m", stream: true, maxTokens: 32, messages: history, tools: [] }).body;
    assert.deepEqual(body.messages.map((m) => m.role), ["user", "assistant", "tool"], "F1 the tool group is closed in order");
    assert.equal(body.messages[2].tool_call_id, "call_p", "F1 the folded result keeps its tool_call id");
    assert.equal(typeof body.messages[2].content, "string", "F1 the object result is serialized for the wire");
    assert.match(body.messages[2].content, /folded here to save context/, "F1 the folded marker survives the protocol layer");
  });
});

test("F2 the underscore part type 'tool_result' folds exactly like 'tool-result'", () => {
  withWorld("v4-underscore", (world) => {
    world.setConfig(baseConfig({ protectRecentMessages: 1 }));
    const run = world.run([typedPart({ success: { stdout: "U".repeat(90000) } }, "c1", "tool_result")]);
    assert.equal(run.stats.folded, 1, "F2 the underscore spelling is recognised: " + stable(run.stats));
    assert.equal(run.stats.savedChars, 90000 - 12000, "F2 it saves the same characters");
    assert.equal(typeof run.messages[0].content[0].result, "object", "F2 the result stays an object");
    assert.match(run.messages[0].content[0].result.success.stdout, /folded here to save context/);
  });
  withWorld("v4-underscore-text", (world) => {
    world.setConfig(baseConfig({ protectRecentMessages: 1 }));
    const run = world.run([typedPart("V".repeat(90000), "c1", "tool_result")]);
    assert.equal(run.stats.folded, 1, "F2 the underscore spelling also folds a text result: " + stable(run.stats));
    assert.match(run.messages[0].content[0].result, /folded here to save context/);
  });
});
test("F3 the scan depth and node budgets bound what can be folded", () => {
  // A 90k leaf buried deeper than the scan depth is never reached, so nothing
  // is folded -- and, just as important, nothing throws.
  //
  // 28 levels is deliberate: it is past the scan depth (24) and inside the
  // digest's own fixed depth (32). Burying the leaf past 32 levels instead
  // makes this case pass for the wrong reason -- the digest refuses the value
  // whatever the scan cap is, so a mutation that lifts the cap stays green.
  const deep = {};
  let node = deep;
  for (let i = 0; i < 28; i += 1) {
    node.child = {};
    node = node.child;
  }
  node.stdout = "D".repeat(90000);
  withWorld("v4-deep", (world) => {
    world.setConfig(baseConfig({ protectRecentMessages: 1 }));
    const run = world.run([objectPart(deep, "c1")]);
    assert.equal(run.stats.parts, 0, "F3 a leaf past the depth cap is not folded: " + stable(run.stats));
    assert.equal(run.stats.folded, 0, "F3 nothing is frozen either");
  });
  // The same leaf a few levels up is reached, which proves the previous case
  // failed for depth and not because the leaf was unreachable at all.
  withWorld("v4-shallow", (world) => {
    world.setConfig(baseConfig({ protectRecentMessages: 1 }));
    const run = world.run([objectPart({ a: { b: { stdout: "D".repeat(90000) } } }, "c1")]);
    assert.equal(run.stats.folded, 1, "F3 the same leaf a few levels up folds: " + stable(run.stats));
  });
  // More nodes than the scan budget: the walk overflows, and an overflow is
  // skipped rather than folded on partial information.
  withWorld("v4-budget", (world) => {
    world.setConfig(baseConfig({ protectRecentMessages: 1 }));
    const wide = { arr: new Array(250001).fill("x"), big: "N".repeat(90000) };
    const run = world.run([objectPart(wide, "c1")]);
    assert.equal(run.stats.parts, 0, "F3 a value over the node budget is skipped: " + stable(run.stats));
    assert.equal(run.stats.folded, 0, "F3 and not folded");
    assert.equal(run.messages[0].content[0].result, wide, "F3 and left byte-identical");
  });
});

test("F4 ledger capacity is a hard ceiling that prunes the least valuable record first", () => {
  withWorld("v4-capacity", (world) => {
    const mk = (ch) => objectPart(shellObject(ch.repeat(70000)), "cap-" + ch);
    world.setConfig(baseConfig({ protectRecentMessages: 100, ledgerMaxEntries: 3 }));
    const sizes = [];
    for (const ch of ["A", "B", "C", "D", "E"]) {
      world.run([mk(ch)]);
      sizes.push(Object.keys(world.ledger()).length);
    }
    assert.equal(sizes.join(","), "1,2,3,3,3", "F4 ledgerMaxEntries is a ceiling, not a suggestion: " + sizes.join(","));
    const newest = world.run([mk("E")]);
    assert.ok(newest.stats.frozen === 1 && newest.stats.folded === 0, "F4 the newest fold survived the prune and replays: " + stable(newest.stats));
    const oldest = world.run([mk("A")]);
    assert.equal(oldest.stats.folded, 1, "F4 the oldest was the one dropped, so it has to fold again: " + stable(oldest.stats));
  });

  // A lost 'full' record is harmless (raw is the default shape), so it is
  // evicted before any folded shape.
  withWorld("v4-capacity-full", (world) => {
    world.setConfig(baseConfig({ protectRecentMessages: 100, ledgerMaxEntries: 2 }));
    world.run([objectPart({ failure: { stderr: "E".repeat(70000) } }, "m-err")]);
    world.run([objectPart(shellObject("A".repeat(70000)), "m-a")]);
    world.run([objectPart(shellObject("B".repeat(70000)), "m-b")]);
    const shapes = Object.values(world.ledger()).map((e) => e.shape);
    assert.equal(shapes.length, 2, "F4 the ledger is at its cap");
    assert.deepEqual(shapes.slice().sort(), ["folded", "folded"], "F4 the exempt 'full' record was evicted first: " + shapes.join(","));
  });

  withWorld("v4-capacity-open", (world) => {
    world.setConfig(baseConfig({ protectRecentMessages: 100, ledgerMaxEntries: 0 }));
    for (let i = 0; i < 5; i += 1) world.run([objectPart(shellObject(String.fromCharCode(65 + i).repeat(70000)), "open-" + i)]);
    assert.equal(Object.keys(world.ledger()).length, 5, "F4 ledgerMaxEntries 0 switches pruning off");
  });

  // The shipped cap has to be a real bound, and megabytes rather than gigabytes.
  const sample = { shape: "folded", h: 8000, tl: 4000, n: 240000, t: Date.now(), why: "first-send", k: "object" };
  const catalog = {};
  for (let i = 0; i < 20000; i += 1) catalog[i.toString(36).padStart(12, "0")] = sample;
  const catalogBytes = Buffer.byteLength(JSON.stringify(catalog), "utf8");
  assert.ok(catalogBytes > 1000000 && catalogBytes < 10000000, "F4 a ledger at the shipped ledgerMaxEntries=20000 weighs " + catalogBytes + " bytes");
});
