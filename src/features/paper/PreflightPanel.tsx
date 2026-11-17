import { useMemo } from 'react';
import { t, useI18n } from '../../ui/i18n';
import { analyzePreflight, type PreflightIssue } from './preflight';
import type { PaperCorpus } from './types';
import './paperAnalysis.css';

type Props = { corpus: PaperCorpus; rootTex: string | null; buildState: 'missing' | 'stale' | 'current'; onNavigate: (path: string, line: number) => void };
function issueLabel(issue: PreflightIssue): string {
  switch (issue.code) {
    case 'todo': return t('미완료 표시', 'Unfinished marker');
    case 'missing-citation': return t('검색 범위에서 정의를 찾지 못한 인용 키', 'Citation key not found in the scanned scope');
    case 'missing-label': return t('검색 범위에서 정의를 찾지 못한 참조 라벨', 'Reference label not found in the scanned scope');
    case 'duplicate-key': return t('중복된 인용 키', 'Duplicate citation key');
    case 'duplicate-label': return t('중복된 라벨', 'Duplicate label');
    case 'missing-file': return t('검색한 파일에서 찾지 못한 입력/문헌 파일', 'Input or bibliography file not found among scanned files');
    case 'bib-syntax': return t('BibTeX 구문 또는 문자열 확인 필요', 'Check BibTeX syntax or strings');
    case 'coverage': return t('분석 범위가 불확실함', 'Uncertain analysis coverage');
  }
}
function detailLabel(issue: PreflightIssue): string {
  if (issue.code !== 'coverage') return issue.detail;
  const descriptions: Record<string, string> = {
    'no-root-selected': t('주 문서가 없어 프로젝트의 TeX 파일을 함께 검색했습니다. 서로 다른 논문의 정의가 섞일 수 있습니다.', 'No root selected: TeX files were scanned together and may belong to independent papers.'),
    'no-tex-source': t('분석할 TeX 소스를 찾지 못했습니다.', 'No TeX source was available to analyze.'),
    'incomplete-corpus': t('프로젝트 파일 검색이 끝나지 않았습니다.', 'The project file scan is incomplete.'),
    'includeonly-active': t('includeonly가 활성화되어 제외된 파일은 검사하지 않았습니다.', 'includeonly is active; excluded inputs were not checked.'),
    'dynamic-input': t('입력 경로가 동적이거나 읽을 수 없어 연결된 파일을 추적하지 못했습니다.', 'An input path is dynamic or unreadable; its linked source could not be followed.'),
    'dynamic-bibliography': t('문헌 경로가 동적이거나 외부 리소스여서 추적하지 못했습니다.', 'A bibliography path is dynamic or external and could not be followed.'),
    'input-search-path-assumption': t('입력 파일의 상대 경로를 가정했습니다. TeX 검색 경로와 다를 수 있습니다.', 'An input file’s relative search path was assumed and may differ from TeX’s search path.'),
    'cyclic-input': t('입력 파일이 순환합니다. 반복 확장을 수행하지 않았습니다.', 'Input files form a cycle. Repeated expansion was not performed.'),
    'repeated-input': t('같은 입력 파일이 반복해서 연결됩니다. 라벨·인용 정의의 중복 확장을 수행하지 않았습니다.', 'An input file is referenced repeatedly. Repeated label/citation expansion was not performed.'),
    'bibliography-search-path-assumption': t('문헌 파일의 상대 경로를 가정했습니다. 빌드의 검색 경로와 다를 수 있습니다.', 'A bibliography file’s relative search path was assumed and may differ from the build’s search path.'),
    'external-document-labels': t('외부 문서의 라벨은 불러오지 않았습니다.', 'Labels from an external document were not loaded.'),
    'unclosed-verbatim': t('리터럴 코드 구간이 닫히지 않았습니다. 뒤쪽 코드는 분석하지 못할 수 있습니다.', 'A literal-code region is unclosed; later source may not have been analyzed.'),
    'unclosed-conditional': t('조건부 코드 구간이 닫히지 않았습니다.', 'A conditional code region is unclosed.'),
    'unclosed-command-argument': t('명령 인자가 닫히지 않아 해석하지 못했습니다.', 'A command argument is unclosed and could not be parsed.'),
    'unparsed-macro-definition': t('매크로 정의의 경계를 확정하지 못했습니다.', 'The boundary of a macro definition could not be determined.'),
    'macro-generated-references': t('매크로가 인용·참조·입력 명령을 만들 수 있습니다. 매크로는 실행하지 않았습니다.', 'A macro may generate citations, references or inputs. Macros were not expanded.'),
    'conditional-or-dynamic-tex': t('조건부 또는 동적 TeX 코드를 실행하지 않았습니다. 발견 사항은 실제 빌드와 대조하세요.', 'Conditional or dynamic TeX was not executed. Compare these findings with the actual build.'),
    'dynamic-definition-key': t('동적이거나 지원 범위 밖인 정의 키를 해석하지 못했습니다.', 'A dynamic or unsupported definition key could not be resolved.'),
    'dynamic-reference-key': t('동적이거나 지원 범위 밖인 인용·참조 키를 해석하지 못했습니다.', 'A dynamic or unsupported citation/reference key could not be resolved.'),
    'unparsed-reference-command': t('인용·참조 명령의 인자를 해석하지 못했습니다.', 'A citation/reference command’s arguments could not be resolved.'),
  };
  if (issue.detail.startsWith('citation-key-case:')) return t(`인용 키의 대소문자가 정의와 다릅니다: ${issue.detail.slice(18)}`, `Citation key differs in case from its definition: ${issue.detail.slice(18)}`);
  if (issue.detail.startsWith('skipped:')) return t(`파일 검색에서 건너뜀: ${issue.detail.slice(8)}`, `Skipped by the file scan: ${issue.detail.slice(8)}`);
  return descriptions[issue.detail] ?? issue.detail;
}
export function PreflightPanel({ corpus, rootTex, buildState, onNavigate }: Props) {
  useI18n();
  const report = useMemo(() => analyzePreflight(corpus, rootTex), [corpus, rootTex]);
  const findings = report.issues.filter(issue => issue.code !== 'coverage');
  const coverage = report.issues.filter(issue => issue.code === 'coverage');
  return <section className="paper-analysis paper-preflight" aria-label={t('논문 제출 전 확인', 'Paper preflight')}>
    <p className="paper-analysis-note">{t('로컬 소스의 정적 분석입니다. TeX 매크로·패키지·검색 경로를 실행하지 않으며, 참고문헌의 사실성이나 학회 규정 준수를 검증하지 않습니다. 최종 빌드와 로그를 반드시 확인하세요.', 'Local static source analysis only. It does not execute TeX macros, packages or search paths, verify bibliographic facts, or certify venue compliance. Always review the final build and log.')}</p>
    <dl className="paper-preflight-summary">
      <div><dt>{t('주 문서', 'Root document')}</dt><dd><code>{rootTex || t('선택되지 않음 · 프로젝트 전체 범위', 'Not selected · project-wide scope')}</code></dd></div>
      <div><dt>{t('빌드 상태', 'Build state')}</dt><dd>{buildState === 'current' ? t('현재 소스 기준 빌드 · 로그 검토 필요', 'Built from current source · review the log') : buildState === 'stale' ? t('소스 변경 후 빌드가 필요합니다.', 'Source changed; rebuild required.') : t('빌드 결과가 없습니다.', 'No build result available.')}</dd></div>
      <div><dt>{t('분석한 파일', 'Analyzed files')}</dt><dd>{t(`TeX ${report.texFiles.length}개 · BibTeX ${report.bibFiles.length}개 · 인용 ${report.citationCount}개 · 참조 ${report.referenceCount}개`, `${report.texFiles.length} TeX · ${report.bibFiles.length} BibTeX · ${report.citationCount} citations · ${report.referenceCount} references`)}</dd></div>
    </dl>
    <p className={report.complete ? 'paper-analysis-note' : 'paper-analysis-warning'} role="status">{report.complete ? t('요청한 정적 검색 범위의 파일을 모두 확인했습니다. 이는 문서 전체의 유효성을 뜻하지 않습니다.', 'All files in the requested static scan scope were checked. This does not establish overall document validity.') : t('분석 범위가 불완전하거나 불확실합니다. 항목이 없어도 이상 없음으로 판단할 수 없습니다.', 'Analysis coverage is incomplete or uncertain. An empty findings list does not mean all clear.')}</p>
    {coverage.length > 0 && <details className="paper-analysis-details" open><summary>{t(`분석 범위 확인 ${coverage.length}개`, `${coverage.length} coverage notices`)}</summary><ul>{coverage.map((issue, i) => <li key={`${issue.path}-${issue.line}-${i}`}><span>{detailLabel(issue)}</span>{issue.path && <button type="button" className="paper-source-link" onClick={() => onNavigate(issue.path, issue.line)} aria-label={t(`${issue.path} ${issue.line}줄로 이동`, `Go to ${issue.path}, line ${issue.line}`)}>{issue.path}:{issue.line}</button>}</li>)}</ul></details>}
    <h3>{t(`확인 사항 ${findings.length}개`, `${findings.length} findings`)}</h3>
    {findings.length > 0 ? <ul className="paper-preflight-list">{findings.map((issue, i) => <li key={`${issue.path}-${issue.line}-${issue.code}-${i}`}><strong>{issueLabel(issue)}</strong><p>{detailLabel(issue)}</p><button type="button" className="paper-source-link" onClick={() => onNavigate(issue.path, issue.line)} aria-label={t(`${issue.path} ${issue.line}줄로 이동`, `Go to ${issue.path}, line ${issue.line}`)}>{issue.path}:{issue.line}</button></li>)}</ul> : <p className="paper-analysis-empty">{t('이 정적 검색 범위에서 확인 사항을 찾지 못했습니다. 빌드 결과·그림·표·참고문헌을 직접 확인하세요.', 'No findings in this static scan scope. Review the build output, figures, tables and bibliography yourself.')}</p>}
  </section>;
}
