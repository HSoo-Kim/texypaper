import { useI18n } from '../../ui/i18n';
import type { WorkspaceRef } from '../../contracts';
import type { ChatAction, ExecutionPermission, ExecutionRequest } from './chatTypes';

export function ExecutionReview({ execution, workspace, permission, onAction }: { execution: ExecutionRequest; workspace: WorkspaceRef; permission: ExecutionPermission; onAction: (action: ChatAction) => void }) {
  const { t } = useI18n();
  const labels: Record<ExecutionRequest['status'], string> = {
    pending: t('실행 승인 대기 · 아직 실행하지 않음', 'Awaiting approval · not executed'),
    running: t('실행 중', 'Running'), completed: t('실행 완료', 'Completed'), failed: t('실행 실패', 'Failed'),
    cancelled: t('실행 중지됨', 'Cancelled'), rejected: t('실행 거절됨', 'Rejected'), timeout: t('제한 시간 초과', 'Timed out'),
  };
  return <article className="execution-review" data-testid="command-card" data-command-id={execution.id} data-status={execution.status} data-task-id={execution.taskId} data-workspace-id={execution.workspaceId}>
    <header><strong>{execution.summary}</strong><p role="status">{labels[execution.status]}{execution.exitCode !== null && ` · ${t('종료 코드', 'Exit code')} ${execution.exitCode}`}</p></header>
    <dl className="execution-metadata"><dt>{t('환경', 'Environment')}</dt><dd>{workspace.environmentId}</dd><dt>{t('작업 폴더', 'Working directory')}</dt><dd><code>{workspace.root}{execution.cwd ? `/${execution.cwd}` : ''}</code></dd><dt>{t('제한 시간', 'Time limit')}</dt><dd>{execution.timeoutSeconds}{t('초', ' seconds')}</dd></dl>
    <details open={execution.status === 'pending'}><summary>{t('정확한 실행 인수 (argv)', 'Exact program arguments (argv)')}</summary><pre className="execution-argv">{JSON.stringify(execution.argv, null, 2)}</pre></details>
    {execution.status === 'pending' && <><p className="agent-note">{t('명령과 스크립트는 현재 계정 권한으로 실행되어 프로젝트 밖에도 영향을 줄 수 있습니다. 샌드박스나 자동 실행 취소 기능이 아닙니다.', 'Commands and scripts run with your account permissions and can affect files outside the project. This is not a sandbox and cannot be automatically undone.')}</p><div className="agent-actions"><button type="button" className="primary" data-testid="command-approve" disabled={permission === 'deny'} onClick={() => onAction({ type: 'execution-decide', id: execution.id, decision: 'approve' })}>{t('이 명령 실행 승인', 'Approve this command')}</button><button type="button" data-testid="command-reject" onClick={() => onAction({ type: 'execution-decide', id: execution.id, decision: 'reject' })}>{t('거절', 'Reject')}</button></div></>}
    {execution.status === 'running' && <button type="button" data-testid="command-cancel" onClick={() => onAction({ type: 'execution-cancel', id: execution.id })}>{t('이 명령 중지', 'Stop this command')}</button>}
    {(execution.stdout || execution.stderr || execution.truncated) && <details className="execution-output" open><summary>{t('실행 출력', 'Execution output')}</summary>{execution.stdout && <section><h4>stdout</h4><pre data-testid="command-stdout">{execution.stdout}</pre></section>}{execution.stderr && <section><h4>stderr</h4><pre data-testid="command-stderr">{execution.stderr}</pre></section>}{execution.truncated && <p className="agent-note" data-testid="execution-truncated">{t('출력이 저장 한도를 넘어 일부만 표시됩니다.', 'Output exceeded the storage limit; only the retained portion is shown.')}</p>}</details>}
    {execution.error && <div role="alert" className="agent-error"><p>{execution.error.message}</p><code>{execution.error.code}</code></div>}
  </article>;
}
