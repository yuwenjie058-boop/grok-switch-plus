"""Read-only installation and explicit-profile routing health check."""
import argparse
import datetime
import json
import re
from pathlib import Path

from patch_routing import RESTART_MARK
from asar import load_archive, walk, payload_of, archive_problems
from client_versions import adapter_for, SUPPORTED_VERSIONS, MAIN

MARKER = 'grok-switch-box-routing'
GUARD = '__gsBoxRouting'
COORD = 'dist/node-agent-coordinator/main.cjs'


UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
ERROR_CODES = frozenset({'EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'EBUSY', 'EIO',
    'ENOSPC', 'EMFILE', 'ENFILE', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG', 'EROFS',
    'EINVAL', 'EBADF', 'ENOTEMPTY', 'ELOOP', 'EXDEV', 'ENOTSUP',
    'invalid_cache', 'cache_too_large', 'write_failed'})


def bounded_status(status):
    """Treat saved status as untrusted input: report only typed routing facts."""
    if not isinstance(status, dict):
        return {}, False
    result, valid = {}, True
    for key, value in status.items():
        if key == 'patchVersion':
            ok = value == RESTART_MARK
        elif key == 'enabled':
            ok = isinstance(value, bool)
        elif key in ('pid', 'loadedCount', 'boxCount', 'seedAttempts'):
            limit = 10000 if key in ('loadedCount', 'boxCount') else 2 ** 31 - 1
            ok = isinstance(value, int) and not isinstance(value, bool) and (1 if key == 'pid' else 0) <= value <= limit
        elif key in ('startedAt', 'updatedAt'):
            ok = isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value) is not None
            if ok:
                try:
                    datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
                except ValueError:
                    ok = False
        elif key == 'seedState':
            ok = isinstance(value, str) and value in {'loading', 'ready', 'retrying', 'disconnected', 'stopped'}
        elif key in ('cacheReadError', 'cacheWriteError'):
            ok = isinstance(value, str) and value in ERROR_CODES
        else:
            continue
        if ok:
            result[key] = value
        else:
            valid = False
    return result, valid


def profile_metadata(profile):
    """Report only bounded routing facts, never identity UUIDs or credentials."""
    profile = Path(profile)
    result = {'path': str(profile), 'marker': (profile / MARKER).is_file(),
              'pinCacheValid': False, 'pinCount': 0}
    try:
        cache = profile / 'grok-switch-box-agents.json'
        if cache.stat().st_size > 2 * 1024 * 1024:
            raise ValueError('cache_too_large')
        pins = json.loads(cache.read_text(encoding='utf8'))
        ids = pins.get('agentIds') if isinstance(pins, dict) else None
        valid = (not isinstance(pins.get('version'), bool) and pins.get('version') == 1
                 and isinstance(ids, list) and len(ids) <= 10000
                 and all(isinstance(i, str) and UUID.fullmatch(i) for i in ids)) if isinstance(pins, dict) else False
        if not valid:
            raise ValueError('invalid_cache')
        result.update(pinCacheValid=True, pinCount=len(set(ids)))
    except (OSError, ValueError, TypeError) as error:
        result['pinCacheError'] = 'missing_cache' if isinstance(error, FileNotFoundError) else 'invalid_cache'
    try:
        status_file = profile / 'grok-switch-routing-status.json'
        if status_file.stat().st_size > 64 * 1024:
            raise ValueError('status_too_large')
        status = json.loads(status_file.read_text(encoding='utf8'))
        result['lastRecordedStatus'], valid = bounded_status(status)
        result['statusAvailable'] = True
        if not valid:
            result['statusError'] = 'invalid_status'
        # A saved status survives process exit; it is not a liveness assertion.
    except (OSError, ValueError, TypeError) as error:
        result['statusAvailable'] = False
        result['statusError'] = 'missing_status' if isinstance(error, FileNotFoundError) else 'invalid_status'
    return result


def inspect_install(install, profiles):
    install = Path(install)
    asar = install / 'resources' / 'app.asar'
    exe = install / 'Grok Bot.exe'
    result = {'install': str(install), 'asarFound': asar.is_file(), 'exeFound': exe.is_file()}
    if not (result['asarFound'] and result['exeFound']):
        result['healthy'] = False
        return result
    try:
        raw, header, start, header_hash = load_archive(asar)
        problems = archive_problems(raw, header, start, require_integrity=True)
    except (OSError, ValueError, KeyError, TypeError) as error:
        result.update(healthy=False, integrityProblems=[str(error)])
        return result
    patched = integrity_ok = None
    transcript_routing = restart_routing = profile_bootstrap = runtime_current = False
    version = patch_version = None
    sources = {}
    for path, item in walk(header):
        if path in (MAIN, COORD):
            try:
                sources[path] = payload_of(raw, start, item).decode('utf8')
            except (ValueError, KeyError, TypeError, UnicodeError):
                pass
        if path == COORD:
            try:
                payload = payload_of(raw, start, item)
            except (ValueError, KeyError, TypeError):
                continue
            src = payload.decode('utf8', 'replace')
            patched = GUARD in src
            transcript_routing = "__gsOwnsBox" in src
            restart_routing = all(mark in src for mark in [
                RESTART_MARK, 'Rb({dataDir:r.processConfig.boxRoutingProfileDir})',
                '__gsSeedController?.reset()', '__gsSeedController?.stop()',
                'Xt=!0,f.__gsStop(),__gsSeedController?.stop(),V.close(),ne.stop()'])
            detected = re.search(r'patchVersion:\s*[\'"](box-routing-v\d+)[\'"]', src)
            patch_version = detected.group(1) if detected else None
            integrity_ok = not any(issue.startswith(COORD + ':') for issue in problems)
            runtime_head, runtime_tail = 'function __gsRoutingDir(options = {}) {', 'var Fb=require("node:crypto");'
            expected_runtime = Path(__file__).with_name('box-routing-store.cjs').read_text(encoding='utf8')
            expected_runtime = expected_runtime[expected_runtime.index(runtime_head):].strip()
            if src.count(runtime_head) == 1 and src.count(runtime_tail) == 1:
                begin, end = src.index(runtime_head), src.index(runtime_tail)
                runtime_current = end > begin and src[begin:end].strip() == expected_runtime
        if path == 'dist/electron-main/main-app.cjs':
            try:
                profile_bootstrap = b'boxRoutingProfileDir:Ae.app.getPath("userData")' in payload_of(raw, start, item)
            except (ValueError, KeyError, TypeError):
                pass
        if path == 'package.json':
            try:
                version = json.loads(payload_of(raw, start, item)).get('version')
            except Exception:
                pass
    wiring_current = False
    if version in SUPPORTED_VERSIONS:
        adapter = adapter_for(version)
        wiring_current = all(adapter.current(path, sources.get(path, '')) for path in (MAIN, COORD))
        if version == '0.66.0':
            module = adapter.module
            src = sources.get(COORD, '')
            expected_runtime = module.routing_runtime()
            runtime_current = src.count(expected_runtime) == 1
            transcript_routing = src.count(module.READ_PATCHED) == 2
            restart_routing = all(src.count(after) == 1 for _, after in module.wiring())
            profile_bootstrap = adapter.current(MAIN, sources.get(MAIN, ''))
    binary = exe.read_bytes()
    record = ('"alg":"SHA256","value":"' + header_hash + '"').encode()
    profile_results = {f'profile{index + 1}': profile_metadata(path) for index, path in enumerate(profiles)}
    markers = {name: value['marker'] for name, value in profile_results.items()}
    result.update({'clientVersion': version, 'coordinatorPatched': patched,
                   'clientVersionSupported': version in SUPPORTED_VERSIONS,
                   'coordinatorIntegrityOk': integrity_ok, 'transcriptRoutingPatched': transcript_routing,
                   'restartRoutingPatched': restart_routing, 'profileBootstrapPatched': profile_bootstrap,
                   'patchVersion': patch_version, 'expectedPatchVersion': RESTART_MARK,
                   'routingRuntimeCurrent': runtime_current,
                   'routingWiringCurrent': wiring_current, 'runtimeVerified': False,
                   'integrityProblems': problems, 'archiveIntegrityOk': not problems,
                   'packedEntriesChecked': sum('offset' in item for _, item in walk(header)),
                   'exeEmbedsAsarHeaderHash': binary.count(record) == 1,
                   'markers': markers, 'profiles': profile_results,
                   'restartCacheReady': bool(profile_results) and all(p['pinCacheValid'] for p in profile_results.values())})
    healthy = bool(wiring_current and patched and transcript_routing and restart_routing and profile_bootstrap and runtime_current
                   and integrity_ok and not problems and result['exeEmbedsAsarHeaderHash']
                   and result['clientVersionSupported']
                   and bool(markers) and all(markers.values()))
    result['healthy'] = healthy
    return result



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install-dir', required=True)
    parser.add_argument('--profile', required=True, action='append', help='exact Electron userData directory; repeat for additional profiles')
    args = parser.parse_args()
    try:
        result = inspect_install(args.install_dir, args.profile)
        print(json.dumps(result, indent=2))
        print('CLIENT-ROUTING-OK' if result['healthy'] else 'CLIENT-ROUTING-NOT-READY')
        return 0 if result['healthy'] else 2
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(2, 'CLIENT-ROUTING-NOT-READY: ' + str(error) + '\n')


if __name__ == '__main__':
    raise SystemExit(main())
