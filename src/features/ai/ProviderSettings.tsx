import { useI18n } from '../../ui/i18n';
import type { GetAccountResponse } from '../../generated/codex-0.153.2/v2/GetAccountResponse';
import type { ModelListResponse } from '../../generated/codex-0.153.2/v2/ModelListResponse';
import type { ChatViewProps } from './chatTypes';
export type Provider = 'codex' | 'claude';
export type ProviderStatus = { provider: Provider; available: boolean; loggedIn: boolean; subscription: boolean; version?: string; code?: string; message?: string; sessionId?: string; account?: GetAccountResponse['account'] };
export type Model = { id: string; label: string; reasoningEfforts: { value: string; label: string }[]; defaultReasoningEffort?: string; catalogSource?: 'official' };
export type ModelsResponse = { models: Model[]; allowCustom: boolean; catalog?: ModelListResponse };
export function localizedAgentError(code: string | undefined, t: (ko: string, en?: string) => string): string {
  const errors: Record<string, [string, string]> = {
    CHECKPOINT_WARNING: ['변경 전 자동 체크포인트를 만들지 못했습니다. 요청한 변경은 계속 진행합니다. 오류 세부 내용을 확인하세요.', 'The automatic checkpoint could not be created. The requested change will continue. See error details.'],
    TRANSMISSION_HISTORY_FAILED: ['공급자 CLI에 데이터가 전달되었지만 전송 내역을 저장하지 못했습니다. 현재 표시된 내역은 앱을 종료하면 사라질 수 있습니다.', 'Data reached the provider CLI, but saving its transmission record failed. The visible record may not survive restarting the app.'],
    AUTH_REQUIRED: ['공식 구독 계정으로 로그인한 뒤 연결 상태를 새로 고치세요.', 'Sign in with the official subscription account, then refresh status.'],
    SUBSCRIPTION_REQUIRED: ['구독 계정이 아닙니다. API/Console/타사 결제로 전환하지 않습니다.', 'A subscription account is required. API, Console, and third-party billing fallback is disabled.'],
    PROVIDER_UNAVAILABLE: ['공식 CLI를 설치한 뒤 새로 고치세요.', 'Install the official CLI, then refresh.'],
    PROVIDER_PROTOCOL_UNSUPPORTED: ['지원 버전은 Codex 0.153.2 / Claude Code 2.1.300입니다. 설치된 버전을 확인하세요.', 'Supported versions are Codex 0.153.2 / Claude Code 2.1.300. Check the installed version.'],
    FILE_CONFLICT: ['원본이 바뀌었습니다. 변경 제안을 보존했으니 새 원본을 읽어 다시 제안해 주세요.', 'The source changed. The proposal is retained; read the new revision and regenerate it.'],
    TRANSACTION_PARTIAL: ['일부 파일 적용 후 중단되었습니다. 복구 기록과 영향 경로를 확인하세요.', 'The transaction stopped after some writes. Review recovery records and affected paths.'],
    PROVIDER_MODEL_UNAVAILABLE: ['이 계정에서 선택한 모델을 사용할 수 없습니다. 모델 목록을 새로 고치세요.', 'The selected model is unavailable for this account. Refresh the model list.'],
    AGENT_BUSY: ['다른 작업이 실행 중입니다. 먼저 중지하세요.', 'Another task is active. Stop it first.'],
    AGENT_CANCELLED: ['작업이 중지되었습니다. 승인하지 않은 제안은 파일을 바꾸지 않습니다.', 'The task was stopped. Unapproved proposals do not change files.'],
    PROVIDER_TOOL_POLICY: ['예상하지 않은 도구가 노출되어 작업을 중지했습니다. CLI 관리 정책을 확인하세요.', 'Unexpected tools were exposed and the task was stopped. Check managed CLI policy.'],
    PROVIDER_TIMEOUT: ['공급자 응답 제한 시간을 넘었습니다. 연결·사용량을 확인한 뒤 다시 시도하세요.', 'The provider deadline expired. Check connectivity and usage, then retry.'],
    SSH_DISCONNECTED: ['SSH 연결이 끊겼습니다. 다시 연결하고 원본 버전을 확인하세요.', 'SSH disconnected. Reconnect and verify source revisions.'],
  };
  const pair = code ? errors[code] : undefined;
  return pair ? t(...pair) : t('작업을 완료하지 못했습니다. 아래 오류 세부 내용을 확인하세요.', 'The operation could not complete. Review the details below.');
}

// All provider requests and configuration writes belong to the main controller.
export function ProviderSettings({ snapshot, onAction }: ChatViewProps) {
  const { t } = useI18n();
  const { provider, busy, loginUrl, configuration } = snapshot;
  const { loading, instructions, executable, error } = configuration;
  const current = snapshot.account?.provider === provider ? snapshot.account : null;
  const checking = loading || (!current && !error);
  const ready = !checking && !!current?.subscription;
  return <section className="provider-settings" aria-label={t('AI 공급자 설정', 'AI provider settings')}>
    <h3>{t('공급자 연결', 'Provider connection')}</h3>
    <div className="agent-setting-row"><label htmlFor="agent-provider">{t('공급자', 'Provider')}</label><select id="agent-provider" data-testid="agent-provider" value={provider} disabled={busy || loading} onChange={event => onAction({ type: 'provider', value: event.target.value as Provider })}><option value="codex">Codex · ChatGPT</option><option value="claude">Claude Code · claude.ai</option></select></div>
    <div data-testid="provider-auth-status" data-provider={provider} data-status={checking ? 'checking' : ready ? 'ready' : current?.available === false ? 'unavailable' : 'loginRequired'} data-code={current?.code ?? error?.code ?? ''} role="status" className="agent-connection"><span>{checking ? t('연결 확인 중…', 'Checking connection…') : ready ? t('구독 계정 연결됨', 'Subscription connected') : t('구독 로그인 필요', 'Subscription sign-in required')}</span>{current?.version && <small>{current.version}</small>}</div>
    <div className="agent-actions"><button type="button" disabled={busy || loading} onClick={() => onAction({ type: 'refresh' })}>{t('연결 새로 고침', 'Refresh connection')}</button>{!ready && <button type="button" disabled={busy || loading} onClick={() => onAction({ type: 'login' })}>{t('공식 로그인', 'Official sign-in')}</button>}</div>
    <p className="agent-note">{provider === 'codex' ? t('TexyPaper 전용 저장소에 ChatGPT 계정으로 로그인합니다. 기존 Codex 설정·토큰을 복사하지 않습니다.', 'Sign in with ChatGPT in TexyPaper’s private store. Existing Codex settings and tokens are not copied.') : t('기존 공식 Claude CLI의 claude.ai 구독 계정을 사용합니다. API 키 결제는 사용하지 않습니다.', 'Uses the existing official Claude CLI’s claude.ai subscription account. API-key billing is not used.')}</p>
    {instructions && <div className="agent-notice"><p>{t('터미널에서 공식 명령으로 로그인한 뒤 연결을 새로 고치세요.', 'Run the official command in a terminal, then refresh the connection.')}</p><code>claude auth login</code></div>}
    {loginUrl && <div className="agent-notice"><p>{t('공식 계정 인증 페이지에서 로그인을 마치세요.', 'Complete sign-in on the official authorization page.')}</p><div className="agent-actions"><button type="button" onClick={() => onAction({ type: 'open-login' })}>{t('인증 페이지 열기', 'Open authorization page')}</button><button type="button" onClick={() => onAction({ type: 'cancel' })}>{t('로그인 취소', 'Cancel sign-in')}</button></div></div>}
    <details className="agent-advanced"><summary>{t('CLI 실행 파일 설정', 'CLI executable settings')}</summary><p className="agent-note">{t('비워 두면 공식 CLI를 자동 검색합니다. 지정한 실행 파일은 현재 계정 권한으로 실행되므로 신뢰하는 공식 바이너리만 사용하세요.', 'Leave blank to discover the official CLI. A configured executable runs with your account permissions; use only a trusted official binary.')}</p><label className="agent-setting-row">{t('실행 파일 경로', 'Executable path')}<input value={executable} maxLength={4096} disabled={busy || loading} spellCheck={false} placeholder={t('자동 검색', 'Automatic discovery')} onChange={event => onAction({ type: 'executable', value: event.target.value })} /></label><button type="button" disabled={busy || loading} onClick={() => onAction({ type: 'save-executable' })}>{t('경로 저장 및 확인', 'Save path and check')}</button></details>
    {error && <div role="alert" className="agent-error"><p>{localizedAgentError(error.code, t)}</p><details><summary>{t('오류 세부 내용', 'Error details')}</summary><code>{error.code}: {error.message}</code></details></div>}
  </section>;
}
export default ProviderSettings;
