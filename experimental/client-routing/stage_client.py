"""Stage a fresh routing-only ASAR/EXE pair without changing an installation."""
import argparse
import copy
import hashlib
import json
from pathlib import Path

from asar import (archive_problems, embedded_record, encode_archive, load_archive,
                  load_archive_bytes, payload_of, version_of, walk)
from patch_routing import RESTART_MARK
from client_versions import adapter_for


def install_files(install_dir):
    install = Path(install_dir).resolve()
    return install / 'resources' / 'app.asar', install / 'Grok Bot.exe'


def stage(install_dir, destination):
    archive, exe = install_files(install_dir)
    output = Path(destination).resolve()
    if output.is_relative_to(Path(install_dir).resolve()):
        raise ValueError('staging destination must be outside the installation')
    if output.exists():
        raise ValueError('staging destination already exists; use a fresh directory')
    raw, header, start, old_hash = load_archive(archive)
    problems = archive_problems(raw, header, start, require_integrity=True)
    if problems:
        raise ValueError('invalid source ASAR: ' + '; '.join(problems))
    version = version_of(raw, header, start)
    adapter = adapter_for(version)
    patchers = adapter.patchers
    entries = dict(walk(header))
    if not all(path in entries and 'offset' in entries[path] for path in patchers):
        raise ValueError('missing packed routing target')
    payloads = {path: payload_of(raw, start, item) for path, item in entries.items() if 'offset' in item}
    changed = []
    for path, patcher in patchers.items():
        replacement = patcher(payloads[path].decode('utf8')).encode('utf8')
        if not adapter.current(path, replacement.decode('utf8')):
            raise ValueError(path + ': routing transform produced incomplete wiring')
        if replacement != payloads[path]:
            changed.append(path)
        payloads[path] = replacement
    if not changed:
        raise ValueError('routing patch is already current; nothing to stage')
    staged_archive = encode_archive(copy.deepcopy(header), payloads)
    new_raw, new_header, new_start, new_hash = load_archive_bytes(staged_archive)
    problems = archive_problems(new_raw, new_header, new_start, require_integrity=True)
    if problems:
        raise ValueError('invalid staged ASAR: ' + '; '.join(problems))
    original_binary = exe.read_bytes()
    old_record, new_record = embedded_record(old_hash), embedded_record(new_hash)
    if original_binary.count(old_record) != 1:
        raise ValueError('source EXE must embed its ASAR header hash exactly once')
    binary = original_binary.replace(old_record, new_record, 1)
    if binary.count(new_record) != 1 or binary.count(old_record):
        raise ValueError('staged EXE integrity record is ambiguous')
    result = {'clientVersion': version, 'patchVersion': RESTART_MARK, 'changed': sorted(changed),
              'originalHeaderHash': old_hash, 'stagedHeaderHash': new_hash,
              'originalArchiveSha256': hashlib.sha256(raw).hexdigest(),
              'archiveSha256': hashlib.sha256(staged_archive).hexdigest(),
              'originalExeSha256': hashlib.sha256(original_binary).hexdigest(),
              'stagedExeSha256': hashlib.sha256(binary).hexdigest(),
              'embeddedIntegrityUpdated': True, 'electronFusesChanged': False}
    # Validate the entire pair before creating a directory. Exclusive creation
    # prevents concurrent stages from overwriting either candidate.
    output.mkdir(parents=True, exist_ok=False)
    written = []
    try:
        for name, content in [('app.asar', staged_archive), ('Grok Bot.exe', binary),
                              ('manifest.json', json.dumps(result, indent=2).encode())]:
            target = output / name
            with target.open('xb') as stream:
                written.append(target)
                stream.write(content)
    except Exception:
        for target in reversed(written):
            target.unlink(missing_ok=True)
        try:
            output.rmdir()
        except OSError:
            pass
        raise
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install-dir', required=True)
    parser.add_argument('--output', required=True, help='new directory outside the installation')
    args = parser.parse_args()
    try:
        print(json.dumps(stage(args.install_dir, args.output), indent=2))
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(2, 'CLIENT-STAGE-FAILED: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
