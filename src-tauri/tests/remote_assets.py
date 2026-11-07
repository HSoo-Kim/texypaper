"""Binary asset staging parity; run under POSIX/WSL using synthetic temporary roots."""
import base64
import hashlib
import importlib.util
import os
import pathlib
import tempfile
import threading
import unittest
import uuid

source = pathlib.Path(__file__).resolve().parents[1] / 'resources' / 'remote_worker.py'
spec = importlib.util.spec_from_file_location('texypaper_asset_worker', source)
worker_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker_module)


@unittest.skipUnless(os.name == 'posix', 'Remote worker requires POSIX directory descriptors')
class RemoteAssetContract(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='texypaper-assets-')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.worker = worker_module.Worker()
        self.addCleanup(self.worker.shutdown)
        self.cancel = threading.Event()
        self.worker.open_root(dict(root=str(self.root), workspaceId=uuid.uuid4().hex, epoch=1), self.cancel, b'')

    def call(self, operation, args, payload=b''):
        return getattr(self.worker, operation)(args, self.cancel, payload)[0]

    def begin(self, path, data):
        return self.call('asset_import_begin', dict(path=path, byteLength=len(data), sha256=hashlib.sha256(data).hexdigest()))['uploadId']

    def chunk(self, ident, index, data, framed=False):
        args = dict(uploadId=ident, index=index)
        if not framed:
            args['data'] = base64.b64encode(data).decode('ascii')
        return self.call('asset_import_chunk', args, data if framed else b'')

    def failure(self, code, operation, args):
        with self.assertRaises(worker_module.Failure) as failure:
            self.call(operation, args)
        self.assertEqual(failure.exception.value['code'], code)

    def assert_clean(self):
        self.assertEqual(list(self.root.rglob('.texypaper-asset-*.tmp')), [])

    def test_three_mib_png_is_hash_verified_over_framed_payload(self):
        data = b'\x89PNG\r\n\x1a\n' + bytes(range(251)) * 12533
        data = data[:3 * 1024 * 1024]
        self.assertEqual(len(data), 3 * 1024 * 1024)
        ident = self.begin('figures/results/plot.png', data)
        for index, offset in enumerate(range(0, len(data), 192 * 1024)):
            self.chunk(ident, index, data[offset:offset + 192 * 1024], framed=True)
        result = self.call('asset_import_commit', dict(uploadId=ident))
        self.assertEqual(result, dict(path='figures/results/plot.png', byteLength=len(data), sha256=hashlib.sha256(data).hexdigest()))
        self.assertEqual((self.root / result['path']).read_bytes(), data)
        self.assert_clean()

    def test_existing_and_racing_destinations_are_never_overwritten(self):
        target = self.root / 'plot.png'
        target.write_bytes(b'original')
        self.failure('ALREADY_EXISTS', 'asset_import_begin', dict(path='plot.png', byteLength=1, sha256=hashlib.sha256(b'x').hexdigest()))
        ident = self.begin('race.png', b'ours')
        self.chunk(ident, 0, b'ours')
        (self.root / 'race.png').write_bytes(b'external')
        self.failure('ALREADY_EXISTS', 'asset_import_commit', dict(uploadId=ident))
        self.assertEqual((self.root / 'race.png').read_bytes(), b'external')
        self.assert_clean()

    def test_paths_extension_size_and_symlink_escape_are_refused(self):
        for path in ('../escape.png', 'a/../plot.png', 'C:/escape.png', 'a:b.png', '/tmp/escape.png', 'a\\plot.png', '.git/image.png', 'sub/.texypaper/image.png', '.paperdock/image.png', 'CON.png', 'LPT1/image.png'):
            with self.subTest(path=path), self.assertRaises(worker_module.Failure):
                self.begin(path, b'')
        self.failure('ASSET_EXTENSION', 'asset_import_begin', dict(path='bad.exe', byteLength=0, sha256=hashlib.sha256(b'').hexdigest()))
        self.failure('ASSET_TOO_LARGE', 'asset_import_begin', dict(path='large.png', byteLength=20 * 1024 * 1024 + 1, sha256=hashlib.sha256(b'').hexdigest()))
        with tempfile.TemporaryDirectory(prefix='texypaper-assets-outside-') as outside:
            (self.root / 'escape').symlink_to(outside, target_is_directory=True)
            with self.assertRaises((worker_module.Failure, OSError)):
                self.begin('escape/plot.png', b'')
            self.assertFalse((pathlib.Path(outside) / 'plot.png').exists())
        self.assert_clean()

    def test_hash_mismatch_order_and_incomplete_failure_remove_temp(self):
        ident = self.begin('hash.png', b'expected')
        self.chunk(ident, 0, b'modified')
        self.failure('ASSET_HASH_MISMATCH', 'asset_import_commit', dict(uploadId=ident))
        ident = self.begin('order.png', b'x')
        self.failure('UPLOAD_SEQUENCE', 'asset_import_chunk', dict(uploadId=ident, index=1, data=base64.b64encode(b'x').decode()))
        ident = self.begin('incomplete.png', b'xy')
        self.chunk(ident, 0, b'x')
        self.failure('UPLOAD_INCOMPLETE', 'asset_import_commit', dict(uploadId=ident))
        self.assert_clean()
        self.assertFalse((self.root / 'hash.png').exists())

    def test_abort_concurrency_limit_and_expiration(self):
        first = self.begin('one.png', b'xy')
        self.chunk(first, 0, b'x')
        second = self.begin('two.png', b'')
        self.failure('UPLOAD_BUSY', 'asset_import_begin', dict(path='three.png', byteLength=0, sha256=hashlib.sha256(b'').hexdigest()))
        self.assertTrue(self.call('asset_import_abort', dict(uploadId=first))['aborted'])
        self.worker.uploads[second]['touched'] -= 301
        third = self.begin('three.png', b'')
        self.assertNotIn(second, self.worker.uploads)
        self.call('asset_import_abort', dict(uploadId=third))
        self.assert_clean()

    def test_source_abort_cannot_delete_an_asset_destination(self):
        ident = self.begin('racing.png', b'ours')
        (self.root / 'racing.png').write_bytes(b'external')
        self.failure('UPLOAD_KIND', 'save_text_abort', dict(uploadId=ident))
        self.failure('UPLOAD_KIND', 'args_abort', dict(uploadId=ident))
        self.assertEqual((self.root / 'racing.png').read_bytes(), b'external')
        self.assertIn(ident, self.worker.uploads)
        self.call('asset_import_abort', dict(uploadId=ident))
        self.assert_clean()


if __name__ == '__main__':
    unittest.main()
