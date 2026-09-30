// Shared loader for the ctx-compact section under test.
//
// The section is a slice of the shipped bundle, so it expects `var
// GROK_SWITCH_DIR`, `grokSwitchFs()` and `grokSwitchReadConfigText()` from its
// host. Each world gets its own temp dir and its own VM context, so two
// versions of the section (the v3 baseline and the shipped v4) can be driven
// side by side without sharing a single global.
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const require = createRequire(import.meta.url);

export function createWorld(sectionText, label, options) {
  const dir = mkdtempSync(join(tmpdir(), label + "-"));
  let configJson = "null";
  const realFs = require("node:fs");
  const failWrite = options && options.failWrite ? options.failWrite : null;
  const fsShim = Object.create(realFs);
  fsShim.writeFileSync = (file, data, opts) => {
    if (failWrite != null && String(file).indexOf(failWrite) >= 0) throw new Error("simulated ENOSPC");
    return realFs.writeFileSync(file, data, opts);
  };
  const sandbox = {
    require,
    Buffer,
    process,
    console,
    setTimeout,
    clearTimeout,
    GROK_SWITCH_DIR: dir,
    grokSwitchFs: () => (failWrite == null ? realFs : fsShim),
    grokSwitchReadConfigText: () => configJson
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sectionText, sandbox, { filename: label + ".section.cjs" });

  return {
    dir,
    api: sandbox,
    setConfig(cfg) {
      configJson = cfg == null ? "null" : JSON.stringify({ contextCompact: cfg });
    },
    /** Run one request through the section, with the section reading its own config. */
    run(messages) {
      return sandbox.grokSwitchCompactMessages(messages, sandbox.grokSwitchCompactConfig());
    },
    ledgerPath: join(dir, "ctx-compact-ledger.json"),
    ledger() {
      return JSON.parse(readFileSync(join(dir, "ctx-compact-ledger.json"), "utf8"));
    },
    ledgerExists() {
      return existsSync(join(dir, "ctx-compact-ledger.json"));
    },
    cacheFiles() {
      const cacheDir = join(dir, "ctx-cache");
      if (!existsSync(cacheDir)) return [];
      return readdirSync(cacheDir).map((name) => ({
        name,
        bytes: statSync(join(cacheDir, name)).size
      }));
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Read the shipped v3 baseline the differential section compares against. */
export function readV3Baseline() {
  return readFileSync(new URL("../fixtures/ctx-compact/ctx-compact.section.v3.cjs", import.meta.url), "utf8");
}

/** Prime a world's ledger with an explicit object, as a previous request would have left it. */
export function primeLedger(world, ledger) {
  writeFileSync(world.ledgerPath, JSON.stringify(ledger), { mode: 384 });
}

/** A tool-result part with a configurable `type`, for the underscore spelling. */
export const typedPart = (value, id, type) => ({
  role: "tool",
  content: [{ type: type, toolCallId: id || "call-1", toolName: "run_terminal_command_v2", result: value }]
});

/** Base config: everything a fold needs, only the knobs under test differ. */
export const baseConfig = (over) =>
  Object.assign(
    {
      enabled: true,
      mode: "apply",
      thresholdChars: 60000,
      freshHeadChars: 8000,
      freshTailChars: 4000,
      protectRecentMessages: 6,
      errorExempt: true,
      ledgerMaxEntries: 20000,
      ledgerRefreshMs: 3600000
    },
    over
  );

/** A tool-result part carrying a text result. */
export const textPart = (text, id) => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: id || "call-1", toolName: "run_terminal_command_v2", result: text }]
});

/** A tool-result part carrying a *parsed object* result, exactly as the host builds it. */
export const objectPart = (value, id) => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: id || "call-1", toolName: "run_terminal_command_v2", result: value }]
});

/** Result-like shell object, the shape the real transcripts use. */
export const shellObject = (stdout, extra) =>
  Object.assign(
    {
      success: {
        stdout,
        interleavedOutput: stdout,
        command: "sleep 1; cat big.log",
        outputLocation: { filePath: "/tmp/big.log", sizeBytes: 7, lineCount: 4 }
      },
      isBackground: false
    },
    extra
  );

/** Deep clone that also rebuilds objects with reversed key order at every level. */
export function reorderKeys(value) {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (value == null || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).reverse()) out[key] = reorderKeys(value[key]);
  return out;
}

/** Character count of a message list, measured the way ctx-profile measures it. */
export function payloadChars(messages) {
  let total = 0;
  for (const message of messages) {
    for (const part of message.content) {
      if (typeof part.result === "string") total += part.result.length;
      else if (part.result != null) total += JSON.stringify(part.result).length;
    }
  }
  return total;
}
