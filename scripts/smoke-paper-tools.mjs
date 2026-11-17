// Runs only against a hidden-start release executable and disposable local/SSH papers.
// No real profile, clipboard, provider credentials, foreground window or AI request is used.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { assert, parseArgs, requireBinary, createRun, launchDesktop, waitFor, writeJson } from './smoke-support.mjs';
import { quickOpen, buildPaper } from './smoke-desktop.mjs';
import { connectSshUi, compileFromUi } from './smoke-ssh.mjs';
import { startSshSmokeHost } from './ssh-smoke-host.mjs';

const args = parseArgs(), binary = await requireBinary(args), run = await createRun(args, 'paper-tools');
const results = [], sha = text => createHash('sha256').update(text).digest('hex');
const main = '\\documentclass{article}\r\n\\begin{document}\r\nSynthetic manuscript \\cite{alpha2026}.\r\n\r\n\\input{sections/body}\r\n\\bibliographystyle{plain}\r\n\\bibliography{refs/library}\r\n\\end{document}\r\n';
const cleanBody = 'Measured evidence remains unchanged.\\label{sec:evidence}\n';
const cleanBib = '@article{alpha2026, author={Kim, Synthetic and Lee, Example}, title={Nested {Graph} Evidence}, journal={Synthetic Journal}, year={2026}}\n';
const initialFiles = {
  'main.tex': main,
  'sections/body.tex': 'Unresolved \\cite[see][p. 4]{missing-citation} and \\ref{missing-label}.\n\\label{duplicated-label}\n\\label{duplicated-label}\n% TODO supply evidence\n',
  'refs/library.bib': cleanBib + '@article{duplicate2026, title={First duplicate}, year={2025}}\n@article{duplicate2026, title={Second duplicate}, year={2026}}\n',
  '.texypaper/project.json': JSON.stringify({ version: 1, rootTex: 'main.tex', engine: 'pdflatex', profile: 'basic', autoBuild: false }),
  '.private/secret.bib': '@article{privatekey,title={Must never appear}}\n',
  'review-report.md': 'KEEP EXISTING REPORT\n',
};
const localRoot = path.join(run.fixtures, 'paper tools local');
await mkdir(localRoot, { recursive: true });
await writeFile(path.join(localRoot, '.texypaper-smoke-fixture'), 'Disposable paper-tools fixture\n', { flag: 'wx' });
const local = {
  kind: 'local', root: localRoot,
  read: relative => readFile(path.join(localRoot, relative), 'utf8'),
  write: async (relative, text) => { const target = path.join(localRoot, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text); },
};
let app, ssh;
const saveResults = complete => writeJson(path.join(run.output, 'paper-tools-results.json'), { complete, scenarios: results, passed: results.filter(result => result.status === 'passed').length, failed: results.filter(result => result.status === 'failed').length });
const closeTools = async page => { if (await page.getByTestId('paper-tools').count()) await page.getByRole('button', { name: '논문 도구 닫기', exact: true }).click(); };
const openTool = async (page, tool) => {
  await page.getByRole('button', { name: '논문', exact: true }).click();
  await page.getByTestId(`paper-${tool}`).click();
  await page.getByTestId('paper-tools').waitFor();
  if (tool !== 'table') await page.locator(tool === 'references' ? '.paper-references' : '.paper-preflight').waitFor({ timeout: 30000 });
};
const insertionPoint = async page => {
  await quickOpen(page, 'main.tex');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  for (let index = 0; index < 3; index++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
};
const replaceFile = async (page, host, relative, text) => {
  await quickOpen(page, relative);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(text);
  await waitFor(async () => (await host.read(relative)).replace(/\r\n/g, '\n') === text.replace(/\r\n/g, '\n'), { label: `saved synthetic ${relative}` });
};
async function exercise(host, dataDir) {
  const output = path.join(run.output, host.kind); await mkdir(output, { recursive: true });
  for (const [name, text] of Object.entries(initialFiles)) await host.write(name, text);
  app = await launchDesktop({ binary, output, dataDir, ...(host.kind === 'local' ? { project: host.root } : {}) });
  const { page } = app;
  await page.setViewportSize({ width: 1440, height: 900 });
  if (host.kind === 'ssh') await connectSshUi(page, host.environment, host.root, { acceptUnknownHost: true });
  await page.getByTestId('file-tree').waitFor({ timeout: 30000 });
  const shot = name => page.screenshot({ path: path.join(output, `${name}.png`) });
  const scenario = async (name, body) => {
    try { const evidence = await body(); results.push({ host: host.kind, name, status: 'passed', evidence }); }
    catch (error) {
      results.push({ host: host.kind, name, status: 'failed', error: error.stack ?? String(error) });
      await shot(`failure-${name}`).catch(() => {});
      for (let attempt = 0; attempt < 3 && await page.locator('[aria-modal="true"]:visible').count(); attempt++) await page.keyboard.press('Escape');
    }
    await saveResults(false);
  };
  await scenario('bibliography-search-insert-undo', async () => {
    await insertionPoint(page);
    await openTool(page, 'references');
    const search = page.locator('.paper-reference-search');
    await search.fill('Graph');
    const item = page.locator('.paper-reference-item');
    assert(await item.count() === 1 && (await item.innerText()).includes('alpha2026'), 'Metadata search must find the unopened nested bibliography.');
    assert(!(await page.locator('.paper-references').innerText()).includes('privatekey'), 'Hidden private bibliography must not be scanned.');
    await shot('references-light');
    await page.getByRole('button', { name: 'alpha2026 인용 삽입', exact: true }).click();
    await page.getByTestId('paper-tools').waitFor({ state: 'hidden' });
    await waitFor(async () => ((await host.read('main.tex')).match(/\\cite\{alpha2026\}/g) ?? []).length === 2, { label: 'citation inserted into actual saved source' });
    const inserted = await host.read('main.tex');
    assert(!/(?<!\r)\n/.test(inserted), 'Citation insertion changed CRLF bytes.');
    await page.keyboard.press('Control+z');
    await waitFor(async () => await host.read('main.tex') === main, { label: 'one undo restores exact source' });
    await openTool(page, 'references'); await search.fill('duplicate2026');
    const duplicates = page.getByRole('button', { name: 'duplicate2026 인용 삽입', exact: true });
    assert(await duplicates.count() === 2 && await duplicates.first().isDisabled() && await duplicates.last().isDisabled(), 'Ambiguous citation keys must not be inserted.');
    await closeTools(page);
    return { nestedMetadata: true, privateExcluded: true, duplicatesBlocked: true, exactUndo: sha(main) };
  });
  await scenario('preflight-findings-navigation', async () => {
    await openTool(page, 'preflight');
    const findings = await page.locator('.paper-preflight-list').innerText();
    for (const expected of ['missing-citation', 'missing-label', 'duplicate2026', 'duplicated-label', 'TODO']) assert(findings.includes(expected), `Preflight missed ${expected}.`);
    assert((await page.locator('.paper-preflight-summary').innerText()).includes('빌드 결과가 없습니다'), 'Unbuilt paper must not claim a current PDF.');
    await shot('preflight-findings');
    await page.locator('.paper-preflight-list li').filter({ hasText: 'missing-label' }).getByRole('button').click();
    await waitFor(async () => await page.getByTestId('source-editor').getAttribute('data-path') === 'sections/body.tex', { label: 'finding navigates to exact source file' });
    await waitFor(async () => page.locator('.cm-content').evaluate(element => {
      const node = window.getSelection()?.anchorNode;
      const line = (node instanceof Element ? node : node?.parentElement)?.closest('.cm-line');
      return !!line && element.contains(line) && line.textContent.includes('missing-label');
    }), { label: 'caret moved to the finding source line' });
    return { findings, source: 'sections/body.tex:1' };
  });
  await scenario('table-validation-insert-undo-real-pdf', async () => {
    await replaceFile(page, host, 'sections/body.tex', cleanBody);
    await replaceFile(page, host, 'refs/library.bib', cleanBib);
    await insertionPoint(page);
    const before = await host.read('main.tex');
    const prepare = async () => {
      await openTool(page, 'table');
      await page.getByTestId('table-data').fill('Name,Value\nOnlyOne');
      assert(await page.getByTestId('table-insert').isDisabled(), 'Ragged rows must be refused, not padded or dropped.');
      await page.getByTestId('table-data').fill('Name,Value\n"A & B","50%"\n"Line one\nLine two","x_1"');
      await page.getByLabel('캡션 (선택)', { exact: true }).fill('Results & checks');
      await page.getByLabel('라벨 (선택)', { exact: true }).fill('tab:results');
      const latex = await page.getByTestId('table-latex').inputValue();
      for (const expected of ['\\&', '\\%', '\\_', '\\label{tab:results}']) assert(latex.includes(expected), `Escaped LaTeX missing ${expected}.`);
      return latex;
    };
    const latex = await prepare();
    await page.getByTestId('table-insert').click();
    await waitFor(async () => (await host.read('main.tex')).includes('\\begin{tabular}'), { label: 'generated table saved to actual source' });
    assert(!/(?<!\r)\n/.test(await host.read('main.tex')), 'Multiline table insertion changed CRLF bytes.');
    await page.keyboard.press('Control+z');
    await waitFor(async () => await host.read('main.tex') === before, { label: 'table is one exact undo operation' });
    await insertionPoint(page); await prepare(); await page.getByTestId('table-insert').click();
    const build = host.kind === 'local' ? await buildPaper(page, host.root) : await compileFromUi(page);
    await page.locator('.pdf-preview').waitFor({ timeout: 30000 });
    await shot('compiled-table');
    await openTool(page, 'preflight');
    assert(await page.locator('.paper-preflight-list li').count() === 0, 'Repaired paper must no longer show source findings.');
    assert((await page.locator('.paper-preflight-summary').innerText()).includes('현재 소스 기준 빌드'), 'Successful current build was not recognized.');
    await closeTools(page);
    return { buildId: build.buildId, latex, sourceSha256: sha(await host.read('main.tex')) };
  });
  await scenario('review-report-preview-save-no-overwrite', async () => {
    await quickOpen(page, 'sections/body.tex'); await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+Shift+ArrowRight'); await page.keyboard.press('Control+Shift+c');
    await page.locator('#comment-text').fill('Original review: retain number 17.\nLiteral ``` fence.');
    await page.getByRole('button', { name: '댓글 저장', exact: true }).click();
    const thread = page.locator('.comment-thread').filter({ hasText: 'Original review: retain number 17.' });
    await thread.getByRole('button', { name: '답글', exact: true }).click();
    await page.locator('#comment-text').fill('Reply: no experiment was claimed.');
    await page.getByRole('button', { name: '댓글 저장', exact: true }).click();
    await thread.getByText('Reply: no experiment was claimed.', { exact: true }).waitFor();
    await thread.getByRole('button', { name: '해결', exact: true }).click();
    await waitFor(async () => JSON.parse(await host.read('.texypaper/comments.json')).threads.some(value => value.status === 'resolved'), { label: 'resolved review saved on actual host' });
    const comments = await host.read('.texypaper/comments.json');
    await page.getByRole('button', { name: '검토 보고서 내보내기', exact: true }).click();
    const preview = await page.locator('.review-export-preview').innerText();
    for (const expected of ['Original review: retain number 17.', 'Reply: no experiment was claimed.', 'sections/body.tex']) assert(preview.includes(expected), `Report lost ${expected}.`);
    await page.getByTestId('review-export-save').click();
    await page.getByTestId('review-export').getByRole('alert').waitFor();
    assert(await host.read('review-report.md') === initialFiles['review-report.md'], 'Export overwrote an existing report.');
    const name = `review-${host.kind}.md`;
    await page.getByLabel('저장 경로 (프로젝트 기준)', { exact: true }).fill(name);
    await page.getByTestId('review-export-save').click();
    await page.getByText('보고서를 저장했습니다.', { exact: true }).waitFor();
    assert(await host.read(name) === preview, 'Saved Markdown differs from the exact preview.');
    assert(await host.read('.texypaper/comments.json') === comments, 'Export mutated portable comments or status.');
    await shot('review-report'); await page.keyboard.press('Escape');
    await page.getByTestId('review-export').waitFor({ state: 'hidden' });
    return { path: name, reportSha256: sha(preview), commentsUnchanged: sha(comments), existingFilePreserved: true };
  });
  await scenario('academic-tasks-append-without-send', async () => {
    await quickOpen(page, 'sections/body.tex'); await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+Shift+ArrowRight'); await page.keyboard.press('Control+l');
    const prompt = page.getByTestId('agent-prompt'); await prompt.fill('Keep my draft, value 17, and citation \\cite{alpha2026}.');
    const attachments = await page.getByTestId('agent-attachment').allInnerTexts();
    assert(attachments.length > 0, 'Synthetic source selection must be attached.');
    for (const task of ['shorten', 'english', 'critique', 'reviewer-response']) {
      const before = await prompt.inputValue();
      await page.getByTestId('agent-writing-task').selectOption(task); await page.getByTestId('agent-writing-task-append').click();
      const after = await prompt.inputValue();
      assert(after.startsWith(before + '\n\n') && after.length > before.length + 40, `Task ${task} overwrote or failed to append the draft.`);
      assert(await page.getByTestId('agent-status').getAttribute('data-status') === 'idle', `Task ${task} unexpectedly sent the draft.`);
      assert(JSON.stringify(await page.getByTestId('agent-attachment').allInnerTexts()) === JSON.stringify(attachments), 'Preset changed existing attachments.');
    }
    await shot('academic-draft');
    await prompt.fill('x'.repeat(65530)); await page.getByTestId('agent-writing-task').selectOption('shorten');
    assert(await page.getByTestId('agent-writing-task-append').isDisabled(), 'Oversized combined prompt must be refused.');
    assert((await prompt.inputValue()).length === 65530, 'Prompt limit silently truncated the existing draft.');
    await prompt.fill('');
    return { presets: 4, automaticSends: 0, attachmentsPreserved: attachments.length, overflowRefused: true };
  });
  await scenario('escaped-table-expansion-and-undo', async () => {
    await insertionPoint(page); const before = await host.read('main.tex');
    await openTool(page, 'table');
    await page.getByTestId('table-data').fill('Column\n' + '\\'.repeat(80000));
    const generated = await page.getByTestId('table-latex').inputValue();
    assert(generated.length > 1048576, 'Fixture must exercise valid escaped output exceeding 1 MiB.');
    await page.getByTestId('table-insert').click();
    await page.getByTestId('paper-tools').waitFor({ state: 'hidden' });
    await waitFor(async () => (await host.read('main.tex')).includes(generated.replace(/\n/g, '\r\n')), { label: 'expanded escaped output saved without truncation' });
    await page.keyboard.press('Control+z');
    await waitFor(async () => await host.read('main.tex') === before, { label: 'large generated table undone exactly' });
    return { inputCharacters: 80007, outputCharacters: generated.length, exactUndo: sha(before) };
  });
  await scenario('stale-source-and-readonly-guards-layout', async () => {
    await insertionPoint(page); const before = await host.read('main.tex');
    await openTool(page, 'table'); await page.getByTestId('table-data').fill('A\tB\n1\t2');
    await host.write('main.tex', '% External source revision\r\n' + before);
    await waitFor(async () => (await page.locator('.cm-content').innerText()).includes('External source revision'), { timeoutMs: 30000, label: 'external source change reached editor behind modal' });
    await page.getByTestId('table-insert').click();
    await page.getByTestId('paper-tools').getByRole('alert').waitFor();
    assert(await host.read('main.tex') === '% External source revision\r\n' + before, 'Stale insertion overwrote an external source revision.');
    await closeTools(page);
    await openTool(page, 'preflight');
    assert((await page.locator('.paper-preflight-summary').innerText()).includes('빌드가 필요'), 'Changed source must not claim a current PDF.');
    await closeTools(page);
    await host.write('oversized.tex', '% bounded readonly source\n'.repeat(200000));
    await page.getByRole('button', { name: /파일 목록 새로|새로 고침|Refresh files/ }).first().click();
    await quickOpen(page, 'oversized.tex'); await openTool(page, 'table');
    await page.getByTestId('table-data').fill('A\tB\n1\t2');
    assert(await page.getByTestId('table-insert').isDisabled(), 'Read-only source must never accept table insertion.');
    await closeTools(page);
    await insertionPoint(page); await openTool(page, 'references');
    await page.locator('.paper-reference-search').fill('alpha2026');
    assert(await page.getByRole('button', { name: 'alpha2026 인용 삽입', exact: true }).isDisabled(), 'Incomplete scan must not allow ambiguous citation insertion.');
    assert((await page.locator('.paper-references').innerText()).includes('일부 파일'), 'Skipped oversized source must be disclosed.');
    await closeTools(page);
    await page.getByTestId('settings-button').click(); await page.getByTestId('ui-theme').selectOption('dark'); await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 960, height: 640 }); await insertionPoint(page); await openTool(page, 'table');
    await page.getByTestId('table-data').fill('Name,Value\nA,42');
    const box = await page.getByTestId('paper-tools').boundingBox();
    assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 961 && box.y + box.height <= 641, 'Dialog overflows the minimum viewport.');
    await page.keyboard.press('Tab');
    assert(await page.getByTestId('paper-tools').evaluate(element => element.contains(document.activeElement)), 'Keyboard focus escaped the modal.');
    await shot('table-dark-960'); await closeTools(page);
    await shot('workspace-dark-960');
    return { staleInsertRefused: true, readonlyRefused: true, incompleteDisclosed: true, keyboardFocusContained: true, viewport: { width: 960, height: 640 } };
  });
  await app.close(); app = null;
}
try {
  await exercise(local, run.dataDir);
  ssh = await startSshSmokeHost({ outputDir: run.output });
  const sshData = path.join(run.output, 'ssh-app-data'); await mkdir(sshData);
  await exercise({ ...ssh, kind: 'ssh' }, sshData);
} catch (error) {
  results.push({ name: 'harness', status: 'failed', error: error.stack ?? String(error) });
} finally {
  if (app) await app.close();
  if (ssh) await ssh.stop();
  await saveResults(true);
}
console.log(JSON.stringify({ passed: results.filter(result => result.status === 'passed').length, failed: results.filter(result => result.status === 'failed').length, evidence: path.join(run.output, 'paper-tools-results.json') }));
if (results.some(result => result.status === 'failed')) process.exitCode = 1;
