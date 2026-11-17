"""Recorded real-UI comparison; PDF validation runs after all timing samples."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import statistics
import subprocess
import sys
import xml.etree.ElementTree as ET
import labrun

labrun.require()
p = argparse.ArgumentParser()
p.add_argument('--kind', choices=['cortex', 'texypaper'], required=True)
p.add_argument('--protocol', required=True)
p.add_argument('--output', required=True)
p.add_argument('--script')
p.add_argument('--binary')
p.add_argument('--comparison')
p.add_argument('--validate-only', action='store_true',
               help='Validate a complete saved latency-results.json without launching or replaying either UI.')
a = p.parse_args()
protocol_path = Path(a.protocol).resolve()
protocol = json.loads(protocol_path.read_text(encoding='utf-8'))
output = Path(a.output).resolve()
raw_path = output/'latency-results.json'
mode = 'offline-validation' if a.validate_only else 'measurement-and-validation'
if a.validate_only and not raw_path.is_file():
    p.error('--validate-only requires an existing complete latency-results.json in --output')
config = {'variant':a.kind, 'protocol_sha256':hashlib.sha256(protocol_path.read_bytes()).hexdigest(),
          'documents':protocol['documents'], 'warm_rounds':protocol['warmRounds'],
          'requested_gaps_ms':protocol['delaysMs'], 'measurement':protocol['endpoint'],
          'synthetic_only':True, 'viewport':'actual Cortex readback matched in TexyPaper',
          'execution_mode':mode, 'measurement_executed':not a.validate_only}
if a.validate_only:
    config['raw_report_sha256'] = hashlib.sha256(raw_path.read_bytes()).hexdigest()
elif a.binary:
    config['binary_sha256'] = hashlib.sha256(Path(a.binary).read_bytes()).hexdigest()
labrun.config(config)
if not a.validate_only:
    if a.kind == 'cortex':
        assert a.script
        command = [shutil.which('ego-browser'), 'nodejs', '-e', f"await import('{Path(a.script).resolve().as_uri()}')"]
    else:
        assert a.binary and a.comparison
        command = ['node','scripts/measure-irregular-texypaper.mjs','--binary',a.binary,'--protocol',a.protocol,
                   '--comparison',a.comparison,'--output',a.output,'--variant','texypaper-page-priority']
    result = subprocess.run(command, env=dict(os.environ, TEXYPAPER_LAB_MEASUREMENT='1'), check=False)
    if not raw_path.exists():
        sys.exit(result.returncode or 1)
labrun.artifact(str(raw_path),kind='metrics',
                note='Saved measurement input for offline validation; no UI replay' if a.validate_only
                else 'Raw actual input/render observations; failures retained')
report = json.loads(raw_path.read_text(encoding='utf-8'))
if not a.validate_only and result.returncode:
    sys.exit(result.returncode)
assert report.get('complete') is True and not report.get('error'), 'Raw measurement is incomplete; validation cannot promote a failed or partial run'
assert [case['pages'] for case in report['cases']] == protocol['documents'], 'Raw measurement must contain every protocol document'
assert (report['variant'] == 'cortex') == (a.kind == 'cortex'), 'Raw measurement kind differs from --kind'
if a.kind == 'cortex':
    assert report['protocol'] == protocol, 'Saved measurement protocol differs from --protocol'
else:
    assert all(case.get('complete') is True for case in report['cases']), 'Native measurement contains an incomplete case'

cache = {}
def pdf_data(filename):
    target = Path(filename)
    if not target.is_absolute(): target = output/target
    key = str(target)
    if key not in cache:
        info = subprocess.run([shutil.which('pdfinfo'),str(target)],capture_output=True,check=True).stdout
        pages = int(re.search(rb'^Pages:\s+(\d+)',info,re.MULTILINE).group(1))
        bbox = subprocess.run([shutil.which('pdftotext'),'-bbox-layout','-enc','UTF-8',str(target),'-'],capture_output=True,check=True).stdout
        tree = ET.fromstring(bbox)
        page_data = []
        for page in (e for e in tree.iter() if e.tag.endswith('}page') or e.tag == 'page'):
            lines = [e for e in page.iter() if e.tag.endswith('}line') or e.tag == 'line']
            words = [{'text':''.join(w.itertext()),'line':index,**{k:float(v) for k,v in w.attrib.items()}}
                     for index,line in enumerate(lines) for w in line.iter() if w.tag.endswith('}word') or w.tag == 'word']
            fragments = [{**word,'text':match.group(),
                          'hyphenated':match.group().endswith(('-', '\u00ad', '\u2010')) and match.end() == len(word['text'])}
                         for word in words for match in re.finditer(r'\w+(?:[-\u00ad\u2010])?',word['text'])]
            page_data.append({'width':float(page.attrib['width']),'height':float(page.attrib['height']),
                              'words':words,'fragments':fragments})
        assert len(page_data) == pages, f'PDF page extraction is incomplete: {target}'
        cache[key] = {'pages':pages,'page_data':page_data}
    return cache[key]

def marker_fragments(words, token):
    for start in range(len(words)):
        remaining, matched = token, []
        for index in range(start,len(words)):
            word = words[index]
            part = word['text'][:-1] if word['text'].endswith(('-', '\u00ad', '\u2010')) else word['text']
            if not remaining.startswith(part): break
            # Explicit PDF text lines distinguish wraps even when font boxes
            # overlap vertically. Keep adjacent words and a leftward/downward wrap.
            if index > start:
                previous = words[index-1]
                if not (word['line'] == previous['line']+1 and word['yMin'] > previous['yMin']
                        and word['yMax'] > previous['yMax'] and word['xMin'] < previous['xMin']): break
            matched.append(word)
            remaining = remaining[len(part):]
            if not remaining: return matched
            if not word['hyphenated']: break
    return None

def pdf_has_token(data, token):
    return any(marker_fragments(page['fragments'],token) for page in data['page_data'])

def visible_token(frame, data, token):
    rect, clip = frame['rect'], frame['clip']
    page = data['page_data'][0]  # The recorded CorTeX identity/frame is explicitly page index 0.
    fragments = marker_fragments(page['fragments'],token)
    if not fragments or clip['right'] <= clip['left'] or clip['bottom'] <= clip['top']: return False
    for word in fragments:
        left = rect['x']+word['xMin']/page['width']*rect['width']
        right = rect['x']+word['xMax']/page['width']*rect['width']
        top = rect['y']+word['yMin']/page['height']*rect['height']
        bottom = rect['y']+word['yMax']/page['height']*rect['height']
        if not (right>left and bottom>top and right>clip['left'] and left<clip['right'] and bottom>clip['top'] and top<clip['bottom']): return False
    return True

for case in report['cases']:
    assert len(case['samples']) == protocol['warmRounds']
    irregular = case['irregular']
    tokens = [f"{protocol['burstTokenPrefix']}{i:03d}" for i in range(len(protocol['delaysMs']))]
    expected = protocol['burstPrefix']+' '+' '.join(tokens)
    assert irregular['sourceReadback'] == expected, f"{case['name']}: exact source differs"
    assert len(irregular['inputs']) == len(tokens), f"{case['name']}: incomplete cumulative input sequence"
    if a.kind == 'cortex':
        for index,sample in enumerate(case['samples']):
            assert sample['index'] == index and sample['token'] == f'LATENCYMARKER{chr(65+index)}001'
            assert sample['sourceMatches'] and sample['sourceReadback'] == f"Latency probe {sample['token']}.\n", 'Exact warm source differs'
            data = pdf_data(sample['pdf'])
            assert 1 <= data['pages'] <= case['pages']
            assert visible_token(sample['draw'],data,sample['token']), f"{case['name']}: edited warm token was not visible"
            full = pdf_data(sample['full_pdf'])
            assert full['pages'] == case['pages'] and pdf_has_token(full,sample['token'])
        full = pdf_data(irregular['full_pdf'])
        assert full['pages'] == case['pages'] and all(pdf_has_token(full,token) for token in tokens)
        frames = irregular['frames']
        high = -1
        regressions = []
        for frame in frames:
            data = pdf_data(frame['pdf'])
            present = [i for i,t in enumerate(tokens) if visible_token(frame,data,t)]
            prefix = -1
            while prefix+1 in present: prefix += 1
            frame['visibleTokenIndices'] = present
            frame['prefix'] = prefix
            if high >= 0 and prefix < high: regressions.append({'at':frame['done'],'previous':high,'prefix':prefix,'viewerId':frame['viewerId']})
            high = max(high,prefix)
        for i,input_row in enumerate(irregular['inputs']):
            assert input_row['index'] == i and input_row['token'] == tokens[i] and input_row['sourceMatches']
            assert input_row['sourceReadback'] == protocol['burstPrefix']+' '+' '.join(tokens[:i+1]), 'Exact cumulative input source differs'
            shown = next((f for f in frames if f['done'] >= input_row['started'] and i in f['visibleTokenIndices']),None)
            assert shown, f"Token not observed on a visible frame: {tokens[i]}"
            input_row['done'] = shown['done']
            input_row['edit_to_pdf_ms'] = shown['done']-input_row['started']
            input_row['frameId'] = shown['id']
        irregular['prefixRegressions'] = regressions
        irregular['validation'] = 'verified-PDF-bytes-and-visible-token-bounds'
    else:
        full = pdf_data(case['finalArtifact']['pdfPath'])
        assert full['pages'] == case['pages'] and all(pdf_has_token(full,token) for token in tokens)
        overlap = case.get('nativeBuildOverlapProbe')
        assert irregular['inputsDuringNativeBuild'] or overlap, 'Native-build overlap was not exercised'
        if overlap:
            data = pdf_data(overlap['artifact']['pdfPath'])
            assert data['pages'] == case['pages'] and all(pdf_has_token(data,t) for t in ['OVERLAP000','OVERLAP001'])
    delays = [row['edit_to_pdf_ms'] for row in irregular['inputs']]
    irregular['median_ms'] = statistics.median(delays)
    irregular['max_ms'] = max(delays)
    irregular['p95_ms'] = sorted(delays)[len(delays) - len(delays)//20 - 1]  # nearest rank
    for sample in case['samples']:
        labrun.log(step=sample['index'],case=case['name'],edit_to_pdf_ms=sample['edit_to_pdf_ms'],execution_mode=mode)
    for row in irregular['inputs']:
        labrun.log(step=row['index'],case=case['name']+'-irregular',edit_to_pdf_ms=row['edit_to_pdf_ms'],execution_mode=mode)
    print(json.dumps({'case':case['name'],'warm_median_ms':case['median_ms'],'irregular_median_ms':irregular['median_ms'],
                      'irregular_max_ms':irregular['max_ms'],'prefix_regressions':len(irregular['prefixRegressions']),
                      'execution_mode':mode}))
report['validation'] = 'verified'
verified = output/('revalidated-results.json' if a.validate_only else 'verified-results.json')
verified.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
labrun.artifact(str(verified),kind='metrics',
                note=f'{mode}: PDF text, physical pages, visibility and exact source verified; raw report unchanged')
summary = {'edit_to_pdf_median_ms':report['cases'][0]['median_ms'],
           'irregular_prefix_regressions':sum(len(c['irregular']['prefixRegressions']) for c in report['cases']),
           'source_and_final_pdf_verified':True, 'execution_mode':mode,
           'measurement_executed':not a.validate_only}
for case in report['cases']:
    prefix = f"pages_{case['pages']}"
    summary.update({prefix+'_warm_median_ms':case['median_ms'],prefix+'_irregular_median_ms':case['irregular']['median_ms'],prefix+'_irregular_max_ms':case['irregular']['max_ms']})
labrun.summary(**summary)
