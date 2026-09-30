"""Synthetic archives and matching-anchor fragments; never read installed apps."""
import copy
import hashlib
import json
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import asar
import check_client
import patch_routing
import stage_client
import verify_client

MAIN, COORD = stage_client.PATCHERS


def coordinator_fixture():
    # These are only the transform's matching fragments, not an app bundle.
    return '\n'.join([
        patch_routing.ANCHOR + '}}',
        'gatewayTranscript({payload:n,legacyServerActive:o}){if(o)return null;if(!G(n))return n;',
        'let i=a??r,l=[...t.values()].some(u=>u!=="box");',
        'var Fb=require("node:crypto");', 'let f=Rb(),',
        'acceptsAgent:({agentId:E})=>f.harnessOf(E)!=="unsupported"',
        'ne.isActive({agentId:J.id})?Ue(', 'ne.isActive({agentId:J.id})?Ue(',
        patch_routing.SEED_ANCHOR,
        'bootstrap:{processConfig:{appVersion:r,isPackaged:n,dataDir:o}}',
        'l=!1,_=void 0,c.invalidateHealthCache()', 'Xt=!0,V.close(),ne.stop()',
    ]).encode()


def main_fixture():
    return (b'processConfig:{appVersion:Ib().version,isPackaged:Ae.app.isPackaged,'
            b'dataDir:(0,ca.getSandRootDir)()},artifactPath:Kxe()')


def archive(path, files, mutate=None):
    header, data = {'files': {}}, bytearray()
    for name, payload in files.items():
        node = header
        parts = name.split('/')
        for part in parts[:-1]:
            node = node['files'].setdefault(part, {'files': {}})
        size = 64
        node['files'][parts[-1]] = {
            'size': len(payload), 'offset': str(len(data)),
            'integrity': {'algorithm': 'SHA256', 'blockSize': size,
                          'hash': hashlib.sha256(payload).hexdigest(),
                          'blocks': [hashlib.sha256(payload[i:i + size]).hexdigest()
                                     for i in range(0, len(payload), size)]}}
        data.extend(payload)
    if mutate:
        mutate(header)
    encoded = json.dumps(header, separators=(',', ':')).encode()
    padded = struct.pack('<I', len(encoded)) + encoded
    padded += b'\0' * (-len(padded) % 4)
    pickle = struct.pack('<I', len(padded)) + padded
    path.write_bytes(struct.pack('<II', 4, len(pickle)) + pickle + data)
    return hashlib.sha256(encoded).hexdigest()


class ClientToolsTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.install = self.root / 'install'
        (self.install / 'resources').mkdir(parents=True)
        self.original, self.exe = stage_client.install_files(self.install)
        self.files = {MAIN: main_fixture(), COORD: coordinator_fixture(),
                      'package.json': b'{"version":"0.57.1"}', 'keep.txt': b'keep'}
        self.output = self.root / 'candidate'
        self.write_source()

    def write_source(self, mutate=None):
        digest = archive(self.original, self.files, mutate)
        self.exe.write_bytes(b'synthetic exe prefix ' + asar.embedded_record(digest) + b' suffix')

    def stage(self):
        return stage_client.stage(self.install, self.output)

    def test_stage_and_verify_exact_pair(self):
        before = self.original.read_bytes(), self.exe.read_bytes()
        result = self.stage()
        report = verify_client.verify(self.install, self.output)
        self.assertTrue(report['healthy'], report)
        self.assertEqual(result['changed'], sorted([MAIN, COORD]))
        self.assertEqual(before, (self.original.read_bytes(), self.exe.read_bytes()))

    def test_stage_has_no_creation_transform(self):
        self.stage()
        raw, header, start, _ = asar.load_archive(self.output / 'app.asar')
        expected = patch_routing.patch_client_routing_profile(main_fixture().decode()).encode()
        self.assertEqual(asar.payload_of(raw, start, dict(asar.walk(header))[MAIN]), expected)

    def test_existing_destination_rejected(self):
        self.output.mkdir()
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.stage()

    def test_install_destination_rejected(self):
        with self.assertRaisesRegex(ValueError, 'outside'):
            stage_client.stage(self.install, self.install / 'candidate')

    def test_unknown_version_rejected_without_output(self):
        self.files['package.json'] = b'{"version":"0.58.0"}'
        self.write_source()
        with self.assertRaisesRegex(ValueError, 'unsupported client version'):
            self.stage()
        self.assertFalse(self.output.exists())

    def test_unknown_coordinator_rejected(self):
        self.files[COORD] = b'unknown coordinator'
        self.write_source()
        with self.assertRaises(ValueError):
            self.stage()
        self.assertFalse(self.output.exists())

    def test_invalid_exe_leaves_no_half_pair(self):
        self.exe.write_bytes(b'no embedded record')
        with self.assertRaisesRegex(ValueError, 'exactly once'):
            self.stage()
        self.assertFalse(self.output.exists())

    def test_duplicate_exe_record_rejected(self):
        self.exe.write_bytes(self.exe.read_bytes() * 2)
        with self.assertRaisesRegex(ValueError, 'exactly once'):
            self.stage()

    def test_corrupt_source_is_not_repacked(self):
        self.original.write_bytes(self.original.read_bytes()[:-1] + b'x')
        with self.assertRaisesRegex(ValueError, 'invalid source'):
            self.stage()

    def test_missing_integrity_rejected(self):
        self.write_source(lambda h: h['files']['keep.txt'].pop('integrity'))
        with self.assertRaisesRegex(ValueError, 'missing integrity'):
            self.stage()

    def test_invalid_block_size_rejected(self):
        self.write_source(lambda h: h['files']['keep.txt']['integrity'].update(blockSize=0))
        with self.assertRaisesRegex(ValueError, 'invalid integrity block size'):
            self.stage()

    def test_overlapping_payloads_rejected(self):
        self.write_source(lambda h: h['files']['keep.txt'].update(offset='0'))
        with self.assertRaisesRegex(ValueError, 'overlapping'):
            self.stage()

    def test_invalid_header_bounds(self):
        for raw in (b'', struct.pack('<4I', 4, 8, 4, 100)):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                asar.load_archive_bytes(raw)

    def test_malformed_tree_rejected(self):
        self.write_source(lambda h: h['files'].update(bad='not an entry'))
        with self.assertRaisesRegex(ValueError, 'invalid ASAR entry'):
            self.stage()

    def test_truncated_payload_rejected(self):
        self.original.write_bytes(self.original.read_bytes()[:-2])
        with self.assertRaisesRegex(ValueError, 'bounds'):
            self.stage()

    def test_exe_outside_record_change_rejected(self):
        self.stage()
        exe = self.output / 'Grok Bot.exe'
        exe.write_bytes(b'extra' + exe.read_bytes())
        report = verify_client.verify(self.install, self.output)
        self.assertFalse(report['healthy'])
        self.assertTrue(any('EXE is not' in p for p in report['integrityProblems']))

    def test_manifest_tamper_rejected(self):
        self.stage()
        (self.output / 'manifest.json').write_text('{}')
        self.assertFalse(verify_client.verify(self.install, self.output)['healthy'])

    def changed_archive(self, mutate_files=None, mutate_header=None):
        staged = self.root / 'different.asar'
        files = copy.deepcopy(self.files)
        if mutate_files:
            mutate_files(files)
        archive(staged, files, mutate_header)
        return asar.compare_archives(self.original, staged)['integrityProblems']

    def test_unexpected_payload_change_rejected(self):
        self.assertIn('keep.txt: unexpected payload change', self.changed_archive(lambda f: f.update({'keep.txt': b'changed'})))

    def test_deleted_entry_rejected(self):
        self.assertIn('keep.txt: deleted archive entry', self.changed_archive(lambda f: f.pop('keep.txt')))

    def test_added_entry_rejected(self):
        self.assertIn('extra.txt: added archive entry', self.changed_archive(lambda f: f.update({'extra.txt': b'extra'})))

    def test_directory_metadata_change_rejected(self):
        self.assertIn('unexpected archive tree metadata change', self.changed_archive(mutate_header=lambda h: h['files']['dist'].update(executable=True)))

    def test_entry_metadata_change_rejected(self):
        self.assertIn('keep.txt: unexpected entry metadata change', self.changed_archive(mutate_header=lambda h: h['files']['keep.txt'].update(executable=True)))

    def test_unpacked_and_link_entries_preserved(self):
        self.write_source(lambda h: h['files'].update({'external': {'size': 4, 'unpacked': True}, 'alias': {'link': 'keep.txt'}}))
        self.stage()
        self.assertTrue(verify_client.verify(self.install, self.output)['healthy'])

    def test_output_io_failure_cleans_candidates(self):
        open_original = Path.open
        # Match staging's canonical path, including Windows short-path aliases.
        manifest_path = (self.output / 'manifest.json').resolve()
        def fail_manifest(path, *args, **kwargs):
            if path == manifest_path:
                raise OSError('synthetic write failure')
            return open_original(path, *args, **kwargs)
        with patch.object(Path, 'open', fail_manifest), self.assertRaises(OSError):
            self.stage()
        self.assertFalse(self.output.exists())

    def test_patch_idempotent_and_same_version_refresh(self):
        current = patch_routing.patch_coordinator(coordinator_fixture().decode())
        self.assertEqual(patch_routing.patch_coordinator(current), current)
        stale = current.replace('    delete __gsHealth.statusWriteError;\n', '', 1)
        self.assertNotEqual(stale, current)
        self.assertEqual(patch_routing.patch_coordinator(stale), current)

    def test_incomplete_current_patch_rejected(self):
        current = patch_routing.patch_coordinator(coordinator_fixture().decode())
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            patch_routing.patch_coordinator(current.replace('f.__gsStop()', 'missing()', 1))

    def test_main_profile_patch_idempotent(self):
        current = patch_routing.patch_client_routing_profile(main_fixture().decode())
        self.assertEqual(patch_routing.patch_client_routing_profile(current), current)
        with self.assertRaises(ValueError):
            patch_routing.patch_client_routing_profile('unknown bootstrap')

    def test_checker_enabled_healthy_but_unseeded(self):
        self.stage()
        fixture_install = self.root / 'patched-install'
        (fixture_install / 'resources').mkdir(parents=True)
        (fixture_install / 'resources' / 'app.asar').write_bytes((self.output / 'app.asar').read_bytes())
        (fixture_install / 'Grok Bot.exe').write_bytes((self.output / 'Grok Bot.exe').read_bytes())
        profile = self.root / 'profile'
        profile.mkdir()
        (profile / check_client.MARKER).touch()
        result = check_client.inspect_install(fixture_install, [profile])
        self.assertTrue(result['healthy'], result)
        self.assertFalse(result['restartCacheReady'])
        (profile / check_client.MARKER).unlink()
        self.assertFalse(check_client.inspect_install(fixture_install, [profile])['healthy'])

    def test_profile_report_does_not_expose_pin_ids(self):
        profile = self.root / 'profile'
        profile.mkdir()
        identifier = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        (profile / 'grok-switch-box-agents.json').write_text(json.dumps({'version': 1, 'agentIds': [identifier]}))
        result = check_client.profile_metadata(profile)
        self.assertEqual(result['pinCount'], 1)
        self.assertNotIn(identifier, json.dumps(result))

    def test_profile_status_discards_nested_or_arbitrary_values(self):
        profile = self.root / 'profile'
        profile.mkdir()
        (profile / 'grok-switch-routing-status.json').write_text(json.dumps({
            'patchVersion': 'private conversation', 'cacheReadError': {'apiKey': 'synthetic-secret'},
            'cacheWriteError': 'synthetic-secret', 'pid': True, 'loadedCount': float('inf'),
            'boxCount': -1, 'startedAt': 'synthetic-secret', 'updatedAt': '2026-99-99T99:99:99.000Z',
            'seedState': 'synthetic-secret', 'seedAttempts': 2 ** 40, 'enabled': 'synthetic-secret'}))
        result = check_client.profile_metadata(profile)
        self.assertEqual(result['lastRecordedStatus'], {})
        self.assertEqual(result['statusError'], 'invalid_status')
        self.assertNotIn('synthetic-secret', json.dumps(result))
        self.assertNotIn('private conversation', json.dumps(result))

    def test_profile_status_accepts_bounded_typed_facts(self):
        status = {'patchVersion': patch_routing.RESTART_MARK, 'pid': 42, 'enabled': True,
                  'loadedCount': 1, 'boxCount': 2, 'seedAttempts': 3, 'seedState': 'ready',
                  'startedAt': '2026-09-30T09:00:00.000Z', 'cacheWriteError': 'EEXIST'}
        self.assertEqual(check_client.bounded_status(status), (status, True))
        self.assertEqual(check_client.bounded_status(['synthetic-secret']), ({}, False))

    def test_pin_version_boolean_is_rejected_like_runtime(self):
        profile = self.root / 'profile'
        profile.mkdir()
        cache = profile / 'grok-switch-box-agents.json'
        cache.write_text(json.dumps({'version': True, 'agentIds': []}))
        self.assertFalse(check_client.profile_metadata(profile)['pinCacheValid'])
        cache.write_text(json.dumps({'version': 1.0, 'agentIds': []}))
        self.assertTrue(check_client.profile_metadata(profile)['pinCacheValid'])

    def test_current_patch_cannot_be_staged_again(self):
        self.files[MAIN] = patch_routing.patch_client_routing_profile(main_fixture().decode()).encode()
        self.files[COORD] = patch_routing.patch_coordinator(coordinator_fixture().decode()).encode()
        self.write_source()
        with self.assertRaisesRegex(ValueError, 'already current'):
            self.stage()
        self.assertFalse(self.output.exists())

    def test_invalid_package_shape_fails_cleanly(self):
        self.files['package.json'] = b'[]'
        self.write_source()
        with self.assertRaisesRegex(ValueError, 'invalid client package'):
            self.stage()

    def test_duplicate_archive_metadata_keys_rejected(self):
        encoded = b'{"files":{},"files":{}}'
        padded = struct.pack('<I', len(encoded)) + encoded
        padded += b'\0' * (-len(padded) % 4)
        pickle = struct.pack('<I', len(padded)) + padded
        raw = struct.pack('<II', 4, len(pickle)) + pickle
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            asar.load_archive_bytes(raw)

    def test_ambiguous_bootstrap_rejected(self):
        source = main_fixture().decode()
        current = patch_routing.patch_client_routing_profile(source)
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            patch_routing.patch_client_routing_profile(current + source)

    def test_checker_rejects_current_marker_with_stale_runtime(self):
        self.files[MAIN] = patch_routing.patch_client_routing_profile(main_fixture().decode()).encode()
        current = patch_routing.patch_coordinator(coordinator_fixture().decode())
        self.files[COORD] = current.replace('    delete __gsHealth.statusWriteError;\n', '', 1).encode()
        self.write_source()
        profile = self.root / 'profile'
        profile.mkdir()
        (profile / check_client.MARKER).touch()
        result = check_client.inspect_install(self.install, [profile])
        self.assertEqual(result['patchVersion'], patch_routing.RESTART_MARK)
        self.assertFalse(result['routingRuntimeCurrent'])
        self.assertFalse(result['healthy'])

    def test_cli_requires_explicit_paths(self):
        for filename in ('stage_client.py', 'verify_client.py', 'check_client.py'):
            result = subprocess.run([sys.executable, str(Path(__file__).with_name(filename))], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('--install-dir', result.stderr)


if __name__ == '__main__':
    unittest.main()
