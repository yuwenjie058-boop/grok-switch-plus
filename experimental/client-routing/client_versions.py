"""Explicit client-version adapters shared by staging, verification and health."""
from dataclasses import dataclass
from importlib import import_module

MAIN = 'dist/electron-main/main-app.cjs'
COORD = 'dist/node-agent-coordinator/main.cjs'
MODULES = {'0.57.1': 'patch_routing', '0.66.0': 'patch_routing_066'}
SUPPORTED_VERSIONS = tuple(MODULES)


@dataclass(frozen=True)
class ClientAdapter:
    version: str
    module: object

    @property
    def patchers(self):
        return {MAIN: self.module.patch_client_routing_profile,
                COORD: self.module.patch_coordinator}

    def current(self, path, source):
        """A marker is insufficient: all required wiring and runtime must match."""
        try:
            return self.patchers[path](source) == source
        except (ValueError, KeyError, TypeError):
            return False


def adapter_for(version):
    if not isinstance(version, str) or version not in MODULES:
        raise ValueError('unsupported client version: ' + str(version))
    return ClientAdapter(version, import_module(MODULES[version]))
