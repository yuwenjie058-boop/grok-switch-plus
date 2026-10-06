# Changelog

## 0.1.0-alpha.4 — 2026-09-30

- Preserve recorded context-fold shapes after threshold or head/tail changes, including zero-length recorded edges. Centralize replay policy selection without weakening ledger commit protections.
- Keep the bounded object scan ahead of replay hashing, so oversized shared subtrees cannot bypass its existing refusal guard; retain the accepted legacy digest domain for recorded replay.
- Add opt-in desktop routing recovery tools for the explicitly supported 0.57.1 structure: per-profile confirmed ownership, persistence retry and merge protection, reconnect seeding, candidate-only staging and whole-archive/EXE verification.
- Compare full embedded routing code as well as its version marker, so same-version corrections are not silently skipped.
- Add a read-only validated ownership roster core that retains last-good state after malformed updates and blocks cold ownership decisions when no valid roster exists.
- Separate ASAR integrity, patch adaptation and routing state behind focused interfaces; add synthetic fault tests and Linux/Windows client-tool CI.
- Keep desktop tools and ownership policy outside the default Linux Box installer. No automatic identity migration, task import, account enrollment or universal new-version compatibility is implied.

## 0.1.0-alpha.3 — 2026-09-30

- Present PLUS as an independently maintained, complete Grok Bot model switcher, with product capabilities and installation/upgrade paths first.
- Align the configuration panel, CLI identity and package metadata with Grok Switch Plus; retain configuration paths, command filenames and patch markers for existing deployments.
- Port upstream 0.8.5 (`2005450`) tool strictness and machine-target validation fixes, preserving the distinct validation error and adding the upstream regressions to the combined Plus build.
- Keep existing host adaptation, tool-history repairs, context compaction and guarded recovery; retain upstream and third-party attribution.
- Publish compatibility evidence separately from the product positioning: structural checks and synthetic tests do not certify arbitrary new host releases.

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
