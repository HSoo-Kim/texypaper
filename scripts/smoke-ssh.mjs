import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, requireBinary, createRun, launchDesktop, waitFor, writeJson, assert } from './smoke-support.mjs';
import { startSshSmokeHost } from './ssh-smoke-host.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');

async function workspaceIdentity(page) {
  return page.getByTestId('workspace-identity').evaluateAll((elements) => {
    const element = elements[0];
    return element ? {
      root: element.getAttribute('data-root'),
      environmentId: element.getAttribute('data-environment-id'),
      epoch: Number(element.getAttribute('data-epoch')),
    } : null;
  });
}

async function localWorkspaceIdentity(page, expectedRoot) {
  const identity = await workspaceIdentity(page);
  if (!identity?.root || identity.environmentId !== 'local') return null;
  // Native Windows canonical roots include the extended-length \\?\ prefix.
  // Compare filesystem-resolved identities, not display spelling or case guesses.
  return await fs.realpath(identity.root).catch(() => null) === expectedRoot ? identity : null;
}

async function picker(page) {
  if (!await page.getByTestId('workspace-path').isVisible().catch(() => false)) {
    await page.getByTestId('workspace-switch').click();
  }
  await page.getByTestId('workspace-path').waitFor({ state: 'visible' });
}

export async function openLocalUi(page, root, { alreadyOpen = false } = {}) {
  const expectedRoot = await fs.realpath(root);
  if (!alreadyOpen) {
    await picker(page);
    await page.getByTestId('workspace-environment').selectOption('local');
    await page.getByTestId('workspace-path').fill(root);
    await page.getByTestId('workspace-open').click();
  }
  return await waitFor(async () => {
    const identity = await localWorkspaceIdentity(page, expectedRoot);
    return identity && !await page.getByTestId('workspace-path').isVisible() ? identity : false;
  }, { timeoutMs: 30000, label: `real local workspace opened at ${expectedRoot}` });
}

export async function connectSshUi(page, environment, root, { acceptUnknownHost = false, cancelAuthentication = false, password, expectError, reuse = false } = {}) {
  await picker(page);
  const environments = page.getByTestId('workspace-environment');
  const label = environment.label;
  const existing = environments.locator('option').filter({ hasText: label });
  if (!reuse || await existing.count() === 0) {
    await page.getByTestId('ssh-add').click();
    await page.getByTestId('ssh-label').fill(label);
    await page.getByTestId('ssh-alias').fill(environment.hostAlias || '');
    await page.getByTestId('ssh-config-file').fill(environment.sshConfigFile || '');
    await page.getByTestId('ssh-save').click();
  }
  const value = await environments.locator('option').filter({ hasText: label }).last().getAttribute('value');
  assert(value, `Saved SSH environment missing from real environment picker: ${label}`);
  await environments.selectOption(value);
  await page.getByTestId('workspace-path').fill(root);
  const helper = page.getByTestId('ssh-helper-consent');
  if (await helper.count()) await helper.check();
  const prompts = [];
  const previousIdentity = await workspaceIdentity(page);
  let connectionFailure;
  await page.getByTestId('workspace-open').click();
  await waitFor(async () => {
    const prompt = page.getByTestId('ssh-prompt');
    if (await prompt.isVisible().catch(() => false)) {
      const text = await prompt.innerText();
      if (!prompts.includes(text)) prompts.push(text);
      if (cancelAuthentication) {
        await page.getByTestId('ssh-cancel').click();
      } else if (/fingerprint|authenticity|continue connecting|진위|지문/i.test(text)) {
        if (!acceptUnknownHost) { connectionFailure = `SSH_UNKNOWN_HOST_APPROVAL_REQUIRED: ${text}`; return true; }
        if (!/SHA256:|MD5:/.test(text)) { connectionFailure = 'Unknown-host UI omitted the native host fingerprint'; return true; }
        const answer = page.getByTestId('ssh-answer');
        if (await answer.count()) await answer.fill('yes');
        await page.getByTestId('ssh-submit').click();
      } else {
        if (typeof password !== 'string') { connectionFailure = `SSH_AUTH_PROMPT: ${text}; no fixture credential supplied`; return true; }
        await page.getByTestId('ssh-answer').fill(password);
        await page.getByTestId('ssh-submit').click();
      }
    }
    const body = await page.locator('body').innerText();
    if (expectError && body.includes(expectError)) return true;
    if (cancelAuthentication && prompts.length > 0 && !await prompt.isVisible() && await page.getByTestId('workspace-path').isVisible() && !await page.getByTestId('workspace-open').isDisabled()) return true;
    const identity = await workspaceIdentity(page);
    if (identity?.root === root && identity.environmentId === value && (!previousIdentity || identity.epoch > previousIdentity.epoch) && !await page.getByTestId('workspace-path').isVisible()) return true;
    const errors = (await page.locator('.workspace-picker [role=\"alert\"]').allTextContents()).join('\n');
    if (errors && !await page.getByTestId('workspace-open').isDisabled() && !expectError && !cancelAuthentication) { connectionFailure = errors; return true; }
    return false;
  }, { timeoutMs: 90000, intervalMs: 200, label: expectError || (cancelAuthentication ? 'SSH credential prompt cancellation' : `real SSH workspace ${environment.hostAlias}`) });
  assert(!connectionFailure, `Actual SSH connection failed: ${connectionFailure}`);
  if (expectError) assert((await page.locator('body').innerText()).includes(expectError), `Expected exact SSH failure ${expectError}`);
  if (cancelAuthentication) assert(prompts.length > 0, 'Authentication cancellation did not observe a real native prompt');
  return { prompts, identity: await workspaceIdentity(page) };
}

export async function selectMainDocument(page, value) {
  const root = page.getByTestId('root-document');
  if (!await root.isVisible()) await page.getByRole('button', { name: /^(빌드 옵션|Build options)$/ }).click();
  await root.selectOption(value);
  await waitFor(async () => await root.inputValue() === value, { label: 'manual main document selected in build options' });
  await page.getByRole('button', { name: /^(빌드 옵션|Build options)$/ }).click();
  await root.waitFor({ state: 'hidden' });
}

export async function compileFromUi(page) {
  const root = page.getByTestId('root-document');
  if (await root.count() && await root.inputValue() !== 'main.tex') {
    await selectMainDocument(page, 'main.tex');
    await waitFor(async () => await root.inputValue() === 'main.tex', { label: 'explicit main TeX root selection persisted' });
  }
  const before = await page.getByTestId('build-status').getAttribute('data-build-id').catch(() => null);
  const previousSequence = await page.getByTestId('build-status').getAttribute('data-sequence');
  assert(previousSequence !== null, 'Build UI must expose its actual completion sequence');
  await page.keyboard.press('Control+Shift+B');
  let failure, observed;
  try {
    await waitFor(async () => {
      const status = page.getByTestId('build-status');
      const state = await status.getAttribute('data-status');
      const sequence = await status.getAttribute('data-sequence');
      const completed = sequence !== previousSequence;
      observed = { state, sequence, previousSequence, buildId: await status.getAttribute('data-build-id'), alerts: (await page.getByRole('alert').allInnerTexts()).join(' | ').slice(0, 600) };
      const body = await page.locator('body').innerText();
      if (completed && (state === 'failed' || /BUILD_FAILED|BUILD_TIMEOUT|TEX_TOOL_MISSING|TOOL_MISSING/.test(body))) { failure = body.slice(-12000); return true; }
      return completed && state === 'published' && Boolean(await status.getAttribute('data-build-id'));
    }, { timeoutMs: 150000, label: 'actual host latexmk publication' });
  } catch (error) { throw new Error(`${error.message}; last observed build status ${JSON.stringify(observed)}`); }
  assert(!failure, `REAL_COMPILE_FAILED: ${failure}`);
  const buildId = await page.getByTestId('build-status').getAttribute('data-build-id');
  return { beforeBuildId: before, buildId, sequence: await page.getByTestId('build-status').getAttribute('data-sequence') };
}

async function openFile(page, relative) {
  // Prefer the exact normalized path, never choose an unrelated basename match.
  await page.locator(`[role="treeitem"][data-path=${JSON.stringify(relative)}]`).dblclick();
  await page.locator('.cm-content[contenteditable="true"]').waitFor({ state: 'visible' });
}

async function replaceEditor(page, text) {
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
  await page.keyboard.press('Control+S');
}

async function remoteMutations(page, host) {
  const original = await host.read('rename-me.tex');
  const renamed = 'renamed remote.tex';
  const row = (relative) => page.locator(`[role="treeitem"][data-path=${JSON.stringify(relative)}]`);
  const observedDialogs = [];
  let dialogError;
  const renamePrompt = async (dialog) => {
    try {
      assert(dialog.type() === 'prompt', `Rename expected a native prompt, received ${dialog.type()}`);
      observedDialogs.push({ type: dialog.type(), message: dialog.message() });
      await dialog.accept(renamed);
    } catch (error) { dialogError = error; await dialog.dismiss().catch(() => {}); }
  };
  page.once('dialog', renamePrompt);
  await row('rename-me.tex').click();
  await page.getByTestId('file-tree').focus();
  await page.keyboard.press('F2');
  await waitFor(async () => {
    if (dialogError) throw dialogError;
    return await host.read(renamed) === original;
  }, { label: 'real remote rename to a space-containing filename' });
  const confirmRestore = async (dialog) => {
    try {
      assert(dialog.type() === 'confirm', `Trash expected native confirmation, received ${dialog.type()}`);
      observedDialogs.push({ type: dialog.type(), message: dialog.message() });
      if (observedDialogs.length === 2) assert(dialog.message().includes(renamed), 'Destructive confirmation did not name its target');
      else {
        const missing = await host.read(renamed).then(() => false, () => true);
        assert(missing, 'Trash action did not remove the actual project path before Restore');
        const trash = await host.list('.texypaper/trash');
        assert(trash.some((name) => name.endsWith(renamed)), 'Remote trash journal does not retain the original file');
      }
      await dialog.accept();
    } catch (error) { dialogError = error; await dialog.dismiss().catch(() => {}); }
  };
  page.on('dialog', confirmRestore);
  try {
    await row(renamed).click();
    await page.getByTestId('file-tree').focus();
    await page.keyboard.press('Delete');
    await waitFor(async () => {
      if (dialogError) throw dialogError;
      return observedDialogs.length === 3 && await host.read(renamed) === original;
    }, { timeoutMs: 30000, label: 'real remote project trash and restore' });
  } finally { page.off('dialog', confirmRestore); }
  await row(renamed).click({ button: 'right' });
  const createPrompt = async (dialog) => {
    try {
      assert(dialog.type() === 'prompt', 'Create file must use the actual path prompt');
      observedDialogs.push({ type: dialog.type(), message: dialog.message() });
      await dialog.accept('created remote.tex');
    } catch (error) { dialogError = error; await dialog.dismiss().catch(() => {}); }
  };
  page.once('dialog', createPrompt);
  await page.getByTestId('context-create-file').click();
  await waitFor(async () => {
    if (dialogError) throw dialogError;
    return await host.read('created remote.tex') === '';
  }, { label: 'real remote create file' });
  return { name: 'remote-create-rename-trash-restore', sha256: sha(original), observedDialogs };
}

async function main() {
  const args = parseArgs();
  const run = await createRun(args, 'ssh');
  const report = { passed: false, scenarios: [], startedAt: new Date().toISOString() };
  let host, desktop;
  try {
    const binary = await requireBinary(args);
    host = await startSshSmokeHost({ outputDir: run.output, distribution: args.distribution });
    desktop = await launchDesktop({ binary, output: run.output, dataDir: run.dataDir });
    const { page } = desktop;
    const direct = await connectSshUi(page, host.environment, host.root, { acceptUnknownHost: true });
    assert(direct.prompts.some((text) => /fingerprint|authenticity|continue connecting|진위|지문/i.test(text)), 'Fresh known_hosts connection did not request explicit host approval');
    assert(host.events.some((event) => event.kind === 'worker-start'), 'No actual Python worker process was started through SSH');
    report.scenarios.push({ name: 'literal-alias-native-host-approval', prompts: direct.prompts, environment: host.environment, probe: host.probe });
    await page.screenshot({ path: path.join(run.output, 'ssh-connected.png'), fullPage: true });
    report.scenarios.push(await remoteMutations(page, host));
    await openFile(page, 'main.tex');
    const original = await host.read('main.tex');
    const updated = original.replace('TexyPaper remote evidence starts here.', `TexyPaper remote evidence was edited through SSH ${randomUUID()}.`);
    await replaceEditor(page, updated);
    await waitFor(async () => await host.read('main.tex') === updated, { timeoutMs: 30000, label: 'real remote hash-checked source save' });
    report.scenarios.push({ name: 'remote-read-edit-save', beforeSha256: sha(original), afterSha256: sha(updated) });
    const build = await compileFromUi(page);
    const published = (await host.list()).filter((name) => /\/published\/[^/]+\/manifest\.json$/.test(name));
    assert(published.length > 0, 'GUI build did not publish any actual remote manifest');
    const manifests = await Promise.all(published.map(async (name) => ({ name, value: JSON.parse(await host.read(name)) })));
    const manifest = manifests.find((item) => item.value.buildId === build.buildId);
    assert(manifest, `UI build ${build.buildId} does not match immutable remote published manifest`);
    assert(manifest.value.mappingReady === true && manifest.value.pdfSha256 && manifest.value.syncSha256, 'Actual remote build lacks edit-grade matching PDF/SyncTeX manifest');
    const pdfText = page.locator('.textLayer');
    await waitFor(async () => (await pdfText.allTextContents()).join(' ').includes('TexyPaper remote evidence'), { timeoutMs: 60000, label: 'actual remote PDF text layer rendered' });
    report.scenarios.push({ name: 'real-remote-latexmk-and-artifacts', build, manifest: manifest.value });
    // Source -> PDF is the production SyncTeX action, not a fabricated RPC reply.
    const forwardBefore = host.events.filter((event) => event.kind === 'worker-reply' && event.op === 'synctex_view' && event.ok).length;
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Control+Alt+J');
    await waitFor(() => host.events.filter((event) => event.kind === 'worker-reply' && event.op === 'synctex_view' && event.ok).length > forwardBefore, { timeoutMs: 30000, label: 'actual remote forward SyncTeX match on Unicode root' });
    const span = pdfText.locator('span').filter({ hasText: 'TexyPaper remote evidence' }).first();
    const bounds = await span.boundingBox();
    assert(bounds && bounds.width > 20, 'Actual PDF prose text has no selectable geometry');
    const inverseBefore = host.events.filter((event) => event.kind === 'worker-reply' && event.op === 'synctex_edit' && event.ok).length;
    await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + Math.min(bounds.width - 2, 190), bounds.y + bounds.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.getByTestId('pdf-selection-view-source').click();
    await waitFor(() => host.events.filter((event) => event.kind === 'worker-reply' && event.op === 'synctex_edit' && event.ok).length > inverseBefore, { timeoutMs: 30000, label: 'real selected PDF prose resolves through remote inverse SyncTeX' });
    report.scenarios.push({ name: 'remote-unicode-forward-and-inverse-synctex', records: host.events.filter((event) => event.kind === 'worker-reply' && ['synctex_view', 'synctex_edit'].includes(event.op)) });
    await page.screenshot({ path: path.join(run.output, 'ssh-compiled.png'), fullPage: true });
    // Same byte length, changed content: metadata alone cannot protect this save.
    await openFile(page, 'conflict.tex');
    const conflictBase = await host.read('conflict.tex');
    const external = conflictBase.replace('original', 'external');
    assert(Buffer.byteLength(conflictBase) === Buffer.byteLength(external), 'Conflict fixture must keep byte length exactly equal');
    await host.write('conflict.tex', external);
    await replaceEditor(page, `${conflictBase}% local edit held for conflict\n`);
    await waitFor(async () => /FILE_CONFLICT/.test(await page.locator('body').innerText()), { timeoutMs: 15000, label: 'same-size external remote conflict detected' });
    assert(await host.read('conflict.tex') === external, 'SAFETY FAILURE: remote same-size conflict was overwritten');
    const reloadPrompt = page.waitForEvent('dialog');
    const reloadClick = page.getByTestId('file-reload').click();
    const consent = await reloadPrompt;
    assert(consent.type() === 'confirm', 'Reload must ask before discarding the conflicted buffer.');
    await consent.accept(); await reloadClick;
    await waitFor(async () => await page.getByTestId('file-reload').count() === 0 && (await page.locator('.cm-content').innerText()).includes(external.trim()), { label: 'approved reload acknowledged the current remote revision' });
    report.scenarios.push({ name: 'same-size-remote-hash-conflict', expected: sha(conflictBase), actual: sha(external) });
    const uncertainContent = `${external}% uncertain committed write ${randomUUID()}\n`;
    const oldEpoch = await page.getByTestId('workspace-identity').getAttribute('data-epoch');
    host.armDropReply('save_text');
    await replaceEditor(page, uncertainContent);
    await waitFor(() => host.events.some((event) => event.kind === 'dropped-real-reply' && event.op === 'save_text'), { timeoutMs: 30000, label: 'real save committed then transport reply interrupted' });
    const dropped = host.events.findLast((event) => event.kind === 'dropped-real-reply' && event.op === 'save_text');
    assert(dropped.transactionId, 'Actual save request omitted its recovery transaction identity');
    assert(await host.read('conflict.tex') === uncertainContent, 'Fault was not injected after a genuine successful remote save');
    const journalPath = `.texypaper/transactions/${dropped.transactionId}/journal.json`;
    const committedJournal = JSON.parse(await host.read(journalPath));
    assert(committedJournal.status === 'committed', 'Interrupted reply lacks a durable committed transaction journal');
    await waitFor(async () => (await page.locator('body').innerText()).includes('SSH_DISCONNECTED'), { timeoutMs: 30000, label: 'real transport EOF disconnect state' });
    assert(await pdfText.count() > 0, 'Disconnect discarded the last good PDF');
    const writesBeforeReconnect = host.events.filter((event) => event.kind === 'worker-request' && event.op === 'save_text').length;
    await connectSshUi(page, host.environment, host.root, { reuse: true });
    await waitFor(() => host.events.some((event) => event.kind === 'worker-reply' && event.op === 'transaction_status' && event.transactionId === dropped.transactionId && event.ok), { timeoutMs: 30000, label: 'explicit reconnect queries uncertain native transaction status' });
    assert(await page.getByTestId('workspace-identity').getAttribute('data-epoch') !== oldEpoch, 'Reconnect failed to establish a new workspace epoch');
    assert(await host.read('conflict.tex') === uncertainContent, 'Reconnect changed uncertain committed bytes');
    assert(host.events.filter((event) => event.kind === 'worker-request' && event.op === 'save_text').length === writesBeforeReconnect, 'Reconnect replayed a potentially completed write');
    report.scenarios.push({ name: 'disconnect-retains-pdf-and-resolves-journal-without-replay', dropped, journal: committedJournal });
    await connectSshUi(page, host.proxyEnvironment, host.root, { acceptUnknownHost: true });
    assert(host.events.some((event) => event.kind === 'proxy-forward'), 'ProxyJump did not create a real SSH direct-tcpip forwarding channel');
    await openFile(page, 'main.tex');
    const proxySource = await host.read('main.tex');
    const proxyEdit = proxySource.replace('sample count is 128', 'sample count remains 128');
    await replaceEditor(page, proxyEdit);
    await waitFor(async () => await host.read('main.tex') === proxyEdit, { timeoutMs: 30000, label: 'ProxyJump remote real save' });
    await compileFromUi(page);
    report.scenarios.push({ name: 'proxyjump-real-worker-save-compile' });
    const busySource = proxyEdit.replace('\\end{document}', '\\newcount\\smokecounter\\smokecounter=0\\loop\\advance\\smokecounter by1\\ifnum\\smokecounter<100000000\\repeat\n\\end{document}');
    await replaceEditor(page, busySource);
    await waitFor(async () => await host.read('main.tex') === busySource, { label: 'real remote busy build fixture saved' });
    await page.keyboard.press('Control+Shift+B');
    let interruptedJobs;
    await waitFor(async () => { interruptedJobs = await host.ownedJobs(); return interruptedJobs.length > 0; }, { timeoutMs: 30000, intervalMs: 250, label: 'actual remote TeX descendant running before disconnect' });
    await host.dropConnections();
    await waitFor(async () => (await host.ownedJobs()).length === 0, { timeoutMs: 15000, intervalMs: 500, label: 'SSH EOF kills only owned remote compile process group' });
    await waitFor(async () => (await page.locator('body').innerText()).includes('SSH_DISCONNECTED'), { timeoutMs: 30000, label: 'disconnect during actual remote compilation' });
    assert(await pdfText.count() > 0, 'Interrupted compile discarded the previous real PDF');
    await host.write('main.tex', proxyEdit);
    report.scenarios.push({ name: 'disconnect-during-build-cleans-owned-tex-group', interruptedJobs, remainingJobs: await host.ownedJobs() });
    const passEnv = { ...host.environment, id: `password-${randomUUID()}`, label: 'SSH password cancel fixture', hostAlias: 'TexyPaperSmokePassword' };
    const cancelledPassword = await connectSshUi(page, passEnv, host.root, { cancelAuthentication: true });
    report.scenarios.push({ name: 'native-password-prompt-cancellation', prompts: cancelledPassword.prompts });
    const encryptedEnv = { ...host.environment, id: `encrypted-${randomUUID()}`, label: 'SSH passphrase cancel fixture', hostAlias: 'TexyPaperSmokeEncrypted' };
    const cancelledPassphrase = await connectSshUi(page, encryptedEnv, host.root, { cancelAuthentication: true });
    report.scenarios.push({ name: 'native-key-passphrase-cancellation', prompts: cancelledPassphrase.prompts });
    await host.rotateHostKey();
    await connectSshUi(page, host.environment, host.root, { reuse: true, expectError: 'SSH_HOST_KEY_CHANGED' });
    report.scenarios.push({ name: 'changed-host-key-hard-rejection' });
    await page.screenshot({ path: path.join(run.output, 'ssh-host-key-changed.png'), fullPage: true });
    report.passed = true;
  } catch (error) {
    report.error = error.stack || error.message;
    if (desktop) await desktop.page.screenshot({ path: path.join(run.output, 'ssh-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    if (host) report.transportEvents = host.events;
    try { await writeJson(path.join(run.output, 'ssh.json'), report); }
    finally { try { await desktop?.close(); } finally { await host?.stop(); } }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
