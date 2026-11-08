import type { AppError, Diagnostic } from '../contracts';
import { Icon } from './Icon';
import { errorText } from './errors';
import { t } from './i18n';

type Props = {
  buildFailure: AppError | null;
  diagnostics: Diagnostic[];
  logTail: string;
  onClose: () => void;
  onAskAi: () => void;
  onOpen: (path: string, line?: number) => void;
};

export function BuildDiagnostics({ buildFailure, diagnostics, logTail, onClose, onAskAi, onOpen }: Props) {
  return <section className="diagnostics" aria-label={t("빌드 진단")}>
    <div className="pane-heading">
      <strong>{t('로그 및 출력','Logs and output')}</strong>
      <button aria-label={t('빌드 진단 닫기','Close build diagnostics')} onClick={onClose}>
        {t('PDF로 돌아가기','Back to PDF')}
      </button>
    </div>
    {buildFailure && <p className="diagnostic-failure" role="status">
      <strong>{buildFailure.code}</strong> {errorText(buildFailure)}
    </p>}
    {diagnostics.some(item => item.path) && <button type="button" className="diagnostic-ask-ai" data-testid="ask-ai-build-error" onClick={onAskAi}>
      <Icon name="ai" size={14}/> {t('이 오류를 AI에게 묻기','Ask AI about this error')}
    </button>}
    {diagnostics.map((diagnostic, index) => <button key={index} disabled={!diagnostic.path} onClick={() => diagnostic.path && onOpen(diagnostic.path, diagnostic.line)}>
      {diagnostic.severity==='error'?t('오류'):diagnostic.severity==='warning'?t('경고'):t('정보')} · {diagnostic.path??''}{diagnostic.line?`:${diagnostic.line}`:''}{diagnostic.inferred?t(' (추정 위치)'):''} {diagnostic.message}
    </button>)}
    <pre tabIndex={0} aria-label={t('원본 빌드 로그','Raw build log')}>{logTail||t('이 세션에서 받은 빌드 로그가 없습니다.')}</pre>
  </section>;
}
