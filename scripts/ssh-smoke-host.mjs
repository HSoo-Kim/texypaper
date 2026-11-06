// Authentication adapts the ssh2 README server example:
// "Password and public key authentication and non-interactive (exec) command execution".
// Copyright Brian White. All rights reserved. MIT; see THIRD_PARTY_NOTICES.md.
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import ssh2 from 'ssh2';

const { Server, utils } = ssh2;
const USER = 'texypaper-smoke';
const MAX_CAPTURE = 4 * 1024 * 1024;
const quoteConfig = (value) => `"${String(value).replaceAll('\\', '/').replaceAll('"', '\\"')}"`;
const equals = (a, b) => a.length === b.length && timingSafeEqual(a, b);

// A bounded wire tap observes genuine worker frames. Fault injection may drop a
// completed reply/connection; it never creates or changes a filesystem response.
class WorkerWireTap extends Transform {
  constructor(direction, observe) {
    super();
    this.direction = direction;
    this.observe = observe;
    this.buffer = Buffer.alloc(0);
    this.stage = direction === 'request' ? 'bootstrap' : 'marker';
    this.sourceBytes = 0;
    this.preambleBytes = 0;
  }
  _transform(chunk, encoding, done) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        if (this.stage === 'bootstrap' || this.stage === 'marker') {
          const end = this.buffer.indexOf(10);
          if (end < 0) {
            if (this.buffer.length > 8192) throw new Error('Worker wire preamble exceeded 8 KiB');
            break;
          }
          const line = this.buffer.subarray(0, end + 1);
          this.buffer = this.buffer.subarray(end + 1);
          this.push(line);
          if (this.stage === 'bootstrap') {
            const match = /^(\d+) [a-f0-9]{64}\n$/.exec(line.toString('ascii'));
            if (!match || Number(match[1]) > 1048576) throw new Error('Invalid actual worker bootstrap envelope');
            this.sourceBytes = Number(match[1]);
            this.stage = 'source';
          } else if (line.toString('ascii') === 'TEXYPAPER/1\n') this.stage = 'frame';
          else {
            this.preambleBytes += line.length;
            if (this.preambleBytes > 8192) throw new Error('Worker banner exceeded 8 KiB');
          }
        } else if (this.stage === 'source') {
          const amount = Math.min(this.sourceBytes, this.buffer.length);
          if (amount) this.push(this.buffer.subarray(0, amount));
          this.buffer = this.buffer.subarray(amount);
          this.sourceBytes -= amount;
          if (this.sourceBytes) break;
          this.stage = 'frame';
        } else {
          if (this.buffer.length < 4) break;
          const headerLength = this.buffer.readUInt32BE(0);
          if (headerLength > 65536) throw new Error('Actual worker header exceeds protocol bound');
          if (this.buffer.length < 8 + headerLength) break;
          const payloadLength = this.buffer.readUInt32BE(4 + headerLength);
          if (payloadLength > 1048576) throw new Error('Actual worker payload exceeds protocol bound');
          const length = 8 + headerLength + payloadLength;
          if (this.buffer.length < length) break;
          const frame = this.buffer.subarray(0, length);
          this.buffer = this.buffer.subarray(length);
          const header = JSON.parse(frame.subarray(4, 4 + headerLength).toString('utf8'));
          if (this.observe(header) !== false) this.push(frame);
        }
      }
      done();
    } catch (error) { done(error); }
  }
}

function run(binary, args, { input, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = { stdout: [], stderr: [] };
    let length = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${binary} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    for (const key of ['stdout', 'stderr']) child[key].on('data', (data) => {
      length += data.length;
      if (length > MAX_CAPTURE) { child.kill(); reject(new Error(`${binary} exceeded bounded diagnostic output`)); }
      else chunks[key].push(data);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = { code, stdout: Buffer.concat(chunks.stdout).toString('utf8').replace(/^\uFEFF/, ''), stderr: Buffer.concat(chunks.stderr).toString('utf8') };
      if (code !== 0) reject(new Error(`${binary} exited ${code}: ${result.stderr || result.stdout}`));
      else resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function hostKey() {
  return generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
}

export async function startSshSmokeHost({ outputDir, distribution = 'Ubuntu-24.04' }) {
  if (!outputDir) throw new Error('SSH smoke requires an explicit isolated outputDir');
  const directory = path.resolve(outputDir, `ssh-host-${randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  const wsl = (code, args = [], options = {}) => run('wsl.exe', ['--distribution', distribution, '--exec', 'python3', '-I', '-c', code, ...args], options);
  let probe;
  try {
    probe = JSON.parse((await wsl('import sys,shutil,json,pathlib; print(json.dumps({"python":sys.version,"version":list(sys.version_info[:3]),"home":str(pathlib.Path.home().resolve()),"tools":{x:shutil.which(x) for x in ["latexmk","pdflatex","xelatex","lualatex","synctex"]}}))')).stdout.trim());
  } catch (error) {
    throw new Error(`REMOTE_RUNTIME_UNAVAILABLE: WSL ${distribution} with Python >=3.9 is required; ${error.message}`);
  }
  if (probe.version[0] < 3 || (probe.version[0] === 3 && probe.version[1] < 9)) throw new Error(`REMOTE_RUNTIME_UNAVAILABLE: Python >=3.9 required, observed ${probe.python}`);
  for (const name of ['latexmk', 'pdflatex', 'synctex']) if (!probe.tools[name]) throw new Error(`TEX_TOOL_MISSING: ${name} unavailable in WSL ${distribution}; install only with user authorization`);
  // WSL may clear /tmp when an idle distro is restarted between fixture setup
  // and WebView launch. A uniquely owned home-cache directory survives that gap.
  const root = `${probe.home}/.cache/texypaper/smoke-fixtures/${randomUUID()}/논문 project`;
  const files = {
    'main.tex': '\\documentclass{article}\n\\usepackage[T1]{fontenc}\n\\begin{document}\nTexyPaper remote evidence starts here.\nThe measured accuracy is 0.875 and the sample count is 128.\n\\input{sections/method}\n\\end{document}\n',
    'sections/method.tex': 'This uniquely anchored remote method paragraph is safe literal prose.\n',
    'code/analysis.py': 'sample_count = 128\ncorrect = 112\naccuracy = correct / sample_count\nprint(accuracy)\n',
    'results/metrics.csv': 'metric,value\naccuracy,0.875\nsample_count,128\n',
    'conflict.tex': 'original remote value\n',
    'rename-me.tex': 'A synthetic rename fixture.\n',
    'references.bib': '@article{smoke,author={Fixture, Synthetic},title={Smoke evidence},year={2026}}\n',
  };
  await wsl('import pathlib,json,sys; root=pathlib.Path(sys.argv[1]); files=json.load(sys.stdin); root.parent.mkdir(parents=True,mode=0o700); root.mkdir(mode=0o700); [( (root/k).parent.mkdir(parents=True,exist_ok=True),(root/k).write_bytes(v.encode("utf-8")) ) for k,v in files.items()]; print(str(root.resolve(strict=True)))', [root], { input: JSON.stringify(files) });
  const clientKey = path.join(directory, 'client_ed25519');
  const encryptedKey = path.join(directory, 'encrypted_ed25519');
  const passphrase = `fixture-${randomUUID()}`;
  const password = `password-${randomUUID()}`;
  try {
    await run('ssh-keygen.exe', ['-q', '-t', 'ed25519', '-N', '', '-C', 'texypaper disposable smoke', '-f', clientKey]);
    await run('ssh-keygen.exe', ['-q', '-t', 'ed25519', '-N', passphrase, '-C', 'texypaper encrypted smoke', '-f', encryptedKey]);
  } catch (error) {
    await Promise.all([clientKey, `${clientKey}.pub`, encryptedKey, `${encryptedKey}.pub`].map((file) => fs.rm(file, { force: true })));
    await wsl('import shutil,sys; shutil.rmtree(sys.argv[1])', [root.slice(0, root.lastIndexOf('/'))]);
    throw new Error(`SSH_KEYGEN_UNAVAILABLE: ${error.message}`);
  }
  const publicKeys = await Promise.all([clientKey, encryptedKey].map(async (key) => utils.parseKey(await fs.readFile(`${key}.pub`))));
  const knownHosts = path.join(directory, 'known_hosts');
  const config = path.join(directory, 'ssh_config');
  await fs.writeFile(knownHosts, '');
  const clients = new Set();
  const processes = new Set();
  const sockets = new Set();
  const events = [];
  const log = (event) => { events.push({ at: new Date().toISOString(), ...event }); };
  let target;
  let jump;
  let closed = false;
  let dropReplyOperation = null;

  async function startServer({ key, port = 0, isJump = false }) {
    const server = new Server({ hostKeys: [key], ident: 'TexyPaperIsolatedSmoke', keepaliveInterval: 15000 }, (client) => {
      clients.add(client);
      client.on('error', (error) => log({ kind: 'ssh-error', jump: isJump, message: error.message }));
      client.on('close', () => clients.delete(client));
      client.on('authentication', (context) => {
        if (context.username !== USER) return context.reject();
        if (context.method === 'publickey') {
          const key = publicKeys.find((candidate) => !(candidate instanceof Error) && candidate.type === context.key.algo && equals(candidate.getPublicSSH(), context.key.data));
          if (key && (!context.signature || key.verify(context.blob, context.signature, context.hashAlgo) === true)) return context.accept();
        }
        if (context.method === 'password' && equals(Buffer.from(context.password), Buffer.from(password))) return context.accept();
        context.reject(['publickey', 'password']);
      });
      client.on('ready', () => {
        log({ kind: 'authenticated', jump: isJump });
        client.on('tcpip', (accept, reject, info) => {
          if (!isJump || info.destIP !== '127.0.0.1' || info.destPort !== target.address().port) return reject();
          const socket = net.connect({ host: '127.0.0.1', port: info.destPort });
          let forwarded;
          sockets.add(socket);
          socket.once('connect', () => {
            const channel = accept(); forwarded = channel;
            log({ kind: 'proxy-forward', port: info.destPort });
            channel.pipe(socket).pipe(channel);
            channel.on('error', () => socket.destroy());
            channel.on('close', () => socket.destroy());
          });
          socket.on('error', () => { if (forwarded) forwarded.destroy(); else reject(); });
          socket.on('close', () => sockets.delete(socket));
        });
        client.on('session', (accept, reject) => {
          if (isJump) return reject();
          const session = accept();
          session.on('exec', (acceptExec, rejectExec, info) => {
            // Only the application's Python worker bootstrap is admitted. Source/path
            // arguments thereafter are framed stdin bytes, never shell interpolation.
            if (!/^python3\s+-I\s+-u\s+-c\s/.test(info.command) || info.command.length > 128 * 1024) return rejectExec();
            const channel = acceptExec();
            const child = spawn('wsl.exe', ['--distribution', distribution, '--exec', 'sh', '-lc', info.command], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
            processes.add(child);
            log({ kind: 'worker-start', pid: child.pid });
            const requests = new Map();
            const inbound = new WorkerWireTap('request', (header) => {
              const metadata = { op: header.op, id: header.id, path: header.args?.path, root: header.args?.root, transactionId: header.args?.transactionId };
              requests.set(header.id, metadata);
              log({ kind: 'worker-request', ...metadata });
            });
            const outbound = new WorkerWireTap('reply', (header) => {
              const metadata = requests.get(header.id);
              requests.delete(header.id);
              if (metadata) log({ kind: 'worker-reply', ...metadata, ok: header.ok, code: header.error?.code, message: header.error?.message });
              if (metadata && header.ok && (dropReplyOperation === metadata.op || (dropReplyOperation === 'save_text' && metadata.op === 'save_text_commit'))) {
                dropReplyOperation = null;
                log({ kind: 'dropped-real-reply', ...metadata });
                client.end();
                child.stdin.end();
                return false;
              }
            });
            for (const tap of [inbound, outbound]) tap.on('error', (error) => { log({ kind: 'wire-error', message: error.message }); client.end(); child.stdin.end(); });
            channel.pipe(inbound).pipe(child.stdin);
            child.stdout.pipe(outbound).pipe(channel, { end: false });
            child.stderr.pipe(channel.stderr, { end: false });
            child.stdin.on('error', () => {});
            child.on('error', (error) => { channel.stderr.write(error.message); channel.exit(127); channel.end(); });
            child.on('close', (code) => { processes.delete(child); log({ kind: 'worker-exit', pid: child.pid, code }); channel.exit(code ?? 1); channel.end(); });
            channel.on('error', () => child.stdin.end());
            channel.on('close', () => {
              child.stdin.end();
              const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 3000);
              timer.unref();
              child.once('close', () => clearTimeout(timer));
            });
          });
        });
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return server;
  }

  try {
    target = await startServer({ key: hostKey() });
    jump = await startServer({ key: hostKey(), isJump: true });
    const common = `  HostName 127.0.0.1\n  User ${USER}\n  IdentityFile ${quoteConfig(clientKey)}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${quoteConfig(knownHosts)}\n  GlobalKnownHostsFile NUL\n  StrictHostKeyChecking ask\n  UpdateHostKeys no\n  ForwardAgent no\n  LogLevel ERROR\n`;
    await fs.writeFile(config,
      `Host TexyPaperSmokeDirect\n${common}  Port ${target.address().port}\n` +
      `Host TexyPaperSmokeJump\n${common}  Port ${jump.address().port}\n` +
      `Host TexyPaperSmokeProxy\n${common}  Port ${target.address().port}\n  ProxyJump TexyPaperSmokeJump\n` +
      `Host TexyPaperSmokePassword\n${common}  Port ${target.address().port}\n  PreferredAuthentications password\n  PubkeyAuthentication no\n` +
      `Host TexyPaperSmokeEncrypted\n${common.replace(`  IdentityFile ${quoteConfig(clientKey)}\n`, `  IdentityFile ${quoteConfig(encryptedKey)}\n`)}  Port ${target.address().port}\n`);
    const environment = { id: `ssh-smoke-${randomUUID()}`, label: '격리 SSH smoke', kind: 'ssh', hostAlias: 'TexyPaperSmokeDirect', sshConfigFile: config };
    const proxyEnvironment = { ...environment, id: `ssh-proxy-${randomUUID()}`, label: '격리 SSH ProxyJump', hostAlias: 'TexyPaperSmokeProxy' };
    await fs.writeFile(path.join(directory, 'host.json'), JSON.stringify({ root, distribution, probe, port: target.address().port, jumpPort: jump.address().port, config, knownHosts, environment, proxyEnvironment }, null, 2));
    return {
      root, directory, distribution, probe, environment, proxyEnvironment, password, passphrase, config, knownHosts,
      get events() { return [...events]; },
      async read(relative) { return (await wsl('import pathlib,sys; sys.stdout.buffer.write((pathlib.Path(sys.argv[1])/sys.argv[2]).read_bytes())', [root, relative])).stdout; },
      async write(relative, text) { await wsl('import pathlib,sys; p=pathlib.Path(sys.argv[1])/sys.argv[2]; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(sys.stdin.buffer.read())', [root, relative], { input: text }); },
      async list(relative = '.texypaper') { return JSON.parse((await wsl('import pathlib,json,sys; r=pathlib.Path(sys.argv[1]); p=r/sys.argv[2]; print(json.dumps([str(x.relative_to(r)) for x in p.rglob("*") if x.is_file()]))', [root, relative])).stdout); },
      async ownedJobs() {
        const code = `import pathlib,os,json,sys
root=sys.argv[1]; jobs=[]
for p in pathlib.Path("/proc").glob("[0-9]*"):
 try:
  cwd=os.readlink(p/"cwd"); name=(p/"comm").read_text().strip()
  if (cwd==root or cwd.startswith(root+"/")) and name in {"latexmk","perl","pdflatex","pdftex","xelatex","xetex","lualatex","luahbtex","biber","bibtex"}: jobs.append({"pid":int(p.name),"name":name,"cwd":cwd})
 except (OSError,ValueError): pass
print(json.dumps(jobs))`;
        return JSON.parse((await wsl(code, [root])).stdout);
      },
      async dropConnections() { for (const client of clients) client.end(); for (const socket of sockets) socket.destroy(); },
      armDropReply(op) {
        if (dropReplyOperation) throw new Error('Only one real transport fault may be armed');
        if (!['save_text', 'build_start'].includes(op)) throw new Error('Unsupported smoke transport fault operation');
        dropReplyOperation = op;
      },
      async rotateHostKey() {
        const port = target.address().port;
        for (const client of clients) client.end();
        await new Promise((resolve) => target.close(resolve));
        target = await startServer({ key: hostKey(), port });
        log({ kind: 'host-key-rotated', port });
      },
      async stop() {
        if (closed) return;
        closed = true;
        try {
        for (const client of clients) client.end();
        for (const socket of sockets) socket.destroy();
        for (const child of processes) child.stdin.end();
        await Promise.all([target, jump].map((server) => new Promise((resolve) => server.close(resolve))));
        await Promise.all([...processes].map((child) => new Promise((resolve) => { child.once('close', resolve); const timer = setTimeout(() => { child.kill(); resolve(); }, 4000); timer.unref(); })));
        await fs.writeFile(path.join(directory, 'events.json'), JSON.stringify(events, null, 2));
        await wsl('import shutil,sys; shutil.rmtree(sys.argv[1],ignore_errors=True)', [root.slice(0, root.lastIndexOf('/'))]);
        } finally {
          // Fixture private keys are never retained with evidence, even on cleanup failure.
          await Promise.all([clientKey, `${clientKey}.pub`, encryptedKey, `${encryptedKey}.pub`].map((file) => fs.rm(file, { force: true })));
        }
      },
    };
  } catch (error) {
    for (const client of clients) client.end();
    if (target) target.close();
    if (jump) jump.close();
    await Promise.all([clientKey, `${clientKey}.pub`, encryptedKey, `${encryptedKey}.pub`].map((file) => fs.rm(file, { force: true })));
    await wsl('import shutil,sys; shutil.rmtree(sys.argv[1],ignore_errors=True)', [root.slice(0, root.lastIndexOf('/'))]);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { parseArgs, writeJson } = await import('./smoke-support.mjs');
  const args = parseArgs();
  let host;
  try {
    host = await startSshSmokeHost({ outputDir: args.output, distribution: args.distribution });
    process.stdout.write(`${JSON.stringify({ root: host.root, environment: host.environment, proxyEnvironment: host.proxyEnvironment })}\n`);
    const stop = async () => { await host.stop(); process.exit(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    if (args.output) { await fs.mkdir(args.output, { recursive: true }); await writeJson(path.join(args.output, 'ssh-host-failure.json'), { passed: false, error: error.message }); }
    console.error(error.message);
    process.exitCode = 1;
  }
}
