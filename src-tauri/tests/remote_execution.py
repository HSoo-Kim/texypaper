"""Actual POSIX command-group regressions in disposable projects, no SSH/provider mocks.
Native approval/default-deny authority is covered by execution.rs; this tests its internal worker transport.
"""
import importlib.util
import os
import pathlib
import sys
import tempfile
import threading
import time
import unittest
import uuid

source = pathlib.Path(__file__).resolve().parents[1] / 'resources' / 'remote_worker.py'
spec = importlib.util.spec_from_file_location('texypaper_execution_worker', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@unittest.skipUnless(os.name == 'posix', 'Remote command ownership requires POSIX')
class RemoteExecutionContract(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='texypaper-command-')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.worker = module.Worker()
        self.addCleanup(self.worker.shutdown)
        self.cancel = threading.Event()
        self.worker.open_root(dict(root=str(self.root), workspaceId=uuid.uuid4().hex, epoch=1), self.cancel, b'')

    def args(self, script, timeout=120):
        return dict(id=uuid.uuid4().hex, cwd='', argv=[pathlib.Path(sys.executable).name, '-c', script], timeoutSeconds=timeout)

    def start(self, args):
        return self.worker.command_start(args, self.cancel, b'')[0]

    def finished(self, args):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            row = self.worker.command_status(dict(id=args['id']), self.cancel, b'')[0]
            if row['status'] != 'running':
                return row
            time.sleep(0.02)
        self.fail('Owned command did not terminate')

    def test_duplicate_start_is_not_replayed_and_output_is_real_bounded(self):
        args = self.args("from pathlib import Path; import sys; p=Path('marker'); p.write_text(p.read_text()+'x' if p.exists() else 'x'); print('x'*100000); print('stderr',file=sys.stderr); sys.exit(7)")
        self.start(args)
        self.start(args)
        row = self.finished(args)
        self.start(args)
        self.assertEqual((self.root / 'marker').read_text(), 'x')
        self.assertEqual(row['status'], 'failed')
        self.assertEqual(row['exitCode'], 7)
        self.assertIn('stderr', row['stderr'])
        self.assertTrue(row['truncated'])
        self.assertLessEqual(len(row['stdout'].encode()), 16384)

    def test_timeout_and_cancel_stop_descendants_before_returning(self):
        for timeout, cancel in ((1, False), (120, True)):
            with self.subTest(cancel=cancel):
                for name in ('ready', 'descendant-marker'):
                    (self.root / name).unlink(missing_ok=True)
                child = "import time; from pathlib import Path; time.sleep(2); Path('descendant-marker').write_text('orphan')"
                script = "import subprocess,sys,time; from pathlib import Path; subprocess.Popen([sys.executable,'-c'," + repr(child) + "]); Path('ready').write_text('ready'); time.sleep(30)"
                args = self.args(script, timeout)
                self.start(args)
                deadline = time.monotonic() + 5
                while not (self.root / 'ready').exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue((self.root / 'ready').exists())
                row = self.worker.command_cancel(dict(id=args['id']), self.cancel, b'')[0] if cancel else self.finished(args)
                self.assertEqual(row['status'], 'cancelled' if cancel else 'timeout')
                self.assertIsNotNone(row['exitCode'])
                time.sleep(2.1)
                self.assertFalse((self.root / 'descendant-marker').exists())

    def test_cwd_symlink_escape_old_epoch_and_invalid_argv_have_no_effects(self):
        outside = tempfile.TemporaryDirectory(prefix='texypaper-outside-')
        self.addCleanup(outside.cleanup)
        (self.root / 'escape').symlink_to(outside.name, target_is_directory=True)
        for cwd in ('..', 'escape', '/tmp'):
            args = self.args("from pathlib import Path; Path('marker').write_text('bad')")
            args['cwd'] = cwd
            with self.assertRaises(module.Failure):
                self.start(args)
        args = self.args("from pathlib import Path; Path('marker').write_text('bad')")
        request = dict(v=1, id=1, op='command_start', workspaceId=self.worker.workspace_id, epoch=0, args=args)
        with self.assertRaises(module.Failure):
            self.worker.dispatch(request, self.cancel, b'')
        for argv in ([], ['python3', '\x00'], ['python3'] * 129, ['python3', 'x' * 8193]):
            args['argv'] = argv
            with self.assertRaises(module.Failure):
                self.start(args)
        self.assertFalse((self.root / 'marker').exists())
        self.assertFalse((pathlib.Path(outside.name) / 'marker').exists())

    def test_argv_is_not_shell_interpolated_and_stdin_is_closed(self):
        args = self.args("import sys; print(repr(sys.stdin.read())); print(sys.argv[1])")
        args['argv'].append('$(touch marker); & echo injected')
        self.start(args)
        row = self.finished(args)
        self.assertEqual(row['status'], 'completed')
        self.assertIn("''", row['stdout'])
        self.assertIn('$(touch marker); & echo injected', row['stdout'])
        self.assertFalse((self.root / 'marker').exists())

    def test_both_channels_stream_while_process_is_running(self):
        args = self.args("import sys,time; print('LIVE',flush=True); print('LIVEERR',file=sys.stderr,flush=True); time.sleep(30)")
        self.start(args)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            row = self.worker.command_status(dict(id=args['id']), self.cancel, b'')[0]
            if 'LIVE' in row['stdout'] and 'LIVEERR' in row['stderr']:
                self.assertEqual(row['status'], 'running')
                break
            time.sleep(0.02)
        else:
            self.fail('Both channels must stream before process exit')
        row = self.worker.command_cancel(dict(id=args['id']), self.cancel, b'')[0]
        self.assertEqual(row['status'], 'cancelled')

    def test_application_private_environment_is_not_inherited_by_commands(self):
        # The legacy prefix remains denied only to protect secrets after migration.
        names = ('TEXYPAPER_TEST_PRIVATE_SENTINEL', 'PAPERDOCK_TEST_PRIVATE_SENTINEL')
        previous = {name: os.environ.get(name) for name in names}
        try:
            for name in names:
                os.environ[name] = 'synthetic-test-value'
            args = self.args("import os; print([name in os.environ for name in " + repr(names) + "])")
            self.start(args)
            row = self.finished(args)
            self.assertEqual(row['status'], 'completed')
            self.assertIn('[False, False]', row['stdout'])
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def test_shutdown_waits_for_owned_command(self):
        args = self.args('import time; time.sleep(30)')
        self.start(args)
        self.worker.shutdown()
        row = self.finished(args)
        self.assertEqual(row['status'], 'cancelled')


if __name__ == '__main__':
    unittest.main()
