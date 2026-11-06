import { useI18n } from '../../ui/i18n';
import { localizedAgentError } from './ProviderSettings';
export type ProposalFile = { action: 'edit' | 'create'; path: string; baseSha256: string | null; content: string; before: string };
export type Proposal = { id: string; workspaceId: string; epoch: number; provider?: string; taskId?: string; summary: string; status: string; files: ProposalFile[]; evidence: { path: string; sha256: string; startLine: number; endLine: number }[]; transactionId?: string; error?: { code: string; message: string } };
function changedContext(before: string, after: string): [string, string] {
  const left = before.split('\n'); const right = after.split('\n'); let first = 0;
  while (first < left.length && first < right.length && left[first] === right[first]) first++;
  let a = left.length; let b = right.length;
  while (a > first && b > first && left[a - 1] === right[b - 1]) { a--; b--; }
  return [left.slice(Math.max(0, first - 2), Math.min(left.length, a + 2)).join('\n'), right.slice(Math.max(0, first - 2), Math.min(right.length, b + 2)).join('\n')];
}
export function ProposalReview({ proposal, busy, onDecision, onUndo }: { proposal: Proposal; busy: boolean; onDecision: (id: string, decision: 'apply' | 'reject') => void; onUndo: (id: string) => void }) {
  const { t } = useI18n();
  const error = proposal.error;
  const transactionId = proposal.transactionId;
  const pending = ['pending', 'conflicted'].includes(proposal.status);
  const labels: Record<string, string> = { pending: t('승인 대기 · 파일 변경 없음', 'Awaiting approval · files unchanged'), conflicted: t('충돌 · 제안 보존됨', 'Conflict · proposal retained'), applied: t('적용됨 · 빌드 결과 확인', 'Applied · check build result'), rejected: t('거절됨 · 파일 변경 없음', 'Rejected · files unchanged'), undone: t('변경 실행 취소됨', 'Changes undone') };
  return <article className="proposal-review" data-testid="proposal-card" data-proposal-id={proposal.id} data-status={proposal.status} data-state={proposal.status} data-provider={proposal.provider} data-task-id={proposal.taskId} data-workspace-id={proposal.workspaceId} aria-label={t('수정 제안 검토', 'Review proposed changes')}>
    <header><strong>{proposal.summary}</strong><p role="status">{labels[proposal.status] ?? proposal.status}</p></header>
    {proposal.files.map(file => {
      const [before, after] = changedContext(file.before, file.content);
      return <details key={file.path} open={proposal.files.length === 1}><summary><span>{file.path}</span> <small>{file.action === 'create' ? t('새 파일', 'New file') : t('수정', 'Edit')}</small></summary><div className="proposal-diff"><section><h4>{t('변경 전', 'Before')}</h4><pre>{before || t('(빈 파일)', '(empty file)')}</pre></section><section><h4>{t('변경 후', 'After')}</h4><pre>{after}</pre></section></div><details><summary>{t('전체 내용과 원본 해시', 'Full content and base hash')}</summary><code className="proposal-hash">{file.baseSha256 ?? t('생성: 원본 없음', 'Create: no base revision')}</code><h4>{t('원본 전체', 'Full original')}</h4><pre>{file.before}</pre><h4>{t('제안 전체', 'Full proposal')}</h4><pre>{file.content}</pre></details></details>;
    })}
    {proposal.evidence.length > 0 && <details><summary>{t('인용 근거', 'Cited evidence')}</summary><ul>{proposal.evidence.map((item, index) => <li key={`${item.path}:${item.startLine}:${index}`}><code>{item.path}:{item.startLine}–{item.endLine}</code><small className="proposal-hash">{item.sha256}</small></li>)}</ul></details>}
    {error && <div className="agent-error" role="alert"><p>{localizedAgentError(error.code, t)}</p><details><summary>{t('오류 세부 내용', 'Error details')}</summary><code>{error.code}: {error.message}</code></details></div>}
    {pending && <div className="agent-actions"><button type="button" data-testid="proposal-apply" className="primary" disabled={busy || proposal.status === 'conflicted'} onClick={() => onDecision(proposal.id, 'apply')}>{busy ? t('처리 중…', 'Working…') : t('변경 적용', 'Apply changes')}</button><button type="button" data-testid="proposal-reject" disabled={busy} onClick={() => onDecision(proposal.id, 'reject')}>{t('거절', 'Reject')}</button></div>}
    {proposal.status === 'applied' && transactionId && <button type="button" disabled={busy} onClick={() => onUndo(proposal.id)}>{t('이 변경 실행 취소', 'Undo these changes')}</button>}
    {proposal.status === 'conflicted' && <p className="agent-note">{t('최신 파일을 읽고 새 제안을 요청하세요. 충돌한 원본은 덮어쓰지 않습니다.', 'Read the latest files and request a new proposal. Conflicting source revisions are never overwritten.')}</p>}
  </article>;
}
export default ProposalReview;
