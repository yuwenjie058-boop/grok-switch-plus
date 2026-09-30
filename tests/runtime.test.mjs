// Loads the injectable payload out of dist/grok-switch.cjs into a VM that
// imitates the host bundle scope, then drives createHostInference the way the
// host does. Run `node build.mjs` first (npm test does).
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = fs.readFileSync(path.join(root, "dist", "grok-switch.cjs"), "utf8");
const FIXTURES = path.join(root, "tests", "fixtures", "protocols", "streams");
const CONFIG_PATH = "/workspace/grok-switch/config.json";
const LOG_PATH = "/workspace/grok-switch/requests.log";

function payload() {
  const begin = DIST.indexOf("// GROK_SWITCH_PAYLOAD_BEGIN");
  const end = DIST.indexOf("// GROK_SWITCH_PAYLOAD_END");
  assert.ok(begin > 0 && end > begin, "dist file must contain payload markers");
  return DIST.slice(begin, end);
}

class BasePromptBuilder {
  constructor(initial) {
    this.messages = initial == null ? [] : Array.isArray(initial) ? [...initial] : [initial];
  }
  getMessages() {
    return [...this.messages];
  }
}

class BasePromptExecutor {
  constructor(builder) {
    this.builder = builder;
  }
  getMessages() {
    return this.builder.getMessages();
  }
}

function sse(text, extra = {}) {
  const status = extra.status ?? 200;
  const bytes = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => ({ "content-type": "text/event-stream", "x-request-id": "req-1", ...extra.headers })[name.toLowerCase()] ?? null },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    })
  };
}

function jsonFailure(status, body) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer
  };
}

// Builds a fresh host-like scope. `files` is a mutable map standing in for the
// filesystem so tests can change config.json between calls.
function loadHost({ files = new Map(), fetchImpl, classifyTokenLimitErrorFromMessage, terminalGuardSource = false } = {}) {
  const fetches = [];
  const originalCalls = [];
  const labelingCalls = [];
  const directories = new Set();
  const descriptors = new Map();
  let nextDescriptor = 10;
  const context = {
    classifyTokenLimitErrorFromMessage,
    console,
    process: { env: { CODEX_HOME: "/codex" }, pid: 4242 },
    Buffer,
    URLSearchParams,
    fetch: async (url, init) => {
      const isJson = init.headers["content-type"] === "application/json";
      fetches.push({ url, init, body: isJson ? JSON.parse(init.body) : init.body });
      return fetchImpl(url, init, fetches.length);
    },
    TextDecoder,
    TextEncoder,
    crypto,
    URL,
    Uint8Array,
    ArrayBuffer,
    ReadableStream,
    AbortController,
    Promise,
    Map,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Number,
    Object,
    Array,
    String,
    Error,
    Symbol,
    Math,
    BasePromptBuilder,
    BasePromptExecutor,
    require(id) {
      if (id === "node:crypto") return nodeCrypto;
      assert.equal(id, "node:fs");
      return {
        openSync(file) {
          if (!files.has(file) && !directories.has(file)) throw new Error("ENOENT");
          const fd = nextDescriptor++;
          descriptors.set(fd, file);
          return fd;
        },
        fsyncSync(fd) { assert.ok(descriptors.has(fd), "fsync needs an open descriptor"); },
        closeSync(fd) { assert.ok(descriptors.delete(fd), "close needs an open descriptor"); },
        readFileSync(file) {
          if (!files.has(file)) {
            const error = new Error("ENOENT " + file);
            error.code = "ENOENT";
            throw error;
          }
          return files.get(file);
        },
        statSync(file) {
          if (!files.has(file)) throw new Error("ENOENT");
          return { size: files.get(file).length };
        },
        existsSync(file) {
          return files.has(file) || directories.has(file);
        },
        renameSync(from, to) {
          files.set(to, files.get(from));
          files.delete(from);
        },
        appendFileSync(file, data) {
          files.set(file, (files.get(file) ?? "") + data);
        },
        writeFileSync(file, data, options) {
          if (options?.flag === "wx" && files.has(file)) {
            const error = new Error("EEXIST " + file);
            error.code = "EEXIST";
            throw error;
          }
          files.set(file, data);
        },
        mkdirSync(dir, options) {
          if (directories.has(dir) && !options?.recursive) {
            const error = new Error("EEXIST " + dir);
            error.code = "EEXIST";
            throw error;
          }
          directories.add(dir);
        },
        unlinkSync(file) {
          if (!files.delete(file)) {
            const error = new Error("ENOENT " + file);
            error.code = "ENOENT";
            throw error;
          }
        },
        rmdirSync(dir) {
          if (!directories.delete(dir)) throw new Error("missing directory " + dir);
        }
      };
    },
    __grokSwitchOriginalCreateHostInference(options) {
      originalCalls.push(options);
      // Mirrors the host: sessions are class instances whose methods live on
      // the prototype, not own enumerable properties.
      class OfficialSession {
        constructor(onRequestId, sessionOptions) {
          this.official = true;
          this.onRequestId = onRequestId;
          this.sessionOptions = sessionOptions;
          this.requestedModel = { modelId: "grok-official" };
        }
        getModelId() {
          return this.requestedModel.modelId;
        }
        getExecutor(state) {
          const executor = new BasePromptExecutor(new BasePromptBuilder(state));
          executor.stream = (...args) => {
            originalCalls.push({ streamed: true, args });
            const done = Promise.resolve({});
            return { fullStream: (async function* () {})(), usage: done, extendedUsage: done, providerMetadata: done, invocationId: done, response: done };
          };
          return executor;
        }
      }
      return {
        resolvePrivacyMode: () => "official-privacy",
        createSession: (onRequestId, sessionOptions) => new OfficialSession(onRequestId, sessionOptions),
        recordPostTurnLabeling: (args) => labelingCalls.push(["post", args]),
        recordFollowupLabeling: (args) => labelingCalls.push(["followup", args])
      };
    }
  };
  vm.createContext(context);
  vm.runInContext('"use strict";\n' + payload(), context, { filename: "payload.cjs" });
  // Local candidate tests can exercise the changed guard without rebuilding or
  // modifying the distributable. All other tests retain the bundled payload.
  if (terminalGuardSource) vm.runInContext(fs.readFileSync(path.join(root, "src", "terminal-guard.cjs"), "utf8"), context, { filename: "terminal-guard-source.cjs" });
  const inference = context.createHostInference({ auth: {}, experiments: {}, settings: {} });
  return { context, inference, fetches, originalCalls, labelingCalls, files };
}

async function drain(result) {
  const events = [];
  let streamError = null;
  try {
    for await (const event of result.fullStream) events.push(event);
  } catch (error) {
    streamError = error;
  }
  const settle = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  return {
    events,
    streamError,
    usage: await settle(result.usage),
    response: await settle(result.response),
    providerMetadata: await settle(result.providerMetadata)
  };
}

function config(active, providers) {
  return JSON.stringify({ active, providers });
}

// Objects created inside the VM have a different Object prototype.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const OPENAI = { protocol: "openai-chat", baseUrl: "https://api.example.com/v1", model: "gpt-x", apiKey: "sk-secret" };

// Regression: t15 discovered Task, then sent a progress promise with end_turn=true.
// Removing pre-send validation must make the first case fail, not restart a job.
const TERMINAL_PROMISE = "节点导入和应用内连通性测试已经开始，完成后我会回报真实结果；不会登录社媒或发布内容。";
function terminalDiscoveryHistory(user = "请把测试做完并报告结果") {
  return [
    { role: "user", content: user },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "discover_task", toolName: "GetDynamicTools", args: { namespace: "cursor", toolName: "Task" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "discover_task", toolName: "GetDynamicTools", result: '<cursor_untrusted_data_1337 source="GetDynamicTools">\n{"tool":"Task","inputSchema":{"type":"object"}}\n</cursor_untrusted_data_1337>' }] }
  ];
}
async function terminalCandidate({ history = terminalDiscoveryHistory(), content = TERMINAL_PROMISE, end = true, enabled = true, mode, sourceCandidate = false, existingHost, earlierCalls = [] } = {}) {
  const args = { type: "text", content, end_turn: end };
  const calls = [...earlierCalls, { id: "terminal_send", name: "SendToUser", args }];
  const events = calls.map((call, index) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }));
  events.push({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  const files = existingHost?.files || new Map([[CONFIG_PATH, config("main", { main: OPENAI })]]);
  files.set("/workspace/grok-switch/terminal-guard.json", JSON.stringify({ enabled, ...(mode == null ? {} : { mode }) }));
  const host = existingHost || loadHost({ files, terminalGuardSource: sourceCandidate, fetchImpl: () => sse(host.terminalFixtureReply) });
  host.terminalFixtureReply = events.map(e => "data: " + JSON.stringify(e) + "\n\n").join("") + "data: [DONE]\n\n";
  const out = await drain(host.inference.createSession(null, { requestSource: "turn" }).getExecutor(history).stream({}, "terminal_test", [], {}));
  assert.equal(out.streamError, null);
  const id = out.events.find(e => e.type === "tool-call" && e.toolName === "SendToUser").toolCallId;
  return { host, out, args, id, check: (running = () => false) => host.context.grokSwitchTerminalBlockReason?.(id, args, running) ?? null };
}

test("terminal guard rejects discovery-only started promise before user delivery", async () => {
  const r = await terminalCandidate();
  assert.match(r.check(), /not sent.*turn remains open/i);
  assert.equal(r.check(), null, "candidate is consumed once, never a scheduled revival");
  const logs = [...r.host.files.values()].join("\n");
  assert.ok(!logs.includes(TERMINAL_PROMISE), "guard diagnostic must not log message contents");
});

for (const [name, options] of [
  ["opt-in disabled", { enabled: false }],
  ["ordinary progress", { end: false }],
  ["verified final result", { content: "测试完成，结果为通过。" }],
  ["quoted explanation", { content: "问题在于她说‘测试已经开始，完成后我会回报’，但并没有启动任务。" }],
  ["blocked response", { content: "测试未能开始：缺少授权，请先提供授权。" }],
  ["user requested stop", { history: terminalDiscoveryHistory("先暂停，不要继续，等待我明确指令") }],
  ["different user turn", { history: [...terminalDiscoveryHistory(), { role: "user", content: "解释刚才的工具" }] }],
  ["explanatory request", { history: terminalDiscoveryHistory("请解释 Task 的参数，不要执行") }],
  ["unrelated discovery", { history: terminalDiscoveryHistory().map(m => JSON.parse(JSON.stringify(m).replaceAll('Task', 'Read'))) }],
  ["work in same response", { earlierCalls: [{ id: "actual_dispatch", name: "CallDynamicTool", args: { namespace: "cursor", toolName: "Task", arguments: { prompt: "inspect" } } }] }]
]) {
  test(`terminal guard leaves ${name} unchanged`, async () => {
    const r = await terminalCandidate(options);
    assert.equal(r.check(), null);
  });
}

test("terminal guard uses live background facts and fails open when unavailable", async () => {
  for (const facts of [() => true, undefined, () => { throw new Error("unavailable"); }]) {
    const r = await terminalCandidate();
    assert.equal(r.host.context.grokSwitchTerminalBlockReason?.(r.id, r.args, facts) ?? null, null);
  }
});

test("terminal guard cannot block another call with a colliding id and different arguments", async () => {
  const r = await terminalCandidate();
  const other = { ...r.args, content: "已按要求停止。" };
  assert.equal(r.host.context.grokSwitchTerminalBlockReason?.(r.id, other, () => false) ?? null, null);
});

test("terminal guard survives host schema parsing reordering fields", async () => {
  const r = await terminalCandidate();
  const parsed = { end_turn: true, content: r.args.content, type: "text" };
  assert.match(r.host.context.grokSwitchTerminalBlockReason?.(r.id, parsed, () => false) ?? "", /not sent/);
});

test("terminal guard isolates candidates from reused upstream ids and keeps all host ids aligned", async () => {
  const r = await terminalCandidate();
  assert.notEqual(r.id, "terminal_send", "unconsumed transport-blocked candidates cannot attach to a later upstream call");
  assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(r.id));
  for (const event of r.out.events.filter(e => e.type.startsWith("tool-call"))) assert.equal(event.toolCallId, r.id);
  assert.equal(r.out.response.value.messages[0].content[0].toolCallId, r.id);
  assert.equal(r.host.context.grokSwitchTerminalBlockReason("terminal_send", r.args, () => false), null);
  assert.match(r.check(), /not sent/);
});

test("terminal guard allows actual tool execution after discovery", async () => {
  const history = terminalDiscoveryHistory();
  history.push(
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "dispatch", toolName: "CallDynamicTool", args: { namespace: "cursor", toolName: "Task", arguments: { prompt: "inspect" } } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "dispatch", toolName: "CallDynamicTool", result: { success: { agentId: "test-agent" } } }] }
  );
  const r = await terminalCandidate({ history });
  assert.equal(r.check(), null);
});

// These cases exercise only the local source candidate, not a rebuilt/deployed
// payload. The audit is an opportunity to reconsider, not a completion promise.
const C6_PROGRESS = "执行子任务已启动，目标仅限 `/workspace/terminal-guard-test-C6/`；完成后我会亲自读取文件并核对行数、内容和 SHA-256，再给你最终验收结果。";
const AUDIT_MARKER = "[grok-switch-terminal-audit-once:v1]";
const auditCandidate = options => terminalCandidate({ mode: "audit-once", sourceCandidate: true, content: C6_PROGRESS, ...options });
function auditReceipt(candidate, reason) {
  assert.equal(typeof reason, "string", "the fixture requires an actual failed send reason");
  return [
    plain(candidate.out.response.value.messages[0]),
    {
      role: "tool",
      providerOptions: { cursor: { highLevelToolCallResult: { isError: true } } },
      content: [{ type: "tool-result", toolCallId: candidate.id, toolName: "SendToUser", result: "Failed to send the message to the user: " + reason }]
    }
  ];
}

for (const [name, content] of [
  ["C6 exact progress claim containing a code-formatted path", C6_PROGRESS],
  ["quoted output", "The message says ‘started’; I will report the result later."],
  ["English progress", "I have launched the worker and will report back when the checks finish."],
  ["a claimed final result", "The requested checks passed."],
  ["a blocker outcome", "I could not start: the required file is missing."]
]) {
  test(`source audit-once checks structural discovery-only ending: ${name}`, async () => {
    const r = await auditCandidate({ content });
    const reason = r.check();
    assert.equal(typeof reason, "string");
    assert.ok(reason.includes(AUDIT_MARKER + " call_id=" + r.id));
    assert.match(reason, /latest.*authoriz|latest.*instruction/i);
    assert.match(reason, /never.*(?:execute|dispatch).*satisfy.*guard/i);
    assert.equal(r.check(), null);
  });
}

test("source audit-once permits all later ending attempts after its native failed receipt", async () => {
  const first = await auditCandidate();
  const reason = first.check();
  const history = [...terminalDiscoveryHistory(), ...auditReceipt(first, reason)];
  for (const content of [C6_PROGRESS, "The input file is missing; I cannot proceed.", "Here is the explanation of the tool schema."]) {
    const next = await auditCandidate({ existingHost: first.host, history, content });
    assert.equal(next.check(), null, "one corrective audit, not an execution-enforcing loop");
    history.push(plain(next.out.response.value.messages[0]), { role: "tool", content: [{ type: "tool-result", toolCallId: next.id, toolName: "SendToUser", result: "Message sent to user." }] });
  }
});

test("source audit-once does not reset its receipt across hidden same-turn nudges", async () => {
  const first = await auditCandidate();
  const history = [...terminalDiscoveryHistory(), ...auditReceipt(first, first.check()), { role: "user", content: "[SAND_HIDDEN_PROMPT] Continue and deliver the result." }];
  const next = await auditCandidate({ existingHost: first.host, history });
  assert.equal(next.check(), null);
});

test("source audit-once retains its limit when a fresh runtime receives the native receipt", async () => {
  const first = await auditCandidate();
  const history = [...terminalDiscoveryHistory(), ...auditReceipt(first, first.check())];
  const next = await auditCandidate({ history });
  assert.equal(next.check(), null);
});

test("source audit-once emits at most one rejection for multiple terminal sends in one response", async () => {
  const args = { type: "text", content: C6_PROGRESS, end_turn: true };
  const r = await auditCandidate({ earlierCalls: [{ id: "first_terminal", name: "SendToUser", args }] });
  const sends = r.out.events.filter(e => e.type === "tool-call" && e.toolName === "SendToUser");
  assert.equal(sends.length, 2);
  const reasons = sends.map(call => r.host.context.grokSwitchTerminalBlockReason(call.toolCallId, call.args, () => false));
  assert.equal(reasons.filter(reason => typeof reason === "string").length, 1);
});

test("source audit-once preserves UUID alignment and cannot attach to reused upstream IDs", async () => {
  const r = await auditCandidate();
  assert.match(r.id, /^gs_terminal_guard_[0-9a-f]{32}$/);
  for (const event of r.out.events.filter(e => e.type.startsWith("tool-call"))) assert.equal(event.toolCallId, r.id);
  assert.equal(r.out.response.value.messages[0].content[0].toolCallId, r.id);
  assert.equal(r.host.context.grokSwitchTerminalBlockReason("terminal_send", r.args, () => false), null);
  assert.ok(r.check()?.includes(AUDIT_MARKER));
});

test("source audit-once does not apply after actual tool execution in the current turn", async () => {
  const history = [...terminalDiscoveryHistory(),
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "actual_work", toolName: "Shell", args: { command: "read sample" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "actual_work", toolName: "Shell", result: "Sample read." }] }
  ];
  assert.equal((await auditCandidate({ history })).check(), null);
});

test("source audit-once resets for a genuinely new user turn", async () => {
  const first = await auditCandidate();
  const history = [...terminalDiscoveryHistory(), ...auditReceipt(first, first.check()), ...terminalDiscoveryHistory("Now perform another requested check.")];
  const next = await auditCandidate({ existingHost: first.host, history });
  assert.ok(next.check()?.includes(AUDIT_MARKER));
  assert.notEqual(next.id, first.id);
});

for (const [name, options] of [
  ["explicit stop", { history: terminalDiscoveryHistory("先暂停，不要继续，等待我明确指令") }],
  ["explicit explanation", { history: terminalDiscoveryHistory("请解释 Task 参数，不要执行") }],
  ["English explanation", { history: terminalDiscoveryHistory("Explain the available tool schema.") }],
  ["disabled configuration", { enabled: false }],
  ["nonterminal progress", { end: false }],
  ["same-response real dispatch", { earlierCalls: [{ id: "dispatch", name: "CallDynamicTool", args: { namespace: "cursor", toolName: "Task", arguments: { prompt: "inspect" } } }] }]
]) {
  test(`source audit-once leaves ${name} unchanged`, async () => {
    assert.equal((await auditCandidate(options)).check(), null);
  });
}

test("source audit-once requires live negative background evidence", async () => {
  for (const facts of [() => true, undefined, () => { throw new Error("not available"); }]) {
    const r = await auditCandidate();
    assert.equal(r.host.context.grokSwitchTerminalBlockReason(r.id, r.args, facts), null);
  }
});

test("source audit-once does not count a candidate or transport rejection as a completed audit", async () => {
  const first = await auditCandidate();
  const history = [...terminalDiscoveryHistory(), ...auditReceipt(first, "The transport is paused.")];
  const next = await auditCandidate({ existingHost: first.host, history });
  assert.ok(next.check()?.includes(AUDIT_MARKER));
});

for (const kind of ["assistant quotation", "user quotation", "successful result", "unrelated tool", "wrong result id", "nonguard call id", "wrong marker binding"]) {
  test(`source audit-once ignores fake receipt evidence: ${kind}`, async () => {
    const first = await auditCandidate();
    const reason = first.check();
    const receipt = auditReceipt(first, reason);
    let history = terminalDiscoveryHistory();
    if (kind === "assistant quotation") receipt.splice(0, receipt.length, { role: "assistant", content: [{ type: "text", text: reason }] });
    if (kind === "user quotation") {
      history = terminalDiscoveryHistory("Run the check. A quoted log follows: " + reason);
      receipt.length = 0;
    }
    if (kind === "successful result") receipt[1].providerOptions.cursor.highLevelToolCallResult.isError = false;
    if (kind === "unrelated tool") {
      receipt[0].content[0].toolName = "GetDynamicTools";
      receipt[0].content[0].args = { namespace: "cursor", toolName: "Task" };
      receipt[1].content[0].toolName = "GetDynamicTools";
    }
    if (kind === "wrong result id") receipt[1].content[0].toolCallId = "another_call";
    if (kind === "nonguard call id") {
      receipt[0].content[0].toolCallId = "ordinary_delivery";
      receipt[1].content[0].toolCallId = "ordinary_delivery";
      receipt[1].content[0].result = receipt[1].content[0].result.replaceAll(first.id, "ordinary_delivery");
    }
    if (kind === "wrong marker binding") receipt[1].content[0].result = receipt[1].content[0].result.replaceAll(first.id, "gs_terminal_guard_00000000000000000000000000000000");
    const next = await auditCandidate({ existingHost: first.host, history: [...history, ...receipt] });
    assert.ok(next.check()?.includes(AUDIT_MARKER));
  });
}

test("source candidate keeps enabled:true legacy wording behavior unless audit-once is selected", async () => {
  const legacyMiss = await terminalCandidate({ sourceCandidate: true, content: C6_PROGRESS });
  assert.equal(legacyMiss.check(), null);
  const legacyMatch = await terminalCandidate({ sourceCandidate: true });
  const reason = legacyMatch.check();
  assert.match(reason, /not sent/);
  assert.equal(reason.includes(AUDIT_MARKER), false);
});

test("context overflow preserves host error identity and permits native compaction", async () => {
  class InputTokenLimitError extends Error {}
  for (const status of [400, 502]) {
    const files = new Map([[CONFIG_PATH, config("main", { main: OPENAI })]]);
    const host = loadHost({ files,
      classifyTokenLimitErrorFromMessage: message => message.includes("input exceeds the context window") ? new InputTokenLimitError(message) : undefined,
      fetchImpl: () => jsonFailure(status, { error: { message: "Your input exceeds the context window of this model. Please adjust your input and try again." } })
    });
    const out = await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "long history" }]).stream({}, "overflow", [], {}));
    assert.ok(out.streamError instanceof InputTokenLimitError);
    assert.equal(out.events.some(e => e.type === "text-delta"), false, "no visible output may block compaction");
    assert.equal(out.usage.error, out.streamError);
    assert.equal(out.response.error, out.streamError);
  }
});

test("without config.json every session goes to the original host inference", () => {
  const host = loadHost({ fetchImpl: () => assert.fail("fetch must not be called") });
  assert.equal(host.originalCalls.length, 1);
  const session = host.inference.createSession("rid", { requestSource: "main" });
  assert.equal(session.official, true);
  assert.equal(session.getModelId(), "grok-official", "prototype methods of the host session survive wrapping");
  assert.equal(typeof session.getExecutor, "function");
  assert.equal(host.inference.resolvePrivacyMode(), "official-privacy");
  host.inference.recordPostTurnLabeling({ a: 1 });
  assert.equal(host.labelingCalls.length, 1);
});

test("active provider streams through the adapter with auth headers and records a log line", async () => {
  const files = new Map([[CONFIG_PATH, config("main", { main: OPENAI })]]);
  const text = fs.readFileSync(path.join(FIXTURES, "openai-chat", "text.sse"), "utf8");
  const host = loadHost({ files, fetchImpl: () => sse(text) });
  const requestIds = [];
  const session = host.inference.createSession((id) => requestIds.push(id), { requestSource: "main" });
  assert.equal(session.getModelId(), "gpt-x");
  const executor = session.getExecutor([{ role: "user", content: "hi" }]);
  const out = await drain(executor.stream({ signal: undefined }, "inv-1", [], {}));

  assert.equal(out.streamError, null);
  assert.equal(host.fetches.length, 1);
  assert.equal(host.fetches[0].url, "https://api.example.com/v1/chat/completions");
  assert.equal(host.fetches[0].init.headers.authorization, "Bearer sk-secret");
  assert.equal(host.fetches[0].init.redirect, "error");
  assert.equal(host.fetches[0].body.model, "gpt-x");
  // The identity note is inserted after the host's system prompt(s), before the conversation.
  assert.deepEqual(host.fetches[0].body.messages.map((m) => m.role), ["system", "user"]);
  assert.match(host.fetches[0].body.messages[0].content, /^\[grok-switch\] .*gpt-x.*main.*grok-switch 接入/);
  assert.deepEqual(host.fetches[0].body.messages[1], { role: "user", content: "hi" });
  assert.equal(out.events.filter((e) => e.type === "text-delta").map((e) => e.textDelta).join(""), "hello world");
  assert.equal(out.usage.ok, true);
  assert.deepEqual(plain(out.usage.value), { promptTokens: 9, completionTokens: 4, totalTokens: 13 });
  assert.equal(out.response.value.modelId, "gpt-x");
  assert.deepEqual(plain(out.response.value.messages[0].content), [
    { type: "reasoning", text: "plan" },
    { type: "text", text: "hello world" }
  ]);
  assert.deepEqual(requestIds, ["req-1"]);
  assert.equal(host.labelingCalls.length, 0);
  host.inference.recordPostTurnLabeling({});
  assert.equal(host.labelingCalls.length, 0, "labeling is suppressed while external");

  const log = files.get(LOG_PATH).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].provider, "main");
  assert.equal(log[0].status, 200);
  assert.equal(log[0].kind, "main");
  assert.deepEqual(log[0].usage, { promptTokens: 9, completionTokens: 4, totalTokens: 13 });
  assert.ok(!JSON.stringify(log).includes("sk-secret"));
});

test("identity note follows existing system prompts and is skipped for probes", async () => {
  const files = new Map([[CONFIG_PATH, config("main", { main: OPENAI })]]);
  const text = fs.readFileSync(path.join(FIXTURES, "openai-chat", "text.sse"), "utf8");
  const host = loadHost({ files, fetchImpl: () => sse(text) });
  const history = [
    { role: "system", content: "You are Grok Bot." },
    { role: "system", content: "Tools: ..." },
    { role: "user", content: "你是什么模型" }
  ];
  await drain(host.inference.createSession(null, {}).getExecutor(history).stream({}, "i", [], {}));
  const roles = host.fetches[0].body.messages.map((m) => m.role);
  assert.deepEqual(roles, ["system", "system", "system", "user"]);
  assert.equal(host.fetches[0].body.messages[0].content, "You are Grok Bot.");
  assert.match(host.fetches[0].body.messages[2].content, /^\[grok-switch\]/);

  // Responses folds system messages into `instructions`; the note rides along.
  const responsesFiles = new Map([[CONFIG_PATH, config("r", { r: { ...OPENAI, protocol: "openai-responses" } })]]);
  const rHost = loadHost({ files: responsesFiles, fetchImpl: () => sse(fs.readFileSync(path.join(FIXTURES, "openai-responses", "text.sse"), "utf8")) });
  await drain(rHost.inference.createSession(null, {}).getExecutor(history).stream({}, "i", [], {}));
  assert.match(rHost.fetches[0].body.instructions, /You are Grok Bot\.\n\nTools: \.\.\.\n\n\[grok-switch\]/);

  // The CLI probe (`test`) sends the bare message so a broken provider is judged on its own.
  const probeHost = loadHost({ files, fetchImpl: () => sse(text) });
  const provider = probeHost.context.grokSwitchNormalizeProvider("main", OPENAI);
  await drain(probeHost.context.grokSwitchStream(provider, { messages: [{ role: "user", content: "OK?" }], tools: [], options: {}, requestKind: "test" }));
  assert.deepEqual(plain(probeHost.fetches[0].body.messages), [{ role: "user", content: "OK?" }]);
});

test("editing config.json between sessions switches routes without reloading", async () => {
  const files = new Map([[CONFIG_PATH, config("a", { a: OPENAI, b: { ...OPENAI, model: "other", baseUrl: "https://b.example.com" } })]]);
  const text = fs.readFileSync(path.join(FIXTURES, "openai-chat", "text.sse"), "utf8");
  const host = loadHost({ files, fetchImpl: () => sse(text) });
  await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "1" }]).stream({}, "i1", [], {}));
  files.set(CONFIG_PATH, config("b", JSON.parse(files.get(CONFIG_PATH)).providers));
  await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "2" }]).stream({}, "i2", [], {}));
  files.set(CONFIG_PATH, config(null, JSON.parse(files.get(CONFIG_PATH)).providers));
  const official = host.inference.createSession(null, {});
  assert.equal(host.fetches[0].url, "https://api.example.com/v1/chat/completions");
  assert.equal(host.fetches[1].url, "https://b.example.com/chat/completions");
  assert.equal(host.fetches[1].body.model, "other");
  assert.equal(official.official, true);
});

test("broken config.json fails the request with a readable message instead of going official", async () => {
  const files = new Map([[CONFIG_PATH, config("missing", { a: OPENAI })]]);
  const host = loadHost({ files, fetchImpl: () => assert.fail("fetch must not be called") });
  const session = host.inference.createSession(null, {});
  assert.equal(session.official, undefined);
  const out = await drain(session.getExecutor([]).stream({}, "i", [], {}));
  assert.ok(out.streamError);
  assert.match(out.streamError.message, /grok-switch: config\.json: active provider "missing" is not defined/);
  assert.equal(out.events.at(-1).type, "error");
  assert.equal(out.usage.ok, false);
  assert.match(files.get(LOG_PATH), /is not defined/);
});

test("upstream HTTP errors surface the provider's own message", async () => {
  const files = new Map([[CONFIG_PATH, config("main", { main: OPENAI })]]);
  const host = loadHost({ files, fetchImpl: () => jsonFailure(401, { error: { message: "Incorrect API key provided" } }) });
  const out = await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "x" }]).stream({}, "i", [], {}));
  assert.match(out.streamError.message, /main \(gpt-x\) HTTP 401: Incorrect API key provided/);
  const log = JSON.parse(files.get(LOG_PATH).trim());
  assert.equal(log.status, 401);
  assert.match(log.error, /Incorrect API key/);
  // Deterministic failure: visible text precedes the error so the host does not retry (and re-bill).
  assert.equal(out.events[0].type, "text-delta");
  assert.match(out.events[0].textDelta, /^⚠️ grok-switch: main .*HTTP 401/);
  assert.equal(out.events[1].type, "error");
});

test("rate limits and server errors stay retryable: no text is emitted before the error", async () => {
  for (const status of [429, 500, 503]) {
    const files = new Map([[CONFIG_PATH, config("main", { main: OPENAI })]]);
    const host = loadHost({ files, fetchImpl: () => jsonFailure(status, { error: { message: "later" } }) });
    const out = await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "x" }]).stream({}, "i", [], {}));
    assert.equal(out.events[0].type, "error", "status " + status);
    assert.match(out.streamError.message, new RegExp("HTTP " + status));
  }
});

test("shapes the protocol cannot express fail fast with visible text", async () => {
  const files = new Map([[CONFIG_PATH, config("main", { main: OPENAI })]]);
  const host = loadHost({ files, fetchImpl: () => assert.fail("no request expected") });
  const out = await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: [{ type: "video", data: "x" }] }]).stream({}, "i", [], {}));
  assert.equal(out.events[0].type, "text-delta");
  assert.match(out.events[0].textDelta, /User content is unrepresentable/);
  assert.equal(host.fetches.length, 0);
});

test("repeated failed SendMessage calls trip one visible breaker without another provider request", async () => {
  const provider = { ...OPENAI, protocol: "openai-responses", model: "gpt-5.6-sol" };
  const files = new Map([[CONFIG_PATH, config("main", { main: provider })]]);
  const host = loadHost({ files, fetchImpl: () => assert.fail("breaker must not bill the provider") });
  const failed = (id) => [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "send_message", args: { type: "text", content: "x", widget: {}, secret: {} } }]
    },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: id,
        toolName: "send_message",
        result: { error: { error: "Invalid arguments: Nothing was sent." } }
      }]
    }
  ];
  const messages = [{ role: "user", content: "hello" }, ...failed("bad-1"), ...failed("bad-2")];
  const session = host.inference.createSession(null, { requestSource: "turn" });
  const first = await drain(session.getExecutor(messages).stream({}, "breaker-inv", [], {}));
  assert.equal(first.streamError, null);
  assert.equal(host.fetches.length, 0);
  const call = first.events.find((event) => event.type === "tool-call");
  assert.equal(call.toolName, "send_message");
  assert.equal(call.args.type, "text");
  assert.match(call.args.content, /连续 2 次用无效参数调用消息工具.*已停止本轮/);
  assert.match(call.toolCallId, /^grok_switch_delivery_breaker_/);
  assert.equal(first.events.at(-1).finishReason, "tool-calls");

  const completedMessages = [
    ...messages,
    first.response.value.messages[0],
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: "send_message",
        result: { success: { timestamp: 1, messageId: "sent" } }
      }]
    }
  ];
  const second = await drain(host.inference.createSession(null, { requestSource: "turn" }).getExecutor(completedMessages).stream({}, "after-breaker", [], {}));
  assert.equal(second.streamError, null);
  assert.equal(host.fetches.length, 0);
  assert.deepEqual(plain(second.response.value.messages[0].content), []);
  assert.equal(second.events.at(-1).finishReason, "stop");
});

test("tool argument deltas reach the host only as the final normalized JSON", async () => {
  const files = new Map([[CONFIG_PATH, config("main", { main: OPENAI })]]);
  const raw = JSON.stringify({ to: "dm", type: "text", content: "hi", widget: { prompt: "?", options: [{ label: "a" }] }, secret: { label: "t", connector: "c", field: "f" } });
  const chunks = [raw.slice(0, 20), raw.slice(20, 60), raw.slice(60)];
  const stream = [
    `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "SendToUser", arguments: chunks[0] } }] } }] })}`,
    `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: chunks[1] } }] } }] })}`,
    `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: chunks[2] } }] } }] })}`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
    "data: [DONE]"
  ].join("\n\n") + "\n\n";
  const host = loadHost({ files, fetchImpl: () => sse(stream) });
  const out = await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "x" }]).stream({}, "i", [], {}));
  assert.equal(out.streamError, null);
  const types = out.events.map((e) => e.type);
  assert.deepEqual(types, ["tool-call-streaming-start", "tool-call-delta", "tool-call", "finish"]);
  const delta = out.events[1];
  const call = out.events[2];
  assert.equal(delta.toolCallId, call.toolCallId);
  assert.deepEqual(JSON.parse(delta.argsTextDelta), { to: "dm", type: "text", content: "hi" }, "the streamed text is the normalized args");
  assert.deepEqual(plain(call.args), { to: "dm", type: "text", content: "hi" });
  assert.equal(delta.argsTextDelta.includes("widget"), false);
});

test("parallel upstream tools deliver complete JSON before the host starts the next tool", async () => {
  const files = new Map([[CONFIG_PATH, config("main", { main: OPENAI })]]);
  const chunks = [
    { choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: "read_a", type: "function", function: { name: "read_file", arguments: '{"path":' } },
      { index: 1, id: "read_b", type: "function", function: { name: "read_file", arguments: '{"path":' } }
    ] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [
      { index: 1, function: { arguments: '"/tmp/b"}' } },
      { index: 0, function: { arguments: '"/tmp/a"}' } }
    ] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  ];
  const stream = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const host = loadHost({ files, fetchImpl: () => sse(stream) });
  const out = await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "read both files" }]).stream({}, "parallel", [], {}));
  assert.equal(out.streamError, null);

  // The host has one current ToolCallStream. A different start closes it,
  // causing its accumulated JSON to be parsed before later deltas can arrive.
  const executed = [];
  let current = null;
  const close = () => {
    if (current == null) return;
    executed.push({ id: current.id, args: JSON.parse(current.json) });
    current = null;
  };
  for (const event of out.events) {
    if (event.type === "tool-call-streaming-start") {
      close();
      current = { id: event.toolCallId, json: "" };
    } else if (event.type === "tool-call-delta") {
      assert.equal(current?.id, event.toolCallId);
      current.json += event.argsTextDelta;
    } else if (event.type === "tool-call") {
      assert.equal(current?.id, event.toolCallId);
      close();
    }
  }
  close();
  assert.deepEqual(executed, [
    { id: "read_a", args: { path: "/tmp/a" } },
    { id: "read_b", args: { path: "/tmp/b" } }
  ]);
});

test("host nudges ([SAND_HIDDEN_PROMPT]) do not reset the turn for loop detection", async () => {
  const files = new Map([[CONFIG_PATH, config("main", { main: OPENAI })]]);
  const host = loadHost({ files, fetchImpl: () => assert.fail("breaker must fire before any request") });
  const fail = (id) => [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "SendToUser", args: { type: "text", content: "x" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "SendToUser", result: '<cursor_untrusted_data_1337 source="SendToUser">\nFailed to send the message to the user: Invalid arguments:\nwidget: ... Nothing was sent.' }] }
  ];
  const nudge = { role: "user", content: [{ type: "text", text: "[SAND_HIDDEN_PROMPT]Your previous turn left the user without the result they're waiting on…" }] };
  const messages = [{ role: "user", content: "你是什么模型" }, ...fail("a"), nudge, ...fail("b"), nudge];
  const out = await drain(host.inference.createSession(null, { requestSource: "turn" }).getExecutor(messages).stream({}, "i", [], {}));
  assert.equal(host.fetches.length, 0);
  assert.match(out.events.find((e) => e.type === "tool-call").args.content, /连续 2 次用无效参数调用消息工具/);
});

test("consecutive tool failures trip the breaker; successful tool loops continue", async () => {
  const provider = { ...OPENAI, model: "gpt-5.6-sol" };
  const text = fs.readFileSync(path.join(FIXTURES, "openai-chat", "text.sse"), "utf8");
  const round = (id, args, result) => [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "shell", args }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "shell", result, ...(result && result.isError ? { isError: true } : {}) }] }
  ];
  const run = async (messages) => {
    const files = new Map([[CONFIG_PATH, config("main", { main: provider })]]);
    const host = loadHost({ files, fetchImpl: () => sse(text) });
    const out = await drain(host.inference.createSession(null, { requestSource: "turn" }).getExecutor(messages).stream({}, "inv", [], {}));
    return { out, host, log: (files.get(LOG_PATH) || "").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
  };

  // Three consecutive failures of an ordinary tool (the production pattern).
  let r = await run([{ role: "user", content: "go" }, ...round("a", { cmd: "ls /x" }, { isError: true, error: "no such dir" }), ...round("b", { cmd: "ls /y" }, { isError: true, error: "no such dir" }), ...round("c", { cmd: "ls /z" }, { isError: true, error: "no such dir" })]);
  assert.equal(r.host.fetches.length, 0, "no provider request once the loop is detected");
  assert.match(r.out.events.find((e) => e.type === "tool-call").args.content, /连续 3 次调用工具 shell 都失败/);
  assert.equal(r.log.at(-1).kind, "breaker");

  // Two failures then a success resets the count: the turn proceeds normally.
  r = await run([{ role: "user", content: "go" }, ...round("a", { cmd: "ls" }, { isError: true, error: "x" }), ...round("b", { cmd: "ls" }, { isError: true, error: "x" }), ...round("c", { cmd: "ls" }, "file.txt")]);
  assert.equal(r.host.fetches.length, 1);

  // Identical call repeated three times, results not flagged as errors.
  r = await run([{ role: "user", content: "go" }, ...round("a", { cmd: "date" }, "ok"), ...round("b", { cmd: "date" }, "ok"), ...round("c", { cmd: "date" }, "ok")]);
  assert.equal(r.host.fetches.length, 1, "successful repetitions must not be treated as a failed tool loop");
  assert.equal(r.log.some((entry) => entry.kind === "breaker"), false);

  // A legitimate long task: many distinct successful tool calls keep going.
  const long = [{ role: "user", content: "go" }];
  for (let i = 0; i < 30; i += 1) long.push(...round("t" + i, { cmd: "step " + i }, "done " + i));
  r = await run(long);
  assert.equal(r.host.fetches.length, 1);
});

for (const scenario of [
  { name: "changing cloud-job progress", tool: "shell", args: { cmd: "cat /tmp/progress.json" }, result: (i) => ({ exitCode: 0, stdout: JSON.stringify({ progress: i * 20 }) }) },
  { name: "unchanged cloud-job status", tool: "shell", args: { cmd: "cat /tmp/status.json" }, result: () => ({ exitCode: 0, stdout: "running" }) },
  { name: "repeated screenshots", tool: "screenshot", args: {}, result: (i) => ({ success: true, frame: i }) }
]) {
  test(`successful repeated polling continues with ${scenario.name}`, async () => {
    const files = new Map([[CONFIG_PATH, config("main", { main: OPENAI })]]);
    const text = fs.readFileSync(path.join(FIXTURES, "openai-chat", "text.sse"), "utf8");
    const host = loadHost({ files, fetchImpl: () => sse(text) });
    const messages = [{ role: "user", content: "Wait for the cloud task to finish, then report its result." }];
    for (let i = 0; i < 6; i++) {
      messages.push(
        { role: "assistant", content: [{ type: "tool-call", toolCallId: `poll_${i}`, toolName: scenario.tool, args: scenario.args }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: `poll_${i}`, toolName: scenario.tool, result: scenario.result(i) }] }
      );
    }
    const out = await drain(host.inference.createSession(null, { requestSource: "turn" }).getExecutor(messages).stream({}, "poll-next", [], {}));
    assert.equal(host.fetches.length, 1, "the next inference must reach the configured provider");
    assert.equal(out.streamError, null);
    assert.equal(out.response.ok, true);
    assert.equal(out.events.some((event) => event.type === "tool-call" && event.toolCallId.startsWith("grok_switch_delivery_breaker_")), false);
  });
}

test("anthropic providers get x-api-key, anthropic-version and a default max_tokens", async () => {
  const provider = { protocol: "anthropic-messages", baseUrl: "https://claude.example.com/", model: "claude-x", apiKey: "ak" };
  const files = new Map([[CONFIG_PATH, config("c", { c: provider })]]);
  const text = fs.readFileSync(path.join(FIXTURES, "anthropic-messages", "text.sse"), "utf8");
  const host = loadHost({ files, fetchImpl: () => sse(text) });
  const out = await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "x" }]).stream({}, "i", [], {}));
  assert.equal(out.streamError, null);
  assert.equal(host.fetches[0].url, "https://claude.example.com/messages");
  assert.equal(host.fetches[0].init.headers["x-api-key"], "ak");
  assert.equal(host.fetches[0].init.headers.authorization, undefined);
  assert.ok(host.fetches[0].init.headers["anthropic-version"]);
  assert.equal(host.fetches[0].body.max_tokens, 8192);
});

test("custom endpointPath, extra headers, query string and parameters are honoured", async () => {
  const provider = {
    ...OPENAI,
    baseUrl: "https://relay.example.com/openai?tenant=7",
    endpointPath: "/v1/custom/chat",
    headers: { "X-Team": "blue" },
    parameters: { reasoningEffort: "high", maxTokens: 321 }
  };
  const files = new Map([[CONFIG_PATH, config("p", { p: provider })]]);
  const text = fs.readFileSync(path.join(FIXTURES, "openai-chat", "text.sse"), "utf8");
  const host = loadHost({ files, fetchImpl: () => sse(text) });
  await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "x" }]).stream({}, "i", [], {}));
  assert.equal(host.fetches[0].url, "https://relay.example.com/openai/v1/custom/chat?tenant=7");
  assert.equal(host.fetches[0].init.headers["X-Team"], "blue");
  assert.equal(host.fetches[0].body.reasoning_effort, "high");
  assert.equal(host.fetches[0].body.max_tokens, 321);
});

test("provider validation rejects obviously wrong entries", () => {
  const host = loadHost({ fetchImpl: () => assert.fail() });
  const normalize = host.context.grokSwitchNormalizeProvider;
  assert.throws(() => normalize("x", { ...OPENAI, protocol: "grpc" }), /protocol must be one of/);
  assert.throws(() => normalize("x", { ...OPENAI, baseUrl: "ftp://x" }), /must be http\(s\)/);
  assert.throws(() => normalize("x", { ...OPENAI, apiKey: "" }), /apiKey is required/);
  assert.throws(() => normalize("x", { ...OPENAI, endpointPath: "relative" }), /absolute path/);
  assert.throws(() => normalize("x", { ...OPENAI, headers: { Host: "evil" } }), /not allowed/);
  assert.throws(() => normalize("x", { ...OPENAI, parameters: { temperature: 1 } }), /unknown parameter/);
  assert.equal(normalize("x", { ...OPENAI, apiKey: "", authType: "none" }).authType, "none");
});

async function chat(host, text, sessionOptions = {}) {
  const session = host.inference.createSession(null, sessionOptions);
  const executor = session.getExecutor([{ role: "user", content: [{ type: "text", text }] }]);
  return drain(executor.stream({}, "inv", [], {}));
}

test("/gs commands in chat are answered locally on both routes and edit config.json", async () => {
  const files = new Map([[CONFIG_PATH, config(null, { a: OPENAI, b: { ...OPENAI, model: "b-model" } })]]);
  const host = loadHost({ files, fetchImpl: () => assert.fail("no model call expected") });

  let out = await chat(host, "/gs status");
  assert.equal(out.streamError, null);
  const reply = out.events.filter((e) => e.type === "text-delta").map((e) => e.textDelta).join("");
  assert.match(reply, /Active: \*\*official Grok\*\*/);
  assert.match(reply, /- a — openai-chat/);
  assert.equal(out.events.at(-1).type, "finish");
  assert.equal(out.response.value.messages[0].content[0].text, reply);
  assert.equal(host.originalCalls.filter((c) => c.streamed).length, 0, "official model was not called");

  out = await chat(host, "  /GS use b");
  assert.match(out.events[0].textDelta, /Switched to \*\*b\*\*.*b-model/);
  assert.equal(JSON.parse(files.get(CONFIG_PATH)).active, "b");
  assert.deepEqual(Object.keys(JSON.parse(files.get(CONFIG_PATH)).providers), ["a", "b"], "providers preserved");

  // Now on the external route: commands still intercepted, no fetch.
  out = await chat(host, "/gs use nope");
  assert.match(out.events[0].textDelta, /No provider named `nope`.*Saved providers: a, b/);
  assert.equal(JSON.parse(files.get(CONFIG_PATH)).active, "b");

  out = await chat(host, "/gs official");
  assert.match(out.events[0].textDelta, /Switched back to \*\*official Grok\*\*/);
  assert.equal(JSON.parse(files.get(CONFIG_PATH)).active, null);

  out = await chat(host, "/gs");
  assert.match(out.events[0].textDelta, /\/gs use <name>/);

  // Ordinary messages on the official route still reach the host executor.
  out = await chat(host, "hello there");
  assert.equal(host.originalCalls.filter((c) => c.streamed).length, 1);

  // Non-main sessions (summarization etc.) never intercept.
  out = await chat(host, "/gs status", { isSummarizationSession: true });
  assert.equal(host.originalCalls.filter((c) => c.streamed).length, 2);

  out = await chat(host, "/gs status", { requestSource: "turn" });
  assert.match(out.events[0].textDelta, /Active:/, "Grok Bot 0.30 names the main request source turn");
});

test("/gs official repairs a broken active pointer", async () => {
  const files = new Map([[CONFIG_PATH, config("gone", { a: OPENAI })]]);
  const host = loadHost({ files, fetchImpl: () => assert.fail() });
  let out = await chat(host, "/gs status");
  assert.match(out.events[0].textDelta, /config\.json is broken .*Run `\/gs official`/);
  out = await chat(host, "/gs official");
  assert.match(out.events[0].textDelta, /Switched back/);
  assert.equal(host.inference.createSession(null, {}).official, true);
});

test("codex auth signs with the ChatGPT login and refreshes once on 401", async () => {
  const idToken = "h." + Buffer.from(JSON.stringify({ aud: "client-123" })).toString("base64url") + ".s";
  const auth = { auth_mode: "chatgpt", tokens: { access_token: "old-access", refresh_token: "refresh-1", id_token: idToken, account_id: "acct-9" } };
  const provider = { protocol: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", model: "gpt-5-codex", authType: "codex" };
  const files = new Map([[CONFIG_PATH, config("cx", { cx: provider })], ["/codex/auth.json", JSON.stringify(auth)]]);
  const text = fs.readFileSync(path.join(FIXTURES, "openai-responses", "text.sse"), "utf8");
  const host = loadHost({
    files,
    fetchImpl: (url, init, n) => {
      if (url === "https://auth.openai.com/oauth/token") {
        assert.equal(init.headers["content-type"], "application/x-www-form-urlencoded");
        const form = new URLSearchParams(init.body);
        assert.equal(form.get("grant_type"), "refresh_token");
        assert.equal(form.get("refresh_token"), "refresh-1");
        assert.equal(form.get("client_id"), "client-123");
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ access_token: "new-access", refresh_token: "refresh-2" }) };
      }
      if (n === 1) return jsonFailure(401, { detail: "expired" });
      return sse(text);
    }
  });
  const out = await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "hi" }]).stream({}, "i", [], {}));
  assert.equal(out.streamError, null, out.streamError && out.streamError.message);
  assert.equal(host.fetches.length, 3);
  assert.equal(host.fetches[0].url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(host.fetches[0].init.headers.authorization, "Bearer old-access");
  assert.equal(host.fetches[0].init.headers["chatgpt-account-id"], "acct-9");
  assert.equal(host.fetches[0].body.store, false);
  assert.equal(host.fetches[2].init.headers.authorization, "Bearer new-access");
  const saved = JSON.parse(files.get("/codex/auth.json"));
  assert.equal(saved.tokens.access_token, "new-access");
  assert.equal(saved.tokens.refresh_token, "refresh-2");
  assert.equal(saved.tokens.account_id, "acct-9");
  assert.ok(saved.last_refresh);

  files.delete("/codex/auth.json");
  const missing = await drain(host.inference.createSession(null, {}).getExecutor([{ role: "user", content: "hi" }]).stream({}, "i", [], {}));
  assert.match(missing.streamError.message, /Codex login not found .*codex login/);
});

// ---------------------------------------------------------------------------
// ctx-compact wiring: the engine, its call site, and the request kinds it must
// leave alone, all driven through the real fetch boundary rather than by poking
// the engine directly.
// ---------------------------------------------------------------------------
const COMPACT_LEDGER = "/workspace/grok-switch/ctx-compact-ledger.json";
const COMPACT_SETTINGS = { enabled: true, mode: "apply", thresholdChars: 1000, freshHeadChars: 200, freshTailChars: 80, protectRecentMessages: 1, errorExempt: true, ledgerMaxEntries: 20000, ledgerRefreshMs: 3600000 };
function compactConfig(over = {}) {
  return JSON.stringify({ active: "main", providers: { main: OPENAI }, contextCompact: { ...COMPACT_SETTINGS, ...over } });
}
const BIG_TOOL_TEXT = "Q".repeat(50000);
function compactHistory() {
  return [
    { role: "user", content: "run it" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_q", toolName: "run_terminal_command_v2", args: { cmd: "cat big.log" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call_q", toolName: "run_terminal_command_v2", result: BIG_TOOL_TEXT }] }
  ];
}
const toolOnWire = (body) => body.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_q");
const CHAT_SSE = fs.readFileSync(path.join(FIXTURES, "openai-chat", "text.sse"), "utf8");

test("context capacity reaches both finish events and host usage promises without becoming an output limit", async () => {
  const files = new Map([[CONFIG_PATH, config("main", { main: { ...OPENAI, contextWindowTokens: 1000000 } })]]);
  const host = loadHost({ files, fetchImpl: () => sse(CHAT_SSE) });
  for (const sessionOptions of [{ requestSource: "turn" }, { isSummarizationSession: true }]) {
    const result = host.inference.createSession(null, sessionOptions).getExecutor([{ role: "user", content: "fixture" }]).stream({}, "capacity", [], {});
    const out = await drain(result);
    assert.equal(out.streamError, null);
    assert.equal((await result.extendedUsage).maxTokens, 1000000);
    assert.equal(out.events.find(e => e.type === "finish").extendedUsage.maxTokens, 1000000);
  }
  for (const request of host.fetches) {
    assert.equal(request.body.contextWindowTokens, undefined);
    assert.equal(request.body.max_tokens, undefined, "input capacity must not change output budget");
  }
  const rows = files.get(LOG_PATH).trim().split("\n").map(JSON.parse);
  assert.ok(rows.every(row => row.contextWindowTokens === 1000000));
});

test("context capacity is validated and not inferred from a model name", () => {
  const { context: c } = loadHost();
  for (const invalid of [0, -1, 1.5, "1000000", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => c.grokSwitchNormalizeProvider("bad", { ...OPENAI, contextWindowTokens: invalid }), /contextWindowTokens/);
  }
  assert.equal(c.grokSwitchNormalizeProvider("unknown", OPENAI).contextWindowTokens, undefined);
});

test("ctx-compact never folds a host summarization session's history", async () => {
  const files = new Map([[CONFIG_PATH, compactConfig()]]);
  const host = loadHost({ files, fetchImpl: () => sse(CHAT_SSE) });
  const out = await drain(host.inference.createSession(null, { isSummarizationSession: true }).getExecutor(compactHistory()).stream({}, "i-sum", [], {}));
  assert.equal(out.streamError, null);
  assert.equal(host.fetches.length, 1);
  const tool = toolOnWire(host.fetches[0].body);
  assert.ok(tool, "the tool result reached the wire");
  assert.equal(tool.content, BIG_TOOL_TEXT, "a summary request carries the raw history");
  assert.ok(!JSON.stringify(host.fetches[0].body).includes("folded here to save context"), "no fold marker in a summary request");
  assert.equal(files.get(COMPACT_LEDGER), undefined, "a summary request records nothing");

  // The same history on a main request does fold, which proves the history was
  // eligible and the summary kind is what suppressed it.
  await drain(host.inference.createSession(null, { requestSource: "main" }).getExecutor(compactHistory()).stream({}, "i-main", [], {}));
  const mainTool = toolOnWire(host.fetches[1].body);
  assert.match(mainTool.content, /folded here to save context/, "a main request folds the same history");
});

test("ctx-compact folds a fresh tool result once and then replays the recorded shape", async () => {
  const files = new Map([[CONFIG_PATH, compactConfig()]]);
  const host = loadHost({ files, fetchImpl: () => sse(CHAT_SSE) });
  const provider = host.context.grokSwitchNormalizeProvider("main", OPENAI);
  const stream = () => host.context.grokSwitchStream(provider, { messages: compactHistory(), tools: [], options: {}, requestKind: "main" });

  await drain(stream());
  const first = toolOnWire(host.fetches[0].body);
  assert.equal(typeof first.content, "string");
  assert.equal(first.content.split("folded here to save context").length - 1, 1, "exactly one fold marker on the first send");
  const ledgerA = JSON.parse(files.get(COMPACT_LEDGER));
  assert.equal(Object.keys(ledgerA).length, 1, "one ledger record");
  assert.equal(Object.values(ledgerA)[0].shape, "folded");

  await drain(stream());
  const second = toolOnWire(host.fetches[1].body);
  assert.equal(second.content, first.content, "the replay is byte-identical to the first fold");
  assert.equal(second.content.split("folded here to save context").length - 1, 1, "still exactly one fold marker");
  const ledgerB = JSON.parse(files.get(COMPACT_LEDGER));
  assert.equal(Object.keys(ledgerB).length, 1, "the second request folded nothing new");
  assert.deepEqual(Object.keys(ledgerB), Object.keys(ledgerA), "the ledger key did not move");

  const logs = files.get(LOG_PATH).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(logs.length, 2);
  assert.equal(logs[0].compact.mode, "apply");
  assert.equal(logs[0].compact.version, 5, "the shipped engine stamps v4.1 as version 5");
  assert.equal(logs[0].compact.folded, 1, "the first request folded once");
  assert.equal(logs[0].compact.frozen, 0, "the first request replayed nothing");
  assert.ok(logs[0].compact.savedChars > 0, "the first request measured a saving");
  assert.equal(logs[1].compact.folded, 0, "the second request folds nothing");
  assert.equal(logs[1].compact.frozen, 1, "the second request replays the recorded shape");
  assert.equal(logs[1].compact.savedChars, logs[0].compact.savedChars, "the replay avoids exactly the bytes the first fold avoided");
});

test("an uncertain ledger commit prevents a provider request instead of silently sending raw history", () => {
  const host = loadHost({ files: new Map([[CONFIG_PATH, compactConfig()]]), fetchImpl: () => sse(CHAT_SSE) });
  host.context.grokSwitchCompactMessages = () => { throw Object.assign(new Error('uncertain ledger commit'), { code: 'GROK_SWITCH_COMPACT_COMMIT_UNCERTAIN' }); };
  const provider = host.context.grokSwitchNormalizeProvider('main', OPENAI);
  assert.throws(() => host.context.grokSwitchStream(provider, { messages: compactHistory(), tools: [], options: {}, requestKind: 'main' }), { code: 'GROK_SWITCH_COMPACT_COMMIT_UNCERTAIN' });
  assert.equal(host.fetches.length, 0);
});

test("ctx-compact records entry.compact only when the engine actually ran", async () => {
  const files = new Map([[CONFIG_PATH, compactConfig()]]);
  const host = loadHost({ files, fetchImpl: () => sse(CHAT_SSE) });
  const provider = host.context.grokSwitchNormalizeProvider("main", OPENAI);
  await drain(host.context.grokSwitchStream(provider, { messages: compactHistory(), tools: [], options: {}, requestKind: "main" }));
  const logged = JSON.parse(files.get(LOG_PATH).trim().split("\n")[0]);
  assert.ok(logged.compact, "entry.compact is recorded");
  assert.equal(logged.compact.mode, "apply");
  assert.equal(logged.compact.version, 5, "the shipped engine stamps v4.1 as version 5");
  assert.equal(typeof logged.compact.savedChars, "number");

  const offFiles = new Map([[CONFIG_PATH, compactConfig({ enabled: false })]]);
  const offHost = loadHost({ files: offFiles, fetchImpl: () => sse(CHAT_SSE) });
  const offProvider = offHost.context.grokSwitchNormalizeProvider("main", OPENAI);
  await drain(offHost.context.grokSwitchStream(offProvider, { messages: compactHistory(), tools: [], options: {}, requestKind: "main" }));
  const offLogged = JSON.parse(offFiles.get(LOG_PATH).trim().split("\n")[0]);
  assert.equal(offLogged.compact, undefined, "a disabled engine records no entry.compact");

  // An ineligible history is a no-op that is still measured, not a crash.
  const smallFiles = new Map([[CONFIG_PATH, compactConfig()]]);
  const smallHost = loadHost({ files: smallFiles, fetchImpl: () => sse(CHAT_SSE) });
  const smallProvider = smallHost.context.grokSwitchNormalizeProvider("main", OPENAI);
  await drain(smallHost.context.grokSwitchStream(smallProvider, { messages: [{ role: "user", content: "hi" }], tools: [], options: {}, requestKind: "main" }));
  const smallLogged = JSON.parse(smallFiles.get(LOG_PATH).trim().split("\n")[0]);
  assert.equal(smallLogged.compact.parts, 0, "an ineligible history folds nothing");
});

test("payload parses under strict mode and defines no unexpected globals in the host scope", () => {
  const host = loadHost({ fetchImpl: () => assert.fail() });
  const names = Object.keys(host.context).filter((n) => /^(grokSwitch|GROK_SWITCH|__grokSwitch|createHostInference)/.test(n) === false);
  // Everything we injected is namespaced; the remaining names are the harness's own.
  const injected = Object.keys(host.context).filter((n) => !names.includes(n));
  assert.ok(injected.includes("createHostInference"));
  assert.ok(injected.every((n) => /^(grokSwitch|GROK_SWITCH|__grokSwitch|createHostInference$)/.test(n)));
});

test("a tool result with no id no longer kills the turn: the part is dropped and the turn goes out", async () => {
  const files = new Map([[CONFIG_PATH, config("main", { main: OPENAI })]]);
  const host = loadHost({ files, fetchImpl: () => sse(CHAT_SSE) });
  const provider = host.context.grokSwitchNormalizeProvider("main", OPENAI);
  const out = await drain(host.context.grokSwitchStream(provider, {
    messages: [{ role: "tool", content: [{ type: "tool-result", toolName: "Read", result: "this result lost its id" }] }],
    tools: [],
    options: {},
    requestKind: "chat"
  }));
  // The part has no id, so it can never be paired with a call; the host also
  // stored nothing else in this message. That used to fail the whole turn.
  assert.equal(host.fetches.length, 1, "the request leaves: the rest of the turn is deliverable");
  const sent = host.fetches[0].body.messages;
  assert.ok(sent.some((m) => m.role === "system"), "the request still carries the turn's own messages");
  assert.ok(
    sent.every((m) => m.role !== "tool"),
    "no tool message survives for a part that had no call: " + JSON.stringify(sent)
  );
  assert.ok(!JSON.stringify(sent).includes("this result lost its id"), "the unpaired part never reaches the provider");
  assert.ok(!out.events.some((event) => event.type === "error"), "the turn is no longer an error");
});

// The shapes that really cannot be expressed stay fatal, and stay visible: a
// tool result whose own content the protocol cannot represent still fails the
// turn before it is sent, so the host does not retry it three times and re-bill
// the provider for a turn that can never produce output.
test("an unrepresentable tool result content is still fatal and still visible", async () => {
  const files = new Map([[CONFIG_PATH, config("main", { main: OPENAI })]]);
  const host = loadHost({ files, fetchImpl: () => assert.fail("no request expected") });
  const provider = host.context.grokSwitchNormalizeProvider("main", OPENAI);
  const out = await drain(host.context.grokSwitchStream(provider, {
    messages: [{
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_x", toolName: "Read", result: "x", experimental_content: [{ type: "video", data: "zzz" }] }]
    }],
    tools: [],
    options: {},
    requestKind: "chat"
  }));
  assert.equal(host.fetches.length, 0, "the request never leaves the process");
  assert.equal(out.events[0].type, "text-delta", "a forever-failing shape must be visible: " + JSON.stringify(out.events[0]));
  assert.match(out.events[0].textDelta, /⚠️/, "the operator sees the warning marker");
  assert.equal(out.events[1].type, "error", "and the error still follows");
  assert.equal(out.streamError.grokSwitchFatal, undefined, "fatal is a classification, not a flag on the error");
});
