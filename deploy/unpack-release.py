"""Validate a CI release before extraction or loading any application code."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile

def protocol_field(metadata):
    version = metadata.get('runnerRecoveryProtocol') if isinstance(metadata, dict) else None
    if type(version) is not int or not 1 <= version <= 2147483647:
        raise ValueError('release/recovery-protocol-incompatible')
    return version


def supported_protocol():
    return protocol_field(json.loads((Path(__file__).resolve().parents[1] / 'package.json').read_text(encoding='utf-8')))


def runtime_fingerprint():
    # Built-in Node APIs only. No imports from the candidate or its dependencies.
    return json.loads(subprocess.check_output([
        'node', '-e',
        'const p=process; console.log(JSON.stringify({platform:p.platform,'
        'arch:p.arch,nodeMajor:p.versions.node.split(".")[0],'
        'nodeAbi:p.versions.modules,glibc:p.report.getReport().header.glibcVersionRuntime}));'
    ], text=True))


def glibc_version(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]+\.[0-9]+', value):
        raise ValueError('A Linux/glibc runtime is required')
    return tuple(int(part) for part in value.split('.'))


def build_metadata(revision):
    if not re.fullmatch(r'[0-9a-f]{40,64}', revision):
        raise ValueError('Invalid release revision')
    runtime = runtime_fingerprint()
    if runtime.get('platform') != 'linux':
        raise ValueError('A Linux/glibc builder is required')
    glibc_version(runtime.get('glibc'))
    return {'revision': revision, **runtime,
            'runnerRecoveryProtocol': supported_protocol()}


def unpack(archive, digest, revision, target=None, expected_protocol=None):
    supported = supported_protocol() if expected_protocol is None else protocol_field({'runnerRecoveryProtocol': expected_protocol})
    if not re.fullmatch(r'[0-9a-f]{64}', digest) or not re.fullmatch(r'[0-9a-f]{40,64}', revision):
        raise ValueError('Invalid release checksum or revision')
    # Keep the same file descriptor for checksum, validation and extraction.
    with open(archive, 'rb') as source:
        checksum = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            checksum.update(chunk)
        if checksum.hexdigest() != digest:
            raise ValueError('Release checksum mismatch')
        source.seek(0)
        with tarfile.open(fileobj=source, mode='r:gz') as payload:
            members = {}
            root_files = {'package.json', 'package-lock.json', 'release.json'}
            for member in payload.getmembers():
                name = member.name.rstrip('/') if member.isdir() else member.name
                parts = name.split('/')
                if (any(part in ('', '.', '..') for part in parts)
                        or '\\' in name or ':' in name
                        or not (member.isdir() or member.isfile())
                        or name in members):
                    raise ValueError('Unsafe or duplicate release entry')
                if not (name in root_files or parts[0] in ('dist', 'node_modules')
                        or name in ('deploy', 'deploy/exchange-directories.py')):
                    raise ValueError('Unexpected release entry')
                members[name] = member
            required = root_files | {'dist/index.js', 'dist/runner/index.js',
                                     'dist/preflight.js', 'deploy/exchange-directories.py'}
            if any(name not in members or not members[name].isfile() for name in required):
                raise ValueError('Incomplete release')
            if 'node_modules' not in members or not members['node_modules'].isdir():
                raise ValueError('Production dependencies are missing')
            # Reject file/directory collisions before writing anything.
            for name in members:
                parent = name.rpartition('/')[0]
                while parent:
                    if parent in members and not members[parent].isdir():
                        raise ValueError('Invalid release parent directory')
                    parent = parent.rpartition('/')[0]
            if members['release.json'].size > 4096:
                raise ValueError('Invalid release metadata')
            with payload.extractfile(members['release.json']) as metadata_file:
                metadata = json.load(metadata_file)
            if members['package.json'].size > 16384:
                raise ValueError('Invalid package metadata')
            with payload.extractfile(members['package.json']) as package_file:
                package = json.load(package_file)
            if not isinstance(metadata, dict) or not isinstance(package, dict) or any(
                protocol_field(item) != supported for item in (metadata, package)
            ):
                raise ValueError('release/recovery-protocol-incompatible')
            runtime = runtime_fingerprint()
            if not isinstance(metadata, dict) or metadata.get('revision') != revision:
                raise ValueError('Release revision mismatch')
            if metadata.get('platform') != 'linux' or any(
                not isinstance(metadata.get(key), str) or metadata[key] != runtime.get(key)
                for key in ('platform', 'arch', 'nodeMajor', 'nodeAbi')
            ):
                raise ValueError('Release runtime mismatch')
            if glibc_version(runtime.get('glibc')) < glibc_version(metadata.get('glibc')):
                raise ValueError('Server glibc is older than the build runtime')
            if target is None:
                return
            destination = Path(target)
            if destination.is_symlink() or not destination.is_dir():
                raise ValueError('A real candidate directory is required')
            # Only the archive just uploaded by deploy.sh may already exist.
            if any(path.resolve() != Path(archive).resolve() for path in destination.iterdir()):
                raise ValueError('Candidate directory is not empty')
            # Copy regular files explicitly: never restore links, ownership or
            # special permission bits from tar metadata, including on old Python.
            for name, member in members.items():
                path = destination.joinpath(*name.split('/'))
                if member.isdir():
                    path.mkdir(mode=0o700, parents=True, exist_ok=True)
                else:
                    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    with payload.extractfile(member) as content, path.open('xb') as output:
                        shutil.copyfileobj(content, output)
                    os.chmod(path, 0o700 if member.mode & 0o111 else 0o600)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 2 and sys.argv[1] == '--protocol':
            print(supported_protocol())
        elif len(sys.argv) == 3 and sys.argv[1] == '--metadata':
            print(json.dumps(build_metadata(sys.argv[2])))
        elif len(sys.argv) in (5, 6):
            if len(sys.argv) == 6 and not re.fullmatch(r'[1-9][0-9]{0,9}', sys.argv[5]):
                raise ValueError('release/recovery-protocol-incompatible')
            expected = None if len(sys.argv) == 5 else int(sys.argv[5])
            unpack(*sys.argv[1:4], None if sys.argv[4] == '--check-only' else sys.argv[4], expected)
        else:
            raise ValueError('Usage: unpack-release.py --metadata COMMIT_SHA | ARCHIVE SHA256 COMMIT_SHA TARGET|--check-only')
    except (ValueError, OSError, tarfile.TarError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from None
