import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { normalizeError, request } from '../../api';
import type { AppError, CommentThread, WorkspaceRef } from '../../contracts';
import { errorText } from '../../ui/errors';
import { t } from '../../ui/i18n';
import { buildReviewReport, reviewExportPathIssue, reviewExportSummary, saveReviewReport } from './reviewReport';
import './review-export.css';

type Props = { workspace: WorkspaceRef; threads: readonly CommentThread[]; onClose: () => void };

export function ReviewExport({ workspace, threads, onClose }: Props) {
  const id = useId();
  const [snapshot] = useState(() => ({ content: buildReviewReport(threads), counts: reviewExportSummary(threads) }));
  const [path, setPath] = useState('review-report.md');
  const [busy, setBusy] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLPreElement>(null);
  const saving = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => {
      mounted.current = false;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  const issue = reviewExportPathIssue(path);
  const pathError = issue === 'metadata'
    ? t('프로젝트 메타데이터 폴더에는 내보낼 수 없습니다.', 'Reports cannot be saved in project metadata folders.')
    : issue === 'extension'
      ? t('.md 확장자를 가진 새 파일 경로를 입력하세요.', 'Enter a new file path ending in .md.')
      : issue ? t('상위 폴더 이동이나 절대 경로 없이 안전한 상대 경로를 입력하세요. 폴더 구분에는 /를 사용하세요.', 'Enter a safe relative path without traversal or absolute paths. Use / between folders.') : null;
  const save = async () => {
    if (saving.current || savedPath || issue) return;
    saving.current = true;
    // The initiating button becomes disabled; keep keyboard focus inside the dialog.
    preview.current?.focus({ preventScroll: true });
    setBusy(true);
    setError(null);
    try {
      await saveReviewReport({ workspace, path, content: snapshot.content, request });
      if (mounted.current) setSavedPath(path);
    } catch (cause) {
      if (mounted.current) setError(normalizeError(cause));
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return createPortal(<div className="modal-scrim review-export-scrim" onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      if (!saving.current) onClose();
    }
  }}>
    <section className="modal review-export" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`} aria-busy={busy} data-testid="review-export">
      <header className="review-export-header">
        <h2 id={`${id}-title`}>{t('검토 보고서 내보내기', 'Export review report')}</h2>
        <p id={`${id}-intro`}>{t('열 때 저장된 전체 댓글의 스냅샷입니다. 상태 필터와 작성 중인 내용은 반영하지 않습니다. 원문과 모든 답글을 그대로 기록하며, 답글을 공식 저자 답변으로 간주하지 않습니다.', 'A snapshot of all saved comments at opening, regardless of the status filter. Unsaved drafts are excluded. Original comments and every reply are included; replies are not treated as formal author responses.')}</p>
        <p className="review-export-counts">{t(`스레드 ${snapshot.counts.threads}개 · 메시지 ${snapshot.counts.messages}개 · 답글 ${snapshot.counts.replies}개`, `${snapshot.counts.threads} threads · ${snapshot.counts.messages} messages · ${snapshot.counts.replies} replies`)}</p>
      </header>
      <div className="review-export-body">
        <h3 className="review-export-preview-label" id={`${id}-preview-label`}>{t('저장할 Markdown 미리보기', 'Markdown preview — exact file content')}</h3>
        <pre ref={preview} id={`${id}-preview`} className="review-export-preview" tabIndex={0} role="region" aria-labelledby={`${id}-preview-label`}>{snapshot.content}</pre>
        <label htmlFor={`${id}-path`}>{t('저장 경로 (프로젝트 기준)', 'Destination (relative to project)')}</label>
        <input ref={input} id={`${id}-path`} value={path} disabled={busy || !!savedPath} onChange={event => { setPath(event.target.value); setError(null); }} spellCheck={false} autoComplete="off" aria-invalid={!!pathError} aria-describedby={`${id}-path-help${pathError ? ` ${id}-path-error` : ''}`} />
        <p className="review-export-help" id={`${id}-path-help`}>{t('현재 프로젝트의 로컬 또는 SSH 호스트에 새 .md 파일만 만듭니다. 하위 폴더는 이미 존재해야 하며, 기존 파일은 덮어쓰지 않습니다. 미리보기를 열거나 경로를 바꾸는 것만으로 저장하지 않습니다.', 'Creates a new .md file on the current project’s local or SSH host. Parent folders must already exist. Existing files are never overwritten. Opening this preview or editing the path does not save anything.')}</p>
        {pathError && <p className="inline-error" id={`${id}-path-error`} role="alert">{pathError}</p>}
        {error && <div className="inline-error" role="alert"><strong>{error.code}</strong><p>{errorText(error)}</p><p>{t('대상 파일이 이미 있다면 다른 경로를 선택하세요. 연결 오류가 있었다면 파일 목록을 새로 고쳐 생성 여부를 확인한 뒤 다시 시도하세요.', 'If the destination exists, choose another path. After a connection error, refresh the file list to check whether the file was created before trying again.')}</p></div>}
        <div role="status" aria-live="polite" className="review-export-status">
          {busy && t('보고서 저장 중… 저장 요청이 끝날 때까지 기다려 주세요.', 'Saving report… Wait for the save request to finish.')}
          {savedPath && <><strong>{t('보고서를 저장했습니다.', 'Report saved.')}</strong><p>{savedPath}</p><p>{t('탐색기 파일 목록을 새로 고쳐 보고서를 여세요. 댓글 내용과 상태는 변경하지 않았습니다.', 'Refresh the explorer file list to open the report. Comment content and statuses were not changed.')}</p></>}
        </div>
      </div>
      <footer className="button-row review-export-actions">
        <button type="button" disabled={busy} onClick={onClose}>{savedPath ? t('닫기', 'Close') : t('취소', 'Cancel')}</button>
        <button type="button" className="primary" disabled={busy || !!savedPath || !!issue} onClick={() => void save()} data-testid="review-export-save">{busy ? t('저장 중…', 'Saving…') : t('새 Markdown 파일로 저장', 'Save new Markdown file')}</button>
      </footer>
    </section>
  </div>, document.body);
}
