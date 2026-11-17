import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { applyWorkerPatch, controllerSource, localWorker, sourcePatchName, sourcePatchSha256 } from './wasmtex-local-patch.mjs';
export { sourcePatchName, sourcePatchSha256 } from './wasmtex-local-patch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const assetDirectory = path.join(root, 'public/wasmtex/2026');
export const sourceName = 'wasmtex-2026-f5d94438a7c75a23-source.tar.xz';
const releaseId = '2026-f5d94438a7c75a23';
const sdkRevision = 'b2930ab196d17594eed3beefa0fd00e4f5fb5257';
export const sourceSha256 = 'e6a1f9b8ad84c7127368bb521217af381407fcc0d5c5518114345d55b470d637';
const sourceBytes = 154968364;
const sourceUrl = `https://github.com/corca-ai/wasmtex/releases/download/engine-${releaseId}/${sourceName}`;
const assetOrigin = 'https://corca-ai.github.io/wasmtex/wasmtex/2026/';
const sdkNotices = path.join(root, `licenses/npm/wasmtex-${sdkRevision}`);
const engineNotices = path.join(root, 'licenses/wasmtex-engine-2026');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function matches(file, expected) {
  let info;
  try { info = await lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  assert(info.isFile() && !info.isSymbolicLink(), `Not a regular asset file: ${file}`);
  if (info.size !== expected.bytes) return false;
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex') === expected.sha256;
}

async function ensureDownload(name, expected, url, verifyOnly) {
  const destination = path.join(assetDirectory, name);
  if (await matches(destination, expected)) return;
  assert(!verifyOnly, `Missing or corrupt WasmTex asset: ${name}; run pnpm assets:wasmtex`);
  console.log(`Downloading pinned WasmTex asset: ${name}`);
  const temporary = `${destination}.${process.pid}.part`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    assert(response.ok && response.body, `Download failed (${response.status}): ${url}`);
    let bytes = 0;
    const digest = createHash('sha256');
    const verifier = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > expected.bytes) { callback(new Error(`Oversized download: ${name}`)); return; }
      digest.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(temporary, { flags: 'wx' }));
    assert.equal(bytes, expected.bytes, `Size mismatch: ${name}`);
    assert.equal(digest.digest('hex'), expected.sha256, `SHA-256 mismatch: ${name}`);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function ensureBytes(destination, bytes, verifyOnly) {
  try {
    const info = await lstat(destination);
    assert(info.isFile() && !info.isSymbolicLink(), `Not a regular legal asset: ${destination}`);
    if ((await readFile(destination)).equals(bytes)) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert(!verifyOnly, `Missing or changed WasmTex legal asset: ${destination}; run pnpm assets:wasmtex`);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

async function copyNotices(source, destination, verifyOnly) {
  let total = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), `Symlink notice is not allowed: ${entry.name}`);
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) total += await copyNotices(from, to, verifyOnly);
    else {
      assert(entry.isFile(), `Not a regular notice: ${from}`);
      const bytes = await readFile(from);
      await ensureBytes(to, bytes, verifyOnly);
      total += bytes.length;
    }
  }
  return total;
}

// The checked-in manifest, not the mutable deployment's current manifest, is the
// trust root. Existing valid payloads need no network access, including source.
export async function setupWasmtex({ verifyOnly = false } = {}) {
  assert(Number(process.versions.node.split('.')[0]) >= 24, 'WasmTex requires Node.js 24 or newer');
  const manifestBytes = await readFile(new URL('./wasmtex-engine-2026.manifest.json', import.meta.url));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.version, '2026');
  assert.equal(manifest.releaseId, releaseId);
  assert.equal(manifest.legal.releaseStatus, 'release-cleared');
  assert.deepEqual(manifest.legal.releaseBlockers, []);
  assert.equal(manifest.legal.correspondingSource.url, sourceUrl);
  assert.equal(manifest.legal.correspondingSource.sha256, sourceSha256);
  const names = new Set();
  for (const file of manifest.files) {
    assert(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file.name), `Invalid asset name: ${file.name}`);
    assert(!names.has(file.name), `Duplicate asset: ${file.name}`);
    names.add(file.name);
    assert(Number.isSafeInteger(file.bytes) && file.bytes > 0, `Invalid asset size: ${file.name}`);
    assert(/^[a-f0-9]{64}$/.test(file.sha256), `Invalid asset digest: ${file.name}`);
  }
  assert(names.has('LICENSE-MANIFEST.json'), 'Missing engine license manifest');
  for (const receipt of manifest.buildReceipts) {
    assert(manifest.files.some(file => file.name === receipt.name && file.sha256 === receipt.sha256), `Unbound receipt: ${receipt.name}`);
  }
  const patchBytes = await readFile(path.join(engineNotices, 'texypaper-local-assets.patch'));
  assert.equal(hash(patchBytes), sourcePatchSha256, 'Local engine source patch digest mismatch');
  const upstreamWorker = manifest.files.find(file => file.name === localWorker.name);
  assert(upstreamWorker, 'Missing pinned upstream PDF worker');
  if (!verifyOnly) await mkdir(assetDirectory, { recursive: true });
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < manifest.files.length) {
      const file = manifest.files[next++];
      if (file.name !== localWorker.name) {
        await ensureDownload(file.name, file, new URL(file.name, assetOrigin), verifyOnly);
        continue;
      }
      const destination = path.join(assetDirectory, file.name);
      if (await matches(destination, localWorker)) continue;
      assert(!verifyOnly, 'Missing or corrupt locally patched PDF worker; run pnpm assets:wasmtex');
      await ensureDownload(file.name, file, new URL(file.name, assetOrigin), false);
      const patched = Buffer.from(applyWorkerPatch(await readFile(destination, 'utf8'), patchBytes.toString('utf8')));
      assert.equal(patched.length, localWorker.bytes, 'Patched PDF worker size mismatch');
      assert.equal(hash(patched), localWorker.sha256, 'Patched PDF worker digest mismatch');
      await ensureBytes(destination, patched, false);
    }
  }));
  await ensureDownload(sourceName, { bytes: sourceBytes, sha256: sourceSha256 }, sourceUrl, verifyOnly);
  const legal = JSON.parse(await readFile(path.join(assetDirectory, 'LICENSE-MANIFEST.json'), 'utf8'));
  assert.equal(legal.texliveVersion, '2026');
  assert.equal(legal.releaseStatus, 'release-cleared');
  assert.deepEqual(legal.releaseBlockers, []);
  assert.deepEqual(legal.correspondingSource, manifest.legal.correspondingSource);
  const distributionId = `${releaseId}-texypaper-${localWorker.sha256.slice(0, 12)}`;
  const sourcePatch = { path: sourcePatchName, sha256: sourcePatchSha256, bytes: patchBytes.length, sourceFile: controllerSource };
  const deployed = {
    ...manifest,
    releaseId: distributionId,
    upstreamReleaseId: releaseId,
    upstreamManifest: 'upstream-manifest.json',
    files: manifest.files.map(file => file.name === localWorker.name ? { ...file, ...localWorker } : file),
    legal: { ...manifest.legal, releaseStatus: 'local-source-patch', correspondingSource: { ...manifest.legal.correspondingSource, patch: sourcePatch } },
    localModifications: {
      description: 'Local-only relative package paths and flat cache names in the PDF worker controller; all WASM and format files remain unchanged.',
      upstreamBuildReceipt: 'BUILD-RECEIPT.pdftex.json',
      upstreamWorker,
      modifiedWorker: localWorker,
      sourcePatch,
      rebuild: 'Extract the upstream source archive, apply this patch with patch -p1 from its root, then follow REBUILD.md for the PDF worker. The same exact hunks are applied to the generated worker during TexyPaper packaging.',
    },
  };
  const deployedBytes = Buffer.from(`${JSON.stringify(deployed, null, 2)}\n`);
  await ensureBytes(path.join(assetDirectory, 'upstream-manifest.json'), manifestBytes, verifyOnly);
  await ensureBytes(path.join(assetDirectory, 'manifest.json'), deployedBytes, verifyOnly);
  await ensureBytes(path.join(assetDirectory, sourcePatchName), patchBytes, verifyOnly);
  const noticeBytes = await copyNotices(engineNotices, path.join(assetDirectory, 'legal/engine'), verifyOnly)
    + await copyNotices(sdkNotices, path.join(assetDirectory, 'legal/sdk'), verifyOnly);
  const indexBytes = await readFile(new URL('./wasmtex-licenses.html', import.meta.url));
  await ensureBytes(path.join(assetDirectory, 'index.html'), indexBytes, verifyOnly);
  const metadata = Buffer.from(`${JSON.stringify({
    releaseId: distributionId,
    upstreamReleaseId: releaseId,
    sdkRevision,
    sdkLicense: 'MIT',
    engineManifest: 'manifest.json',
    licenseManifest: 'LICENSE-MANIFEST.json',
    notices: 'legal/engine/THIRD_PARTY_NOTICES.md',
    licenseDirectory: 'legal/engine/LICENSES/',
    source: { path: sourceName, url: sourceUrl, sha256: sourceSha256, bytes: sourceBytes },
    sourcePatch,
    engineManifestSha256: hash(deployedBytes),
    upstreamManifestSha256: hash(manifestBytes),
  }, null, 2)}\n`);
  await ensureBytes(path.join(assetDirectory, 'DISTRIBUTION.json'), metadata, verifyOnly);
  const engineBytes = deployed.files.reduce((sum, file) => sum + file.bytes, 0);
  const result = {
    releaseId: distributionId, upstreamReleaseId: releaseId, files: deployed.files.length, engineBytes, sourceBytes, sourcePatchBytes: patchBytes.length, noticeBytes,
    totalBytes: engineBytes + sourceBytes + noticeBytes + manifestBytes.length + deployedBytes.length + patchBytes.length + indexBytes.length + metadata.length,
    directory: assetDirectory,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.slice(2).every(arg => arg === '--verify'), 'Usage: node scripts/setup-wasmtex.mjs [--verify]');
  try { await setupWasmtex({ verifyOnly: process.argv.includes('--verify') }); }
  catch (error) { console.error(`WasmTex assets: ${error.message}`); process.exitCode = 1; }
}
