// Inject `(${browserProbe.toString()})()` with Page.addScriptToEvaluateOnNewDocument.
export function browserProbe() {
  if (window.__cortexIrregular) throw new Error('Cortex irregular probe already installed');
  const probe = window.__cortexIrregular = {
    version: 1, phase: null, armed: null, inputs: [], events: [], viewers: [],
    compilations: [], frameResponses: [], frames: [], commits: [], busyCompilations: 0,
  };
  const workers = new WeakMap(), blobs = new Map(), committed = new WeakMap();
  // The public preview runtime assigns WeakMap keys before converting the same
  // buffer span into a Blob. Observe that binding; renderer RPC identity is null.
  const byteIdentities = new WeakMap(), blobIdentities = new WeakMap();
  const weakSet = WeakMap.prototype.set, NativeBlob = Blob;
  WeakMap.prototype.set = function (key, value) {
    const result = weakSet.call(this, key, value);
    if (typeof value === 'string' && /^preview:\d+$/.test(value) && ArrayBuffer.isView(key)) {
      let spans = byteIdentities.get(key.buffer);
      if (!spans) { spans = new Map(); weakSet.call(byteIdentities, key.buffer, spans); }
      spans.set(`${key.byteOffset}:${key.byteLength}`, value);
    }
    return result;
  };
  globalThis.Blob = class extends NativeBlob {
    constructor(parts, options) {
      super(parts, options);
      if (Array.isArray(parts) && parts.length === 1 && ArrayBuffer.isView(parts[0])) {
        const part = parts[0];
        const identity = byteIdentities.get(part.buffer)?.get(`${part.byteOffset}:${part.byteLength}`);
        if (identity) weakSet.call(blobIdentities, this, identity);
      }
    }
  };
  let nextWorker = 1, revision = 0, latestPDF = null;
  const pageSelector = '[aria-label^="PDF 미리보기:"] [data-pdf-page="1"]';
  const isPDF = value => {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
      : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
    return bytes?.length >= 5 && bytes[0] === 37 && bytes[1] === 80 && bytes[2] === 68 && bytes[3] === 70 && bytes[4] === 45;
  };
  const stamp = () => ({ at: performance.now(), phase: probe.phase, revision });
  const visible = element => {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
      && rect.right > 0 && rect.left < innerWidth && style.visibility === 'visible' && style.display !== 'none'
      && document.visibilityState === 'visible';
  };
  const editor = () => {
    const editors = [...document.querySelectorAll('.cm-content[contenteditable="true"]')].filter(visible);
    if (editors.length !== 1) throw new Error(`Expected one visible source editor, found ${editors.length}`);
    return editors[0];
  };
  const editorModel = () => {
    const content = editor(), cm = content.cmTile ?? content.cmView;
    const view = cm?.view ?? cm?.root?.view ?? cm?.rootView?.view;
    if (!view?.state?.doc || view.contentDOM !== content) throw new Error('Source model is not hydrated');
    return { content, view };
  };
  probe.source = () => {
    const { content, view } = editorModel();
    const lines = [...content.querySelectorAll('.cm-line')];
    return {
      source: view.state.doc.toString(),
      method: 'CodeMirror-state.doc',
      ariaLabel: content.getAttribute('aria-label'), readOnly: view.state.readOnly, renderedLines: lines.length,
      editorSelector: content.getAttribute('aria-label')
        ? `.cm-content[contenteditable="true"][aria-label=${JSON.stringify(content.getAttribute('aria-label'))}]`
        : '.cm-content[contenteditable="true"]',
    };
  };
  probe.replaceFixture = (file, text) => {
    const { content, view } = editorModel();
    if (!content.getAttribute('aria-label')?.endsWith(file) || view.state.readOnly) throw new Error(`Editable fixture unavailable: ${JSON.stringify({ file, actual: content.getAttribute('aria-label'), readOnly: view.state.readOnly })}`);
    const changed = view.state.doc.toString() !== text, started = changed ? performance.now() : 0;
    if (changed) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 }, userEvent: 'input.paste' });
    const readback = probe.source().source;
    if (readback !== text) throw new Error('Fixture model readback differs');
    return { started, sourceReadback: readback, expectedSource: text, sourceMatches: true,
      method: 'fixture-model-transaction; excluded from input latency' };
  };
  probe.arm = mutation => {
    if (probe.armed) throw new Error('Previous mutation did not emit beforeinput');
    probe.armed = { ...mutation, phase: probe.phase, armedAt: performance.now(), beforeinputs: [] };
    probe.inputs.push(probe.armed);
  };
  document.addEventListener('beforeinput', event => {
    if (!(event.target instanceof Element) || !event.target.closest('.cm-content')) return;
    const at = performance.now(), mutation = probe.armed;
    const evidence = { at, inputType: event.inputType, data: event.data, isTrusted: event.isTrusted,
      ariaLabel: event.target.closest('.cm-content').getAttribute('aria-label') };
    probe.events.push({ ...evidence, direction: 'beforeinput', phase: probe.phase });
    if (!mutation) return;
    mutation.beforeinputs.push(evidence);
    mutation.started ??= at;
    mutation.revision = ++revision;
    const previous = probe.inputs.filter(input => input !== mutation && input.phase === mutation.phase && input.started != null).at(-1);
    mutation.actualGapMs = previous ? at - previous.started : null;
    mutation.actualDelayMs = at - mutation.armedAt;
    probe.armed = null;
  }, true);
  probe.readback = () => {
    const input = probe.inputs.at(-1), readback = probe.source();
    if (!input) throw new Error('No mutation to read back');
    input.sourceReadback = readback.source;
    input.sourceReadbackAt = performance.now();
    input.sourceReadbackMethod = readback.method;
    input.sourceMatches = input.expectedSource === readback.source;
    return { ...input };
  };
  const identityMatches = (identity, viewer) => typeof viewer.identity === 'string'
    && (identity === viewer.identity || identity === `${viewer.identity}:0`);
  const checkCommits = () => {
    for (const wrapper of document.querySelectorAll(pageSelector)) {
      const canvas = wrapper.querySelector('canvas[data-pdf-page-surface]');
      if (!canvas?.width || !canvas.height || !visible(canvas)) continue;
      const identity = wrapper.dataset.pdfPageIdentity, generation = wrapper.dataset.pdfGeneration;
      if (!identity || generation == null) continue;
      const previous = committed.get(wrapper), key = `${identity}\n${generation}`;
      if (previous?.key === key && previous.canvas === canvas) continue;
      const at = performance.now();
      // A completed DOM page identity binds the exact observed PDF Blob. A
      // fingerprint-cache hit can reuse a canvas without another frame RPC.
      const viewer = probe.viewers.findLast(item => !item.background && item.openOK
        && item.openedAt <= at && identityMatches(identity, item));
      const candidate = viewer && probe.frameResponses.findLast(response =>
        response.viewerId === viewer.id && response.index === 0 && response.ok && response.at <= at);
      const rect = canvas.getBoundingClientRect();
      const clip = canvas.closest('[aria-label^="PDF 미리보기:"]').getBoundingClientRect();
      const commit = { ...stamp(), identity, generation, previousIdentity: previous?.identity ?? null,
        previousGeneration: previous?.generation ?? null, width: canvas.width, height: canvas.height,
        method: 'completed-page-render-animation-frame', matched: !!viewer,
        rect: {x:rect.x,y:rect.y,width:rect.width,height:rect.height},
        clip: {left:Math.max(0,clip.left),top:Math.max(0,clip.top),right:Math.min(innerWidth,clip.right),bottom:Math.min(innerHeight,clip.bottom)} };
      if (!viewer) {
        if (!probe.commits.some(item => !item.matched && item.identity === identity && item.generation === generation)) probe.commits.push(commit);
        continue;
      }
      const frame = { ...commit, id: probe.frames.length + 1, done: at, viewerId: viewer.id,
        worker: viewer.worker, frameRequestAt: candidate?.requestAt ?? null, frameAt: candidate?.at ?? null,
        openAt: viewer.at, compileSequence: viewer.compileSequence,
        compileStart: viewer.compileStart, pdfAt: viewer.pdfAt, background: viewer.background };
      probe.frames.push(frame);
      probe.commits.push({ ...commit, matched: true, frameId: frame.id });
      committed.set(wrapper, { key, identity, generation, canvas });
    }
  };
  const observeFrame = () => {
    checkCommits();
    requestAnimationFrame(observeFrame);
  };
  requestAnimationFrame(observeFrame);
  const NativeWorker = Worker, originalPost = NativeWorker.prototype.postMessage;
  const attach = worker => {
    let state = workers.get(worker);
    if (state) return state;
    state = { id: nextWorker++, requests: new Map(), compileRequests: [], viewerId: null };
    workers.set(worker, state);
    worker.addEventListener('message', event => {
      const at = performance.now(), data = event.data;
      const keys = data && typeof data === 'object' ? Object.keys(data) : [];
      let request = state.requests.get(data?.id);
      // Cortex's compiler replies use cmd=\"compile\" without echoing the request
      // id (including compilepagepreview). Correlate terminal replies FIFO within
      // that worker, independently of renderer RPC ids.
      const terminalCompile = data?.cmd === 'compile'
        && (keys.includes('result') || keys.includes('pdf') || keys.includes('heapCheckpoints') || keys.includes('status') || !!data.error);
      if (terminalCompile) {
        if (!request?.compile) request = state.compileRequests[0];
        const index = state.compileRequests.indexOf(request);
        if (index >= 0) state.compileRequests.splice(index, 1);
      }
      if (data?.id != null) state.requests.delete(data.id);
      if (terminalCompile && request?.id != null) state.requests.delete(request.id);
      probe.events.push({ ...stamp(), at, direction: 'in', worker: state.id,
        id: data?.id, cmd: data?.cmd, type: request?.type, keys, requestAt: request?.at,
        viewerId: request?.viewerId, error: data?.error ? String(data.error) : null });
      if (terminalCompile && request?.compile) probe.busyCompilations--;
      if (isPDF(data?.pdf) || (data?.cmd === 'compile' && keys.includes('heapCheckpoints'))) {
        const compilation = { ...stamp(), at, sequence: probe.compilations.length + 1,
          worker: state.id, id: data?.id, cmd: data?.cmd, requestAt: request?.at ?? null,
          requestRevision: request?.revision ?? null, hasPDF: isPDF(data?.pdf),
          full: keys.includes('heapCheckpoints'), error: data?.error ? String(data.error) : null,
          status: data?.status ?? null, keys };
        probe.compilations.push(compilation);
        if (compilation.hasPDF) latestPDF = compilation;
      }
      if (request?.type === 'open' && request.viewerId) {
        const viewer = probe.viewers[request.viewerId - 1];
        viewer.openedAt = at;
        viewer.openOK = Object.prototype.hasOwnProperty.call(data ?? {}, 'result') && !data.error;
      }
      if (request?.type === 'frame' && request.viewerId) {
        probe.frameResponses.push({ ...stamp(), at, worker: state.id, id: data?.id,
          requestAt: request.at, viewerId: request.viewerId, index: request.index,
          ok: Object.prototype.hasOwnProperty.call(data ?? {}, 'result') && !data.error });
      }
    }, { capture: true });
    return state;
  };
  globalThis.Worker = class extends NativeWorker {
    constructor(...args) { super(...args); attach(this); }
  };
  NativeWorker.prototype.postMessage = function (message, ...rest) {
    const state = attach(this), at = performance.now(), type = message?.type, cmd = message?.cmd;
    if (type === 'open' && message.blob instanceof Blob) {
      const id = probe.viewers.length + 1;
      const viewer = { ...stamp(), at, id, worker: state.id, requestId: message.id,
        identity: typeof message.identity === 'string' ? message.identity : blobIdentities.get(message.blob) ?? null,
        rawIdentity: message.identity ?? null, background: message.background === true,
        size: message.blob.size, mime: message.blob.type,
        compileSequence: latestPDF?.sequence ?? null, compileStart: latestPDF?.requestAt ?? null,
        pdfAt: latestPDF?.at ?? null, full: latestPDF?.full ?? false };
      probe.viewers.push(viewer);
      blobs.set(id, message.blob);
      state.viewerId = id;
    }
    const compile = typeof cmd === 'string' && cmd.startsWith('compile');
    const request = { at, id: message?.id, type, cmd, compile, revision,
      index: message?.index, viewerId: state.viewerId };
    if (message?.id != null) state.requests.set(message.id, request);
    if (compile) {
      state.compileRequests.push(request);
      probe.busyCompilations++;
    }
    probe.events.push({ ...stamp(), at, direction: 'out', worker: state.id,
      id: message?.id, type, cmd, viewerId: state.viewerId,
      keys: message && typeof message === 'object' ? Object.keys(message) : [] });
    return originalPost.call(this, message, ...rest);
  };
  probe.fullReady = after => {
    const full = probe.compilations.findLast(item => item.full && item.hasPDF && !item.error && item.requestAt >= after);
    if (!full || probe.busyCompilations) return null;
    const viewer = probe.viewers.findLast(item => !item.background && item.openOK
      && item.compileSequence === full.sequence && item.at >= full.at);
    return viewer ? { compilation: full, viewer, readyAt: Math.max(full.at, viewer.openedAt) } : null;
  };
  probe.encodeViewer = async id => {
    const blob = blobs.get(id);
    if (!blob) throw new Error(`Missing viewer Blob ${id}`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(binary);
  };
  probe.snapshot = () => ({ version: probe.version, timeOrigin: performance.timeOrigin,
    at: performance.now(), inputs: probe.inputs, events: probe.events, viewers: probe.viewers,
    compilations: probe.compilations, frameResponses: probe.frameResponses,
    frames: probe.frames, commits: probe.commits, busyCompilations: probe.busyCompilations });
}

export async function runCortex({ page, output, protocol, mainSelector, bodySelector }) {
  const fs = await import('node:fs/promises'), path = await import('node:path');
  if (!path.isAbsolute(output)) throw new Error('output must be an absolute path');
  if (!mainSelector || !bodySelector) throw new Error('Pass selectors for the observed main and body file/tab controls');
  if (protocol.warmRounds !== 7 || protocol.delaysMs?.length !== 24) throw new Error('Expected the agreed seven-warm/24-input protocol');
  await fs.mkdir(output, { recursive: true });
  const result = { variant: 'cortex', viewport: null, complete: false,
    validation: 'pending-offline-pdftotext', protocol, cases: [], viewerPdfs: [] };
  const savedViewers = new Set();
  const persist = () => fs.writeFile(path.join(output, 'latency-results.json'), JSON.stringify(result, null, 2));
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  let activeCase = null;
  async function evidence() {
    const snapshot = await page.evaluate(() => window.__cortexIrregular.snapshot());
    // Snapshot timestamps first; no Blob reads, base64 encoding, file I/O, or PDF
    // parsing occurs inside the burst or before its display endpoints are recorded.
    result.probe = snapshot;
    result.viewerPdfs = snapshot.viewers.map(viewer => ({ ...viewer,
      pdf: `viewer-${String(viewer.id).padStart(5, '0')}.pdf` }));
    for (const item of result.cases) {
      const prefix = `${item.name}:`;
      item.inputs = snapshot.inputs.filter(input => input.phase?.startsWith(prefix));
      if (item.irregular) {
        const phase = `${item.name}:irregular`;
        item.irregular.inputs = snapshot.inputs.filter(input => input.phase === phase);
        item.irregular.frames = snapshot.frames.filter(frame => frame.phase === phase).map(frame => ({ ...frame,
          pdf: `viewer-${String(frame.viewerId).padStart(5, '0')}.pdf` }));
        item.irregular.commits = snapshot.commits.filter(commit => commit.phase === phase);
      }
      for (const sample of item.samples) {
        const input = snapshot.inputs.find(input => input.phase === sample.phase);
        if (input) Object.assign(sample, input);
        sample.frames = snapshot.frames.filter(frame => frame.phase === sample.phase).map(frame => ({ ...frame,
          pdf: `viewer-${String(frame.viewerId).padStart(5, '0')}.pdf` }));
      }
    }
    await persist();
    for (const viewer of result.viewerPdfs) {
      if (savedViewers.has(viewer.id)) continue;
      const base64 = await page.evaluate(id => window.__cortexIrregular.encodeViewer(id), viewer.id);
      await fs.writeFile(path.join(output, viewer.pdf), Buffer.from(base64, 'base64'));
      savedViewers.add(viewer.id);
    }
  }
  async function assertViewport() {
    const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
      deviceScaleFactor: devicePixelRatio, visibility: document.visibilityState }));
    if (actual.width !== result.viewport.width || actual.height !== result.viewport.height
      || actual.deviceScaleFactor !== result.viewport.deviceScaleFactor || actual.visibility !== 'visible') {
      throw new Error(`Viewport/visibility changed: ${JSON.stringify(actual)}`);
    }
  }
  async function selectFile(selector) {
    const observedTitle = await page.evaluate(selector => {
      try {
        const css = selector.replace(/^(?:loc=css:|css=)/, '');
        return document.querySelector(css)?.getAttribute('title') || null;
      } catch { return null; }
    }, selector);
    await page.click(selector);
    await page.waitForFunction(title => {
      try {
        const source = window.__cortexIrregular.source();
        return !!source.editorSelector && !source.readOnly && (!title || source.ariaLabel?.endsWith(title));
      } catch { return false; }
    }, observedTitle, { timeout: 10000 });
    return page.evaluate(() => window.__cortexIrregular.source());
  }
  async function mutate({ phase, text, expectedSource, token, index, replace = false, delayMs = 0 }) {
    await assertViewport();
    if (replace) {
      const source = await page.evaluate(() => window.__cortexIrregular.source());
      await page.focus(source.editorSelector);
      await page.keyboard.press('Control+Home');
      await page.keyboard.press('Control+Shift+End');
    }
    await page.evaluate(mutation => {
      const probe = window.__cortexIrregular;
      probe.phase = mutation.phase;
      probe.arm(mutation);
    }, { phase, expectedSource, token, index, replace, delayMs });
    if (delayMs) await page.waitForTimeout(delayMs);
    await page.keyboard.insertText(text);
    const input = await page.evaluate(() => window.__cortexIrregular.readback());
    if (input.started == null || input.beforeinputs.length !== 1) throw new Error('Mutation needs exactly one actual beforeinput timestamp');
    if (!input.beforeinputs[0].isTrusted) throw new Error('Input was not trusted browser input');
    if (!input.sourceMatches) throw new Error(`Exact source mismatch after ${phase}/${index}`);
    return input;
  }
  async function settled(started) {
    await page.waitForFunction(after => !!window.__cortexIrregular.fullReady(after), started, { timeout: 90000 });
    return page.evaluate(after => window.__cortexIrregular.fullReady(after), started);
  }
  async function visibleFrame(input) {
    await page.waitForFunction(({ started, revision }) => {
      const probe = window.__cortexIrregular;
      return probe.frames.some(frame => frame.done >= started && frame.compileStart >= started
        && probe.compilations[frame.compileSequence - 1]?.requestRevision >= revision);
    }, input, { timeout: 90000 });
    return page.evaluate(({ started, revision }) => {
      const probe = window.__cortexIrregular;
      return probe.frames.find(frame => frame.done >= started && frame.compileStart >= started
        && probe.compilations[frame.compileSequence - 1]?.requestRevision >= revision);
    }, input);
  }
  async function savePDF(viewerId, filename) {
    const base64 = await page.evaluate(id => window.__cortexIrregular.encodeViewer(id), viewerId);
    await fs.writeFile(path.join(output, filename), Buffer.from(base64, 'base64'));
  }
  try {
    if (!await page.evaluate(() => !!window.__cortexIrregular)) throw new Error('Inject browserProbe before application scripts and reload first');
    result.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
      deviceScaleFactor: devicePixelRatio, visibility: document.visibilityState, userAgent: navigator.userAgent }));
    await assertViewport();
    await persist();
    const initial = await selectFile(bodySelector);
    result.initialSource = initial;
    if (initial.source !== protocol.initialBody) throw new Error('Prepared body differs from protocol.initialBody');
    for (const pages of protocol.documents) {
      if (![1, 30].includes(pages)) throw new Error(`Unsupported physical page case ${pages}`);
      const name = pages === 1 ? 'short' : 'long';
      activeCase = { name, pages, samples: [], median_ms: null, max_ms: null };
      result.cases.push(activeCase);
      if (pages === 30) {
        await selectFile(mainSelector);
        // Fixture construction is not a timed keystroke. Use the actual editable
        // CodeMirror model, like the native fixture's prewritten main.tex file.
        const setup = await page.evaluate(text => {
          const probe = window.__cortexIrregular;
          probe.phase = 'long:setup';
          return probe.replaceFixture('main.tex', text);
        }, protocol.mainByPages['30']);
        if (!setup.sourceMatches) throw new Error('Root fixture transaction differs from protocol');
        activeCase.setup = { ...setup, full: await settled(setup.started) };
        await selectFile(bodySelector);
      }
      // Establish a settled, identical baseline before either timed seven-edit set.
      const beforeBaseline = await page.evaluate(() => window.__cortexIrregular.source());
      if (beforeBaseline.source !== protocol.initialBody) {
        const baseline = await mutate({ phase: `${name}:baseline`, text: protocol.initialBody,
          expectedSource: protocol.initialBody, token: 'BASELINEMARKER', index: 0, replace: true });
        activeCase.baseline = { ...baseline, full: await settled(baseline.started) };
      } else {
        activeCase.baseline = { sourceReadback: beforeBaseline.source, sourceMatches: true,
          full: await settled(0) };
      }
      for (let index = 0; index < protocol.warmRounds; index++) {
        const token = `LATENCYMARKER${String.fromCharCode(65 + index)}001`, phase = `${name}:warm:${index}`;
        const sample = { index, token, phase };
        activeCase.samples.push(sample);
        const input = await mutate({ phase, text: `Latency probe ${token}.\n`,
          expectedSource: `Latency probe ${token}.\n`, token, index, replace: true });
        Object.assign(sample, input);
        const frame = await visibleFrame(input);
        Object.assign(sample, { done: frame.done, edit_to_pdf_ms: frame.done - input.started,
          compileStart: frame.compileStart, pdfAt: frame.pdfAt, openAt: frame.openAt, frameAt: frame.frameAt,
          draw: frame, pdfOrigin: 'visible-worker-Blob', pdf: `${name}-warm-${index}.pdf`,
          full_pdf: `${name}-warm-${index}-full.pdf` });
        await savePDF(frame.viewerId, sample.pdf);
        const full = await settled(input.started);
        Object.assign(sample, { fullReadyAt: full.readyAt, full_pdf_ready_ms: full.readyAt - input.started,
          fullCompilation: full.compilation, fullViewer: full.viewer });
        await savePDF(full.viewer.id, sample.full_pdf);
        await evidence();
      }
      const latencies = activeCase.samples.map(sample => sample.edit_to_pdf_ms);
      activeCase.median_ms = median(latencies);
      activeCase.max_ms = Math.max(...latencies);
      activeCase.irregular = { inputs: [], frames: [], expectedSource: '', sourceReadback: null,
        firstVisibility: null, regressions: null, validation: 'pending-offline-pdftotext' };
      let expectedSource = '';
      for (let index = 0; index < protocol.delaysMs.length; index++) {
        const token = `${protocol.burstTokenPrefix}${String(index).padStart(3, '0')}`;
        const text = index === 0 ? `${protocol.burstPrefix} ${token}` : ` ${token}`;
        expectedSource = index === 0 ? text : expectedSource + text;
        activeCase.irregular.expectedSource = expectedSource;
        const input = await mutate({ phase: `${name}:irregular`, text, expectedSource, token,
          index, replace: index === 0, delayMs: protocol.delaysMs[index] });
        activeCase.irregular.inputs.push(input);
        // Do not wait for compilation or rendering between irregular inputs.
      }
      const lastInput = activeCase.irregular.inputs.at(-1);
      const full = await settled(lastInput.started);
      await visibleFrame(lastInput);
      const finalSource = await page.evaluate(() => window.__cortexIrregular.source());
      Object.assign(activeCase.irregular, { sourceReadback: finalSource.source,
        sourceReadbackMethod: finalSource.method, sourceMatches: finalSource.source === expectedSource,
        full_pdf: `${name}-irregular-full.pdf`, fullReadyAt: full.readyAt,
        fullCompilation: full.compilation, fullViewer: full.viewer });
      if (!activeCase.irregular.sourceMatches) throw new Error('Final cumulative source mismatch');
      await savePDF(full.viewer.id, activeCase.irregular.full_pdf);
      await evidence();
      await page.screenshot({ path: path.join(output, `${name}-actual-split.png`) });
    }
    result.complete = true;
    await evidence();
    await persist();
    return result;
  } catch (error) {
    result.complete = false;
    result.error = { message: String(error?.message ?? error), stack: error?.stack ?? null };
    try { await evidence(); } catch (captureError) { result.captureError = String(captureError); }
    try { await page.screenshot({ path: path.join(output, 'error.png') }); }
    catch (screenshotError) { result.screenshotError = String(screenshotError); }
    await persist();
    throw error;
  }
}
