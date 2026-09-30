# Experimental client routing recovery

This optional toolkit stages and checks a routing patch for the **Windows Grok Bot 0.57.1 client**. The main switch bundle does not load or enable it. Supply your own installation; this directory contains transforms and synthetic tests, no app or host binaries. Only `0.57.1` and the exact matching coordinator/profile-bootstrap shapes are supported. Other versions and unknown source shapes fail closed.

Use **Python 3.10 or later**, with its standard library. Node.js 20 or later is needed only to run the runtime tests. No Python packages are required. Examples below use Windows PowerShell; replace the example paths with the installation and exact Electron `userData` profile directory you intend to inspect. There are no account names, identity IDs, or personal path defaults.

## Stage and verify

From the repository root:

```powershell
python experimental/client-routing/stage_client.py --install-dir 'C:\Apps\Grok Bot' --output 'C:\Staging\routing-candidate'
python experimental/client-routing/verify_client.py --install-dir 'C:\Apps\Grok Bot' --staged-dir 'C:\Staging\routing-candidate'
```

`--install-dir` must contain `resources/app.asar` and `Grok Bot.exe`. `--output` must be a **new directory outside that installation**. Staging writes only `app.asar`, `Grok Bot.exe`, and `manifest.json` there. It validates all packed payload hashes and block hashes before and after repacking, preserves entry attributes and integrity block sizes, and changes the EXE only by replacing its one exact ASAR header-hash record. Electron fuse bytes are preserved. A fully current routing patch produces an “already current” error; an older runtime with the same `box-routing-v4` marker is refreshed in full.

Verification compares both candidate files and the manifest with the exact source installation. It checks every packed entry, added/deleted entries, directory/entry metadata, the expected routing transforms, and the exact EXE pair. Exit code `0` means verified; `2` means invalid or not ready. Candidate digests establish consistency with the supplied source, not vendor authenticity. Unpacked files and link attributes are preserved in the archive header; unpacked payloads are outside the ASAR and are **not copied or verified**. The candidate directory is not a complete standalone installation.

These commands never deploy, restart a client, create a profile marker, or enable routing. They apply **only routing and profile-path bootstrap transforms**; they do not change agent-creation preferences. Keep source files stable during staging and verification, and keep a recoverable backup before a separately reviewed deployment. Do not redistribute generated vendor binaries.

## Explicit profile opt-in and health check

After separately deploying a verified candidate, routing remains native until you explicitly create an empty file named `grok-switch-box-routing` in that client's exact Electron `userData` profile directory. Creating this marker is an operator action; the tools do not do it. Each profile has its own marker and pins. Deleting the marker restores native routing on the next client start. The running coordinator reads its marker once when creating its routing store, so a restart is required after changing opt-in state. A missing profile-bootstrap path also leaves routing disabled.

```powershell
python experimental/client-routing/check_client.py --install-dir 'C:\Apps\Grok Bot' --profile 'C:\Profiles\Work'
# Repeat --profile to inspect more than one explicitly selected profile.
```

The check is read-only. It reports version support, full packed archive integrity, the embedded EXE header hash, transcript/restart wiring, exact embedded runtime content, markers, pin counts, and bounded typed health facts. It never prints cached agent UUIDs or arbitrary saved status values. `healthy` means the supported patch, integrity, and requested markers are consistent. `restartCacheReady` separately reports whether each requested profile has a valid pin cache; a newly enabled profile can be healthy before it has that cache. Saved status survives process exit and is not proof that a client is live, that the box is reachable, that the current seed succeeded, or that a UI send/reply round trip works. Missing or invalid pins require a confirmed gateway roster bootstrap; verify that seed and a send/reply round trip separately.

## Behavior and bootstrap limits

The patch learns box ownership only from a confirmed gateway roster row with no `harness` field. It retains that ownership when a later platform roster labels the same agent `temporal` or an unknown harness. Platform-only agents retain native routing. This policy relies on that roster shape in 0.57.1; it cannot discover ownership from a platform-only roster, infer which box should host an agent, or repair server-side harness records.

After a successful first gateway roster, confirmed UUIDs are saved in the profile's `grok-switch-box-agents.json` and loaded before the next roster. A fresh profile, missing cache, or corrupt cache cannot pin an agent before that first confirmation. A later confirmed roster repairs a corrupt cache. Gateway seed failures retry with bounded backoff, concurrent requests coalesce, and transport reset discards stale responses. Box-owned transcripts follow the same ownership rule as sends.

With opt-in enabled, the embedded runtime writes the pin cache and `grok-switch-routing-status.json` in that profile. Pin writes merge the disk cache under an exclusive `.lock`, retry transient failures, and attempt a final flush on stop. Writes use temporary files and rename; this provides replacement consistency, not a guarantee against power loss. Pins are additive and contain UUIDs only; health includes bounded counts, process ID, timestamps, and error codes. Pin state should be reviewed if ownership changes. Removing the marker stops the override but leaves those files on disk.

Locks are **never stolen based on age**, even if the owner appears old or is suspended. A crash can leave `grok-switch-box-agents.json.lock`. Stop every client/coordinator using that profile, verify no writer remains, then manually remove the abandoned lock before restarting. Until it is removed, in-memory ownership continues but durable writes retry and can remain unavailable. Do not remove a live owner's lock.

## Synthetic tests

```powershell
python -m unittest discover -s experimental/client-routing -p 'test_*.py'
node --test experimental/client-routing/routing.test.cjs
```

The fixtures use tiny archives, matching fragments, generated temporary profiles, and synthetic UUIDs. They do not depend on an installed client, a private source file, network access, or an actual box. They verify archive/EXE consistency, refusal paths, runtime refresh, profile isolation, native kill switch, save retries, cache repair, overlapping pin merges, lock contention, shutdown flush, health recovery, and seed reset/retry behavior. They do not prove production behavior on other client builds or validate vendor signatures after an EXE change.
