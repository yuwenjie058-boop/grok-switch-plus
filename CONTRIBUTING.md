# Contributing

Start with `npm test` and `npm run test:cron` on Node.js 20+. For desktop-tool changes also run `npm run test:client` with Python 3.10+. Tests do not need real credentials, a running Bot or an installed client. Use synthetic fixtures for regression coverage.

For a bug report, include the Plus version, OS/Node version, protocol, sanitized error, reproduction steps, expected behavior and actual behavior. Host compatibility reports should identify the host/client version and failing anchor without uploading proprietary bundles. Distinguish a provider API test from a real client round trip.

Keep compatibility changes explicit and fail closed on unknown structures. Preserve upstream and dependency attribution. If editing source, run `npm run build` and commit the regenerated bundle with the source. Do not edit `dist/grok-switch.cjs` directly.

Never submit API keys, cookies, OAuth tokens, account identifiers, employee conversations, business tasks, runtime caches, real screenshots, host backups, or private network addresses. Use `example.invalid` and fictional IDs for examples. Keep logs and reports outside this checkout.

Small pull requests with a reproducible failure and relevant tests are easiest to review. Migration automation should start as a read-only preflight with synthetic tests before adding mutations. Roadmap items are proposals, not compatibility promises.
