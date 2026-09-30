# Upstream and release provenance

- Project: https://github.com/enderzcx/grok-bot-switch
- Original source baseline: `c612786ef8ec5e70c67fc691fea85cee1f06e724` (upstream 0.8.4).
- Reviewed upstream tip on 2026-09-30: [`2005450dc9980bc32ced742a46a1dbe3ed99bc38`](https://github.com/enderzcx/grok-bot-switch/commit/2005450dc9980bc32ced742a46a1dbe3ed99bc38), dated 2026-09-12 (upstream 0.8.5).
- Original license: MIT, Copyright (c) 2026 enderzcx; retained unchanged in `LICENSE`.
- PLUS uses an independent version line: alpha.1 publishes the enhanced source, alpha.2 adds ledger hardening and onboarding, and alpha.3 aligns the product identity and ports the upstream 0.8.5 functional fixes. PLUS is an independently maintained derivative, not an official upstream successor or a transfer of the upstream project.
- Internal source snapshot used for this export: `0.8.4-cloud.12-ctxcompact41-hardening1`.

This repository begins with a reviewed source snapshot. The private deployment workspace and its history are deliberately not included. The source snapshot contains more hardening than some field-deployed builds; field observations are not a substitute for verifying this exact release in a target environment.

## Upstream changes incorporated in alpha.3

The changes from `2005450` were reviewed and ported into the Plus source rather than replacing its enhanced modules or generated bundle:

- Preserve explicit tool `strict` settings in Chat Completions and Responses; Responses defaults to `strict: false` so optional host fields remain optional.
- Reject present but empty/non-string `machineId` values for Shell, Read and AwaitShell without dispatching or silently changing the target machine.
- Retain the distinct `invalid-machine-target` error instead of treating validation failures as malformed JSON.
- Port the upstream protocol/stream/runtime regressions and expected request fixture, extending coverage to Chat strictness.

The independent Plus version, product documentation and generated distribution replace the upstream release-number/documentation changes. There is no claim that private host adaptations or Plus additions were authored upstream. Future upstream changes should be reviewed and tested before being listed here; elapsed time since a commit is not evidence that upstream is abandoned.

Plus changes include tool-result and argument handling, context metadata/probing/compaction, journal compatibility, terminal guards, maintenance receipts and watchdog durability. The local cron controller is published separately as experimental code. Operational identity recovery scripts and private fixtures are not part of this release.

The panel is inherited from the upstream project. Its own `panel/UPSTREAM.md`, `panel/upstream.json`, and license directory record the CC Switch attribution and dependencies. The public package intentionally omits the upstream social-media mini-tool, whose installation links target upstream releases.

Compatibility anchors in the patcher describe specific host structures. The project does not distribute a complete proprietary host or desktop application. Unknown structures must be investigated using copies supplied by their authorized operator; do not attach those bundles to public issues.
