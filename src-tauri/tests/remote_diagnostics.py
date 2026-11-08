"""Native/SSH diagnostic parity using captured TeX Live and latexmk output shapes."""
import importlib.util
import pathlib
import tempfile
import threading
import unittest
import uuid

source = pathlib.Path(__file__).resolve().parents[1] / 'resources' / 'remote_worker.py'
spec = importlib.util.spec_from_file_location('texypaper_diagnostics_worker', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RemoteDiagnosticsContract(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='texypaper-diagnostics-')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name).resolve()
        (self.root / 'broken.tex').write_text('\\undefined', encoding='utf-8')
        (self.root / 'sections').mkdir()
        (self.root / 'sections' / 'included.tex').write_text('\\undefined', encoding='utf-8')
        self.worker = module.Worker()
        self.addCleanup(self.worker.shutdown)
        self.worker.open_root(dict(root=str(self.root), workspaceId=uuid.uuid4().hex, epoch=1), threading.Event(), b'')

    def parse(self, text):
        return self.worker.diagnostics(text, self.root, 'broken.tex')

    def test_windows_and_linux_wrappers_do_not_duplicate_document_errors(self):
        rows = self.parse(
            './broken.tex:3: Undefined control sequence.\n'
            './broken.tex:3: Undefined control sequence.\n'
            'Latexmk: Errors, so I did not complete making targets\n'
            'Collected error summary (may duplicate other messages):\n'
            "  pdflatex: Command for 'pdflatex' gave return code 1\n"
            'C:\\texlive\\2026\\bin\\windows\\runscript.tlu:933: command failed with exit code 12:\n'
            '/usr/share/texlive/texmf-dist/scripts/latexmk/latexmk.pl:123: command failed with exit code 12\n')
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]['path'], rows[0]['line'], rows[0]['severity']), ('broken.tex', 3, 'error'))
        self.assertFalse(rows[0]['inferred'])

    def test_wrapper_only_failures_keep_one_clear_error_even_with_warnings(self):
        for text in (
            'C:\\texlive\\2026\\bin\\windows\\runscript.tlu:933: command failed with exit code 12:\n',
            'Latexmk: Errors, so I did not complete making targets\nCollected error summary (may duplicate other messages):\n  bibtex main: Bibtex errors: See file main.blg\n',
            "LaTeX Warning: Citation `missing' undefined\n\n  biber main: Biber errors: See file main.blg\n",
        ):
            with self.subTest(text=text):
                errors = [row for row in self.parse(text) if row['severity'] == 'error']
                self.assertEqual(len(errors), 1)
                self.assertIsNone(errors[0]['path'])
                self.assertIsNone(errors[0]['line'])
                self.assertTrue(errors[0]['inferred'])
                self.assertTrue(errors[0]['message'].startswith('LaTeX build failed: '))

    def test_bib_warnings_included_and_external_inputs_are_preserved(self):
        rows = self.parse(
            'Warning--I didn\'t find a database entry for "missing"\n'
            "[42] Biber.pm:130> WARN - I didn't find a database entry for 'other'\n"
            "LaTeX Warning: Citation `missing' on page 1 undefined on input line 8.\n\n"
            './sections/included.tex:7: Undefined control sequence.\n'
            '/outside/included.tex:8: Missing $ inserted.\n'
            '/usr/share/texlive/texmf-dist/tex/luatex/package/input.lua:9: invalid input\n'
            '/usr/share/texlive/texmf-dist/scripts/driver/driver.lua:9: driver failed\n'
            "  biber main: Biber errors: See file 'main.blg'\n")
        self.assertEqual(len(rows), 6)
        self.assertEqual(sum(row['severity'] == 'warning' for row in rows), 3)
        included = next(row for row in rows if row.get('line') == 7)
        self.assertEqual(included['path'], 'sections/included.tex')
        for number in (8, 9):
            row = next(row for row in rows if row.get('line') == number)
            self.assertIsNone(row['path'])
            self.assertTrue(row['inferred'])
            self.assertEqual(row['severity'], 'error')
        self.assertFalse(any('driver failed' in row['message'] for row in rows))

    def test_project_scripts_and_real_biber_error_are_not_noise(self):
        (self.root / 'check.lua').write_text('error()', encoding='utf-8')
        rows = self.parse('./check.lua:4: command failed with exit code 1\n'
                          "[10] Biber.pm:130> ERROR - Cannot find 'main.bcf'!\n"
                          '/outside/input.tex:12: command failed with exit code 1\n'
                          '/opt/tools/driver.lua:15: command failed with exit code 1\n'
                          "  biber main: Biber errors: See file 'main.blg'\n")
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]['path'], 'check.lua')
        self.assertIn("Cannot find 'main.bcf'", rows[1]['message'])
        self.assertIsNone(rows[2]['path'])
        self.assertTrue(rows[2]['inferred'])
        self.assertEqual(rows[2]['line'], 12)


if __name__ == '__main__':
    unittest.main()
