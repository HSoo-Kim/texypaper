import { normalizeError, request } from '../../api';
import type { TextDocument, WorkspaceRef } from '../../contracts';
import { discoverEntries } from '../history/checkpoints';
import { t } from '../../ui/i18n';
import type { PaperCorpus } from './types';

const MAX_FILES = 400, MAX_FILE_BYTES = 1024 * 1024, MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/** Read-only, on demand, from the real project host. Never reads a user profile or sends text to AI. */
export async function loadPaperCorpus(workspace: WorkspaceRef, unsaved: ReadonlyMap<string, string>, signal: AbortSignal, invoke = request): Promise<PaperCorpus> {
  signal.throwIfAborted();
  const entries = await discoverEntries({ workspace, request: async <T>(command: string, scope: WorkspaceRef, args?: unknown) => {
    signal.throwIfAborted();
    const result = await invoke<T>(command, scope, args);
    signal.throwIfAborted();
    return result;
  } });
  const result: PaperCorpus = { files: [], skipped: [], complete: true };
  const encoder = new TextEncoder();
  let total = 0;
  const skip = (path: string, reason: string) => { result.skipped.push({ path, reason }); result.complete = false; };
  for (const entry of entries) {
    signal.throwIfAborted();
    if (entry.kind === 'directory' || !/\.(tex|ltx|bib)$/i.test(entry.path)) continue;
    if (entry.kind !== 'file') { skip(entry.path, t('심볼릭 링크는 검사하지 않습니다.', 'Symbolic links are not scanned.')); continue; }
    if (result.files.length >= MAX_FILES || total >= MAX_TOTAL_BYTES) { skip(entry.path, t('검사 한도: 400개 파일 / 총 8 MiB', 'Scan limit: 400 files / 8 MiB total')); continue; }
    if (!unsaved.has(entry.path) && (entry.byteLength ?? 0) > MAX_FILE_BYTES) { skip(entry.path, t('1 MiB를 넘는 파일', 'File exceeds 1 MiB')); continue; }
    let text = unsaved.get(entry.path);
    if (text === undefined) {
      try {
        const document = await invoke<TextDocument>('file_read', workspace, { path: entry.path });
        signal.throwIfAborted();
        if (document.truncated || !['utf8', 'utf8Bom'].includes(document.encoding)) { skip(entry.path, t('잘렸거나 UTF-8이 아닌 파일', 'Truncated or non-UTF-8 file')); continue; }
        text = document.text;
      } catch (error) {
        signal.throwIfAborted();
        const normalized = normalizeError(error);
        if (['SSH_DISCONNECTED', 'WORKSPACE_STALE', 'WORKSPACE_CLOSED'].includes(normalized.code)) throw normalized;
        skip(entry.path, `${normalized.code}: ${normalized.message}`); continue;
      }
    }
    const bytes = encoder.encode(text).length;
    if (bytes > MAX_FILE_BYTES || total + bytes > MAX_TOTAL_BYTES) { skip(entry.path, t('파일 또는 전체 크기 한도 초과', 'File or total size limit exceeded')); continue; }
    result.files.push({ path: entry.path, text }); total += bytes;
  }
  signal.throwIfAborted();
  return result;
}
