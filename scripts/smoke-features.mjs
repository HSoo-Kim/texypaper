// Real-executable smoke for the 0.0.5 features: word count and spell check, "ask AI about this build error",
// project-wide replace, paper templates, asset drop/paste import and checkpoints.
// Run against a release build with a hidden window; never uses real user papers (synthetic fixtures only).
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createSmokeFixtures } from './create-smoke-fixtures.mjs';
import { assert, parseArgs, requireBinary, createRun, launchDesktop, waitFor, writeJson } from './smoke-support.mjs';
import { quickOpen, buildPaper } from './smoke-desktop.mjs';
import { selectMainDocument } from './smoke-ssh.mjs';

const args = parseArgs();
const binary = await requireBinary(args);
const run = await createRun(args, 'features');
const fixture = await createSmokeFixtures({ outputDir: run.fixtures, stress: false });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// 1x1 PNG, enough to exercise import, naming, hashing and the includegraphics snippet.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

await writeFile(path.join(fixture.root, 'spell-demo.tex'), '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nThis sentense has a mispeled wrod and \\textbf{anoter} one. Math $x^2+\\alpha$ stays quiet.\n\\end{document}\n');
await writeFile(path.join(fixture.root, 'broken.tex'), '\\documentclass{article}\n\\begin{document}\nHello \\undefinedcommandxyz{world}.\n\\end{document}\n');
await writeFile(path.join(fixture.root, 'scratch.tex'), '\\documentclass{article}\n\\begin{document}\nScratch pad for asset and checkpoint checks.\n\\end{document}\n');
await mkdir(path.join(fixture.root, 'replace-demo'), { recursive: true });
const replaceFiles = {
  'replace-demo/a.tex': 'alpha ALPHA_TOKEN one\nsecond ALPHA_TOKEN line\n',
  'replace-demo/b.tex': 'only ALPHA_TOKEN here\n',
  'replace-demo/crlf.tex': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom ALPHA_TOKEN\r\nkeep CRLF line\r\n')]),
};
for (const [relative, content] of Object.entries(replaceFiles)) await writeFile(path.join(fixture.root, relative), content);
await writeFile(path.join(fixture.root, 'gutter-demo.tex'), 'first line\nsecond line\nthird line');
await mkdir(path.join(fixture.root, 'auto-demo'), { recursive: true });
const autoFiles = { 'auto-demo/one.tex': 'one AUTO_TOKEN\n', 'auto-demo/two.tex': 'two AUTO_TOKEN\n' };
for (const [relative, content] of Object.entries(autoFiles)) await writeFile(path.join(fixture.root, relative), content);
await writeFile(path.join(fixture.root, 'auto-demo/untouched.tex'), 'no token here\n');

const results = [];
let app;
const shot = name => app.page.screenshot({ path: path.join(run.output, `${name}.png`) });
const scenario = async (name, body) => {
  const startedAt = new Date().toISOString();
  try { const evidence = await body(); results.push({ name, status: 'passed', startedAt, evidence }); }
  catch (error) {
    results.push({ name, status: 'failed', startedAt, error: error.stack ?? String(error) });
    await shot(`failure-${name}`).catch(() => {});
    for (let attempt = 0; attempt < 3 && await app.page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').count(); attempt++) await app.page.keyboard.press('Escape');
  }
  await writeJson(path.join(run.output, 'features-results.json'), { complete: false, scenarios: results });
};
const read = relative => readFile(path.join(fixture.root, relative));
const showSearch = async page => { if (!await page.locator('.project-search-panel').isVisible()) await page.getByRole('button', { name: '프로젝트 검색', exact: true }).click(); };
const showFiles = async page => {
  const tree = page.getByTestId('file-tree');
  if (!await tree.isVisible()) await page.getByRole('button', { name: '탐색기 표시', exact: true }).click();
  await tree.waitFor({ state: 'visible', timeout: 15000 });
};

try {
  app = await launchDesktop({ binary, ...run, project: fixture.root });
  const { page } = app;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('file-tree').waitFor({ timeout: 30000 });

  await scenario('word-count-and-spellcheck', async () => {
    await quickOpen(page, 'spell-demo.tex');
    const count = page.getByTestId('word-count');
    await count.waitFor({ timeout: 30000 });
    const words = Number(await count.getAttribute('data-words'));
    assert(words >= 12 && words <= 30, `Word count of the prose should ignore commands and math, got ${words}.`);
    await page.getByTestId('settings-button').click();
    const toggle = page.getByTestId('settings-spellcheck');
    await toggle.waitFor({ timeout: 10000 });
    const available = !await toggle.isDisabled();
    await page.keyboard.press('Escape');
    if (!available) { await shot('spellcheck-unavailable'); return { words, spellcheck: 'unavailable-on-this-machine' }; }
    const errors = page.locator('.cm-spell-error');
    await waitFor(async () => await errors.count() >= 3, { timeoutMs: 30000, label: 'misspelled prose words underlined' });
    const flagged = await errors.allInnerTexts();
    assert(flagged.every(word => !/[\\${}]/.test(word)) && !flagged.some(word => /amsmath|alpha|textbf|begin|document/i.test(word)), `Only prose words may be flagged: ${flagged}`);
    await shot('spellcheck-underlines');
    await errors.first().click();
    await page.keyboard.press('Alt+F8');
    const suggestion = page.getByTestId('spelling-suggestion').first();
    await suggestion.waitFor({ timeout: 15000 });
    const before = await errors.count();
    await suggestion.click();
    await waitFor(async () => await errors.count() < before, { timeoutMs: 15000, label: 'accepted suggestion removes its underline' });
    await page.getByTestId('settings-button').click();
    await toggle.uncheck();
    await page.keyboard.press('Escape');
    await waitFor(async () => await errors.count() === 0, { timeoutMs: 10000, label: 'spell check can be turned off' });
    await page.getByTestId('settings-button').click();
    await toggle.check();
    await page.keyboard.press('Escape');
    return { words, flagged, spellcheck: 'exercised' };
  });

  await scenario('line-numbers-gutter-and-home-button', async () => {
    await quickOpen(page, 'spell-demo.tex');
    // Overleaf rule: one number per source line on its first row; rows a long line wraps onto carry no number and no mark.
    const rows = () => page.locator('.cm-lineNumbers .cm-gutterElement').evaluateAll(elements => elements
      .filter(element => getComputedStyle(element).visibility !== 'hidden')
      .map(element => ({ text: element.textContent?.trim() ?? '', height: element.getBoundingClientRect().height })));
    const first = await waitFor(async () => {
      const value = await rows();
      if (value.length < 6) return false;
      // The heights are estimates until CodeMirror has measured the freshly opened file.
      const single = value[0].height;
      return value.every((row, index) => index === 3 ? row.height / single >= 2.5 : Math.abs(row.height - single) < 1) ? value : false;
    }, { timeoutMs: 20000, label: 'line numbers rendered with measured heights' });
    assert(first.map(row => row.text).join(',') === '1,2,3,4,5,6', `Every source line keeps its own number and nothing else is drawn: ${JSON.stringify(first)}`);
    const single = first[0].height, spans = first[3].height / single;
    await shot('wrapped-line-numbers');
    // Narrowing the window wraps line 4 into more rows; its single number stays.
    await page.setViewportSize({ width: 1100, height: 900 });
    await waitFor(async () => { const value = await rows(); return value[3]?.text === '4' && value[3].height / single > spans + 0.5; }, { timeoutMs: 15000, label: 'line 4 spans more rows after narrowing' });
    assert((await rows()).map(row => row.text).join(',') === '1,2,3,4,5,6', 'Narrowing must not add numbers or marks');
    await page.setViewportSize({ width: 1440, height: 900 });
    const gutter = await page.locator('.cm-gutters').evaluate(element => {
      const style = getComputedStyle(element), editor = getComputedStyle(element.closest('.cm-editor'));
      return { gutter: style.backgroundColor, editor: editor.backgroundColor, divider: style.borderRightWidth };
    });
    assert(gutter.gutter !== gutter.editor && parseFloat(gutter.divider) > 0, `The number column needs its own background and a divider: ${JSON.stringify(gutter)}`);
    const home = page.getByTestId('home-button');
    await page.mouse.move(700, 450);
    const border = () => home.evaluate(element => getComputedStyle(element).borderTopColor);
    await waitFor(async () => /rgba\(0, 0, 0, 0\)|transparent/.test(await border()), { timeoutMs: 5000, label: 'Home button has no border at rest' });
    await home.hover();
    await waitFor(async () => !/rgba\(0, 0, 0, 0\)|transparent/.test(await border()), { timeoutMs: 5000, label: 'Home button shows its border on hover' });
    await shot('home-button-hover');
    await page.mouse.move(700, 450);
    return { rows: first.length, line4Rows: Math.round(spans), gutter };
  });

  await scenario('line-number-click-and-drag-select-whole-lines', async () => {
    await quickOpen(page, 'gutter-demo.tex');
    const number = value => page.locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: new RegExp(`^${value}$`) }).first();
    const text = () => page.locator('.cm-content').evaluate(element => [...element.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'));
    await waitFor(async () => (await text()) === 'first line\nsecond line\nthird line', { timeoutMs: 15000, label: 'gutter fixture shown' });
    const typeAndUndo = async insert => { await page.keyboard.insertText(insert); const after = await text(); await page.keyboard.press('Control+Z'); await waitFor(async () => (await text()) === 'first line\nsecond line\nthird line', { timeoutMs: 10000, label: 'undo restores the fixture' }); return after; };
    // Click: the whole line 2 including its line break (Overleaf behavior).
    await number(2).click();
    const clicked = await typeAndUndo('X');
    assert(clicked === 'first line\nXthird line', `Clicking number 2 must select the whole line with its line break: ${JSON.stringify(clicked)}`);
    // Drag upwards from 3 to 1: every line in between, in reverse direction.
    const from = await number(3).boundingBox(), to = await number(1).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
    await new Promise(resolve => setTimeout(resolve, 150));
    await page.mouse.up();
    const dragged = await typeAndUndo('Y');
    assert(dragged === 'Y', `Dragging from 3 to 1 must select all three lines: ${JSON.stringify(dragged)}`);
    // The last line has no line break; the selection is clamped to the document end.
    await number(3).click();
    const last = await typeAndUndo('Z');
    assert(last === 'first line\nsecond line\nZ', `Clicking the last number must select only that line: ${JSON.stringify(last)}`);
    return { clicked, dragged, last };
  });

  await scenario('ask-ai-about-build-error', async () => {
    await selectMainDocument(page, 'broken.tex');
    const status = page.getByTestId('build-status');
    await page.getByRole('button', { name: '빌드', exact: true }).click();
    await waitFor(async () => await status.getAttribute('data-status') === 'failed', { timeoutMs: 120000, label: 'broken document build fails' });
    if (await page.locator('.logs-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('.logs-toggle').click();
    // One document error; the TeX Live wrapper's "command failed" line is not a second diagnostic.
    const badge = (await page.locator('.logs-toggle .diagnostic-count').innerText()).trim();
    assert(badge === '1', `The log badge must count only the document error, got ${badge}`);
    const ask = page.getByTestId('ask-ai-build-error');
    await ask.waitFor({ timeout: 15000 });
    await ask.click();
    const prompt = page.getByTestId('agent-prompt');
    await waitFor(async () => (await prompt.inputValue()).length > 20, { timeoutMs: 15000, label: 'prefilled question' });
    const value = await prompt.inputValue();
    assert(/broken\.tex/.test(value) && /undefined/i.test(value) && /BUILD_FAILED/.test(value), `The question should name the file, the error and the build failure: ${value}`);
    assert(!/\?:|runscript\.tlu|command failed with exit code/i.test(value), `The question must not carry wrapper noise: ${value}`);
    const chip = page.getByTestId('agent-attachment').first();
    await chip.waitFor({ timeout: 10000 });
    assert((await chip.getAttribute('data-kind')) === 'source' && /broken\.tex/.test(await chip.innerText()), 'The source around the error is attached as a chip.');
    assert(await page.getByTestId('agent-status').getAttribute('data-status') === 'idle', 'Nothing may be sent automatically.');
    await shot('ask-ai-error');
    await page.getByTestId('agent-attachment-remove').first().click();
    await prompt.fill('');
    await selectMainDocument(page, 'main.tex');
    return { prompt: value.slice(0, 160) };
  });

  await scenario('project-replace-preview-apply-undo', async () => {
    await showSearch(page);
    const search = page.locator('.project-search-panel input[type="search"]');
    await search.fill('ALPHA_TOKEN');
    await search.press('Enter');
    await page.getByTestId('replace-toggle').click();
    await page.getByTestId('replace-input').fill('BETA_TOKEN');
    await page.getByTestId('replace-match-case').check();
    await page.getByTestId('replace-preview').click();
    const review = page.getByTestId('replace-review');
    await review.waitFor({ timeout: 30000 });
    await waitFor(async () => /4/.test(await review.innerText()) && /3/.test(await review.innerText()), { timeoutMs: 30000, label: '4 matches in 3 files previewed' });
    await shot('replace-preview');
    const original = Object.fromEntries(await Promise.all(Object.keys(replaceFiles).map(async relative => [relative, await read(relative)])));
    await page.getByTestId('replace-apply').click();
    await page.getByTestId('replace-undo').waitFor({ timeout: 60000 });
    for (const relative of Object.keys(replaceFiles)) {
      const bytes = await read(relative), text = bytes.toString('utf8');
      assert(text.includes('BETA_TOKEN') && !text.includes('ALPHA_TOKEN'), `${relative} was not replaced`);
    }
    const bom = await read('replace-demo/crlf.tex');
    assert(bom[0] === 0xef && bom[1] === 0xbb && bom[2] === 0xbf && bom.toString('utf8').includes('\r\n') && !bom.toString('utf8').replace(/\r\n/g, '').includes('\n'), 'BOM and CRLF must survive the replacement byte-for-byte.');
    await page.getByTestId('replace-undo').click();
    await waitFor(async () => { for (const [relative, bytes] of Object.entries(original)) if (sha(await read(relative)) !== sha(bytes)) return false; return true; }, { timeoutMs: 60000, label: 'undo restores every file byte-for-byte' });
    // More than 16 files must be refused without touching anything.
    await search.fill('TexyPaper');
    await page.getByTestId('replace-input').fill('X');
    await page.getByTestId('replace-preview').click();
    await waitFor(async () => /16/.test(await page.getByTestId('replace-review').innerText()) && await page.getByTestId('replace-apply').isDisabled(), { timeoutMs: 60000, label: 'over-limit replace is refused' });
    await shot('replace-limit');
    await page.getByRole('button', { name: '검색 패널 닫기', exact: true }).click();
    return { files: Object.keys(replaceFiles).length };
  });

  await scenario('asset-drop-and-paste', async () => {
    const dropFiles = () => readdir(path.join(fixture.root, 'figures'));
    const before = new Set(await dropFiles());
    await showFiles(page);
    await page.evaluate(base64 => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'Drop Figure 1.png', { type: 'image/png' }));
      const row = document.querySelector('[role="treeitem"][data-path="figures"]') ?? document.querySelector('[data-testid="file-tree"]');
      for (const type of ['dragenter', 'dragover', 'drop']) row.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, PNG.toString('base64'));
    await page.getByTestId('asset-import-status').waitFor({ timeout: 30000 });
    const dropped = await waitFor(async () => (await dropFiles()).find(name => !before.has(name) && /\.png$/i.test(name)), { timeoutMs: 30000, label: 'dropped image written to figures/' });
    assert(sha(await read(`figures/${dropped}`)) === sha(PNG), 'Dropped image must be byte-identical.');
    await shot('asset-drop');
    await quickOpen(page, 'scratch.tex');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.evaluate(base64 => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, PNG.toString('base64'));
    await waitFor(async () => /\\includegraphics/.test(await page.locator('.cm-content').innerText()), { timeoutMs: 30000, label: 'paste inserts the figure snippet' });
    const after = await dropFiles();
    const pasted = after.find(name => !before.has(name) && name !== dropped && /^pasted-image-.*\.png$/.test(name));
    assert(pasted && sha(await read(`figures/${pasted}`)) === sha(PNG), 'Pasted image must be stored byte-identically.');
    await shot('asset-paste');
    await page.keyboard.press('Control+Z');
    return { dropped, pasted };
  });

  await scenario('checkpoints-create-compare-restore-undo', async () => {
    await quickOpen(page, 'scratch.tex');
    const original = await read('scratch.tex');
    await page.getByRole('button', { name: '체크포인트', exact: true }).click();
    await page.getByTestId('checkpoint-create').click();
    await page.locator('[data-testid="checkpoint-row"][data-checkpoint-kind="manual"]').first().waitFor({ timeout: 60000 });
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n%% checkpoint-test change\n');
    await page.keyboard.press('Control+S');
    await waitFor(async () => (await read('scratch.tex')).toString('utf8').includes('checkpoint-test change'), { timeoutMs: 30000, label: 'edit saved to disk' });
    // Compare the manual checkpoint created above; automatic ones from earlier replace runs are listed too.
    await page.locator('[data-testid="checkpoint-row"][data-checkpoint-kind="manual"]').first().getByTestId('checkpoint-compare').click();
    await page.getByTestId('checkpoint-diff').or(page.locator('.checkpoint-files')).first().waitFor({ timeout: 60000 });
    await page.locator('.checkpoint-files').getByText('scratch.tex').first().click();
    await page.getByTestId('checkpoint-diff').waitFor({ timeout: 15000 });
    await shot('checkpoint-compare');
    page.once('dialog', dialog => void dialog.accept());
    await page.getByTestId('checkpoint-restore').first().click();
    await waitFor(async () => sha(await read('scratch.tex')) === sha(original), { timeoutMs: 60000, label: 'restore writes the checkpoint text byte-for-byte' });
    // The file is written before the panel reloads its list, so wait for the backup row rather than counting once.
    await waitFor(async () => await page.getByTestId('checkpoint-row').filter({ hasText: /Before restore|복원 전/ }).count() >= 1, { timeoutMs: 15000, label: 'a "Before restore" checkpoint listed after restoring' });
    await page.getByTestId('checkpoint-undo').click();
    await waitFor(async () => (await read('scratch.tex')).toString('utf8').includes('checkpoint-test change'), { timeoutMs: 60000, label: 'undo brings the edit back' });
    await shot('checkpoint-undo');
    await showFiles(page);
    return { restored: true };
  });

  await scenario('automatic-checkpoint-before-replace-restore-undo', async () => {
    await showSearch(page);
    const search = page.locator('.project-search-panel input[type="search"]');
    await search.fill('AUTO_TOKEN');
    await search.press('Enter');
    if (!await page.getByTestId('replace-input').isVisible()) await page.getByTestId('replace-toggle').click();
    await page.getByTestId('replace-input').fill('DONE_TOKEN');
    await page.getByTestId('replace-match-case').check();
    await page.getByTestId('replace-preview').click();
    await waitFor(async () => /2/.test(await page.getByTestId('replace-review').innerText().catch(() => '')), { timeoutMs: 30000, label: '2 matches previewed' });
    await page.getByTestId('replace-apply').click();
    await page.getByTestId('replace-undo').waitFor({ timeout: 60000 });
    for (const relative of Object.keys(autoFiles)) assert((await read(relative)).toString('utf8').includes('DONE_TOKEN'), `${relative} was not replaced`);
    await page.getByRole('button', { name: '검색 패널 닫기', exact: true }).click();
    await page.getByRole('button', { name: '체크포인트', exact: true }).click();
    await page.getByTestId('checkpoint-filter').selectOption('auto');
    const row = page.locator('[data-testid="checkpoint-row"][data-checkpoint-kind="auto"]').filter({ hasText: /프로젝트 바꾸기 전|before replace/ }).first();
    await row.waitFor({ timeout: 60000 });
    await row.getByTestId('checkpoint-compare').click();
    await page.getByTestId('checkpoint-comparison').waitFor({ timeout: 60000 });
    const listed = await page.locator('.checkpoint-files li').allInnerTexts();
    assert(listed.length === 2 && listed.every(item => /auto-demo\/(one|two)\.tex/.test(item)), `Only the two replaced files belong to the automatic checkpoint: ${JSON.stringify(listed)}`);
    await shot('automatic-checkpoint-compare');
    page.once('dialog', dialog => void dialog.accept());
    await page.getByTestId('checkpoint-restore').first().click();
    await waitFor(async () => { for (const [relative, text] of Object.entries(autoFiles)) if ((await read(relative)).toString('utf8') !== text) return false; return true; }, { timeoutMs: 60000, label: 'restoring the automatic checkpoint brings back the pre-replace text' });
    assert((await read('auto-demo/untouched.tex')).toString('utf8') === 'no token here\n', 'Files outside the automatic checkpoint must stay unchanged.');
    assert(await page.locator('[data-testid="checkpoint-row"][data-checkpoint-kind="auto"]').filter({ hasText: /Before restore|복원 전/ }).count() >= 1, 'Restoring must first create an automatic "Before restore" checkpoint.');
    await page.getByTestId('checkpoint-undo').click();
    await waitFor(async () => { for (const relative of Object.keys(autoFiles)) if (!(await read(relative)).toString('utf8').includes('DONE_TOKEN')) return false; return true; }, { timeoutMs: 60000, label: 'undo brings the replaced text back' });
    await page.getByTestId('checkpoint-filter').selectOption('manual');
    assert(await page.locator('[data-testid="checkpoint-row"][data-checkpoint-kind="manual"]').count() >= 1, 'Automatic checkpoints must not evict the manual one.');
    await page.getByTestId('checkpoint-filter').selectOption('all');
    await showFiles(page);
    return { listed };
  });

  await scenario('ai-transmission-record-shows-pending-attachment', async () => {
    await quickOpen(page, 'scratch.tex');
    await page.locator('.cm-lineNumbers .cm-gutterElement').filter({ hasText: /^3$/ }).first().click();
    await page.keyboard.press('Control+L');
    await page.getByTestId('agent-attachment').first().waitFor({ timeout: 15000 });
    const record = page.getByTestId('agent-transmissions');
    if (!await record.isVisible()) await page.getByRole('button', { name: 'AI 도우미', exact: true }).click();
    await record.waitFor({ timeout: 15000 });
    if (!await record.evaluate(element => element.open)) await record.locator('summary').click();
    const pending = page.getByTestId('agent-transmission-pending');
    await waitFor(async () => await pending.count() === 1, { timeoutMs: 10000, label: 'one pending attachment listed' });
    const pendingText = await pending.first().innerText();
    assert(/scratch\.tex/.test(pendingText) && /3/.test(pendingText), `The pending row must name the attached file and line: ${pendingText}`);
    assert(await page.getByTestId('agent-transmission-row').count() === 0, 'Nothing may be listed as sent without a provider handoff.');
    await shot('ai-transmission-pending');
    await page.getByTestId('agent-attachment-remove').first().click();
    await waitFor(async () => await pending.count() === 0, { timeoutMs: 10000, label: 'removed attachment leaves the pending list' });
    return { pendingText };
  });

  await scenario('paper-templates-create-and-compile', async () => {
    const created = {};
    for (const id of ['article', 'report', 'beamer', 'article-ko']) {
      const folder = path.join(run.output, 'templates', id);
      await mkdir(folder, { recursive: true });
      // Switching projects stops running work only after an explicit confirmation; wait for any autosave build instead.
      await waitFor(async () => !['running', 'queued', 'building', 'cancelling'].includes(await page.getByTestId('build-status').getAttribute('data-status')), { timeoutMs: 150000, label: 'no build is running before switching project' });
      if (await page.getByTestId('workspace-identity').count() && !await page.getByTestId('dashboard-template').isVisible()) await page.getByTestId('home-button').click();
      await page.getByTestId('dashboard-template').waitFor({ timeout: 30000 });
      if (await page.getByTestId('dashboard-template').getAttribute('aria-expanded') !== 'true') await page.getByTestId('dashboard-template').click();
      await page.getByTestId('template-path').fill(folder);
      await page.getByTestId(`template-choice-${id}`).check();
      await page.getByTestId('template-create').click();
      await waitFor(async () => (await readdir(folder).catch(() => [])).includes('main.tex'), { timeoutMs: 60000, label: `${id} template files written` });
      await page.getByTestId('file-tree').waitFor({ timeout: 60000 });
      await waitFor(async () => (await page.getByRole('tab', { name: /main\.tex/ }).count()) > 0, { timeoutMs: 60000, label: `${id} main.tex opened` });
      await buildPaper(page, folder);
      created[id] = { built: true };
      await shot(`template-${id}`);
      const project = JSON.parse(await readFile(path.join(folder, '.texypaper', 'project.json'), 'utf8'));
      assert(project.rootTex === 'main.tex' && project.engine === (id === 'article-ko' ? 'xelatex' : 'pdflatex'), `${id} must record its main document and engine: ${JSON.stringify(project)}`);
    }
    // A second creation in the same folder must refuse and write nothing new.
    const folder = path.join(run.output, 'templates', 'article');
    const filesBefore = (await readdir(folder)).sort();
    await page.getByTestId('home-button').click();
    await page.getByTestId('dashboard-template').waitFor({ timeout: 30000 });
    if (await page.getByTestId('dashboard-template').getAttribute('aria-expanded') !== 'true') await page.getByTestId('dashboard-template').click();
    await page.getByTestId('template-path').fill(folder);
    await page.getByTestId('template-choice-article').check();
    await page.getByTestId('template-create').click();
    await page.locator('[role="alert"]').filter({ hasText: /TEMPLATE_CONFLICT|already|이미/ }).first().waitFor({ timeout: 30000 });
    assert(JSON.stringify((await readdir(folder)).sort()) === JSON.stringify(filesBefore), 'A conflicting template creation must write nothing.');
    return created;
  });

  const failed = results.filter(row => row.status !== 'passed');
  await writeJson(path.join(run.output, 'features-results.json'), { complete: true, passed: failed.length === 0, scenarios: results });
  assert(!failed.length, `${failed.length} required feature scenarios failed: ${failed.map(row => row.name).join(', ')}`);
} finally {
  await app?.close?.().catch(() => {});
}
