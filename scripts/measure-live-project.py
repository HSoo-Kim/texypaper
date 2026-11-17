"""Isolated real-project latency and navigation proof, always through labnote."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import labrun

labrun.require()
parser = argparse.ArgumentParser()
for name in ('binary', 'snapshot', 'headless', 'output', 'variant'):
    parser.add_argument('--' + name, required=True)
parser.add_argument('--mode', choices=('baseline', 'candidate', 'page-priority'), required=True)
args = parser.parse_args()
with open(args.binary, 'rb') as file:
    binary_sha256 = hashlib.file_digest(file, 'sha256').hexdigest()
labrun.config({'variant': args.variant, 'binary_sha256': binary_sha256, 'mode': args.mode,
               'rounds': 5, 'engine': 'pdflatex', 'profile': 'basic', 'viewport': [1440, 900],
               'panels': 'source+PDF; file tree retained; AI panel closed',
               'snapshot': args.snapshot, 'source': 'paper/TR-C/03_Method/03_methodology.tex',
               'burst_inputs': 60, 'inter_input_delay_ms': 80,
               'measurement': 'actual beforeinput to matching painted on-screen PDF text; canonical saved source checked separately'})
command = ['node', 'scripts/measure-live-project.mjs']
for name, value in vars(args).items():
    command.extend(['--' + name, value])
result = subprocess.run(command, env=dict(os.environ, TEXYPAPER_LAB_MEASUREMENT='1'), check=False)
report_path = Path(args.output) / 'live-project-results.json'
if report_path.exists():
    labrun.artifact(str(report_path), kind='metrics', note='Immutable actual-project copy; real hidden Tauri/WebView2 and local TeX')
    report = json.loads(report_path.read_text(encoding='utf-8'))
    for index, sample in enumerate(report.get('samples', [])):
        labrun.log(step=index, edit_to_pdf_ms=sample['edit_to_pdf_ms'],
                   edit_to_canonical_pdf_ms=sample['edit_to_canonical_pdf_ms'], provisional=sample['provisional'])
    if report.get('complete'):
        labrun.summary(edit_to_pdf_median_ms=report['edit_to_pdf_median_ms'],
                       canonical_median_ms=report['canonical_median_ms'],
                       initial_ready_ms=report['initial_ready_ms'],
                       intermediate_frames=report['burst']['intermediate_frames'],
                       interaction_verified=args.mode != 'baseline')
sys.exit(result.returncode)
