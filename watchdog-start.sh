#!/bin/sh
# Detached launcher; enabled/disabled state remains owned by watchdog.json.
umask 077
exec /usr/bin/node /workspace/grok-switch/grok-switch.cjs watchdog run >> /workspace/grok-switch/watchdog-daemon.log 2>&1
