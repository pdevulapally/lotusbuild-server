"""Offline regression tests for the boundary before production secrets load."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'release', Path(__file__).resolve().parents[1] / 'deploy/unpack-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
PROTOCOL = release.supported_protocol()
REVISION = 'a' * 40
RUNTIME = {'platform': 'linux', 'arch': 'x64', 'nodeMajor': '22',
           'nodeAbi': '127', 'glibc': '2.39'}


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / 'release.tar.gz'
        self.target = self.root / 'candidate'
        self.target.mkdir()
        self.runtime = patch.object(release, 'runtime_fingerprint', return_value=RUNTIME)
        self.runtime.start()
        self.addCleanup(self.runtime.stop)

    def make_archive(self, extra=(), metadata=None, missing=None, package=None):
        files = {
            'package.json': json.dumps({'runnerRecoveryProtocol': PROTOCOL} if package is None else package), 'package-lock.json': '{}',
            'release.json': json.dumps({'revision': REVISION, 'runnerRecoveryProtocol': PROTOCOL, **RUNTIME} if metadata is None else metadata),
            'dist/index.js': 'throw new Error("Must never execute during unpack")',
            'dist/runner/index.js': '', 'dist/preflight.js': '',
            'deploy/exchange-directories.py': '',
        }
        with tarfile.open(self.archive, 'w:gz') as archive:
            directory = tarfile.TarInfo('node_modules')
            directory.type = tarfile.DIRTYPE
            archive.addfile(directory)
            for name, value in files.items():
                if name == missing:
                    continue
                data = value.encode()
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
            for entry in extra:
                archive.addfile(entry, io.BytesIO(b''))
        return hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def assert_rejected(self, digest, revision=REVISION):
        with self.assertRaises(ValueError):
            release.unpack(self.archive, digest, revision, self.target)
        self.assertEqual(list(self.target.iterdir()), [])

    def test_valid_release_extracts_without_executing_it(self):
        digest = self.make_archive()
        release.unpack(self.archive, digest, REVISION, self.target)
        self.assertTrue((self.target / 'dist/index.js').is_file())
        self.assertFalse((self.target / '.env').exists())

    def test_corruption_and_wrong_revision_fail_before_extraction(self):
        digest = self.make_archive()
        self.assert_rejected('0' * 64)
        self.assert_rejected(digest, 'b' * 40)

    def test_missing_entrypoint_fails_before_extraction(self):
        self.assert_rejected(self.make_archive(missing='dist/preflight.js'))

    def test_unsafe_names_and_extra_roots_are_rejected(self):
        for name in ('../outside', '/absolute', 'dist/../../outside',
                     'dist\\escape', 'C:/outside', '.env', '.github/workflows/ci.yml',
                     'deploy/unexpected.py', 'dist/index.js', 'dist//file'):
            with self.subTest(name=name):
                self.assert_rejected(self.make_archive([tarfile.TarInfo(name)]))

    def test_links_and_devices_are_rejected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind):
                entry = tarfile.TarInfo('node_modules/escape')
                entry.type = kind
                entry.linkname = '../../outside'
                self.assert_rejected(self.make_archive([entry]))

    def test_file_as_parent_is_rejected_before_extraction(self):
        self.assert_rejected(self.make_archive([tarfile.TarInfo('dist/index.js/child')]))

    def test_runtime_mismatch_is_rejected(self):
        for key, value in (('platform', 'win32'), ('arch', 'arm64'),
                           ('nodeMajor', '24'), ('nodeAbi', '137'),
                           ('glibc', '2.40'), ('glibc', None)):
            with self.subTest(key=key):
                metadata = {'revision': REVISION, 'runnerRecoveryProtocol': PROTOCOL, **RUNTIME, key: value}
                self.assert_rejected(self.make_archive(metadata=metadata))

    def test_newer_server_glibc_is_accepted(self):
        digest = self.make_archive(metadata={'revision': REVISION, 'runnerRecoveryProtocol': PROTOCOL, **RUNTIME, 'glibc': '2.36'})
        release.unpack(self.archive, digest, REVISION, self.target)

    def test_package_protocol_must_match_trusted_builder_and_manifest(self):
        for package in ({}, {'runnerRecoveryProtocol': PROTOCOL + 1}, {'runnerRecoveryProtocol': True}):
            self.assert_rejected(self.make_archive(package=package))

    def test_streamed_validator_uses_explicit_trusted_protocol_without_local_checkout(self):
        digest = self.make_archive()
        with patch.object(release, 'supported_protocol', side_effect=AssertionError('No checkout on server')):
            release.unpack(self.archive, digest, REVISION, self.target, PROTOCOL)
        self.assertTrue((self.target / 'release.json').is_file())

    def test_existing_candidate_content_is_preserved(self):
        digest = self.make_archive()
        marker = self.target / '.env'
        marker.write_text('existing')
        with self.assertRaises(ValueError):
            release.unpack(self.archive, digest, REVISION, self.target)
        self.assertEqual(marker.read_text(), 'existing')
        self.assertEqual(list(self.target.iterdir()), [marker])

    def test_check_only_writes_nothing(self):
        release.unpack(self.archive, self.make_archive(), REVISION)
        self.assertEqual(list(self.target.iterdir()), [])

    def test_metadata_uses_the_observed_runtime_and_rejects_non_linux(self):
        self.assertEqual(release.build_metadata(REVISION), {'revision': REVISION, 'runnerRecoveryProtocol': PROTOCOL, **RUNTIME})
        with patch.object(release, 'runtime_fingerprint', return_value={**RUNTIME, 'platform': 'win32'}):
            with self.assertRaises(ValueError):
                release.build_metadata(REVISION)


class CredentialBoundaryTest(unittest.TestCase):
    # The job/script boundary itself is the security invariant: a lifecycle
    # process must never share a runner/identity with later production secrets.
    def test_build_and_deploy_jobs_keep_dependency_execution_separate(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/ci.yml').read_text()
        check, separator, deploy = workflow.partition('\n  deploy:\n')
        self.assertTrue(separator)
        self.assertNotRegex(check, r'\$\{\{[^}]*\bsecrets(?:\.|\[)')
        self.assertIn('secrets.DEPLOY_SSH_KEY', deploy)
        commands = '\n'.join(line for line in deploy.splitlines() if not line.lstrip().startswith('#'))
        self.assertNotRegex(commands, r'\b(?:npm|npx|yarn|pnpm|tsc)\s')
        self.assertNotRegex(commands, r'\bnode\s')
        self.assertIn('artifact-ids: ${{ needs.check.outputs.release-id }}', deploy)

    def test_server_promotion_never_installs_or_compiles_dependencies(self):
        script = (Path(__file__).resolve().parents[1] / 'deploy.sh').read_text()
        commands = '\n'.join(line for line in script.splitlines() if not line.lstrip().startswith('#'))
        self.assertNotRegex(commands, r'\b(?:npm|npx|yarn|pnpm|tsc)\s')
        self.assertLess(script.index('deploy/unpack-release.py'), script.index('install -m 600'))
        self.assertIn('node --env-file=.env dist/preflight.js', script)



# Exercise the real remote shell and compatibility parser. Only the operating
# system service calls and Linux renameat2 syscall are replaced offline.
class RollbackTest(unittest.TestCase):
    def test_packaged_protocol_rejects_missing_malformed_and_future(self):
        h = ReleaseTest(); h.setUp()
        try:
            for version in (None, True, '1', 0, PROTOCOL + 1):
                metadata = {'revision': REVISION, **RUNTIME, 'runnerRecoveryProtocol': version}
                h.assert_rejected(h.make_archive(metadata=metadata))
            h.assert_rejected(h.make_archive(metadata={'revision': REVISION, **RUNTIME}))
        finally:
            h.doCleanups()

    def flow(self, legacy=False, failure='health', target_protocol=PROTOCOL, active_protocol=PROTOCOL):
        import os
        import subprocess
        import sys
        with tempfile.TemporaryDirectory(prefix='lotus-rollback-') as folder:
            root = Path(folder)
            active = root / 'lotusbuild-server'
            candidate = root / ('.lotusbuild-candidate-' + 'b' * 40 + '-1')
            for path, rev, protocol in ((active, 'a', None if legacy else active_protocol), (candidate, 'b', target_protocol)):
                (path / 'dist/runner').mkdir(parents=True)
                (path / 'deploy').mkdir()
                for file in ('dist/index.js', 'dist/runner/index.js', 'dist/preflight.js', 'deploy/exchange-directories.py', '.env', 'release.tar.gz'):
                    (path / file).write_text('')
                metadata = {'revision': rev * 40}
                package = {}
                if protocol is not None:
                    metadata['runnerRecoveryProtocol'] = protocol
                    package['runnerRecoveryProtocol'] = protocol
                (path / 'release.json').write_text(json.dumps(metadata))
                (path / 'package.json').write_text(json.dumps(package))
                (path / 'identity').write_text(rev)
            stub = root / 'exchange.py'
            helper = Path(__file__).resolve().parents[1] / 'deploy/exchange-directories.py'
            stub.write_text('''import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('exchange', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
args = sys.argv[3:]
a, b = [pathlib.Path(x) for x in args if x not in ('--check', '--rollback')]
assert a.resolve().parent == b.resolve().parent == pathlib.Path(__file__).resolve().parent
try: m.validate_compatibility(a, b, '--rollback' in args)
except ValueError as error: sys.exit(str(error))
if '--check' not in args:
    with (a.parent / 'events').open('a') as log: log.write('exchange\\n')
    # Simulate the atomic exchange without renaming a Windows open cwd.
    left = {p.relative_to(a): p.read_bytes() for p in a.rglob('*') if p.is_file()}
    right = {p.relative_to(b): p.read_bytes() for p in b.rglob('*') if p.is_file()}
    for folder, contents in ((a, right), (b, left)):
        for p in folder.rglob('*'):
            if p.is_file(): p.unlink()
        for name, data in contents.items():
            (folder / name).parent.mkdir(parents=True, exist_ok=True)
            (folder / name).write_bytes(data)
''')
            prelude = r'''
set -euo pipefail
record() { echo "$*" >> "$TEST_ROOT/events"; }
identity() { cat "$TEST_ROOT/lotusbuild-server/identity"; }
sudo() { shift; "$@"; }
flock() { return 0; }
sleep() { return 0; }
node() { record "preflight $(cat identity)"; }
curl() { [[ "$FAILURE" != health || "$(identity)" != b ]]; }
python3() { "$TEST_PYTHON" "$TEST_STUB" "$TEST_HELPER" "$@"; }
systemctl() {
  case "$1" in
    stop) record "stop $(identity)"; [[ "$FAILURE" != stop ]] || return 1; echo inactive > "$TEST_ROOT/state" ;;
    show) if [[ "$2" == --property=ActiveState ]]; then cat "$TEST_ROOT/state"; else [[ "$FAILURE" != pid ]] && echo 0 || echo 8; fi ;;
    start) record "start $(identity)"; echo active > "$TEST_ROOT/state"; [[ "$FAILURE" != start || "$(identity)" != b ]] ;;
    is-active) return 0 ;;
    *) return 1 ;;
  esac
}
'''
            source = (Path(__file__).resolve().parents[1] / 'deploy.sh').read_text()
            remote = source.split("<<'REMOTE'\n", 1)[1].rsplit('\nREMOTE', 1)[0]
            remote = remote.replace('/home/preet/apps', root.as_posix())
            script = root / 'flow.sh'; script.write_text(prelude + remote)
            env = {**os.environ, 'TEST_ROOT': root.as_posix(), 'TEST_PYTHON': Path(sys.executable).as_posix(),
                   'TEST_STUB': stub.as_posix(), 'TEST_HELPER': helper.as_posix(), 'FAILURE': failure}
            result = subprocess.run(['bash', str(script), candidate.as_posix()], env=env, capture_output=True, text=True, timeout=30)
            events = (root / 'events').read_text().splitlines() if (root / 'events').exists() else []
            return result, events, (active / 'identity').read_text()

    def test_first_rollout_health_and_start_failure_never_start_legacy(self):
        for failure in ('health', 'start'):
            with self.subTest(failure=failure):
                result, events, active = self.flow(legacy=True, failure=failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('rollback/recovery-protocol-incompatible', result.stderr)
                self.assertEqual(active, 'b')
                self.assertEqual(events, ['preflight b', 'stop a', 'exchange', 'start b'])

    def test_same_protocol_different_sha_automatic_rollback(self):
        for failure in ('health', 'start'):
            with self.subTest(failure=failure):
                result, events, active = self.flow(failure=failure)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertEqual(active, 'a', result.stderr)
                self.assertEqual(events, ['preflight b', 'stop a', 'exchange', 'start b', 'stop b', 'preflight a', 'exchange', 'start a'])

    def test_success_quiesces_old_writers_before_exchange(self):
        result, events, active = self.flow(legacy=True, failure='none')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(active, 'b')
        self.assertEqual(events, ['preflight b', 'stop a', 'exchange', 'start b'])

    def test_stop_failure_or_live_pid_blocks_exchange(self):
        result, events, active = self.flow(failure='stop')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(active, 'a')
        self.assertEqual(events, ['preflight b', 'stop a', 'start a'])

        result, events, active = self.flow(failure='pid')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(active, 'a')
        self.assertEqual(events, ['preflight b', 'stop a'])

    def test_future_active_contract_cannot_be_downgraded(self):
        result, events, active = self.flow(active_protocol=PROTOCOL + 1)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(active, 'a')
        self.assertEqual(events, ['preflight b'])

    def test_missing_or_future_target_rejected_before_stop_or_exchange(self):
        for protocol in (None, PROTOCOL + 1):
            result, events, active = self.flow(target_protocol=protocol)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('release/recovery-protocol-incompatible', result.stderr)
            self.assertEqual(active, 'a')
            self.assertEqual(events, ['preflight b'])


if __name__ == '__main__':
    unittest.main()
