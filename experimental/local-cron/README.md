# Experimental local cron controller

`local-cron.cjs` is a dependency-injected controller, not an installer. The main bundle does not load it. Its current policy manages **only a top-level `cron` trigger** on explicitly selected Box identities. Group/union triggers and mixed event triggers are outside this snapshot's supported policy.

`createController(deps)` expects `config` (`agentIds`, `activatedAt` in milliseconds), `stateDir`, `isReady`, `isBoxHosted`, `list`, `next`, and `fire`; `now` and `log` are optional. `list()` supplies `{agentId, automation}` records. `next(automation)` returns the next due timestamp. `fire()` returns `ok`, `error`, or `interrupted`; other outcomes are recorded as not executed. Tests give a synthetic example.

```sh
npm run test:cron
```

The default module-level `managed`/`start` functions read `/home/box/agent-data/grok-switch-local-cron/config.json`. For isolated use, use `createController` with your own state directory and dependencies.

Claims use exclusive file creation and are flushed before dispatch. A claimed slot is not retried automatically, including after an uncertain delivery. This provides at-most-once dispatch attempts, **not exactly-once task completion**. A crash after claiming can leave a task unexecuted and requires operator review. Never delete receipts casually to retry jobs.

Only the current minute is eligible; historical slots are not backfilled. The integration must separately disable cloud delivery for locally managed tasks. Without that ownership gate, the controller alone cannot prevent a second scheduler from executing the same task. Do not enable this module against production tasks until that gate and native execution semantics have been verified.
