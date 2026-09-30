// Concatenates src/ into the single distributable file dist/grok-switch.cjs.
// The section between GROK_SWITCH_PAYLOAD_BEGIN/END is what gets injected into
// the Grok Bot host bundle; the CLI reads it back out of its own file.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const PROTOCOL_FILES = [
  "contract.cjs",
  "sse.cjs",
  "tools.cjs",
  "openai-chat.cjs",
  "openai-responses.cjs",
  "anthropic-messages.cjs",
  "index.cjs"
];

// The ctx-probe diagnostics and the ctx-compact engine live in their own files
// but the deployed bundles carry both inside the runtime region, in that order,
// right before the runtime's "// Adapters" banner, so the splice below keeps
// that order instead of appending new payload segments.
const SECTION_BANNER = "// " + "-".repeat(75) + "\n";
const CTX_PROBE_HEADER = SECTION_BANNER + "// [ctx-probe]";
const CTX_COMPACT_HEADER = SECTION_BANNER + "// [ctx-compact v4.1]";
const ADAPTERS_BANNER = SECTION_BANNER + "// Adapters\n";

function read(relative) {
  let text = readFileSync(join(root, relative), "utf8");
  if (text.startsWith("\ufeff")) text = text.slice(1);
  text = text.replace(/\r\n/g, "\n");
  return text.endsWith("\n") ? text : text + "\n";
}

// runtime.cjs with the ctx-compact engine spliced in immediately ahead of the
// runtime's "// Adapters" banner, which is where the deployed bundles carry it.
function ctxCompactRuntime() {
  const runtime = read("src/runtime.cjs");
  const probe = read("src/ctx-probe.cjs");
  if (!probe.startsWith(CTX_PROBE_HEADER)) {
    throw new Error("src/ctx-probe.cjs: ctx-probe section banner is missing");
  }
  const section = read("src/ctx-compact.cjs");
  if (!section.startsWith(CTX_COMPACT_HEADER)) {
    throw new Error("src/ctx-compact.cjs: ctx-compact v4.1 section banner is missing");
  }
  const banners = runtime.split(ADAPTERS_BANNER).length - 1;
  if (banners !== 1) {
    throw new Error(`src/runtime.cjs: expected 1 "// Adapters" banner, found ${banners}`);
  }
  const combined = probe.replace(/\s+$/, "") + "\n\n" + section.replace(/\s+$/, "");
  return runtime.replace(ADAPTERS_BANNER, combined + "\n\n" + ADAPTERS_BANNER);
}

const registry = `var __grokSwitchFactories = Object.create(null);
var __grokSwitchModules = Object.create(null);
function __grokSwitchRegister(id, factory) {
  __grokSwitchFactories[id] = factory;
}
function __grokSwitchRequire(id) {
  if (__grokSwitchModules[id] == null) {
    var factory = __grokSwitchFactories[id];
    // Node built-ins (node:crypto) come from the host's own require.
    if (factory == null) return require(id);
    var module = { exports: {} };
    __grokSwitchModules[id] = module;
    factory(module, module.exports, __grokSwitchRequire);
  }
  return __grokSwitchModules[id].exports;
}
`;

let payload = "// GROK_SWITCH_PAYLOAD_BEGIN\n" + registry;
for (const file of PROTOCOL_FILES) {
  payload += `__grokSwitchRegister(${JSON.stringify("./" + file)}, function (module, exports, require) {\n`;
  payload += read(join("src", "protocols", file));
  payload += "});\n";
}
payload += read("src/maintenance.cjs").replaceAll("__GROK_SWITCH_RUNTIME_VERSION__", version);
payload += read("src/terminal-guard.cjs");
payload += ctxCompactRuntime();
payload += `function createHostInference(options) {
  return grokSwitchWrapHostInference(__grokSwitchOriginalCreateHostInference(options));
}
// GROK_SWITCH_PAYLOAD_END
`;

// The panel is a React app built by Vite into one self-contained HTML file
// (panel/dist/index.html, committed). It is embedded as a string constant.
const panelHtml = readFileSync(join(root, "panel", "dist", "index.html"), "utf8");
const panel = "var UI_HTML = " + JSON.stringify(panelHtml) + ";\n";

// ui.cjs precedes cli.cjs so its top-level vars exist before cliMain runs.
const cli = read("src/ui.cjs") + panel + read("src/watchdog.cjs") + read("src/cli.cjs").replace("__GROK_SWITCH_VERSION__", version);

const output = `#!/usr/bin/env node
// grok-switch-plus ${version} - https://github.com/yuwenjie058-boop/grok-switch-plus
// Derived from enderzcx/grok-bot-switch (MIT); see UPSTREAM.md.
// Single-file build. Do not edit; regenerate with \`node build.mjs\`.
"use strict";
${payload}${cli}`;

mkdirSync(join(root, "dist"), { recursive: true });
const outPath = join(root, "dist", "grok-switch.cjs");
writeFileSync(outPath, output, { mode: 0o755 });

const check = spawnSync(process.execPath, ["--check", outPath], { encoding: "utf8" });
if (check.status !== 0) {
  process.stderr.write(check.stderr);
  process.exit(1);
}
process.stdout.write(`wrote ${outPath} (${output.length} bytes, v${version})\n`);
