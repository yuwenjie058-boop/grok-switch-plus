// Behavioural port of the ctx-compact v3 harness that used to live in
// outputs/patch-cloud9/check-compact-v3.mjs. Every one of its 32 checks is a
// single assertion here, grouped the same way.
// Policy under test: fold a large tool result once, on its first send, and never
// rewrite bytes that were already sent upstream.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const section = readFileSync(join(here, "..", "src", "ctx-compact.cjs"), "utf8");

globalThis.require = createRequire(import.meta.url);
const fs = require("node:fs");

const ROOT = join(tmpdir(), "ctx-compact-" + process.pid);

// Loads the section with an empty ledger directory, so every scenario starts clean.
function load(cfg) {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const cfgJson = JSON.stringify({ contextCompact: cfg });
  vm.runInThisContext(
    "var GROK_SWITCH_DIR = " + JSON.stringify(ROOT) + ";\n" +
    "var grokSwitchFs = function () { return require('node:fs'); };\n" +
    "var grokSwitchReadConfigText = function () { return " + JSON.stringify(cfgJson) + "; };\n" +
    section,
    { filename: "src/ctx-compact.cjs" }
  );
}

// Same loader with a fault-injecting fs and no wipe, so an existing ledger survives.
function loadFaulty(cfg, needle) {
  mkdirSync(ROOT, { recursive: true });
  const cfgJson = JSON.stringify({ contextCompact: cfg });
  const real = require("node:fs");
  const shim = Object.create(real);
  shim.writeFileSync = (file, data, options) => {
    if (String(file).indexOf(needle) >= 0) throw new Error("simulated ENOSPC");
    return real.writeFileSync(file, data, options);
  };
  globalThis.__shim = shim;
  vm.runInThisContext(
    "var GROK_SWITCH_DIR = " + JSON.stringify(ROOT) + ";\n" +
    "var grokSwitchFs = function () { return globalThis.__shim; };\n" +
    "var grokSwitchReadConfigText = function () { return " + JSON.stringify(cfgJson) + "; };\n" +
    section,
    { filename: "src/ctx-compact.cjs" }
  );
}

const cfgOf = (over) => Object.assign({
  enabled: true, mode: "apply", thresholdChars: 1000,
  keepHeadChars: 100, keepTailChars: 50,
  freshHeadChars: 200, freshTailChars: 80,
  protectRecentMessages: 1, errorExempt: true, ledgerMaxEntries: 20000, ledgerRefreshMs: 3600000
}, over);
const opts = () => grokSwitchCompactConfig();
const ledgerPath = () => join(ROOT, "ctx-compact-ledger.json");
const ledger = () => JSON.parse(readFileSync(ledgerPath(), "utf8"));
const tool = (text, id) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id || "c1", result: text }] });
const A = "A".repeat(5000), B = "B".repeat(5000), C = "C".repeat(5000), D = "D".repeat(5000), SMALL = "s".repeat(100);

let r = null;
let firstShape = null;
let shapeC = null;

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

// 1. dry-run: measures, rewrites nothing, records nothing
test("dry-run measures the saving without rewriting or recording", () => {
  load(cfgOf({ mode: "dry-run" }));
  r = grokSwitchCompactMessages([tool(A), tool(B)], opts());
  assert.ok(r.messages[0].content[0].result === A && r.messages[1].content[0].result === B, "dry-run leaves messages untouched");
  assert.ok(r.stats.parts === 1 && r.stats.savedChars === 5000 - 280, "dry-run measures the fresh-window saving: " + JSON.stringify(r.stats));
  assert.ok(!existsSync(ledgerPath()), "dry-run writes no ledger");
  assert.ok(!/folded here to save context/.test(r.messages[1].content[0].result), "dry-run hides the shape it would send");
});

// 2. apply folds the fresh monster on its first send
test("apply folds the fresh monster on its first send", () => {
  load(cfgOf({ mode: "apply" }));
  r = grokSwitchCompactMessages([tool(A), tool(B)], opts());
  assert.ok(/folded here to save context/.test(r.messages[1].content[0].result), "fresh result is folded");
  assert.ok(r.messages[1].content[0].result.startsWith("B".repeat(200)) && r.messages[1].content[0].result.endsWith("B".repeat(80)), "fresh fold keeps the fresh head/tail");
  assert.ok(readdirSync(join(ROOT, "ctx-cache")).length === 1, "full text is written aside: " + readdirSync(join(ROOT, "ctx-cache")).join(","));
  const led = ledger();
  const foldedKey = Object.keys(led).find((k) => led[k].shape === "folded");
  assert.ok(led[foldedKey].why === "first-send" && led[foldedKey].h === 200 && led[foldedKey].tl === 80, "ledger records the folded shape with its params: " + JSON.stringify(led[foldedKey]));
  firstShape = r.messages[1].content[0].result;
});

// 3. replay is byte-identical, even after the config band changes
test("replay after a restart is byte-identical", () => {
  load(cfgOf({ mode: "apply" }));
  grokSwitchCompactMessages([tool(A), tool(B)], opts());
  const shapeAfterLoad = grokSwitchCompactMessages([tool(A), tool(B)], opts()).messages[1].content[0].result;
  assert.ok(shapeAfterLoad === firstShape, "replay after restart is byte-identical");
});

// 4. a large result that was already upstream before we saw it is never rewritten
test("a large result that was already upstream is never rewritten", () => {
  load(cfgOf({ mode: "apply" }));
  r = grokSwitchCompactMessages([tool(A), tool(B), tool(C)], opts());
  assert.ok(r.messages[0].content[0].result === A, "pre-existing large result keeps its bytes");
  assert.ok(Object.keys(ledger()).length === 1, "pre-existing result is not recorded: " + JSON.stringify(ledger()));
  assert.ok(/folded here to save context/.test(r.messages[2].content[0].result), "fresh monster in the same request is folded");
  shapeC = r.messages[2].content[0].result;
});

// 5. the old sliding-window rewrite is gone: a folded message that slides out stays folded
test("a folded message that slides out stays folded", () => {
  r = grokSwitchCompactMessages([tool(A), tool(B), tool(C), tool(D)], opts());
  assert.ok(r.messages[2].content[0].result === shapeC, "folded message replays identically once outside the window");
  assert.ok(r.messages[0].content[0].result === A, "message that slid out and was never folded stays raw");
  assert.ok(r.stats.folded === 1 && r.stats.frozen === 1, "only the new fresh monster is folded this turn: " + JSON.stringify(r.stats));
});

// 6. error-ish output is never folded
test("error-ish output is never folded", () => {
  load(cfgOf({ mode: "apply" }));
  const err = "Traceback (most recent call last):\n" + "x".repeat(4000);
  r = grokSwitchCompactMessages([tool(err)], opts());
  assert.ok(r.messages[0].content[0].result === err && r.stats.errorExempt === 1, "error output is exempt");
  assert.ok(Object.values(ledger())[0].why === "error", "exemption is recorded as full: " + JSON.stringify(ledger()));
});

// 7. small results are ignored entirely
test("below-threshold results are ignored entirely", () => {
  load(cfgOf({ mode: "apply" }));
  r = grokSwitchCompactMessages([tool(SMALL), tool("y".repeat(999))], opts());
  assert.ok(r.stats.parts === 0 && !existsSync(ledgerPath()), "below-threshold results are skipped");
});

// 8. determinism
test("fold output is deterministic", () => {
  const shapes = [];
  for (let k = 0; k < 2; k += 1) {
    load(cfgOf({ mode: "apply" }));
    shapes.push(grokSwitchCompactMessages([tool(A)], opts()).messages[0].content[0].result);
  }
  assert.ok(shapes[0] === shapes[1], "fold output is deterministic");
});

// 9. disabled config is a no-op
test("a disabled config is a no-op", () => {
  load(cfgOf({ mode: "apply", enabled: false }));
  r = grokSwitchCompactMessages([tool(A)], opts());
  assert.ok(r.messages[0].content[0].result === A && r.stats.parts === 0, "disabled config is a no-op");
});

// 10. ledger pruning keeps the shapes that cannot be reproduced
test("pruning keeps the shapes that cannot be reproduced", () => {
  load(cfgOf({ mode: "apply", ledgerMaxEntries: 3, protectRecentMessages: 6 }));
  const many = [];
  for (let k = 0; k < 6; k += 1) many.push(tool("M" + k + "_" + "z".repeat(4000)));
  grokSwitchCompactMessages(many, opts());
  assert.ok(Object.keys(ledger()).length === 3, "ledger is pruned to the cap: " + String(Object.keys(ledger()).length));

  load(cfgOf({ mode: "apply", ledgerMaxEntries: 3, protectRecentMessages: 8 }));
  const more = [];
  for (let k = 0; k < 30; k += 1) more.push(tool("P" + k + "_" + "q".repeat(4000)));
  more.push(tool("boom: command not found in step 7 " + "e".repeat(4000)));
  grokSwitchCompactMessages(more, opts());
  const kept = ledger();
  const fullKept = Object.values(kept).filter((v) => v.shape === "full").length;
  assert.ok(Object.keys(kept).length === 3 && fullKept === 0, "v3 pruning drops the full (error) record first and keeps folded shapes: " + JSON.stringify({ n: Object.keys(kept).length, fullKept }));
  assert.ok(!existsSync(ledgerPath() + ".tmp"), "no temporary ledger file is left behind");
});

// 11. v3 fail-closed: an unrecordable fold must never reach the wire
test("fail-closed: an unrecordable fold never reaches the wire", () => {
  load(cfgOf({ mode: "apply" }));
  const seed = grokSwitchCompactMessages([tool(A)], opts());
  assert.ok(/folded here to save context/.test(seed.messages[0].content[0].result) && Object.keys(ledger()).length === 1, "seed turn folds and records A");
  loadFaulty(cfgOf({ mode: "apply" }), "ctx-compact-ledger.json.tmp");
  const r11 = grokSwitchCompactMessages([tool(A), tool(B)], opts());
  assert.ok(r11.stats.ledgerWriteFailed === 1, "ledger write failure is reported: " + JSON.stringify(r11.stats));
  assert.ok(r11.messages[1].content[0].result === B, "unrecorded fold is reverted to raw");
  assert.ok(/folded here to save context/.test(r11.messages[0].content[0].result), "already-recorded shape still replays under a failed write");
  assert.ok(r11.stats.folded === 0, "nothing new is frozen while the ledger is unwritable: " + JSON.stringify(r11.stats));
});

// 12. v3 merge-on-save: a record written by another request is not erased
test("merge-on-save keeps a record written by another request", () => {
  load(cfgOf({ mode: "apply" }));
  writeFileSync(ledgerPath(), JSON.stringify({ "00000000000000ab": { shape: "folded", h: 200, tl: 80, n: 9999, t: 1, why: "first-send" } }));
  grokSwitchCompactMessages([tool(A)], opts());
  const kept = ledger();
  assert.ok(kept["00000000000000ab"] !== undefined && Object.keys(kept).length === 2, "a concurrently written record survives the save: " + JSON.stringify(Object.keys(kept)));
});

// 13. v3 pruning pins folded shapes that this request actually used
test("pruning pins folded shapes this request actually used", () => {
  load(cfgOf({ mode: "apply", ledgerMaxEntries: 3, protectRecentMessages: 1 }));
  let hist = [tool(A)];
  let last = grokSwitchCompactMessages(hist, opts());
  const foldedA = /folded here to save context/.test(last.messages[0].content[0].result);
  for (let k = 0; k < 6; k += 1) {
    hist = hist.concat([tool("N" + k + "_" + "n".repeat(4000))]);
    last = grokSwitchCompactMessages(hist, opts());
  }
  assert.ok(foldedA, "A was folded first");
  assert.ok(/folded here to save context/.test(last.messages[0].content[0].result), "pruning never drops a folded shape still in use: ledger=" + Object.keys(ledger()).length);
  assert.ok(Object.keys(ledger()).length === 3, "ledger still respects the cap: " + String(Object.keys(ledger()).length));
});

// 14. the engine is wired into the single-file build, not just present in src/.
// The deeper build-wiring assertions live in tests/ctx-compact-v4.test.mjs.
test("the built bundle carries the engine and its first-send call site", () => {
  const dist = readFileSync(join(here, "..", "dist", "grok-switch.cjs"), "utf8");
  assert.ok(dist.includes("// [ctx-compact v4.1]"), "dist embeds the ctx-compact v4.1 section");
  assert.ok(dist.includes("grokSwitchCompactMessages(messages, compactOpts)"), "dist calls the engine from grokSwitchStream");
});