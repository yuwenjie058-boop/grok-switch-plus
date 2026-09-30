import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const cliSource = fs.readFileSync(new URL("../src/cli.cjs", import.meta.url), "utf8");
const anchors = [
  "const blockReason = deps.getSendBlockReason?.(message, deliverTo);",
  "completeTurnAfterSend: turn.offerSendToUserEndTurn() ? turn.completeThisRun : void 0,",
  "listRunningSubagents: () => this.listRunningSubagents(),"
];
const legacyHost = `
var BasePromptBuilder, BasePromptExecutor;
function createCursorSandInference() {}
function createHostInference() {}
`;

// Preserves the observed host send ordering and all three dependency boundaries.
// Network delivery is represented by an outbox; no cloud tools are invoked.
const modernHost = legacyHost + `
function createSendMessageTool2(deps) {
  return (rawArgs, meta) => {
    const message = { type: rawArgs.type, content: rawArgs.content };
    const deliverTo = rawArgs.to;
    const blockReason = deps.getSendBlockReason?.(message, deliverTo);
    if (blockReason != null) return { result: { case: "error", value: { error: blockReason } } };
    deps.onSendMessage(message, Date.now(), deliverTo);
    if ("end_turn" in rawArgs && rawArgs.end_turn === true) deps.completeTurnAfterSend?.();
    return { result: { case: "success" } };
  };
}
function buildTurnTools(host, turn) {
  return createSendMessageTool2({
    completeTurnAfterSend: turn.offerSendToUserEndTurn() ? turn.completeThisRun : void 0,
    onSendMessage: message => host.outbox.push(message),
    getSendBlockReason: () => host.transportBlock
  });
}
class Runner {
  constructor(running = false, transportBlock = null) {
    this.running = running;
    this.outbox = [];
    this.completed = false;
    const turnToolHost = {
      listRunningSubagents: () => this.listRunningSubagents(),
      outbox: this.outbox,
      transportBlock
    };
    this.send = buildTurnTools(turnToolHost, {
      offerSendToUserEndTurn: () => true,
      completeThisRun: () => { this.completed = true; }
    });
  }
  listRunningSubagents() { return this.running ? [{ id: "worker" }] : []; }
  hasRunningBackgroundWork() { return this.running; }
}
globalThis.Runner = Runner;
`;

// The host hook consumes the runtime's candidate registry. Its detection logic
// is tested separately; this double makes argument/identity loss fail visibly.
const payload = `
var candidateIds = new Set(["candidate"]);
function grokSwitchTerminalBlockReason(callId, rawArgs, hasRunningWork) {
  if (!candidateIds.has(callId) || rawArgs.end_turn !== true) return null;
  if (typeof hasRunningWork !== "function" || hasRunningWork() !== false) return null;
  return "Task discovery did not start work.";
}
`;

function patcher() {
  const scope = vm.createContext({
    require, process: { ...process, stdout: new PassThrough() }, module: {}, __filename: "host-hook-test.cjs",
    GROK_SWITCH_DIR: "/unused", GROK_SWITCH_CONFIG_PATH: "/unused/config.json",
    GROK_SWITCH_LOG_PATH: "/unused/requests.log", GROK_SWITCH_CODEX_BASE_URL: "https://example.invalid"
  });
  vm.runInContext(cliSource, scope);
  scope.cliPayload = () => payload;
  return scope;
}

function loadPatchedHost() {
  const cli = patcher();
  const scope = vm.createContext({});
  vm.runInContext(cli.cliBuildPatched(modernHost), scope);
  return { cli, scope };
}

const progress = { type: "text", content: "The requested task has started; I will report when finished.", end_turn: true };

test("patched host rejects an unsupported final progress claim before delivery and completion", () => {
  const { scope } = loadPatchedHost();
  const runner = new scope.Runner(false);
  const result = runner.send(progress, { toolCallId: "candidate" });
  assert.equal(result.result.case, "error");
  assert.match(result.result.value.error, /did not start work/);
  assert.equal(runner.outbox.length, 0);
  assert.equal(runner.completed, false);
});

test("patched host permits a final background yield when live runner work exists", () => {
  const { scope } = loadPatchedHost();
  const runner = new scope.Runner(true);
  assert.equal(runner.send(progress, { toolCallId: "candidate" }).result.case, "success");
  assert.equal(runner.outbox.length, 1);
  assert.equal(runner.completed, true);
});

test("official and other calls without a runtime candidate keep native send behavior", () => {
  const { scope } = loadPatchedHost();
  const runner = new scope.Runner(false);
  assert.equal(runner.send(progress, { toolCallId: "official-call" }).result.case, "success");
  assert.equal(runner.outbox.length, 1);
  assert.equal(runner.completed, true);
});

test("native transport rejection keeps priority over the terminal guard", () => {
  const { scope } = loadPatchedHost();
  const runner = new scope.Runner(false, "Awaiting user selection");
  const result = runner.send(progress, { toolCallId: "candidate" });
  assert.equal(result.result.value.error, "Awaiting user selection");
  assert.equal(runner.outbox.length, 0);
  assert.equal(runner.completed, false);
});

test("patch inspection reverses every terminal hook and supports a clean reapply", () => {
  const cli = patcher();
  const patched = cli.cliBuildPatched(modernHost);
  const restored = cli.cliInspectBundle(patched).stock;
  assert.equal(restored, modernHost);
  assert.equal(cli.cliBuildPatched(restored), patched);
});

for (const [index, anchor] of anchors.entries()) {
  test(`modern host rejects missing terminal hook anchor ${index + 1}`, () => {
    const cli = patcher();
    assert.throws(() => cli.cliBuildPatched(modernHost.replace(anchor, "/* changed host contract */")), /terminal.*contract|terminal.*anchor/i);
  });
  test(`modern host rejects duplicate terminal hook anchor ${index + 1}`, () => {
    const cli = patcher();
    assert.throws(() => cli.cliBuildPatched(modernHost + "\n" + anchor), /terminal.*contract|terminal.*anchor/i);
  });
}

test("legacy hosts without the send-message implementation remain patchable and reversible", () => {
  const cli = patcher();
  const patched = cli.cliBuildPatched(legacyHost);
  assert.equal(cli.cliInspectBundle(patched).stock, legacyHost);
});

test("partially modified terminal hooks cannot be silently restored", () => {
  const cli = patcher();
  const patched = cli.cliBuildPatched(modernHost);
  const damaged = patched.replace("?? grokSwitchTerminalBlockReason(meta.toolCallId, rawArgs, deps.grokSwitchHasRunningBackgroundWork)", "?? null");
  assert.throws(() => cli.cliInspectBundle(damaged), /damaged.*terminal|terminal.*damaged/i);
});

test("duplicate modern send implementations require compatibility review", () => {
  const cli = patcher();
  assert.throws(() => cli.cliBuildPatched(modernHost + "\nfunction createSendMessageTool2() {}"), /terminal.*contract|terminal.*anchor/i);
});

test("removing hook markers without reverting hook code is rejected during restore", () => {
  const cli = patcher();
  const damaged = cli.cliBuildPatched(modernHost).replaceAll(/\/\* GROK_SWITCH_TERMINAL_[A-Z]+ \*\//g, "");
  assert.throws(() => cli.cliInspectBundle(damaged), /damaged.*terminal|terminal.*damaged/i);
});

test("terminal hooks orphaned from the injected runtime are not treated as stock", () => {
  const cli = patcher();
  const damaged = cli.cliBuildPatched(modernHost).replace(/\/\/ GROK_SWITCH_BEGIN[^]*?\/\/ GROK_SWITCH_END\n/, "");
  assert.throws(() => cli.cliInspectBundle(damaged), /damaged.*terminal|terminal.*damaged/i);
});
