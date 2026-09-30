# Changelog

## 0.1.0-alpha.2 — 2026-09-30

- Add a read-only `preflight [host-path] [--json]` command sharing installer structure checks; it parses the candidate over stdin and performs no provider requests or host execution.
- Add a runnable offline compaction demonstration, synthetic host example and compatibility evidence matrix.
- Flush ledger files before replacement and parent directories on Linux; stop provider calls on uncertain post-rename commits.
- Serialize cooperating ledger writers and reject changed/corrupt snapshots instead of overwriting them. Do not automatically reclaim ambiguous locks.
- Revert new folds whose replay records were evicted by the same capacity-limited commit.
- Document finite-ledger, multi-process, Windows and physical-power-loss limitations; retain opt-in defaults.
- Simplify the README around effects, compatibility checks and deployment steps.

## 0.1.0-alpha.1 — 2026-09-30

First public Plus source snapshot, based on enderzcx/grok-bot-switch at `c612786ef8ec5e70c67fc691fea85cee1f06e724` with local enhancements.

- Protocol and tool-history repairs across Chat Completions, Responses and Messages.
- Context capacity metadata, diagnostic probing, and optional v4.1 cache/ledger compaction.
- Journal compatibility and an optional narrow terminal guard.
- Maintenance locking, loaded-runtime receipts, guarded update repair and watchdog durability tests.
- Standalone experimental cron controller and synthetic regression tests.
- Chinese/English entry documentation, deployment/recovery guidance and migration boundaries.

This is a source release for technical evaluation. Existing field deployments used related internal builds; this export is not a fresh end-to-end certification against every current desktop/host combination. No universal identity migration or automatic scheduler installation is included.
