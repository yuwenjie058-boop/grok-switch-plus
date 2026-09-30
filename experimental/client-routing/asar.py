"""Standard-library ASAR parsing, integrity validation and lossless repacking."""
import hashlib
import json
import struct
from pathlib import Path

ALLOWED_CHANGES = frozenset({
    'dist/electron-main/main-app.cjs',
    'dist/node-agent-coordinator/main.cjs',
})


def load_archive(path):
    return load_archive_bytes(Path(path).read_bytes())


def load_archive_bytes(raw):
    if len(raw) < 16:
        raise ValueError('truncated ASAR header')
    size_pickle, header_size, payload_size, string_size = struct.unpack('<4I', raw[:16])
    if (size_pickle != 4 or header_size < 8 or header_size % 4
            or payload_size != header_size - 4 or string_size > header_size - 8
            or 8 + header_size > len(raw)):
        raise ValueError('invalid ASAR header bounds')
    header_bytes = raw[16:16 + string_size]
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate ASAR metadata key')
            result[key] = value
        return result
    header = json.loads(header_bytes, object_pairs_hook=unique_object)
    if not isinstance(header, dict) or not isinstance(header.get('files'), dict):
        raise ValueError('invalid ASAR file tree')
    def validate_tree(tree):
        for name, item in tree['files'].items():
            if not isinstance(name, str) or name in ('', '.', '..') or '/' in name or '\\' in name or not isinstance(item, dict):
                raise ValueError('invalid ASAR entry')
            if 'files' in item:
                if not isinstance(item['files'], dict) or any(k in item for k in ('offset', 'link', 'unpacked')):
                    raise ValueError('invalid ASAR directory')
                validate_tree(item)
            elif 'offset' in item and (item.get('unpacked') or 'link' in item):
                raise ValueError('invalid packed ASAR entry')
            elif 'offset' not in item and not (item.get('unpacked') is True or isinstance(item.get('link'), str)):
                raise ValueError('invalid ASAR leaf')
    validate_tree(header)
    return raw, header, 8 + header_size, hashlib.sha256(header_bytes).hexdigest()


def walk(tree, prefix=''):
    for name, item in tree.get('files', {}).items():
        path = prefix + '/' + name if prefix else name
        if 'files' in item:
            yield from walk(item, path)
        else:
            yield path, item


def payload_of(raw, start, item):
    if not isinstance(item.get('offset'), str) or not item['offset'].isdigit():
        raise ValueError('invalid ASAR offset')
    offset, size = int(item['offset']), item['size']
    if (not isinstance(size, int) or isinstance(size, bool)
            or offset < 0 or size < 0 or start + offset + size > len(raw)):
        raise ValueError('ASAR payload outside archive bounds')
    return raw[start + offset:start + offset + size]


def archive_problems(raw, header, start, require_integrity=False):
    """Validate every packed payload, including blocks and non-overlap bounds."""
    problems, ranges = [], []
    for path, item in walk(header):
        if 'offset' not in item:
            continue
        try:
            payload = payload_of(raw, start, item)
            ranges.append((int(item['offset']), int(item['offset']) + len(payload), path))
        except (ValueError, TypeError, KeyError) as error:
            problems.append(path + ': ' + str(error))
            continue
        integrity = item.get('integrity')
        if not integrity:
            if require_integrity:
                problems.append(path + ': missing integrity metadata')
            continue
        if not isinstance(integrity, dict) or integrity.get('algorithm') != 'SHA256':
            problems.append(path + ': unsupported integrity algorithm')
            continue
        if hashlib.sha256(payload).hexdigest() != integrity.get('hash'):
            problems.append(path + ': integrity hash mismatch')
        size = integrity.get('blockSize')
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            problems.append(path + ': invalid integrity block size')
            continue
        blocks = [hashlib.sha256(payload[i:i + size]).hexdigest()
                  for i in range(0, len(payload), size)]
        if blocks != integrity.get('blocks'):
            problems.append(path + ': integrity block mismatch')
    last_end = 0
    for begin, end, path in sorted(ranges):
        if end == begin:
            continue
        if begin < last_end:
            problems.append(path + ': overlapping packed payload')
        last_end = max(last_end, end)
    return problems



def encode_archive(header, payloads):
    """Repack packed entries; preserve all tree/entry attributes and block sizes."""
    data = bytearray()
    for path, item in sorted(((p, e) for p, e in walk(header) if 'offset' in e),
                             key=lambda pair: int(pair[1]['offset'])):
        payload = payloads[path]
        item['offset'], item['size'] = str(len(data)), len(payload)
        integrity = item.get('integrity')
        if integrity:
            size = integrity['blockSize']
            integrity['hash'] = hashlib.sha256(payload).hexdigest()
            integrity['blocks'] = [hashlib.sha256(payload[i:i + size]).hexdigest()
                                   for i in range(0, len(payload), size)]
        data.extend(payload)
    encoded = json.dumps(header, ensure_ascii=False, separators=(',', ':')).encode()
    padded = struct.pack('<I', len(encoded)) + encoded
    padded += b'\0' * (-len(padded) % 4)
    header_pickle = struct.pack('<I', len(padded)) + padded
    return struct.pack('<II', 4, len(header_pickle)) + header_pickle + data


def embedded_record(header_hash):
    return ('"alg":"SHA256","value":"' + header_hash + '"').encode()


def version_of(raw, header, start):
    item = dict(walk(header)).get('package.json')
    package = json.loads(payload_of(raw, start, item)) if item else None
    if not isinstance(package, dict):
        raise ValueError('invalid client package metadata')
    return package.get('version')


def compare_archives(original, staged):
    """Verify full integrity and restrict payload/metadata edits to routing files."""
    raw0, header0, start0, hash0 = load_archive(original)
    raw1, header1, start1, hash1 = load_archive(staged)
    problems = archive_problems(raw1, header1, start1, require_integrity=True)
    problems.extend('original ' + issue for issue in archive_problems(raw0, header0, start0, require_integrity=True))
    entries0, entries1 = dict(walk(header0)), dict(walk(header1))
    changed = []
    for path in sorted(entries0.keys() - entries1.keys()):
        problems.append(path + ': deleted archive entry')
    for path in sorted(entries1.keys() - entries0.keys()):
        problems.append(path + ': added archive entry')
    for path, item in entries1.items():
        other = entries0.get(path)
        if other is not None:
            ignored = {'offset'} | ({'size', 'integrity'} if path in ALLOWED_CHANGES else set())
            if ({k: v for k, v in item.items() if k not in ignored}
                    != {k: v for k, v in other.items() if k not in ignored}):
                problems.append(path + ': unexpected entry metadata change')
            if isinstance(other.get('integrity'), dict):
                for field in ('algorithm', 'blockSize'):
                    if not isinstance(item.get('integrity'), dict) or item['integrity'].get(field) != other['integrity'].get(field):
                        problems.append(path + ': changed integrity ' + field)
        if 'offset' in item:
            try:
                if other is None or 'offset' not in other or payload_of(raw0, start0, other) != payload_of(raw1, start1, item):
                    changed.append(path)
            except (ValueError, KeyError, TypeError):
                pass
    for path in sorted(set(changed) - ALLOWED_CHANGES):
        problems.append(path + ': unexpected payload change')
    # Directory attributes and top-level metadata are not patch targets either.
    def skeleton(tree):
        return {k: ({name: skeleton(item) for name, item in v.items()} if k == 'files' else v)
                for k, v in tree.items()} if 'files' in tree else None
    if skeleton(header0) != skeleton(header1):
        problems.append('unexpected archive tree metadata change')
    return {'entries': sum('offset' in item for item in entries1.values()),
            'changed': sorted(changed), 'originalHeaderHash': hash0, 'stagedHeaderHash': hash1,
            'integrityProblems': problems}
