import assert from 'node:assert/strict';

export const sourcePatchName = 'texypaper-wasmtex-2026-local-assets.patch';
export const sourcePatchSha256 = '315cfa39941e89dc1164afaf33eb18fa60b974fe3e6fe781d975bc508af2e06a';
export const controllerSource = 'source/wasmtex/a97db8a62ed86b118bcfcc8784b7752aa8e988ac/wasm-build/pdftex-worker.js';
export const localWorker = {
  name: 'wasmtex-pdftex.worker.js',
  bytes: 105698,
  sha256: 'f8ff8f549d6ae60d5b41ad6b7c5b4a3974acff1be14e8f357c82c710ea955482',
};

// A single checked-in source patch is applied to the same controller text in
// the upstream generated worker. No WASM, format or other engine is changed.
export function applyWorkerPatch(text, patch) {
  assert(patch.startsWith(`--- a/${controllerSource}\n+++ b/${controllerSource}\n`), 'Unexpected worker source patch target');
  const hunks = patch.split(/^@@ [^\n]*\n/m).slice(1);
  assert.equal(hunks.length, 2, 'Unexpected worker source patch structure');
  for (const hunk of hunks) {
    const lines = hunk.split('\n');
    assert.equal(lines.pop(), '', 'Source patch must preserve final newlines');
    assert(lines.every(line => /^[ +\-]/.test(line)), 'Unsupported source patch row');
    const before = lines.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n') + '\n';
    const after = lines.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n') + '\n';
    const at = text.indexOf(before);
    assert(at >= 0 && at === text.lastIndexOf(before), 'Pinned worker/source patch mismatch');
    text = text.slice(0, at) + after + text.slice(at + before.length);
  }
  return text;
}
