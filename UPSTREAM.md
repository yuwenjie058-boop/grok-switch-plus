# Upstream and release provenance

- Project: https://github.com/enderzcx/grok-bot-switch
- Local source baseline: `c612786ef8ec5e70c67fc691fea85cee1f06e724`
- Original license: MIT, Copyright (c) 2026 enderzcx; retained unchanged in `LICENSE`.
- Initial public Plus version: `0.1.0-alpha.1`; alpha.2 adds public-source hardening and onboarding tools. This is a separate version line, not an upstream release or a claim that current upstream changes were merged.
- Internal source snapshot used for this export: `0.8.4-cloud.12-ctxcompact41-hardening1`.

This repository begins with a reviewed source snapshot. The private deployment workspace and its history are deliberately not included. The source snapshot contains more hardening than some field-deployed builds; field observations are not a substitute for verifying this exact release in a target environment.

Plus changes include tool-result and argument handling, context metadata/probing/compaction, journal compatibility, terminal guards, maintenance receipts and watchdog durability. The local cron controller is published separately as experimental code. Operational identity recovery scripts and private fixtures are not part of this release.

The panel is inherited from the upstream project. Its own `panel/UPSTREAM.md`, `panel/upstream.json`, and license directory record the CC Switch attribution and dependencies. The public package intentionally omits the upstream social-media mini-tool, whose installation links target upstream releases.

Compatibility anchors in the patcher describe specific host structures. The project does not distribute a complete proprietary host or desktop application. Unknown structures must be investigated using copies supplied by their authorized operator; do not attach those bundles to public issues.
