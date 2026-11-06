import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert, parseArgs, requireBinary, createRun, launchDesktop, waitFor, writeJson, runExternal } from './smoke-support.mjs';
import { openLocalUi, connectSshUi } from './smoke-ssh.mjs';
import { startSshSmokeHost } from './ssh-smoke-host.mjs';

async function openChat(page) {
  if (!await page.locator('#ai-tab').isVisible()) await page.getByRole('button', { name: /^(AI 및 댓글 패널|AI and comments panel)$/ }).click();
  await page.locator('#ai-tab').click();
  await page.getByTestId('agent-prompt').waitFor();
}
async function settings(page) {
  if (!await page.getByTestId('agent-provider').isVisible()) await page.getByTestId('chat-settings-button').click();
}
async function back(page) {
  if (await page.getByTestId('chat-settings-back').isVisible()) await page.getByTestId('chat-settings-back').click();
}
async function quickControlGeometry(page) {
  const controls = await page.locator('#agent-model,[data-testid="reasoning-effort"],[data-testid="execution-permission"],[data-testid="agent-send"],[data-testid="agent-cancel"]').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { name: element.id || element.dataset.testid, x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
  }));
  assert(controls.length === 4, 'Composer must show model, reasoning, permission, then send/stop');
  for (const [index, control] of controls.entries()) {
    assert(control.width > 0 && control.height > 0 && control.x >= 0 && control.x + control.width <= control.viewportWidth + 1 && control.y + control.height <= control.viewportHeight + 1, `Quick control clipped: ${JSON.stringify(control)}`);
    const previous = controls[index - 1];
    if (previous) assert(control.y > previous.y + 1 || control.x >= previous.x + previous.width - 1, 'Quick controls are not visually ordered before Send/Stop');
  }
  return controls;
}
async function detach(desktop) {
  await desktop.page.getByTestId('chat-detach').click();
  const child = await waitFor(() => desktop.browser.contexts().flatMap(context => context.pages()).find(page => !page.isClosed() && page.url().includes('view=chat')), { label: 'native detached chat webview' });
  await child.getByTestId('agent-prompt').waitFor({ timeout: 30000 });
  assert(await child.locator('.cm-editor,.pdf-preview').count() === 0, 'Detached chat created a duplicate editor or PDF viewer');
  return child;
}
async function dock(desktop, child) {
  await child.getByTestId('chat-dock').click();
  await waitFor(() => child.isClosed(), { label: 'detached webview destroyed on dock' });
  await desktop.page.getByTestId('agent-prompt').waitFor();
}
async function nativeWindowOperation(appPid, operation) {
  const code = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ChatWindows {
  public delegate bool EnumProc(IntPtr window, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int mode);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  public static int Operate(uint owner, string operation) {
    int count=0;
    EnumWindows((window,param)=> {
      uint pid; GetWindowThreadProcessId(window,out pid);
      if(pid!=owner) return true;
      var text=new StringBuilder(256); GetWindowText(window,text,256);
      var title=text.ToString(); if(title!="TexyPaper" && title!="TexyPaper — AI") return true;
      if(operation=="visible") { if(IsWindowVisible(window)) count++; }
      else if(operation=="restore") { ShowWindow(window,9); SetForegroundWindow(window); count++; }
      else if(title==(operation=="chat" ? "TexyPaper — AI" : "TexyPaper") && PostMessage(window,0x0010,IntPtr.Zero,IntPtr.Zero)) count++;
      return true;
    },IntPtr.Zero);
    return count;
  }
}
'@; [ChatWindows]::Operate([uint32]$env:TEXYPAPER_CHAT_PID, $env:TEXYPAPER_CHAT_ACTION)`;
  const result = await runExternal('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { env: { TEXYPAPER_CHAT_PID: String(appPid), TEXYPAPER_CHAT_ACTION: operation } });
  return Number(result.stdout.trim());
}
async function closeNativeWindow(appPid, chat = true) {
  assert(await nativeWindowOperation(appPid, chat ? 'chat' : 'main') === 1, `Expected exactly one owned native ${chat ? 'AI' : 'main'} window to receive WM_CLOSE`);
}
async function choosePermission(page, mode) {
  await back(page);
  await page.getByTestId('execution-permission').selectOption(mode);
  if (mode === 'session') {
    await page.getByTestId('execution-session-warning').locator('input[type="checkbox"]').check();
    await page.getByTestId('execution-permission-confirm').click();
  }
  await waitFor(async () => await page.getByTestId('execution-permission').inputValue() === mode, { label: `${mode} command permission acknowledged` });
}
async function configureClaude(page) {
  await settings(page);
  await page.getByTestId('agent-provider').selectOption('claude');
  const auth = page.getByTestId('provider-auth-status');
  await waitFor(async () => await auth.getAttribute('data-provider') === 'claude' && ['ready', 'loginRequired', 'unavailable'].includes(await auth.getAttribute('data-status')), { timeoutMs: 60000, label: 'actual Claude subscription authentication' });
  assert(await auth.getAttribute('data-status') === 'ready', `Claude official subscription required: ${await auth.innerText()}`);
  await back(page);
  await waitFor(async () => await page.locator('#agent-model option:not([value="__custom"])').count() > 0 && !await page.locator('#agent-model').isDisabled(), { timeoutMs: 60000, label: 'latest official model catalog loaded' });
  const models = await page.locator('#agent-model option').evaluateAll(options => options.map(option => ({ id: option.value, label: option.textContent })));
  const latest = models.filter(model => model.id !== '__custom');
  assert(latest.length > 0 && latest.every(model => /\d/.test(model.label)), 'Model catalog must expose real version numbers, not only aliases');
  const selected = latest.find(model => /sonnet/i.test(model.id)) ?? latest[0];
  await page.locator('#agent-model').selectOption(selected.id);
  const efforts = await page.getByTestId('reasoning-effort').locator('option').evaluateAll(options => options.filter(option => option.value).map(option => ({ value: option.value, label: option.textContent })));
  assert(efforts.some(option => option.value === 'low') && efforts.some(option => option.value === 'high'), 'Actual Claude model metadata must advertise selectable low/high effort');
  await page.getByTestId('reasoning-effort').selectOption('low');
  await page.locator('.agent-composer > .agent-disclosure input[type="checkbox"]').check();
  return { models, efforts, selectedEffort: 'low' };
}
async function propose(page, argv, cwd, summary, moveWhileRunning) {
  const before = await page.getByTestId('command-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-command-id')));
  const previousTask = await page.getByTestId('agent-status').getAttribute('data-task-id');
  const prompt = `This is an isolated TexyPaper acceptance fixture. Read code/run.py first. Use propose_command once with summary ${JSON.stringify(summary)}, cwd ${JSON.stringify(cwd)}, exact argv ${JSON.stringify(argv)}, timeoutSeconds 120. Respect the current native execution permission. Do not execute by another tool, do not create or change files with propose_changes, and do not poll. If pending, end your turn and wait for the human approval. Explain what the real script does; do not invent its output.`;
  await page.getByTestId('agent-prompt').fill(prompt);
  await page.getByTestId('agent-send').click();
  if (moveWhileRunning) {
    await waitFor(async () => {
      const task = await page.getByTestId('agent-status').getAttribute('data-task-id');
      return task && task !== previousTask && await page.getByTestId('agent-status').getAttribute('data-status') === 'running';
    }, { label: 'native live AI task before moving chat' });
    const task = await page.getByTestId('agent-status').getAttribute('data-task-id');
    const child = await detach(moveWhileRunning);
    assert(await child.getByTestId('agent-status').getAttribute('data-task-id') === task, 'Detaching started a different AI task');
    assert(await child.getByTestId('reasoning-effort').inputValue() === 'low', 'Detached window lost explicitly selected reasoning effort');
    await closeNativeWindow(moveWhileRunning.child.pid, false);
    await waitFor(async () => await nativeWindowOperation(moveWhileRunning.child.pid, 'visible') === 0, { label: 'active AI task hidden to tray without destroying windows' });
    assert(moveWhileRunning.child.exitCode === null && !child.isClosed(), 'Main close terminated the active AI app or chat');
    await nativeWindowOperation(moveWhileRunning.child.pid, 'restore');
    await dock(moveWhileRunning, child);
    assert(await page.getByTestId('agent-status').getAttribute('data-task-id') === task, 'Redocking lost the active AI task');
  }
  let commandId;
  await waitFor(async () => {
    const cards = await page.getByTestId('command-card').evaluateAll(rows => rows.map(row => row.getAttribute('data-command-id')));
    commandId = cards.find(id => id && !before.includes(id));
    if (commandId) return true;
    const status = await page.getByTestId('agent-status').getAttribute('data-status');
    if (status === 'failed') throw new Error((await page.locator('.agent-error').allTextContents()).join('\n'));
    return false;
  }, { timeoutMs: 180000, label: 'real provider command proposal' });
  await waitFor(async () => ['completed', 'failed', 'cancelled'].includes(await page.getByTestId('agent-status').getAttribute('data-status')), { timeoutMs: 180000, label: 'provider turn terminal' });
  assert(await page.getByTestId('agent-status').getAttribute('data-status') === 'completed', 'Provider failed before command acceptance');
  return commandId;
}
const commandCard = (page, id) => page.getByTestId('command-card').and(page.locator(`[data-command-id=${JSON.stringify(id)}]`));
const script = 'import pathlib,sys,time\nname=sys.argv[1]\nif name.startswith(("slow","background")):\n print("RUNNING",flush=True)\n time.sleep(60 if name.startswith("slow") else 8)\npathlib.Path(name+".txt").write_text("executed:"+name,encoding="utf-8")\nprint("STDOUT:"+name,flush=True)\nprint("STDERR:"+name,file=sys.stderr,flush=True)\n';

async function main() {
  const args = parseArgs();
  const run = await createRun(args, 'chat');
  const binary = await requireBinary(args);
  const report = { passed: false, checks: [], models: {}, startedAt: new Date().toISOString() };
  const root = path.join(run.fixtures, 'chat project');
  const second = path.join(run.fixtures, 'other project');
  let desktop, host;
  try {
    for (const directory of [root, second]) {
      await fs.mkdir(path.join(directory, 'code'), { recursive: true });
      await fs.writeFile(path.join(directory, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nChat acceptance fixture.\n\\end{document}\n');
      await fs.writeFile(path.join(directory, 'code/run.py'), script);
    }
    desktop = await launchDesktop({ binary, output: run.output, dataDir: run.dataDir, project: root });
    const page = desktop.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLocalUi(page, root, { alreadyOpen: true });
    await openChat(page);
    const boxes = await page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      return { tree: rect('.explorer'), chat: rect('.inspector-host'), center: rect('.center-panes'), history: rect('[data-testid="agent-history"]') };
    });
    assert(boxes.tree.width > 0 && boxes.chat.x >= boxes.center.x + boxes.center.width, 'Chat must be on the right independently of the visible file tree');
    assert(boxes.history.height >= boxes.chat.height * .45, 'Transcript did not receive the majority of available chat space');
    assert(!await page.getByTestId('agent-provider').isVisible(), 'Provider settings still occupy the default chat');
    assert(!await page.getByTestId('root-document').isVisible(), 'Main document picker still occupies the toolbar by default');
    report.checks.push({ name: 'composer-quick-controls', controls: await quickControlGeometry(page) });
    report.checks.push({ name: 'right-transcript-first-layout', boxes });
    const draft = `Draft survives detachment · 한글 ${randomUUID()}`;
    await page.getByTestId('agent-prompt').fill(draft);
    let child = await detach(desktop);
    assert(await child.getByTestId('agent-prompt').inputValue() === draft, 'Draft lost on detach');
    const denied = await child.evaluate(async () => {
      try { await window.__TAURI_INTERNALS__.invoke('command_permission', {}); return null; }
      catch (error) { return error; }
    });
    assert(denied?.code === 'WINDOW_ROLE_DENIED', 'Detached webview bypassed the main-owned command permission authority');
    report.checks.push({ name: 'detached-native-role-boundary', passed: true });
    await child.getByTestId('agent-prompt').fill(`${draft} edited`);
    await child.screenshot({ path: path.join(run.output, 'detached-light.png') });
    const childSize = await child.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await child.setViewportSize({ width: 360, height: 640 });
    report.checks.push({ name: 'detached-360px-quick-controls', controls: await quickControlGeometry(child) });
    await child.screenshot({ path: path.join(run.output, 'detached-360px.png') });
    await child.setViewportSize(childSize);
    await dock(desktop, child);
    assert(await page.getByTestId('agent-prompt').inputValue() === `${draft} edited`, 'Detached draft lost on redock');
    child = await detach(desktop);
    await closeNativeWindow(desktop.child.pid);
    await waitFor(() => child.isClosed(), { label: 'native close destroys child and returns chat' });
    await page.getByTestId('agent-prompt').waitFor();
    assert(await page.getByTestId('agent-prompt').inputValue() === `${draft} edited`, 'Native close lost draft');
    report.checks.push({ name: 'detach-dock-native-close-draft', passed: true });
    await choosePermission(page, 'session');
    await choosePermission(page, 'deny');
    await choosePermission(page, 'ask');
    await page.getByTestId('settings-button').click();
    await page.getByTestId('ui-locale').selectOption('en');
    await page.getByTestId('ui-theme').selectOption('dark');
    await page.keyboard.press('Escape');
    child = await detach(desktop);
    await waitFor(() => child.evaluate(() => document.documentElement.dataset.theme === 'dark'), { label: 'detached theme synchronized' });
    assert(await child.getByTestId('chat-settings-button').getAttribute('aria-label') === 'AI settings', 'Detached language not synchronized');
    await child.screenshot({ path: path.join(run.output, 'detached-dark.png') });
    await dock(desktop, child);
    await page.setViewportSize({ width: 960, height: 640 });
    await waitFor(async () => await page.locator('.app-shell.compact-layout').count() === 1 && !await page.locator('#ai-tab').isVisible(), { label: 'compact layout closes side panels before user reopens chat' });
    await openChat(page);
    const fit = await page.getByTestId('agent-prompt').boundingBox();
    assert(fit && fit.x >= 0 && fit.x + fit.width <= 960 && fit.y + fit.height <= 640, 'Compact composer clipped');
    await page.screenshot({ path: path.join(run.output, 'compact-dark.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await waitFor(async () => await page.locator('.app-shell:not(.compact-layout)').count() === 1, { label: 'wide layout applied' });
    await openChat(page);
    await page.screenshot({ path: path.join(run.output, 'docked-dark.png') });
    report.checks.push({ name: 'theme-language-and-compact-layout', passed: true });
    if (args.live !== true) throw new Error('LIVE_AGENTS_REQUIRED: --live exercises actual subscription command proposals, not mocked tool responses');
    for (const backend of ['local', 'ssh']) {
      if (backend === 'ssh') {
        host = await startSshSmokeHost({ outputDir: run.output, distribution: args.distribution });
        await host.write('code/run.py', script);
        await connectSshUi(page, host.environment, host.root, { acceptUnknownHost: true });
        await openChat(page);
      }
      report.models[backend] = await configureClaude(page);
      const read = relative => backend === 'local' ? fs.readFile(path.join(root, relative), 'utf8') : host.read(relative);
      const exists = async relative => { try { await read(relative); return true; } catch { return false; } };
      const python = backend === 'local' ? 'python' : 'python3';
      const marker = `${backend}-${randomUUID().replaceAll('-', '')}`;
      await choosePermission(page, 'ask');
      const id = await propose(page, [python, '-u', 'run.py', marker], 'code', `Run ${backend} isolated analysis`, desktop);
      assert(await commandCard(page, id).getAttribute('data-status') === 'pending', 'Ask permission ran before human approval');
      assert(!await exists(`code/${marker}.txt`), 'Command wrote a file before approval');
      child = await detach(desktop);
      await commandCard(child, id).getByTestId('command-approve').click();
      await waitFor(async () => ['completed', 'failed', 'timeout'].includes(await commandCard(child, id).getAttribute('data-status')), { timeoutMs: 60000, label: `${backend} real command completion` });
      assert(await commandCard(child, id).getAttribute('data-status') === 'completed', `Command failed: ${await commandCard(child, id).innerText()}`);
      assert(await read(`code/${marker}.txt`) === `executed:${marker}`, 'Actual host marker does not match approved command');
      assert((await commandCard(child, id).innerText()).includes(`STDOUT:${marker}`) && (await commandCard(child, id).innerText()).includes(`STDERR:${marker}`), 'Actual stdout or stderr missing');
      await child.screenshot({ path: path.join(run.output, `${backend}-command-detached.png`), fullPage: true });
      await dock(desktop, child);
      assert(await commandCard(page, id).getAttribute('data-status') === 'completed', 'Command outcome lost on redock');
      await page.getByTestId('reasoning-effort').selectOption('high');
      const rejected = `${marker}-reject`;
      const rejectId = await propose(page, [python, '-u', 'run.py', rejected], 'code', 'Reject this isolated execution');
      await commandCard(page, rejectId).getByTestId('command-reject').click();
      await waitFor(async () => await commandCard(page, rejectId).getAttribute('data-status') === 'rejected', { label: 'explicit command rejection' });
      assert(!await exists(`code/${rejected}.txt`), 'Rejected command executed');
      await choosePermission(page, 'session');
      const automatic = `${marker}-session`;
      const autoId = await propose(page, [python, '-u', 'run.py', automatic], 'code', 'Run under explicit current-session permission');
      await waitFor(async () => await commandCard(page, autoId).getAttribute('data-status') === 'completed', { timeoutMs: 60000, label: 'session-authorized actual execution' });
      assert(await read(`code/${automatic}.txt`) === `executed:${automatic}`, 'Session permission did not execute the actual host command');
      const slow = `slow-${marker}`;
      const slowId = await propose(page, [python, '-u', 'run.py', slow], 'code', 'Long-running cancellation fixture');
      await waitFor(async () => (await commandCard(page, slowId).innerText()).includes('RUNNING'), { label: 'actual command started before revocation' });
      child = await detach(desktop);
      assert(await commandCard(child, slowId).getAttribute('data-status') === 'running', 'Active execution lost on detach');
      await dock(desktop, child);
      assert(await commandCard(page, slowId).getAttribute('data-status') === 'running', 'Active execution lost on redock');
      await choosePermission(page, 'deny');
      await waitFor(async () => await commandCard(page, slowId).getAttribute('data-status') === 'cancelled', { timeoutMs: 30000, label: 'permission revocation stops owned command' });
      assert(!await exists(`code/${slow}.txt`), 'Revoked command ran to its side effect');
      report.checks.push({ name: `${backend}-live-execution`, passed: true, approved: id, rejected: rejectId, session: autoId, revoked: slowId });
      await choosePermission(page, 'ask');
      const background = `background-${marker}`;
      const backgroundId = await propose(page, [python, '-u', 'run.py', background], 'code', 'Keep this real analysis running after closing the main window');
      child = await detach(desktop);
      await commandCard(child, backgroundId).getByTestId('command-approve').click();
      await waitFor(async () => (await commandCard(child, backgroundId).innerText()).includes('RUNNING'), { label: 'real background command running before close' });
      await closeNativeWindow(desktop.child.pid, false);
      await waitFor(async () => await nativeWindowOperation(desktop.child.pid, 'visible') === 0, { label: 'all owned windows hidden to tray' });
      assert(desktop.child.exitCode === null && !child.isClosed(), 'Closing the main window destroyed the running app');
      await waitFor(async () => await exists(`code/${background}.txt`), { timeoutMs: 30000, label: `${backend} command writes actual host marker while app hidden` });
      assert(await read(`code/${background}.txt`) === `executed:${background}`, 'Background command output differs from approved execution');
      assert(await nativeWindowOperation(desktop.child.pid, 'visible') === 0, 'Background completion unexpectedly reopened a window');
      await nativeWindowOperation(desktop.child.pid, 'restore');
      await waitFor(async () => await commandCard(child, backgroundId).getAttribute('data-status') === 'completed', { label: 'completed command retained on restored chat' });
      await dock(desktop, child);
      report.checks.push({ name: `${backend}-command-continues-while-hidden`, passed: true, id: backgroundId });
      await choosePermission(page, 'session');
      await openLocalUi(page, second);
      await openChat(page);
      assert(await page.getByTestId('execution-permission').inputValue() === 'ask', 'Session permission leaked into another workspace');
      if (backend === 'local') { await openLocalUi(page, root); await openChat(page); }
      report.checks.push({ name: `${backend}-workspace-permission-reset`, passed: true });
    }
    report.passed = true;
  } catch (error) {
    report.error = error.stack || error.message;
    await desktop?.page.screenshot({ path: path.join(run.output, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeJson(path.join(run.output, 'chat-results.json'), report);
    try { await desktop?.close(); } finally { await host?.stop(); }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
