"""Verify a candidate against the exact source installation, without launching it."""
import argparse
import hashlib
import json
from pathlib import Path

from asar import compare_archives, embedded_record, load_archive, payload_of, version_of, walk
from stage_client import install_files, PATCHERS, SUPPORTED_VERSION
from patch_routing import RESTART_MARK


def verify(install_dir, staged_dir):
    original, original_exe = install_files(install_dir)
    candidate = Path(staged_dir)
    staged, exe = candidate / 'app.asar', candidate / 'Grok Bot.exe'
    result = compare_archives(original, staged)
    problems = result['integrityProblems']
    for archive in (original, staged):
        raw, header, start, _ = load_archive(archive)
        if version_of(raw, header, start) != SUPPORTED_VERSION:
            problems.append('unsupported client version')
    raw0, header0, start0, _ = load_archive(original)
    raw1, header1, start1, _ = load_archive(staged)
    entries0, entries1 = dict(walk(header0)), dict(walk(header1))
    for path, patcher in PATCHERS.items():
        try:
            expected = patcher(payload_of(raw0, start0, entries0[path]).decode('utf8')).encode('utf8')
            if payload_of(raw1, start1, entries1[path]) != expected:
                problems.append(path + ': does not match the routing transform')
        except (KeyError, TypeError, ValueError) as error:
            problems.append(path + ': ' + str(error))
    before, after = original_exe.read_bytes(), exe.read_bytes()
    old_record = embedded_record(result['originalHeaderHash'])
    new_record = embedded_record(result['stagedHeaderHash'])
    result['exeRecordOk'] = (before.count(old_record) == 1 and after.count(new_record) == 1
                            and (old_record == new_record or after.count(old_record) == 0))
    if not result['exeRecordOk'] or before.replace(old_record, new_record, 1) != after:
        problems.append('EXE is not the exact source pair with only its ASAR hash replaced')
    manifest = json.loads((candidate / 'manifest.json').read_text(encoding='utf8'))
    expected = {'clientVersion': SUPPORTED_VERSION, 'patchVersion': RESTART_MARK,
                'originalHeaderHash': result['originalHeaderHash'], 'stagedHeaderHash': result['stagedHeaderHash'],
                'changed': result['changed'], 'originalArchiveSha256': hashlib.sha256(raw0).hexdigest(),
                'archiveSha256': hashlib.sha256(raw1).hexdigest(),
                'originalExeSha256': hashlib.sha256(before).hexdigest(),
                'stagedExeSha256': hashlib.sha256(after).hexdigest(),
                'embeddedIntegrityUpdated': True, 'electronFusesChanged': False}
    if manifest != expected:
        problems.append('manifest does not match the exact candidate and source pair')
    result['healthy'] = not problems
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install-dir', required=True)
    parser.add_argument('--staged-dir', required=True)
    args = parser.parse_args()
    try:
        result = verify(args.install_dir, args.staged_dir)
        print(json.dumps(result, indent=2))
        if not result['healthy']:
            parser.exit(2, 'CLIENT-CANDIDATE-INVALID\n')
        print('CLIENT-CANDIDATE-OK')
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(2, 'CLIENT-CANDIDATE-INVALID: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
