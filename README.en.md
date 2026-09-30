# Grok Switch Plus

Reusable fixes and lessons from running grok-switch beyond initial model switching. [中文](README.md)

Derived from [enderzcx/grok-bot-switch](https://github.com/enderzcx/grok-bot-switch), under MIT. The upstream supplies the routing foundation, CLI and provider panel. This repository packages additional tool-protocol repairs, context compaction, maintenance locking and watchdog recovery. It is independent of xAI/X and does not provide a complete self-hosted Grok Bot.

## Quick development check

With Node.js 20+:

```sh
git clone https://github.com/yuwenjie058-boop/grok-switch-plus.git
cd grok-switch-plus
npm test
npm run test:cron
node dist/grok-switch.cjs help
```

The core build needs no npm install. Tests use synthetic hosts and temporary directories. The embedded panel is supplied with its source, lockfile and license notices; rebuilding it requires its own dependencies (use Node.js 22.12+).

## Scope of this alpha

The project focuses on obstacles encountered with our pinned older upstream baseline and subsequent host environments: successful tool loops mistaken for failures, incomplete parallel tool arguments, incompatible image history, large tool outputs, missing capacity metadata, patches overwritten by updates, and stale client routing after migration. See the [problem → solution → evidence guide](docs/OBSTACLES.md). This is not a claim that current upstream still has every issue.

- OpenAI Chat Completions, OpenAI Responses and Anthropic Messages adapters, including tool/image history degradation and streaming argument ordering fixes.
- Optional v4.1 tool-result compaction: preserve first-send shape with a durable ledger, store original content and support object-valued results. Disabled by default; start in dry-run mode.
- Explicit provider context capacity metadata, without guessing from model names.
- Opt-in watchdog with compatible-update checks, idle gates, backups, runtime receipts and failure latching.
- A narrow, disabled-by-default terminal guard for specific premature completion claims.
- An experimental local cron controller with durable slot claims and no historical catch-up. It is not wired into the default installer.
- A migration design describing identity, visible-history handoff, routing and scheduler ownership. No universal migration tool is included.

Deployment targets compatible **Linux Box hosts**, not the Windows desktop application or platform-side Temporal agents. Installing patches the host and requests a restart. Read [operations](docs/OPERATIONS.md) and [migration boundaries](docs/MIGRATION.md) first. Passing synthetic tests does not certify compatibility with arbitrary host releases.

No proprietary host/client binaries, account data, real conversations or production configuration are distributed. Context caches and runtime logs may contain private material and must remain local. The upstream experimental Codex authentication path remains in the source but is not the recommended setup path for this alpha.

See [contribution guidance](CONTRIBUTING.md), [security](SECURITY.md), [provenance](UPSTREAM.md), and [changelog](CHANGELOG.md). MIT; original copyright and third-party notices are retained.
