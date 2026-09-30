# Security and private data

This is an experimental local host patcher. It can change inference routing and request host restarts. Keep backups, inspect compatibility failures and restrict deployment access.

- Provider configuration contains credentials. Keep it outside the repository with owner-only access.
- Context caches, ledgers, diagnostics and request logs can contain private content or operational metadata. Do not attach them unredacted to issues.
- Keep the provider panel on loopback; do not expose it through a public tunnel.
- Install only in environments you administer. The project supplies no service-side access privileges.
- Auth/session files, official binaries and production history do not belong in contributions.

For a suspected vulnerability, use GitHub's private vulnerability reporting if the repository offers it. If unavailable, open a minimal contact request without exploit details, credentials or private data so a private channel can be arranged. There is no guaranteed response SLA for this alpha.
