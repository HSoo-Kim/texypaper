import {useEffect, useId, useRef, useState} from 'react';
import type {AppError, TextDocument, WorkspaceRef} from '../../contracts';
import {normalizeError, request} from '../../api';
import {errorText} from '../../ui/errors';
import {t} from '../../ui/i18n';
import {createReplacePlan, isPrivateReplacePath, REPLACE_BYTE_LIMIT, REPLACE_FILE_LIMIT, REPLACE_MATCH_LIMIT, type ReplacePlan, type ReplaceSkip} from './replacePlan';
import {automaticCheckpointWarning, createAutomaticCheckpoint} from '../history/checkpoints';
import './replace.css';

type SearchPage = {matches: {path: string}[]; nextCursor?: string | null; truncated?: boolean; incomplete?: boolean};
type Applied = {transactionId: string; paths: string[]; count: number; undone?: boolean};
type Props = {
  workspace: WorkspaceRef; query: string; matchCase: boolean; onMatchCaseChange: (value: boolean) => void;
  flush?: () => Promise<boolean>; onApplied?: (paths: string[]) => void; onError?: (error: unknown) => void;
  onBusyChange: (busy: boolean) => void;
};
function skipReason(reason: string): string {
  switch (reason) {
    case 'private': return t('비공개 프로젝트 메타데이터', 'Private project metadata');
    case 'large': return t('4 MiB를 초과하는 파일', 'File exceeds 4 MiB');
    case 'encoding': return t('UTF-8이 아닌 파일', 'Non-UTF-8 file');
    case 'truncated': return t('일부만 읽은 파일', 'Truncated file');
    case 'readonly': return t('읽기 전용 파일', 'Read-only file');
    default: return reason;
  }
}
function documentSkip(document: TextDocument): string | undefined {
  if (document.revision.byteLength > REPLACE_BYTE_LIMIT) return 'large';
  if (document.encoding !== 'utf8' && document.encoding !== 'utf8Bom') return 'encoding';
  if (document.truncated) return 'truncated';
  if (document.readOnly) return 'readonly';
}
function DiffLine({before, after}: {before: string; after: string}) {
  let start = 0, tail = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (tail < before.length - start && tail < after.length - start && before[before.length - tail - 1] === after[after.length - tail - 1]) tail++;
  // Never split an astral character between unchanged and emphasized text.
  if (start > 0 && /[\udc00-\udfff]/.test(before[start] ?? '') && /[\ud800-\udbff]/.test(before[start - 1])) start--;
  if (tail > 0 && /[\udc00-\udfff]/.test(before[before.length - tail] ?? '') && /[\ud800-\udbff]/.test(before[before.length - tail - 1] ?? '')) tail--;
  return <div className="replace-diff">
    <pre aria-label={t('변경 전', 'Before')}><span aria-hidden="true">− </span>{before.slice(0, start)}<del>{before.slice(start, before.length - tail)}</del>{tail ? before.slice(-tail) : ''}</pre>
    <pre aria-label={t('변경 후', 'After')}><span aria-hidden="true">+ </span>{after.slice(0, start)}<ins>{after.slice(start, after.length - tail)}</ins>{tail ? after.slice(-tail) : ''}</pre>
  </div>;
}
export function ProjectReplace({workspace, query, matchCase, onMatchCaseChange, flush, onApplied, onError, onBusyChange}: Props) {
  const [replacement, setReplacement] = useState(''), [wholeWord, setWholeWord] = useState(false);
  const [review, setReview] = useState<{key: string; plan: ReplacePlan} | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState(''), [applied, setApplied] = useState<Applied | null>(null);
  const sequence = useRef(0), working = useRef(false), id = useId();
  const key = JSON.stringify([workspace.id, workspace.epoch, query, replacement, matchCase, wholeWord]);
  const currentKey = useRef(key); currentKey.current = key;
  useEffect(() => { sequence.current++; setReview(null); setError(null); setNotice(''); return () => { sequence.current++; }; }, [key]);
  useEffect(() => () => { working.current = false; }, []);
  const plan = review?.key === key ? review.plan : null;
  const report = (cause: unknown) => { const failure = normalizeError(cause); setError(failure); onError?.(failure); };
  const start = () => { working.current = true; setBusy(true); onBusyChange(true); setError(null); setNotice(''); };
  const finish = () => { working.current = false; setBusy(false); onBusyChange(false); };
  async function preview() {
    if (!query || working.current) return;
    const generation = ++sequence.current, previewKey = key;
    const fresh = () => sequence.current === generation && currentKey.current === previewKey;
    start(); setReview(null);
    try {
      const options = {find: query, replace: replacement, matchCase, wholeWord};
      const combined: ReplacePlan = {status: 'ready', files: [], totalMatches: 0, skipped: []};
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await request<SearchPage>('project_search', workspace, {query, caseSensitive: matchCase, limit: 200, ...(cursor ? {cursor} : {})});
        if (!fresh()) return;
        for (const match of page.matches) {
          if (seen.has(match.path)) continue;
          seen.add(match.path);
          if (isPrivateReplacePath(match.path)) { combined.skipped.push({path: match.path, reason: 'private'}); continue; }
          let document: TextDocument;
          try { document = await request<TextDocument>('file_read', workspace, {path: match.path}); }
          catch (cause) { const failure = normalizeError(cause); combined.skipped.push({path: match.path, reason: `${failure.code}: ${errorText(failure)}`}); continue; }
          if (!fresh()) return;
          const reason = documentSkip(document);
          if (reason) { combined.skipped.push({path: match.path, reason}); continue; }
          const one = createReplacePlan([{path: match.path, text: document.text, revisionSha256: document.revision.sha256}], options);
          combined.skipped.push(...one.skipped);
          combined.totalMatches += one.totalMatches;
          if (one.status === 'limit' || combined.totalMatches > REPLACE_MATCH_LIMIT || combined.files.length + one.files.length > REPLACE_FILE_LIMIT) {
            combined.status = 'limit';
            combined.limit = one.limit ?? (combined.totalMatches > REPLACE_MATCH_LIMIT ? 'matches' : 'files');
            combined.files = [];
            setReview({key: previewKey, plan: combined});
            return;
          }
          combined.files.push(...one.files);
        }
        if ((page.truncated || page.incomplete) && !page.nextCursor) throw {code: 'SEARCH_INCOMPLETE', message: t('검색이 끝나지 않았습니다. 검색어를 좁혀 다시 미리 보세요. 파일은 변경되지 않았습니다.', 'Search did not finish. Narrow the query and preview again. No files were changed.'), retryable: true};
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      if (fresh()) setReview({key: previewKey, plan: combined});
    } catch (cause) { if (fresh()) report(cause); }
    finally { finish(); }
  }
  async function apply() {
    if (working.current || !flush || !plan || plan.status !== 'ready' || !plan.files.length) return;
    const snapshot = plan, previewKey = key;
    start();
    // A preview is single-use, including a failed or uncertain native request.
    setReview(null);
    try {
      if (!await flush()) { setNotice(t('열린 파일을 저장하지 못했습니다. 저장 문제를 해결한 뒤 다시 미리 보세요.', 'Open files could not be saved. Resolve saving problems and preview again.')); return; }
      if (currentKey.current !== previewKey) return;
      for (const file of snapshot.files) {
        const document = await request<TextDocument>('file_read', workspace, {path: file.path});
        if (document.revision.sha256 !== file.baseSha256 || documentSkip(document)) throw {code: 'FILE_CONFLICT', message: t('미리 보기 이후 파일이 변경되었습니다. 다시 미리 보세요.', 'Files changed after the preview. Preview again.'), path: file.path, retryable: true};
        if (currentKey.current !== previewKey) return;
      }
      try { await createAutomaticCheckpoint({workspace, request, paths: snapshot.files.map(file => file.path), reason: 'replace'}); }
      catch (cause) { setNotice(automaticCheckpointWarning(cause).message); }
      if (currentKey.current !== previewKey) return;
      const transactionId = crypto.randomUUID();
      const result = await request<{status: string; warnings?: {path: string; error: AppError}[]}>('apply_proposal', workspace, {files: snapshot.files.map(({path, baseSha256, content}) => ({path, baseSha256, content, action: 'edit'})), transactionId, summary: 'project replace'});
      if (result.status !== 'committed') throw {code: 'TRANSACTION_INCOMPLETE', message: t('적용이 확정되지 않았습니다. 트랜잭션 상태를 확인하세요.', 'The transaction did not confirm completion. Check its status.'), retryable: false};
      const paths = snapshot.files.map(file => file.path);
      setApplied({transactionId, paths, count: snapshot.files.reduce((count, file) => count + file.count, 0)});
      onApplied?.(paths);
      if (result.warnings?.length) setNotice(previous => [previous, result.warnings!.map(warning => `${warning.path}: ${warning.error.code}: ${errorText(warning.error)}`).join('\n')].filter(Boolean).join('\n'));
    } catch (cause) { report(cause); }
    finally { finish(); }
  }
  async function undo() {
    if (working.current || !flush || !applied || applied.undone) return;
    start(); setReview(null);
    try {
      if (!await flush()) { setNotice(t('열린 파일을 먼저 저장하세요.', 'Save open files first.')); return; }
      const result = await request<{status: string}>('undo_transaction', workspace, {transactionId: applied.transactionId});
      if (result.status !== 'undone') throw {code: 'TRANSACTION_INCOMPLETE', message: t('실행 취소가 확정되지 않았습니다.', 'Undo did not confirm completion.'), retryable: false};
      setApplied({...applied, undone: true});
      onApplied?.(applied.paths);
    } catch (cause) { report(cause); }
    finally { finish(); }
  }
  const skipped: ReplaceSkip[] = plan?.skipped ?? [];
  return <section className="project-replace" aria-label={t('프로젝트 바꾸기', 'Project replace')} aria-busy={busy}>
    <label htmlFor={id}>{t('바꿀 텍스트', 'Replace with')}</label>
    <input id={id} data-testid="replace-input" value={replacement} disabled={busy} onChange={event => setReplacement(event.target.value)} onKeyDown={event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void preview(); } }}/>
    <div className="replace-options">
      <label><input type="checkbox" data-testid="replace-match-case" checked={matchCase} disabled={busy} onChange={event => onMatchCaseChange(event.target.checked)}/>{t('대소문자 구분', 'Match case')}</label>
      <label><input type="checkbox" data-testid="replace-whole-word" checked={wholeWord} disabled={busy} onChange={event => setWholeWord(event.target.checked)}/>{t('단어 단위', 'Whole word')}</label>
    </div>
    <div className="replace-actions"><button data-testid="replace-preview" disabled={busy || !query} onClick={() => void preview()}>{busy ? t('처리 중…', 'Working…') : t('미리 보기', 'Preview')}</button><button data-testid="replace-apply" disabled={busy || !flush || plan?.status !== 'ready' || !plan.files.length} onClick={() => void apply()}>{t('모두 바꾸기', 'Replace all')}</button></div>
    <p className="replace-note">{t('UTF-8 텍스트 파일만 검색합니다. 4 MiB 초과 파일, 바이너리 및 비공개 메타데이터는 검색 대상에서 제외됩니다. 최대 16개 파일, 2,000곳을 바꿀 수 있습니다.', 'Search covers UTF-8 text only; files over 4 MiB, binary files and private metadata are excluded. Replace up to 16 files and 2,000 matches.')}</p>
    {!flush && <p className="replace-note">{t('열린 파일 저장 기능이 연결되지 않아 변경을 적용할 수 없습니다.', 'Applying is unavailable until open-buffer saving is connected.')}</p>}
    {error && <p className="replace-error" role="alert"><strong>{error.code}</strong>: {errorText(error)}{error.path && <> · {error.path}</>} {t('다시 미리 본 뒤 적용하세요.', 'Preview again before applying.')}</p>}
    {notice && <p className="replace-note" role="status" data-testid="replace-notice">{notice}</p>}
    {applied && <div className="replace-success" role="status">{applied.undone ? t('바꾸기를 실행 취소했습니다.', 'Replacement undone.') : t(`${applied.paths.length}개 파일의 ${applied.count}곳을 바꿨습니다.`, `Replaced ${applied.count} matches in ${applied.paths.length} files`)}{!applied.undone && <button data-testid="replace-undo" disabled={busy || !flush} onClick={() => void undo()}>{t('실행 취소', 'Undo')}</button>}</div>}
    {plan && <div className="replace-review" data-testid="replace-review">
      <p role="status">{plan.status === 'limit' ? t('한도를 초과했습니다. 16개 파일 또는 2,000곳 이하로 검색 범위를 줄이세요. 파일은 변경되지 않았습니다.', 'Limit exceeded. Narrow the search to at most 16 files and 2,000 matches. No files were changed.') : plan.files.length ? t(`검색된 항목 ${plan.totalMatches}개 · 변경할 파일 ${plan.files.length}개`, `${plan.totalMatches} matches found · ${plan.files.length} files to change`) : t(`검색된 항목 ${plan.totalMatches}개 · 변경할 내용이 없습니다.`, `${plan.totalMatches} matches found · No changes needed.`)}</p>
      {plan.files.map(file => <details key={file.path}><summary><code>{file.path}</code> · {file.count} {t('곳', 'matches')}</summary>{file.previews.map((preview, index) => <div key={`${preview.line}:${index}`} className="replace-preview-line"><strong>{t('줄', 'Line')} {preview.line}</strong><DiffLine before={preview.before} after={preview.after}/></div>)}</details>)}
      {!!skipped.length && <details open><summary>{t(`건너뛴 파일 ${skipped.length}개`, `${skipped.length} skipped files`)}</summary><ul>{skipped.map((skip, index) => <li key={`${skip.path}:${index}`}><code>{skip.path}</code>: {skipReason(skip.reason)}</li>)}</ul></details>}
    </div>}
  </section>;
}
