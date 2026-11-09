// Real SSH transport and hidden Tauri app; no user project, profile, clipboard or physical tray input.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert, createRun, launchDesktop, parseArgs, requireBinary, waitFor, writeJson } from './smoke-support.mjs';
import { connectSshUi } from './smoke-ssh.mjs';
import { startSshSmokeHost } from './ssh-smoke-host.mjs';

const args = parseArgs();
const run = await createRun(args, 'ssh-exit');
const report = { passed: false, scenarios: [], trayMenu: 'not exercised: no physical desktop interaction' };
let host, app;
const ended = child => child.exitCode !== null || child.signalCode !== null;
const quitEvent = page => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', {
  target: { kind: 'AnyLabel', label: 'main' }, event: 'texypaper:quit-requested', payload: null,
}));
try {
  const binary = await requireBinary(args);
  host = await startSshSmokeHost({ outputDir: run.output, distribution: args.distribution });
  app = await launchDesktop({ binary, ...run });
  let page = app.page;
  await page.setViewportSize({ width: 1440, height: 900 });
  await connectSshUi(page, host.environment, host.root, { acceptUnknownHost: true });
  await page.locator('[role="treeitem"][data-path="main.tex"]').dblclick();
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await editor.waitFor({ state: 'visible' });
  const original = await host.read('main.tex');
  const marker = `% offline-recovery-${randomUUID()}`;
  await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(`\n${marker}\n`);
  const ime = await page.context().newCDPSession(page);
  await ime.send('Input.imeSetComposition', { text: '보류', selectionStart: 2, selectionEnd: 2 });
  await waitFor(async () => (await page.locator('.file-tabs [role="tab"][aria-selected="true"]').innerText()).includes('●'), { label: 'synthetic unsaved buffer' });

  // This sends the same Tauri event as the tray callback. It verifies the guarded
  // path in the real app, not physical Windows notification-area interaction.
  await quitEvent(page);
  let dirty = page.getByRole('alertdialog', { name: /^(저장하지 않은 변경|Unsaved changes)$/ });
  await dirty.waitFor({ state: 'visible' });
  await host.dropConnections();
  await waitFor(async () => (await page.locator('body').innerText()).includes('SSH_DISCONNECTED'), { timeoutMs: 30000, label: 'real transport disconnect while the quit guard is open' });
  assert(await host.read('main.tex') === original, 'Disconnected unsaved text unexpectedly reached the remote fixture.');
  await dirty.getByRole('button', { name: /^(변경 버리기|Discard changes)$/ }).click();
  const offline = page.getByRole('alertdialog', { name: /^(SSH 연결이 끊긴 상태에서 종료|Exit with SSH disconnected)$/ });
  await offline.waitFor({ state: 'visible' });
  assert(/서버 작업이 계속될 수|may continue after the app exits/.test(await offline.innerText()), 'The remote-work uncertainty must be disclosed.');
  await offline.getByRole('button', { name: /^(취소|Cancel)$/ }).click();
  await offline.waitFor({ state: 'hidden' });
  assert(!ended(app.child), 'Cancelling offline exit must keep the process running.');
  assert((await page.locator('.cm-content').innerText()).includes(marker), 'Cancelling offline exit lost the dirty buffer after Discard was selected.');
  assert((await page.locator('.file-tabs [role="tab"][aria-selected="true"]').innerText()).includes('●'), 'Cancelling offline exit must leave the buffer dirty.');
  assert(await host.read('main.tex') === original, 'Cancelling offline exit changed the remote source.');
  report.scenarios.push({ name: 'cancel-after-late-disconnect-preserves-dirty-buffer', passed: true });

  await page.locator('.cm-content').click(); await ime.send('Input.insertText', { text: '보류' }); await ime.detach();
  await waitFor(async () => (await page.getByTestId('workspace-switch').getAttribute('title')).includes('연결 끊김'), { timeoutMs: 30000, label: 'buffer marks disconnected after failed autosave' });
  await quitEvent(page);
  await offline.waitFor({ state: 'visible' });
  await offline.getByRole('button', { name: /^(계속 종료|Exit anyway)$/ }).click();
  dirty = page.getByRole('alertdialog', { name: /^(저장하지 않은 변경|Unsaved changes)$/ });
  await dirty.waitFor({ state: 'visible' });
  await dirty.getByRole('button', { name: /^(복구본 남기고 종료|Keep recovery copy and exit)$/ }).click();
  await waitFor(() => ended(app.child), { timeoutMs: 45000, label: 'disconnected native app exits after keeping recovery' });
  assert(app.child.exitCode === 0, `Offline exit failed: ${app.child.exitCode}/${app.child.signalCode}`);
  assert(await host.read('main.tex') === original, 'Offline exit unexpectedly wrote remote source.');
  report.scenarios.push({ name: 'disconnected-quit-keeps-recovery-and-exits', passed: true, exitCode: app.child.exitCode });
  await app.close(); app = null;

  const restart = path.join(run.output, 'restart'); await fs.mkdir(restart);
  app = await launchDesktop({ binary, output: restart, dataDir: run.dataDir }); page = app.page;
  await page.setViewportSize({ width: 1440, height: 900 });
  await connectSshUi(page, host.environment, host.root, { reuse: true });
  await page.locator('[role="treeitem"][data-path="main.tex"]').dblclick();
  await waitFor(async () => (await page.locator('.cm-content').innerText()).includes(marker), { timeoutMs: 30000, label: 'unsaved synthetic text recovered after SSH reconnect' });
  assert(await host.read('main.tex') === original, 'Recovery must not silently overwrite the remote source.');
  report.scenarios.push({ name: 'restart-reconnect-recovers-without-remote-overwrite', passed: true });

  await page.keyboard.press('Control+Shift+q');
  dirty = page.getByRole('alertdialog', { name: /^(저장하지 않은 변경|Unsaved changes)$/ });
  await dirty.waitFor({ state: 'visible' });
  await dirty.getByRole('button', { name: /^(변경 버리기|Discard changes)$/ }).click();
  await waitFor(() => ended(app.child), { timeoutMs: 45000, label: 'connected exit still honors explicit discard' });
  assert(app.child.exitCode === 0, `Connected exit failed: ${app.child.exitCode}/${app.child.signalCode}`);
  assert(await host.read('main.tex') === original, 'Explicit discard wrote the synthetic remote source.');
  report.scenarios.push({ name: 'connected-quit-still-honors-discard', passed: true });
  report.passed = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  if (app && !app.page.isClosed()) await app.page.screenshot({ path: path.join(run.output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  try { await writeJson(path.join(run.output, 'ssh-exit-results.json'), report); }
  finally { try { await app?.close(); } finally { await host?.stop(); } }
}
console.log(JSON.stringify({ passed: report.passed, scenarios: report.scenarios.length, report: path.join(run.output, 'ssh-exit-results.json') }));
