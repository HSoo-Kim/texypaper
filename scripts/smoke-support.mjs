import { access, mkdir, writeFile, stat, open } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';

export function assert(condition, message) { if (!condition) throw new Error(message); }
export function parseArgs(argv = process.argv.slice(2)) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]; if (argument === '--') continue;
    assert(argument.startsWith('--'), `Unexpected positional argument: ${argument}`);
    const equal = argument.indexOf('=');
    const name = argument.slice(2, equal < 0 ? undefined : equal).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    assert(name && !Object.hasOwn(result, name), `Duplicate or invalid option: ${argument}`);
    if (equal >= 0) result[name] = argument.slice(equal + 1);
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) result[name] = argv[++index];
    else result[name] = true;
  }
  return result;
}
export async function requireBinary(args) {
  assert(typeof args.binary === 'string', 'Supply --binary <actual release texypaper.exe>.');
  const binary = path.resolve(args.binary); await access(binary);
  assert((await stat(binary)).isFile(), `Not an executable file: ${binary}`);
  assert(path.extname(binary).toLowerCase() === '.exe', 'Windows release executable (.exe) is required.');
  assert(!binary.toLowerCase().includes(`${path.sep}debug${path.sep}`), 'Memory/desktop gates require a release binary, not a debug build.');
  return binary;
}
export async function writeJson(target, value) { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(value, null, 2) + '\n'); }
export async function createRun(args, prefix) {
  assert(typeof args.output === 'string', `Supply --output <isolated evidence directory> for ${prefix}.`);
  const output = path.resolve(args.output); await mkdir(output, { recursive: true });
  // Never silently merge reports or overwrite a previous run's writable fixtures.
  const marker = await open(path.join(output, '.texypaper-smoke-run'), 'wx');
  await marker.writeFile(`${prefix}\n${new Date().toISOString()}\n`); await marker.close();
  const fixtures = path.join(output, 'fixtures'), dataDir = path.join(output, 'app-data');
  await mkdir(dataDir); return { output, fixtures, dataDir };
}
export async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs; let lastError;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}
async function reservePort() {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); return port;
}
async function stopOwned(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    await once(killer, 'exit').catch(() => {});
  } else child.kill('SIGTERM');
}
// Playwright enables CDP Network on every page/worker session. DevTools then retains
// response bodies and per-request metadata (InspectorNetworkAgent ResourceData) for
// every Tauri IPC fetch: test instrumentation, not app memory. Real allocator dumps
// showed both growing across cycles and pinning renderer heap pages. No smoke uses
// network events, so the wrapper lets Playwright's Network.enable complete and then
// disables network tracking on that same session; all other commands pass unchanged.
const WRAPPER_IDS = 1_000_000_000;
async function connectWithoutNetworkRetention(endpoint) {
  const socket = new WebSocket(endpoint), ready = Promise.withResolvers();
  socket.addEventListener('open', () => ready.resolve(), { once: true });
  socket.addEventListener('error', () => ready.reject(new Error('Could not open the app-owned CDP WebSocket.')), { once: true });
  await ready.promise;
  const queued = [], enables = new Map();
  let wrapperId = WRAPPER_IDS;
  const transport = {
    open() { while (queued.length && transport.onmessage) transport.onmessage(queued.shift()); },
    send(message) {
      if (message.method === 'Network.enable') enables.set(`${message.sessionId ?? ''}:${message.id}`, message.sessionId);
      socket.send(JSON.stringify(message.method === 'Network.enable' ? { ...message, params: { ...message.params, maxTotalBufferSize: 0, maxResourceBufferSize: 0 } } : message));
    },
    close() { socket.close(); },
    onmessage: undefined, onclose: undefined,
  };
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id === 'number' && message.id >= WRAPPER_IDS) return; // the wrapper's own Network.disable reply
    const key = `${message.sessionId ?? ''}:${message.id}`;
    if (enables.has(key)) {
      enables.delete(key);
      if (!message.error) socket.send(JSON.stringify({ id: wrapperId++, method: 'Network.disable', params: {}, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
    }
    if (transport.onmessage) transport.onmessage(message); else queued.push(message);
  });
  socket.addEventListener('close', event => transport.onclose?.(event.reason));
  return chromium.connectOverCDP(transport);
}
export async function launchDesktop({ binary, output, dataDir, project, env = {} }) {
  assert(process.platform === 'win32', 'Actual Windows Tauri/WebView2 smoke must run on Windows.');
  const port = await reservePort();
  const stdout = await open(path.join(output, 'app.stdout.log'), 'a'), stderr = await open(path.join(output, 'app.stderr.log'), 'a');
  const argumentsList = ['--data-dir', dataDir]; if (project) argumentsList.push('--open', project);
  const child = spawn(binary, argumentsList, { shell: false, windowsHide: false, stdio: ['ignore', stdout.fd, stderr.fd], env: { ...process.env, ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}` } });
  let spawnError; child.on('error', error => { spawnError = error; });
  await stdout.close(); await stderr.close();
  await writeJson(path.join(output, 'launch.json'), { pid: child.pid, binary, dataDir, profile: path.join(dataDir, 'webview'), port, startedAt: new Date().toISOString(), project, arguments: argumentsList });
  let browser;
  try {
    const endpoint = await waitFor(async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`TexyPaper exited ${child.exitCode}; see app.stderr.log.`);
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      return response.ok && (await response.json()).webSocketDebuggerUrl;
    }, { timeoutMs: 45000, label: 'release WebView2 CDP endpoint (machine policy may block debugging)' });
    const listener = await runExternal('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ([int]$env:TEXYPAPER_SMOKE_CDP_PORT) -State Listen | Select-Object -ExpandProperty OwningProcess) | ConvertTo-Json -Compress'], { timeoutMs: 15000, env: { TEXYPAPER_SMOKE_CDP_PORT: String(port) } });
    const listenerValue = JSON.parse(listener.stdout || '[]'), listenerPids = Array.isArray(listenerValue) ? listenerValue : [listenerValue];
    const processIds = new Set((await ownedProcesses(child.pid)).map(process => process.ProcessId));
    assert(listenerPids.length > 0 && listenerPids.every(pid => processIds.has(pid)), 'CDP listener does not belong to this run\'s app process tree; refusing to attach or close an unrelated browser.');
    browser = await connectWithoutNetworkRetention(endpoint);
    const page = await waitFor(async () => browser.contexts().flatMap(context => context.pages()).find(candidate => !candidate.url().startsWith('devtools:')), { label: 'real Tauri webview page' });
    await page.waitForLoadState('domcontentloaded');
    const consoleLog = []; page.on('console', message => { if (consoleLog.length < 2000) consoleLog.push({ type: message.type(), text: message.text() }); });
    page.on('pageerror', error => { if (consoleLog.length < 2000) consoleLog.push({ type: 'pageerror', text: error.stack ?? error.message }); });
    return { browser, page, child, close: async () => { await writeJson(path.join(output, 'webview-console.json'), consoleLog); await browser.close().catch(() => {}); await stopOwned(child); } };
  } catch (error) { await browser?.close().catch(() => {}); await stopOwned(child); throw error; }
}

export async function runExternal(executable, args, { output, prefix = 'process', timeoutMs = 180000, acceptedExitCodes = [0], env = {} } = {}) {
  const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const chunks = { stdout: [], stderr: [] }, lengths = { stdout: 0, stderr: 0 };
  for (const kind of ['stdout', 'stderr']) child[kind].on('data', bytes => {
    if (lengths[kind] < 1024 * 1024) { const retained = bytes.subarray(0, 1024 * 1024 - lengths[kind]); chunks[kind].push(retained); lengths[kind] += retained.length; }
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void stopOwned(child); }, timeoutMs);
  let exitCode;
  try { [exitCode] = await once(child, 'close'); } finally { clearTimeout(timer); }
  const result = { executable, args, exitCode, timedOut, stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') };
  if (output) await writeJson(path.join(output, `${prefix}.json`), result);
  assert(!timedOut && acceptedExitCodes.includes(exitCode), `${executable} ${timedOut ? 'timed out' : `exited ${exitCode}`}: ${result.stderr}`);
  return result;
}
export async function ownedProcesses(appPid) {
  assert(Number.isSafeInteger(appPid) && appPid > 0, 'An actual launched app PID is required.');
  const result = await runExternal('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{n="CreatedTicks";e={$_.CreationDate.ToUniversalTime().Ticks}} | ConvertTo-Json -Compress'], { timeoutMs: 15000 });
  const all = [].concat(JSON.parse(result.stdout || '[]')), ids = new Set([appPid]);
  const created = new Map(all.map(process => [process.ProcessId, Number(process.CreatedTicks)]));
  for (let pass = 0; pass < 32; pass++) {
    let added = false;
    // ParentProcessId is stale after a parent exits and its PID is recycled; a real child is never older than its parent.
    for (const process of all) if (ids.has(process.ParentProcessId) && !ids.has(process.ProcessId) && Number(process.CreatedTicks) >= (created.get(process.ParentProcessId) ?? Infinity)) { ids.add(process.ProcessId); added = true; }
    if (!added) break;
  }
  return all.filter(process => ids.has(process.ProcessId));
}

export async function saveNativePdfDialog({ appPid, destination, output }) {
  assert(Number.isSafeInteger(appPid) && appPid > 0, 'Native dialog automation requires this run\'s exact app PID.');
  const code = String.raw`
$ErrorActionPreference='Stop'
$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$A=[System.Windows.Automation.AutomationElement]
$T=[System.Windows.Automation.TreeScope]
$deadline=[datetime]::UtcNow.AddSeconds(30)
$dialog=$null
while(-not $dialog -and [datetime]::UtcNow -lt $deadline){
  $condition=[System.Windows.Automation.PropertyCondition]::new($A::ProcessIdProperty,[int]$env:TEXYPAPER_SMOKE_PID)
  $windows=$A::RootElement.FindAll($T::Children,$condition)
  foreach($window in $windows){if($window.Current.Name -in @('PDF 내보내기','Export PDF')){$dialog=$window;break}}
  if(-not $dialog){Start-Sleep -Milliseconds 100}
}
if(-not $dialog){throw 'NATIVE_DIALOG_UNAVAILABLE: app-owned PDF save dialog is not accessible. No OS permissions/ACLs were changed.'}
# This Windows dialog exposes filename/save HWNDs through UIA host panes, but no
# ValuePattern/InvokePattern. Discover the host first; never type into arbitrary edits.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OwnedSaveDialog {
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr parent,int id);
 [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent,IntPtr child);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",CharSet=CharSet.Unicode,SetLastError=true)]
 public static extern IntPtr GetText(IntPtr h,uint message,IntPtr count,[Out] StringBuilder text,uint flags,uint timeout,out IntPtr result);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",CharSet=CharSet.Unicode,SetLastError=true)]
 public static extern IntPtr SetText(IntPtr h,uint message,IntPtr w,string text,uint flags,uint timeout,out IntPtr result);
 [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",SetLastError=true)]
 public static extern IntPtr Click(IntPtr h,uint message,IntPtr w,IntPtr l,uint flags,uint timeout,out IntPtr result);
}
'@
$root=[IntPtr]$dialog.Current.NativeWindowHandle
$hostElement=$dialog.FindFirst($T::Descendants,[System.Windows.Automation.PropertyCondition]::new($A::AutomationIdProperty,'FileNameControlHost'))
if(-not $hostElement){throw 'NATIVE_DIALOG_UNAVAILABLE: app-owned filename host was not found.'}
$edit=[OwnedSaveDialog]::GetDlgItem([IntPtr]$hostElement.Current.NativeWindowHandle,1001)
$saveCondition=[System.Windows.Automation.AndCondition]::new([System.Windows.Automation.PropertyCondition]::new($A::AutomationIdProperty,'1'),[System.Windows.Automation.PropertyCondition]::new($A::ClassNameProperty,'Button'))
$save=$dialog.FindFirst($T::Descendants,$saveCondition)
if(-not $save){throw 'NATIVE_DIALOG_UNAVAILABLE: app-owned Save button was not found.'}
$saveHandle=[IntPtr]$save.Current.NativeWindowHandle
foreach($control in @(@{handle=$edit;class='Edit'},@{handle=$saveHandle;class='Button'})){
 [uint32]$owner=0;[void][OwnedSaveDialog]::GetWindowThreadProcessId($control.handle,[ref]$owner)
 $class=[System.Text.StringBuilder]::new(256);[void][OwnedSaveDialog]::GetClassName($control.handle,$class,256)
 if($owner -ne [uint32]$env:TEXYPAPER_SMOKE_PID -or -not [OwnedSaveDialog]::IsChild($root,$control.handle) -or $class.ToString() -ne $control.class){throw 'NATIVE_DIALOG_UNAVAILABLE: dialog control ownership/class mismatch.'}
}
[IntPtr]$result=[IntPtr]::Zero
if([OwnedSaveDialog]::SetText($edit,0x000C,[IntPtr]::Zero,$env:TEXYPAPER_SMOKE_DESTINATION,2,5000,[ref]$result) -eq [IntPtr]::Zero){throw 'Native filename input timed out.'}
$actual=[System.Text.StringBuilder]::new(32768)
if([OwnedSaveDialog]::GetText($edit,0x000D,[IntPtr]32768,$actual,2,5000,[ref]$result) -eq [IntPtr]::Zero){throw 'Native filename acknowledgement timed out.'}
if($actual.ToString() -ne $env:TEXYPAPER_SMOKE_DESTINATION){throw 'Native filename control did not acknowledge the selected destination.'}
$dialogName=$dialog.Current.Name
if([OwnedSaveDialog]::Click($saveHandle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero,2,5000,[ref]$result) -eq [IntPtr]::Zero){throw 'Native Save control timed out.'}
@{passed=$true;dialog=$dialogName;pid=[int]$env:TEXYPAPER_SMOKE_PID;destination=$env:TEXYPAPER_SMOKE_DESTINATION;method='UIA-discovered owned filename host and Win32 Edit/Save controls'}|ConvertTo-Json -Compress
`;
  const result = await runExternal('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { output, prefix: 'native-pdf-save-dialog', timeoutMs: 45000, env: { TEXYPAPER_SMOKE_PID: String(appPid), TEXYPAPER_SMOKE_DESTINATION: destination } });
  return JSON.parse(result.stdout);
}
