// Real-executable smoke for Home navigation, pane resizing/zoom, Overleaf-compatible shortcuts, source<->PDF
// navigation, explicit AI attachments, outline numbering, paper folder badges and the shortcut help.
// Run against a release build with a hidden window; never uses real user papers (synthetic fixtures only).
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createSmokeFixtures } from './create-smoke-fixtures.mjs';
import { assert, parseArgs, requireBinary, createRun, launchDesktop, waitFor, writeJson } from './smoke-support.mjs';
import { quickOpen, buildPaper, showPdf, selectPdfText } from './smoke-desktop.mjs';

const args = parseArgs();
const binary = await requireBinary(args);
const run = await createRun(args, 'usability');
const fixture = await createSmokeFixtures({ outputDir: run.fixtures, stress: false });
await writeFile(path.join(fixture.root, 'scratch.tex'), '\\section{Alpha}\nfirst line\nsecond line\nthird line\n\\begin{itemize}\n\\item one\n\\end{itemize}\n');
await writeFile(path.join(fixture.root, 'outline-demo.tex'), '\\section{Intro}\n\\subsection{Scope}\n\\subsubsection{Detail}\n\\section*{Unnumbered}\n\\section{Method}\n\\subsection{Setup}\n');

const results = [];
let app;
const shot = (name) => app.page.screenshot({ path: path.join(run.output, `${name}.png`) });
const scenario = async (name, body) => {
  const startedAt = new Date().toISOString();
  try { const evidence = await body(); results.push({ name, status: 'passed', startedAt, evidence }); }
  catch (error) {
    results.push({ name, status: 'failed', startedAt, error: error.stack ?? String(error) });
    await shot(`failure-${name}`).catch(() => {});
    for (let attempt = 0; attempt < 3 && await app.page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible, .context-menu:visible').count(); attempt++) await app.page.keyboard.press('Escape');
  }
  await writeJson(path.join(run.output, 'usability-results.json'), { complete: false, scenarios: results });
};
const text = (page) => page.locator('.cm-content').innerText();
const number = async (locator, attribute) => Number(await locator.getAttribute(attribute));
const wheelZoom = async (page, locator, deltaY) => {
  await locator.hover();
  await page.keyboard.down('Control'); await page.mouse.wheel(0, deltaY); await page.keyboard.up('Control');
};
const rootFontSize = (page) => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);

try {
  app = await launchDesktop({ binary, ...run, project: fixture.root });
  const { page } = app;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('file-tree').waitFor({ timeout: 30000 });

  await scenario('paper-folder-badges-before-expanding', async () => {
    const direct = page.getByRole('treeitem', { name: /^paper-direct(?:,|$)/ });
    await direct.locator('.paper-badge').waitFor({ timeout: 30000 });
    const ancestor = page.getByRole('treeitem', { name: /^ancestor(?:,|$)/ });
    await ancestor.locator('.paper-badge-descendant').waitFor({ timeout: 90000 });
    assert(await page.getByRole('treeitem', { name: /^pdf-only(?:,|$)/ }).locator('.paper-badge').count() === 0, 'A PDF-only folder must not be marked as a paper folder.');
    await shot('explorer-paper-badges');
    return { direct: true, descendant: true };
  });

  await scenario('explorer-file-and-folder-icons', async () => {
    const tree = page.getByTestId('file-tree');
    await page.getByRole('treeitem', { name: /^sections(?:,|$)/ }).click();
    await tree.locator('[data-icon="file-tex"]').first().waitFor({ state: 'visible', timeout: 15000 });
    const icons = await tree.locator('[data-icon]').evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('data-icon')))]);
    assert(icons.some(id => id.startsWith('folder')) && icons.includes('file-tex') && icons.some(id => id === 'file-bib' || id === 'file-latex-package'), `Expected folder and TeX/bib icons, found ${icons}`);
    const ids = await page.locator('svg[id]').evaluateAll(nodes => nodes.map(node => node.id));
    const duplicate = await page.evaluate(() => { const seen = new Set(); for (const node of document.querySelectorAll('[id]')) { if (seen.has(node.id)) return node.id; seen.add(node.id); } return null; });
    assert(duplicate === null, `Duplicate DOM id from repeated icons: ${duplicate}`);
    await quickOpen(page, 'sections/page-01.tex');
    assert(await page.locator('.file-tabs [role="tab"] [data-icon]').count() > 0, 'Open file tabs need a file icon.');
    for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(250); await shot(`explorer-icons-${scheme}`); }
    await page.emulateMedia({ colorScheme: 'light' });
    return { icons, svgIds: ids.length };
  });

  await scenario('outline-numbers-and-indentation', async () => {
    await quickOpen(page, 'outline-demo.tex');
    const items = page.locator('.file-outline .outline-item');
    await waitFor(async () => await items.count() === 6, { label: 'outline headings parsed' });
    const numbers = await page.locator('.file-outline .outline-item').evaluateAll(nodes => nodes.map(node => node.querySelector('.outline-number')?.textContent?.trim() ?? ''));
    assert(JSON.stringify(numbers) === JSON.stringify(['1', '1.1', '1.1.1', '', '2', '2.1']), `Unexpected outline numbers: ${numbers}`);
    const indents = await items.evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).paddingLeft)));
    assert(indents[0] < indents[1] && indents[1] < indents[2], `Outline levels must indent progressively: ${indents}`);
    await items.nth(4).click();
    await waitFor(async () => Number(await page.locator('.cm-lineNumbers .cm-activeLineGutter').innerText()) === 5, { label: 'outline click navigates to its source line' });
    return { numbers, indents };
  });

  await scenario('latex-commands-are-green-in-light-and-dark', async () => {
    await quickOpen(page, 'scratch.tex');
    const colors = {};
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await waitFor(() => page.evaluate(expected => document.documentElement.dataset.theme === expected, scheme), { label: `${scheme} theme applied` });
      colors[scheme] = await page.locator('.source-editor .tok-typeName').first().evaluate(node => getComputedStyle(node).color);
      const [r, g, b] = colors[scheme].match(/\d+/g).map(Number);
      assert(g > r + 20 && g > b + 20, `LaTeX commands are not green in ${scheme}: ${colors[scheme]}`);
    }
    await shot('latex-command-green-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    return colors;
  });

  await scenario('overleaf-editing-shortcuts', async () => {
    await quickOpen(page, 'scratch.tex');
    const editor = page.locator('.cm-content');
    const line = (needle) => page.locator('.cm-line').filter({ hasText: needle }).first();
    await line('second line').click();
    await page.keyboard.press('Control+d');
    let now = await text(page);
    assert(!now.includes('second line') && now.includes('first line') && now.includes('third line'), 'Ctrl+D must delete exactly the current line.');
    await page.keyboard.press('Control+z');
    assert((await text(page)).includes('second line'), 'Undo did not restore the deleted line.');
    await line('first line').click();
    await page.keyboard.press('Control+/');
    assert((await line('first line').innerText()).startsWith('%'), 'Ctrl+/ must comment the line with %.');
    await page.keyboard.press('Control+/');
    assert(!(await line('first line').innerText()).startsWith('%'), 'Ctrl+/ must toggle the comment off again.');
    await line('third line').dblclick();
    await page.keyboard.press('Control+b');
    assert((await text(page)).includes('\\textbf{third}') || (await text(page)).includes('\\textbf{line}'), 'Ctrl+B must wrap the selection in \\textbf.');
    await page.keyboard.press('Control+z');
    await page.evaluate(() => { window.__compileRequests = 0; window.addEventListener('texypaper:compile-requested', () => { window.__compileRequests++; }); });
    const before = await text(page);
    await editor.click(); await page.keyboard.press('Control+Enter');
    await waitFor(async () => (await page.evaluate(() => window.__compileRequests)) >= 1, { label: 'Ctrl+Enter requests compilation' });
    assert(await text(page) === before, 'Ctrl+Enter must not insert a blank line.');
    await page.keyboard.press('Control+Shift+l');
    await page.locator('.cm-panel input').first().waitFor({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await line('first line').click();
    await line('third line').click({ modifiers: ['Control'] });
    await page.keyboard.type('Q');
    assert(((await text(page)).match(/Q/g) ?? []).length >= 2, 'Ctrl+click must add a second cursor.');
    await page.keyboard.press('Control+z');
    assert(await page.locator('.cm-foldGutter').count() > 0, 'The fold gutter is missing.');
    await page.keyboard.press('Control+s');
    return { deleteLine: true, comment: true, bold: true, compile: true, gotoLine: true, multiCursor: true, folding: true };
  });

  await scenario('home-round-trip-preserves-work', async () => {
    await quickOpen(page, 'scratch.tex');
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+Home'); await page.keyboard.type('HomeDraftMarker ');
    const epoch = await page.getByTestId('workspace-identity').getAttribute('data-epoch');
    await page.getByTestId('home-button').click();
    await page.getByTestId('project-home').waitFor({ state: 'visible' });
    assert(await page.getByTestId('workspace-resume').isVisible(), 'Home needs a visible way back to the open project.');
    await shot('home-with-current-project');
    await page.getByTestId('workspace-resume').click();
    await page.locator('.cm-content').waitFor({ state: 'visible' });
    assert((await text(page)).includes('HomeDraftMarker'), 'Visiting Home lost the unsaved draft.');
    assert(await page.getByTestId('workspace-identity').getAttribute('data-epoch') === epoch, 'Visiting Home must not reopen the workspace.');
    await page.keyboard.press('Control+z');
    return { epoch };
  });

  await scenario('home-switches-projects-and-returns', async () => {
    await page.getByTestId('home-button').click();
    await page.getByTestId('workspace-disclose').click();
    await page.getByTestId('workspace-path').fill(fixture.secondRoot);
    await page.getByTestId('workspace-open').click();
    // Switching asks about running work first (a compile started by Ctrl+Enter earlier; stopping it can take a few seconds), then unsaved edits.
    const openedRoot = async () => (await page.locator('[data-testid="workspace-identity"]').getAttribute('data-root', { timeout: 500 }).catch(() => null))?.replaceAll('\\', '/').toLowerCase() ?? '';
    await waitFor(async () => {
      const guard = page.getByRole('alertdialog');
      if (await guard.isVisible().catch(() => false)) {
        await shot(`home-guard-${Date.now()}`);
        await guard.getByRole('button', { name: /중지하고 계속|Stop and continue|모두 저장|Save all/ }).first().click({ timeout: 2000 }).catch(() => {});
      }
      return (await openedRoot()).endsWith('second isolated project');
    }, { timeoutMs: 90000, intervalMs: 400, label: 'second project opened from Home after guard dialogs' });
    await page.getByTestId('home-button').click();
    await page.locator('[data-testid="project-home"] .recent-projects-table button', { hasText: 'paper fixture with spaces' }).first().click();
    await waitFor(async () => (await page.getByTestId('workspace-identity').getAttribute('data-root')).replaceAll('\\', '/').toLowerCase().endsWith('paper fixture with spaces'), { label: 'first project reopened from Home recents' });
    await page.getByTestId('file-tree').waitFor({ state: 'visible', timeout: 30000 });
    return { switched: true };
  });

  await scenario('pane-divider-resize-collapse-restore', async () => {
    const divider = page.getByTestId('source-pdf-divider');
    const start = await number(divider, 'aria-valuenow');
    await divider.focus(); await page.keyboard.press('ArrowRight');
    const afterKey = await number(divider, 'aria-valuenow');
    assert(afterKey > start, 'Keyboard resize did not widen the source pane.');
    const box = await divider.boundingBox();
    // The collapse arrows sit at the divider's midpoint; grab it near the top like a user would.
    const grabY = box.y + box.height * 0.2;
    await page.mouse.move(box.x + box.width / 2, grabY); await page.mouse.down();
    await page.mouse.move(box.x - 140, grabY, { steps: 8 }); await page.mouse.up();
    const dragged = await number(divider, 'aria-valuenow');
    assert(dragged < afterKey - 3, `Dragging left must shrink the source pane (${dragged} vs ${afterKey}).`);
    await shot('divider-resized');
    await page.getByRole('button', { name: /^(PDF 접기|Collapse PDF)$/ }).click();
    await page.getByTestId('restore-pdf').waitFor({ state: 'visible' });
    await page.getByTestId('restore-pdf').click();
    await divider.waitFor({ state: 'visible' });
    assert(Math.abs(await number(divider, 'aria-valuenow') - dragged) < 1, 'Restoring the PDF pane must return to the previous ratio.');
    return { start, dragged };
  });

  let manifest;
  await scenario('build-then-pane-zoom-is-independent', async () => {
    await quickOpen(page, 'main.tex');
    manifest = await buildPaper(page, fixture.root);
    await showPdf(page);
    await page.getByRole('button', { name: '분할', exact: true }).click();
    const frame = page.locator('.source-editor-frame'), preview = page.locator('.pdf-preview');
    // Fit-width scale settles asynchronously after the layout change; wait until it is stable before comparing.
    let last = -1; await waitFor(async () => { const now = await number(preview, 'data-scale'); const stable = now === last; last = now; return stable; }, { label: 'PDF scale settled' });
    const fontBefore = await number(frame, 'data-font-size'), scaleBefore = await number(preview, 'data-scale'), rootBefore = await rootFontSize(page);
    await wheelZoom(page, page.locator('.cm-content'), -240);
    await waitFor(async () => await number(frame, 'data-font-size') > fontBefore, { label: 'Ctrl+wheel enlarges the source text' });
    assert(await number(preview, 'data-scale') === scaleBefore, 'Source zoom changed the PDF scale.');
    await wheelZoom(page, page.locator('.pdf-scroll'), -240);
    await waitFor(async () => await number(preview, 'data-scale') > scaleBefore, { label: 'Ctrl+wheel enlarges the PDF' });
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+-');
    await waitFor(async () => await number(frame, 'data-font-size') === fontBefore, { label: 'Ctrl+minus shrinks the focused source' });
    assert(await rootFontSize(page) === rootBefore, 'Pane zoom must never scale the whole UI.');
    assert(await page.evaluate(() => window.visualViewport?.scale ?? 1) === 1, 'The WebView page zoom changed.');
    return { fontBefore, scaleBefore };
  });

  await scenario('ai-chat-zoom', async () => {
    if (!await page.locator('.agent-panel').isVisible()) await page.getByRole('button', { name: /^(AI 및 댓글 패널|AI and comments panel)$/ }).click();
    const panel = page.locator('.agent-panel');
    await panel.waitFor({ state: 'visible' });
    const before = await number(panel, 'data-chat-font-size'), rootBefore = await rootFontSize(page);
    await wheelZoom(page, page.locator('.agent-history'), -240);
    await waitFor(async () => await number(panel, 'data-chat-font-size') > before, { label: 'Ctrl+wheel enlarges the chat text' });
    await page.locator('.agent-history').focus(); await page.keyboard.press('Control+-');
    await waitFor(async () => await number(panel, 'data-chat-font-size') === before, { label: 'Ctrl+minus shrinks the chat text' });
    assert(await rootFontSize(page) === rootBefore, 'Chat zoom changed the whole UI.');
    return { before };
  });

  await scenario('source-to-pdf-highlight-and-pdf-ctrl-click-to-source', async () => {
    await quickOpen(page, 'sections/page-02.tex');
    await page.locator('.cm-content').click(); await page.keyboard.press('Control+Home');
    for (let step = 0; step < 2; step++) await page.keyboard.press('ArrowDown');
    const sync = page.getByTestId('sync-status'), before = await sync.getAttribute('data-sequence');
    await page.keyboard.press('Control+Alt+j');
    await waitFor(async () => await sync.getAttribute('data-direction') === 'forward' && await sync.getAttribute('data-sequence') !== before, { label: 'Ctrl+Alt+J source to PDF' });
    await page.locator('.pdf-page-slot[data-page="2"] .pdf-sync-marker').waitFor({ state: 'visible', timeout: 30000 });
    await shot('source-to-pdf-marker');
    // The marker only points at the spot; it must remove itself shortly afterwards.
    await page.locator('.pdf-sync-marker').waitFor({ state: 'detached', timeout: 10000 });
    await page.getByRole('button', { name: 'PDF', exact: true }).click();
    await page.locator('.pdf-scroll').evaluate(node => { node.scrollTop = 0; });
    const span = page.locator('.textLayer[data-ready="true"] span').filter({ hasText: 'TexyPaper page 1' }).first();
    await span.waitFor({ state: 'visible', timeout: 30000 });
    const inverseBefore = await sync.getAttribute('data-sequence');
    await span.click({ modifiers: ['Control'] });
    await waitFor(async () => await sync.getAttribute('data-direction') === 'inverse' && await sync.getAttribute('data-sequence') !== inverseBefore, { label: 'PDF Ctrl+click to source' });
    await waitFor(async () => await page.getByTestId('source-editor').getAttribute('data-path') === 'sections/page-01.tex', { label: 'inverse navigation opened the page-1 source' });
    await waitFor(async () => { const line = Number(await page.locator('.cm-lineNumbers .cm-activeLineGutter').innerText()); return line === 3 || line === 4; }, { label: 'cursor landed on the clicked prose line' });
    return { forwardPage: 2, inversePath: 'sections/page-01.tex' };
  });

  await scenario('explicit-ai-attachments-from-menu-shortcut-and-pdf', async () => {
    await quickOpen(page, 'scratch.tex');
    const chips = page.getByTestId('agent-attachment');
    const before = await chips.count();
    await page.locator('.cm-line').filter({ hasText: 'second line' }).first().dblclick();
    await page.locator('.cm-line').filter({ hasText: 'second line' }).first().click({ button: 'right' });
    const menu = page.locator('.context-menu');
    await menu.waitFor({ state: 'visible' });
    await shot('source-context-menu');
    await menu.getByRole('menuitem', { name: /AI에 첨부|Attach to AI chat/ }).click();
    await waitFor(async () => await chips.count() === before + 1, { label: 'context-menu attachment chip' });
    assert(await chips.last().getAttribute('data-kind') === 'source', 'The source attachment chip has the wrong kind.');
    await page.locator('.cm-line').filter({ hasText: 'third line' }).first().dblclick();
    await page.keyboard.press('Control+l');
    await waitFor(async () => await chips.count() === before + 2, { label: 'Ctrl+L attachment chip' });
    assert(await page.locator('.agent-context').count() === 0, 'The old always-visible environment/selection block must be gone.');
    await showPdf(page);
    await selectPdfText(page, 'TexyPaper page 1');
    await page.locator('.textLayer[data-ready="true"] span').filter({ hasText: 'TexyPaper page 1' }).first().click({ button: 'right' });
    await page.locator('.context-menu').getByRole('menuitem', { name: /AI에 첨부|Attach to AI chat/ }).click();
    await waitFor(async () => await chips.count() === before + 3, { label: 'PDF attachment chip' });
    assert(await chips.last().getAttribute('data-kind') === 'pdf', 'The PDF attachment chip has the wrong kind.');
    await shot('ai-attachment-chips');
    await page.getByTestId('agent-attachment-remove').last().click();
    await waitFor(async () => await chips.count() === before + 2, { label: 'chip removal' });
    return { chips: await chips.count() };
  });

  await scenario('shortcut-help-categories', async () => {
    await page.locator('[data-testid="shortcut-help-button"]:visible').first().click();
    const dialog = page.getByTestId('shortcut-help');
    await dialog.waitFor({ state: 'visible' });
    const categories = await page.locator('[data-testid="shortcut-toc"] button').count();
    assert(categories >= 6, `Expected categorized help, found ${categories} categories.`);
    await page.locator('[data-testid="shortcut-toc"] button').nth(1).click();
    await shot('shortcut-help');
    await page.getByTestId('shortcut-search').fill('Ctrl+D');
    await dialog.getByText(/줄 삭제|Delete line|Delete current line/i).first().waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    return { categories };
  });

  await scenario('workspace-visuals-light-dark', async () => {
    for (const scheme of ['light', 'dark']) { await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(300); await shot(`workspace-${scheme}`); }
    await page.emulateMedia({ colorScheme: 'light' });
    return { captured: true };
  });
} finally {
  const failed = results.filter(row => row.status === 'failed');
  await writeJson(path.join(run.output, 'usability-results.json'), { complete: true, passed: failed.length === 0, scenarios: results, manifest: undefined });
  await app?.close();
  const console = JSON.parse(await readFile(path.join(run.output, 'webview-console.json'), 'utf8').catch(() => '[]'));
  const pageErrors = console.filter(row => row.type === 'pageerror');
  await writeJson(path.join(run.output, 'usability-console.json'), { pageErrors });
  if (failed.length || pageErrors.length) { process.exitCode = 1; }
}
