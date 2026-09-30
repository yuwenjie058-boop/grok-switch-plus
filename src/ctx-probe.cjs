// ---------------------------------------------------------------------------
// [ctx-probe] Request-body profile. Metadata only: counts and character sizes
// per message role / content-part type. Never records message text.
var GROK_SWITCH_PROFILE_PATH = GROK_SWITCH_DIR + "/ctx-profile.jsonl";
var GROK_SWITCH_PROFILE_MAX_BYTES = 8 * 1024 * 1024;

function grokSwitchPartChars(part) {
  if (part == null || typeof part !== "object") return 0;
  var n = 0;
  if (typeof part.text === "string") n += part.text.length;
  if (typeof part.result === "string") { n += part.result.length; }
  else if (part.result != null) { try { n += JSON.stringify(part.result).length; } catch (_e1) {} }
  if (typeof part.args === "string") { n += part.args.length; }
  else if (part.args != null) { try { n += JSON.stringify(part.args).length; } catch (_e2) {} }
  if (typeof part.content === "string") n += part.content.length;
  if (part.experimental_content != null) { try { n += JSON.stringify(part.experimental_content).length; } catch (_e3) {} }
  if (n === 0) { try { n = JSON.stringify(part).length; } catch (_e4) { n = 0; } }
  return n;
}

function grokSwitchAppendProfile(entry, messages) {
  if (!Array.isArray(messages)) return;
  var byRole = {};
  var byType = {};
  var totalChars = 0;
  var systemChars = 0;
  var imageParts = 0;
  var imageChars = 0;
  var reasoningChars = 0;
  var toolResultChars = 0;
  var biggest = [];
  for (var i = 0; i < messages.length; i += 1) {
    var m = messages[i];
    if (m == null || typeof m !== "object") continue;
    var role = typeof m.role === "string" ? m.role : "?";
    var chars = 0;
    var c = m.content;
    if (typeof c === "string") {
      chars = c.length;
      byType[role + ":string"] = (byType[role + ":string"] || 0) + chars;
    } else if (Array.isArray(c)) {
      for (var j = 0; j < c.length; j += 1) {
        var part = c[j];
        if (part == null || typeof part !== "object") continue;
        var t = typeof part.type === "string" ? part.type : "?";
        var pc = grokSwitchPartChars(part);
        chars += pc;
        byType[role + ":" + t] = (byType[role + ":" + t] || 0) + pc;
        if (t === "image" || t === "image_url") { imageParts += 1; imageChars += pc; }
        if (t === "reasoning") reasoningChars += pc;
        if (t === "tool-result" || t === "tool_result") toolResultChars += pc;
      }
    }
    byRole[role] = (byRole[role] || 0) + chars;
    if (role === "system") systemChars += chars;
    totalChars += chars;
    if (chars > 2000) biggest.push([role, chars]);
  }
  biggest.sort(function (a, b) { return b[1] - a[1]; });
  var profile = {
    ts: entry.ts,
    kind: entry.kind,
    model: entry.model,
    messages: messages.length,
    totalChars: totalChars,
    systemChars: systemChars,
    imageParts: imageParts,
    imageChars: imageChars,
    reasoningChars: reasoningChars,
    toolResultChars: toolResultChars,
    promptTokens: entry.usage != null ? entry.usage.promptTokens : null,
    cacheReadTokens: entry.cacheReadTokens || 0,
    cacheWriteTokens: entry.cacheWriteTokens || 0,
    byRole: byRole,
    byType: byType,
    biggest: biggest.slice(0, 8)
  };
  var fs = grokSwitchFs();
  try {
    if (fs.statSync(GROK_SWITCH_PROFILE_PATH).size > GROK_SWITCH_PROFILE_MAX_BYTES) {
      fs.renameSync(GROK_SWITCH_PROFILE_PATH, GROK_SWITCH_PROFILE_PATH + ".1");
    }
  } catch (_stat) {}
  fs.appendFileSync(GROK_SWITCH_PROFILE_PATH, JSON.stringify(profile) + "\n", { mode: 384 });
}
