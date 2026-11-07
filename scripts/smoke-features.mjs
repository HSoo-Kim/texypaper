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
    const rows = () => page.locator('.cm-lineNumbers .cm-gutterElement').evaluateAll(elements => elements
      .filter(element => getComputedStyle(element).visibility !== 'hidden')
      .map(element => ({ number: element.querySelector('.cm-wrapped-number')?.firstChild?.textContent ?? null, wrap: element.querySelector('.cm-wrapped-number')?.getAttribute('data-wrap') ?? null }))
      .filter(row => row.number !== null));
    const first = await waitFor(async () => { const value = await rows(); return value.length >= 6 ? value : false; }, { timeoutMs: 15000, label: 'line numbers rendered' });
    assert(first.map(row => row.number).join(',') === '1,2,3,4,5,6', `Every source line keeps its own number: ${JSON.stringify(first)}`);
    const wrapped = first.filter(row => row.wrap);
    assert(wrapped.length === 1 && wrapped[0].number === '4' && wrapped[0].wrap.split('\n').every(mark => mark === '↳'), `Only the wrapped line 4 carries continuation marks: ${JSON.stringify(first)}`);
    const activeNumber = await page.locator('.cm-lineNumbers .cm-activeLineGutter').first().innerText();
    assert(/^\d+$/.test(activeNumber), `A wrapped marker must not leak into the number text: ${JSON.stringify(activeNumber)}`);
    await shot('wrapped-line-numbers');
    // Narrowing the window wraps line 4 into more rows; the marks follow the layout.
    const before = wrapped[0].wrap.split('\n').length;
    await page.setViewportSize({ width: 1100, height: 900 });
    await waitFor(async () => (await rows()).find(row => row.number === '4')?.wrap?.split('\n').length > before, { timeoutMs: 15000, label: 'more continuation marks after narrowing' });
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
    return { rows: first.length, continuationRows: before, gutter };
  });

  await scenario('ask-ai-about-build-error', async () => {
    await selectMainDocument(page, 'broken.tex');
    const status = page.getByTestId('build-status');
    await page.getByRole('button', { name: '빌드', exact: true }).click();
    await waitFor(async () => await status.getAttribute('data-status') === 'failed', { timeoutMs: 120000, label: 'broken document build fails' });
    if (await page.locator('.logs-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('.logs-toggle').click();
    const ask = page.getByTestId('ask-ai-build-error');
    await ask.waitFor({ timeout: 15000 });
    await ask.click();
    const prompt = page.getByTestId('agent-prompt');
    await waitFor(async () => (await prompt.inputValue()).length > 20, { timeoutMs: 15000, label: 'prefilled question' });
    const value = await prompt.inputValue();
    assert(/broken\.tex/.test(value) && /undefined/i.test(value), `The question should name the file and error: ${value}`);
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
    await page.getByTestId('checkpoint-row').first().waitFor({ timeout: 60000 });
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n%% checkpoint-test change\n');
    await page.keyboard.press('Control+S');
    await waitFor(async () => (await read('scratch.tex')).toString('utf8').includes('checkpoint-test change'), { timeoutMs: 30000, label: 'edit saved to disk' });
    await page.getByTestId('checkpoint-compare').first().click();
    await page.getByTestId('checkpoint-diff').or(page.locator('.checkpoint-files')).first().waitFor({ timeout: 60000 });
    await page.locator('.checkpoint-files').getByText('scratch.tex').first().click();
    await page.getByTestId('checkpoint-diff').waitFor({ timeout: 15000 });
    await shot('checkpoint-compare');
    page.once('dialog', dialog => void dialog.accept());
    await page.getByTestId('checkpoint-restore').first().click();
    await waitFor(async () => sha(await read('scratch.tex')) === sha(original), { timeoutMs: 60000, label: 'restore writes the checkpoint text byte-for-byte' });
    assert(await page.getByTestId('checkpoint-row').filter({ hasText: 'Before restore' }).count() >= 1, 'A "Before restore" checkpoint must be created first.');
    await page.getByTestId('checkpoint-undo').click();
    await waitFor(async () => (await read('scratch.tex')).toString('utf8').includes('checkpoint-test change'), { timeoutMs: 60000, label: 'undo brings the edit back' });
    await shot('checkpoint-undo');
    await showFiles(page);
    return { restored: true };
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
      if (id !== 'article-ko') {
        await buildPaper(page, folder);
        created[id] = { built: true };
      } else created[id] = { built: 'not-compiled (kotex may be absent)', files: (await readdir(folder)).sort() };
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
