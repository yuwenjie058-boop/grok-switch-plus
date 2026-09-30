// grok-switch command line. build.mjs appends this after the injectable
// payload (adapters + runtime.cjs), so grokSwitch* functions are in scope.
// This part is never injected into the host bundle.

var cliFs = require("node:fs");
var cliPath = require("node:path");
var cliChildProcess = require("node:child_process");

var CLI_VERSION = "__GROK_SWITCH_VERSION__";
var CLI_HOST_PATH = process.env.GROK_SWITCH_HOST || "/home/box/sand-host/host-main.cjs";
var CLI_HOST_VERSION_PATH = cliPath.join(cliPath.dirname(CLI_HOST_PATH), "version");
var CLI_BACKUP_PATH = CLI_HOST_PATH + ".grok-switch.orig";
var CLI_SUPERVISOR_DIR = process.env.GROK_SWITCH_SUPERVISOR_DIR || "/tmp/sand-supervisor";
var CLI_PROC_ROOT = process.env.GROK_SWITCH_PROC || "/proc";
var CLI_CONFIG_DIR = GROK_SWITCH_DIR;
var CLI_CONFIG_PATH = GROK_SWITCH_CONFIG_PATH;
var CLI_LOG_PATH = GROK_SWITCH_LOG_PATH;

var CLI_PAYLOAD_BEGIN = "// GROK_SWITCH_PAYLOAD_BEGIN";
var CLI_PAYLOAD_END = "// GROK_SWITCH_PAYLOAD_END";
var CLI_PATCH_BEGIN = "// GROK_SWITCH_BEGIN";
var CLI_PATCH_END = "// GROK_SWITCH_END";
var CLI_HOST_FACTORY = "function createHostInference(";
var CLI_RENAMED_FACTORY = "function __grokSwitchOriginalCreateHostInference(";
var CLI_JOURNAL_GUARD = "previousTurn != null && !bytesEqual(previousTurn.userMessage, currentTurn.userMessage)";
var CLI_JOURNAL_COMPAT = "/* GROK_SWITCH_JOURNAL_TIMESTAMPS */ previousTurn != null && !bytesEqual(previousTurn.userMessage, currentTurn.userMessage) && !(await grokSwitchJournalUserMessagesEqual(ctx, blobStore, previousTurn.userMessage, currentTurn.userMessage))";
// The compat patch decodes a UserMessage and normalizes only its timing fields,
// so the stock bundle must keep declaring those fields on the UserMessage
// protobuf. Newer bundles write the schema positionally
// (["UserMessage|1 text 9|...|25 started_at_ms 4?|26 completed_at_ms 4?|...",
// ...]) instead of as `name: "started_at_ms"`, so these anchors match that
// descriptor string instead of a bare substring. `started_at_ms` also occurs in
// unrelated places (parent_run_started_at_ms, the JSON-schema "SAFE" tables),
// and a bare match there would let a genuinely broken contract through.
//
// Deliberate trade-off (audit F12): the old bare-substring anchors could accept a
// host whose journal contract really changed (a false accept). These bounded
// anchors can instead reject a host we merely do not recognize (a false reject):
// cliBuildPatched throws "host transcript journal contract changed", the tick
// records patch_failed, and that reason is not keeper-rearmable, so the guardian
// stays off until a human acts. Fail-closed is the intended direction; the
// operational consequence is that the first official host push after this build
// is deployed must be watched for patch_failed in watchdog.log.
var CLI_JOURNAL_USER_MESSAGE_SCHEMA = /\["UserMessage\|[^"]*\bstarted_at_ms \d+\?[^"]*\bcompleted_at_ms \d+\?[^"]*"/;
var CLI_JOURNAL_USER_MESSAGE_API = /(?:^|[^A-Za-z0-9_$])UserMessage\.fromBinary\(/;
var CLI_TERMINAL_HOOKS = [
  {
    marker: "/* GROK_SWITCH_TERMINAL_BLOCK */",
    original: "const blockReason = deps.getSendBlockReason?.(message, deliverTo);",
    patched: "/* GROK_SWITCH_TERMINAL_BLOCK */ const blockReason = deps.getSendBlockReason?.(message, deliverTo) ?? grokSwitchTerminalBlockReason(meta.toolCallId, rawArgs, deps.grokSwitchHasRunningBackgroundWork);"
  },
  {
    marker: "/* GROK_SWITCH_TERMINAL_DEPS */",
    original: "completeTurnAfterSend: turn.offerSendToUserEndTurn() ? turn.completeThisRun : void 0,",
    patched: "completeTurnAfterSend: turn.offerSendToUserEndTurn() ? turn.completeThisRun : void 0,\n        /* GROK_SWITCH_TERMINAL_DEPS */ grokSwitchHasRunningBackgroundWork: host.grokSwitchHasRunningBackgroundWork,"
  },
  {
    marker: "/* GROK_SWITCH_TERMINAL_RUNNER */",
    original: "listRunningSubagents: () => this.listRunningSubagents(),",
    patched: "listRunningSubagents: () => this.listRunningSubagents(),\n        /* GROK_SWITCH_TERMINAL_RUNNER */ grokSwitchHasRunningBackgroundWork: () => this.hasRunningBackgroundWork(),"
  }
];
var CLI_REQUIRED_HOST_NAMES = ["BasePromptExecutor", "BasePromptBuilder", "function createCursorSandInference("];

var CLI_USAGE = [
  "grok-switch " + CLI_VERSION + " - route Grok Bot inference to your own model API",
  "",
  "usage: node grok-switch.cjs <command> [options]",
  "",
  "  install [--no-ui] [--port N]    patch the host now, request its one-time restart, start the panel",
  "  use <name> [provider options]   switch to a saved provider (saves and test-requests it first if options given)",
  "  official                        switch back to official Grok; saved providers are kept",
  "  add <name> <provider options>   save or update a provider without switching",
  "  remove <name>                   delete a saved provider",
  "  list                            show saved providers",
  "  status [--json]                 show host patch, process, supervisor and config state",
  "  test <name> [--json]            send one small request to a provider and print the reply",
  "  log [N]                         show the last N upstream requests (default 20)",
  "  restart                         ask the supervisor to restart the host when idle",
  "  restore                         remove the patch from the host bundle and restart",
  "  watchdog <action>               enable | disable | status | once | run; automatic compatible-update repair",
  "  ui [--background] [--port N]    web panel on 127.0.0.1 for configuring providers (ui stop / ui status)",
  "",
  "provider options:",
  "  --url <baseUrl>                 e.g. https://api.openai.com/v1 (required)",
  "  --model <id>                    model id sent to the provider (required)",
  "  --protocol <p>                  openai-chat (default) | openai-responses | anthropic-messages",
  "  --key <apiKey>                  API key; or --key-file <path>; or env GROK_SWITCH_API_KEY",
  "  --auth <type>                   bearer | x-api-key | none | codex (default depends on protocol)",
  "                                  codex = sign with the ChatGPT login from `codex login` (~/.codex/auth.json);",
  "                                  implies openai-responses and " + GROK_SWITCH_CODEX_BASE_URL,
  "  --endpoint <path>               override the request path, e.g. /v1/chat/completions",
  "  --header <Name: value>          extra request header (repeatable)",
  "  --reasoning <effort>            reasoningEffort parameter (OpenAI protocols)",
  "  --max-tokens <n>                maxTokens parameter (Anthropic default 8192)",
  "  --no-test                       skip the test request `use` sends before switching",
  "",
  "in chat (any platform, no terminal): /gs use <name>   /gs official   /gs status",
  "",
  "files: " + CLI_CONFIG_PATH + " (config, mode 600), " + CLI_LOG_PATH + " (request log)",
  "host:  " + CLI_HOST_PATH
].join("\n");

class CliError extends Error {}

function cliParseArgs(argv) {
  var positional = [];
  var flags = {};
  for (var i = 0; i < argv.length; i += 1) {
    var arg = argv[i];
    if (arg.slice(0, 2) !== "--") {
      positional.push(arg);
      continue;
    }
    var eq = arg.indexOf("=");
    var name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    var value;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else if (name === "json" || name === "force" || name === "no-test" || name === "background" || name === "no-ui") {
      value = true;
    } else {
      if (i + 1 >= argv.length) throw new CliError("--" + name + " needs a value");
      i += 1;
      value = argv[i];
    }
    if (name === "header") {
      if (flags.header == null) flags.header = [];
      flags.header.push(value);
    } else {
      flags[name] = value;
    }
  }
  return { positional: positional, flags: flags };
}

// ---------------------------------------------------------------------------
// Config file

function cliReadRawConfig() {
  var text = grokSwitchReadConfigText();
  if (text == null) return grokSwitchTrackConfig({ active: null, providers: {} }, text);
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    throw new CliError(CLI_CONFIG_PATH + " is not valid JSON; fix or delete it");
  }
  if (!grokSwitchIsPlainObject(parsed)) throw new CliError(CLI_CONFIG_PATH + " must contain a JSON object");
  if (parsed.providers == null) parsed.providers = {};
  if (parsed.active === void 0) parsed.active = null;
  return grokSwitchTrackConfig(parsed, text);
}

function cliWriteConfig(config) {
  return grokSwitchWriteConfigCAS(config);
}

function cliHash(text) {
  return grokSwitchHash(text);
}

function cliRequireProviderName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new CliError("provider name must be 1-64 letters, digits, '.', '_' or '-'");
  }
  return name;
}

function cliHasProviderFlags(flags) {
  var names = ["url", "model", "protocol", "key", "key-file", "auth", "endpoint", "header", "reasoning", "max-tokens"];
  for (var i = 0; i < names.length; i += 1) {
    if (flags[names[i]] != null) return true;
  }
  return false;
}

function cliReadKey(flags) {
  if (flags.key != null) return String(flags.key);
  if (flags["key-file"] != null) return cliFs.readFileSync(String(flags["key-file"]), "utf8").trim();
  if (process.env.GROK_SWITCH_API_KEY != null) return process.env.GROK_SWITCH_API_KEY;
  return null;
}

// Builds the raw provider entry from flags, merging over an existing entry so
// `use name --model x` can change one field.
// Model named in the Codex CLI config, used as the default for --auth codex.
function cliCodexConfiguredModel() {
  try {
    var home = process.env.CODEX_HOME && process.env.CODEX_HOME.trim() ? process.env.CODEX_HOME.trim() : require("node:os").homedir() + "/.codex";
    var match = /^\s*model\s*=\s*["']([^"']+)["']/m.exec(cliFs.readFileSync(home + "/config.toml", "utf8"));
    return match ? match[1].trim() : null;
  } catch (_error) {
    return null;
  }
}

function cliProviderFromFlags(name, flags, existing) {
  var entry = existing != null ? JSON.parse(JSON.stringify(existing)) : {};
  if (flags.auth != null) entry.authType = String(flags.auth);
  var codex = entry.authType === "codex";
  if (flags.protocol != null) entry.protocol = String(flags.protocol);
  if (entry.protocol == null) entry.protocol = codex ? "openai-responses" : "openai-chat";
  if (flags.url != null) entry.baseUrl = String(flags.url);
  if (entry.baseUrl == null && codex) entry.baseUrl = GROK_SWITCH_CODEX_BASE_URL;
  if (flags.model != null) entry.model = String(flags.model);
  if (entry.model == null && codex) entry.model = cliCodexConfiguredModel();
  var key = cliReadKey(flags);
  if (key != null) entry.apiKey = key;
  if (flags.endpoint != null) entry.endpointPath = String(flags.endpoint);
  if (flags.header != null) {
    entry.headers = entry.headers || {};
    for (var i = 0; i < flags.header.length; i += 1) {
      var raw = String(flags.header[i]);
      var colon = raw.indexOf(":");
      if (colon <= 0) throw new CliError("--header must look like 'Name: value'");
      entry.headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
    }
  }
  if (flags.reasoning != null || flags["max-tokens"] != null) {
    entry.parameters = entry.parameters || {};
    if (flags.reasoning != null) entry.parameters.reasoningEffort = String(flags.reasoning);
    if (flags["max-tokens"] != null) {
      var n = Number(flags["max-tokens"]);
      if (!Number.isInteger(n) || n < 1) throw new CliError("--max-tokens must be a positive integer");
      entry.parameters.maxTokens = n;
    }
  }
  if (entry.baseUrl == null) throw new CliError("--url is required");
  if (entry.model == null) throw new CliError(codex ? "--model is required (no model in ~/.codex/config.toml)" : "--model is required");
  if (codex) {
    try {
      grokSwitchCodexCredentials();
    } catch (error) {
      throw new CliError(error.message);
    }
  }
  try {
    grokSwitchNormalizeProvider(name, entry);
  } catch (error) {
    throw new CliError(error.message);
  }
  return entry;
}

function cliDescribeProvider(provider) {
  return provider.protocol + " " + provider.baseUrl + provider.endpointPath + " model=" + provider.model;
}

// ---------------------------------------------------------------------------
// Host bundle patching

function cliPayload() {
  var self = cliFs.readFileSync(__filename, "utf8");
  var begin = self.indexOf(CLI_PAYLOAD_BEGIN);
  var end = self.indexOf(CLI_PAYLOAD_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new CliError("this file is not a built grok-switch bundle; run `npm run build` and use dist/grok-switch.cjs");
  }
  return self.slice(begin, end + CLI_PAYLOAD_END.length) + "\n";
}

// The exact bytes our patch occupies in a host bundle. The banner version alone
// cannot tell two payloads apart, so every "is the host already running this
// build?" decision compares this block: a payload change with an unmoved version
// string used to read as "unchanged" and never reached the host. The block is
// compared as text rather than hashed so this stays usable wherever the bundle
// is loaded without the shared hash helper (the patch inspector is unit-tested
// on its own).

// This file's payload region is immutable for the life of the process; only a
// replacement changes it, and a replacement moves the file identity that the
// daemon's fingerprint loop already watches. Remembering the block keyed on that
// identity keeps cliPatchIsCurrent() - called at least twice per 30s tick - from
// re-reading the whole ~700 KB bundle every time, while a rewrite is still seen.
var cliPatchBlockMemo = null;

function cliPatchBlock() {
  var identity = null;
  try {
    var stat = cliFs.statSync(__filename);
    identity = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  } catch (_error) {
    identity = null;
  }
  if (identity != null && cliPatchBlockMemo != null && cliPatchBlockMemo.identity === identity) return cliPatchBlockMemo.block;
  var block = CLI_PATCH_BEGIN + " " + CLI_VERSION + "\n" + cliPayload() + CLI_PATCH_END + "\n";
  if (identity != null) cliPatchBlockMemo = { identity: identity, block: block };
  return block;
}

function cliPatchIsCurrent(info) {
  return info != null && info.patched === true && info.version === CLI_VERSION && info.patchBlock === cliPatchBlock();
}

// install and the guardian ask two different questions with the same helper.
// install asks "would writing our patch change anything?" - version plus patch
// block, because a rewrite must not happen for an unchanged banner. The guardian
// also asks "are these the bytes I last verified?" (watchdog.cjs compares the
// snapshot hash with state.baselineHash) because it must not certify a host it
// never proved. The difference is deliberate and this reports its consequence so
// "already patched" is not later met by patched_host_changed without context.
function cliGuardianProvenanceWarning(guardian) {
  if (guardian == null || guardian.enabled !== true || guardian.baselineHash == null) return null;
  var currentHash = null;
  try { currentHash = cliHash(cliReadBundle()); } catch (_error) { return null; }
  if (currentHash === guardian.baselineHash) return null;
  return "the guardian last verified different host bytes; run \"watchdog disable\" then \"watchdog enable\" to rebind, or its next observation fails closed as patched_host_changed";
}

function cliCount(text, needle) {
  var count = 0;
  var index = 0;
  for (;;) {
    index = text.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

// Only the observed SendToUser host contract is hooked. Older hosts keep their
// native behavior; changed modern anchors require review before any file write.
function cliHasTerminalGuardHooks(text) {
  return text.indexOf("GROK_SWITCH_TERMINAL_") !== -1 || text.indexOf("grokSwitchHasRunningBackgroundWork") !== -1;
}

function cliTerminalGuardHooks(text, restore) {
  if (restore) {
    if (!cliHasTerminalGuardHooks(text)) return text;
    for (var r = 0; r < CLI_TERMINAL_HOOKS.length; r += 1) {
      var applied = CLI_TERMINAL_HOOKS[r];
      if (cliCount(text, applied.marker) !== 1 || cliCount(text, applied.patched) !== 1) {
        throw new CliError("host bundle contains damaged terminal guard hooks; restore it from " + CLI_BACKUP_PATH);
      }
    }
    for (var u = 0; u < CLI_TERMINAL_HOOKS.length; u += 1) {
      text = text.replace(CLI_TERMINAL_HOOKS[u].patched, CLI_TERMINAL_HOOKS[u].original);
    }
    return text;
  }
  if (text.indexOf("createSendMessageTool2") === -1) return text;
  if (cliCount(text, "function createSendMessageTool2(") !== 1) {
    throw new CliError("host terminal guard contract changed; manual compatibility review required");
  }
  for (var i = 0; i < CLI_TERMINAL_HOOKS.length; i += 1) {
    if (cliCount(text, CLI_TERMINAL_HOOKS[i].original) !== 1) {
      throw new CliError("host terminal guard anchor " + (i + 1) + " changed; manual compatibility review required");
    }
  }
  for (var p = 0; p < CLI_TERMINAL_HOOKS.length; p += 1) {
    text = text.replace(CLI_TERMINAL_HOOKS[p].original, CLI_TERMINAL_HOOKS[p].patched);
  }
  return text;
}

// Returns { stock, patched, version } where stock is the bundle text with our
// patch removed (identical to the original file when no patch is present).
function cliInspectBundle(text) {
  var begin = text.indexOf(CLI_PATCH_BEGIN);
  var end = text.indexOf(CLI_PATCH_END);
  if (begin === -1 && end === -1) {
    if (cliHasTerminalGuardHooks(text)) {
      throw new CliError("host bundle contains damaged terminal guard hooks without a runtime patch; restore it from " + CLI_BACKUP_PATH);
    }
    return { stock: text, patched: false, version: null };
  }
  if (begin === -1 || end === -1 || end < begin) {
    throw new CliError("host bundle contains a damaged grok-switch patch; restore it from " + CLI_BACKUP_PATH);
  }
  var lineEnd = text.indexOf("\n", begin);
  var version = text.slice(begin + CLI_PATCH_BEGIN.length, lineEnd).trim();
  var stop = end + CLI_PATCH_END.length;
  if (text[stop] === "\n") stop += 1;
  var block = text.slice(begin, stop);
  var stock = text.slice(0, begin) + text.slice(stop);
  if (cliCount(stock, CLI_RENAMED_FACTORY) !== 1) {
    throw new CliError("host bundle contains a damaged grok-switch patch; restore it from " + CLI_BACKUP_PATH);
  }
  stock = stock.replace(CLI_RENAMED_FACTORY, CLI_HOST_FACTORY);
  stock = stock.replace(CLI_JOURNAL_COMPAT, CLI_JOURNAL_GUARD);
  stock = cliTerminalGuardHooks(stock, true);
  return { stock: stock, patched: true, version: version, patchBlock: block };
}

function cliAssertPatchable(stock) {
  var factories = cliCount(stock, CLI_HOST_FACTORY);
  if (factories !== 1) {
    throw new CliError("host bundle has " + factories + " createHostInference definitions (expected 1); this Grok Bot version is not supported yet");
  }
  for (var i = 0; i < CLI_REQUIRED_HOST_NAMES.length; i += 1) {
    if (stock.indexOf(CLI_REQUIRED_HOST_NAMES[i]) === -1) {
      throw new CliError("host bundle lacks " + CLI_REQUIRED_HOST_NAMES[i] + "; this Grok Bot version is not supported yet");
    }
  }
}

function cliBuildPatched(stock) {
  stock = cliTerminalGuardHooks(stock, false);
  var block = cliPatchBlock();
  if (stock.includes("var FileTranscriptMirror = class")) {
    // 2026-09-16 port of the cloud.5 fix: newer host bundles declare schema fields
    // positionally (e.g. `started_at_ms 4?`) instead of `name: "started_at_ms"`. The
    // functional dependencies the journal compat patch relies on are unchanged, so the
    // fingerprint is relaxed from the strict schema form to the UserMessage protobuf
    // descriptor plus the UserMessage.fromBinary API, while keeping the substantive
    // check (unique journal guard anchor). Both anchors are bounded, so a decoy such as
    // `parent_run_started_at_ms` or the JSON-schema "SAFE" tables cannot satisfy them.
    if (cliCount(stock, CLI_JOURNAL_GUARD) !== 1 || !CLI_JOURNAL_USER_MESSAGE_SCHEMA.test(stock) || !CLI_JOURNAL_USER_MESSAGE_API.test(stock)) {
      throw new CliError("host transcript journal contract changed; manual compatibility review required");
    }
    stock = stock.replace(CLI_JOURNAL_GUARD, CLI_JOURNAL_COMPAT);
  }
  return stock.replace(CLI_HOST_FACTORY, block + CLI_RENAMED_FACTORY);
}

function cliNodeCheck(path) {
  var result = cliChildProcess.spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  if (result.status !== 0) {
    var detail = String(result.stderr || result.stdout).trim().split("\n").filter(Boolean).slice(0, 4).join(" | ");
    throw new CliError("patched bundle failed `node --check`: " + detail);
  }
}

function cliBundleSnapshot() {
  var before = cliFs.lstatSync(CLI_HOST_PATH);
  if (!before.isFile() || before.isSymbolicLink()) throw new CliError("host bundle must be a regular file");
  var text = cliReadBundle();
  var after = cliFs.lstatSync(CLI_HOST_PATH);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new CliError("host bundle changed while taking its snapshot; retry after the official update finishes");
  }
  return { text: text, hash: cliHash(text), dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, mode: after.mode & 511 };
}

function cliAssertBundleSnapshot(expected) {
  var current = cliBundleSnapshot();
  if (current.hash !== expected.hash || current.dev !== expected.dev || current.ino !== expected.ino || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs) {
    throw new CliError("host bundle changed during maintenance; official update preserved");
  }
}

function cliWriteBundle(text, expected) {
  grokSwitchAssertMaintenanceLock();
  if (expected == null) throw new CliError("host bundle snapshot required before replacement");
  // A killed patch attempt leaves host-main.cjs.grok-switch-<suffix>.tmp.cjs next
  // to the host, which is the directory the supervisor and the official updater
  // both watch - collect the old ones while we are writing here anyway.
  grokSwitchSweepTempFiles(cliPath.dirname(CLI_HOST_PATH), [cliPath.basename(CLI_HOST_PATH) + ".grok-switch-"]);
  // Keep the .cjs extension so `node --check` parses it as CommonJS.
  var tmp = CLI_HOST_PATH + ".grok-switch-" + grokSwitchUniqueSuffix() + ".tmp.cjs";
  try {
    cliFs.writeFileSync(tmp, text, { mode: expected.mode, flag: "wx" });
    cliNodeCheck(tmp);
    // Our lock serializes our own writers only. Recheck the official updater's
    // file identity and content immediately before committing the candidate.
    cliAssertBundleSnapshot(expected);
    cliFs.renameSync(tmp, CLI_HOST_PATH);
    grokSwitchFsyncDir(cliPath.dirname(CLI_HOST_PATH));
    if (cliBundleSnapshot().hash !== cliHash(text)) throw new CliError("host bundle changed after replacement; manual inspection required");
  } finally {
    try { cliFs.unlinkSync(tmp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function cliReadBundle() {
  try {
    return cliFs.readFileSync(CLI_HOST_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new CliError("host bundle not found at " + CLI_HOST_PATH + "; run this inside the Grok Bot cloud machine");
    throw error;
  }
}

// Ensures the host bundle on disk carries the current patch.
// Returns "unchanged" | "patched" | "updated".
function cliEnsurePatched(expectedSnapshot) {
  grokSwitchAssertMaintenanceLock();
  var snapshot = expectedSnapshot || cliBundleSnapshot();
  if (expectedSnapshot != null) cliAssertBundleSnapshot(expectedSnapshot);
  var info = cliInspectBundle(snapshot.text);
  if (cliPatchIsCurrent(info)) return "unchanged";
  cliAssertPatchable(info.stock);
  if (!info.patched) cliFs.writeFileSync(CLI_BACKUP_PATH, info.stock, { mode: 384 });
  cliWriteBundle(cliBuildPatched(info.stock), snapshot);
  return info.patched ? "updated" : "patched";
}

function cliUnpatch() {
  grokSwitchAssertMaintenanceLock();
  var snapshot = cliBundleSnapshot();
  var info = cliInspectBundle(snapshot.text);
  if (!info.patched) return false;
  cliWriteBundle(info.stock, snapshot);
  try {
    cliFs.unlinkSync(CLI_BACKUP_PATH);
  } catch (_error) {}
  return true;
}

// ---------------------------------------------------------------------------
// Host process and supervisor

function cliBootTimeMs() {
  var stat = cliFs.readFileSync(cliPath.join(CLI_PROC_ROOT, "stat"), "utf8");
  var match = /^btime (\d+)/m.exec(stat);
  return match ? Number(match[1]) * 1000 : null;
}

// Field 22 of /proc/<pid>/stat, converted to epoch milliseconds. Used for the
// host process and for the keeper identity cross-check, so both read it the same
// way and neither can drift from the other.
function cliPidStartedAtMs(pid, bootMs) {
  try {
    var stat = cliFs.readFileSync(cliPath.join(CLI_PROC_ROOT, String(pid), "stat"), "utf8");
    var fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    var startTicks = Number(fields[19]);
    var boot = bootMs == null ? cliBootTimeMs() : bootMs;
    if (boot != null && Number.isFinite(startTicks)) return boot + startTicks * 10;
  } catch (_error) {}
  return null;
}

function cliFindHostProcess() {
  var entries;
  try {
    entries = cliFs.readdirSync(CLI_PROC_ROOT);
  } catch (_error) {
    return null;
  }
  var boot = null;
  try {
    boot = cliBootTimeMs();
  } catch (_error) {}
  for (var i = 0; i < entries.length; i += 1) {
    if (!/^\d+$/.test(entries[i]) || Number(entries[i]) === process.pid) continue;
    var cmdline;
    try {
      cmdline = cliFs.readFileSync(cliPath.join(CLI_PROC_ROOT, entries[i], "cmdline"), "utf8").split("\0");
    } catch (_error) {
      continue;
    }
    if (cmdline.indexOf(CLI_HOST_PATH) === -1) continue;
    return { pid: Number(entries[i]), startedAtMs: cliPidStartedAtMs(entries[i], boot) };
  }
  return null;
}

function cliSupervisorState() {
  var commandPath = cliPath.join(CLI_SUPERVISOR_DIR, "command.json");
  var state = { busy: cliFs.existsSync(cliPath.join(CLI_SUPERVISOR_DIR, "agent.busy")), pending: null };
  if (cliFs.existsSync(commandPath)) {
    try {
      state.pending = JSON.parse(cliFs.readFileSync(commandPath, "utf8"));
    } catch (_error) {
      state.pending = { id: "unreadable" };
    }
  }
  return state;
}

// Asks the supervisor to restart the host. The supervisor applies restart
// commands only when no agent is busy, so this is safe to issue any time.
function cliRequestRestart(reason) {
  grokSwitchAssertMaintenanceLock();
  var state = cliSupervisorState();
  if (state.pending != null) return { issued: false, pending: state.pending };
  cliFs.mkdirSync(CLI_SUPERVISOR_DIR, { recursive: true });
  var command = {
    id: "grok-switch-" + Date.now(),
    kind: "restart",
    issuedAtMs: Date.now(),
    reason: reason
  };
  var commandPath = cliPath.join(CLI_SUPERVISOR_DIR, "command.json");
  var tmp = commandPath + "." + grokSwitchUniqueSuffix() + ".part";
  try {
    cliFs.writeFileSync(tmp, JSON.stringify(command), { mode: 384, flag: "wx" });
    // Link the complete command into place without replacing an official
    // command that appeared since our first check. The supervisor sees a
    // complete JSON file; unsupported filesystems fail rather than overwrite.
    try {
      cliFs.linkSync(tmp, commandPath);
    } catch (error) {
      if (error.code === "EEXIST") return { issued: false, pending: cliSupervisorState().pending || { id: "command-arrived-during-staging" } };
      throw error;
    }
  } finally {
    try { cliFs.unlinkSync(tmp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { issued: true, command: command };
}

function cliHostState() {
  var text = null;
  try {
    text = cliReadBundle();
  } catch (_error) {}
  var info = text == null ? null : cliInspectBundle(text);
  var bundleMtimeMs = null;
  try {
    bundleMtimeMs = cliFs.statSync(CLI_HOST_PATH).mtimeMs;
  } catch (_error) {}
  var version = null;
  try {
    version = cliFs.readFileSync(CLI_HOST_VERSION_PATH, "utf8").trim();
  } catch (_error) {}
  var proc = cliFindHostProcess();
  var runningCurrent = null;
  if (proc != null && proc.startedAtMs != null && bundleMtimeMs != null) {
    runningCurrent = proc.startedAtMs >= bundleMtimeMs;
  }
  return {
    path: CLI_HOST_PATH,
    exists: text != null,
    version: version,
    patched: info == null ? false : info.patched,
    patchVersion: info == null ? null : info.version,
    backupExists: cliFs.existsSync(CLI_BACKUP_PATH),
    process: proc,
    runningCurrentBundle: runningCurrent,
    supervisor: cliSupervisorState()
  };
}

// ---------------------------------------------------------------------------
// Commands

// Output sink. The web panel captures command output by swapping it.
var cliSink = null;

function cliPrint(line) {
  if (cliSink != null) cliSink.push(line);
  else process.stdout.write(line + "\n");
}

// `status | head` closes the pipe early; that is not an error worth a stack trace.
process.stdout.on("error", function (error) {
  if (error && error.code === "EPIPE") process.exit(0);
});

async function cliCapture(fn) {
  var lines = [];
  var previous = cliSink;
  cliSink = lines;
  try {
    await fn();
  } finally {
    cliSink = previous;
  }
  return lines;
}

function cliCommandAdd(args) {
  return grokSwitchWithManualMaintenance("manual provider add", function () {
    var name = cliRequireProviderName(args.positional[1]);
    var config = cliReadRawConfig();
    config.providers[name] = cliProviderFromFlags(name, args.flags, config.providers[name]);
    cliWriteConfig(config);
    cliPrint("saved provider " + name + ": " + cliDescribeProvider(grokSwitchNormalizeProvider(name, config.providers[name])));
  });
}

function cliCommandRemove(args) {
  return grokSwitchWithManualMaintenance("manual provider remove", function () {
    var name = cliRequireProviderName(args.positional[1]);
    var config = cliReadRawConfig();
    if (config.providers[name] == null) throw new CliError("no provider named " + name);
    if (config.active === name) throw new CliError(name + " is the active provider; run `official` or `use <other>` first");
    delete config.providers[name];
    cliWriteConfig(config);
    cliPrint("removed provider " + name);
  });
}

function cliCommandList(args) {
  var config = cliReadRawConfig();
  var names = Object.keys(config.providers);
  if (args.flags.json) {
    var out = {};
    for (var i = 0; i < names.length; i += 1) {
      var copy = JSON.parse(JSON.stringify(config.providers[names[i]]));
      if (copy.apiKey != null) copy.apiKey = "***";
      out[names[i]] = copy;
    }
    cliPrint(JSON.stringify({ active: config.active, providers: out }, null, 2));
    return;
  }
  if (names.length === 0) {
    cliPrint("no providers saved; add one with: use <name> --url <baseUrl> --model <id> --key <apiKey>");
    return;
  }
  for (var j = 0; j < names.length; j += 1) {
    var marker = config.active === names[j] ? "* " : "  ";
    var summary;
    try {
      summary = cliDescribeProvider(grokSwitchNormalizeProvider(names[j], config.providers[names[j]]));
    } catch (error) {
      summary = "INVALID: " + error.message;
    }
    cliPrint(marker + names[j] + "  " + summary);
  }
  cliPrint(config.active == null ? "active: official Grok" : "active: " + config.active);
}

function cliExplainRestart(result) {
  if (result.issued) {
    cliPrint("restart requested (" + result.command.id + "); the supervisor restarts the host as soon as no Bot is busy.");
  } else {
    cliPrint("a supervisor command is already pending (" + String(result.pending.id) + "); the host restarts when it is applied.");
  }
}

async function cliCommandUse(args) {
  return grokSwitchWithManualMaintenance("manual provider use", async function () {
    var name = cliRequireProviderName(args.positional[1]);
    var config = cliReadRawConfig();
    var changed = cliHasProviderFlags(args.flags);
    if (changed) {
      config.providers[name] = cliProviderFromFlags(name, args.flags, config.providers[name]);
    }
    if (config.providers[name] == null) {
      throw new CliError("no provider named " + name + "; pass --url/--model/--key to create it");
    }
    var provider;
    try {
      provider = grokSwitchNormalizeProvider(name, config.providers[name]);
    } catch (error) {
      throw new CliError(error.message);
    }
    // A new or edited provider is probed before anything is switched, so a bad
    // URL, key or model is reported here instead of in the next conversation.
    if (changed && !args.flags["no-test"]) {
      var probe = await cliProbeProvider(provider);
      if (!probe.ok) {
        throw new CliError("provider " + name + " did not answer a test request: " + probe.error + "\nnothing was switched; fix the flags and run again, or add --no-test to skip this check");
      }
      cliPrint("test request OK in " + probe.ms + "ms (reply " + JSON.stringify(probe.text.slice(0, 40)) + ")");
    }
    var outcome = cliEnsurePatched();
    config.active = name;
    cliWriteConfig(config);
    cliPrint("active provider: " + name + " (" + cliDescribeProvider(provider) + ")");
    if (outcome === "patched") cliPrint("host bundle patched; original saved to " + CLI_BACKUP_PATH);
    if (outcome === "updated") cliPrint("host bundle patch updated to " + CLI_VERSION);
    var state = cliHostState();
    if (outcome !== "unchanged" || state.runningCurrentBundle === false) {
      cliExplainRestart(cliRequestRestart("grok-switch use " + name));
      cliPrint("after the restart, new conversations use " + name + ".");
    } else if (state.process == null) {
      cliPrint("host process not found; it will use " + name + " when it starts.");
    } else {
      cliPrint("takes effect on the next conversation turn; no restart needed.");
    }
    cliPrint("in chat: /gs official switches back, /gs use <name> switches again, /gs status shows the route.");
  });
}

// Only a command-line invocation owns an exit status; the panel runs the same
// commands in-process and must not inherit one. Armed by the entry point at the
// bottom of this file, and disarmed again by the panel server itself: the panel
// is launched as `node <bundle> ui`, which is also `require.main === module`.
var cliCommandExitCodeArmed = false;

// A manual command disables the guardian before it touches anything, and the
// restore path used to swallow every failure: the command looked like it worked
// while watchdog.json stayed disabled until the box keeper happened to retry.
// Make a failed restore loud (stdout + watchdog.log) and, on the command line,
// non-zero. Null means there was nothing to restore, which stays silent.
function cliGuardianReport(restored, successLine) {
  if (restored == null) return;
  if (restored.ok) { if (successLine) cliPrint(successLine); return; }
  var detail = restored.detail ? ": " + restored.detail : "";
  cliPrint("warning: the guardian was not restored (" + restored.reason + detail + "); the box keeper will retry.");
  try {
    cliWatchdogEvent({ schemaVersion: 1, enabled: false, phase: "guardian_restore_failed", disabledReason: restored.reason }, "guardian_restore_failed", Date.now());
  } catch (_error) {}
  if (cliCommandExitCodeArmed) process.exitCode = 1;
}

// One-shot setup run by Grok Bot: patch now (transparent while no provider
// is active), request the single restart, start the panel. By the time the
// user opens the panel the host is already running the patched code.
async function cliCommandInstall(args) {
  var priorGuardian = cliWatchdogReadOrNull();
  var noop = false;
  try {
    return await grokSwitchWithManualMaintenance("manual install", async function () {
      var outcome = cliEnsurePatched();
      if (outcome === "patched") cliPrint("host bundle patched; original saved to " + CLI_BACKUP_PATH);
      else if (outcome === "updated") cliPrint("host bundle patch updated to " + CLI_VERSION);
      else {
        cliPrint("host bundle already patched (" + CLI_VERSION + ")");
        var provenanceWarning = cliGuardianProvenanceWarning(priorGuardian);
        if (provenanceWarning != null) cliPrint("note: " + provenanceWarning);
      }
      var state = cliHostState();
      if (outcome !== "unchanged" || state.runningCurrentBundle === false) {
        cliExplainRestart(cliRequestRestart("grok-switch install"));
        cliPrint("this restart happens once, after the current Bot turn ends; switching providers later never restarts.");
      } else {
        noop = true;
        cliPrint("host process already runs the patched code; no restart needed.");
      }
      cliPrint("route: " + (grokSwitchResolveRoute().kind === "official" ? "official Grok (unchanged until a provider is selected)" : "external provider selected"));
      if (!args.flags["no-ui"]) {
        await uiCommand({ positional: ["ui"], flags: { background: true, port: args.flags.port } });
      }
    });
  } finally {
    if (noop) cliGuardianReport(cliWatchdogRestoreAfterNoop(priorGuardian), "guardian left enabled; nothing about the host or the route changed.");
  }
}

function cliCommandOfficial() {
  var priorGuardian = cliWatchdogReadOrNull();
  try {
    return grokSwitchWithManualMaintenance("manual official", function () {
      var config = cliReadRawConfig();
      config.active = null;
      cliWriteConfig(config);
      cliPrint("active provider: official Grok (saved providers kept)");
      cliPrint("takes effect on the next conversation turn.");
    });
  } finally {
    cliGuardianReport(cliWatchdogSuppressAfterOfficial(priorGuardian), "guardian suppressed for the official route; it resumes by itself when an external provider is active again.");
  }
}

function cliCommandRestart() {
  return grokSwitchWithManualMaintenance("manual restart", function () {
    cliExplainRestart(cliRequestRestart("grok-switch restart"));
  });
}

function cliCommandRestore() {
  return grokSwitchWithManualMaintenance("manual restore", function () {
    var config = cliReadRawConfig();
    if (config.active != null) {
      config.active = null;
      cliWriteConfig(config);
      cliPrint("active provider reset to official Grok");
    }
    if (cliUnpatch()) {
      cliPrint("patch removed from " + CLI_HOST_PATH);
      cliExplainRestart(cliRequestRestart("grok-switch restore"));
    } else {
      cliPrint("host bundle has no grok-switch patch; nothing to restore");
    }
  });
}

function cliReadLog(limit) {
  var lines = [];
  try {
    lines = cliFs.readFileSync(CLI_LOG_PATH, "utf8").split("\n").filter(Boolean);
  } catch (_error) {}
  return lines.slice(-limit).map(function (line) {
    try {
      return JSON.parse(line);
    } catch (_error) {
      return { raw: line };
    }
  });
}

function cliFormatLogEntry(entry) {
  if (entry.raw != null) return entry.raw;
  var parts = [entry.ts, entry.provider || "-", entry.model || "-", entry.kind || "-", "HTTP " + entry.status, (entry.ms || 0) + "ms"];
  if (entry.usage) parts.push("tokens " + entry.usage.promptTokens + "+" + entry.usage.completionTokens);
  if (entry.error) parts.push("ERROR " + entry.error);
  return parts.join("  ");
}

function cliCommandLog(args) {
  var limit = args.positional[1] != null ? Number(args.positional[1]) : 20;
  if (!Number.isInteger(limit) || limit < 1) throw new CliError("log count must be a positive integer");
  var entries = cliReadLog(limit);
  if (entries.length === 0) {
    cliPrint("no upstream requests logged yet (" + CLI_LOG_PATH + ")");
    return;
  }
  for (var i = 0; i < entries.length; i += 1) cliPrint(cliFormatLogEntry(entries[i]));
}

function cliCommandStatus(args) {
  var host = cliHostState();
  var config = cliReadRawConfig();
  var route = grokSwitchResolveRoute();
  var recent = cliReadLog(5);
  var usage = cliUsageTotals();
  if (args.flags.json) {
    var activeProvider = route.kind === "external" ? cliDescribeProvider(route.provider) : null;
    cliPrint(JSON.stringify({
      version: CLI_VERSION,
      host: host,
      config: { path: CLI_CONFIG_PATH, active: config.active, providers: Object.keys(config.providers), route: route.kind, error: route.kind === "error" ? route.message : null, activeProvider: activeProvider },
      usage: usage,
      recentRequests: recent
    }, null, 2));
    return;
  }
  cliPrint("grok-switch " + CLI_VERSION);
  if (!host.exists) {
    cliPrint("host bundle : not found at " + host.path + " (not inside the Grok Bot cloud machine?)");
  } else {
    var patch = host.patched ? "patched (" + host.patchVersion + ")" : "not patched";
    cliPrint("host bundle : " + host.path + (host.version ? " version " + host.version : "") + "  " + patch);
  }
  if (host.process == null) {
    cliPrint("host process: not running");
  } else {
    var running = host.runningCurrentBundle === true ? "running current bundle" : host.runningCurrentBundle === false ? "RESTART PENDING (bundle changed after start)" : "start time unknown";
    cliPrint("host process: pid " + host.process.pid + (host.process.startedAtMs ? " started " + new Date(host.process.startedAtMs).toISOString() : "") + "  " + running);
  }
  var sup = host.supervisor;
  cliPrint("supervisor  : " + (sup.busy ? "agent busy" : "idle") + (sup.pending ? ", command pending (" + String(sup.pending.id) + ")" : ""));
  if (route.kind === "official") cliPrint("active      : official Grok");
  else if (route.kind === "external") cliPrint("active      : " + route.provider.name + " -> " + cliDescribeProvider(route.provider));
  else cliPrint("active      : MISCONFIGURED - " + route.message + " (requests fail until fixed; run `official` to recover)");
  var names = Object.keys(config.providers);
  cliPrint("providers   : " + (names.length ? names.join(", ") : "none"));
  if (route.kind === "external" && host.exists && !host.patched) {
    cliPrint("warning     : provider selected but host is not patched (Grok Bot update replaced the bundle?); run `use " + route.provider.name + "` to re-apply");
  }
  var usedNames = Object.keys(usage);
  if (usedNames.length > 0) {
    cliPrint("usage       :");
    for (var u = 0; u < usedNames.length; u += 1) {
      var t = usage[usedNames[u]];
      cliPrint("  " + usedNames[u] + "  " + t.requests + " requests" + (t.failed ? " (" + t.failed + " failed)" : "") + ", " + cliFormatTokens(t.promptTokens) + " in / " + cliFormatTokens(t.completionTokens) + " out tokens" + (t.lastUsedAt ? ", last " + t.lastUsedAt : ""));
    }
  }
  if (recent.length > 0) {
    cliPrint("recent      :");
    for (var i = 0; i < recent.length; i += 1) cliPrint("  " + cliFormatLogEntry(recent[i]));
  }
}

// Sends one tiny request through the same code path the host uses.
async function cliProbeProvider(provider) {
  var startedAt = Date.now();
  var result = grokSwitchStream(provider, {
    messages: [{ role: "user", content: "Reply with exactly the word OK and nothing else." }],
    tools: [],
    options: {},
    requestKind: "test"
  });
  var text = "";
  var failure = null;
  try {
    for await (var event of result.fullStream) {
      if (event.type === "text-delta") text += event.textDelta;
    }
  } catch (error) {
    failure = error;
  }
  var usage = null;
  try {
    usage = await result.usage;
  } catch (_error) {}
  return { ok: failure == null, ms: Date.now() - startedAt, text: text, usage: usage, error: failure ? failure.message : null };
}

async function cliCommandTest(args) {
  var name = cliRequireProviderName(args.positional[1]);
  var config = cliReadRawConfig();
  if (config.providers[name] == null) throw new CliError("no provider named " + name);
  var provider;
  try {
    provider = grokSwitchNormalizeProvider(name, config.providers[name]);
  } catch (error) {
    throw new CliError(error.message);
  }
  var probe = await cliProbeProvider(provider);
  if (args.flags.json) {
    cliPrint(JSON.stringify(Object.assign({ provider: name }, probe)));
  } else if (!probe.ok) {
    cliPrint("FAILED after " + probe.ms + "ms: " + probe.error);
  } else {
    cliPrint("OK in " + probe.ms + "ms via " + cliDescribeProvider(provider));
    cliPrint("reply: " + JSON.stringify(probe.text));
    if (probe.usage) cliPrint("usage: " + probe.usage.promptTokens + " prompt + " + probe.usage.completionTokens + " completion tokens");
  }
  if (!probe.ok && cliCommandExitCodeArmed) process.exitCode = 1;
}

// Per-provider totals from the request log (current file plus one rotation).
function cliUsageTotals() {
  var totals = {};
  var files = [CLI_LOG_PATH + ".1", CLI_LOG_PATH];
  for (var f = 0; f < files.length; f += 1) {
    var lines;
    try {
      lines = cliFs.readFileSync(files[f], "utf8").split("\n");
    } catch (_error) {
      continue;
    }
    for (var i = 0; i < lines.length; i += 1) {
      if (!lines[i]) continue;
      var entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch (_parse) {
        continue;
      }
      if (typeof entry.provider !== "string") continue;
      var t = totals[entry.provider] || (totals[entry.provider] = { requests: 0, failed: 0, promptTokens: 0, completionTokens: 0, lastUsedAt: null });
      t.requests += 1;
      if (entry.error) t.failed += 1;
      if (entry.usage) {
        t.promptTokens += Number(entry.usage.promptTokens) || 0;
        t.completionTokens += Number(entry.usage.completionTokens) || 0;
      }
      if (entry.ts && (t.lastUsedAt == null || entry.ts > t.lastUsedAt)) t.lastUsedAt = entry.ts;
    }
  }
  return totals;
}

function cliFormatTokens(n) {
  return n >= 1000000 ? (n / 1000000).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

async function cliMain(argv) {
  var args = cliParseArgs(argv);
  var command = args.positional[0];
  if (command == null || command === "help" || command === "--help" || command === "-h") {
    cliPrint(CLI_USAGE);
    return;
  }
  if (command === "version") return cliPrint(CLI_VERSION);
  if (command === "watchdog") return cliCommandWatchdog(args);
  if (command === "install") return cliCommandInstall(args);
  if (command === "add") return cliCommandAdd(args);
  if (command === "remove") return cliCommandRemove(args);
  if (command === "list") return cliCommandList(args);
  if (command === "use") return cliCommandUse(args);
  if (command === "official") return cliCommandOfficial(args);
  if (command === "status") return cliCommandStatus(args);
  if (command === "test") return cliCommandTest(args);
  if (command === "log") return cliCommandLog(args);
  if (command === "restart") return cliCommandRestart(args);
  if (command === "restore") return cliCommandRestore(args);
  if (command === "ui") return uiCommand(args);
  throw new CliError("unknown command " + command + "\n\n" + CLI_USAGE);
}

if (require.main === module) {
  // A programmatic caller (a test, the panel) may run commands in-process; only
  // this entry point, the one a shell invocation reaches, owns an exit status.
  cliCommandExitCodeArmed = true;
  cliMain(process.argv.slice(2)).catch(function (error) {
    process.stderr.write("error: " + (error instanceof CliError ? error.message : (error && error.stack) || String(error)) + "\n");
    process.exitCode = 1;
  });
}
