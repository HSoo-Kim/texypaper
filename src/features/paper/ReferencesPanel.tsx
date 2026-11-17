import { useId, useMemo, useState } from 'react';
import { t, useI18n } from '../../ui/i18n';
import { bibDisplayText, indexBibTeX, searchBibEntries, type BibDiagnostic } from './bibtex';
import type { PaperCorpus } from './types';
import './paperAnalysis.css';

type Props = { corpus: PaperCorpus; canInsert: boolean; onInsert: (text: string) => void; onNavigate: (path: string, line: number) => void };
function diagnosticLabel(issue: BibDiagnostic): string {
  switch (issue.code) {
    case 'duplicate': return t('중복된 인용 키', 'Duplicate citation key');
    case 'unsafe-key': return t('안전하게 삽입할 수 없는 인용 키', 'Citation key cannot be inserted safely');
    case 'unknown-string': return t('해석하지 못한 문자열 또는 순환 문자열', 'Unresolved or cyclic string');
    case 'malformed': return t('BibTeX 구문 확인 필요', 'Check BibTeX syntax');
  }
}
export function ReferencesPanel({ corpus, canInsert, onInsert, onNavigate }: Props) {
  useI18n();
  const searchId = useId();
  const [query, setQuery] = useState('');
  const index = useMemo(() => indexBibTeX(corpus), [corpus]);
  const entries = useMemo(() => searchBibEntries(index.entries, query), [index.entries, query]);
  const corpusComplete = corpus.complete && corpus.skipped.length === 0;
  const syntaxComplete = !index.diagnostics.some(issue => issue.code === 'malformed');
  return <section className="paper-analysis paper-references" aria-label={t('프로젝트 참고문헌', 'Project references')}>
    <p className="paper-analysis-note">{t('프로젝트의 BibTeX 메타데이터를 로컬에서 검색합니다. 인용 키가 존재해도 문헌의 정확성이나 실제 빌드에서의 인용 성공을 보장하지 않습니다.', 'Search project BibTeX metadata locally. A key’s presence does not verify the reference or guarantee that it resolves in the actual build.')}</p>
    {!corpusComplete && <p className="paper-analysis-warning" role="status">{t('일부 파일을 검색하지 못했습니다. 숨겨진 중복 키를 배제할 수 없어 인용 삽입을 잠갔습니다. 파일 검색을 완료한 뒤 새로 고치세요.', 'Some files were not scanned. Citation insertion is disabled because unseen duplicate keys cannot be ruled out. Complete the file scan, then refresh.')}</p>}
    {!syntaxComplete && <p className="paper-analysis-warning" role="status">{t('BibTeX 구문 오류로 일부 항목을 읽지 못했을 수 있습니다. 숨겨진 중복을 막기 위해 구문을 수정할 때까지 삽입을 잠갔습니다.', 'BibTeX syntax errors may hide entries. Insertion is disabled until syntax is corrected, to avoid unseen duplicate keys.')}</p>}
    {corpus.skipped.length > 0 && <details className="paper-analysis-details"><summary>{t(`건너뛴 파일 ${corpus.skipped.length}개`, `${corpus.skipped.length} skipped files`)}</summary><ul>{corpus.skipped.map((file, i) => <li key={`${file.path}-${i}`}><code>{file.path}</code> — {file.reason}</li>)}</ul></details>}
    <label className="paper-analysis-label" htmlFor={searchId}>{t('제목 · 저자 · 연도 · 인용 키 검색', 'Search title, author, year or citation key')}</label>
    <input id={searchId} className="paper-reference-search" type="search" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" spellCheck={false} />
    <p className="paper-analysis-note" role="status" aria-live="polite">{t(`${index.entries.length}개 중 ${entries.length}개 표시`, `Showing ${entries.length} of ${index.entries.length} entries`)}{corpusComplete && <> · {t('프로젝트 파일 검색 완료', 'Project file scan complete')}</>}</p>
    {index.diagnostics.length > 0 && <details className="paper-analysis-details"><summary>{t(`BibTeX 확인 사항 ${index.diagnostics.length}개`, `${index.diagnostics.length} BibTeX findings`)}</summary><ul>{index.diagnostics.map((issue, i) => <li key={`${issue.path}-${issue.line}-${i}`}><span>{diagnosticLabel(issue)}: <code>{issue.detail}</code></span><button type="button" className="paper-source-link" onClick={() => onNavigate(issue.path, issue.line)} aria-label={t(`${issue.path} ${issue.line}줄로 이동`, `Go to ${issue.path}, line ${issue.line}`)}>{issue.path}:{issue.line}</button></li>)}</ul></details>}
    {entries.length > 0 ? <ul className="paper-reference-list">{entries.map((entry, i) => {
      const disabledReason = entry.duplicate ? t('중복 키를 먼저 수정하세요.', 'Resolve duplicate keys first.') : !entry.safeKey ? t('소스에서 인용 키를 수정하세요.', 'Correct the citation key in source.') : !entry.valid || !syntaxComplete ? t('BibTeX 구문을 먼저 수정하세요.', 'Correct BibTeX syntax first.') : !corpusComplete ? t('파일 검색을 먼저 완료하세요.', 'Complete the file scan first.') : !canInsert ? t('편집 가능한 TeX 소스와 커서가 필요합니다.', 'An editable TeX source and cursor are required.') : '';
      const title = bibDisplayText(entry.fields.title ?? '');
      const author = bibDisplayText(entry.fields.author ?? '');
      const year = bibDisplayText(entry.fields.year || entry.fields.date || '');
      return <li key={`${entry.path}-${entry.line}-${i}`} className="paper-reference-item">
        <div className="paper-reference-heading"><code>{entry.key || t('(키 없음)', '(no key)')}</code><button type="button" disabled={!!disabledReason} title={disabledReason || `\\cite{${entry.key}}`} onClick={() => { if (!disabledReason) onInsert(`\\cite{${entry.key}}`); }} aria-label={t(`${entry.key} 인용 삽입`, `Insert citation ${entry.key}`)}>{t('인용 삽입', 'Insert citation')}</button></div>
        <p className="paper-reference-title">{title || t('제목 메타데이터 없음', 'No title metadata')}</p>
        {(author || year) && <p className="paper-analysis-note">{[author, year].filter(Boolean).join(' · ')}</p>}
        {disabledReason && <p className="paper-analysis-note">{disabledReason}</p>}
        <button type="button" className="paper-source-link" onClick={() => onNavigate(entry.path, entry.line)} aria-label={t(`${entry.path} ${entry.line}줄로 이동`, `Go to ${entry.path}, line ${entry.line}`)}>{entry.path}:{entry.line}</button>
      </li>;
    })}</ul> : <p className="paper-analysis-empty">{index.entries.length ? t('일치하는 항목이 없습니다. 검색어를 바꿔 보세요.', 'No matching entries. Try another search.') : t('검색한 .bib 파일에 읽을 수 있는 항목이 없습니다. BibTeX 파일을 추가하거나 구문 확인 사항을 확인하세요.', 'No readable entries in the scanned .bib files. Add a BibTeX file or review the syntax findings.')}</p>}
  </section>;
}
