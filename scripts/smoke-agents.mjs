import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, requireBinary, createRun, launchDesktop, waitFor, writeJson, assert } from './smoke-support.mjs';
import { startSshSmokeHost } from './ssh-smoke-host.mjs';
import { connectSshUi, openLocalUi, compileFromUi } from './smoke-ssh.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function providerProcesses(appPid) {
  if (!Number.isSafeInteger(appPid) || appPid < 1) throw new Error('Process ownership evidence requires launched app PID');
  const code = `$all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine); $ids=[System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${appPid}); do {$changed=$false; foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){$changed=$true}}}while($changed); $result=@($all | Where-Object {$ids.Contains([int]$_.ProcessId) -and ($_.Name -match '^(codex|claude|node)([.]exe)?$' -or $_.CommandLine -match '--mcp-stdio|--ssh-askpass')} | Select-Object ProcessId,ParentProcessId,Name,@{Name='Mode';Expression={if($_.CommandLine -match '--mcp-stdio'){'mcp'}elseif($_.CommandLine -match '--ssh-askpass'){'askpass'}else{'provider'}}}); ConvertTo-Json -Compress -InputObject $result`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Provider process inspection timed out')); }, 15000);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (exit) => { clearTimeout(timer); if (exit !== 0) reject(new Error(`Provider process evidence failed: ${stderr}`)); else { try { resolve(JSON.parse(stdout.trim() || '[]')); } catch (error) { reject(error); } } });
  });
}

async function screenshot(page, output, name) {
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
}

async function assistantTurn(page, taskId) {
  assert(taskId, 'Evidence must be bound to a real provider task');
  const view = page.getByTestId('agent-history');
  const original = await view.evaluate((element) => ({ top: element.scrollTop, height: element.clientHeight, total: element.scrollHeight }));
  assert(original.height > 0, 'Actual agent history viewport is not visible');
  const parts = new Set();
  const step = Math.max(50, original.height - 24);
  assert(Math.ceil(original.total / step) <= 5000, 'Agent UI history exceeded its bounded rendered-history policy');
  try {
    for (let top = 0; top <= original.total; top += step) {
      await view.evaluate((element, position) => { element.scrollTop = position; }, top);
      await delay(50);
      for (const text of await view.locator(`article.agent-message-assistant[data-task-id=${JSON.stringify(taskId)}]`).allInnerTexts()) parts.add(text);
    }
  } finally {
    await view.evaluate((element, position) => { element.scrollTop = position; }, original.top);
  }
  return [...parts].join('\n');
}

export async function exerciseAgent({ page, provider, readSource, writeSource, output, backend = 'local', authTimeoutMs = 0, resume = true, appPid }) {
  assert(provider === 'codex' || provider === 'claude', 'Only actual Codex and Claude subscription providers are supported');
  const result = { provider, backend, passed: false, checks: [], startedAt: new Date().toISOString() };
  const report = path.join(output, `agent-${provider}-${backend}.json`);
  await fs.mkdir(output, { recursive: true });
  try {
    const agentTab = page.getByRole('tab', { name: /AI|에이전트/ }).first();
    if (!await agentTab.isVisible()) await page.getByRole('button', { name: /^(AI 및 댓글 패널|AI and comments panel)$/ }).click();
    if (await agentTab.count()) await agentTab.click();
    if (!await page.getByTestId('agent-provider').isVisible()) await page.getByTestId('chat-settings-button').click();
    await page.getByTestId('agent-provider').selectOption(provider);
    const auth = page.getByTestId('provider-auth-status');
    await auth.waitFor({ state: 'visible', timeout: 15000 });
    await waitFor(async () => await auth.getAttribute('data-provider') === provider && ['ready', 'loginRequired', 'unavailable'].includes(await auth.getAttribute('data-status')), { label: `${provider} official auth status` });
    if (await auth.getAttribute('data-status') !== 'ready' && authTimeoutMs > 0) {
      console.error(`${provider}: complete the official subscription login in the release UI within ${authTimeoutMs / 1000}s. No token files will be copied.`);
      await waitFor(async () => await auth.getAttribute('data-status') === 'ready', { timeoutMs: authTimeoutMs, label: `${provider} official subscription login` });
    }
    const authText = await auth.innerText();
    const authCode = await auth.getAttribute('data-code') || (await auth.getAttribute('data-status') === 'unavailable' ? 'PROVIDER_UNAVAILABLE' : 'AUTH_REQUIRED/SUBSCRIPTION_REQUIRED');
    assert(await auth.getAttribute('data-status') === 'ready', `${provider} ${authCode}: ${authText}. Use official TexyPaper provider login; Codex requires its isolated CODEX_HOME ChatGPT login, Claude requires claude.ai subscription authentication.`);
    result.auth = { status: 'ready', text: authText };
    await page.getByTestId('chat-settings-back').click();
    const metrics = await readSource('results/metrics.csv');
    const code = await readSource('code/analysis.py');
    const numericEvidence = [...metrics.matchAll(/(?:^|,)(\d+\.\d+)(?=,|\s|$)/gm)].map((match) => match[1]);
    assert(numericEvidence.length > 0, 'Synthetic metrics fixture has no measured numeric evidence');
    result.evidence = { codeSha256: sha(code), metricsSha256: sha(metrics), values: numericEvidence };
    const initial = await readSource('main.tex');
    const evidenceDir = path.join(output, `${provider}-${backend}-evidence`);
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, 'before.tex'), initial);
    await fs.writeFile(path.join(evidenceDir, 'analysis.py'), code);
    await fs.writeFile(path.join(evidenceDir, 'metrics.csv'), metrics);
    const status = page.getByTestId('agent-status');
    const prompt = page.getByTestId('agent-prompt');
    async function send(text) {
      const previousTask = await status.getAttribute('data-task-id');
      await prompt.fill(text);
      await page.getByTestId('agent-send').click();
      await waitFor(async () => {
        const task = await status.getAttribute('data-task-id');
        return Boolean(task) && task !== previousTask && ['running', 'completed', 'failed'].includes(await status.getAttribute('data-status'));
      }, { timeoutMs: 30000, label: `${provider} fresh task accepted` });
    }
    async function completed() {
      await waitFor(async () => ['completed', 'failed', 'cancelled'].includes(await status.getAttribute('data-status')), { timeoutMs: 20 * 60 * 1000 + 15000, label: `${provider} authoritative turn completion` });
      assert(await status.getAttribute('data-status') === 'completed', `${provider} turn failed: ${await status.innerText()} ${(await page.locator('.agent-error').allTextContents()).join('\n')}`);
    }
    async function proposal(text, previousIds = []) {
      await send(text);
      const taskId = await status.getAttribute('data-task-id');
      assert(taskId, 'Current provider task lacks its native identity');
      await waitFor(async () => {
        const cards = page.getByTestId('proposal-card').and(page.locator(`[data-provider="${provider}"][data-task-id=${JSON.stringify(taskId)}]`));
        for (let i = 0; i < await cards.count(); i++) {
          const card = cards.nth(i);
          if (await card.getAttribute('data-status') === 'pending' && !previousIds.includes(await card.getAttribute('data-proposal-id'))) return true;
        }
        if (['completed', 'failed', 'cancelled'].includes(await status.getAttribute('data-status'))) return true;
        return false;
      }, { timeoutMs: 20 * 60 * 1000 + 15000, label: `${provider} real MCP proposal` });
      await completed();
      const cards = page.getByTestId('proposal-card').and(page.locator(`[data-provider="${provider}"][data-task-id=${JSON.stringify(taskId)}]`));
      for (let i = 0; i < await cards.count(); i++) {
        const card = cards.nth(i);
        if (await card.getAttribute('data-status') === 'pending' && !previousIds.includes(await card.getAttribute('data-proposal-id'))) return card;
      }
      throw new Error('Pending proposal vanished before native approval');
    }
    const nonce = randomUUID();
    const marker = `TexyPaperSmoke${nonce.replaceAll('-', '')}`;
    const instruction = `This is an isolated TexyPaper release smoke on the ${backend} backend. Read code/analysis.py and results/metrics.csv using TexyPaper tools, cite both real file paths with line ranges in your visible reply, and report the actual measured metric without inventing results. Read main.tex, then propose exactly one small valid LaTeX prose paragraph in main.tex before \\end{document}. Include the plain marker TexyPaperSmoke${nonce.replaceAll('-', '')} in the paragraph and preserve all existing content. Use propose_changes only; do not claim the files were applied. Wait for human Apply. Never modify other paths.`;
    const first = await proposal(instruction);
    const firstId = await first.getAttribute('data-proposal-id');
    assert((await first.innerText()).includes('main.tex'), 'Proposal review does not identify main.tex');
    assert(await readSource('main.tex') === initial, 'SAFETY FAILURE: provider modified source before user Apply');
    const firstTaskId = await first.getAttribute('data-task-id');
    const history = await assistantTurn(page, firstTaskId);
    await fs.writeFile(path.join(evidenceDir, 'first-turn.txt'), history);
    assert(history.includes('code/analysis.py') && history.includes('results/metrics.csv'), 'Provider did not cite actual evidence paths');
    assert(numericEvidence.some((value) => history.includes(value)), 'Provider output did not report the actual measured metric');
    assert(/analysis\.py[^\n]*(?::\d|line|줄|L\d)/i.test(history) && /metrics\.csv[^\n]*(?::\d|line|줄|L\d)/i.test(history), 'Provider evidence lacks line ranges for both inspected files');
    result.checks.push({ name: 'evidence-and-no-write-before-approval', proposalId: firstId, sourceSha256: sha(initial) });
    await screenshot(page, output, `${provider}-${backend}-pending`);
    await first.getByTestId('proposal-apply').click();
    await waitFor(async () => await first.getAttribute('data-status') === 'applied', { timeoutMs: 60000, label: `${provider} approved native transaction` });
    const applied = await readSource('main.tex');
    assert(applied !== initial && applied.includes(marker), 'Applied proposal did not change actual source with requested marker');
    await fs.writeFile(path.join(evidenceDir, 'applied.tex'), applied);
    assert(await readSource('code/analysis.py') === code && await readSource('results/metrics.csv') === metrics, 'SAFETY FAILURE: provider modified read-only experimental evidence');
    result.checks.push({ name: 'approved-real-source-write', before: sha(initial), after: sha(applied) });
    await compileFromUi(page);
    // Only visible pages keep a text layer; the provider may place the paragraph on any page (e.g. after \newpage),
    // so find it with the app's own PDF search and jump there before checking the rendered text layer.
    await page.getByRole('textbox', { name: /^(PDF 텍스트 검색|Search PDF text)$/ }).fill(marker.slice(0, 24));
    await page.locator('.pdf-search').getByRole('button', { name: /^(검색|Search)$/ }).click();
    const hit = page.locator('.pdf-search-results button').filter({ hasText: marker.slice(0, 14) }).first();
    await hit.waitFor({ state: 'visible', timeout: 120000 });
    await hit.click();
    const textLayer = page.locator('.textLayer');
    await waitFor(async () => (await textLayer.allTextContents()).join('').replace(/\s+/g, '').includes(marker), { timeoutMs: 120000, label: 'this approved turn appears in actual newly compiled PDF text layer' });
    result.checks.push({ name: 'compiled-pdf-reflects-approved-source' });
    await screenshot(page, output, `${provider}-${backend}-applied`);
    const second = await proposal('Read the current main.tex and propose one additional short literal prose sentence in main.tex only, using a unique replacement. This proposal will be rejected by the user; do not apply it.', [firstId]);
    const secondId = await second.getAttribute('data-proposal-id');
    const beforeReject = await readSource('main.tex');
    await second.getByTestId('proposal-reject').click();
    await waitFor(async () => await second.getAttribute('data-status') === 'rejected', { label: 'native proposal rejected' });
    assert(await readSource('main.tex') === beforeReject, 'SAFETY FAILURE: rejected proposal changed source');
    result.checks.push({ name: 'reject-does-not-write', proposalId: secondId, sha256: sha(beforeReject) });
    const third = await proposal('Read current main.tex afresh and propose one additional literal prose sentence in main.tex only. Leave it waiting for human approval.', [firstId, secondId]);
    const thirdId = await third.getAttribute('data-proposal-id');
    const beforeConflict = await readSource('main.tex');
    const external = `${beforeConflict}\n% external smoke edit ${randomUUID()}\n`;
    await writeSource('main.tex', external);
    await third.getByTestId('proposal-apply').click();
    await waitFor(async () => await third.getAttribute('data-status') === 'conflicted', { timeoutMs: 30000, label: 'stale proposal hash conflict' });
    assert(await readSource('main.tex') === external, 'SAFETY FAILURE: conflicted proposal overwrote external bytes');
    await fs.writeFile(path.join(evidenceDir, 'conflict-external.tex'), external);
    result.checks.push({ name: 'stale-proposal-no-write', proposalId: thirdId, sha256: sha(external) });
    await third.getByTestId('proposal-reject').click();
    await send('Read the neighboring code and results again, then explain the evidence and limitations in detailed prose without proposing any changes. Do not use shell tools.');
    await waitFor(async () => await status.getAttribute('data-status') === 'running', { timeoutMs: 30000, label: 'live task running before cancellation' });
    const runningProcesses = appPid ? await providerProcesses(appPid) : undefined;
    if (appPid) assert(runningProcesses.length > 0, 'No owned actual provider process observed during live turn');
    await page.getByTestId('agent-cancel').click();
    await waitFor(async () => await status.getAttribute('data-status') === 'cancelled', { timeoutMs: 15000, label: 'provider interruption acknowledged' });
    let afterCancel;
    if (appPid) await waitFor(async () => { afterCancel = await providerProcesses(appPid); return afterCancel.length === 0; }, { timeoutMs: 15000, intervalMs: 500, label: 'cancel leaves no owned provider processes' });
    result.checks.push({ name: 'cancel', runningProcesses, remainingProcesses: afterCancel });
    assert(await readSource('main.tex') === external, 'Cancelled task unexpectedly changed actual source');
    if (resume) {
      await send('Read results/metrics.csv and state its measured metric with the evidence path and line range. Do not propose changes.');
      await completed();
      const sessionId = await page.getByTestId('agent-status').getAttribute('data-session-id');
      assert(sessionId, 'Provider did not expose actual persisted session identity');
      await delay(65000);
      if (appPid) assert((await providerProcesses(appPid)).length === 0, 'Idle provider transport remained alive after 60-second lifecycle deadline');
      await send('Continue this same conversation. Read results/metrics.csv again and state the measurement and evidence path. Do not propose changes.');
      await completed();
      assert(await page.getByTestId('agent-status').getAttribute('data-session-id') === sessionId, 'Resume started a new provider session instead of resuming the saved session');
      result.checks.push({ name: 'resume-after-idle-exit', sessionId });
    }
    await screenshot(page, output, `${provider}-${backend}-complete`);
    result.passed = true;
    return result;
  } catch (error) {
    result.error = error.stack || error.message;
    await screenshot(page, output, `${provider}-${backend}-failure`).catch(() => {});
    throw error;
  } finally {
    result.finishedAt = new Date().toISOString();
    await page.getByTestId('agent-history').innerText({ timeout: 2000 }).then(async (text) => {
      const transcript = path.join(output, `${provider}-${backend}-visible-transcript.txt`);
      await fs.writeFile(transcript, text);
      result.visibleTranscript = transcript;
    }).catch(() => {});
    await writeJson(report, result);
  }
}

async function main() {
  const args = parseArgs();
  const run = await createRun(args, 'agents');
  const results = [];
  let desktop, host;
  try {
    assert(args.live === true, 'LIVE_AGENTS_REQUIRED: pass --live to exercise real subscription inference; recorded transcripts are not accepted');
    const binary = await requireBinary(args);
    assert(args.dataDir === undefined || typeof args.dataDir === 'string', '--data-dir must name a dedicated smoke-owned authentication directory');
    const dataDir = args.dataDir ? path.resolve(args.dataDir) : run.dataDir;
    if (args.dataDir) {
      await fs.mkdir(dataDir, { recursive: true });
      const entries = await fs.readdir(dataDir);
      assert(entries.length === 0 || entries.includes('.texypaper-smoke-auth'), 'ISOLATION_REQUIRED: --data-dir must be new/empty or already marked .texypaper-smoke-auth; never point smoke at normal TexyPaper user data');
      if (entries.length === 0) await fs.writeFile(path.join(dataDir, '.texypaper-smoke-auth'), 'Dedicated official subscription login store for synthetic TexyPaper smoke only.\n', { flag: 'wx' });
    }
    const local = path.join(run.fixtures, 'agent-local');
    await fs.mkdir(path.join(local, 'code'), { recursive: true });
    await fs.mkdir(path.join(local, 'results'), { recursive: true });
    await fs.writeFile(path.join(local, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nLocal subscription agent smoke.\n\\end{document}\n');
    await fs.writeFile(path.join(local, 'code/analysis.py'), 'sample_count = 128\ncorrect = 112\naccuracy = correct / sample_count\n');
    await fs.writeFile(path.join(local, 'results/metrics.csv'), 'metric,value\naccuracy,0.875\nsample_count,128\n');
    desktop = await launchDesktop({ binary, output: run.output, dataDir, project: local });
    for (const backend of ['local', 'ssh']) {
      try {
        let opened;
        if (backend === 'ssh') {
          host = await startSshSmokeHost({ outputDir: run.output, distribution: args.distribution });
          opened = await connectSshUi(desktop.page, host.environment, host.root, { acceptUnknownHost: true });
        } else opened = { identity: await openLocalUi(desktop.page, local, { alreadyOpen: true }) };
        await writeJson(path.join(run.output, `backend-${backend}.json`), { passed: true, backend, expectedRoot: backend === 'ssh' ? host.root : local, ...opened });
        await desktop.page.screenshot({ path: path.join(run.output, `backend-${backend}-opened.png`), fullPage: true });
      } catch (error) {
        await writeJson(path.join(run.output, `backend-${backend}.json`), { passed: false, backend, error: error.stack || error.message });
        await desktop.page.screenshot({ path: path.join(run.output, `backend-${backend}-failure.png`), fullPage: true }).catch(() => {});
        for (const provider of ['codex', 'claude']) results.push({ provider, backend, passed: false, error: error.message });
        continue;
      }
      for (const provider of ['codex', 'claude']) {
        try {
          results.push(await exerciseAgent({ page: desktop.page, provider, backend, output: run.output, appPid: desktop.child.pid, authTimeoutMs: Number(args.authTimeoutSeconds || 0) * 1000,
            readSource: backend === 'ssh' ? (relative) => host.read(relative) : (relative) => fs.readFile(path.join(local, relative), 'utf8'),
            writeSource: backend === 'ssh' ? (relative, text) => host.write(relative, text) : (relative, text) => fs.writeFile(path.join(local, relative), text),
          }));
        } catch (error) {
          results.push({ provider, backend, passed: false, error: error.message });
          // Finish every independently reachable provider/backend gate; none is a skip.
          const cancel = desktop.page.getByTestId('agent-cancel');
          if (await cancel.isVisible().catch(() => false)) await cancel.click().catch(() => {});
        }
      }
    }
    assert(results.length === 4 && results.every((result) => result.passed), `LIVE_AGENT_GATE_FAILED: ${results.filter((result) => !result.passed).map((result) => `${result.provider}/${result.backend}: ${result.error}`).join('; ')}`);
    await writeJson(path.join(run.output, 'agents.json'), { passed: true, results });
  } catch (error) {
    await writeJson(path.join(run.output, 'agents.json'), { passed: false, results, error: error.stack || error.message });
    throw error;
  } finally {
    try { await desktop?.close(); } finally { await host?.stop(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
