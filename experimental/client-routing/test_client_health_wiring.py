"""Health must reject incomplete routing wiring despite valid archive hashes.

These tests reuse synthetic matching fragments only; no installed app is read.
"""
import tempfile
import unittest
from pathlib import Path

import asar
import check_client
import patch_routing
import test_client_tools as fixtures


class ClientHealthWiringTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.install = self.root / 'install'
        (self.install / 'resources').mkdir(parents=True)
        self.profile = self.root / 'profile'
        self.profile.mkdir()
        (self.profile / check_client.MARKER).touch()
        self.main = patch_routing.patch_client_routing_profile(
            fixtures.main_fixture().decode())
        self.coordinator = patch_routing.patch_coordinator(
            fixtures.coordinator_fixture().decode())

    def inspect(self, coordinator):
        files = {fixtures.MAIN: self.main.encode(),
                 fixtures.COORD: coordinator.encode(),
                 'package.json': b'{"version":"0.57.1"}'}
        digest = fixtures.archive(self.install / 'resources' / 'app.asar', files)
        (self.install / 'Grok Bot.exe').write_bytes(
            b'synthetic exe ' + asar.embedded_record(digest))
        result = check_client.inspect_install(self.install, [self.profile])
        # The defect is wiring, not corruption, stale runtime, or EXE pairing.
        self.assertTrue(result['archiveIntegrityOk'], result)
        self.assertTrue(result['exeEmbedsAsarHeaderHash'], result)
        self.assertTrue(result['routingRuntimeCurrent'], result)
        return result

    def remove_wiring(self, before, after, count=1):
        self.assertEqual(self.coordinator.count(before), count)
        return self.coordinator.replace(before, after)

    def test_complete_synthetic_wiring_is_healthy(self):
        self.assertTrue(self.inspect(self.coordinator)['healthy'])

    def test_missing_dispatch_ownership_guard_is_not_healthy(self):
        broken = self.remove_wiring(
            'acceptsAgent:({agentId:E})=>!f.__gsOwnsBox(E)&&f.harnessOf(E)',
            'acceptsAgent:({agentId:E})=>f.harnessOf(E)')
        self.assertFalse(self.inspect(broken)['healthy'])

    def test_missing_both_transcript_read_guards_is_not_healthy(self):
        broken = self.remove_wiring(
            '!f.__gsOwnsBox(J.id)&&ne.isActive({agentId:J.id})?Ue(',
            'ne.isActive({agentId:J.id})?Ue(', count=2)
        self.assertFalse(self.inspect(broken)['healthy'])

    def test_missing_profile_forwarding_or_seed_wiring_is_not_healthy(self):
        cases = [
            ('profile_forwarding',
             ',...qt(t.processConfig.boxRoutingProfileDir)?'
             '{boxRoutingProfileDir:t.processConfig.boxRoutingProfileDir}:{}',
             ''),
            ('seed_creation',
             '__gsSeedController??=__gsRosterSeed({',
             '__gsSeedController??=unrelatedController({'),
            ('seed_request',
             'return __gsSeedController.request()',
             'return Promise.resolve()'),
        ]
        for name, before, after in cases:
            with self.subTest(wiring=name):
                broken = self.remove_wiring(before, after)
                self.assertFalse(self.inspect(broken)['healthy'])


if __name__ == '__main__':
    unittest.main()
