# Validated ownership roster

This read-only core packages the roster validation and last-good-state rule from a field fix. It is **not injected by the default installer**, does not change an agent harness, and does not authorize any platform migration.

```js
const { createAgentRoster } = require('./agent-roster.cjs');
const roster = createAgentRoster('/your/private/confirmed-agents.json');
try {
  if (roster.has(agentId)) {
    // The embedding application may apply its existing local-ownership policy.
  }
} catch (error) {
  if (error.code === 'ROSTER_UNAVAILABLE') {
    // Stop the ownership decision. Preserve existing routing; do not guess.
  } else throw error;
}
```

Accepts a non-empty array of UUIDs or `{ "agents": [...] }`, at most 10,000 entries and 2 MiB. UUID comparisons are case-insensitive. Every entry must validate; partial lists and empty lists are rejected. A valid later roster may intentionally remove previously confirmed IDs. Disable the embedding ownership policy explicitly to remove all ownership.

`has(id)` lazily refreshes at most once every two seconds (also after clock rollback). `refresh()` forces a read and returns metadata; it never treats a failed read as an empty roster. `status()` reports only readiness, degradation, count and a bounded error code. A failed refresh retains the last valid roster; without one, a valid-ID query throws `ROSTER_UNAVAILABLE` on every call until repair. Invalid lookup IDs return false.

The caller must decide whether degraded last-good state is acceptable and handle the cold error before changing routes. `ready` means a valid snapshot exists, not that the last refresh succeeded; check `degraded` as well. No automatically broadened ownership, server patch anchors, account identifiers, network access or background timers are included.

Tests: `node --test experimental/ownership/agent-roster.test.cjs`. `read` and `now` options allow alternate storage adapters and deterministic fault tests.
