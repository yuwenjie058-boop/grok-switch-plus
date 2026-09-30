"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentRoster } = require("./agent-roster.cjs");
const A = "11111111-1111-4111-8111-111111111111";
const B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function world(value) {
  let data = value, clock = 1000, reads = 0;
  const roster = createAgentRoster("unused", {
    read() { reads++; if (data instanceof Error) throw data; return data; }, now: () => clock,
  });
  return { roster, reads: () => reads, update(v) { data = v; clock += 2000; }, rollback() { clock -= 5000; } };
}

test("ownership uses validated UUIDs, accepts both shapes, and returns bounded metadata", () => {
  const w = world({ agents: [A, B.toUpperCase(), A] });
  assert.equal(w.roster.has(A), true);
  assert.equal(w.roster.has(B), true);
  assert.deepEqual(w.roster.status(), { ready: true, degraded: false, count: 2, errorCode: null });
  w.update([B]);
  assert.equal(w.roster.has(A), false);
  assert.equal(w.roster.has(B.toUpperCase()), true);
});

for (const bad of [{ agents: [null] }, { agents: [A, 42] }, { agents: A }, [], null,
  Array(1), { agents: [A, ...Array(1)] }, { agents: Array(10001).fill(A) }]) {
  test("malformed roster cannot silently discard confirmed ownership: " + JSON.stringify(bad).slice(0, 45), () => {
    const w = world([A]);
    assert.equal(w.roster.has(A), true);
    w.update(bad);
    assert.equal(w.roster.has(A), true);
    assert.equal(w.roster.has(B), false);
    assert.equal(w.roster.status().degraded, true);
    const cold = world(bad);
    assert.throws(() => cold.roster.has(A), { code: "ROSTER_UNAVAILABLE" });
    assert.throws(() => cold.roster.has(B), { code: "ROSTER_UNAVAILABLE" });
  });
}

test("failed reads retain last-good ownership and recover without leaking error text", () => {
  const w = world([A]); w.roster.has(A);
  w.update(Object.assign(new Error("private-path-and-content"), { code: "EACCES" }));
  assert.equal(w.roster.has(A), true);
  assert.equal(JSON.stringify(w.roster.status()).includes("private"), false);
  w.update([B]);
  assert.equal(w.roster.has(B), true);
  assert.equal(w.roster.has(A), false);
  assert.equal(w.roster.status().degraded, false);
});

test("refresh interval coalesces reads and clock rollback cannot stall recovery", () => {
  const w = world([A]); w.roster.has(A); w.roster.has(A); assert.equal(w.reads(), 1);
  w.update([B]); w.rollback();
  assert.equal(w.roster.has(B), true); assert.equal(w.reads(), 2);
});

test("explicit refresh makes a repaired cold roster usable immediately", () => {
  const w = world(null);
  assert.throws(() => w.roster.has(A), { code: "ROSTER_UNAVAILABLE" });
  w.update([A]);
  assert.equal(w.roster.refresh().ready, true);
  assert.equal(w.roster.has(A), true);
});

test("default file adapter rejects invalid JSON and oversized input, then recovers", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plus-roster-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "roster.json");
  const roster = createAgentRoster(file, { refreshMs: 0 });
  assert.throws(() => roster.has(A), { code: "ROSTER_UNAVAILABLE" });
  fs.writeFileSync(file, "{broken");
  assert.throws(() => roster.has(A), { code: "ROSTER_UNAVAILABLE" });
  fs.writeFileSync(file, JSON.stringify([A]));
  assert.equal(roster.has(A), true);
  fs.writeFileSync(file, " ".repeat(2 * 1024 * 1024 + 1));
  assert.equal(roster.has(A), true);
  assert.equal(roster.status().errorCode, "roster_too_large");
});

test("invalid options and lookup IDs fail predictably", () => {
  assert.throws(() => createAgentRoster("unused", { refreshMs: -1 }), TypeError);
  const w = world([A]);
  assert.equal(w.roster.has("bad"), false); assert.equal(w.reads(), 0);
});
