"""Labnote entry point for the actual hidden-release source-to-PDF measurement."""
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
parser.add_argument('--binary', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--variant', required=True)
parser.add_argument('--verify', action='store_true')
parser.add_argument('--comparison', help='CorTeX actual viewport JSON; measures matched local source/PDF views only')
parser.add_argument('--resident', action='store_true', help='Wait for the local resident engine; separately prove the authoritative final PDF')
parser.add_argument('--case', choices=['local-short','local-long','ssh-short'], help='Run only the selected independent host/document scenario')
args = parser.parse_args()
if args.case == 'ssh-short' and args.comparison:
    parser.error('The CorTeX comparison is local; use --case ssh-short without --comparison.')
with open(args.binary, 'rb') as executable:
    binary_sha256 = hashlib.file_digest(executable, 'sha256').hexdigest()
config={'variant': args.variant, 'binary_sha256': binary_sha256, 'rounds': 7, 'cases': ['local-short', 'local-long', 'ssh-short'], 'viewport': [1440, 900], 'engine': 'pdflatex', 'profile': 'basic', 'measurement': 'beforeinput-to-matching-rendered-PDF-text; resource-timing IPC stages', 'hidden_release': True, 'verify': args.verify}
if args.resident:
    config.update(resident=True,measurement='beforeinput-to-first-correct-visible-PDF; separately verify saved canonical PDF')
if args.comparison:
    viewport=json.loads(Path(args.comparison).read_text(encoding='utf-8'))
    config.update(cases=['local-short','local-long'],viewport=[viewport['width'],viewport['height']],device_scale_factor=viewport['deviceScaleFactor'],panels='source+PDF; side and AI panels closed')
if args.case:
    config['cases']=[args.case]
labrun.config(config)
env = dict(os.environ, TEXYPAPER_LAB_MEASUREMENT='1')
command = ['node', 'scripts/measure-live-latency.mjs', '--binary', args.binary, '--output', args.output, '--variant', args.variant]
if args.verify:
    command.append('--verify')
if args.comparison:
    command.extend(['--comparison',args.comparison])
if args.resident:
    command.append('--resident')
if args.case:
    command.extend(['--case',args.case])
result = subprocess.run(command, env=env, check=False)
report_path = Path(args.output) / 'latency-results.json'
if report_path.exists():
    labrun.artifact(str(report_path), kind='metrics', note='Actual Tauri/WebView2, native TeX and isolated SSH observations')
    report = json.loads(report_path.read_text(encoding='utf-8'))
    for case in report.get('cases', []):
        for sample in case['samples']:
            labrun.log(step=sample['index'], case=case['name'], edit_to_pdf_ms=sample['edit_to_pdf_ms'], build_ms=sample['build_ms'], preview_ms=sample['preview_ms'])
    if report.get('complete'):
        metrics = {f"{case['name'].replace('-', '_')}_median_ms": case['median_ms'] for case in report['cases']}
        metrics['edit_to_pdf_median_ms'] = report['cases'][0]['median_ms']
        labrun.summary(**metrics)
if result.returncode:
    sys.exit(result.returncode)
