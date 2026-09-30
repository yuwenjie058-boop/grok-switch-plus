// Behavioural suite for the merged ctx-probe section (src/ctx-probe.cjs), the
// request-body profiler the runtime calls from its request logger. The section
// is byte-for-byte the region the live bundle carries; the live bundle only
// proves it is *present*, so these are the first assertions on what it writes.
//
//   P1  counts and sizes per role/part type, and never message text
//   P2  the biggest-entry list is capped and sorted
//   P3  the profile file rotates once past its size cap
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const section = readFileSync(new URL("../src/ctx-probe.cjs", import.meta.url), "utf8");

function withProbe(label, fn) {
  const dir = mkdtempSync(join(tmpdir(), label + "-"));
  const sandbox = {
    require,
    process,
    console,
    GROK_SWITCH_DIR: dir,
    grokSwitchFs: () => require("node:fs")
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(section, sandbox, { filename: label + ".section.cjs" });
  try {
    return fn({
      dir,
      profilePath: join(dir, "ctx-profile.jsonl"),
      append(entry, messages) {
        return sandbox.grokSwitchAppendProfile(entry, messages);
      },
      records() {
        return readFileSync(join(dir, "ctx-profile.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const entry = (over) => Object.assign({ ts: "2026-09-18T00:00:00.000Z", kind: "chat", model: "grok-4", usage: { promptTokens: 11 }, cacheReadTokens: 2, cacheWriteTokens: 3 }, over);

test("P1 the probe records sizes per role and part type, and no message text", () => {
  withProbe("probe-shape", (world) => {
    const resultValue = { stdout: "T".repeat(400) };
    const resultChars = JSON.stringify(resultValue).length;
    world.append(entry(), [
      { role: "system", content: "S".repeat(300) },
      { role: "assistant", content: [{ type: "reasoning", text: "R".repeat(50) }, { type: "tool-call", toolCallId: "c1", toolName: "Read", args: { path: "/x" } }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", toolName: "Read", result: resultValue }] },
      { role: "user", content: [{ type: "image", data: "I".repeat(20), mimeType: "image/png" }, { type: "text", text: "SECRETMESSAGE" }] }
    ]);
    const [profile] = world.records();
    assert.equal(profile.messages, 4, "P1 every message is counted");
    assert.equal(profile.systemChars, 300, "P1 a plain string content is sized");
    assert.equal(profile.reasoningChars, 50, "P1 reasoning parts are sized");
    assert.equal(profile.imageParts, 1, "P1 image parts are counted");
    // An image part carries none of the fields the sizer knows, so it falls back
    // to the size of the part's own JSON: that is the shipped behaviour and the
    // only number that stays honest without ever reading the bytes.
    assert.equal(profile.imageChars, JSON.stringify({ type: "image", data: "I".repeat(20), mimeType: "image/png" }).length, "P1 image parts are sized");
    assert.equal(profile.toolResultChars, resultChars, "P1 the underscore tool_result part is sized: " + JSON.stringify(profile.byType));
    assert.equal(profile.byType["tool:tool_result"], resultChars, "P1 the underscore part type is profiled, not just the dashed one");
    assert.equal(profile.promptTokens, 11, "P1 usage is carried over");
    assert.equal(profile.cacheReadTokens, 2, "P1 cache reads are carried over");
    assert.equal(profile.cacheWriteTokens, 3, "P1 cache writes are carried over");
    assert.ok(profile.biggest.every((pair) => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "number"), "P1 biggest holds [role, chars] pairs");
    const serialized = JSON.stringify(profile);
    assert.ok(!serialized.includes("SECRETMESSAGE") && !serialized.includes("TTTT"), "P1 no message text reaches the profile");
  });
});

test("P2 the biggest-entry list is capped at eight rows and sorted by size", () => {
  withProbe("probe-biggest", (world) => {
    const messages = [];
    for (let i = 0; i < 11; i += 1) messages.push({ role: "user", content: [{ type: "text", text: "x".repeat(2100 + i * 10) }] });
    world.append(entry(), messages);
    const [profile] = world.records();
    assert.equal(profile.biggest.length, 8, "P2 at most eight rows are recorded, however many are big");
    const sizes = profile.biggest.map((pair) => pair[1]);
    assert.deepEqual(sizes.slice().sort((a, b) => b - a), sizes, "P2 the rows are sorted largest first");
    assert.equal(sizes[0], 2200, "P2 the largest row is the largest message");
  });
});

test("P3 the profile file rotates to .1 once its cap is exceeded", () => {
  withProbe("probe-rotate", (world) => {
    const cap = 8 * 1024 * 1024;
    writeFileSync(world.profilePath, Buffer.alloc(cap + 1, 0x78), { mode: 384 });
    world.append(entry(), [{ role: "user", content: "x" }]);
    assert.equal(statSync(world.profilePath + ".1").size, cap + 1, "P3 the oversized file is moved aside intact");
    const records = world.records();
    assert.equal(records.length, 1, "P3 the oversized file is replaced, not appended to");
    assert.equal(records[0].messages, 1, "P3 and the new record is the one that crossed the cap");
  });
});
