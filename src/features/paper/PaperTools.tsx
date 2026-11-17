import { useEffect, useRef, useState } from 'react';
import type { WorkspaceRef } from '../../contracts';
import { normalizeError } from '../../api';
import { errorText } from '../../ui/errors';
import { t, useI18n } from '../../ui/i18n';
import { loadPaperCorpus } from './project';
import type { PaperCorpus, PaperTool } from './types';
import { ReferencesPanel } from './ReferencesPanel';
import { PreflightPanel } from './PreflightPanel';
import { TableBuilder } from '../tables/TableBuilder';
import './paperTools.css';

type Props = {
  workspace: WorkspaceRef; tool: PaperTool; rootTex: string | null;
  sourceVersion: number; getUnsaved: () => ReadonlyMap<string, string>;
  buildState: 'missing' | 'stale' | 'current'; canInsert: boolean;
  onInsert: (text: string) => void; onNavigate: (path: string, line: number) => void; onClose: () => void;
};

export function PaperTools(props: Props) {
  useI18n();
  const { workspace, tool, rootTex, sourceVersion, buildState, canInsert, onNavigate, onClose } = props;
  const [loaded, setLoaded] = useState<{ corpus: PaperCorpus; version: number } | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const latest = useRef(props); latest.current = props;
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    return () => { if (previous?.isConnected && previous.getClientRects().length && (document.activeElement === document.body || dialog.current?.contains(document.activeElement))) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    if (tool === 'table') return;
    const controller = new AbortController(), version = latest.current.sourceVersion;
    setBusy(true); setError(''); setLoaded(null);
    void loadPaperCorpus(workspace, latest.current.getUnsaved(), controller.signal).then(corpus => {
      if (!controller.signal.aborted) setLoaded({ corpus, version });
    }).catch(error => {
      if (!controller.signal.aborted) setError(errorText(normalizeError(error)));
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [workspace.id, workspace.epoch, tool, refresh]);
  const insert = (text: string) => {
    try { latest.current.onInsert(text); }
    catch (error) { setError(errorText(normalizeError(error))); }
  };
  const title = tool === 'references' ? t('참고문헌 찾기', 'Find references') : tool === 'table' ? t('데이터로 표 만들기', 'Create table from data') : t('제출 전 점검', 'Pre-submission check');
  return <div className="modal-scrim" onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <section ref={dialog} className="modal paper-tools" role="dialog" aria-modal="true" aria-label={title} data-testid="paper-tools" data-tool={tool}>
      <header className="paper-tools-heading"><h2>{title}</h2><div className="button-row">{tool !== 'table' && <button disabled={busy} onClick={() => setRefresh(value => value + 1)}>{t('다시 검사', 'Rescan')}</button>}<button onClick={onClose} aria-label={t('논문 도구 닫기', 'Close paper tools')}>{t('닫기', 'Close')}</button></div></header>
      <div className="paper-tools-body">
        {error && <p role="alert" className="inline-error">{error}</p>}
        {tool !== 'table' && <p className="muted">{t('프로젝트의 TeX·Bib 파일과 열린 미저장 내용을 읽습니다. 서버로 업로드하거나 AI에 보내지 않습니다.', 'Reads project TeX/Bib files and open unsaved edits. Nothing is uploaded to another service or sent to AI.')}</p>}
        {busy && <p role="status">{t('논문 파일을 읽는 중…', 'Reading manuscript files…')}</p>}
        {loaded && loaded.version !== sourceVersion && <p className="paper-tools-stale" role="status">{t('검사 후 소스가 변경되었습니다. 다시 검사해 최신 내용을 확인하세요.', 'The source changed after this scan. Rescan to inspect the latest content.')}</p>}
        {tool === 'references' && loaded && <ReferencesPanel corpus={loaded.corpus} canInsert={canInsert && loaded.version === sourceVersion} onInsert={insert} onNavigate={onNavigate}/>}
        {tool === 'preflight' && loaded && <PreflightPanel corpus={loaded.corpus} rootTex={rootTex} buildState={loaded.version === sourceVersion ? buildState : 'stale'} onNavigate={onNavigate}/>}
        {tool === 'table' && <TableBuilder canInsert={canInsert} onInsert={insert}/>}
      </div>
    </section>
  </div>;
}
