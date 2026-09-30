// ---------------------------------------------------------------------------
// [ctx-compact v3] Cache-first compaction: fold a large tool result exactly
// once, on the request that carries it upstream for the very first time, and
// then replay that shape byte for byte forever.
//
// Why the first send is the only thing worth touching: bytes that already went
// upstream are served from the provider prefix cache at roughly 1/cacheDiscount
// of the miss price, so folding them later saves almost nothing, while moving
// the edit point re-bills everything after it at full price. Bytes that were
// never sent are billed at full price, so folding them before they leave this
// process is where the money is.
//
// A large result that was already on the wire when this patch first saw it is
// left exactly as it is. Rewriting history is never worth the invalidation.
//
// v2 -> v3, four fixes to that promise:
//   1. fail-closed: a new fold is only kept if its ledger record was durably
//      written. An unrecorded fold cannot be replayed on the next request, so
//      it would flip bytes; if the write fails the fold is reverted.
//   2. merge-on-save: re-read the ledger before writing so a concurrent
//      request cannot erase records that were just persisted.
//   3. pruning inverted: a lost full record is harmless (raw is the default
//      shape) while a lost folded record flips already-sent bytes, so full
//      goes first and entries seen in this request are pinned.
//   4. keepHeadChars/keepTailChars were dead code and are no longer read.
var GROK_SWITCH_COMPACT_CACHE_DIR = GROK_SWITCH_DIR + "/ctx-cache";
var GROK_SWITCH_COMPACT_LEDGER_PATH = GROK_SWITCH_DIR + "/ctx-compact-ledger.json";
var GROK_SWITCH_COMPACT_DEFAULTS = {
  enabled: false,
  mode: "dry-run",
  thresholdChars: 60000,
  // Legacy v1 keys, accepted so an existing config.json still loads, but they
  // shape nothing: a fold is head/tail of freshHeadChars/freshTailChars when
  // it is first sent, and is frozen from then on.
  keepHeadChars: 4000,
  keepTailChars: 1500,
  freshHeadChars: 8000,
  freshTailChars: 4000,
  protectRecentMessages: 6,
  errorExempt: true,
  ledgerMaxEntries: 20000,
  ledgerRefreshMs: 3600000
};

function grokSwitchCompactConfig() {
  var text = grokSwitchReadConfigText();
  if (text == null) return null;
  var raw;
  try { raw = JSON.parse(text); } catch (_cfgErr) { return null; }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  var section = raw.contextCompact;
  if (section == null || typeof section !== "object" || Array.isArray(section)) return null;
  var out = {};
  var key;
  for (key in GROK_SWITCH_COMPACT_DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(GROK_SWITCH_COMPACT_DEFAULTS, key)) out[key] = GROK_SWITCH_COMPACT_DEFAULTS[key];
  }
  for (key in section) {
    if (Object.prototype.hasOwnProperty.call(out, key)) out[key] = section[key];
  }
  return out;
}

function grokSwitchContentDigest(text) {
  var nodeCrypto = require("node:crypto");
  return nodeCrypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function grokSwitchCompactLedgerLoad() {
  try {
    var cfs = grokSwitchFs();
    if (!cfs.existsSync(GROK_SWITCH_COMPACT_LEDGER_PATH)) return {};
    var raw = cfs.readFileSync(GROK_SWITCH_COMPACT_LEDGER_PATH, "utf8");
    var parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (_ledgerRead) {
    return {};
  }
}

function grokSwitchCompactLedgerSave(ledger, opts, seen) {
  try {
    var cfs = grokSwitchFs();
    // Merge what is on disk right now: a concurrent request may have recorded
    // shapes since this process loaded its copy, and dropping those records
    // would flip bytes that already went upstream.
    var onDisk = grokSwitchCompactLedgerLoad();
    var mergeKey;
    for (mergeKey in onDisk) {
      if (Object.prototype.hasOwnProperty.call(onDisk, mergeKey)
        && !Object.prototype.hasOwnProperty.call(ledger, mergeKey)) {
        ledger[mergeKey] = onDisk[mergeKey];
      }
    }
    var pinned = seen == null ? {} : seen;
    var keys = Object.keys(ledger);
    var max = Number(opts.ledgerMaxEntries) || 0;
    if (max > 0 && keys.length > max) {
      keys.sort(function (a, b) {
        // Delete order is the inverse of what has to survive. Pinned entries
        // were observed in this very request, so they are in active use; then
        // full entries go first because losing one changes nothing (raw is
        // the default shape); then oldest first.
        var ap = pinned[a] === true ? 1 : 0;
        var bp = pinned[b] === true ? 1 : 0;
        if (ap !== bp) return ap - bp;
        var af = ledger[a] && ledger[a].shape === "full" ? 0 : 1;
        var bf = ledger[b] && ledger[b].shape === "full" ? 0 : 1;
        if (af !== bf) return af - bf;
        return (ledger[a] && ledger[a].t ? ledger[a].t : 0) - (ledger[b] && ledger[b].t ? ledger[b].t : 0);
      });
      var drop = keys.length - max;
      for (var i = 0; i < drop; i += 1) delete ledger[keys[i]];
    }
    // Crash-safe: a torn ledger would flip already-sent shapes back to raw.
    var tmp = GROK_SWITCH_COMPACT_LEDGER_PATH + ".tmp";
    cfs.writeFileSync(tmp, JSON.stringify(ledger), { mode: 384 });
    cfs.renameSync(tmp, GROK_SWITCH_COMPACT_LEDGER_PATH);
    return true;
  } catch (_ledgerWrite) {
    return false;
  }
}
var GROK_SWITCH_COMPACT_ERROR_TOKENS = [
  "error", "exception", "traceback", "fatal", "failed", "failure",
  "stack trace", "errno", "panic:", "permission denied", "command not found"
];

function grokSwitchLooksLikeError(text) {
  var probe = text.length > 6000 ? text.slice(0, 3000) + "\n" + text.slice(text.length - 3000) : text;
  var lower = probe.toLowerCase();
  for (var i = 0; i < GROK_SWITCH_COMPACT_ERROR_TOKENS.length; i += 1) {
    if (lower.indexOf(GROK_SWITCH_COMPACT_ERROR_TOKENS[i]) >= 0) return true;
  }
  return false;
}

// Deterministic: identical input and identical head/tail always produce
// identical output, which is what makes a folded shape safe to replay forever.
// The full text is written aside once and referenced by path.
function grokSwitchFoldToolText(text, head, tail, opts, stats) {
  if (typeof text !== "string") return null;
  head = Number(head) || 0;
  tail = Number(tail) || 0;
  if (head < 0) head = 0;
  if (tail < 0) tail = 0;
  if (text.length <= head + tail + 200) return null;
  var dropped = text.length - head - tail;
  var file = GROK_SWITCH_COMPACT_CACHE_DIR + "/" + grokSwitchContentDigest(text) + ".txt";
  var dryRun = opts.mode !== "apply";
  if (!dryRun) {
    try {
      var cfs = grokSwitchFs();
      cfs.mkdirSync(GROK_SWITCH_COMPACT_CACHE_DIR, { recursive: true, mode: 448 });
      if (!cfs.existsSync(file)) cfs.writeFileSync(file, text, { mode: 384 });
    } catch (_foldWrite) {}
  }
  stats.parts += 1;
  stats.savedChars += dropped;
  // dry-run measures the counterfactual saving without rewriting a single byte.
  if (dryRun) return null;
  var marker = "\n\n[grok-switch: " + dropped + " characters of intermediate tool output folded here to save context; full text saved at " + file + "]\n\n";
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

function grokSwitchCompactMessages(messages, opts) {
  var stats = { mode: opts.mode, version: 3, parts: 0, savedChars: 0, folded: 0, frozen: 0, errorExempt: 0, ledger: 0 };
  if (messages == null || !Array.isArray(messages) || opts.enabled !== true) {
    return { messages: messages, stats: stats };
  }
  var apply = opts.mode === "apply";
  var threshold = Number(opts.thresholdChars) || 0;
  if (threshold <= 0) threshold = Infinity;
  var protect = Number(opts.protectRecentMessages);
  if (!(protect >= 0)) protect = 0;
  var freshLimit = messages.length - protect;
  var freshHead = Number(opts.freshHeadChars) || 0;
  var freshTail = Number(opts.freshTailChars) || 0;
  var ledger = apply ? grokSwitchCompactLedgerLoad() : {};
  var ledgerDirty = false;
  var seen = {};
  // A new fold stays provisional until the ledger write succeeds: an
  // unrecorded fold would be re-decided (to raw) next request, moving bytes.
  var pending = [];
  var pendingSaved = 0;
  var pendingParts = 0;
  var refreshMs = Number(opts.ledgerRefreshMs) || 0;
  var now = Date.now();
  var out = null;
  for (var i = 0; i < messages.length; i += 1) {
    var m = messages[i];
    if (m == null || typeof m !== "object" || m.role !== "tool" || !Array.isArray(m.content)) continue;
    var inFresh = i >= freshLimit;
    var parts = null;
    for (var j = 0; j < m.content.length; j += 1) {
      var part = m.content[j];
      if (part == null || typeof part !== "object") continue;
      var type = part.type;
      if (type !== "tool-result" && type !== "tool_result") continue;
      var result = part.result;
      if (typeof result !== "string" || result.length < threshold) continue;
      if (!apply) {
        // Measurement only: report what the same policy would fold, change nothing.
        if (inFresh) grokSwitchFoldToolText(result, freshHead, freshTail, opts, stats);
        continue;
      }
      var hash = grokSwitchContentDigest(result);
      var entry = ledger[hash];
      // Never seen before: only the fresh window can still be shaped. Anything
      // that was already upstream before this patch saw it keeps its bytes.
      if ((entry == null || typeof entry !== "object") && !inFresh) continue;
      if (entry != null && typeof entry === "object") {
        stats.ledger += 1;
        seen[hash] = true;
        if (entry.shape === "folded") {
          // Replay with the parameters that were recorded, not with today's
          // config: a config edit must not move bytes that were already sent.
          var replay = grokSwitchFoldToolText(result, Number(entry.h) || freshHead, Number(entry.tl) || freshTail, opts, stats);
          if (replay != null) {
            if (parts == null) parts = m.content.slice();
            parts[j] = Object.assign({}, part, { result: replay });
            stats.frozen += 1;
          }
        }
        if (refreshMs > 0 && now - (Number(entry.t) || 0) > refreshMs) {
          entry.t = now;
          ledgerDirty = true;
        }
        continue;
      }
      if (opts.errorExempt !== false && grokSwitchLooksLikeError(result)) {
        ledger[hash] = { shape: "full", n: result.length, t: now, why: "error" };
        ledgerDirty = true;
        stats.errorExempt += 1;
        continue;
      }
      var beforeSaved = stats.savedChars;
      var beforeParts = stats.parts;
      var folded = grokSwitchFoldToolText(result, freshHead, freshTail, opts, stats);
      if (folded == null) continue;
      ledger[hash] = { shape: "folded", h: freshHead, tl: freshTail, n: result.length, t: now, why: "first-send" };
      ledgerDirty = true;
      stats.folded += 1;
      if (parts == null) parts = m.content.slice();
      parts[j] = Object.assign({}, part, { result: folded });
      pending.push({ hash: hash, parts: parts, index: j, original: part });
      pendingSaved += stats.savedChars - beforeSaved;
      pendingParts += stats.parts - beforeParts;
    }
    if (parts != null) {
      if (out == null) out = messages.slice();
      out[i] = Object.assign({}, m, { content: parts });
    }
  }
  if (apply && ledgerDirty) {
    if (!grokSwitchCompactLedgerSave(ledger, opts, seen)) {
      // Fail closed: without a durable record the fold cannot be replayed, so
      // it must not be sent. Replays of recorded shapes stay applied.
      for (var q = 0; q < pending.length; q += 1) {
        pending[q].parts[pending[q].index] = pending[q].original;
        delete ledger[pending[q].hash];
      }
      stats.folded = 0;
      stats.savedChars -= pendingSaved;
      stats.parts -= pendingParts;
      stats.ledgerWriteFailed = 1;
    }
  }
  return { messages: out == null ? messages : out, stats: stats };
}
