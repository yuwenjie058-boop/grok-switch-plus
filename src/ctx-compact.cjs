// ---------------------------------------------------------------------------
// [ctx-compact v4.1] Cache-first compaction: fold a large tool result exactly
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
//
// v3 -> v4, three fixes. Nothing about the cache-first promise changes.
//   1. type bug (the reason v3 never saved a single character): the host hands
//      this layer part.result as a *parsed object* -- fromRedactedToolMessage
//      does JSON.parse(resultStr) -- while v3 only accepted
//      `typeof result === "string"`. Every real tool result was skipped, so
//      savedChars stayed 0 forever. v4 folds the big string leaves *inside* an
//      object result and leaves the result an object, so the host's parsed
//      shape survives untouched.
//   2. order-stable identity: v3 identified a value by digest(JSON.stringify),
//      so rebuilding the same object with a different key order produced a
//      different hash and flipped the fold state (raw <-> folded). Objects are
//      now keyed by an order-independent digest (sorted keys, byte-length
//      framed, no escaping needed) and a folded object is re-emitted with
//      sorted keys, so the replayed shape is byte-stable no matter how the host
//      rebuilds it.
//   3. string results behave exactly as in v3: same predicate, same digest,
//      same fold, same ledger records. Only object results change.
//
// v4 -> v4.1, five fixes, all of them about the *numbers* rather than the fold.
// The cache-first promise and the folded bytes are unchanged.
//   1. dry-run now applies the same error-exemption predicate as apply. It used
//      to fold an error-looking *text* result into the measurement while apply
//      exempted it, so the dry run promised savings apply would refuse. That is
//      the number an operator reads before flipping to apply.
//   2. dry-run counts `objects` (it only ever incremented in the fold path, so
//      the field was always 0 in the one mode that actually runs today).
//   3. dry-run refuses to measure a value apply cannot fold: a value whose
//      order-stable digest cannot be computed (cycle, BigInt/function leaf,
//      nesting deeper than the digest's walk) is no longer counted as savings.
//      Measured on v4: a self-referencing value was reported as 24x its real
//      size, and a 33-deep value was reported as foldable when apply skips it.
//   4. the scan detects cycles while it walks, so the inflation is not even
//      computed. `stats.unstable` / `stats.unhashable` / `stats.guardHold` say
//      why a candidate was refused instead of silently dropping it.
//   5. the refusal checks run in the same order in both modes. They did not at
//      first, and the tests caught it: apply refuses a value the moment the
//      digest comes back null, before it looks at the error flag or the guard,
//      while the dry run was asking about the error flag first - so one BigInt
//      value was counted as `guardHold` in dry-run and `unhashable` in apply.
//      Same zero savings either way, different explanation, and an explanation
//      an operator cannot trust is worse than no explanation. The guard is also
//      computed lazily now: serializing a 20 MB result is only worth doing for a
//      candidate that would otherwise be folded.
//
// Not changed, on purpose: the terminal guard. v4.1 must not fold away anything
// grokSwitchTaskDiscoveredOnly reads back. It cannot: that guard matches
// /"tool"\s*:\s*"Task"/ and /"inputSchema"\s*:/ against JSON.stringify(result),
// and measured against the real guard function (see tests) the verdict is
// identical before and after a fold. Object keys survive a fold verbatim, a
// "Task" value is 4 bytes and never foldable, and a pattern made of raw quotes
// can never occur *inside* a JSON string value because JSON.stringify escapes
// them. `grokSwitchCompactGuardHold` still refuses the fold when the serialized
// result carries those tokens or the failure phrases grokSwitchHasFailureValue
// looks for, because a folded leaf could otherwise drop one of those phrases and
// change which results the guard skips.
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
  // Object results (the shape the host actually produces) are foldable. Set
  // false to fall back to v3's string-only behaviour without reinstalling.
  objectResults: true,
  ledgerMaxEntries: 20000,
  ledgerRefreshMs: 3600000
};

// v4.1: these two were already dead in v3 and stay accepted so an existing
// config.json still loads, but the no-op is now named instead of silent and is
// reported back through `stats.ignoredKeys`, so an operator who set them finds
// out rather than assuming they shape the fold. A first send is shaped by
// freshHeadChars/freshTailChars and is frozen from then on; there is nothing
// left for a second pair of head/tail numbers to do.
var GROK_SWITCH_COMPACT_LEGACY_NOOP_KEYS = ["keepHeadChars", "keepTailChars"];

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
  var ignored = [];
  for (var legacyIndex = 0; legacyIndex < GROK_SWITCH_COMPACT_LEGACY_NOOP_KEYS.length; legacyIndex += 1) {
    var legacyKey = GROK_SWITCH_COMPACT_LEGACY_NOOP_KEYS[legacyIndex];
    if (Object.prototype.hasOwnProperty.call(section, legacyKey)) ignored.push(legacyKey);
  }
  out.__legacyKeysIgnored = ignored;
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

function grokSwitchCompactLedgerSave(ledger, opts, seen, expected) {
  var cfs = grokSwitchFs();
  var lock = GROK_SWITCH_COMPACT_LEDGER_PATH + ".lock";
  var locked = false;
  var tmp = null;
  var fd = null;
  var renamed = false;
  try {
    cfs.mkdirSync(GROK_SWITCH_DIR, { recursive: true, mode: 448 });
    // Cooperating writers serialize the check and replacement. Never reclaim an
    // ambiguous stale lock automatically: an operator must first stop writers.
    cfs.mkdirSync(lock, { mode: 448 });
    locked = true;
    // Merge what is on disk right now: a concurrent request may have recorded
    // shapes since this process loaded its copy, and dropping those records
    // would flip bytes that already went upstream.
    var onDisk = {};
    try {
      onDisk = JSON.parse(cfs.readFileSync(GROK_SWITCH_COMPACT_LEDGER_PATH, "utf8"));
      if (onDisk == null || typeof onDisk !== "object" || Array.isArray(onDisk)) return false;
    } catch (readError) {
      if (readError.code !== "ENOENT") return false;
    }
    // A different process may have committed after this request loaded its
    // snapshot. Decline new folds instead of overwriting its shape decisions.
    if (expected != null && JSON.stringify(onDisk) !== expected) return false;
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
    tmp = GROK_SWITCH_COMPACT_LEDGER_PATH + ".tmp." + require("node:crypto").randomBytes(12).toString("hex");
    cfs.writeFileSync(tmp, JSON.stringify(ledger), { mode: 384, flag: "wx" });
    fd = cfs.openSync(tmp, "r+");
    cfs.fsyncSync(fd);
    cfs.closeSync(fd);
    fd = null;
    cfs.renameSync(tmp, GROK_SWITCH_COMPACT_LEDGER_PATH);
    renamed = true;
    tmp = null;
    // Directory flushing is supported by our production Linux target. Windows
    // provides atomic replacement/file flushing but is not certified for power loss.
    if (process.platform !== "win32") {
      fd = cfs.openSync(GROK_SWITCH_DIR, "r");
      cfs.fsyncSync(fd);
      cfs.closeSync(fd);
      fd = null;
    }
    return true;
  } catch (_ledgerWrite) {
    if (renamed) {
      // New bytes may already be visible. Sending raw now and replaying folded
      // bytes next time would be inconsistent; let the host report an error.
      var uncertain = new Error("grok-switch: ledger replacement could not be confirmed durable; inspect storage before retrying");
      uncertain.code = "GROK_SWITCH_COMPACT_COMMIT_UNCERTAIN";
      throw uncertain;
    }
    return false;
  } finally {
    if (fd != null) { try { cfs.closeSync(fd); } catch (_closeLedger) {} }
    if (tmp != null) { try { cfs.unlinkSync(tmp); } catch (_unlinkLedger) {} }
    if (locked) { try { cfs.rmdirSync(lock); } catch (_unlockLedger) {} }
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

// A marker may promise a recoverable original only after verified, atomic
// storage. Check old files too: earlier versions could leave a partial file.
function grokSwitchStoreCompactOriginal(file, text) {
  var cfs = grokSwitchFs();
  var tmp = null;
  var fd = null;
  try {
    try {
      if (cfs.readFileSync(file, "utf8") === text) return true;
    } catch (_missing) {}
    cfs.mkdirSync(GROK_SWITCH_COMPACT_CACHE_DIR, { recursive: true, mode: 448 });
    tmp = file + "." + require("node:crypto").randomBytes(12).toString("hex") + ".tmp";
    cfs.writeFileSync(tmp, text, { encoding: "utf8", mode: 384, flag: "wx" });
    fd = cfs.openSync(tmp, "r+");
    cfs.fsyncSync(fd);
    cfs.closeSync(fd);
    fd = null;
    if (cfs.readFileSync(tmp, "utf8") !== text) throw new Error("incomplete compact original");
    cfs.renameSync(tmp, file);
    tmp = null;
    // Windows does not support opening directories this way. Production Linux
    // also persists the directory entry before any folded ledger is committed.
    if (process.platform !== "win32") {
      fd = cfs.openSync(GROK_SWITCH_COMPACT_CACHE_DIR, "r");
      cfs.fsyncSync(fd);
      cfs.closeSync(fd);
      fd = null;
    }
    return cfs.readFileSync(file, "utf8") === text;
  } catch (_storeFailure) {
    return false;
  } finally {
    if (fd != null) { try { cfs.closeSync(fd); } catch (_close) {} }
    if (tmp != null) { try { cfs.unlinkSync(tmp); } catch (_unlink) {} }
  }
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
  if (!dryRun && !grokSwitchStoreCompactOriginal(file, text)) {
    stats.storageWriteFailed = (stats.storageWriteFailed || 0) + 1;
    return null;
  }
  stats.parts += 1;
  stats.savedChars += dropped;
  // dry-run measures the counterfactual saving without rewriting a single byte.
  if (dryRun) return null;
  var marker = "\n\n[grok-switch: " + dropped + " characters of intermediate tool output folded here to save context; full text saved at " + file + "]\n\n";
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

// --- object results ---------------------------------------------------------
// A real tool result does not arrive here as text: the host parses the result
// string back into a value (fromRedactedToolMessage -> JSON.parse), so the
// provider call sees structured tool output. Folding therefore has to happen
// *inside* the value -- shorten the big string leaves, leave every other key and
// every type exactly where it was, and hand back an object.

// Order-independent identity for a JSON value. Every string is framed with its
// UTF-8 byte length, so the byte stream stays unambiguous without any escaping,
// and object keys are visited in sorted order, so the same object rebuilt with
// a different key order hashes identically. That stability is what lets a
// folded shape replay byte for byte.
function grokSwitchStableDigest(value) {
  var nodeCrypto = require("node:crypto");
  var hash = nodeCrypto.createHash("sha256");
  if (!grokSwitchStableFeed(hash, value, [], 0)) return null;
  return hash.digest("hex").slice(0, 16);
}

function grokSwitchStableFeed(hash, value, stack, depth) {
  if (depth > 32) return false;
  if (value === null) { hash.update("z"); return true; }
  var type = typeof value;
  if (type === "string") {
    hash.update("s" + Buffer.byteLength(value, "utf8") + ":");
    hash.update(value, "utf8");
    return true;
  }
  if (type === "number") { hash.update("n" + (isFinite(value) ? String(value) : "nan") + ";"); return true; }
  if (type === "boolean") { hash.update(value ? "t" : "f"); return true; }
  if (type === "undefined") { hash.update("u"); return true; }
  if (type !== "object") return false;
  for (var s = 0; s < stack.length; s += 1) {
    if (stack[s] === value) return false;
  }
  stack.push(value);
  var ok = true;
  if (Array.isArray(value)) {
    hash.update("a" + value.length + "[");
    for (var i = 0; i < value.length && ok; i += 1) {
      ok = grokSwitchStableFeed(hash, value[i], stack, depth + 1);
      hash.update(",");
    }
    hash.update("]");
  } else {
    var keys = Object.keys(value).sort();
    hash.update("o" + keys.length + "{");
    for (var k = 0; k < keys.length && ok; k += 1) {
      hash.update("k" + Buffer.byteLength(keys[k], "utf8") + ":");
      hash.update(keys[k], "utf8");
      hash.update("=");
      ok = grokSwitchStableFeed(hash, value[keys[k]], stack, depth + 1);
      hash.update(";");
    }
    hash.update("}");
  }
  stack.pop();
  return ok;
}

// Allocation-free scan: how many characters live in string leaves, and how much
// would folding them save? This runs on every part of every request, so it must
// not build the JSON text. It is a lower bound on what a fold can reach.
var GROK_SWITCH_COMPACT_SCAN_NODE_BUDGET = 200000;
var GROK_SWITCH_COMPACT_SCAN_DEPTH = 24;

// `stack` holds the ancestors of the current node only, so a value reachable by
// two different paths (a shared subtree) is measured once per path - which is
// what JSON.stringify does too - while a value that is its own ancestor (a
// cycle) is refused. Without this, a self-referencing value was counted once per
// level down to the depth cap: measured on v4, 24x the real figure.
function grokSwitchCompactScanNode(value, leafMin, head, tail, state, depth, stack) {
  if (state.overflow || state.unstable || depth > GROK_SWITCH_COMPACT_SCAN_DEPTH) return;
  state.nodes += 1;
  if (state.nodes > GROK_SWITCH_COMPACT_SCAN_NODE_BUDGET) { state.overflow = true; return; }
  if (value == null) return;
  var type = typeof value;
  if (type === "string") {
    state.leafChars += value.length;
    if (value.length >= leafMin && value.length > head + tail + 200) {
      state.foldable += 1;
      state.saved += value.length - head - tail;
    }
    return;
  }
  if (type !== "object") return;
  for (var s = 0; s < stack.length; s += 1) {
    if (stack[s] === value) { state.unstable = true; return; }
  }
  stack.push(value);
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length && !state.overflow && !state.unstable; i += 1) {
      grokSwitchCompactScanNode(value[i], leafMin, head, tail, state, depth + 1, stack);
    }
    stack.pop();
    return;
  }
  var keys = Object.keys(value);
  for (var k = 0; k < keys.length && !state.overflow && !state.unstable; k += 1) {
    grokSwitchCompactScanNode(value[keys[k]], leafMin, head, tail, state, depth + 1, stack);
  }
  stack.pop();
}

function grokSwitchCompactScan(value, leafMin, head, tail) {
  var state = { nodes: 0, leafChars: 0, foldable: 0, saved: 0, overflow: false, unstable: false };
  grokSwitchCompactScanNode(value, leafMin, head, tail, state, 0, []);
  return state;
}

// Structured results carry their own failure signal, which is both cheaper and
// more accurate than probing 6 KB of text for the word "error": a shell result
// that merely mentions an error somewhere in 25 MB of output is not an error
// report the model needs verbatim. Plain strings keep using
// grokSwitchLooksLikeError above.
function grokSwitchCompactStructuredError(part, value) {
  if (part != null && part.isError === true) return true;
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.isError === true) return true;
  if (value.failure != null) return true;
  if (value.success === false) return true;
  return false;
}

// Folding an object is deterministic in the strong sense: identical input and
// identical head/tail/leafMin always produce an identical value, key order
// included (sorted), so the shape can be replayed byte for byte forever. The
// full value is written aside once, as JSON, and referenced by path.
function grokSwitchCompactFoldValue(value, file, ctx, path, depth) {
  if (depth > GROK_SWITCH_COMPACT_SCAN_DEPTH) return value;
  if (value == null) return value;
  var type = typeof value;
  if (type === "string") {
    if (value.length >= ctx.leafMin && value.length > ctx.head + ctx.tail + 200) {
      var dropped = value.length - ctx.head - ctx.tail;
      ctx.folded += 1;
      ctx.saved += dropped;
      var marker = "\n\n[grok-switch: " + dropped + " characters of " + path
        + " folded here to save context; full tool result saved at " + file + "]\n\n";
      return value.slice(0, ctx.head) + marker + value.slice(value.length - ctx.tail);
    }
    return value;
  }
  if (type !== "object") return value;
  if (Array.isArray(value)) {
    var items = new Array(value.length);
    for (var i = 0; i < value.length; i += 1) {
      items[i] = grokSwitchCompactFoldValue(value[i], file, ctx, path + "[" + i + "]", depth + 1);
    }
    return items;
  }
  var keys = Object.keys(value).sort();
  var out = {};
  for (var k = 0; k < keys.length; k += 1) {
    out[keys[k]] = grokSwitchCompactFoldValue(value[keys[k]], file, ctx, path + "." + keys[k], depth + 1);
  }
  return out;
}

// digest must be the order-independent digest of value: it names the cache file
// and, from there, the ledger record that freezes this shape.
function grokSwitchFoldToolObject(value, head, tail, leafMin, opts, stats, digest) {
  head = Number(head) || 0;
  tail = Number(tail) || 0;
  if (head < 0) head = 0;
  if (tail < 0) tail = 0;
  leafMin = Number(leafMin) || 0;
  var ctx = { head: head, tail: tail, leafMin: leafMin, folded: 0, saved: 0 };
  var file = GROK_SWITCH_COMPACT_CACHE_DIR + "/" + digest + ".json";
  var folded = grokSwitchCompactFoldValue(value, file, ctx, "result", 0);
  if (ctx.folded === 0) return null;
  if (opts.mode === "apply" && !grokSwitchStoreCompactOriginal(file, JSON.stringify(value))) {
    stats.storageWriteFailed = (stats.storageWriteFailed || 0) + 1;
    return null;
  }
  stats.parts += ctx.folded;
  stats.savedChars += ctx.saved;
  stats.objects += 1;
  return folded;
}

// v4.1: the terminal guard runs *after* this layer and re-reads tool results.
// grokSwitchRegisterTerminalCandidate -> grokSwitchTaskDiscoveredOnly matches
// /"tool"\s*:\s*"Task"/ and /"inputSchema"\s*:/ against the JSON.stringify of a
// tool result, and grokSwitchHasFailureValue matches
// /invalid arguments|nothing was sent|not delivered/i against its string values.
// A fold shortens string leaves, so this layer proves the tokens are absent
// before it shortens anything: refusing a fold is cheap, silently changing a
// guard verdict is not.
//
// Measured against the real guard (tests/check-ctx-compact-v4.mjs, section T):
// the verdict is identical before and after a fold, in both the structural shape
// ({tools:[{tool:"Task",inputSchema:{...}}]}) and the double-encoded shape
// (the schema text inside a big string leaf), because object keys survive a fold
// verbatim, a "Task" value is 4 bytes and never foldable, and a pattern made of
// raw quotes can never occur *inside* a JSON string value - JSON.stringify
// escapes them. The failure phrases, by contrast, can sit inside a leaf, so the
// check is kept for them.
var GROK_SWITCH_COMPACT_GUARD_PATTERNS = [/"tool"\s*:\s*"Task"/, /"inputSchema"\s*:/];
var GROK_SWITCH_COMPACT_GUARD_FAILURE = /invalid arguments|nothing was sent|not delivered/i;

function grokSwitchCompactGuardHold(value) {
  var text;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch (_guardSerialize) {
      // Unserializable (a cycle): this layer cannot prove the fold is safe, so
      // it does not fold. apply refuses on the digest anyway.
      return true;
    }
  }
  if (text == null) return true;
  for (var i = 0; i < GROK_SWITCH_COMPACT_GUARD_PATTERNS.length; i += 1) {
    if (GROK_SWITCH_COMPACT_GUARD_PATTERNS[i].test(text)) return true;
  }
  if (GROK_SWITCH_COMPACT_GUARD_FAILURE.test(text)) return true;
  return false;
}

// Select recorded parameters once so eligibility and replay use the same shape.
// Zero is a valid frozen head/tail; only missing or invalid values fall back.
function grokSwitchCompactReplayShape(entry, fresh) {
  if (entry == null || typeof entry !== "object" || entry.shape !== "folded") return fresh;
  var head = Number(entry.h);
  var tail = Number(entry.tl);
  var leafMin = Number(entry.lm);
  return {
    head: head >= 0 ? head : fresh.head,
    tail: tail >= 0 ? tail : fresh.tail,
    leafMin: leafMin >= 0 ? leafMin : fresh.leafMin
  };
}

function grokSwitchCompactMessages(messages, opts) {
  var stats = {
    mode: opts.mode, version: 5, parts: 0, savedChars: 0, folded: 0, frozen: 0,
    errorExempt: 0, ledger: 0, objects: 0, guardHold: 0, unhashable: 0, unstable: 0
  };
  // v4.1: a legacy key the config still sets is named in the log rather than
  // read and ignored in silence.
  var legacyIgnored = opts.__legacyKeysIgnored;
  if (Array.isArray(legacyIgnored) && legacyIgnored.length > 0) stats.ignoredKeys = legacyIgnored.join(",");
  if (messages == null || !Array.isArray(messages) || opts.enabled !== true) {
    return { messages: messages, stats: stats };
  }
  var apply = opts.mode === "apply";
  var errorExemptOn = opts.errorExempt !== false;
  var threshold = Number(opts.thresholdChars) || 0;
  if (threshold <= 0) threshold = Infinity;
  var protect = Number(opts.protectRecentMessages);
  if (!(protect >= 0)) protect = 0;
  var freshLimit = messages.length - protect;
  var freshHead = Number(opts.freshHeadChars) || 0;
  var freshTail = Number(opts.freshTailChars) || 0;
  var freshShape = { head: freshHead, tail: freshTail, leafMin: threshold };
  var ledger = apply ? grokSwitchCompactLedgerLoad() : {};
  var ledgerSnapshot = apply ? JSON.stringify(ledger) : null;
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
  // Lazy count of recorded object shapes: -1 means "not counted yet". Without a
  // single one of them a historical object result can only ever be re-sent raw,
  // so it never needs hashing.
  var ledgerObjectShapes = -1;
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
      var isText = typeof result === "string";
      var isObject = !isText && result != null && typeof result === "object";
      if (isObject && opts.objectResults === false) continue;
      if (!isText && !isObject) continue;
      if (isObject && !inFresh) {
        if (ledgerObjectShapes < 0) {
          ledgerObjectShapes = 0;
          for (var ledgerKey in ledger) {
            if (Object.prototype.hasOwnProperty.call(ledger, ledgerKey)
              && ledger[ledgerKey] != null
              && ledger[ledgerKey].k === "object"
              // v4.1: a `full` object record (error or guard-hold) is not a
              // folded shape, so it must not turn this optimization off
              // forever: only a folded object shape needs the hashing.
              && ledger[ledgerKey].shape === "folded") ledgerObjectShapes += 1;
          }
        }
        if (ledgerObjectShapes === 0) continue;
      }
      // Bound object work before replay identity hashing. This scan must not
      // filter on today's fold eligibility: the recorded policy may differ.
      var scan = isObject ? grokSwitchCompactScan(result, threshold, freshHead, freshTail) : null;
      if (scan != null) {
        if (scan.overflow) continue;
        if (scan.unstable) { stats.unstable += 1; continue; }
        if (scan.leafChars === 0) continue;
      }
      // Today's candidate settings govern first sends only. Look up the record
      // before filtering, or a config edit can silently unfold an old result.
      // Text retains the v3 digest; objects use the order-independent digest.
      var hash = apply ? (isText ? grokSwitchContentDigest(result) : grokSwitchStableDigest(result)) : null;
      var entry = hash == null ? null : ledger[hash];
      var shape = grokSwitchCompactReplayShape(entry, freshShape);
      var replaying = shape !== freshShape;
      if (isText) {
        if (result.length < threshold && !replaying) continue;
      } else {
        if (replaying) scan = grokSwitchCompactScan(result, shape.leafMin, shape.head, shape.tail);
        if (scan.overflow || scan.foldable === 0) continue;
        if (scan.unstable) {
          // A cycle. v4.1 refuses to measure it instead of counting the same
          // leaf once per level down to the depth cap.
          stats.unstable += 1;
          continue;
        }
      }
      // Computed lazily: the guard serializes the whole value, so it is only
      // worth paying for on a candidate this layer would otherwise fold.
      var guardHold = null;
      var held = function () {
        if (guardHold === null) guardHold = grokSwitchCompactGuardHold(result);
        return guardHold;
      };
      if (!apply) {
        // Measurement only: report what the same policy would fold, change nothing.
        // v4.1: the predicates below are apply's predicates, in apply's order.
        // They used to differ - an error-looking *text* result was measured as
        // savings while apply exempted it, and an object whose digest cannot be
        // computed was measured while apply skipped it - so the dry run promised
        // more than apply would deliver, in the very number an operator reads
        // before flipping the switch.
        if (inFresh) {
          if (isText) {
            if (errorExemptOn && grokSwitchLooksLikeError(result)) {
              stats.errorExempt += 1;
            } else if (held()) {
              stats.guardHold += 1;
            } else {
              grokSwitchFoldToolText(result, freshHead, freshTail, opts, stats);
            }
          } else if (grokSwitchStableDigest(result) == null) {
            // apply refuses the moment the digest comes back null, before it
            // looks at anything else, so the dry run has to refuse in the same
            // place or the two modes disagree about which counter a candidate
            // lands in (a BigInt value is the easy way to see it: it is neither
            // hashable nor serializable, so the two checks both "apply").
            stats.unhashable += 1;
          } else if (errorExemptOn && grokSwitchCompactStructuredError(part, result)) {
            stats.errorExempt += 1;
          } else if (held()) {
            stats.guardHold += 1;
          } else {
            // v4.1: `objects` used to be incremented only inside the fold, so it
            // was always 0 in dry run - the one mode that actually runs.
            stats.objects += 1;
            stats.parts += scan.foldable;
            stats.savedChars += scan.saved;
          }
        }
        continue;
      }
      if (hash == null) { stats.unhashable += 1; continue; }
      // Never seen before: only the fresh window can still be shaped. Anything
      // that was already upstream before this patch saw it keeps its bytes.
      if ((entry == null || typeof entry !== "object") && !inFresh) continue;
      if (entry != null && typeof entry === "object") {
        stats.ledger += 1;
        seen[hash] = true;
        if (entry.shape === "folded") {
          // Replay with the parameters that were recorded, not with today's
          // config: a config edit must not move bytes that were already sent.
          var replay;
          if (isText) {
            replay = grokSwitchFoldToolText(result, shape.head, shape.tail, opts, stats);
          } else {
            replay = grokSwitchFoldToolObject(result, shape.head, shape.tail, shape.leafMin, opts, stats, hash);
          }
          if (replay != null) {
            if (parts == null) parts = m.content.slice();
            parts[j] = Object.assign({}, part, { result: replay });
            stats.frozen += 1;
          } else {
            // A deleted/unrecoverable original cannot support the old promise.
            // Send raw evidence and retire the stale folded ledger entry.
            entry = ledger[hash] = { shape: "full", t: now, why: "storage-unavailable" };
            ledgerDirty = true;
          }
        }
        if (refreshMs > 0 && now - (Number(entry.t) || 0) > refreshMs) {
          entry.t = now;
          ledgerDirty = true;
        }
        continue;
      }
      if (errorExemptOn) {
        if (isText && grokSwitchLooksLikeError(result)) {
          ledger[hash] = { shape: "full", n: result.length, t: now, why: "error" };
          ledgerDirty = true;
          stats.errorExempt += 1;
          continue;
        }
        if (!isText && grokSwitchCompactStructuredError(part, result)) {
          ledger[hash] = { shape: "full", n: scan.leafChars, t: now, why: "error", k: "object" };
          ledgerDirty = true;
          stats.errorExempt += 1;
          continue;
        }
      }
      if (held()) {
        // v4.1: never fold a value whose serialized form carries a token the
        // terminal guard reads back. Recorded as full so the decision sticks and
        // every later request replays it raw, exactly like an exemption.
        ledger[hash] = isText
          ? { shape: "full", n: result.length, t: now, why: "guard-hold" }
          : { shape: "full", n: scan.leafChars, t: now, why: "guard-hold", k: "object" };
        ledgerDirty = true;
        stats.guardHold += 1;
        continue;
      }
      var beforeSaved = stats.savedChars;
      var beforeParts = stats.parts;
      var folded;
      if (isText) {
        folded = grokSwitchFoldToolText(result, freshHead, freshTail, opts, stats);
      } else {
        folded = grokSwitchFoldToolObject(result, freshHead, freshTail, threshold, opts, stats, hash);
      }
      if (folded == null) continue;
      if (isText) {
        ledger[hash] = { shape: "folded", h: freshHead, tl: freshTail, n: result.length, t: now, why: "first-send" };
      } else {
        ledger[hash] = { shape: "folded", h: freshHead, tl: freshTail, lm: threshold, n: scan.leafChars, t: now, why: "first-send", k: "object" };
      }
      ledgerDirty = true;
      stats.folded += 1;
      if (parts == null) parts = m.content.slice();
      parts[j] = Object.assign({}, part, { result: folded });
      pending.push({ hash: hash, parts: parts, index: j, original: part, saved: stats.savedChars - beforeSaved, count: stats.parts - beforeParts });
      pendingSaved += stats.savedChars - beforeSaved;
      pendingParts += stats.parts - beforeParts;
    }
    if (parts != null) {
      if (out == null) out = messages.slice();
      out[i] = Object.assign({}, m, { content: parts });
    }
  }
  if (apply && ledgerDirty) {
    if (!grokSwitchCompactLedgerSave(ledger, opts, seen, ledgerSnapshot)) {
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
    } else {
      // Capacity pruning can evict a provisional shape in the same request.
      // Only shapes whose records survived are allowed onto the wire.
      for (var p = 0; p < pending.length; p += 1) {
        var item = pending[p];
        if (ledger[item.hash] == null) {
          item.parts[item.index] = item.original;
          stats.folded -= 1;
          stats.savedChars -= item.saved;
          stats.parts -= item.count;
          stats.capacityHeld = (stats.capacityHeld || 0) + 1;
        }
      }
    }
  }
  return { messages: out == null ? messages : out, stats: stats };
}
