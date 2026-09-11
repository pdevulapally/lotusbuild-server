"""Linux atomic exchange, retaining the existing active directory pathname."""
import ctypes
import json
import os
import pathlib
import re
import sys


def read_metadata(path):
    try:
        if path.is_symlink() or path.stat().st_size > 16384:
            raise ValueError()
        result = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except (OSError, ValueError):
        raise ValueError('release/recovery-protocol-incompatible') from None


def protocol_field(metadata):
    version = metadata.get('runnerRecoveryProtocol')
    if type(version) is not int or not 1 <= version <= 2147483647:
        raise ValueError('release/recovery-protocol-incompatible')
    return version


def package_protocol(root):
    return protocol_field(read_metadata(root / 'package.json'))


def release_protocol(root, legacy=False):
    package = read_metadata(root / 'package.json')
    manifest = root / 'release.json'
    if legacy and not manifest.exists() and 'runnerRecoveryProtocol' not in package:
        return 0
    metadata = read_metadata(manifest)
    if legacy and 'runnerRecoveryProtocol' not in package and 'runnerRecoveryProtocol' not in metadata:
        return 0
    version = protocol_field(metadata)
    if version != protocol_field(package) or not isinstance(metadata.get('revision'), str) or not re.fullmatch(r'[0-9a-f]{40,64}', metadata['revision']):
        raise ValueError('release/recovery-protocol-incompatible')
    return version


def validate_compatibility(active, candidate, rollback=False):
    # The executing, protocol-aware release defines what this tool understands.
    supported = package_protocol(pathlib.Path(__file__).resolve().parents[1])
    try:
        target = release_protocol(candidate)
        current = release_protocol(active, legacy=not rollback)
        if target != supported or (current != supported and not (current == 0 and not rollback)):
            raise ValueError()
    except ValueError:
        code = 'rollback' if rollback else 'release'
        raise ValueError(f'{code}/recovery-protocol-incompatible') from None


def exchange_directories(active, candidate, check=False, rollback=False):
    paths = [active, candidate]
    parent = pathlib.Path('/home/preet/apps').resolve(strict=True)
    if any(p.is_symlink() or not p.is_dir() or p.resolve().parent != parent for p in paths):
        raise ValueError('Directories must be real direct children of the deployment parent')
    if active.name != 'lotusbuild-server' or not candidate.name.startswith('.lotusbuild-candidate-'):
        raise ValueError('Unexpected deployment directory')
    if os.stat(active).st_dev != os.stat(candidate).st_dev:
        raise ValueError('Atomic exchange requires one filesystem')
    validate_compatibility(active, candidate, rollback)
    libc = ctypes.CDLL(None, use_errno=True)
    exchange = libc.renameat2
    exchange.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    exchange.restype = ctypes.c_int
    if not check:
        if exchange(-100, os.fsencode(active), -100, os.fsencode(candidate), 2) != 0:
            raise OSError('Atomic directory exchange failed')


if __name__ == '__main__':
    try:
        args = sys.argv[1:]
        paths = [pathlib.Path(x) for x in args if x not in ('--check', '--rollback')]
        if len(paths) != 2:
            raise ValueError('Two directories required')
        exchange_directories(*paths, check='--check' in args, rollback='--rollback' in args)
    except (OSError, ValueError) as error:
        # All ValueErrors above are static categories; OS payloads are never printed.
        raise SystemExit(str(error) if isinstance(error, ValueError) else 'release/directory-exchange-failed') from None
