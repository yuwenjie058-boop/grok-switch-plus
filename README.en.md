# Grok Switch Plus

**An independently maintained model switcher for Grok Bot, with host adaptation, tool reliability, context management and guarded recovery.** [中文](README.md)

Grok Switch Plus routes inference on compatible Linux Box hosts to your configured model APIs. It ships the complete switcher, CLI and provider panel in one file; no prior upstream installation is required.

Based on [enderzcx/grok-bot-switch](https://github.com/enderzcx/grok-bot-switch), PLUS has its own source repository, maintenance and releases. It retains the upstream MIT license and attribution while extending host adaptation, continuous tool execution and operational recovery. It is a community project independent of xAI/X, and requires the existing Grok Bot host.

## What PLUS includes

- Provider management and switching through the panel or CLI, with Chat Completions, Responses and Anthropic Messages adapters and a return-to-official mode.
- Journal/tool-hook adaptation and read-only checks against the current host structure.
- Streaming argument and image-history repairs, successful polling support, and execution-machine validation.
- Explicit context capacity metadata and opt-in tool-output compaction with recoverable originals and recorded replay shapes.
- Backups, maintenance locking, loaded-runtime receipts and an opt-in update watchdog.
- Complete source, a single-file build, an offline demo and a core CI configuration covering Linux/Windows × Node 20/22/24.

**Current prerelease candidate: 0.1.0-alpha.5** ([published releases](https://github.com/yuwenjie058-boop/grok-switch-plus/releases)). The optional desktop tools add an exact-structure Windows `0.66.0` adapter while retaining `0.57.1`. Native factory digest checks and complete wiring checks reject unknown structures, and the native automation contract is preserved. Read-only health reports still set `runtimeVerified: false`. Staging and verification against a real local `0.66.0` package passed for all 582 packed entries, as did syntax checks for both transformed CJS files; real sign-in and message round trips for this public build remain unverified. Earlier context-replay repairs and upstream 0.8.5 fixes remain. See [compatibility evidence](docs/COMPATIBILITY.md), [architecture](docs/ARCHITECTURE.md), [provenance](UPSTREAM.md) and [changelog](CHANGELOG.md).

## Install or upgrade

Download `grok-switch.cjs` and its checksums from [Releases](https://github.com/yuwenjie058-boop/grok-switch-plus/releases), or build this repository. Follow [operations](docs/OPERATIONS.md) on an authorized Linux Box: back up, preflight, install, configure a provider, then verify a real client round trip. Existing upstream/Plus deployments retain their command, configuration-directory and patch-marker conventions; stop competing writers before upgrading.

Adapting to host changes is a maintenance priority. Structural adaptations and regression coverage do not certify every newer host release. The [compatibility matrix](docs/COMPATIBILITY.md) records the current evidence and remaining runtime validation.

## Quick development check

With Node.js 20+:

```sh
git clone https://github.com/yuwenjie058-boop/grok-switch-plus.git
cd grok-switch-plus
npm run demo
npm run preflight -- examples/synthetic-host.cjs --json
npm test
npm run test:cron
# Optional desktop-tool regressions (Python 3.10+ required)
npm run test:client
node dist/grok-switch.cjs help
```

The core build needs no npm install. Tests use synthetic hosts and temporary directories. The embedded panel is supplied with its source, lockfile and license notices; rebuilding it requires its own dependencies (use Node.js 22.12+).

In **0.1.0-alpha.2**, the offline demo runs the actual engine with compaction disabled/enabled on the same synthetic input: about 184k serialized characters become 12.9k, with stable replay, recoverable originals and a ledger-failure check. These are character counts, not token, cost or quality measurements. No account or network is needed.

`node dist/grok-switch.cjs preflight /path/to/host-main.cjs --json` reads the host and parses an in-memory candidate without executing it, reading provider settings or restarting anything. Exit 0 means structural eligibility; exit 2 means blocked. `runtimeVerified` always remains false. See the [compatibility matrix](docs/COMPATIBILITY.md), [demo](docs/DEMO.md), and [ledger reliability boundaries](docs/RELIABILITY.md). No complete public alpha.5 real-host build has been certified yet.

The ledger now flushes the candidate file before replacement and its parent directory on Linux, uses a cooperative writer lock and snapshot comparison, preserves corrupt state for inspection, and cancels provisional folds evicted by capacity limits. An uncertain post-rename commit blocks the provider request. This is not a distributed storage guarantee or a physical power-loss test.

## Scope of this alpha

The project focuses on obstacles encountered with our pinned older upstream baseline and subsequent host environments: successful tool loops mistaken for failures, incomplete parallel tool arguments, incompatible image history, large tool outputs, missing capacity metadata, patches overwritten by updates, and stale client routing after migration. See the [problem → solution → evidence guide](docs/OBSTACLES.md). This is not a claim that current upstream still has every issue.

- OpenAI Chat Completions, OpenAI Responses and Anthropic Messages adapters, including tool/image history degradation and streaming argument ordering fixes.
- Optional v4.1 tool-result compaction: preserve first-send shape with a durable ledger, store original content and support object-valued results. Disabled by default; start in dry-run mode.
- Explicit provider context capacity metadata, without guessing from model names.
- Opt-in watchdog with compatible-update checks, idle gates, backups, runtime receipts and failure latching.
- A narrow, disabled-by-default terminal guard for specific premature completion claims.
- An experimental local cron controller with durable slot claims and no historical catch-up. It is not wired into the default installer.
- A migration design describing identity, visible-history handoff, routing and scheduler ownership. No universal migration tool is included.
- Optional experimental [desktop routing tools](experimental/client-routing/README.md) for explicitly checked Windows `0.57.1` and `0.66.0` client structures, using Python 3.10+: generate and verify candidates, then deploy separately. An unknown structure is rejected even with a matching version number. The CI configuration covers Linux/Windows × Node 20/24 × Python 3.10/3.12. No automatic restart or ownership enrollment.
- A read-only [ownership roster core](experimental/ownership/README.md), not injected by the default installer, with UUID validation, last-good recovery and explicit cold-failure handling.

Deployment targets compatible **Linux Box hosts**, not the Windows desktop application or platform-side Temporal agents. Installing patches the host and requests a restart. Read [operations](docs/OPERATIONS.md) and [migration boundaries](docs/MIGRATION.md) first. Passing synthetic tests does not certify compatibility with arbitrary host releases.

For official Linux desktop connection and persistent-login problems, see the [Linux proxy, certificate and secure-storage guide](docs/LINUX-CLIENT.md). Its official-client sign-in and same-session reopen evidence does not establish PLUS Linux desktop patch support or complete routing compatibility.

No proprietary host/client binaries, account data, real conversations or production configuration are distributed. Context caches and runtime logs may contain private material and must remain local. The upstream experimental Codex authentication path remains in the source but is not the recommended setup path for this alpha.

See [contribution guidance](CONTRIBUTING.md), [security](SECURITY.md), [provenance](UPSTREAM.md), and [changelog](CHANGELOG.md). MIT; original copyright and third-party notices are retained.
