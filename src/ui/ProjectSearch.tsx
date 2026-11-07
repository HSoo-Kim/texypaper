import {useEffect, useId, useRef, useState} from 'react';
import type {WorkspaceRef} from '../contracts';
import {request} from '../api';
import {t} from './i18n';
import {Icon} from './Icon';
import {ProjectReplace} from '../features/search/ProjectReplace';

type Match = {path: string; line: number; text: string};
export type ProjectSearchProps = {
  workspace: WorkspaceRef;
  onOpen: (path: string, line: number) => void;
  onError?: (error: unknown) => void;
  onClose: () => void;
  flush?: () => Promise<boolean>;
  onApplied?: (paths: string[]) => void;
};
export function ProjectSearch({workspace, onOpen, onError, onClose, flush, onApplied}: ProjectSearchProps) {
  const [query, setQuery] = useState(''), [matches, setMatches] = useState<Match[]>([]);
  const [cursor, setCursor] = useState<string>(), [busy, setBusy] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false), [replaceBusy, setReplaceBusy] = useState(false);
  const [matchCase, setMatchCase] = useState(false), [searchVersion, setSearchVersion] = useState(0);
  const sequence = useRef(0), replaceId = useId();
  const errorRef = useRef(onError); errorRef.current = onError;
  const caseSensitive = replaceOpen && matchCase;
  useEffect(() => {
    const current = ++sequence.current;
    setCursor(undefined); setMatches([]);
    if (!query.trim()) {setBusy(false); return;}
    setBusy(true);
    const timer = window.setTimeout(() => {
      void request<{matches: Match[]; nextCursor?: string}>('project_search', workspace, {query, caseSensitive, limit: 200})
        .then(result => {if (sequence.current !== current) return; setMatches(result.matches); setCursor(result.nextCursor);})
        .catch(error => {if (sequence.current === current) errorRef.current?.(error);})
        .finally(() => {if (sequence.current === current) setBusy(false);});
    }, 180);
    return () => {clearTimeout(timer); sequence.current++;};
  }, [query, workspace.id, workspace.epoch, caseSensitive, searchVersion]);
  const next = async () => {
    const current = sequence.current;
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const result = await request<{matches: Match[]; nextCursor?: string}>('project_search', workspace, {query, caseSensitive, cursor, limit: 200});
      if (current === sequence.current) {setMatches(result.matches); setCursor(result.nextCursor);}
    } catch (error) {if (current === sequence.current) errorRef.current?.(error);}
    finally {if (current === sequence.current) setBusy(false);}
  };
  return <section className="project-search-panel" aria-label={t('프로젝트 검색', 'Project search')}>
    <div className="pane-heading"><strong>{t('프로젝트 검색', 'Project search')}</strong><button className="icon-button" disabled={replaceBusy} aria-label={t('검색 패널 닫기', 'Close search panel')} onClick={onClose}><Icon name="close"/></button></div>
    <label className="project-search-field"><span className="sr-only">{t('프로젝트 본문 검색', 'Search project text')}</span><input autoFocus type="search" value={query} disabled={replaceBusy} onChange={event => setQuery(event.target.value)} onKeyDown={event => {if (event.key === 'Enter') {event.preventDefault(); setSearchVersion(value => value + 1);}}} placeholder={t('프로젝트에서 찾기', 'Find in project')}/></label>
    <button data-testid="replace-toggle" className="replace-toggle" aria-expanded={replaceOpen} aria-controls={replaceId} disabled={replaceBusy} onClick={() => setReplaceOpen(value => !value)}><Icon name="chevronDown" size={14}/>{t('바꾸기', 'Replace')}</button>
    <div id={replaceId} hidden={!replaceOpen} className="replace-container"><ProjectReplace key={`${workspace.id}:${workspace.epoch}`} workspace={workspace} query={query} matchCase={matchCase} onMatchCaseChange={setMatchCase} flush={flush} onApplied={paths => {setSearchVersion(value => value + 1); onApplied?.(paths);}} onError={onError} onBusyChange={setReplaceBusy}/></div>
    <p className="search-summary" role="status">{busy ? t('검색 중…', 'Searching…') : query ? `${matches.length} ${t('개 결과', 'results')}` : t('프로젝트 파일의 텍스트를 검색합니다.', 'Search text across project files.')}</p>
    <div className="project-search-results">{matches.map((match, index) => <button key={`${match.path}:${match.line}:${index}`} onClick={() => onOpen(match.path, match.line)}><strong>{match.path}:{match.line}</strong><span>{match.text}</span></button>)}</div>
    {cursor && <button disabled={busy} onClick={() => void next()}>{t('다음 검색 결과', 'Next results')}</button>}
  </section>;
}
