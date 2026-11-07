import { describe, expect, it } from 'vitest';
import type { WorkspaceRef } from '../../contracts';
import { ASSET_CHUNK_SIZE, ASSET_SIZE_LIMIT, importAssets, sanitizeAssetName, type AssetRequest } from './importAssets';

const workspace = { id: 'assets', epoch: 1, environmentId: 'local', root: '/paper' } as WorkspaceRef;
function fixture(failChunk = false) {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  let path = '', sha256 = '', byteLength = 0;
  const chunks: Uint8Array[] = [];
  const request: AssetRequest = async <T>(command: string, _workspace: WorkspaceRef, args?: unknown) => {
    const value = args as Record<string, unknown>; calls.push({ command, args: value });
    if (command === 'asset_import_begin') { path = String(value.path); sha256 = String(value.sha256); byteLength = Number(value.byteLength); return { uploadId: 'upload' } as T; }
    if (command === 'asset_import_chunk') {
      if (failChunk) throw { code: 'DISCONNECTED', message: 'Connection lost' };
      chunks.push(Uint8Array.from(atob(String(value.data)), character => character.charCodeAt(0)));
    }
    if (command === 'asset_import_commit') return { path, sha256, byteLength } as T;
    return {} as T;
  };
  return { request, calls, chunks };
}
describe('asset imports', () => {
  it.each([['C:\\temp\\My figure #1.PNG', 'My_figure_1.png'], ['../한글 그림{a}.PDF', '한글_그림_a.pdf'], ['NUL.jpg', 'image-NUL.jpg'], ['.png', 'image.png'], ['a.b.jpg', 'a_b.jpg']])('sanitizes %s', (input, expected) => expect(sanitizeAssetName(input)).toBe(expected));
  it('reserves unique, case-insensitive names across a batch without mutating caller names', async () => {
    const fake = fixture(), existingNames = new Set(['PLOT.PNG', 'plot-1.png']);
    const result = await importAssets({ workspace, request: fake.request, files: [{ name: 'plot.png', bytes: new Uint8Array([1]) }, { name: 'plot.png', bytes: new Uint8Array([2]) }], targetDir: 'figures', existingNames });
    expect(result.imported.map(file => file.path)).toEqual(['figures/plot-2.png', 'figures/plot-3.png']);
    expect(existingNames.size).toBe(2);
  });
  it.each([0, ASSET_CHUNK_SIZE - 1, ASSET_CHUNK_SIZE, ASSET_CHUNK_SIZE + 1, 3 * 1024 * 1024])('uploads %i bytes sequentially with an end-to-end hash', async length => {
    const fake = fixture(), bytes = Uint8Array.from({ length }, (_, index) => index % 251);
    const result = await importAssets({ workspace, request: fake.request, files: [{ name: 'plot.png', bytes: bytes.buffer }], targetDir: '', existingNames: new Set() });
    expect(result.failed).toEqual([]);
    expect(fake.chunks.map(chunk => chunk.byteLength)).toEqual(Array.from({ length: Math.ceil(length / ASSET_CHUNK_SIZE) }, (_, index) => Math.min(ASSET_CHUNK_SIZE, length - index * ASSET_CHUNK_SIZE)));
    expect(fake.calls.filter(call => call.command === 'asset_import_chunk').map(call => call.args.index)).toEqual(fake.chunks.map((_, index) => index));
    const combined = new Uint8Array(length); let offset = 0;
    for (const chunk of fake.chunks) { combined.set(chunk, offset); offset += chunk.length; }
    expect(combined).toEqual(bytes);
    const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', combined))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    expect(fake.calls[0].args.sha256).toBe(expected);
  });
  it('rejects extensions and oversize assets before native requests', async () => {
    const fake = fixture();
    const result = await importAssets({ workspace, request: fake.request, files: [{ name: 'bad.exe', bytes: new Uint8Array() }, { name: 'large.png', bytes: new Uint8Array(ASSET_SIZE_LIMIT + 1) }], targetDir: '', existingNames: new Set() });
    expect(result.failed.map(file => file.code)).toEqual(['ASSET_EXTENSION', 'ASSET_TOO_LARGE']);
    expect(fake.calls).toEqual([]);
  });
  it('aborts a failed upload and retains the native failure', async () => {
    const fake = fixture(true);
    const result = await importAssets({ workspace, request: fake.request, files: [{ name: 'plot.png', bytes: new Uint8Array([1]) }], targetDir: '', existingNames: new Set() });
    expect(result.imported).toEqual([]);
    expect(result.failed[0].code).toBe('DISCONNECTED');
    expect(fake.calls.map(call => call.command)).toEqual(['asset_import_begin', 'asset_import_chunk', 'asset_import_abort']);
  });
});
