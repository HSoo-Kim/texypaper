"""POSIX project replacement and cursor tests using real temporary workspace files."""
import importlib.util
import os
import pathlib
import tempfile
import threading
import unittest
import uuid

source = pathlib.Path(__file__).resolve().parents[1] / 'resources' / 'remote_worker.py'
spec = importlib.util.spec_from_file_location('texypaper_replace_worker', source)
worker_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker_module)


@unittest.skipUnless(os.name == 'posix', 'Worker transactions require POSIX')
class RemoteProjectReplace(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='texypaper-replace-')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.cancel = threading.Event()
        self.worker = worker_module.Worker()
        self.addCleanup(self.worker.shutdown)
        self.worker.open_root(dict(root=str(self.root), workspaceId=uuid.uuid4().hex, epoch=1), self.cancel, b'')

    def proposal(self, path, before, content, agent=False):
        return dict(transactionId=uuid.uuid4().hex, summary='project replace', _agentPolicy=agent,
                    files=[dict(path=path, action='edit', baseSha256=worker_module.digest(before), content=content)])

    def search(self, **args):
        return self.worker.search_text(args, self.cancel, b'')[0]

    def test_generic_nonpaper_replacement_preserves_bom_and_every_unaffected_line_ending(self):
        path = self.root / 'notes.txt'
        before = b'\xef\xbb\xbfcat\r\nuntouched\ncat\rfinal\r\n'
        path.write_bytes(before)
        args = self.proposal('notes.txt', before, 'dog\r\nuntouched\ndog\rfinal\r\n')
        result, _ = self.worker.apply_proposal(args, self.cancel, b'')
        self.assertEqual(result['status'], 'committed')
        self.assertEqual(path.read_bytes(), before.replace(b'cat', b'dog'))
        undone, _ = self.worker.undo_transaction(dict(transactionId=args['transactionId']), self.cancel, b'')
        self.assertEqual(undone['status'], 'undone')
        self.assertEqual(path.read_bytes(), before)

    def test_generic_content_is_exact_even_when_replacement_changes_line_ending(self):
        path = self.root / 'main.tex'
        before = b'cat\r\nuntouched\r\n'
        path.write_bytes(before)
        self.worker.apply_proposal(self.proposal('main.tex', before, 'dog\nuntouched\r\n'), self.cancel, b'')
        self.assertEqual(path.read_bytes(), b'dog\nuntouched\r\n')

    def test_agent_still_rejects_nonpaper_and_preserves_existing_proposal_normalization(self):
        path = self.root / 'notes.txt'
        path.write_bytes(b'cat')
        with self.assertRaises(worker_module.Failure) as failure:
            self.worker.apply_proposal(self.proposal('notes.txt', b'cat', 'dog', agent=True), self.cancel, b'')
        self.assertEqual(failure.exception.value['code'], 'WRITE_NOT_ALLOWED')
        self.assertEqual(path.read_bytes(), b'cat')
        paper = self.root / 'main.tex'
        paper.write_bytes(b'cat\r\n')
        self.worker.apply_proposal(self.proposal('main.tex', b'cat\r\n', 'dog\n', agent=True), self.cancel, b'')
        self.assertEqual(paper.read_bytes(), b'dog\r\n')

    def test_private_paths_invalid_encoding_binary_and_large_files_are_refused(self):
        for relative in ['.git/config', 'nested/.texypaper/data.txt', 'nested/.paperdock/data.txt']:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'cat')
            with self.subTest(path=relative), self.assertRaises(worker_module.Failure) as failure:
                self.worker.apply_proposal(self.proposal(relative, b'cat', 'dog'), self.cancel, b'')
            self.assertEqual(failure.exception.value['code'], 'PATH_RESERVED')
            self.assertEqual(path.read_bytes(), b'cat')
        for name, before, code in [('legacy.txt', b'\xff\xfe@', 'ENCODING_UNSUPPORTED'),
                                   ('binary.txt', b'cat\x00', 'BINARY_FILE'),
                                   ('large.txt', b'x' * (worker_module.TEXT_LIMIT + 1), 'LARGE_FILE')]:
            path = self.root / name
            path.write_bytes(before)
            with self.subTest(path=name), self.assertRaises(worker_module.Failure) as failure:
                self.worker.apply_proposal(self.proposal(name, before, 'dog'), self.cancel, b'')
            self.assertEqual(failure.exception.value['code'], code)
            self.assertEqual(path.read_bytes(), before)

    def test_private_symlink_target_and_outside_root_are_not_writable(self):
        private = self.root / '.git'
        private.mkdir()
        (private / 'data.txt').write_bytes(b'cat')
        (self.root / 'alias.txt').symlink_to(private / 'data.txt')
        with self.assertRaises(worker_module.Failure) as failure:
            self.worker.apply_proposal(self.proposal('alias.txt', b'cat', 'dog'), self.cancel, b'')
        self.assertEqual(failure.exception.value['code'], 'PATH_RESERVED')
        with self.assertRaises(worker_module.Failure):
            self.worker.apply_proposal(self.proposal('../escape.txt', b'cat', 'dog'), self.cancel, b'')

    def test_all_hashes_are_checked_before_any_replacement(self):
        (self.root / 'a.txt').write_bytes(b'cat')
        (self.root / 'b.txt').write_bytes(b'new')
        args = self.proposal('a.txt', b'cat', 'dog')
        args['files'].extend(self.proposal('b.txt', b'cat', 'dog')['files'])
        with self.assertRaises(worker_module.Failure) as failure:
            self.worker.apply_proposal(args, self.cancel, b'')
        self.assertEqual(failure.exception.value['code'], 'FILE_CONFLICT')
        self.assertEqual((self.root / 'a.txt').read_bytes(), b'cat')

    def test_pages_cover_every_matching_line_and_file_without_duplicates(self):
        (self.root / 'a.txt').write_text('cat\n' * 450, encoding='utf-8')
        nested = self.root / 'nested'
        nested.mkdir()
        (nested / 'b.txt').write_text('cat\n' * 30, encoding='utf-8')
        page = self.search(query='cat', limit=17, caseSensitive=True)
        seen = []
        while True:
            seen.extend((item['path'], item['line']) for item in page['matches'])
            if not page['nextCursor']:
                break
            page = self.search(query='cat', limit=17, caseSensitive=True, cursor=page['nextCursor'])
        self.assertEqual(len(seen), 480)
        self.assertEqual(len(set(seen)), 480)
        self.assertIn(('a.txt', 450), seen)
        self.assertIn(('nested/b.txt', 30), seen)
        self.assertFalse(page['truncated'])

    def test_cursor_binds_query_case_workspace_and_agent_policy(self):
        (self.root / 'a.txt').write_text('cat\n' * 5, encoding='utf-8')
        page = self.search(query='cat', limit=1, caseSensitive=True)
        cursor = page['nextCursor']
        for patch in [dict(query='dog'), dict(caseSensitive=False), dict(_agentPolicy=True), dict(path='a.txt')]:
            args = dict(query='cat', limit=1, caseSensitive=True, cursor=cursor)
            args.update(patch)
            with self.subTest(patch=patch), self.assertRaises(worker_module.Failure) as failure:
                self.search(**args)
            self.assertEqual(failure.exception.value['code'], 'CURSOR_INVALID')
        self.worker.epoch += 1
        with self.assertRaises(worker_module.Failure) as failure:
            self.search(query='cat', caseSensitive=True, cursor=cursor)
        self.assertEqual(failure.exception.value['code'], 'CURSOR_INVALID')

    def test_literal_unicode_case_and_long_lines(self):
        (self.root / 'a.txt').write_text('Cat\nCAT\ncat\nK\na.*\naxx\n' + 'x' * 70000 + 'needle\n', encoding='utf-8')
        self.assertEqual(len(self.search(query='cat', caseSensitive=True)['matches']), 1)
        self.assertEqual(len(self.search(query='cat', caseSensitive=False)['matches']), 3)
        self.assertEqual(len(self.search(query='k', caseSensitive=False)['matches']), 1)
        self.assertEqual(len(self.search(query='a.*')['matches']), 1)
        self.assertEqual(len(self.search(query='needle')['matches']), 1)
        self.assertEqual(len(self.search(query='needle')['matches'][0]['text']), 2000)

    def test_search_excludes_private_metadata_and_never_follows_symlinks(self):
        for directory in ['.git', 'nested/.texypaper', 'nested/.paperdock']:
            path = self.root / directory
            path.mkdir(parents=True, exist_ok=True)
            (path / 'private.txt').write_text('cat', encoding='utf-8')
        (self.root / 'alias.txt').symlink_to(self.root / '.git/private.txt')
        self.assertEqual(self.search(query='cat')['matches'], [])


if __name__ == '__main__':
    unittest.main()
