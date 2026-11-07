import type { WorkspaceRef } from '../../contracts';

export const ASSET_SIZE_LIMIT = 20 * 1024 * 1024;
export const ASSET_CHUNK_SIZE = 192 * 1024;
const extensions: Record<string, true> = { png: true, jpg: true, jpeg: true, gif: true, webp: true, pdf: true, eps: true, svg: true };
export type AssetFile = { name: string; bytes: Uint8Array | ArrayBuffer };
export type AssetRequest = <T>(command: string, workspace: WorkspaceRef, args?: unknown) => Promise<T>;
export type AssetImportResult = { imported: { path: string; name: string }[]; failed: { name: string; code: string; message: string }[] };

export function sanitizeAssetName(input: string): string {
  const basename = input.split(/[\\/]/).at(-1) ?? '';
  const dot = basename.lastIndexOf('.');
  const extension = dot >= 0 ? basename.slice(dot + 1).toLowerCase() : '';
  let stem = (dot >= 0 ? basename.slice(0, dot) : basename).normalize('NFC').replace(/[^\p{L}\p{N}_-]/gu, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'image';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(stem)) stem = `image-${stem}`;
  return extension ? `${stem}.${extension}` : stem;
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
export async function importAssets({ workspace, request, files, targetDir, existingNames }: {
  workspace: WorkspaceRef; request: AssetRequest; files: AssetFile[]; targetDir: string; existingNames: Set<string>;
}): Promise<AssetImportResult> {
  const result: AssetImportResult = { imported: [], failed: [] };
  const names = new Set([...existingNames].map(name => name.toLocaleLowerCase()));
  for (const file of files) {
    let uploadId: string | undefined;
    try {
      const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
      const sanitized = sanitizeAssetName(file.name), dot = sanitized.lastIndexOf('.'), extension = sanitized.slice(dot + 1);
      if (dot < 0 || !Object.hasOwn(extensions, extension)) throw { code: 'ASSET_EXTENSION', message: 'Unsupported image or figure extension' };
      if (bytes.byteLength > ASSET_SIZE_LIMIT) throw { code: 'ASSET_TOO_LARGE', message: 'Images and figures must be at most 20 MiB' };
      const stem = sanitized.slice(0, dot);
      let name = sanitized, suffix = 1;
      while (names.has(name.toLocaleLowerCase())) name = `${stem}-${suffix++}.${extension}`;
      names.add(name.toLocaleLowerCase());
      const path = targetDir ? `${targetDir}/${name}` : name;
      // Copy only when the caller supplied a view backed by a SharedArrayBuffer.
      const digestBytes = bytes.buffer instanceof ArrayBuffer ? bytes as Uint8Array<ArrayBuffer> : new Uint8Array(bytes);
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', digestBytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      ({ uploadId } = await request<{ uploadId: string }>('asset_import_begin', workspace, { path, byteLength: bytes.byteLength, sha256 }));
      for (let offset = 0, index = 0; offset < bytes.byteLength; offset += ASSET_CHUNK_SIZE, index++) {
        await request('asset_import_chunk', workspace, { uploadId, index, data: base64(bytes.subarray(offset, offset + ASSET_CHUNK_SIZE)) });
      }
      const committed = await request<{ path: string; byteLength: number; sha256: string }>('asset_import_commit', workspace, { uploadId });
      result.imported.push({ path: committed.path, name });
    } catch (error) {
      if (uploadId) { try { await request('asset_import_abort', workspace, { uploadId }); } catch { /* The original failure remains authoritative. */ } }
      const failure = error as { code?: string; message?: string };
      result.failed.push({ name: file.name, code: failure?.code ?? 'ASSET_IMPORT_FAILED', message: failure?.message ?? String(error) });
    }
  }
  return result;
}
