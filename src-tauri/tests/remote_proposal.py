"""POSIX worker transaction regressions; uses real temporary files, never provider mocks."""
import hashlib
import importlib.util
import json
import os
import pathlib
import tempfile
import threading
import unittest
import uuid


source = pathlib.Path(__file__).resolve().parents[1] / 'resources' / 'remote_worker.py'
spec = importlib.util.spec_from_file_location('texypaper_remote_worker', source)
worker_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker_module)


class RemoteProposalContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='texypaper-proposal-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.path = self.root / 'main.tex'
        self.original = b'\xef\xbb\xbf\\documentclass{article}\r\nResult 42.\r\n'
        self.path.write_bytes(self.original)
        self.cancel = threading.Event()
        self.worker = worker_module.Worker()
        self.worker.open_root(dict(root=str(self.root), workspaceId=uuid.uuid4().hex, epoch=1), self.cancel, b'')

    def proposal(self, action='edit'):
        return dict(transactionId=uuid.uuid4().hex, summary='Change literal result', _agentPolicy=True, files=[
            dict(path='main.tex', action=action, baseSha256=hashlib.sha256(self.original).hexdigest(),
                 content='\\documentclass{article}\nResult 43.\n')])

    def test_edit_uses_shared_action_and_returns_exact_changed_revisions(self):
        result, payload = self.worker.apply_proposal(self.proposal(), self.cancel, b'')
        expected = b'\xef\xbb\xbf\\documentclass{article}\r\nResult 43.\r\n'
        self.assertEqual(self.path.read_bytes(), expected)
        self.assertEqual(payload, b'')
        self.assertEqual(result['status'], 'committed')
        self.assertEqual([item['path'] for item in result['changed']], ['main.tex'])
        self.assertEqual(result['changed'][0]['revision']['sha256'], hashlib.sha256(expected).hexdigest())
        self.assertNotIn('revisions', result)

    def test_explicit_create_has_no_base_revision(self):
        args = dict(transactionId=uuid.uuid4().hex, summary='Create bibliography', files=[
            dict(path='references.bib', action='create', baseSha256=None, content='@article{paper, title={Paper}}\n')])
        result, _ = self.worker.apply_proposal(args, self.cancel, b'')
        self.assertEqual((self.root / 'references.bib').read_text(), '@article{paper, title={Paper}}\n')
        self.assertEqual(result['changed'][0]['path'], 'references.bib')

    def test_noncontract_actions_cannot_delete_or_modify_source(self):
        for action in ('delete', 'modify', None):
            with self.subTest(action=action):
                with self.assertRaises(worker_module.Failure) as failure:
                    self.worker.apply_proposal(self.proposal(action), self.cancel, b'')
                self.assertEqual(failure.exception.value['code'], 'INVALID_ARGUMENT')
                self.assertEqual(self.path.read_bytes(), self.original)

    def test_same_size_external_edit_remains_a_hash_conflict(self):
        external = self.original.replace(b'42', b'44')
        self.path.write_bytes(external)
        with self.assertRaises(worker_module.Failure) as failure:
            self.worker.apply_proposal(self.proposal(), self.cancel, b'')
        self.assertEqual(failure.exception.value['code'], 'FILE_CONFLICT')
        self.assertEqual(self.path.read_bytes(), external)

    def test_undo_returns_shared_changes_and_restores_exact_bytes(self):
        applied, _ = self.worker.apply_proposal(self.proposal(), self.cancel, b'')
        undone, _ = self.worker.undo_transaction(dict(transactionId=applied['transactionId']), self.cancel, b'')
        self.assertEqual(undone['transactionId'], applied['transactionId'])
        self.assertEqual(undone['status'], 'undone')
        self.assertEqual(undone['changed'][0]['path'], 'main.tex')
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_undo_never_overwrites_a_later_human_edit(self):
        applied, _ = self.worker.apply_proposal(self.proposal(), self.cancel, b'')
        external = b'A later human revision\n'
        self.path.write_bytes(external)
        with self.assertRaises(worker_module.Failure) as failure:
            self.worker.undo_transaction(dict(transactionId=applied['transactionId']), self.cancel, b'')
        self.assertEqual(failure.exception.value['code'], 'FILE_CONFLICT')
        self.assertEqual(self.path.read_bytes(), external)


@unittest.skipUnless(os.name == 'posix', 'Metadata migration requires POSIX')
class RemoteMetadataMigration(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='texypaper-migration-')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.legacy = self.root / '.paperdock'
        self.current = self.root / '.texypaper'
        self.legacy.mkdir()
        self.cancel = threading.Event()

    def write_json(self, relative, value):
        path = self.legacy / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(worker_module.compact(value))
        return path

    def open(self):
        worker = worker_module.Worker()
        self.addCleanup(worker.shutdown)
        worker.open_root(dict(root=str(self.root), workspaceId='stable_workspace', epoch=1), self.cancel, b'')
        return worker

    def assert_open_failure(self, code):
        with self.assertRaises(worker_module.Failure) as failure:
            self.open()
        self.assertEqual(failure.exception.value['code'], code)

    def test_rename_preserves_documents_settings_comments_and_opaque_private_bytes(self):
        document = b'User prose about .paperdock stays unchanged.\r\n'
        (self.root / 'main.tex').write_bytes(document)
        settings = worker_module.compact(dict(version=1, rootTex='main.tex', engine='xelatex',
                                             profile='basic', autoBuild=False))
        comments = b'{"version":1,"threads":[],"note":"Keep .paperdock prose"}\n'
        (self.legacy / 'project.json').write_bytes(settings)
        (self.legacy / 'comments.json').write_bytes(comments)
        for relative in ('recovery/unsaved.tex', 'trash/old/main.tex', 'transactions/old/0.before'):
            path = self.legacy / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(document)
        identity = self.legacy.stat().st_ino
        worker = self.open()
        self.assertFalse(self.legacy.exists())
        self.assertEqual(self.current.stat().st_ino, identity)
        self.assertEqual(worker.workspace_id, 'stable_workspace')
        self.assertEqual(worker.main_tex, 'main.tex')
        self.assertEqual((self.root / 'main.tex').read_bytes(), document)
        self.assertEqual((self.current / 'project.json').read_bytes(), settings)
        self.assertEqual((self.current / 'comments.json').read_bytes(), comments)
        for relative in ('recovery/unsaved.tex', 'trash/old/main.tex', 'transactions/old/0.before'):
            self.assertEqual((self.current / relative).read_bytes(), document)
        self.assertFalse((self.current / '.texypaper-migration').exists())
        # No marker means ordinary subsequent opens leave migrated bytes untouched.
        self.open()
        self.assertEqual((self.current / 'comments.json').read_bytes(), comments)

    def test_pending_internal_transaction_recovers_after_private_path_adaptation(self):
        before, after = b'{"threads":[]}\n', b'{"threads":[],"changed":true}\n'
        directory = self.legacy / 'transactions' / 'pending'
        directory.mkdir(parents=True)
        (directory / '0.before').write_bytes(before)
        (directory / '0.after').write_bytes(after)
        (self.legacy / 'comments.json').write_bytes(after)
        self.write_json('transactions/pending/journal.json', dict(
            version=1, transactionId='pending', status='applying', applied=[0], nextIndex=0,
            summary='User mentioned .paperdock/comments.json',
            files=[dict(path='.paperdock/comments.json', internal=True, action='modify',
                        beforeFile='0.before', afterFile='0.after', beforeSha256=worker_module.digest(before),
                        afterSha256=worker_module.digest(after), mode=0o600)]))
        self.open()
        self.assertEqual((self.current / 'comments.json').read_bytes(), before)
        journal = json.loads((self.current / 'transactions/pending/journal.json').read_bytes())
        self.assertEqual(journal['status'], 'rolled_back')
        self.assertEqual(journal['files'][0]['path'], '.texypaper/comments.json')
        self.assertEqual(journal['files'][0]['beforeFile'], '0.before')
        self.assertEqual(journal['summary'], 'User mentioned .paperdock/comments.json')
        self.assertEqual((self.current / 'transactions/pending/0.after').read_bytes(), after)

    def test_trash_journal_remains_restorable_without_rewriting_document_bytes(self):
        data = b'User document contains .paperdock/trash/literal.\n'
        target = self.legacy / 'trash' / 'trashed' / 'main.tex'
        target.parent.mkdir(parents=True)
        target.write_bytes(data)
        self.write_json('transactions/trashed/journal.json', dict(
            version=1, transactionId='trashed', status='committed', kind='trash',
            source='main.tex', destination='.paperdock/trash/trashed/main.tex',
            signature=worker_module.digest(data),
            result=dict(transactionId='trashed', status='committed', path='main.tex',
                        newPath='.paperdock/trash/trashed/main.tex')))
        worker = self.open()
        result, _ = worker.restore(dict(transactionId='trashed', restoreTransactionId='restored'), self.cancel, b'')
        self.assertEqual(result['newPath'], 'main.tex')
        self.assertEqual((self.root / 'main.tex').read_bytes(), data)

    def test_native_and_remote_build_manifests_adapt_only_private_artifact_fields(self):
        manifest = dict(version=1, buildId='oldbuild', workspaceId='stable_workspace',
                        pdfPath='.paperdock/build/root/published/oldbuild/main.pdf',
                        syncPath='.paperdock/build/root/published/oldbuild/main.synctex.gz',
                        rootTex='main.tex', mappingReady=True, mappingReason='old',
                        sources=[dict(path='main.tex', snapshotPath='.paperdock/build/root/published/oldbuild/sources/main.tex')],
                        userNote='Do not rewrite .paperdock/build in prose')
        for relative in ('build/root/latest.json', 'build/root/published/oldbuild/manifest.json',
                         'build/root/pending/oldbuild/manifest.json'):
            self.write_json(relative, manifest)
        self.write_json('build/latest.json', dict(manifest=manifest))
        self.write_json('build/status.json', dict(status='published', manifest=manifest, logTail='.paperdock log remains'))
        self.write_json('transactions/native/journal.json', dict(
            version=1, status='committed', transactionId='native', affected=['.paperdock/comments.json'],
            records=[dict(path='.paperdock/comments.json', backup='.paperdock/transactions/native/before',
                          stage='.paperdock/transactions/native/after', before='opaque', after='opaque')]))
        worker = self.open()
        for relative in ('build/root/latest.json', 'build/root/published/oldbuild/manifest.json',
                         'build/root/pending/oldbuild/manifest.json'):
            value = json.loads((self.current / relative).read_bytes())
            self.assertTrue(value['pdfPath'].startswith('.texypaper/'))
            self.assertTrue(value['syncPath'].startswith('.texypaper/'))
            self.assertTrue(value['sources'][0]['snapshotPath'].startswith('.texypaper/'))
            self.assertEqual(value['sources'][0]['path'], 'main.tex')
            self.assertFalse(value['mappingReady'])
            self.assertEqual(value['userNote'], manifest['userNote'])
        self.assertFalse(worker.build_state['manifest']['mappingReady'])
        self.assertEqual(worker.build_state['logTail'], '.paperdock log remains')
        native = json.loads((self.current / 'transactions/native/journal.json').read_bytes())
        self.assertEqual(native['records'][0]['backup'], '.texypaper/transactions/native/before')
        self.assertEqual(native['affected'], ['.texypaper/comments.json'])
        for inverse in (False, True):
            with self.assertRaises(worker_module.Failure) as failure:
                worker.synctex(dict(buildId='oldbuild'), self.cancel, inverse)
            self.assertEqual(failure.exception.value['code'], 'PDF_STALE')

    def test_interrupted_post_rename_migration_resumes_before_recovery(self):
        self.write_json('transactions/old/journal.json', dict(
            version=1, transactionId='old', status='committed', files=[],
            source='main.tex', destination='.paperdock/trash/old/main.tex',
            affectedPaths=['.paperdock/trash/old/main.tex'],
            result=dict(path='main.tex', newPath='.paperdock/trash/old/main.tex')))
        (self.legacy / '.texypaper-migration').write_bytes(b'1\n')
        self.legacy.rename(self.current)
        self.open()
        journal = json.loads((self.current / 'transactions/old/journal.json').read_bytes())
        self.assertEqual(journal['destination'], '.texypaper/trash/old/main.tex')
        self.assertEqual(journal['affectedPaths'], ['.texypaper/trash/old/main.tex'])
        self.assertEqual(journal['result']['newPath'], '.texypaper/trash/old/main.tex')
        self.assertFalse((self.current / '.texypaper-migration').exists())

    def test_two_stores_conflict_without_merge_or_deletion(self):
        (self.legacy / 'comments.json').write_bytes(b'legacy')
        self.current.mkdir()
        (self.current / 'comments.json').write_bytes(b'current')
        self.assert_open_failure('METADATA_MIGRATION_CONFLICT')
        self.assertEqual((self.legacy / 'comments.json').read_bytes(), b'legacy')
        self.assertEqual((self.current / 'comments.json').read_bytes(), b'current')

    def test_root_and_nested_symlinks_and_non_directory_store_are_rejected(self):
        outside = tempfile.TemporaryDirectory(prefix='texypaper-outside-')
        self.addCleanup(outside.cleanup)
        target = pathlib.Path(outside.name)
        (target / 'sentinel').write_bytes(b'untouched')
        self.legacy.rmdir()
        self.legacy.symlink_to(target, target_is_directory=True)
        self.assert_open_failure('METADATA_MIGRATION_UNSAFE')
        self.legacy.unlink()
        self.legacy.write_bytes(b'not a directory')
        self.assert_open_failure('METADATA_MIGRATION_UNSAFE')
        self.legacy.unlink()
        self.legacy.mkdir()
        (self.legacy / 'recovery').symlink_to(target, target_is_directory=True)
        self.assert_open_failure('METADATA_MIGRATION_UNSAFE')
        self.assertFalse(self.current.exists())
        self.assertEqual((target / 'sentinel').read_bytes(), b'untouched')
        (self.legacy / 'recovery').unlink()
        (self.legacy / 'broken').symlink_to(target / 'missing')
        self.assert_open_failure('METADATA_MIGRATION_UNSAFE')

    def test_ambiguous_or_escaping_journal_paths_fail_before_rename(self):
        for paths in (['.paperdock/comments.json', '.texypaper/comments.json'],
                      ['.paperdock/../main.tex'], ['.texypaper/../main.tex']):
            with self.subTest(paths=paths):
                self.write_json('transactions/bad/journal.json', dict(
                    version=1, transactionId='bad', status='committed',
                    files=[dict(path=path) for path in paths]))
                self.assert_open_failure('METADATA_MIGRATION_INVALID')
                self.assertTrue(self.legacy.is_dir())
                self.assertFalse(self.current.exists())
                self.assertFalse((self.legacy / '.texypaper-migration').exists())

    def test_both_private_names_and_canonical_aliases_are_denied_to_agents(self):
        worker = self.open()
        for name in ('.paperdock', '.texypaper'):
            store = self.root / name
            store.mkdir(exist_ok=True)
            (store / 'project.json').write_bytes(b'private')
            alias = self.root / (name[1:] + '-alias')
            alias.symlink_to(store, target_is_directory=True)
            for relative in (name + '/project.json', alias.name + '/project.json'):
                with self.subTest(path=relative):
                    with self.assertRaises(worker_module.Failure) as failure:
                        worker.agent_path(relative)
                    self.assertEqual(failure.exception.value['code'], 'READ_DENIED')


    def test_explicit_private_transaction_fingerprint_remains_idempotent(self):
        data = b'{"version":1,"threads":[]}\n'
        record = dict(path='.paperdock/comments.json', action='create', internal=True,
                      beforeSha256=None, afterSha256=worker_module.digest(data),
                      beforeFile=None, afterFile='0.after', mode=0o600)
        fingerprint = worker_module.digest(worker_module.compact([
            dict(path=record['path'], baseSha256=None, action='create', resultSha256=record['afterSha256'])]))
        (self.legacy / 'comments.json').write_bytes(data)
        self.write_json('transactions/comments/journal.json', dict(
            version=1, transactionId='comments', status='committed', files=[record], fingerprint=fingerprint,
            result=dict(transactionId='comments', status='committed', paths=['.paperdock/comments.json'],
                        revisions=[dict(file=dict(workspaceId='stable_workspace', path='.paperdock/comments.json'))])))
        worker = self.open()
        result = worker.apply_files('comments', [dict(path='.texypaper/comments.json', action='create',
                                                     internal=True, baseSha256=None, data=data)],
                                    update_comments=False)
        self.assertEqual(result['paths'], ['.texypaper/comments.json'])
        self.assertEqual(result['revisions'][0]['file']['path'], '.texypaper/comments.json')
        self.assertEqual((self.current / 'comments.json').read_bytes(), data)

    def test_invalid_recognized_json_is_rejected_without_partial_migration(self):
        journal = self.legacy / 'transactions' / 'invalid' / 'journal.json'
        journal.parent.mkdir(parents=True)
        journal.write_bytes(b'{"files":')
        self.assert_open_failure('METADATA_MIGRATION_INVALID')
        self.assertTrue(self.legacy.is_dir())
        self.assertFalse(self.current.exists())
        self.assertEqual(journal.read_bytes(), b'{"files":')
        self.assertFalse((self.legacy / '.texypaper-migration').exists())


    def test_unrecognized_migration_marker_does_not_authorize_migration(self):
        marker = self.legacy / '.texypaper-migration'
        marker.write_bytes(b'unknown')
        self.assert_open_failure('METADATA_MIGRATION_INVALID')
        self.assertEqual(marker.read_bytes(), b'unknown')
        self.assertTrue(self.legacy.is_dir())
        self.assertFalse(self.current.exists())


if __name__ == '__main__':
    if os.name != 'posix':
        raise SystemExit('Remote worker regressions require POSIX Python >=3.9; run inside the registered WSL host.')
    unittest.main()
