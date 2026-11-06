import { readFile, writeFile, readdir, stat, access, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSmokeFixtures } from './create-smoke-fixtures.mjs';
import { assert, parseArgs, requireBinary, createRun, launchDesktop, waitFor, writeJson, runExternal, ownedProcesses, saveNativePdfDialog } from './smoke-support.mjs';
import { selectMainDocument } from './smoke-ssh.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export async function openWorkspace(page, root) {
  const expectedRoot = await realpath(root);
  if (!(await page.getByTestId('workspace-disclose').isVisible())) await page.getByTestId('workspace-switch').click();
  if (!(await page.getByTestId('workspace-path').isVisible())) await page.getByTestId('workspace-disclose').click();
  await page.getByTestId('workspace-path').fill(root);
  await page.getByTestId('workspace-open').click();
  await waitFor(async () => {
    const identity = page.getByTestId('workspace-identity');
    const actual = await identity.getAttribute('data-root');
    return actual && await realpath(actual).catch(() => null) === expectedRoot && !await page.getByTestId('workspace-path').isVisible();
  }, { label: 'new canonical workspace identity acknowledged' });
  if (!await page.getByTestId('file-tree').isVisible()) await page.getByRole('button', { name: /탐색기 표시|Show explorer/, exact: true }).click();
  await page.getByTestId('file-tree').waitFor({ state: 'visible', timeout: 30000 });
}
export async function verifyPickerDisclosure(page) {
  const disclose = page.getByTestId('workspace-disclose'), input = page.getByTestId('workspace-path'), addSsh = page.getByTestId('ssh-add');
  assert(await disclose.getAttribute('aria-expanded') === 'false' && !await input.isVisible(), 'Project inputs should wait for an explicit opening action.');
  assert(await addSsh.getAttribute('aria-expanded') === 'false' && !await page.getByTestId('ssh-alias').isVisible(), 'SSH setup should not be expanded on entry.');
  await disclose.focus(); await page.keyboard.press('Enter');
  await input.waitFor({ state: 'visible' });
  assert(await input.evaluate(element => element === document.activeElement), 'Keyboard disclosure did not focus the project path.');
  await input.fill('');
  await input.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })));
  assert(!await page.locator('.workspace-picker [role="alert"]').count(), 'Committing an IME composition must not validate or open an incomplete project path.');
  await page.keyboard.press('Enter');
  const errors = page.locator('.workspace-picker [role="alert"]');
  await errors.waitFor({ state: 'visible' });
  await addSsh.click();
  await page.getByTestId('ssh-alias').waitFor({ state: 'visible' });
  assert(await page.getByTestId('ssh-alias').evaluate(element => element === document.activeElement), 'SSH disclosure did not focus its alias field.');
  assert(await errors.isVisible(), 'Switching disclosure hid a project-opening error.');
  await page.locator('.ssh-form .button-row button[type=button]').click();
  assert(await addSsh.evaluate(element => element === document.activeElement), 'Closing SSH setup did not restore its action focus.');
  assert(await errors.isVisible(), 'Closing disclosure hid an unresolved error.');
  await disclose.focus(); await page.keyboard.press('Space');
  await input.waitFor({ state: 'visible' });
  await page.locator('.picker-form:not([hidden]) .dialog-heading>button').click();
  assert(await disclose.evaluate(element => element === document.activeElement), 'Closing the project form did not restore its action focus.');
  return { initiallyCollapsed: true, keyboardDisclosure: true, focusRestored: true, errorsRemainVisible: true };
}
async function revealTreeRow(page, relative) {
  const tree = page.getByTestId('file-tree');
  // Files remain independent of right-hand chat on wide layouts; compact overlays may hide the tree.
  if (!await tree.isVisible()) await page.locator('.activity-rail').getByRole('button', { name: /^(탐색기 표시|Show explorer)$/ }).click();
  await tree.waitFor({ state: 'visible' });
  const row = page.locator(`[id="tree-${encodeURIComponent(relative)}"]`);
  await tree.evaluate(element => { element.scrollTop = 0; });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await row.count()) { await row.scrollIntoViewIfNeeded(); return row; }
    const end = await tree.evaluate(element => { element.scrollTop += Math.max(100, element.clientHeight - 30); return element.scrollTop + element.clientHeight >= element.scrollHeight; });
    await delay(30);
    if (end && !(await row.count())) await tree.evaluate(element => { element.scrollTop = 0; });
  }
  throw new Error(`Explorer row not found in the actual virtualized tree: ${relative}`);
}
export async function quickOpen(page, relative) {
  const components = relative.split('/');
  for (let index = 1; index < components.length; index++) {
    const row = await revealTreeRow(page, components.slice(0, index).join('/'));
    if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
  }
  await page.keyboard.press('Control+p');
  const dialog = page.locator('.quick-open');
  await dialog.locator('input').fill(relative);
  await dialog.locator('.quick-results button').filter({ hasText: relative }).first().click();
  await waitFor(async () => {
    const editor = page.getByTestId('source-editor');
    return await editor.getAttribute('data-path') === relative && await editor.getAttribute('aria-busy') === 'false' && await editor.locator('.cm-content').isVisible();
  }, { label: `requested editor document ${relative} finished loading` });
}
async function latestManifest(root) {
  const manifests = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name === 'manifest.json') {
        const value = JSON.parse(await readFile(target, 'utf8'));
        if (value.buildId && value.pdfSha256) manifests.push({ ...value, directory });
      }
    }
  }
  try { await visit(path.join(root, '.texypaper', 'build')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  manifests.sort((left, right) => String(right.finishedAt).localeCompare(String(left.finishedAt)));
  return manifests[0];
}
export async function buildPaper(page, root, previousId) {
  const status = page.getByTestId('build-status'), previousSequence = await status.getAttribute('data-sequence');
  await page.getByRole('button', { name: '빌드', exact: true }).click();
  await waitFor(async () => (await status.getAttribute('data-sequence')) !== previousSequence && ['published','failed','cancelled','timeout'].includes(await status.getAttribute('data-status')), { timeoutMs: 150000, label: 'fresh actual terminal build completion sequence' });
  const state = await status.getAttribute('data-status');
  assert(state === 'published' || state === 'success', `Real build did not publish a current generation (${state}): ${await status.innerText()}`);
  const manifest = await waitFor(async () => {
    const value = await latestManifest(root);
    return value && value.buildId === await status.getAttribute('data-build-id') && (!previousId || value.buildId !== previousId) && value;
  }, { timeoutMs: 150000, label: 'real successful immutable build manifest' });
  const pdfs = (await readdir(manifest.directory)).filter(name => name.endsWith('.pdf'));
  assert(pdfs.length === 1, 'A published generation must contain exactly one PDF.');
  const pdf = await readFile(path.join(manifest.directory, pdfs[0]));
  assert(pdf.subarray(0, 5).toString() === '%PDF-', 'Published artifact is not an actual PDF.');
  assert(digest(pdf) === manifest.pdfSha256, 'Published PDF hash disagrees with its manifest.');
  const synctex = (await readdir(manifest.directory)).filter(name => /\.synctex(?:\.gz)?$/.test(name));
  assert(synctex.length === 1, 'A generation must carry exactly one matching SyncTeX file.');
  assert(digest(await readFile(path.join(manifest.directory, synctex[0]))) === manifest.syncSha256, 'SyncTeX hash disagrees with the manifest.');
  return manifest;
}
export async function showPdf(page) {
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  // The previous document stays on screen until its replacement loads; act only on the published build's
  // document (reference PDFs excepted) once its text layer is ready for selection mapping.
  await waitFor(async () => {
    const preview = page.locator('.pdf-preview'), displayed = await preview.getAttribute('data-build-id');
    const current = await page.getByTestId('build-status').getAttribute('data-build-id');
    return Boolean(displayed) && (await preview.getAttribute('data-reference') === 'true' || !current || displayed === current);
  }, { timeoutMs: 30000, label: 'displayed PDF matches the published build' });
  await page.locator('.textLayer[data-ready="true"] span').first().waitFor({ state: 'visible', timeout: 30000 });
}
export async function selectPdfText(page, quote) {
  // Freeze a range in the real rendered text layer, including selections across PDF text items.
  const selected = await waitFor(() => page.locator('.textLayer[data-ready="true"]').evaluateAll((layers, text) => {
    for (const layer of layers) {
      // PDF.js represents visual line ends as <br>; real selections across them are normalized to one space.
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: candidate => candidate.nodeType === Node.TEXT_NODE || candidate.nodeName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP }), nodes = [];
      let node, combined = '';
      while ((node = walker.nextNode())) {
        if (node.nodeName === 'BR') { if (!combined.endsWith(' ')) combined += ' '; continue; }
        nodes.push({ node, offset: combined.length }); combined += node.textContent;
      }
      const offset = combined.indexOf(text);
      if (offset < 0) continue;
      const first = nodes.find(item => item.offset + item.node.textContent.length > offset);
      const last = nodes.find(item => item.offset + item.node.textContent.length >= offset + text.length);
      if (!first || !last) continue;
      const range = document.createRange(); range.setStart(first.node, offset - first.offset); range.setEnd(last.node, offset + text.length - last.offset);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      const rects = range.getClientRects(), box = rects[rects.length - 1] ?? range.getBoundingClientRect();
      return { x: box.right - 1, y: box.top + box.height / 2, selected: selection.toString().replace(/\s+/g, ' ') };
    }
    return null;
  }, quote), { timeoutMs: 30000, label: `requested PDF text layer rendered: ${quote}` });
  assert(selected?.selected === quote, `Rendered PDF text not found: ${quote}`);
  await page.locator('.pdf-scroll').dispatchEvent('pointerup', { button: 0, clientX: selected.x, clientY: selected.y });
  return selected;
}
async function replaceSource(page, relative, text, root) {
  await page.getByRole('button', { name: '소스', exact: true }).click();
  await quickOpen(page, relative);
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+a'); await page.keyboard.insertText(text); await page.keyboard.press('Control+s');
  await waitFor(async () => (await readFile(path.join(root, relative), 'utf8')) === text, { label: `real source save ${relative}` });
}
async function settings(page, action) {
  await page.getByTestId('settings-button').click();
  await action();
  await page.keyboard.press('Escape');
}
async function screenshot(page, output, name) { await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true }); }
async function keyboardTree(page) {
  const tree = page.getByTestId('file-tree'); await tree.focus(); await page.keyboard.press('Home');
  const first = await tree.getAttribute('aria-activedescendant'); assert(first, 'Tree Home did not identify an active row.');
  await page.keyboard.press('ArrowDown'); assert((await tree.getAttribute('aria-activedescendant')) !== first, 'Tree ArrowDown did not move focus.');
  await page.keyboard.press('End'); assert((await tree.getAttribute('aria-activedescendant')) !== first, 'Tree End did not move focus.');
  await page.keyboard.press('Home');
}
async function expectFileAbsent(target) { try { await access(target); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } }

async function desktopScenarios(session, fixture, output) {
  const { page } = session, results = [];
  let manifest;
  const scenario = async (name, run) => {
    const startedAt = new Date().toISOString();
    try { const evidence = await run(); results.push({ name, status: 'passed', startedAt, finishedAt: new Date().toISOString(), evidence }); }
    catch (error) {
      results.push({ name, status: 'failed', startedAt, error: error.stack ?? String(error) }); await screenshot(page, output, `failure-${name}`).catch(() => {});
      // Close only transient UI left by this failed scenario so later independent checks observe their own state.
      for (let attempt = 0; attempt < 3 && await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').count(); attempt++) await page.keyboard.press('Escape');
    }
    await writeJson(path.join(output, 'desktop-results.json'), { version: 1, complete: false, scenarios: results });
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('file-tree').waitFor({ timeout: 30000 });
  await scenario('recent-project-modal-disclosure-and-continuation', async () => {
    await page.getByTestId('workspace-switch').click();
    const evidence = await verifyPickerDisclosure(page);
    const continuation = page.locator('.workspace-picker .recent-continue');
    assert(await continuation.count() === 1, 'Recent projects need one clear primary continuation.');
    await continuation.focus(); await page.keyboard.press('Enter');
    await page.getByTestId('workspace-disclose').waitFor({ state: 'hidden' });
    await page.getByTestId('file-tree').waitFor({ state: 'visible' });
    return { ...evidence, recentContinuation: true };
  });
  await scenario('explorer-keyboard-and-paper-evidence', async () => {
    await keyboardTree(page);
    const direct = await revealTreeRow(page, 'paper-direct');
    await direct.click();
    await waitFor(async () => (await direct.getAttribute('aria-label'))?.includes('논문 관련 파일 포함'), { label: 'verified direct paper-directory evidence' });
    const evidenceStyle = await direct.locator('.file-label').evaluate(element => ({ weight: getComputedStyle(element).fontWeight, color: getComputedStyle(element).backgroundColor }));
    assert(Number(evidenceStyle.weight) >= 600 && evidenceStyle.color !== 'rgba(0, 0, 0, 0)', 'Direct paper evidence needs bold type and a visible amber label band.');
    const ancestor = page.getByRole('treeitem', { name: /^ancestor(?:,|$)/ }); await ancestor.click();
    await page.getByRole('treeitem', { name: /^deep(?:,|$)/ }).click();
    await page.getByRole('treeitem', { name: /^paper(?:,|$)/ }).click();
    await waitFor(async () => (await ancestor.getAttribute('aria-label'))?.includes('하위 폴더'), { label: 'positive evidence ancestor propagation' });
    assert(await ancestor.locator('.paper-dot').count(), 'Ancestor evidence needs an amber dot.');
    return { direct: await direct.getAttribute('aria-label'), directStyle: evidenceStyle, ancestor: await ancestor.getAttribute('aria-label') };
  });
  await scenario('bounded-discovery-frontier-and-virtualized-stress-tree', async () => {
    const stress = await revealTreeRow(page, 'stress-tree');
    assert(await stress.locator('.unknown-mark').count(), 'Unscanned is not the same as no paper evidence.');
    const excluded = await revealTreeRow(page, 'node_modules'); assert((await excluded.innerText()).includes('제외'), 'Default discovery exclusions were not visible.');
    let sweeps = 0;
    while (sweeps < 3) {
      await waitFor(async () => ['complete','paused'].includes(await page.locator('.discovery-status').getAttribute('data-state')), { timeoutMs: 120000, label: 'active filename sweep settles before explicit continuation' });
      if (await page.locator('.discovery-status').getAttribute('data-state') === 'complete') break;
      await page.locator('.discovery-status button').click(); sweeps++;
    }
    assert(await page.locator('.discovery-status').getAttribute('data-state') === 'complete', 'The on-disk discovery frontier could not be continued to completion.');
    const markedStress = await revealTreeRow(page, 'stress-tree'); assert(await markedStress.locator('.paper-dot').count(), 'Deep verified bibliography evidence did not propagate through the stress tree.');
    await markedStress.click(); const rows = await page.getByTestId('file-tree').getByRole('treeitem').count();
    assert(rows < 100, 'The explorer retained all offscreen DOM rows instead of virtualizing.');
    const directoryNames = await readdir(path.join(fixture.root, 'stress-tree'));
    let entryCount = directoryNames.length;
    for (const name of directoryNames) entryCount += (await readdir(path.join(fixture.root, 'stress-tree', name))).length;
    assert(entryCount === 20000, 'Synthetic filename stress tree does not contain exactly 20,000 entries.');
    await markedStress.click(); return { sweeps, actualStressEntries: entryCount, mountedRows: rows };
  });
  await scenario('root-picker-and-real-thirty-page-pdf', async () => {
    const root = page.getByRole('combobox', { name: '주 문서', exact: true });
    assert(!(await root.inputValue()), 'Multiple documentclass candidates must require an explicit root choice.');
    await root.selectOption('main.tex');
    manifest = await buildPaper(page, fixture.root);
    assert(manifest.mappingReady === true, 'Stable synthetic source build must be edit-grade.');
    await showPdf(page);
    assert((await stat(path.join(manifest.directory, (await readdir(manifest.directory)).find(name => name.endsWith('.pdf'))))).size <= fixture.maxPdfBytes, 'Standard workload PDF exceeds 10 MiB.');
    const pageInput = page.getByRole('spinbutton', { name: 'PDF 페이지', exact: true });
    assert(Number(await pageInput.getAttribute('max')) === 30, 'Fixture did not compile to exactly 30 real pages.');
    return { buildId: manifest.buildId, mappingReady: manifest.mappingReady, pages: 30, pdfSha256: manifest.pdfSha256 };
  });
  await scenario('installed-optional-latex-engines', async () => {
    const engines = [];
    for (const engine of ['xelatex', 'lualatex']) {
      const found = await runExternal('where.exe', [engine], { output, prefix: `engine-${engine}-discovery`, acceptedExitCodes: [0, 1] });
      if (found.exitCode === 1) { engines.push({ engine, installed: false, exercised: false, reason: 'Optional engine not installed; no substitute used.' }); continue; }
      await settings(page, () => page.getByRole('combobox', { name: '엔진', exact: true }).selectOption(engine));
      await waitFor(async () => JSON.parse(await readFile(path.join(fixture.root, '.texypaper', 'project.json'), 'utf8')).engine === engine, { label: `${engine} persisted project setting` });
      manifest = await buildPaper(page, fixture.root);
      assert(manifest.engine === engine, `Requested ${engine} was silently substituted with ${manifest.engine}.`);
      await showPdf(page); engines.push({ engine, installed: true, exercised: true, buildId: manifest.buildId });
    }
    await settings(page, () => page.getByRole('combobox', { name: '엔진', exact: true }).selectOption('pdflatex'));
    await waitFor(async () => JSON.parse(await readFile(path.join(fixture.root, '.texypaper', 'project.json'), 'utf8')).engine === 'pdflatex', { label: 'explicit pdfLaTeX restoration acknowledged' });
    manifest = await buildPaper(page, fixture.root);
    return { engines };
  });
  await scenario('native-dialog-pdf-export', async () => {
    await showPdf(page);
    const destination = path.join(output, 'exported-real-paper.pdf');
    await page.getByRole('button', { name: 'PDF 내보내기', exact: true }).click();
    const dialog = await saveNativePdfDialog({ appPid: session.child.pid, destination, output });
    const bytes = await waitFor(async () => { try { const value = await readFile(destination); return value.length && value; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, { label: 'actual disk-streamed PDF export' });
    assert(digest(bytes) === manifest.pdfSha256, 'Exported PDF does not match the displayed build.');
    return { destination, bytes: bytes.length, sha256: digest(bytes), dialog };
  });
  await scenario('pdf-navigation-search-rotation-and-reference', async () => {
    await showPdf(page);
    const input = page.getByRole('spinbutton', { name: 'PDF 페이지', exact: true });
    await input.fill('3'); assert(await input.inputValue() === '3', 'PDF page jump failed.');
    await page.getByRole('button', { name: '다음 페이지', exact: true }).click(); assert(await input.inputValue() === '4', 'Next page did not navigate.');
    await page.getByRole('button', { name: '이전 페이지', exact: true }).click(); assert(await input.inputValue() === '3', 'Previous page did not navigate.');
    await page.getByRole('combobox', { name: 'PDF 확대', exact: true }).selectOption('1.5');
    await page.getByRole('button', { name: 'PDF 90도 회전', exact: true }).click();
    assert((await page.getByRole('button', { name: 'PDF 90도 회전', exact: true }).innerText()).includes('90'), 'PDF rotation state did not change.');
    for (let turn = 0; turn < 3; turn++) await page.getByRole('button', { name: 'PDF 90도 회전', exact: true }).click();
    await page.getByRole('button', { name: '너비 맞춤', exact: true }).click();
    await page.getByRole('textbox', { name: 'PDF 텍스트 검색', exact: true }).fill('Synthetic page 17');
    await page.locator('.pdf-search').getByRole('button', { name: '검색', exact: true }).click();
    await page.locator('.pdf-search-results button').filter({ hasText: '17' }).first().click();
    assert(await input.inputValue() === '17', 'PDF page-by-page text search did not navigate to actual result.');
    await page.getByRole('button', { name: '소스', exact: true }).click();
    const folder = await revealTreeRow(page, 'pdf-only'); if (await folder.getAttribute('aria-expanded') !== 'true') await folder.click();
    assert(!(await folder.getAttribute('aria-label')).includes('논문 관련 파일 포함'), 'PDF-only directory was falsely classified as a LaTeX paper.');
    await (await revealTreeRow(page, 'pdf-only/reference.pdf')).click();
    await page.locator('.textLayer').filter({ hasText: 'TexyPaper reference PDF only.' }).waitFor();
    await page.getByRole('button', { name: '빌드', exact: true }).click();
    await waitFor(async () => await page.getByRole('button', { name: '빌드', exact: true }).isVisible(), { timeoutMs: 150000, label: 'rebuild while reference PDF remains active' });
    assert(await page.locator('.textLayer').filter({ hasText: 'TexyPaper reference PDF only.' }).isVisible(), 'Main build replaced an explicitly opened reference PDF.');
    await page.getByRole('button', { name: '빌드 PDF로 돌아가기', exact: true }).first().click();
    await page.locator('.textLayer').filter({ hasText: 'TexyPaper reference PDF only.' }).waitFor({ state: 'detached' });
    await page.locator('.textLayer span').first().waitFor({ state: 'visible' });
    await input.fill('1'); await page.locator('.textLayer').filter({ hasText: 'Synthetic page 1' }).first().waitFor();
    return { searchedPage: 17, rotatedDegrees: 90, referenceKeptDuringBuild: true };
  });
  await scenario('cancel-owned-real-compiler-tree', async () => {
    const root = page.getByRole('combobox', { name: '주 문서', exact: true }); await root.selectOption('busy.tex');
    const before = await latestManifest(fixture.root);
    await page.getByRole('button', { name: '빌드', exact: true }).click();
    const running = await waitFor(async () => {
      const children = (await ownedProcesses(session.child.pid)).filter(process => /^(latexmk|perl|pdftex|pdflatex|miktex-latexmk)\.exe$/i.test(process.Name));
      return children.length > 1 && children;
    }, { timeoutMs: 30000, label: 'real latexmk and engine descendants' });
    await page.getByRole('button', { name: '빌드 중지', exact: true }).click();
    await waitFor(async () => {
      const snapshot = await runExternal('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,CreationDate | ConvertTo-Json -Compress'], { timeoutMs: 15000 });
      const all = JSON.parse(snapshot.stdout || '[]');
      return running.every(old => !all.some(current => current.ProcessId === old.ProcessId && current.CreationDate === old.CreationDate));
    }, { timeoutMs: 15000, label: 'all captured compiler/engine identities exited, including reparented children' });
    assert((await latestManifest(fixture.root)).buildId === before.buildId, 'Cancelled work published a generation.');
    await root.selectOption('main.tex'); manifest = await buildPaper(page, fixture.root);
    return { terminated: running };
  });
  await scenario('create-rename-trash-restore', async () => {
    page.once('dialog', dialog => dialog.accept('smoke-created.tex'));
    await page.getByRole('button', { name: '새 파일', exact: true }).click();
    await waitFor(async () => !(await expectFileAbsent(path.join(fixture.root, 'smoke-created.tex'))), { label: 'created file on actual disk' });
    await page.getByRole('button', { name: '소스', exact: true }).click();
    await quickOpen(page, 'smoke-created.tex');
    const tree = page.getByTestId('file-tree'); await tree.focus(); await page.keyboard.press('End');
    const row = page.getByRole('treeitem', { name: /^smoke-created\.tex/ }); await row.click({ button: 'right' });
    page.once('dialog', dialog => dialog.accept('smoke-renamed.tex'));
    await page.getByRole('menuitem', { name: '이름 변경 / 이동' }).click();
    await waitFor(async () => !(await expectFileAbsent(path.join(fixture.root, 'smoke-renamed.tex'))) && await expectFileAbsent(path.join(fixture.root, 'smoke-created.tex')), { label: 'actual disk rename' });
    await page.getByRole('treeitem', { name: /^smoke-renamed\.tex/ }).click({ button: 'right' });
    const dialogs = []; const accept = async dialog => { dialogs.push(dialog.message()); await dialog.accept(); }; page.on('dialog', accept);
    try { await page.getByRole('menuitem', { name: '프로젝트 휴지통으로 이동' }).click(); await waitFor(() => dialogs.length === 2, { label: 'named trash and restore confirmations' }); }
    finally { page.off('dialog', accept); }
    assert(dialogs[0].includes('smoke-renamed.tex'), 'Destructive confirmation did not name its target.');
    await waitFor(async () => !(await expectFileAbsent(path.join(fixture.root, 'smoke-renamed.tex'))), { label: 'restored file on original host' });
    return { dialogs };
  });
  await scenario('unicode-bom-crlf-and-cdp-ime', async () => {
    await page.getByRole('button', { name: '소스', exact: true }).click(); await quickOpen(page, fixture.files.unicode);
    const before = await readFile(path.join(fixture.root, fixture.files.unicode));
    const editor = page.locator('.cm-content'); await editor.click(); await page.keyboard.press('Control+End');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '한글입력', selectionStart: 4, selectionEnd: 4 });
    await delay(1000);
    assert(digest(await readFile(path.join(fixture.root, fixture.files.unicode))) === digest(before), 'Autosave must pause during active IME composition.');
    await cdp.send('Input.insertText', { text: '한글입력 😀' }); await cdp.detach(); await page.keyboard.press('Control+s');
    const after = await waitFor(async () => { const bytes = await readFile(path.join(fixture.root, fixture.files.unicode)); return bytes.includes(Buffer.from('한글입력 😀')) && bytes; }, { label: 'committed Korean/emoji native source save' });
    assert(after.subarray(0, 3).equals(Buffer.from([239,187,191])), 'UTF-8 BOM was lost.');
    assert(!after.subarray(3).toString().replaceAll('\r\n', '').includes('\n'), 'Existing CRLF file was silently normalized to LF.');
    assert(after.subarray(0, before.length).equals(before), 'Saving an appended IME edit changed unaffected BOM/CRLF/combining-character bytes.');
    await editor.click(); await page.keyboard.press('Control+Home'); await page.keyboard.press('Shift+End'); await page.keyboard.press('Control+Shift+a');
    await page.locator('#comment-text').fill('Unicode BOM physical anchor.'); await page.getByRole('button', { name: '댓글 저장', exact: true }).click();
    const anchor = await waitFor(async () => {
      const value = JSON.parse(await readFile(path.join(fixture.root, '.texypaper', 'comments.json'), 'utf8'));
      return value.threads.find(thread => thread.messages.some(message => message.text === 'Unicode BOM physical anchor.'))?.source;
    }, { label: 'physical UTF-8 source comment interval' });
    const firstLine = before.subarray(3).toString('utf8').split('\r\n')[0];
    assert(anchor.startByte === 3 && anchor.endByte === 3 + Buffer.byteLength(firstLine), 'Comment byte interval did not include the physical UTF-8 BOM offset or respected UTF-8 grapheme boundaries.');
    return { beforeSha256: digest(before), afterSha256: digest(after), bom: true, lineEndings: 'crlf', imeRoute: 'real CDP Input.imeSetComposition/Input.insertText' };
  });
  await scenario('large-file-and-encoding-safety', async () => {
    await quickOpen(page, 'large-readonly.tex');
    assert(await page.getByText(/큰 파일|4 MiB|4 MB|대용량/).first().isVisible(), 'Missing large-source memory notice.');
    assert(await page.locator('.cm-content').getAttribute('contenteditable') === 'false', 'Large file did not default to read-only.');
    await quickOpen(page, 'unsupported-encoding.txt');
    assert(await page.getByText(/ENCODING_UNSUPPORTED|인코딩/).first().isVisible(), 'Undecodable bytes must show an explicit encoding error.');
    return { largeFileBytes: (await stat(path.join(fixture.root, 'large-readonly.tex'))).size };
  });
  await scenario('same-size-external-save-conflict', async () => {
    await quickOpen(page, fixture.files.unicode);
    const target = path.join(fixture.root, fixture.files.unicode), saved = await readFile(target);
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' local pending');
    const external = Buffer.from(saved); const index = external.indexOf(Buffer.from('UTF8')); external[index] = 'V'.charCodeAt(0); await writeFile(target, external);
    await page.keyboard.press('Control+s');
    await page.getByText(/FILE_CONFLICT|외부 변경|충돌/).first().waitFor();
    assert((await readFile(target)).equals(external), 'Conflict overwrote a same-size external edit.');
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: /다시 불러오기|새로 불러오기|Reload/ }).first().click();
    return { sameLength: saved.length === external.length, externalSha256: digest(external) };
  });
  await scenario('pdf-literal-prose-review-and-rebuild', async () => {
    assert(manifest, 'Earlier real PDF build is required.');
    manifest = await buildPaper(page, fixture.root);
    await showPdf(page); await page.getByRole('spinbutton', { name: 'PDF 페이지', exact: true }).fill('1');
    await selectPdfText(page, 'measured evidence supports careful scientific writing.');
    await page.getByRole('button', { name: '텍스트 수정', exact: true }).click();
    const target = path.join(fixture.root, fixture.files.prose), original = await readFile(target, 'utf8');
    await page.getByRole('textbox', { name: '바꿀 텍스트', exact: true }).fill('verified evidence supports reproducible scientific writing.');
    assert((await readFile(target, 'utf8')) === original, 'PDF edit review changed source before Apply.');
    await page.getByRole('button', { name: '변경 적용', exact: true }).click();
    await waitFor(async () => (await readFile(target, 'utf8')).includes('verified evidence supports reproducible scientific writing.'), { label: 'proof-bound source transaction' });
    const next = await waitFor(async () => { const value = await latestManifest(fixture.root); return value?.buildId !== manifest.buildId && value; }, { timeoutMs: 150000, label: 'new PDF publication after approved prose edit' });
    await waitFor(async () => await page.getByTestId('build-status').getAttribute('data-status') === 'published' && await page.getByTestId('build-status').getAttribute('data-build-id') === next.buildId, { timeoutMs: 150000, label: 'displayed build identity advanced after approved prose edit' });
    await showPdf(page); await page.getByRole('spinbutton', { name: 'PDF 페이지', exact: true }).fill('1');
    await page.locator('.textLayer').filter({ hasText: 'verified evidence' }).first().waitFor({ timeout: 30000 });
    manifest = next; return { newBuildId: next.buildId, newSourceSha256: digest(await readFile(target)) };
  });
  await scenario('ambiguous-macro-math-and-stale-selections-never-write', async () => {
    await showPdf(page); await page.getByRole('spinbutton', { name: 'PDF 페이지', exact: true }).fill('1');
    const target = path.join(fixture.root, fixture.files.prose), before = await readFile(target);
    for (const quote of ['Repeated prose must never authorize a guessed replacement.', 'mathematics', 'citation']) {
      await selectPdfText(page, quote); await page.getByRole('button', { name: '텍스트 수정', exact: true }).click();
      const review = page.getByRole('dialog', { name: '원문 수정 검토', exact: true });
      await review.waitFor();
      assert((await readFile(target)).equals(before), `Review for ${quote} wrote source without approval.`);
      // Repeated text can be disambiguated by geometry/context; unsupported mappings must disable Apply.
      const replacement = review.getByRole('textbox', { name: '바꿀 텍스트', exact: true });
      if (!(await replacement.count())) assert(!(await review.getByRole('button', { name: '변경 적용', exact: true }).count()), 'Unavailable source mapping exposed an Apply button.');
      await page.keyboard.press('Escape');
    }
    // A single rendered line whose literal spans a TeX source newline; multi-line PDF selections are deliberately refused.
    await selectPdfText(page, 'without guessing. A second source line');
    await page.getByRole('button', { name: '텍스트 수정', exact: true }).click();
    const review = page.getByRole('dialog', { name: '원문 수정 검토', exact: true });
    await review.getByRole('textbox', { name: '바꿀 텍스트', exact: true }).fill('This stale interval must never be applied.');
    const external = Buffer.concat([before, Buffer.from('\n% Source changed after PDF proof creation.\n')]); await writeFile(target, external);
    const apply = review.getByRole('button', { name: '변경 적용', exact: true });
    if (await apply.isVisible()) await apply.click();
    await page.getByText(/PDF_STALE|소스.*변경|다시 빌드|오래된/).first().waitFor();
    assert((await readFile(target)).equals(external), 'Stale proof overwrote the externally changed source.');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '소스', exact: true }).click(); await quickOpen(page, fixture.files.prose);
    // CodeMirror renders only the viewport; the external marker is appended at the end of the file.
    await waitFor(async () => { await page.locator('.cm-content').click(); await page.keyboard.press('Control+End'); return (await page.locator('.cm-content').textContent()).includes('Source changed after PDF proof creation.'); }, { label: 'external source revision reload before safe restoration' });
    await replaceSource(page, fixture.files.prose, before.toString('utf8'), fixture.root); manifest = await buildPaper(page, fixture.root);
    return { sourceSha256Before: digest(before), staleSourceSha256: digest(external) };
  });
  await scenario('failed-build-keeps-stale-pdf', async () => {
    const target = path.join(fixture.root, fixture.files.prose), original = await readFile(target, 'utf8');
    let retainedBuildId;
    try {
      await replaceSource(page, fixture.files.prose, original + '\n\\texypaperUndefinedCommand\n', fixture.root);
      await page.getByRole('button', { name: '빌드', exact: true }).click();
      await page.locator('[role="alert"]').filter({ hasText: /BUILD_FAILED|빌드 실패|컴파일 실패|LATEX/ }).first().waitFor({ timeout: 150000 });
      const after = await latestManifest(fixture.root); assert(after.buildId === manifest.buildId, 'Failed build published an old artifact as a new success.');
      retainedBuildId = after.buildId;
      await showPdf(page); await page.getByText(/오래된|이전.*PDF|최신.*아님|stale/i).first().waitFor();
    } finally {
      await replaceSource(page, fixture.files.prose, original, fixture.root);
      manifest = await buildPaper(page, fixture.root, manifest.buildId);
    }
    return { retainedBuildId, recoveredBuildId: manifest.buildId };
  });
  await scenario('comments-persist-and-resolve', async () => {
    await page.getByRole('button', { name: '소스', exact: true }).click(); await quickOpen(page, fixture.files.prose);
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+ArrowDown'); await page.keyboard.press('Control+Shift+ArrowRight'); await page.keyboard.press('Control+Shift+a');
    await page.locator('#comment-text').fill('Synthetic persisted source comment.');
    await page.getByRole('button', { name: '댓글 저장', exact: true }).click();
    const commentsPath = path.join(fixture.root, '.texypaper', 'comments.json');
    const sidecar = await waitFor(async () => { try { const value = JSON.parse(await readFile(commentsPath, 'utf8')); return value.threads?.some(thread => thread.messages.some(message => message.text === 'Synthetic persisted source comment.')) && value; } catch { return false; } }, { label: 'actual portable comments sidecar' });
    const thread = page.locator('.comment-thread').filter({ hasText: 'Synthetic persisted source comment.' });
    await thread.getByRole('button', { name: '답글', exact: true }).click();
    await page.locator('#comment-text').fill('Synthetic comment reply.'); await page.getByRole('button', { name: '댓글 저장', exact: true }).click();
    await thread.getByText('Synthetic comment reply.', { exact: true }).waitFor();
    page.once('dialog', dialog => dialog.accept('Synthetic edited reply.'));
    await thread.locator('.comment-message').filter({ hasText: 'Synthetic comment reply.' }).getByRole('button', { name: '내 댓글 수정', exact: true }).click();
    await thread.getByText('Synthetic edited reply.', { exact: true }).waitFor();
    page.once('dialog', dialog => dialog.accept());
    await thread.locator('.comment-message').filter({ hasText: 'Synthetic edited reply.' }).getByRole('button', { name: '내 댓글 삭제', exact: true }).click();
    await waitFor(async () => !JSON.stringify(JSON.parse(await readFile(commentsPath, 'utf8'))).includes('Synthetic edited reply.'), { label: 'own reply deletion persisted, not only hidden from the UI' });
    await page.getByRole('button', { name: '해결', exact: true }).first().click();
    await waitFor(async () => JSON.parse(await readFile(commentsPath, 'utf8')).threads.some(thread => thread.status === 'resolved'), { label: 'persisted resolved comment' });
    await page.getByRole('combobox', { name: '댓글 상태', exact: true }).selectOption('resolved'); await page.getByRole('button', { name: '다시 열기', exact: true }).first().click();
    await page.getByRole('combobox', { name: '댓글 상태', exact: true }).selectOption('open');
    await showPdf(page); await page.getByRole('spinbutton', { name: 'PDF 페이지', exact: true }).fill('1');
    await selectPdfText(page, 'identifies source mapping without guessing.');
    await page.locator('.pdf-selection-popover').getByRole('button', { name: '댓글', exact: true }).click();
    await page.locator('#comment-text').fill('Synthetic persisted PDF comment.');
    await page.getByRole('button', { name: '댓글 저장', exact: true }).click();
    const pdfThread = await waitFor(async () => JSON.parse(await readFile(commentsPath, 'utf8')).threads.find(item => item.messages.some(message => message.text === 'Synthetic persisted PDF comment.')), { label: 'portable PDF geometry comment persisted' });
    assert(pdfThread.pdf?.buildId === manifest.buildId && pdfThread.pdf.pdfSha256 === manifest.pdfSha256 && pdfThread.pdf.page === 1, 'PDF comment lost its displayed immutable artifact identity.');
    assert(pdfThread.pdf.rects.every(rect => rect.length === 4 && rect.every(Number.isFinite) && rect[2] > 0 && rect[3] > 0), 'PDF comment has invalid page geometry.');
    await page.locator('.pdf-comment-mark').first().click();
    await page.locator(`#comment-${pdfThread.id}`).waitFor({ state: 'visible' });
    return { threadCount: sidecar.threads.length, revision: sidecar.revision, pdfThreadId: pdfThread.id };
  });
  await scenario('native-ascii-unicode-synctex-fallback-comparison', async () => {
    assert(/^[\x00-\x7f]+$/.test(fixture.mappingPairRoot), 'ASCII_OUTPUT_DIRECTORY_REQUIRED: choose an ASCII-only --output path to compare truly ASCII native SyncTeX paths with Korean paths.');
    let ascii, unicode, gateEvidence;
    try {
      await openWorkspace(page, fixture.mappingPairRoot);
      await quickOpen(page, 'paper-ASCII/main.tex'); await selectMainDocument(page, 'paper-ASCII/main.tex');
      ascii = await buildPaper(page, fixture.mappingPairRoot); await showPdf(page);
      await page.getByRole('button', { name: '소스', exact: true }).click();
      await quickOpen(page, '한국 논문/main.tex'); await selectMainDocument(page, '한국 논문/main.tex');
      unicode = await buildPaper(page, fixture.mappingPairRoot); await showPdf(page);
      assert(JSON.stringify(ascii.sources.map(source => source.sha256).sort()) === JSON.stringify(unicode.sources.map(source => source.sha256).sort()), 'The SyncTeX comparison fixtures are not byte-identical.');
      const gate = page.getByTestId('unicode-mapping-gate'); await gate.click();
      await waitFor(async () => ['passed', 'failed'].includes(await gate.getAttribute('data-status')), { timeoutMs: 30000, label: 'native ASCII vs streaming Unicode SyncTeX geometry validation' });
      gateEvidence = { status: await gate.getAttribute('data-status'), text: await gate.innerText() };
      assert(gateEvidence.status === 'passed', `Real Unicode geometry validation failed: ${gateEvidence.text}`);
      await page.getByRole('button', { name: '소스', exact: true }).click(); await quickOpen(page, '한국 논문/main.tex');
      await page.locator('.cm-content').click(); await page.keyboard.press('Control+Home'); for (let line = 0; line < 6; line++) await page.keyboard.press('ArrowDown');
      const sync = page.getByTestId('sync-status'), previous = await sync.getAttribute('data-sequence');
      await page.keyboard.press('Control+Alt+j');
      await waitFor(async () => await sync.getAttribute('data-direction') === 'forward' && await sync.getAttribute('data-sequence') !== previous, { label: 'actual Unicode source-to-PDF SyncTeX navigation' });
      await showPdf(page); const quote = 'Unicode mapping retains source identity without a basename shortcut.';
      await selectPdfText(page, quote); await page.getByRole('button', { name: '텍스트 수정', exact: true }).click();
      await page.getByRole('dialog', { name: '원문 수정 검토', exact: true }).getByRole('textbox', { name: '바꿀 텍스트', exact: true }).waitFor();
      await screenshot(page, output, 'unicode-proven-source-review'); await page.keyboard.press('Escape');
      await selectPdfText(page, quote); await page.getByRole('button', { name: '원문 보기', exact: true }).click();
      await page.locator('.cm-content').waitFor();
      assert(await page.locator('.file-tabs [role="tab"][aria-selected="true"]').getAttribute('title') === '한국 논문/main.tex', 'Unicode inverse mapping navigated to a basename collision in the ASCII subtree.');
      return { asciiBuildId: ascii.buildId, unicodeBuildId: unicode.buildId, gate: gateEvidence };
    } finally { await page.keyboard.press('Escape'); await openWorkspace(page, fixture.root); manifest = await buildPaper(page, fixture.root); }
  });
  await scenario('bilingual-appearance-accessibility-screenshots', async () => {
    const screenshots = [];
    for (const locale of ['ko', 'en']) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await settings(page, async () => { await page.getByTestId('ui-locale').selectOption(locale); await page.getByTestId('ui-theme').selectOption(theme); });
      const expectedSource = locale === 'ko' ? '소스' : 'Source';
      await page.getByRole('button', { name: expectedSource, exact: true }).click();
      assert(await page.locator('.cm-editor').isVisible(), `Translated ${locale} Source action did not open the editor.`);
      const expectedBuild = locale === 'ko' ? '빌드' : 'Build';
      assert(await page.getByRole('button', { name: expectedBuild, exact: true }).isVisible(), `Missing translated ${locale} Build action.`);
      const actual = await page.evaluate(() => ({ locale: document.documentElement.lang, theme: document.documentElement.dataset.theme }));
      assert(actual.locale === locale && actual.theme === theme, `Locale/theme not applied: ${JSON.stringify(actual)}`);
      const name = `1440-${locale}-${theme}-100`; await screenshot(page, output, name); screenshots.push(name);
      await page.setViewportSize({ width: 960, height: 640 }); const narrow = `960-${locale}-${theme}-100`; await screenshot(page, output, narrow); screenshots.push(narrow);
      await settings(page, () => page.getByTestId('ui-zoom').selectOption('2'));
      const zoomed = `960-${locale}-${theme}-200`; await screenshot(page, output, zoomed); screenshots.push(zoomed);
      const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      assert(overflow.scroll <= overflow.client + 1, `${locale} 200% UI zoom creates horizontal overflow.`);
      await settings(page, () => page.getByTestId('ui-zoom').selectOption('1'));
    }
    await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' }); await screenshot(page, output, '960-en-high-contrast-reduced-motion');
    await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' });
    await settings(page, () => page.getByTestId('ui-locale').selectOption('ko'));
    await page.setViewportSize({ width: 1440, height: 900 });
    const controls = await page.locator('button:visible, input:visible, select:visible').evaluateAll(elements => elements.filter(element => !element.getAttribute('aria-label') && !element.textContent?.trim() && !element.labels?.length).map(element => element.outerHTML.slice(0, 200)));
    assert(controls.length === 0, 'Visible controls without accessible labels: ' + controls.join(', '));
    return { screenshots };
  });
  await scenario('workspace-switch-stale-event-isolation', async () => {
    await openWorkspace(page, fixture.secondRoot); await quickOpen(page, 'main.tex');
    const content = await page.locator('.cm-content').innerText(); assert(content.includes('Second workspace epoch isolation.'), 'New project did not open its actual source.');
    await delay(3000); assert((await page.locator('.cm-content').innerText()).includes('Second workspace epoch isolation.'), 'Old workspace event replaced the new source.');
    assert(!(await page.locator('.textLayer:visible').count()), 'An unrelated old PDF remains active in the new workspace.');
    await openWorkspace(page, fixture.root);
    if (!await page.locator('#comments-tab').isVisible()) await page.getByRole('button', { name: 'AI 및 댓글 패널', exact: true }).click();
    await page.locator('#comments-tab').click();
    await page.getByText('Synthetic persisted source comment.', { exact: true }).waitFor();
    return { changedRoot: fixture.secondRoot, originalCommentReloaded: true };
  });
  const report = { version: 1, completedAt: new Date().toISOString(), realReleaseSurface: true, fixture, passed: results.every(result => result.status === 'passed'), scenarios: results };
  await writeJson(path.join(output, 'desktop-results.json'), report); return report;
}

async function memoryWorkload(session, fixture, output, args) {
  const { page, browser } = session;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('file-tree').waitFor({ state: 'visible' });
  await settings(page, async () => { await page.getByTestId('ui-locale').selectOption('ko'); await page.getByTestId('ui-zoom').selectOption('1'); });
  const root = page.getByRole('combobox', { name: '주 문서', exact: true }); await root.selectOption('main.tex');
  const manifest = await buildPaper(page, fixture.root); await showPdf(page);
  const files = ['main.tex', 'references.bib', 'sections/page-01.tex', 'sections/page-02.tex', 'sections/page-03.tex', 'sections/page-04.tex', 'code/analysis.py', 'results/metrics.csv'];
  async function sameState() {
    await page.getByRole('button', { name: '소스', exact: true }).click();
    for (const file of files) await quickOpen(page, file);
    await quickOpen(page, 'sections/page-01.tex');
    await page.getByRole('button', { name: '분할', exact: true }).click();
    await page.getByRole('spinbutton', { name: 'PDF 페이지', exact: true }).fill('1');
    await page.getByRole('button', { name: '너비 맞춤', exact: true }).click();
    if (!await page.locator('#ai-tab').isVisible()) await page.getByRole('button', { name: 'AI 및 댓글 패널', exact: true }).click();
    await page.locator('#ai-tab').click();
  }
  await sameState();
  const scale = await page.evaluate(() => ({ devicePixelRatio, width: innerWidth, height: innerHeight }));
  assert(Math.abs(scale.devicePixelRatio - 1) <= 1e-6 || args.allowNonstandardDisplayScale === true, 'Standard memory gate requires Windows 100% scale (devicePixelRatio≈1). The explicit nonstandard-DPI diagnostic does not pass standard acceptance.');
  const cdp = await browser.newBrowserCDPSession();
  const pageCdp = await page.context().newCDPSession(page);
  await pageCdp.send('Performance.enable');
  const targetSnapshots = [];
  async function snapshot(label) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const workers = targetInfos.filter(target => target.type === 'worker');
    const webviews = targetInfos.filter(target => target.type === 'page' && !target.url.startsWith('devtools:'));
    assert(workers.length <= 1, `Duplicate PDF/parser workers at ${label}: ${workers.length}`);
    assert(webviews.length === 1, `Hidden duplicate webviews at ${label}: ${webviews.length}`);
    const measureRendering = () => page.locator('.pdf-preview').evaluate(element => {
      const canvases = [...element.querySelectorAll('canvas')].filter(canvas => canvas.width && canvas.height);
      const layers = [...element.querySelectorAll('.textLayer')].filter(layer => layer.childNodes.length);
      const viewport = element.querySelector('.pdf-scroll').getBoundingClientRect();
      const offscreenTextLayers = layers.filter(layer => { const box = layer.getBoundingClientRect(); return box.bottom <= viewport.top || box.top >= viewport.bottom; }).length;
      return { canvases: canvases.length, rgbaBytes: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0), textLayers: layers.length, offscreenTextLayers, editors: document.querySelectorAll('.cm-editor').length };
    });
    // Scrolling releases offscreen pages asynchronously (intersection callbacks, cancelled renders). Allow a short
    // bounded settle; anything still retained afterwards is real retention and fails below.
    let rendering = await measureRendering();
    for (let attempt = 0; attempt < 20 && (rendering.offscreenTextLayers || rendering.editors > 1 || rendering.canvases > 3); attempt++) { await delay(100); rendering = await measureRendering(); }
    assert(rendering.canvases <= 3 && rendering.rgbaBytes <= 48 * 1024 * 1024, `Canvas retention budget exceeded at ${label}: ${JSON.stringify(rendering)}`);
    assert(rendering.offscreenTextLayers === 0 && rendering.editors <= 1, `Retained offscreen text layers or hidden editors at ${label}: ${JSON.stringify(rendering)}`);
    const { metrics } = await pageCdp.send('Performance.getMetrics');
    const heap = Object.fromEntries(metrics.filter(metric => ['JSHeapUsedSize','JSHeapTotalSize','Nodes','Documents','JSEventListeners','LayoutObjects'].includes(metric.name)).map(metric => [metric.name, metric.value]));
    const dom = await pageCdp.send('Memory.getDOMCounters');
    targetSnapshots.push({ label, rendering, heap, dom, workers: workers.map(({ type, url }) => ({ type, url })), webviews: webviews.map(({ type, url }) => ({ type, url })) });
  }
  await snapshot('initial');
  await writeJson(path.join(output, 'memory-ready.json'), { readyAt: new Date().toISOString(), fixture, manifest, scale, files, sourceViews: await page.locator('.cm-editor').count(), webviewVersion: browser.version() });
  await waitFor(async () => { try { await access(path.join(output, 'memory-cycles.start')); return true; } catch { return false; } }, { timeoutMs: 120000, label: 'memory sampler warmup handshake' });
  for (let cycle = 0; cycle < 20; cycle++) {
    await openWorkspace(page, fixture.secondRoot); await quickOpen(page, 'main.tex');
    await openWorkspace(page, fixture.root); await root.selectOption('main.tex'); await buildPaper(page, fixture.root);
    await showPdf(page);
    await page.getByRole('spinbutton', { name: 'PDF 페이지', exact: true }).fill(String(cycle % 30 + 1));
    await page.mouse.move(1000, 600); await page.mouse.wheel(0, 700); await page.mouse.wheel(0, -700);
    await snapshot(`cycle-${cycle + 1}`);
  }
  await sameState(); await screenshot(page, output, 'memory-standard-final');
  await writeJson(path.join(output, 'memory-cycles.done.json'), { cycles: 20, finishedAt: new Date().toISOString(), targetSnapshots });
  await waitFor(async () => { try { await access(path.join(output, 'memory-highdpi.start')); return true; } catch { return false; } }, { timeoutMs: Number(args.measurementSeconds ?? 120) * 1000 + 360000, label: 'separate high-DPI measurement phase' });
  await pageCdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await waitFor(() => page.evaluate(() => Math.abs(devicePixelRatio - 2) <= 1e-6), { label: 'actual 2× renderer emulation applied within browser numeric precision' });
  for (let number = 1; number <= 30; number++) {
    await page.getByRole('spinbutton', { name: 'PDF 페이지', exact: true }).fill(String(number));
    await page.locator(`.pdf-page-slot[data-page="${number}"] canvas`).waitFor();
    await delay(100); await snapshot(`highdpi-page-${number}`);
  }
  await screenshot(page, output, 'memory-emulated-highdpi-2x');
  await writeJson(path.join(output, 'memory-highdpi.done.json'), { effectiveDevicePixelRatio: 2, mode: 'CDP renderer emulation at unchanged Windows display scale; not a claim of OS 200% scale', targetSnapshots });
  await waitFor(async () => { try { await access(path.join(output, 'memory-highdpi.stop')); return true; } catch { return false; } }, { timeoutMs: 180000, label: 'high-DPI sampling complete' });
  await pageCdp.send('Emulation.clearDeviceMetricsOverride'); await page.setViewportSize({ width: 1440, height: 900 }); await sameState();
  await waitFor(async () => { try { await access(path.join(output, 'memory-agent.start')); return true; } catch { return false; } }, { timeoutMs: 300000, label: 'agent-inclusive memory phase handshake' });
  let agentResult;
  try {
    const { exerciseAgent } = await import('./smoke-agents.mjs');
    agentResult = await exerciseAgent({ page, provider: args.provider ?? 'codex', output, backend: 'local', resume: false, appPid: session.child.pid, authTimeoutMs: Number(args.authTimeoutSeconds ?? 0) * 1000, readSource: relative => readFile(path.join(fixture.root, relative), 'utf8'), writeSource: (relative, text) => writeFile(path.join(fixture.root, relative), text) });
    await showPdf(page); await page.mouse.move(1000, 600); await page.mouse.wheel(0, 2500); await snapshot('after-live-agent');
    await writeJson(path.join(output, 'memory-agent.done.json'), { passed: true, provider: args.provider ?? 'codex', result: agentResult });
  } catch (error) { await writeJson(path.join(output, 'memory-agent.done.json'), { passed: false, error: error.stack ?? String(error) }); throw error; }
  await waitFor(async () => { try { await access(path.join(output, 'memory-stop')); return true; } catch { return false; } }, { timeoutMs: 120000, label: 'memory sampler shutdown handshake' });
}

export async function configurePreferenceFixtures(page, run) {
  await page.getByTestId('settings-button').click();
  await page.getByTestId('ui-theme').selectOption('light');
  const light = page.getByTestId('palette-light-action'), dark = page.getByTestId('palette-dark-action');
  await light.fill('#1553a3'); await light.press('Enter');
  await waitFor(async () => JSON.parse(await readFile(path.join(run.dataDir, 'settings.json'), 'utf8')).palettes?.light?.action === '#1553a3', { label: 'persisted custom light palette' });
  for (const invalid of ['#nothex', '#ffffff']) {
    await light.fill(invalid); await light.press('Enter'); await page.getByTestId('palette-light-error').waitFor();
    assert(JSON.parse(await readFile(path.join(run.dataDir, 'settings.json'), 'utf8')).palettes.light.action === '#1553a3', 'Invalid HEX or low-contrast accent overwrote the valid persisted palette.');
    await light.fill('#1553a3'); await light.press('Enter');
  }
  await dark.fill('#83b9ff'); await dark.press('Enter');
  await waitFor(async () => JSON.parse(await readFile(path.join(run.dataDir, 'settings.json'), 'utf8')).palettes?.dark?.action === '#83b9ff', { label: 'independent persisted custom dark palette' });
  await page.getByTestId('palette-dark-canvas').fill('#121824');
  await page.getByTestId('palette-dark-canvas').press('Enter');
  await waitFor(async () => JSON.parse(await readFile(path.join(run.dataDir, 'settings.json'), 'utf8')).palettes?.dark?.canvas === '#121824', { label: 'custom background and derived surfaces saved independently' });
  await page.getByTestId('update-check').click();
  await waitFor(async () => /주소.*설정|Configure a release feed/.test(await page.getByTestId('update-status').innerText()), { label: 'honest unconfigured release-feed state' });
  assert(!(await page.getByTestId('update-notice').count()), 'No production/test feed is configured; a fabricated available-release badge appeared.');
  await page.getByTestId('updates-enabled').uncheck();
  assert(await page.getByTestId('update-check').isDisabled(), 'Disabling update checks did not disable Check now.');
  await waitFor(async () => JSON.parse(await readFile(path.join(run.dataDir, 'settings.json'), 'utf8')).updates?.enabled === false, { label: 'persisted disabled update notification setting' });
  await page.getByTestId('ui-theme').selectOption('dark'); await page.keyboard.press('Escape');
  await waitFor(async () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--action').trim().toLowerCase() === '#83b9ff'), { label: 'real dark custom accent applied to rendered app' });
  await waitFor(async () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim().toLowerCase() === '#121824'), { label: 'actual custom background rendered' });
  await screenshot(page, run.output, 'custom-dark-palette');
  return { light: '#1553a3', dark: '#83b9ff', darkBackground: '#121824', invalidHexRejected: true, lowContrastRejected: true, updateFeed: 'unconfigured', updatesDisabledPersisted: true };
}
export async function verifyResetPreferences(page, run) {
  assert(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--action').trim().toLowerCase()) === '#83b9ff', 'Custom dark palette did not survive executable restart.');
  assert(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim().toLowerCase()) === '#121824', 'Custom background did not survive executable restart.');
  await page.getByTestId('settings-button').click();
  assert(!(await page.getByTestId('updates-enabled').isChecked()), 'Disabled update checks did not persist across executable restart.');
  assert(await page.getByTestId('update-check').isDisabled(), 'Restored disabled update state still allows checking.');
  await waitFor(async () => /disabled|꺼져/.test(await page.getByTestId('update-status').innerText()), { label: 'native disabled update status restored on restart' });
  await page.getByTestId('ui-theme').selectOption('light');
  await waitFor(async () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--action').trim().toLowerCase() === '#1553a3'), { label: 'custom light palette persisted independently' });
  await page.getByTestId('palette-reset').click();
  await waitFor(async () => { const value = JSON.parse(await readFile(path.join(run.dataDir, 'settings.json'), 'utf8')); return Object.keys(value.palettes ?? {}).length === 0 && (value.paletteRecents ?? []).length === 0; }, { label: 'both custom palettes and recents reset on actual disk' });
  await page.getByTestId('updates-enabled').check();
  await waitFor(async () => JSON.parse(await readFile(path.join(run.dataDir, 'settings.json'), 'utf8')).updates?.enabled === true, { label: 'explicit re-enable persisted' });
  await page.getByTestId('update-check').click();
  await waitFor(async () => /Configure a release feed|주소.*설정/.test(await page.getByTestId('update-status').innerText()), { label: 're-enabled feed remains honestly unconfigured' });
  await page.getByTestId('ui-theme').selectOption('dark'); await page.keyboard.press('Escape');
  return { customPalettesRestored: true, defaultsReset: true, updateDisabledRestored: true };
}
export async function exerciseOptionalUpdateFeed(page, args, output, dataDir) {
  if (!args.updateFeed) return { status: 'not-exercised', reason: 'No TexyPaper production release feed is supplied. Unconfigured/disabled persistence is exercised; a new production release is not invented.' };
  assert(typeof args.updateFeed === 'string' && typeof args.updateVersion === 'string', '--update-feed requires --update-version <expected real test release version>.');
  const url = new URL(args.updateFeed); assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'A real credential-free HTTPS update test feed is required.');
  await page.getByTestId('settings-button').click();
  await page.getByTestId('updates-feed').fill(url.href); await page.getByTestId('updates-feed-save').click();
  await waitFor(async () => JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).updates?.feedUrl === url.href, { label: 'actual HTTPS release feed saved before checking' });
  await page.getByTestId('update-check').click();
  await waitFor(async () => (await page.getByTestId('update-notice').innerText()).includes(args.updateVersion), { timeoutMs: 30000, label: 'actual HTTPS release metadata produced an available-version bottom badge' });
  await page.keyboard.press('Escape'); await delay(12000);
  assert((await page.getByTestId('update-notice').innerText()).includes(args.updateVersion), 'Available-release notification disappeared like a transient toast.');
  const badge = await page.getByTestId('update-notice').boundingBox(), viewport = await page.evaluate(() => ({ height: innerHeight }));
  assert(badge && badge.y > viewport.height * 0.6, 'The persistent update notice is not placed at the bottom working surface.');
  await screenshot(page, output, 'real-test-feed-persistent-update-notice');
  return { status: 'passed', feed: url.href, expectedVersion: args.updateVersion, origin: 'Explicit HTTPS release fixture used only in an isolated test profile, not an official production TexyPaper release.' };
}

export async function exerciseInstaller({ installer, run, fixture }) {
  const output = path.join(run.output, 'installer'); await mkdir(output);
  installer = path.resolve(installer); await access(installer);
  const installedDirectory = path.join(output, 'installation');
  const prior = await runExternal('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference=\"Stop\"; @(\"HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TexyPaper\",\"HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TexyPaper\") | ForEach-Object { if (Test-Path -LiteralPath $_) { throw \"An existing TexyPaper installation prevents isolated installer smoke.\" } }; if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA \"TexyPaper\")) { throw \"An existing TexyPaper install directory prevents isolated installer smoke.\" }; Get-AuthenticodeSignature -LiteralPath $env:TEXYPAPER_SMOKE_INSTALLER | Select-Object Status,StatusMessage | ConvertTo-Json -Compress'], { output, prefix: 'installer-prerequisites', env: { TEXYPAPER_SMOKE_INSTALLER: installer } });
  const signature = JSON.parse(prior.stdout);
  let installed, report;
  try {
    await runExternal(installer, ['/S', `/D=${installedDirectory}`], { output, prefix: 'nsis-install', timeoutMs: 300000 });
    const installedBinary = path.join(installedDirectory, 'texypaper.exe');
    await access(installedBinary);
    const dataDir = path.join(output, 'app-data'); await mkdir(dataDir);
    installed = await launchDesktop({ binary: installedBinary, output, dataDir, project: fixture.secondRoot });
    await installed.page.getByTestId('file-tree').waitFor({ timeout: 30000 });
    await selectMainDocument(installed.page, 'main.tex');
    const manifest = await buildPaper(installed.page, fixture.secondRoot);
    await showPdf(installed.page); await screenshot(installed.page, output, 'installed-compiled-fixture');
    report = { passed: true, installer, installedBinary, installArguments: ['/S', `/D=${installedDirectory}`], signature, unsignedWarning: signature.Status === 0 || signature.Status === 'Valid' ? 'Valid Authenticode signature observed.' : 'Installer is not verified signed. Silent installation does not exercise or dismiss an interactive SmartScreen/unsigned warning.', runtime: { webview2Version: installed.browser.version(), note: 'Actual installed executable launched with this existing WebView2 runtime. Fresh-machine runtime bootstrap is not inferred.' }, buildId: manifest.buildId };
  } finally {
    await installed?.close();
    const candidates = (await readdir(installedDirectory)).filter(name => /^uninstall.*\.exe$/i.test(name));
    assert(candidates.length === 1, 'Cannot safely clean isolated NSIS registration: expected exactly one own uninstaller.');
    await runExternal(path.join(installedDirectory, candidates[0]), ['/S', `_?=${installedDirectory}`], { output, prefix: 'nsis-uninstall', timeoutMs: 120000 });
  }
  report.cleanup = { passed: true, note: 'Only the isolated installation own uninstaller was run.' };
  await writeJson(path.join(output, 'installer-results.json'), report);
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv); const binary = await requireBinary(args); const run = await createRun(args, 'desktop');
  const fixture = await createSmokeFixtures({ outputDir: run.fixtures });
  if (args.authDataDir) {
    assert(args.mode === 'memory' && typeof args.authDataDir === 'string', '--auth-data-dir is only for a dedicated memory-smoke official login store.');
    const dataDir = path.resolve(args.authDataDir); await mkdir(dataDir, { recursive: true });
    const contents = await readdir(dataDir);
    assert(contents.length === 0 || contents.includes('.texypaper-smoke-auth'), 'Refusing a non-smoke authentication directory; never reuse normal user app data.');
    if (contents.length === 0) await writeFile(path.join(dataDir, '.texypaper-smoke-auth'), 'Dedicated official subscription login store for synthetic smoke only.\n', { flag: 'wx' });
    run.dataDir = dataDir;
  }
  let session;
  try {
    session = await launchDesktop({ binary, ...run, project: fixture.root });
    if (args.mode === 'memory') await memoryWorkload(session, fixture, run.output, args);
    else {
      const report = await desktopScenarios(session, fixture, run.output);
      try {
        await session.page.getByRole('button', { name: '소스', exact: true }).click(); await quickOpen(session.page, fixture.files.unicode);
        const original = await readFile(path.join(fixture.root, fixture.files.unicode));
        await session.page.locator('.cm-content').click(); await session.page.keyboard.press('Control+End'); await session.page.keyboard.insertText(' UnsavedRecoveryMarker');
        const ime = await session.page.context().newCDPSession(session.page); await ime.send('Input.imeSetComposition', { text: '보류', selectionStart: 2, selectionEnd: 2 });
        await delay(1200);
        assert((await readFile(path.join(fixture.root, fixture.files.unicode))).equals(original), 'IME-paused dirty buffer was unexpectedly saved before crash recovery.');
        await session.close(); session = null;
        const recoveryOutput = path.join(run.output, 'recovery-restart'); await mkdir(recoveryOutput);
        session = await launchDesktop({ binary, output: recoveryOutput, dataDir: run.dataDir, project: fixture.root });
        await session.page.getByTestId('file-tree').waitFor(); await quickOpen(session.page, fixture.files.unicode);
        assert((await session.page.locator('.cm-content').innerText()).includes('UnsavedRecoveryMarker'), 'Private recovery journal did not restore real unsaved source after executable restart.');
        await session.page.keyboard.press('Control+s');
        await waitFor(async () => (await readFile(path.join(fixture.root, fixture.files.unicode), 'utf8')).includes('UnsavedRecoveryMarker'), { label: 'restored buffer acknowledged through hash-checked native save' });
        await screenshot(session.page, recoveryOutput, 'restored-dirty-source');
        report.scenarios.push({ name: 'unsaved-buffer-crash-recovery', status: 'passed' });
      } catch (error) { report.scenarios.push({ name: 'unsaved-buffer-crash-recovery', status: 'failed', error: error.stack ?? String(error) }); }
      try { report.scenarios.push({ name: 'custom-palette-validation-and-update-settings', status: 'passed', evidence: await configurePreferenceFixtures(session.page, run) }); }
      catch (error) { report.scenarios.push({ name: 'custom-palette-validation-and-update-settings', status: 'failed', error: error.stack ?? String(error) }); }
      try {
        await settings(session.page, async () => { await session.page.getByTestId('ui-locale').selectOption('en'); await session.page.getByTestId('ui-theme').selectOption('dark'); });
        await waitFor(async () => { const value = JSON.parse(await readFile(path.join(run.dataDir, 'settings.json'), 'utf8')); return value.locale === 'en' && value.theme === 'dark'; }, { label: 'persisted English/night selection on actual disk' });
        await session.close(); session = null;
        const restartOutput = path.join(run.output, 'restart'); await mkdir(restartOutput);
        session = await launchDesktop({ binary, output: restartOutput, dataDir: run.dataDir, project: fixture.root });
        await waitFor(async () => session.page.evaluate(() => document.documentElement.lang === 'en' && document.documentElement.dataset.theme === 'dark'), { label: 'English and night theme restored after real executable restart' });
        await session.page.getByRole('button', { name: 'Source', exact: true }).click();
        await session.page.getByRole('button', { name: 'Comments', exact: true }).click();
        await session.page.locator('#comments-tab').click();
        await session.page.getByText('Synthetic persisted source comment.', { exact: true }).waitFor();
        await session.page.getByText('Synthetic persisted PDF comment.', { exact: true }).waitFor();
        await screenshot(session.page, restartOutput, 'persisted-en-night-comments');
        report.scenarios.push({ name: 'restart-persisted-locale-theme-comments', status: 'passed' });
        report.scenarios.push({ name: 'restart-custom-palettes-update-disabled-and-reset', status: 'passed', evidence: await verifyResetPreferences(session.page, run) });
        report.updateRelease = await exerciseOptionalUpdateFeed(session.page, args, run.output, run.dataDir);
        if (args.updateFeed) {
          await session.close(); session = null;
          const updateRestartOutput = path.join(run.output, 'update-restart'); await mkdir(updateRestartOutput);
          session = await launchDesktop({ binary, output: updateRestartOutput, dataDir: run.dataDir, project: fixture.root });
          await waitFor(async () => (await session.page.getByTestId('update-notice').innerText()).includes(args.updateVersion), { timeoutMs: 30000, label: 'cached actual available release persists at the bottom after executable restart' });
          await screenshot(session.page, updateRestartOutput, 'persisted-update-badge');
          report.scenarios.push({ name: 'real-update-feed-badge-persists-on-restart', status: 'passed' });
        }
      } catch (error) { report.scenarios.push({ name: 'restart-persisted-locale-theme-comments', status: 'failed', error: error.stack ?? String(error) }); }
      await session?.close(); session = null;
      if (args.installer) {
        try { report.scenarios.push({ name: 'installed-executable-compiles-real-fixture', status: 'passed', evidence: await exerciseInstaller({ installer: args.installer, run, fixture }) }); }
        catch (error) { report.scenarios.push({ name: 'installed-executable-compiles-real-fixture', status: 'failed', error: error.stack ?? String(error) }); }
      } else report.installer = { status: 'not-exercised', reason: 'Supply --installer <NSIS.exe> to exercise installation; desktop success does not claim installer acceptance.' };
      report.passed = report.scenarios.every(result => result.status === 'passed');
      report.complete = true; report.completedAt = new Date().toISOString();
      await writeJson(path.join(run.output, 'desktop-results.json'), report);
      assert(report.passed, `${report.scenarios.filter(result => result.status === 'failed').length} required desktop scenarios failed; see desktop-results.json.`);
    }
  } catch (error) { await writeJson(path.join(run.output, 'failure.json'), { passed: false, error: error.stack ?? String(error) }); throw error; }
  finally { await session?.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
