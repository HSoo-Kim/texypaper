import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const usage = 'Usage: pnpm package:release --version <version> --release-dir <release folder> --output <new folder> --hidden-sha <verified hidden exe SHA-256> [--sevenzip <7z.exe or WSL 7z path>] [--signed]';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = file => sha256(readFileSync(file));

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program} failed (${result.status}):\n${result.stderr}\n${result.stdout}`);
  return result.stdout.trim().replace(/^\uFEFF/, '');
}

function filesUnder(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    const full = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Symlink payload is not allowed: ${full}`);
    if (entry.isDirectory()) files.push(...filesUnder(full, `${name}/`));
    else {
      assert(entry.isFile(), `Not a regular payload file: ${full}`);
      files.push(name);
    }
  }
  return files.sort();
}

// Match the historical Python zipfile ZIP headers: DOS host, 0644 mode, no
// extras/descriptors/directory entries, and the fixed 2026-11-08 00:00:00 date.
// ZIP32 bounds are deliberate: fail instead of emitting an invalid ZIP64 file.
const dosDate = ((2026 - 1980) << 9) | (11 << 5) | 8;
function writeZip(file, payload) {
  assert(payload.length < 0xffff, 'ZIP64 entry count is not supported');
  const fd = openSync(file, 'wx');
  const central = [];
  let offset = 0;
  const append = bytes => {
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
    offset += bytes.length;
    assert(offset < 0xffffffff, 'ZIP64 size is not supported');
  };
  try {
    for (const entry of payload) {
      const name = Buffer.from(entry.name, 'utf8');
      assert(name.length < 0xffff, `ZIP filename too long: ${entry.name}`);
      const flags = /^[\x00-\x7f]*$/.test(entry.name) ? 0 : 0x800;
      const bytes = readFileSync(entry.source);
      assert.equal(sha256(bytes), entry.sha256, `Source changed while packaging: ${entry.name}`);
      const compressed = deflateRawSync(bytes, { level: 9 });
      assert(bytes.length < 0xffffffff && compressed.length < 0xffffffff, 'ZIP64 member size is not supported');
      const crc = crc32(bytes);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(8, 8);
      local.writeUInt16LE(dosDate, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(bytes.length, 22);
      local.writeUInt16LE(name.length, 26);
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(flags, 8);
      header.writeUInt16LE(8, 10);
      header.writeUInt16LE(dosDate, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(compressed.length, 20);
      header.writeUInt32LE(bytes.length, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt32LE(0o644 << 16, 38);
      header.writeUInt32LE(offset, 42);
      central.push(header, name);
      append(local);
      append(name);
      append(compressed);
    }
    const centralOffset = offset;
    for (const bytes of central) append(bytes);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(payload.length, 8);
    end.writeUInt16LE(payload.length, 10);
    end.writeUInt32LE(offset - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    append(end);
  } finally {
    closeSync(fd);
  }
}

// Reopen the actual output, check the central/local records, inflate every file
// and compare its hash, length and CRC to the input. A writer completing alone
// is not evidence that the portable payload can be read back.
function verifyZip(file, payload) {
  const zip = readFileSync(file);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50, 'Missing ZIP end record');
  assert.equal(zip.readUInt16LE(end + 8), payload.length, 'ZIP member count mismatch');
  assert.equal(zip.readUInt16LE(end + 10), payload.length, 'ZIP member count mismatch');
  let at = zip.readUInt32LE(end + 16);
  const centralStart = at;
  let nextLocal = 0;
  for (const entry of payload) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50, 'Missing ZIP central record');
    const compressedLength = zip.readUInt32LE(at + 20);
    const length = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    assert.equal(zip.subarray(at + 46, at + 46 + nameLength).toString('utf8'), entry.name, 'ZIP entry order/name mismatch');
    const local = zip.readUInt32LE(at + 42);
    assert.equal(local, nextLocal, 'ZIP local entries are not contiguous');
    assert.equal(zip.readUInt32LE(local), 0x04034b50, 'Missing ZIP local record');
    assert.equal(zip.readUInt16LE(local + 8), 8, 'ZIP member is not deflated');
    assert.equal(zip.readUInt32LE(local + 18), compressedLength);
    assert.equal(zip.readUInt32LE(local + 22), length);
    assert.equal(zip.readUInt16LE(local + 26), nameLength);
    assert.equal(zip.subarray(local + 30, local + 30 + nameLength).toString('utf8'), entry.name);
    const start = local + 30 + nameLength + zip.readUInt16LE(local + 28);
    const bytes = inflateRawSync(zip.subarray(start, start + compressedLength));
    assert.equal(bytes.length, length, `ZIP length mismatch: ${entry.name}`);
    assert.equal(crc32(bytes), zip.readUInt32LE(at + 16), `ZIP CRC mismatch: ${entry.name}`);
    assert.equal(crc32(bytes), zip.readUInt32LE(local + 14), `ZIP local CRC mismatch: ${entry.name}`);
    assert.equal(sha256(bytes), entry.sha256, `ZIP payload hash mismatch: ${entry.name}`);
    nextLocal = start + compressedLength;
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  assert.equal(nextLocal, centralStart, 'Unexpected extra ZIP payload');
  assert.equal(at, end, 'Unexpected ZIP central data');
  assert.equal(at - centralStart, zip.readUInt32LE(end + 12), 'ZIP central size mismatch');
}

function wslPath(file) {
  if (file.startsWith('/')) return file;
  return run('wsl.exe', ['-d', 'Ubuntu-24.04', '--exec', 'wslpath', '-a', '-u', path.resolve(file)]);
}

function extractInstaller(sevenzip, installer, output) {
  if (sevenzip.toLowerCase().endsWith('.exe')) {
    run(path.resolve(sevenzip), ['x', '-y', `-o${output}`, installer]);
  } else {
    run('wsl.exe', ['-d', 'Ubuntu-24.04', '--exec', wslPath(sevenzip), 'x', '-y', `-o${wslPath(output)}`, wslPath(installer)]);
  }
}

function windowsMetadata(files) {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rows = @(foreach ($file in ($env:TEXYPAPER_PACKAGE_FILES | ConvertFrom-Json)) {
  $item = Get-Item -LiteralPath $file.path
  $signature = Get-AuthenticodeSignature -LiteralPath $file.path
  [ordered]@{
    name = $file.name
    productName = $item.VersionInfo.ProductName
    fileVersion = $item.VersionInfo.FileVersion
    productVersion = $item.VersionInfo.ProductVersion
    signature = $signature.Status.ToString()
    signerSubject = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null })
    signerThumbprint = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null })
    signerIssuer = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Issuer } else { $null })
    timestampSubject = $(if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null })
  }
})
ConvertTo-Json -InputObject $rows -Depth 5 -Compress
`;
  return JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, TEXYPAPER_PACKAGE_FILES: JSON.stringify(files) },
  }));
}

function bundleTypeProof(normal, embedded, normalSha256) {
  assert.equal(normal.length, embedded.length, 'Installer exe has a different length');
  const unk = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const nss = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
  const index = normal.indexOf(unk);
  assert(index >= 0 && normal.indexOf(unk, index + 1) < 0, 'Normal exe must have exactly one UNK bundle marker');
  assert.equal(embedded.indexOf(nss), index, 'Installer exe NSS bundle marker is misplaced');
  assert.equal(embedded.indexOf(nss, index + 1), -1, 'Installer exe has duplicate NSS bundle markers');
  const expected = Buffer.from(normal);
  nss.copy(expected, index);
  assert(expected.equals(embedded), 'Installer exe differs beyond the UNK -> NSS bundle marker');
  let changedBytes = 0;
  for (let i = 0; i < normal.length; i++) if (normal[i] !== embedded[i]) changedBytes++;
  assert.equal(changedBytes, 3, 'Expected exactly three changed bundle-type bytes');
  return {
    changedBytes,
    normalSha256,
    note: 'Same length; three differing bytes, __TAURI_BUNDLE_TYPE_VAR_UNK -> __TAURI_BUNDLE_TYPE_VAR_NSS, confirmed by replacing the marker in the extracted executable.',
  };
}

function main() {
  const { values } = parseArgs({ options: {
    version: { type: 'string' }, 'release-dir': { type: 'string' }, output: { type: 'string' },
    'hidden-sha': { type: 'string' }, sevenzip: { type: 'string' }, signed: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(usage); return; }
  assert.equal(process.platform, 'win32', 'Packaging requires Windows PowerShell for version and Authenticode metadata');
  assert(values.version && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(values.version), `Invalid or missing --version. ${usage}`);
  assert(values['release-dir'] && values.output, `Missing input/output directory. ${usage}`);
  assert(values['hidden-sha'] && /^[a-fA-F0-9]{64}$/.test(values['hidden-sha']), 'Pass the SHA-256 of the verified hidden executable using --hidden-sha');
  const version = values.version;
  const hiddenSha = values['hidden-sha'].toLowerCase();
  const release = path.resolve(values['release-dir']);
  const output = path.resolve(values.output);
  assert(!existsSync(output), `Refusing to overwrite existing output directory: ${output}`);
  const installerName = `TexyPaper_${version}_x64-setup.exe`;
  const portableName = `TexyPaper_${version}_windows_x64_portable.zip`;
  const normalPath = path.join(release, 'texypaper.exe');
  const sourceInstaller = path.join(release, 'bundle', 'nsis', installerName);
  for (const file of [normalPath, sourceInstaller]) assert(lstatSync(file).isFile(), `Missing release binary: ${file}`);
  const normal = readFileSync(normalPath);
  const normalSha = sha256(normal);
  assert.notEqual(normalSha, hiddenSha, 'Refusing to distribute the hidden verification build');
  const payload = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'texypaper.exe', ...filesUnder(path.join(root, 'licenses'), 'licenses/')].map(name => {
    const source = name === 'texypaper.exe' ? normalPath : path.join(root, name);
    assert(lstatSync(source).isFile(), `Not a regular payload file: ${source}`);
    return { name, source, sha256: fileHash(source) };
  });
  mkdirSync(path.dirname(output), { recursive: true });
  mkdirSync(output); // Atomic refusal if another process created it after the check.
  let temporary;
  try {
    temporary = mkdtempSync(path.join(output, '.package-extract-'));
    const installer = path.join(output, installerName);
    const portable = path.join(output, portableName);
    copyFileSync(sourceInstaller, installer);
    assert.equal(fileHash(installer), fileHash(sourceInstaller), 'Installer copy hash mismatch');
    writeZip(portable, payload);
    verifyZip(portable, payload);
    const sevenzip = values.sevenzip ?? path.join(root, 'artifacts/publication-tools/sevenzip/usr/lib/7zip/7z');
    extractInstaller(sevenzip, installer, temporary);
    const embeddedPath = path.join(temporary, 'texypaper.exe');
    const embedded = readFileSync(embeddedPath);
    assert.notEqual(sha256(embedded), hiddenSha, 'Installer contains the hidden verification build');
    const licensePayload = payload.filter(entry => entry.name !== 'texypaper.exe');
    const extractedLicenseFiles = ['LICENSE', 'THIRD_PARTY_NOTICES.md', ...filesUnder(path.join(temporary, 'licenses'), 'licenses/')].sort();
    assert.deepEqual(extractedLicenseFiles, licensePayload.map(entry => entry.name).sort(), 'Installer license payload file set differs from source');
    for (const entry of licensePayload) {
      assert.equal(fileHash(path.join(temporary, entry.name)), entry.sha256, `Installer license hash mismatch: ${entry.name}`);
      assert.equal(fileHash(entry.source), entry.sha256, `Source changed during verification: ${entry.name}`);
    }
    assert.equal(fileHash(normalPath), normalSha, 'Normal exe changed during verification');
    const metadata = windowsMetadata([
      { name: 'texypaper.exe', path: normalPath },
      { name: installerName, path: installer },
      { name: 'installer/texypaper.exe', path: embeddedPath },
    ]);
    assert.equal(metadata.length, 3, 'PowerShell did not return all binary metadata');
    for (const item of metadata) {
      assert.equal(item.productName, 'TexyPaper', `Unexpected product name: ${item.name}`);
      assert.equal(item.fileVersion, version, `Unexpected file version: ${item.name}`);
      assert.equal(item.productVersion, version, `Unexpected product version: ${item.name}`);
      if (values.signed) {
        assert.equal(item.signature, 'Valid', `Invalid Authenticode signature: ${item.name}: ${item.signature}`);
        assert(item.signerSubject && item.signerThumbprint && item.signerIssuer, `Missing signer identity: ${item.name}`);
        assert(item.timestampSubject, `Missing Authenticode timestamp: ${item.name}`);
        assert.equal(item.signerSubject, metadata[0].signerSubject, `Signer subject differs: ${item.name}`);
        assert.equal(item.signerIssuer, metadata[0].signerIssuer, `Signer issuer differs: ${item.name}`);
      } else {
        assert.equal(item.signature, 'NotSigned', `${item.name} is signed or has an invalid signature; use --signed for a signed release`);
      }
    }
    const assets = [installerName, portableName].map(name => ({ name, sha256: fileHash(path.join(output, name)), bytes: statSync(path.join(output, name)).size }));
    const manifest = {
      version,
      productionStartup: 'normal visible/focused Tauri startup; no hidden override; production release feed baked in',
      exeSha256: normalSha,
      hiddenVerificationExeSha256: hiddenSha,
      assets,
    };
    const proof = {
      version,
      payloadFileCount: payload.length,
      sourceLicenseHashesMatchBothDistributions: true,
      portableAllPayloadHashesMatch: true,
      normalExecutableMatchesPortable: true,
      installerExecutableDiffersOnlyByTauriBundleType: values.signed ? null : bundleTypeProof(normal, embedded, normalSha),
      windowsMetadata: metadata.slice(0, 2).map(({ signerSubject, signerThumbprint, signerIssuer, timestampSubject, ...item }) => values.signed ? { ...item, signerSubject, signerThumbprint, signerIssuer, timestampSubject } : item),
      hiddenBuildDistributed: false,
    };
    if (values.signed) proof.signedExecutableVerification = {
      sameSigner: true,
      signatures: metadata.map(item => ({ name: item.name, status: item.signature, signerSubject: item.signerSubject, signerThumbprint: item.signerThumbprint, signerIssuer: item.signerIssuer, timestampSubject: item.timestampSubject })),
    };
    for (const [name, data] of [['release-manifest.json', manifest], ['package-proof.json', proof]]) {
      writeFileSync(path.join(output, name), `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
    }
    writeFileSync(path.join(output, 'SHA256SUMS.txt'), assets.map(asset => `${asset.sha256} ${asset.name}\n`).join(''), { flag: 'wx' });
    console.log(JSON.stringify({ output, payloadFileCount: payload.length, assets, signed: values.signed }, null, 2));
  } catch (error) {
    // Only this invocation's new directory is removed; existing outputs never enter this block.
    rmSync(output, { recursive: true, force: true });
    throw error;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

try { main(); } catch (error) { console.error(`Package release failed: ${error.message}`); process.exitCode = 1; }
