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

    def make_archive(self, extra=(), metadata=None, missing=None):
        files = {
            'package.json': '{}', 'package-lock.json': '{}',
            'release.json': json.dumps({'revision': REVISION, **RUNTIME} if metadata is None else metadata),
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
                metadata = {'revision': REVISION, **RUNTIME, key: value}
                self.assert_rejected(self.make_archive(metadata=metadata))

    def test_newer_server_glibc_is_accepted(self):
        digest = self.make_archive(metadata={'revision': REVISION, **RUNTIME, 'glibc': '2.36'})
        release.unpack(self.archive, digest, REVISION, self.target)

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
        self.assertEqual(release.build_metadata(REVISION), {'revision': REVISION, **RUNTIME})
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


if __name__ == '__main__':
    unittest.main()
