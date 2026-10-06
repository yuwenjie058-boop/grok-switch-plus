"""Version registry integration on synthetic archives and disposable profiles."""
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import asar
import check_client
import client_versions
import patch_routing_066 as adapter066
import stage_client
import verify_client
from test_client_tools import archive, coordinator_fixture as coordinator057, main_fixture as main057
from test_routing_066 import SYNTHETIC_DIGEST, coordinator_fixture as coordinator066

MAIN, COORD = client_versions.MAIN, client_versions.COORD


class ClientVersionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.install = self.root / 'source'
        self.output = self.root / 'candidate'
        self.profile = self.root / 'profile'
        self.profile.mkdir()
        (self.profile / check_client.MARKER).write_text('')
        # Only the synthetic factory fingerprint is substituted. Real adapter
        # defaults retain the exact, audited native 0.66 factory digest.
        digest = patch.object(adapter066, 'NATIVE_ROSTER_SHA256', SYNTHETIC_DIGEST)
        digest.start()
        self.addCleanup(digest.stop)
        self.files = self.files_for('0.66.0')
        self.write_install(self.install, self.files)

    @staticmethod
    def files_for(version):
        return {
            MAIN: adapter066.MAIN_ANCHOR.encode() if version == '0.66.0' else main057(),
            COORD: coordinator066().encode() if version == '0.66.0' else coordinator057(),
            'package.json': json.dumps({'version': version}).encode(),
            'untouched.txt': b'synthetic unrelated payload',
        }

    @staticmethod
    def write_install(directory, files):
        original, exe = stage_client.install_files(directory)
        original.parent.mkdir(parents=True, exist_ok=True)
        digest = archive(original, files)
        exe.write_bytes(b'synthetic binary ' + asar.embedded_record(digest) + b' unchanged suffix')

    def candidate_install(self, mutate=None):
        raw, header, start, _ = asar.load_archive(self.output / 'app.asar')
        files = {name: asar.payload_of(raw, start, item) for name, item in asar.walk(header)}
        if mutate:
            mutate(files)
        installed = self.root / 'isolated-candidate'
        self.write_install(installed, files)
        # Use the actual staged EXE for an unmodified candidate; mutations use a
        # correctly rehashed synthetic pair so integrity cannot mask wiring bugs.
        if not mutate:
            shutil.copyfile(self.output / 'Grok Bot.exe', installed / 'Grok Bot.exe')
        return installed

    def test_066_stage_verify_and_health_preserve_exact_source(self):
        original, exe = stage_client.install_files(self.install)
        before = original.read_bytes(), exe.read_bytes()
        staged = stage_client.stage(self.install, self.output)
        self.assertEqual(staged['clientVersion'], '0.66.0')
        self.assertEqual(staged['changed'], sorted([MAIN, COORD]))
        self.assertFalse(staged['electronFusesChanged'])
        verified = verify_client.verify(self.install, self.output)
        self.assertTrue(verified['healthy'], verified)
        self.assertEqual(before, (original.read_bytes(), exe.read_bytes()))
        healthy = check_client.inspect_install(self.candidate_install(), [self.profile])
        for field in ('healthy', 'clientVersionSupported', 'routingWiringCurrent',
                      'routingRuntimeCurrent', 'profileBootstrapPatched',
                      'transcriptRoutingPatched', 'restartRoutingPatched',
                      'archiveIntegrityOk', 'exeEmbedsAsarHeaderHash'):
            self.assertTrue(healthy[field], (field, healthy))
        self.assertFalse(healthy['runtimeVerified'])
        self.assertFalse(healthy['restartCacheReady'])
        self.assertEqual(sorted(p.name for p in self.profile.iterdir()), [check_client.MARKER])

    def test_both_known_versions_select_their_own_patchers(self):
        self.assertEqual(set(client_versions.SUPPORTED_VERSIONS), {'0.57.1', '0.66.0'})
        self.assertEqual(client_versions.adapter_for('0.57.1').module.__name__, 'patch_routing')
        self.assertEqual(client_versions.adapter_for('0.66.0').module.__name__, 'patch_routing_066')
        for version in client_versions.SUPPORTED_VERSIONS:
            with self.subTest(version=version):
                source, destination = self.root / version, self.root / (version + '-candidate')
                self.write_install(source, self.files_for(version))
                stage_client.stage(source, destination)
                self.assertTrue(verify_client.verify(source, destination)['healthy'])

    def test_unknown_versions_fail_before_staging_any_output(self):
        for index, version in enumerate(('0.66.1', '0.99.0', None, 66, ['0.66.0'])):
            with self.subTest(version=version):
                source = self.root / ('unknown-' + str(index))
                destination = self.root / ('unknown-candidate-' + str(index))
                self.write_install(source, {**self.files,
                    'package.json': json.dumps({'version': version}).encode()})
                with self.assertRaisesRegex(ValueError, 'unsupported client version'):
                    stage_client.stage(source, destination)
                self.assertFalse(destination.exists())
                report = check_client.inspect_install(source, [self.profile])
                self.assertFalse(report['healthy'])
                self.assertFalse(report['clientVersionSupported'])

    def test_old_bundle_disguised_as_066_is_rejected(self):
        files = self.files_for('0.57.1')
        files['package.json'] = b'{"version":"0.66.0"}'
        self.write_install(self.install, files)
        with self.assertRaises(ValueError):
            stage_client.stage(self.install, self.output)
        self.assertFalse(self.output.exists())
        self.assertFalse(check_client.inspect_install(self.install, [self.profile])['healthy'])

    def test_old_coordinator_with_new_main_is_still_rejected(self):
        self.files[COORD] = coordinator057()
        self.write_install(self.install, self.files)
        with self.assertRaisesRegex(ValueError, '0.66 harness factory'):
            stage_client.stage(self.install, self.output)
        self.assertFalse(self.output.exists())

    def test_candidate_from_another_supported_version_is_rejected(self):
        old = self.root / 'old-source'
        self.write_install(old, self.files_for('0.57.1'))
        stage_client.stage(old, self.output)
        report = verify_client.verify(self.install, self.output)
        self.assertFalse(report['healthy'])
        self.assertIn('candidate client version differs from source', report['integrityProblems'])

    def test_unknown_source_version_rejected_by_verifier(self):
        stage_client.stage(self.install, self.output)
        self.files['package.json'] = b'{"version":"0.67.0"}'
        self.write_install(self.install, self.files)
        with self.assertRaisesRegex(ValueError, 'unsupported client version'):
            verify_client.verify(self.install, self.output)

    def test_missing_066_wiring_rejected_even_when_archive_integrity_is_valid(self):
        stage_client.stage(self.install, self.output)
        variants = [(COORD, after, before) for before, after in adapter066.wiring()]
        variants.extend([
            (COORD, adapter066.READ_PATCHED, adapter066.READ_ANCHOR),
            (MAIN, adapter066.MAIN_PATCHED, adapter066.MAIN_ANCHOR),
        ])
        for path, after, before in variants:
            with self.subTest(anchor=after[:60]):
                def mutate(files):
                    self.assertIn(after.encode(), files[path])
                    files[path] = files[path].replace(after.encode(), before.encode(), 1)
                source = self.candidate_install(mutate)
                report = check_client.inspect_install(source, [self.profile])
                self.assertTrue(report['archiveIntegrityOk'])
                self.assertTrue(report['exeEmbedsAsarHeaderHash'])
                self.assertFalse(report['healthy'])
                self.assertFalse(report['routingWiringCurrent'])

    def test_stale_066_runtime_is_not_healthy(self):
        stage_client.stage(self.install, self.output)
        def stale(files):
            files[COORD] = files[COORD].replace(b'const staleBoxAutomations = [];',
                b'const staleBoxAutomations = []; /* stale owned runtime */', 1)
        report = check_client.inspect_install(self.candidate_install(stale), [self.profile])
        self.assertTrue(report['archiveIntegrityOk'])
        self.assertFalse(report['routingRuntimeCurrent'])
        self.assertFalse(report['routingWiringCurrent'])
        self.assertFalse(report['healthy'])

    def write_incomplete_legacy_v3(self):
        adapter = client_versions.adapter_for('0.57.1')
        files = self.files_for('0.57.1')
        for path, patcher in adapter.patchers.items():
            files[path] = patcher(files[path].decode()).encode()
        replacements = [
            (b'box-routing-v4', b'box-routing-v3'),
            (b'Xt=!0,f.__gsStop(),__gsSeedController?.stop(),V.close(),ne.stop()',
             b'Xt=!0,__gsSeedController?.stop(),V.close(),ne.stop()'),
            (b'acceptsAgent:({agentId:E})=>!f.__gsOwnsBox(E)&&f.harnessOf(E)',
             b'acceptsAgent:({agentId:E})=>f.harnessOf(E)'),
        ]
        for before, after in replacements:
            self.assertEqual(files[COORD].count(before), 1)
            files[COORD] = files[COORD].replace(before, after, 1)
        self.write_install(self.install, files)

    def test_incomplete_legacy_v3_upgrade_rejected_without_output(self):
        self.write_incomplete_legacy_v3()
        with self.assertRaises(ValueError):
            stage_client.stage(self.install, self.output)
        self.assertFalse(self.output.exists())

    def test_previously_staged_incomplete_legacy_v3_candidate_is_invalid(self):
        self.write_incomplete_legacy_v3()
        # Reproduce a candidate from the old staging behavior, which had no
        # post-transform current-wiring gate. Verification runs without this
        # bypass, against the unchanged real adapter validation.
        with patch.object(client_versions.ClientAdapter, 'current', return_value=True):
            stage_client.stage(self.install, self.output)
        report = verify_client.verify(self.install, self.output)
        self.assertTrue(report['exeRecordOk'])
        self.assertFalse(report['healthy'])


if __name__ == '__main__':
    unittest.main()
