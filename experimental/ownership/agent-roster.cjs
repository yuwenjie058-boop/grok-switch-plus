"use strict";

const fs = require("node:fs");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AGENTS = 10000;
const MAX_BYTES = 2 * 1024 * 1024;

function rosterIds(value) {
  const rows = Array.isArray(value) ? value : value && value.agents;
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_AGENTS) {
    throw Object.assign(new Error("Invalid agent roster"), { code: "INVALID_AGENT_ROSTER" });
  }
  const ids = new Set();
  // for...of visits sparse holes too, including alternate storage adapters.
  for (const id of rows) {
    if (typeof id !== "string" || !UUID.test(id)) {
      throw Object.assign(new Error("Invalid agent roster"), { code: "INVALID_AGENT_ROSTER" });
    }
    ids.add(id.toLowerCase());
  }
  return ids;
}

function readRoster(file) {
  if (fs.statSync(file).size > MAX_BYTES) {
    throw Object.assign(new Error("Agent roster exceeds size limit"), { code: "ROSTER_TOO_LARGE" });
  }
  const text = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(text) > MAX_BYTES) {
    throw Object.assign(new Error("Agent roster exceeds size limit"), { code: "ROSTER_TOO_LARGE" });
  }
  return JSON.parse(text);
}

/**
 * Read-only ownership guard. A failed refresh retains confirmed ownership;
 * without a valid initial roster, queries throw instead of guessing owners.
 * read/now are private seams for alternate storage and deterministic tests.
 */
function createAgentRoster(file, { read = () => readRoster(file), now = Date.now, refreshMs = 2000 } = {}) {
  if (typeof read !== "function" || typeof now !== "function" ||
      !Number.isFinite(refreshMs) || refreshMs < 0) throw new TypeError("Invalid roster options");
  let ids = null, checkedAt = null, errorCode = null;
  function status() { return { ready: ids !== null, degraded: errorCode !== null, count: ids?.size || 0, errorCode }; }
  function refresh() {
    checkedAt = now();
    try {
      const next = rosterIds(read());
      ids = next;
      errorCode = null;
    } catch (error) {
      // File paths and parser excerpts must not escape through diagnostics.
      errorCode = error?.code === "INVALID_AGENT_ROSTER" ? "invalid_roster" :
        error?.code === "ROSTER_TOO_LARGE" ? "roster_too_large" : "read_failed";
    }
    return status();
  }
  function has(id) {
    if (typeof id !== "string" || !UUID.test(id)) return false;
    const at = now();
    if (checkedAt === null || at < checkedAt || at - checkedAt >= refreshMs) refresh();
    if (ids === null) {
      throw Object.assign(new Error("No valid agent roster; leave routing unchanged"), { code: "ROSTER_UNAVAILABLE" });
    }
    return ids.has(id.toLowerCase());
  }
  return { has, refresh, status };
}

module.exports = { createAgentRoster };
