// Opt-in, conservative incident guard. This is NOT a general completion judge.
// Legacy mode rejects a discovery-only Task turn's explicit started/later promise.
// audit-once instead offers one neutral structural check, not guaranteed work.
// Live background state is checked by the host immediately BEFORE delivery.
var grokSwitchTerminalCandidates = new Map();
var GROK_SWITCH_TERMINAL_GUARD_ERROR = "Invalid arguments: this message was not sent and the turn remains open. Nothing was sent. Task discovery returned its schema; it did not start work. No running background work is recorded. Perform the authorized work or actually dispatch Task before claiming it has started. If the request is explanatory, cancelled, or blocked, report that actual outcome instead. Do not repeat this progress promise.";
var GROK_SWITCH_TERMINAL_AUDIT_MARKER = "[grok-switch-terminal-audit-once:v1]";
var GROK_SWITCH_TERMINAL_AUDIT_ERROR = "Invalid arguments: this message was not sent and the turn remains open. Nothing was sent. Task discovery returned a schema; it did not dispatch a task. No running background work is recorded. Reconsider this ending once under the latest user instructions and authorization. If execution is still requested, do the authorized work or dispatch an appropriate task. If the latest request is cancellation, explanation, or the work is blocked, report that actual outcome. Never execute or dispatch work merely to satisfy this guard. This audit is not an instruction to keep working against the user's wishes.";

function grokSwitchTerminalGuardMode() {
  try {
    var text = grokSwitchFs().readFileSync(GROK_SWITCH_DIR + "/terminal-guard.json", "utf8");
    if (text.length >= 4096) return null;
    var config = JSON.parse(text);
    if (config.enabled !== true) return null;
    return config.mode === "audit-once" ? "audit-once" : "legacy";
  } catch (_error) {
    return null;
  }
}

function grokSwitchTerminalGuardEnabled() {
  return grokSwitchTerminalGuardMode() !== null;
}

// Trust only a host-recorded failed delivery result, joined to its generated
// call UUID and ID-bound marker. Quoted prose and unrelated tools are not an
// audit receipt. The limit depends on retaining this native current-turn
// history; truncation or a restart that loses the receipt can allow a new audit.
function grokSwitchTerminalAuditSeen(messages) {
  var calls = new Set();
  for (var i = grokSwitchCurrentTurnStart(messages); i < messages.length; i += 1) {
    var message = messages[i];
    var parts = grokSwitchMessageParts(message);
    for (var j = 0; j < parts.length; j += 1) {
      var part = parts[j];
      if (part == null) continue;
      var id = grokSwitchPartToolId(part);
      var name = part.toolName || part.name;
      if (message.role === "assistant" && (part.type === "tool-call" || part.type === "tool_call")) {
        if (/^gs_terminal_guard_[0-9a-f]{32}$/.test(id || "") && grokSwitchIsDeliveryToolName(name) && part.args != null && part.args.type === "text" && part.args.end_turn === true) calls.add(id);
      } else if (message.role === "tool" && (part.type === "tool-result" || part.type === "tool_result") && calls.has(id)) {
        if (name != null && !grokSwitchIsDeliveryToolName(name)) continue;
        var native = message.providerOptions != null && message.providerOptions.cursor != null ? message.providerOptions.cursor.highLevelToolCallResult : null;
        if (part.isError !== true && (native == null || native.isError !== true)) continue;
        var encoded = typeof part.result === "string" ? part.result : JSON.stringify(part.result);
        if (typeof encoded === "string" && encoded.includes(GROK_SWITCH_TERMINAL_AUDIT_MARKER + " call_id=" + id)) return true;
      }
    }
  }
  return false;
}

function grokSwitchTerminalPromise(text) {
  if (typeof text !== "string" || text.length > 600) return false;
  // Ambiguous, quoted, explanatory and terminal/blocked language fails open.
  if (/[“”‘’"`]|例如|比如|解释|原因|未能|尚未|没有|失败|阻塞|暂停|停止|等待你|等待您|需要你|需要您/.test(text)) return false;
  return /(?:已经|已)开始/.test(text)
    && /(?:完成|结束|有结果)后[^。！？\n]{0,24}(?:回报|汇报|告知|告诉)/.test(text);
}

function grokSwitchTaskDiscoveredOnly(messages) {
  var start = grokSwitchCurrentTurnStart(messages);
  var user = start > 0 ? grokSwitchLastUserText([messages[start - 1]]) : "";
  if (/先暂停|先停|停工|不要继续|不要执行|等我|等待我|先不急|解释|只读|仅查看|^(?:stop|pause|explain)\b/i.test(user || "")) return false;
  var discoveries = new Set();
  var confirmed = false;
  for (var i = start; i < messages.length; i += 1) {
    var message = messages[i];
    var parts = grokSwitchMessageParts(message);
    for (var j = 0; j < parts.length; j += 1) {
      var part = parts[j];
      if (part == null) continue;
      var name = part.toolName || part.name;
      var id = grokSwitchPartToolId(part);
      if (message.role === "assistant" && (part.type === "tool-call" || part.type === "tool_call")) {
        if (grokSwitchIsDeliveryToolName(name)) continue;
        if (name !== "GetDynamicTools" && name !== "GetMcpTools" && name !== "get_mcp_tools") return false;
        var args = part.args || {};
        if ((args.namespace || args.server) === "cursor" && args.toolName === "Task" && id != null) discoveries.add(id);
      } else if (message.role === "tool" && (part.type === "tool-result" || part.type === "tool_result") && discoveries.has(id)) {
        var result = part.result;
        if (part.isError === true || grokSwitchHasFailureValue(result, 0)) continue;
        // Match a returned schema, not a model-written success assertion.
        var encoded = typeof result === "string" ? result : JSON.stringify(result);
        if (typeof encoded === "string" && /"tool"\s*:\s*"Task"/.test(encoded) && /"inputSchema"\s*:/.test(encoded)) confirmed = true;
      }
    }
  }
  return confirmed;
}

function grokSwitchRegisterTerminalCandidate(messages, call, precedingCalls) {
  if (!grokSwitchIsDeliveryToolName(call.toolName) || call.args == null || call.args.type !== "text" || call.args.end_turn !== true) return;
  var mode = grokSwitchTerminalGuardMode();
  if (mode == null) return;
  if (mode === "audit-once" ? grokSwitchTerminalAuditSeen(messages) : !grokSwitchTerminalPromise(call.args.content)) return;
  // A response can emit several final sends before a failed result is added to
  // history. Only its first generated audit candidate may request correction.
  if (mode === "audit-once" && precedingCalls.some(function (earlier) {
    return grokSwitchIsDeliveryToolName(earlier.toolName) && /^gs_terminal_guard_[0-9a-f]{32}$/.test(earlier.toolCallId || "");
  })) return;
  if (precedingCalls.some(function (earlier) { return !grokSwitchIsDeliveryToolName(earlier.toolName); })) return;
  if (!grokSwitchTaskDiscoveredOnly(messages)) return;
  // Upstream ids are not globally unique. This private id is emitted consistently
  // in host start/delta/call and persisted response; a stale candidate can never
  // attach to a later call reusing the provider's id in another turn/session.
  call.toolCallId = "gs_terminal_guard_" + crypto.randomUUID().replace(/-/g, "");
  while (grokSwitchTerminalCandidates.size >= 128) grokSwitchTerminalCandidates.delete(grokSwitchTerminalCandidates.keys().next().value);
  grokSwitchTerminalCandidates.set(call.toolCallId, {
    mode: mode,
    signature: grokSwitchTerminalSignature(call.args),
    expires: Date.now() + 300000
  });
}

function grokSwitchTerminalSignature(args) {
  // Zod may reorder object keys or strip unused optional fields in the host.
  return grokSwitchHash(JSON.stringify([args.type, args.content, args.end_turn, args.reply_to || null, args.to || null]));
}

function grokSwitchTerminalBlockReason(toolCallId, rawArgs, hasRunningBackgroundWork) {
  var candidate = grokSwitchTerminalCandidates.get(toolCallId);
  grokSwitchTerminalCandidates.delete(toolCallId);
  if (candidate == null || candidate.expires < Date.now() || grokSwitchTerminalGuardMode() !== candidate.mode) return null;
  if (rawArgs == null || candidate.signature !== grokSwitchTerminalSignature(rawArgs)) return null;
  // Never infer absence of work from an unavailable/changed host callback.
  try {
    if (typeof hasRunningBackgroundWork !== "function" || hasRunningBackgroundWork() !== false) return null;
  } catch (_error) {
    return null;
  }
  grokSwitchAppendLog({ ts: new Date().toISOString(), kind: "terminal-guard", status: 0, ms: 0, reason: candidate.mode === "audit-once" ? "task-discovery-audit-once" : "task-discovery-without-dispatch" });
  if (candidate.mode === "audit-once") return GROK_SWITCH_TERMINAL_AUDIT_ERROR + " " + GROK_SWITCH_TERMINAL_AUDIT_MARKER + " call_id=" + toolCallId;
  return GROK_SWITCH_TERMINAL_GUARD_ERROR;
}
