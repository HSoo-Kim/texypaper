// Labnote wrapper only. Real isolated desktop input and rendered-PDF observations; no product hooks.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { assert, parseArgs, requireBinary, createRun, launchDesktop, writeJson } from './smoke-support.mjs';
import { quickOpen } from './smoke-desktop.mjs';

const args = parseArgs();
assert(process.env.TEXYPAPER_LAB_MEASUREMENT === '1', 'Use the labrun Python entry point.');
for (const key of ['protocol', 'comparison', 'output', 'variant']) assert(typeof args[key] === 'string', `Supply --${key}.`);
const binary = await requireBinary(args);
const protocol = JSON.parse(await readFile(path.resolve(args.protocol), 'utf8'));
const viewport = JSON.parse(await readFile(path.resolve(args.comparison), 'utf8'));
assert(JSON.stringify(protocol.documents) === '[1,30]' && protocol.warmRounds === 7 && protocol.delaysMs?.length === 24, 'Expected the shared 1/30-page, seven-warmup, 24-input protocol.');
assert(protocol.delaysMs.every(value => Number.isFinite(value) && value >= 0), 'Invalid input delays.');
assert([viewport.width, viewport.height, viewport.deviceScaleFactor].every(value => Number.isFinite(value) && value > 0), 'Comparison must contain actual width, height and deviceScaleFactor.');
assert(typeof protocol.initialBody === 'string' && typeof protocol.bibliography === 'string' && typeof protocol.burstPrefix === 'string' && typeof protocol.burstTokenPrefix === 'string', 'Incomplete synthetic protocol.');
const markerTokens = ['BASELINEMARKER', ...Array.from({ length: protocol.warmRounds }, (_, index) => `LATENCYMARKER${String.fromCharCode(65 + index)}001`), ...protocol.delaysMs.map((_, index) => `${protocol.burstTokenPrefix}${String(index).padStart(3, '0')}`), 'OVERLAP000', 'OVERLAP001'];
const run = await createRun(args, 'irregular-texypaper');
const report = { variant: args.variant, viewport, complete: false, protocol: path.resolve(args.protocol), binary, cases: [] };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const resultPath = path.join(run.output, 'latency-results.json');
const save = () => writeJson(resultPath, report);
let app;

async function installObserver(page) {
  await page.evaluate(tokens => {
    const probe = window.__irregularNative = { phase: 'initial', armed: null, inputs: [], inputEvents: [], frames: [], statuses: [], identities: [], resources: [], active: true, lastStatus: null, lastFrame: null, nativeBuildIntervals: [] };
    const canvasIds = new WeakMap();
    let nextCanvas = 0;
    performance.setResourceTimingBufferSize(50000);
    const resource = entry => {
      let command;
      try { command = new URL(entry.name).pathname.replace(/^\//, ''); } catch { command = entry.name; }
      probe.resources.push({ name: entry.name, command, start: entry.startTime, end: entry.responseEnd, duration: entry.duration, initiatorType: entry.initiatorType });
    };
    const resourceObserver = new PerformanceObserver(list => list.getEntries().forEach(resource));
    resourceObserver.observe({ type: 'resource', buffered: true });
    const state = () => {
      const status = document.querySelector('[data-testid="build-status"]');
      return { status: status?.dataset.status ?? null, buildId: status?.dataset.buildId ?? null, sequence: status?.dataset.sequence ?? null };
    };
    const statusCheck = () => {
      const current = state(), signature = JSON.stringify(current);
      if (signature === probe.lastStatus) return;
      const at = performance.now();
      probe.lastStatus = signature;
      probe.statuses.push({ at, phase: probe.phase, ...current });
      const open = probe.nativeBuildIntervals.at(-1);
      if (current.status === 'building') {
        if (!open || open.end !== null) probe.nativeBuildIntervals.push({ start: at, end: null, phase: probe.phase, ...current });
      } else if (open?.end === null) Object.assign(open, { end: at, terminalStatus: current.status });
    };
    const sourceTarget = event => event.target instanceof Element && event.target.closest('[data-testid="source-editor"]');
    document.addEventListener('beforeinput', event => {
      if (!sourceTarget(event)) return;
      statusCheck();
      const input = { ...probe.armed, phase: probe.phase, started: performance.now(), data: event.data, inputType: event.inputType, isTrusted: event.isTrusted, isComposing: event.isComposing, ...state(), previousFrameId: document.querySelector('.pdf-preview')?.dataset.buildId ?? null };
      input.gap_ms = probe.inputs.length ? input.started - probe.inputs.at(-1).started : null;
      probe.inputs.push(input);
      probe.armed = null;
    }, true);
    document.addEventListener('input', event => {
      if (sourceTarget(event)) probe.inputEvents.push({ at: performance.now(), phase: probe.phase, data: event.data, inputType: event.inputType, isTrusted: event.isTrusted, source: document.querySelector('[data-testid="source-editor"] .cm-content')?.innerText ?? null });
    }, true);
    for (const name of ['texypaper:pdf-identity', 'texypaper:pdf-frame']) window.addEventListener(name, event => probe.identities.push({ at: performance.now(), phase: probe.phase, name, ...event.detail }));
    const intersects = (a, b) => a.width > 0 && a.height > 0 && b.right > b.left && b.bottom > b.top && a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right;
    const markerFragments = (words, token) => {
      for (let start = 0; start < words.length; start++) {
        let remaining = token;
        const matched = [];
        for (let index = start; index < words.length; index++) {
          const word = words[index], previous = words[index - 1];
          const part = /[-\u00ad\u2010]$/.test(word.text) ? word.text.slice(0, -1) : word.text;
          if (!remaining.startsWith(part)) break;
          // PDF.js line boxes can overlap vertically. Require its explicit EOL,
          // adjacent words, downward progression and a leftward wrap instead of
          // requiring disjoint boxes; same-line hyphens never join.
          if (index > start && !(word.line === previous.line + 1 && word.top > previous.top && word.bottom > previous.bottom && word.left < previous.left)) break;
          matched.push(word);
          remaining = remaining.slice(part.length);
          if (!remaining) return matched;
          if (!word.hyphenated) break;
        }
      }
      return null;
    };
    const tick = () => {
      if (!probe.active) return;
      statusCheck();
      const preview = document.querySelector('.pdf-preview'), scroll = preview?.querySelector('.pdf-scroll');
      const bounds = scroll?.getBoundingClientRect();
      if (preview?.dataset.buildId && bounds) {
        const screen = { left: Math.max(0, bounds.left), top: Math.max(0, bounds.top), right: Math.min(innerWidth, bounds.right), bottom: Math.min(innerHeight, bounds.bottom) };
        const layers = [...preview.querySelectorAll('[data-testid="pdf-text-layer"][data-ready="true"]')].flatMap(layer => {
          const node = layer.closest('.pdf-page'), canvas = node?.querySelector('canvas');
          if (!canvas?.width || !canvas?.height || !intersects(canvas.getBoundingClientRect(), screen) || getComputedStyle(canvas).visibility === 'hidden' || !canvas.getClientRects().length) return [];
          if (!canvasIds.has(canvas)) canvasIds.set(canvas, ++nextCanvas);
          const elements = [...layer.querySelectorAll('span, br')];
          const spans = elements.filter(span => span.tagName === 'SPAN' && intersects(span.getBoundingClientRect(), screen));
          let line = 0;
          const words = elements.flatMap(span => {
            if (span.tagName === 'BR') { line++; return []; }
            return [...span.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).flatMap(node => [...node.textContent.matchAll(/[\p{L}\p{N}\p{M}_]+(?:[-\u00ad\u2010])?/gu)].map(match => {
              const range = document.createRange();
              range.setStart(node, match.index);
              range.setEnd(node, match.index + match[0].length);
              const rect = range.getBoundingClientRect();
              return { text: match[0], line, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, visible: intersects(rect, screen), hyphenated: /[-\u00ad\u2010]$/.test(match[0]) && !/\S/.test(node.textContent.slice(match.index + match[0].length)) };
            }));
          });
          const fragments = Object.fromEntries(tokens.map(token => [token, markerFragments(words, token)]).filter(([, parts]) => parts));
          const visibleTokens = Object.keys(fragments).filter(token => fragments[token].every(word => word.visible));
          return [{ page: Number(node.dataset.page), stale: node.dataset.previewStale === 'true', canvasId: canvasIds.get(canvas), width: canvas.width, height: canvas.height, text: spans.map(span => span.textContent).join(' '), fullLayerText: layer.textContent, wordFragments: words, markerFragments: fragments, visibleTokens }];
        });
        if (layers.length) {
          const text = layers.map(layer => layer.text).join(' ');
          const frame = { id: preview.dataset.buildId, live: preview.dataset.livePreview === 'true', kind: preview.dataset.previewKind, ready: preview.dataset.liveReady === 'true', pageCount: Number(preview.querySelector('.pdf-page-count')?.textContent.match(/\d+/)?.[0]), exportDisabled: preview.querySelector('.pdf-export')?.disabled ?? null, ...state(), text, layers, clip: screen, visibleTokens: [...new Set(layers.flatMap(layer => layer.visibleTokens))] };
          const signature = JSON.stringify(frame);
          if (signature !== probe.lastFrame) {
            probe.lastFrame = signature;
            probe.frames.push({ index: probe.frames.length, at: performance.now(), phase: probe.phase, ...frame });
          }
        }
      }
      requestAnimationFrame(tick);
    };
    new MutationObserver(statusCheck).observe(document.querySelector('#root') ?? document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status', 'data-build-id', 'data-sequence'] });
    probe.snapshot = () => {
      resourceObserver.takeRecords().forEach(resource);
      return { inputs: probe.inputs, inputEvents: probe.inputEvents, frames: probe.frames, statuses: probe.statuses, identities: probe.identities, resources: probe.resources, nativeBuildIntervals: probe.nativeBuildIntervals, current: state(), editorSource: document.querySelector('[data-testid="source-editor"] .cm-content')?.innerText ?? null };
    };
    requestAnimationFrame(tick);
  }, markerTokens);
}

async function insert(page, { phase, index, token, text, replace = false, requestedDelayMs = null }) {
  if (replace) {
    await page.getByTestId('source-editor').locator('.cm-content').focus();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Control+Shift+End');
  }
  await page.evaluate(value => { const probe = window.__irregularNative; probe.phase = value.phase; probe.armed = value; }, { phase, index, token, intendedData: text, requestedDelayMs });
  await page.keyboard.insertText(text);
}

async function waitCanonical(page, token, previousId = null) {
  await page.waitForFunction(({ token, previousId }) => {
    const probe = window.__irregularNative, preview = document.querySelector('.pdf-preview'), status = document.querySelector('[data-testid="build-status"]');
    const frame = probe.frames.at(-1);
    return frame && !frame.live && frame.id !== previousId && frame.id === preview?.dataset.buildId && frame.id === status?.dataset.buildId && status?.dataset.status === 'published' && preview?.dataset.liveReady === 'true' && frame.visibleTokens.includes(token) && frame.exportDisabled === false;
  }, { token, previousId }, { timeout: 180000, polling: 'raf' });
  return page.evaluate(() => window.__irregularNative.frames.at(-1));
}

function firstVisible(input, frames) {
  const frame = frames.find(frame => frame.at >= input.started && frame.id !== input.previousFrameId && frame.visibleTokens.includes(input.token));
  return frame ? { ...input, done: frame.at, edit_to_pdf_ms: frame.at - input.started, frameIndex: frame.index, frameId: frame.id, provisional: frame.live, pageCount: frame.pageCount } : { ...input, done: null, edit_to_pdf_ms: null };
}

function prefixRegressions(frames, tokens, phase) {
  let high = -1;
  const regressions = [];
  for (const frame of frames.filter(frame => frame.phase === phase)) {
    const present = tokens.map((token, index) => frame.visibleTokens.includes(token) ? index : -1).filter(index => index >= 0);
    let prefix = -1;
    while (present.includes(prefix + 1)) prefix++;
    if (high >= 0 && prefix < high) regressions.push({ frameIndex: frame.index, at: frame.at, id: frame.id, live: frame.live, kind: frame.kind, previousMaxPrefix: high, prefix, present });
    high = Math.max(high, prefix);
  }
  return regressions;
}

async function canonicalArtifact(project, frame, output, name) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name === 'manifest.json') {
        const manifest = JSON.parse(await readFile(target, 'utf8'));
        if (manifest.buildId === frame.id) found.push({ manifest, directory, manifestPath: target });
      }
    }
  }
  await visit(path.join(project, '.texypaper', 'build'));
  assert(found.length === 1, `Expected exactly one manifest for visible canonical build ${frame.id}.`);
  const artifact = found[0], pdfs = (await readdir(artifact.directory)).filter(name => name.endsWith('.pdf'));
  assert(pdfs.length === 1, 'Canonical build must have exactly one actual PDF.');
  const sourcePdf = path.join(artifact.directory, pdfs[0]), bytes = await readFile(sourcePdf);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert(bytes.subarray(0, 5).toString() === '%PDF-' && sha256 === artifact.manifest.pdfSha256, 'Canonical PDF bytes/hash do not match the immutable published manifest.');
  const pdfPath = path.join(output, name);
  await copyFile(sourcePdf, pdfPath);
  return { ...artifact, sourcePdf, pdfPath, sha256, byteLength: bytes.length, displayedPageCount: frame.pageCount, buildId: frame.id };
}

async function exercise(pages) {
  const name = pages === 1 ? 'local-short' : 'local-long';
  const output = path.join(run.output, name), project = path.join(run.fixtures, name);
  const row = { name, pages, host: 'local', output, project, samples: [], irregular: {}, complete: false };
  report.cases.push(row);
  await mkdir(output, { recursive: true });
  await mkdir(path.join(output, 'app-data'));
  await mkdir(path.join(project, '.texypaper'), { recursive: true });
  assert(typeof protocol.mainByPages?.[String(pages)] === 'string', `Missing main fixture for ${pages} pages.`);
  const files = { 'main.tex': protocol.mainByPages[String(pages)], 'body.tex': protocol.initialBody, 'refs.bib': protocol.bibliography, '.texypaper/project.json': JSON.stringify({ version: 1, rootTex: 'main.tex', engine: 'pdflatex', profile: 'basic', autoBuild: true }), '.texypaper-smoke-fixture': 'Owned isolated irregular-input fixture.\n' };
  for (const [relative, text] of Object.entries(files)) await writeFile(path.join(project, relative), text, { flag: 'wx' });
  let page;
  try {
    app = await launchDesktop({ binary, output, dataDir: path.join(output, 'app-data'), project });
    page = app.page;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor, mobile: false });
    row.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio }));
    assert(['width', 'height', 'deviceScaleFactor'].every(key => row.viewport[key] === viewport[key]), 'TexyPaper viewport/DPR differs from actual CorTeX.');
    await page.getByTestId('file-tree').waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: '분할', exact: true }).click();
    await page.getByRole('button', { name: '작업 패널 닫기', exact: true }).click();
    await quickOpen(page, 'body.tex');
    await page.getByRole('button', { name: '사이드 패널 접기', exact: true }).click();
    await installObserver(page);
    await page.getByRole('button', { name: '빌드', exact: true }).click();
    const initial = await waitCanonical(page, 'BASELINEMARKER');
    row.initialPageCount = initial.pageCount;
    assert(initial.pageCount === pages, 'Initial physical page count differs from the fixture.');
    for (let index = 0; index < protocol.warmRounds; index++) {
      const token = `LATENCYMARKER${String.fromCharCode(65 + index)}001`, text = `Latency probe ${token}.\n`;
      const previousId = await page.locator('.pdf-preview').getAttribute('data-build-id');
      await insert(page, { phase: 'warm', index, token, text, replace: true });
      const canonical = await waitCanonical(page, token, previousId);
      const evidence = await page.evaluate(() => window.__irregularNative.snapshot());
      const input = evidence.inputs.find(input => input.phase === 'warm' && input.index === index);
      assert(input?.isTrusted && input.data === text, 'Warm replacement must be actual matching trusted beforeinput.');
      const sample = firstVisible(input, evidence.frames);
      sample.canonicalDone = canonical.at;
      sample.edit_to_canonical_pdf_ms = canonical.at - input.started;
      sample.operations = evidence.resources.filter(resource => resource.start >= input.started && resource.start <= canonical.at);
      sample.nativeBuildIntervals = evidence.nativeBuildIntervals.filter(interval => interval.start >= input.started && interval.start <= canonical.at);
      const nativeBuild = sample.operations.find(resource => resource.command === 'build_start');
      const fileSave = sample.operations.find(resource => resource.command === 'file_save');
      sample.edit_to_save_ms = fileSave ? fileSave.end - input.started : null;
      sample.save_to_build_ms = nativeBuild && fileSave ? nativeBuild.start - fileSave.end : null;
      sample.build_ms = nativeBuild?.duration ?? null;
      sample.preview_ms = nativeBuild ? canonical.at - nativeBuild.end : null;
      row.samples.push(sample);
      assert(sample.done !== null && canonical.pageCount === pages && canonical.exportDisabled === false, 'Warm visible/canonical endpoint is incomplete.');
      assert(await readFile(path.join(project, 'body.tex'), 'utf8') === text, 'Warm source was not saved exactly.');
      await save();
    }
    row.median_ms = median(row.samples.map(sample => sample.edit_to_pdf_ms));
    row.max_ms = Math.max(...row.samples.map(sample => sample.edit_to_pdf_ms));
    const tokens = protocol.delaysMs.map((_, index) => `${protocol.burstTokenPrefix}${String(index).padStart(3, '0')}`);
    const expectedSource = `${protocol.burstPrefix} ${tokens.join(' ')}`;
    row.irregular.expectedSource = expectedSource;
    row.irregular.tokens = tokens;
    // Prepare selection before waiting; the specified delay precedes each actual insertion.
    await page.getByTestId('source-editor').locator('.cm-content').focus();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Control+Shift+End');
    for (let index = 0; index < tokens.length; index++) {
      await page.waitForTimeout(protocol.delaysMs[index]);
      await insert(page, { phase: 'irregular', index, token: tokens[index], text: index ? ` ${tokens[index]}` : `${protocol.burstPrefix} ${tokens[index]}`, requestedDelayMs: protocol.delaysMs[index] });
    }
    let canonical = await waitCanonical(page, tokens.at(-1));
    let evidence = await page.evaluate(() => window.__irregularNative.snapshot());
    row.irregular.inputs = evidence.inputs.filter(input => input.phase === 'irregular').map(input => firstVisible(input, evidence.frames));
    row.irregular.frames = evidence.frames.filter(frame => frame.phase === 'irregular');
    row.irregular.prefixRegressions = prefixRegressions(evidence.frames, tokens, 'irregular');
    row.irregular.inputsDuringNativeBuild = row.irregular.inputs.filter(input => input.status === 'building' || evidence.nativeBuildIntervals.some(interval => input.started >= interval.start && (interval.end === null || input.started < interval.end)));
    row.irregular.sourceReadback = await readFile(path.join(project, 'body.tex'), 'utf8');
    row.irregular.canonicalFrame = canonical;
    row.irregular.artifact = await canonicalArtifact(project, canonical, output, 'irregular-final.pdf');
    await page.screenshot({ path: path.join(output, 'irregular-final.png') });
    await save();
    assert(row.irregular.inputs.length === tokens.length && row.irregular.inputs.every((input, index) => input.token === tokens[index] && input.isTrusted && input.data === input.intendedData && input.done !== null), 'Some irregular input or first-visible token endpoint is missing.');
    assert(row.irregular.sourceReadback === expectedSource, 'Irregular disk source differs from the exact cumulative inputs.');
    assert(canonical.pageCount === pages && canonical.exportDisabled === false && tokens.every(token => canonical.visibleTokens.includes(token)), 'Final complete canonical canvas/pages/export/tokens were not restored.');

    if (!row.irregular.inputsDuringNativeBuild.length) {
      const probe = row.nativeBuildOverlapProbe = { label: 'event-driven-native-build-overlap', excludedFromTimingComparison: true, expectedSource: `${expectedSource} OVERLAP000 OVERLAP001` };
      await page.getByTestId('source-editor').locator('.cm-content').focus();
      await page.keyboard.press('Control+End');
      await insert(page, { phase: 'overlap-probe', index: 0, token: 'OVERLAP000', text: ' OVERLAP000' });
      await page.waitForFunction(() => document.querySelector('[data-testid="build-status"]')?.dataset.status === 'building', null, { timeout: 180000, polling: 'raf' });
      probe.buildObserved = await page.evaluate(() => ({ at: performance.now(), ...window.__irregularNative.snapshot().current }));
      await insert(page, { phase: 'overlap-probe', index: 1, token: 'OVERLAP001', text: ' OVERLAP001' });
      canonical = await waitCanonical(page, 'OVERLAP001');
      evidence = await page.evaluate(() => window.__irregularNative.snapshot());
      probe.inputs = evidence.inputs.filter(input => input.phase === 'overlap-probe').map(input => firstVisible(input, evidence.frames));
      probe.frames = evidence.frames.filter(frame => frame.phase === 'overlap-probe');
      probe.sourceReadback = await readFile(path.join(project, 'body.tex'), 'utf8');
      probe.canonicalFrame = canonical;
      probe.artifact = await canonicalArtifact(project, canonical, output, 'overlap-probe-final.pdf');
      probe.prefixRegressions = prefixRegressions(evidence.frames, [...tokens, 'OVERLAP000', 'OVERLAP001'], 'overlap-probe');
      await save();
      assert(probe.inputs.length === 2 && probe.inputs[1].status === 'building', 'Event-driven probe did not actually insert during native building.');
      assert(probe.inputs.every(input => input.isTrusted && input.data === input.intendedData && input.done !== null), 'Overlap probe inputs/visible endpoints are incomplete.');
      assert(probe.sourceReadback === probe.expectedSource && canonical.pageCount === pages && canonical.visibleTokens.includes('OVERLAP000') && canonical.visibleTokens.includes('OVERLAP001'), 'Overlap probe lost final source/PDF content.');
      // Restore the comparison fixture with real editor input, excluded from comparison timings.
      await insert(page, { phase: 'probe-restoration', index: 0, token: tokens.at(-1), text: expectedSource, replace: true });
      canonical = await waitCanonical(page, tokens.at(-1), canonical.id);
      probe.restoration = { expectedSource, sourceReadback: await readFile(path.join(project, 'body.tex'), 'utf8'), canonicalFrame: canonical };
      assert(probe.restoration.sourceReadback === expectedSource, 'Probe restoration did not save exact comparison source.');
    }
    row.finalSourceReadback = await readFile(path.join(project, 'body.tex'), 'utf8');
    row.finalCanonicalFrame = canonical;
    row.finalArtifact = await canonicalArtifact(project, canonical, output, 'final-canonical.pdf');
    assert(row.finalSourceReadback === expectedSource && canonical.pageCount === pages && canonical.exportDisabled === false && tokens.every(token => canonical.visibleTokens.includes(token)), 'Final source/full canonical page count/export/token verification failed.');
    row.complete = true;
    await page.screenshot({ path: path.join(output, 'final-split.png') });
  } catch (error) {
    row.error = error.stack ?? String(error);
    throw error;
  } finally {
    if (page) {
      try {
        row.observations = await page.evaluate(() => window.__irregularNative?.snapshot() ?? null);
        if (row.observations) {
          const observations = row.observations;
          row.irregular.frames = observations.frames.filter(frame => frame.phase === 'irregular');
          row.irregular.inputs = observations.inputs.filter(input => input.phase === 'irregular').map(input => firstVisible(input, observations.frames));
          row.irregular.prefixRegressions = prefixRegressions(observations.frames, row.irregular.tokens ?? [], 'irregular');
          row.irregular.nativeBuildIntervals = observations.nativeBuildIntervals;
          row.irregular.resources = observations.resources;
          row.irregular.inputsDuringNativeBuild = row.irregular.inputs.filter(input => input.status === 'building' || observations.nativeBuildIntervals.some(interval => input.started >= interval.start && (interval.end === null || input.started < interval.end)));
          const latencies = row.irregular.inputs.map(input => input.edit_to_pdf_ms).filter(Number.isFinite);
          row.irregular.median_ms = latencies.length ? median(latencies) : null;
          row.irregular.max_ms = latencies.length ? Math.max(...latencies) : null;
        }
        row.lastSourceReadback = await readFile(path.join(project, 'body.tex'), 'utf8');
        await page.screenshot({ path: path.join(output, 'last-state.png') });
      } catch (captureError) { row.captureError = captureError.stack ?? String(captureError); }
    }
    await save();
    if (app) { const owned = app; app = null; await owned.close(); }
  }
}

try {
  for (const pages of protocol.documents) await exercise(pages);
  report.complete = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  await save();
  if (app) await app.close();
}
console.log(JSON.stringify({ variant: report.variant, complete: report.complete, cases: report.cases.map(({ name, median_ms, max_ms, irregular, nativeBuildOverlapProbe }) => ({ name, median_ms, max_ms, irregularMedianMs: median((irregular.inputs ?? []).map(input => input.edit_to_pdf_ms).filter(Number.isFinite)), irregularMaxMs: Math.max(...(irregular.inputs ?? []).map(input => input.edit_to_pdf_ms).filter(Number.isFinite)), prefixRegressions: irregular.prefixRegressions?.length, inputsDuringNativeBuild: irregular.inputsDuringNativeBuild?.length, overlapProbe: !!nativeBuildOverlapProbe })) }, null, 2));
