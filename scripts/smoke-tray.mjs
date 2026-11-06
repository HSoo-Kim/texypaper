import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assert, parseArgs, requireBinary, createRun, launchDesktop, waitFor, writeJson, runExternal, ownedProcesses } from './smoke-support.mjs';
import { openLocalUi } from './smoke-ssh.mjs';

const helper = fileURLToPath(new URL('./smoke-tray-native.ps1', import.meta.url));
const mainTitle = 'TexyPaper', chatTitle = 'TexyPaper — AI';
const buildTerminals = ['published', 'failed', 'cancelled', 'timeout'];

async function openChat(page) {
  if (!await page.locator('#ai-tab').isVisible()) await page.getByRole('button', { name: /^(AI 및 댓글 패널|AI and comments panel)$/ }).click();
  await page.locator('#ai-tab').click();
  await page.getByTestId('agent-prompt').waitFor();
}
async function state(page, chat) {
  const identity = await page.getByTestId('workspace-identity').evaluate(element => Object.fromEntries(['root', 'environment-id', 'epoch'].map(name => [name, element.getAttribute(`data-${name}`)])));
  const task = chat.getByTestId('agent-status');
  return {
    workspace: identity,
    sourcePath: await page.getByTestId('source-editor').getAttribute('data-path'),
    source: await page.locator('.cm-content').innerText(),
    draft: await chat.getByTestId('agent-prompt').inputValue(),
    task: { id: await task.getAttribute('data-task-id'), status: await task.getAttribute('data-status') },
    build: await page.getByTestId('build-status').evaluate(element => ({ status: element.getAttribute('data-status'), id: element.getAttribute('data-build-id'), sequence: element.getAttribute('data-sequence') })),
  };
}
function sameState(before, after, { buildMayFinish = false } = {}) {
  assert(JSON.stringify(before.workspace) === JSON.stringify(after.workspace), 'Tray cycle changed the actual workspace root/environment/epoch');
  assert(before.sourcePath === after.sourcePath && before.source === after.source, 'Tray cycle lost the open source buffer');
  assert(before.draft === after.draft, 'Tray cycle lost the detached chat draft');
  assert(JSON.stringify(before.task) === JSON.stringify(after.task), 'Tray cycle replaced the actual AI task identity/status');
  if (!buildMayFinish) assert(JSON.stringify(before.build) === JSON.stringify(after.build), 'Tray cycle changed the existing build/task state');
}
function assertWindows(snapshot, handles, visible) {
  assert(snapshot.windows.length === handles.length, `Expected exactly ${handles.length} owned main/chat windows, got ${snapshot.windows.length}`);
  for (const before of handles) {
    const current = snapshot.windows.find(window => window.Handle === before.Handle && window.Title === before.Title);
    assert(current && current.Visible === visible, `Owned ${before.Title} HWND ${before.Handle} was ${visible ? 'not restored' : 'destroyed or still visible'}`);
  }
}

async function main() {
  const args = parseArgs();
  assert(args.headed === true, 'HEADED_PERMISSION_REQUIRED: this tray smoke opens windows and uses the physical mouse. Run only with explicit user permission and --headed; never use it for background/headless verification.');
  const run = await createRun(args, 'tray');
  const report = { passed: false, startedAt: new Date().toISOString(), checks: [], native: [], dependencies: {}, coverage: { liveAiCommand: 'Covered by the separate smoke:chat --live gate; this gate does not fabricate provider tasks.' } };
  let desktop, lock;
  const lockPath = path.join(os.tmpdir(), 'texypaper-tray-acceptance.lock');
  let nativeSequence = 0;
  async function native(action, label = action, appPid = desktop?.child.pid) {
    const prefix = `native-${String(++nativeSequence).padStart(2, '0')}-${label}`;
    const evidence = path.join(run.output, `${prefix}.png`);
    // Windows PowerShell 5 treats BOM-less .ps1 files as ANSI. Explicit UTF-8 loading
    // keeps Korean menu labels and the detached window's em dash exact on every locale.
    const code = '& ([scriptblock]::Create([IO.File]::ReadAllText($env:TEXYPAPER_TRAY_HELPER,[Text.Encoding]::UTF8))) -Action $env:TEXYPAPER_TRAY_ACTION -AppPid ([int]$env:TEXYPAPER_TRAY_PID) -Evidence $env:TEXYPAPER_TRAY_EVIDENCE -Headed';
    const result = await runExternal('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
      output: run.output, prefix, timeoutMs: 40000,
      env: { TEXYPAPER_TRAY_HELPER: helper, TEXYPAPER_TRAY_ACTION: action, TEXYPAPER_TRAY_PID: String(appPid ?? 0), TEXYPAPER_TRAY_EVIDENCE: evidence },
    });
    const record = JSON.parse(result.stdout.trim());
    report.native.push(record);
    assert(record.passed === true, `Native ${action} did not complete`);
    return record;
  }
  const alive = () => assert(desktop.child.exitCode === null && desktop.child.signalCode === null, 'The originally launched TexyPaper process exited during a tray hide/restore cycle');
  async function waitWindows(handles, visible, label) {
    return waitFor(async () => {
      alive();
      const current = await native('windows', label);
      assertWindows(current, handles, visible);
      return current;
    }, { timeoutMs: 20000, intervalMs: 200, label });
  }
  try {
    assert(process.platform === 'win32', 'PREREQUISITE_MISSING: real tray acceptance requires an interactive Windows desktop, Explorer notification area and WebView2.');
    const binary = await requireBinary(args);
    try { lock = await fs.open(lockPath, 'wx'); }
    catch (error) { throw new Error(`OS_INTERACTION_BUSY: cannot acquire ${lockPath}; serialize native acceptance runs. An existing lock is never removed automatically. ${error.message}`); }
    await lock.writeFile(JSON.stringify({ pid: process.pid, output: run.output, startedAt: report.startedAt }));
    // Do not click an existing user's TexyPaper icon. Inspect promoted and hidden
    // icons before launching ours, and refuse ambiguous notification-area identity.
    const baseline = await native('probe', 'before-launch', 0);
    assert(baseline.iconCount === 0, 'PREREQUISITE_MISSING: another TexyPaper tray icon already exists. Close that instance explicitly before running; this gate never touches unrelated applications.');
    report.dependencies.notificationArea = 'Explorer notification area accessible; pre-launch TexyPaper icon count is zero';
    const tools = {};
    for (const tool of ['latexmk', 'pdflatex']) {
      const found = await runExternal('where.exe', [tool], { output: run.output, prefix: `dependency-${tool}`, acceptedExitCodes: [0, 1] });
      tools[tool] = found.exitCode === 0;
    }
    report.dependencies.latex = tools;
    const buildAvailable = tools.latexmk && tools.pdflatex;
    const root = path.join(run.fixtures, 'tray project');
    await fs.mkdir(path.join(root, '.texypaper'), { recursive: true });
    // A real pdfTeX timer loop, not a wrapper/fake compiler or shell escape. Each
    // pass is slow enough for native WM_CLOSE + process/window observations.
    const slow = '\\newcount\\traydeadline\n\\traydeadline=\\pdfelapsedtime\n\\advance\\traydeadline by 1966080\n\\loop\\ifnum\\pdfelapsedtime<\\traydeadline\\relax\\repeat\n';
    const source = `\\documentclass{article}\n\\begin{document}\n${buildAvailable ? slow : ''}Isolated real TexyPaper tray acceptance.\n\\end{document}\n`;
    await fs.writeFile(path.join(root, 'main.tex'), source);
    await writeJson(path.join(root, '.texypaper', 'project.json'), { version: 1, rootTex: 'main.tex', engine: 'pdflatex', profile: 'basic', autoBuild: false });
    desktop = await launchDesktop({ binary, output: run.output, dataDir: run.dataDir, project: root });
    const page = desktop.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLocalUi(page, root, { alreadyOpen: true });
    await page.getByTestId('settings-button').click();
    await page.getByTestId('ui-locale').selectOption('en');
    await page.keyboard.press('Escape');
    const sourceRow = page.locator('[role="treeitem"][data-path="main.tex"]');
    await sourceRow.dblclick();
    await page.locator('.cm-content[contenteditable="true"]').waitFor();
    await openChat(page);
    const draft = `Native tray retained draft · 한글 ${randomUUID()}`;
    await page.getByTestId('agent-prompt').fill(draft);
    await page.getByTestId('chat-detach').click();
    const chat = await waitFor(() => desktop.browser.contexts().flatMap(context => context.pages()).find(candidate => !candidate.isClosed() && candidate.url().includes('view=chat')), { label: 'actual detached Tauri chat webview' });
    await chat.getByTestId('agent-prompt').waitFor();
    assert(await chat.getByTestId('agent-prompt').inputValue() === draft, 'Initial detached chat draft missing');
    assert(await chat.locator('.cm-editor,.pdf-preview').count() === 0, 'Detached webview duplicated editor/PDF ownership');
    const initial = await native('windows', 'initial-owned-windows');
    assert(initial.windows.length === 2 && initial.windows.some(window => window.Title === mainTitle) && initial.windows.some(window => window.Title === chatTitle), 'Expected exactly one real main window and one real detached chat');
    assert(initial.windows.every(window => window.Visible), 'Initial owned main/chat windows must be natively visible');
    const handles = initial.windows;
    report.process = { pid: desktop.child.pid, nativeIdentity: initial.process, windows: handles };
    // Initial programmatic launch need not own Windows foreground focus; the
    // actual tray Open action below must restore it before native screen capture.
    await page.screenshot({ path: path.join(run.output, 'before-close-webview.png') });
    const before = await state(page, chat);
    await native('close', 'main-wm-close');
    const hidden = await waitWindows(handles, false, 'hidden-owned-windows');
    assert(!page.isClosed() && !chat.isClosed(), 'Native main close destroyed a controller or detached webview');
    sameState(before, await state(page, chat));
    const hiddenIcon = await native('probe', 'hidden-tray-icon');
    assert(hiddenIcon.iconCount === 1, 'Hidden process did not retain exactly one native TexyPaper tray icon');
    await native('open', 'tray-open-menu');
    const restored = await waitWindows(handles, true, 'restored-owned-windows');
    sameState(before, await state(page, chat));
    await native('capture', 'restored-main');
    await chat.screenshot({ path: path.join(run.output, 'restored-detached-chat.png') });
    report.checks.push({ name: 'native-wm-close-hide-and-real-tray-open', passed: true, before, hidden, restored, samePid: desktop.child.pid });

    await native('close', 'double-click-hide');
    await waitWindows(handles, false, 'double-click-hidden');
    await native('double-click', 'tray-left-double-click');
    await waitWindows(handles, true, 'double-click-restored');
    sameState(before, await state(page, chat));
    report.checks.push({ name: 'real-tray-left-double-click-restores-both-existing-hwnds', passed: true });

    if (buildAvailable) {
      const status = page.getByTestId('build-status');
      const sequence = await status.getAttribute('data-sequence');
      await page.getByRole('button', { name: 'Build', exact: true }).click();
      await waitFor(async () => await status.getAttribute('data-status') === 'building', { label: 'actual native build started' });
      const compilers = await waitFor(async () => {
        const processes = (await ownedProcesses(desktop.child.pid)).filter(process => /^(latexmk|perl|pdftex|pdflatex|miktex-latexmk)\.exe$/i.test(process.Name));
        return processes.length > 0 && processes.some(process => /^(pdftex|pdflatex)\.exe$/i.test(process.Name)) && processes;
      }, { timeoutMs: 25000, label: 'real app-owned latexmk/pdfTeX descendant processes' });
      const running = await state(page, chat);
      await native('close', 'running-build-wm-close');
      await waitWindows(handles, false, 'build-running-hidden');
      assert(await status.getAttribute('data-status') === 'building', 'Slow real build already ended before the hidden interval could be observed');
      const completion = await waitFor(async () => {
        alive();
        const current = await state(page, chat);
        return current.build.sequence !== sequence && buildTerminals.includes(current.build.status) && current;
      }, { timeoutMs: 180000, intervalMs: 500, label: 'real compiler publication while both native windows remain hidden' });
      const stillHidden = await waitWindows(handles, false, 'build-completed-still-hidden');
      assert(completion.build.status === 'published' && completion.build.id, `Real background build did not publish: ${JSON.stringify(completion.build)}; ${(await page.getByRole('alert').allTextContents()).join(' | ')}`);
      sameState(running, completion, { buildMayFinish: true });
      const processesAfterBuild = await ownedProcesses(desktop.child.pid);
      assert(!processesAfterBuild.some(process => compilers.some(old => old.ProcessId === process.ProcessId && old.CreatedTicks === process.CreatedTicks)), 'Completed hidden build retained a captured compiler process');
      await native('open', 'completed-build-tray-open');
      await waitWindows(handles, true, 'build-restored');
      sameState(completion, await state(page, chat));
      await native('capture', 'completed-background-build');
      report.checks.push({ name: 'real-owned-latex-build-completes-while-hidden', passed: true, compilers, running, completion, stillHidden });
    } else {
      report.checks.push({ name: 'real-owned-latex-build-completes-while-hidden', status: 'unavailable', passed: null, reason: 'Optional real latexmk and pdfLaTeX prerequisites are not both installed; no fake compiler or passing substitute used.' });
    }

    // Hold a genuine Chromium IME composition, as in smoke:desktop recovery,
    // so production 700ms autosave cannot erase the dirty-exit precondition.
    const saved = await fs.readFile(path.join(root, 'main.tex'), 'utf8');
    const unsaved = `% Unsaved native tray exit marker ${randomUUID()}`;
    const editor = page.locator('.cm-content[contenteditable="true"]');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText(`\n${unsaved}\n`);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '보류', selectionStart: 2, selectionEnd: 2 });
    await waitFor(async () => (await page.locator('.file-tabs [role="tab"][aria-selected="true"]').innerText()).includes('●'), { label: 'real unsaved source tab before tray Exit' });
    assert(await fs.readFile(path.join(root, 'main.tex'), 'utf8') === saved, 'Dirty fixture unexpectedly reached disk before tray Exit');
    const dirtyBefore = await state(page, chat);
    await native('close', 'dirty-main-wm-close');
    await waitWindows(handles, false, 'dirty-hidden');
    assert(await page.getByRole('alertdialog').count() === 0, 'Main X prompted or guarded instead of simply hiding');
    await native('exit', 'first-real-tray-exit');
    await waitWindows(handles, true, 'dirty-exit-restores-both');
    const dirtyDialog = page.getByRole('alertdialog', { name: 'Unsaved changes', exact: true });
    await dirtyDialog.waitFor();
    assert(!/switch|changing projects/i.test(await dirtyDialog.innerText()), 'Exit guard incorrectly describes switching projects');
    await native('capture', 'dirty-exit-guard');
    report.dirtyExitDialog = await dirtyDialog.innerText();
    await dirtyDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dirtyDialog.waitFor({ state: 'hidden' });
    alive();
    sameState(dirtyBefore, await state(page, chat));
    assert(await fs.readFile(path.join(root, 'main.tex'), 'utf8') === saved, 'Cancel mutated the saved source');
    await native('capture', 'dirty-exit-cancelled');
    report.checks.push({ name: 'real-tray-exit-dirty-cancel-retains-project-draft-buffer-and-process', passed: true, dirtyBefore, diskUnchanged: true });

    const identities = await ownedProcesses(desktop.child.pid);
    report.exitProcessIdentities = identities;
    await native('close', 'final-exit-hide');
    await waitWindows(handles, false, 'final-exit-hidden');
    await native('exit', 'final-real-tray-exit');
    await dirtyDialog.waitFor();
    await dirtyDialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await waitFor(() => desktop.child.exitCode !== null || desktop.child.signalCode !== null, { timeoutMs: 30000, label: 'same launched native process exits after explicit tray Exit and guarded Discard' });
    assert(desktop.child.exitCode === 0, `Explicit guarded exit returned ${desktop.child.exitCode} / ${desktop.child.signalCode}`);
    const remaining = await waitFor(async () => {
      const result = await runExternal('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; $ids=@($env:TEXYPAPER_TRAY_OWNED_IDS.Split(",") | ForEach-Object {[int]$_}); @(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -in $ids} | Select-Object ProcessId,@{n="CreatedTicks";e={$_.CreationDate.ToUniversalTime().Ticks}}) | ConvertTo-Json -Compress'], { timeoutMs: 15000, env: { TEXYPAPER_TRAY_OWNED_IDS: identities.map(process => process.ProcessId).join(',') } });
      const current = [].concat(JSON.parse(result.stdout || '[]'));
      const retained = current.filter(process => identities.some(old => old.ProcessId === process.ProcessId && old.CreatedTicks === process.CreatedTicks));
      return retained.length === 0 && { retained, at: new Date().toISOString() };
    }, { timeoutMs: 30000, intervalMs: 250, label: 'captured owned application/WebView process identities gone after explicit exit' });
    assert(await fs.readFile(path.join(root, 'main.tex'), 'utf8') === saved, 'Explicit Discard wrote the dirty source fixture');
    const afterExit = await native('probe', 'after-explicit-exit', 0);
    assert(afterExit.iconCount === 0, 'Explicit Exit left a live native TexyPaper notification icon');
    report.checks.push({ name: 'real-tray-exit-guarded-discard-actually-exits-owned-process-tree', passed: true, exitCode: desktop.child.exitCode, remaining, trayIcons: afterExit.iconCount, diskUnchanged: true });
    report.passed = true;
  } catch (error) {
    report.error = error.stack ?? String(error);
    if (desktop && desktop.child.exitCode === null) {
      await desktop.page.screenshot({ path: path.join(run.output, 'failure-webview.png') }).catch(capture => { report.failureCaptureError = capture.message; });
      await native('windows', 'failure-owned-windows').catch(capture => { report.failureNativeError = capture.message; });
    }
  } finally {
    // Harness teardown targets only the process tree it spawned; it is never
    // counted as proof of explicit Exit and never kills by executable name.
    try { await desktop?.close(); }
    catch (error) { report.cleanupError = error.stack ?? String(error); report.passed = false; }
    if (lock) { await lock.close(); await fs.unlink(lockPath).catch(error => { report.lockCleanupError = error.message; report.passed = false; }); }
    report.finishedAt = new Date().toISOString();
    await writeJson(path.join(run.output, 'tray-report.json'), report);
  }
  console.log(JSON.stringify({ passed: report.passed, report: path.join(run.output, 'tray-report.json'), error: report.error ?? null }));
  if (!report.passed) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
