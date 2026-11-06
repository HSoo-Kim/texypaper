import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { useI18n } from '../../ui/i18n';
import { ProviderSettings, localizedAgentError } from './ProviderSettings';
import { ProposalReview } from './ProposalReview';
import { ExecutionReview } from './ExecutionReview';
import type { ChatSnapshot, ChatViewProps, HistoryRow } from './chatTypes';
import './agents.css';

// Text is rendered as React text nodes, never provider-supplied HTML.
function MessageText({ text }: { text: string }) {
  const blocks = useMemo(() => text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g), [text]);
  return <div className="agent-message-body">{blocks.map((block, index) => {
    if (!block) return null;
    if (block.startsWith('```')) {
      const newline = block.indexOf('\n');
      const language = block.slice(3, newline).trim();
      const code = block.slice(newline + 1).replace(/```$/, '');
      return <figure key={index} className="agent-code">{language && <figcaption>{language}</figcaption>}<pre><code>{code}</code></pre></figure>;
    }
    return <Fragment key={index}>{block.split(/\n\s*\n/).map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}</Fragment>;
  })}</div>;
}

function MeasuredMessage({ row, measure, measurementEpoch }: { row: HistoryRow; measure: (id: string, height: number) => void; measurementEpoch: number }) {
  const { t } = useI18n(); const element = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = element.current; if (!node) return;
    const observer = new ResizeObserver(() => measure(row.id, node.getBoundingClientRect().height));
    observer.observe(node); measure(row.id, node.getBoundingClientRect().height);
    return () => observer.disconnect();
  }, [row.id, measure, measurementEpoch]);
  return <article ref={element} data-message-id={row.id} data-task-id={row.taskId} className={`agent-message agent-message-${row.role}`}>
    <strong>{row.role === 'user' ? t('나', 'You') : row.role === 'tool' ? t('도구 사용', 'Tool use') : row.provider === 'claude' ? 'Claude' : 'Codex'}</strong>
    <MessageText text={row.text} />
  </article>;
}

function Transcript({ snapshot, onAction }: ChatViewProps) {
  const { t } = useI18n();
  const view = useRef<HTMLDivElement>(null); const heights = useRef(new Map<string, number>());
  const following = useRef(true); const anchor = useRef<{ id: string; inset: number } | null>(null);
  const previousPage = useRef(snapshot.historyPage);
  const [viewport, setViewport] = useState({ top: 0, height: 600 }); const [revision, setRevision] = useState(0);
  const [measurementEpoch, setMeasurementEpoch] = useState(0);
  const [selection, setSelection] = useState<{ start: string; end: string } | null>(null);
  const measure = useCallback((id: string, height: number) => {
    if (Math.abs((heights.current.get(id) ?? 0) - height) < .5) return;
    heights.current.set(id, height); setRevision(value => value + 1);
  }, []);
  useEffect(() => {
    const node = view.current; if (!node) return;
    let width = node.clientWidth;
    const resize = new ResizeObserver(() => {
      if (node.clientWidth !== width) { width = node.clientWidth; heights.current.clear(); setMeasurementEpoch(value => value + 1); setRevision(value => value + 1); }
      setViewport({ top: node.scrollTop, height: node.clientHeight });
    });
    // Theme and scale can alter line wrapping without changing the panel's CSS width.
    const appearance = new MutationObserver(() => { heights.current.clear(); setMeasurementEpoch(value => value + 1); setRevision(value => value + 1); });
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
    setViewport({ top: node.scrollTop, height: node.clientHeight });
    return () => { resize.disconnect(); appearance.disconnect(); };
  }, []);
  useEffect(() => {
    const preserveSelection = () => {
      const selected = document.getSelection(); const node = view.current;
      if (!selected || selected.isCollapsed || !node) { setSelection(previous => previous === null ? previous : null); return; }
      const start = selected.anchorNode instanceof Element ? selected.anchorNode : selected.anchorNode?.parentElement;
      const end = selected.focusNode instanceof Element ? selected.focusNode : selected.focusNode?.parentElement;
      const first = start?.closest<HTMLElement>('[data-message-id]');
      const last = end?.closest<HTMLElement>('[data-message-id]');
      if (first && last && node.contains(first) && node.contains(last)) {
        following.current = false;
        const startId = first.dataset.messageId!; const endId = last.dataset.messageId!;
        setSelection(previous => previous?.start === startId && previous.end === endId ? previous : { start: startId, end: endId });
      } else setSelection(previous => previous === null ? previous : null);
    };
    document.addEventListener('selectionchange', preserveSelection);
    return () => document.removeEventListener('selectionchange', preserveSelection);
  }, []);
  const layout = useMemo(() => {
    let top = 0;
    const offsets = snapshot.history.map(row => { const offset = top; top += heights.current.get(row.id) ?? 120; return offset; });
    const threshold = viewport.top - 600;
    let first = 0; while (first + 1 < offsets.length && offsets[first + 1] < threshold) first++;
    let end = first; while (end < offsets.length && offsets[end] < viewport.top + viewport.height + 600) end++;
    if (selection) {
      const start = snapshot.history.findIndex(row => row.id === selection.start);
      const finish = snapshot.history.findIndex(row => row.id === selection.end);
      if (start >= 0 && finish >= 0) { first = Math.min(first, start, finish); end = Math.max(end, start + 1, finish + 1); }
    }
    return { offsets, total: top, first, end: Math.max(first + 1, end) };
  }, [snapshot.history, viewport, revision, selection]);
  useLayoutEffect(() => {
    const node = view.current; if (!node) return;
    if (previousPage.current !== snapshot.historyPage) { previousPage.current = snapshot.historyPage; following.current = snapshot.historyPage === 'current.jsonl'; anchor.current = null; node.scrollTop = following.current ? node.scrollHeight : 0; }
    else if (following.current) node.scrollTop = node.scrollHeight;
    else if (anchor.current) {
      const index = snapshot.history.findIndex(row => row.id === anchor.current?.id);
      if (index >= 0) node.scrollTop = layout.offsets[index] + anchor.current.inset;
    }
    setViewport(previous => previous.top === node.scrollTop && previous.height === node.clientHeight ? previous : { top: node.scrollTop, height: node.clientHeight });
    const retained = new Set(snapshot.history.map(row => row.id));
    for (const id of heights.current.keys()) if (!retained.has(id)) heights.current.delete(id);
  }, [snapshot.history, snapshot.historyPage, snapshot.proposals, snapshot.executions, layout.total, layout.offsets]);
  const proposals = snapshot.proposals.filter(proposal => !proposal.provider || proposal.provider === snapshot.provider);
  return <div data-testid="agent-history" className="agent-history" ref={view} tabIndex={0} role="log" aria-live="off" aria-label={t('AI 대화 기록', 'AI conversation history')} onScroll={event => {
    const node = event.currentTarget;
    following.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 32;
    let index = 0; while (index + 1 < layout.offsets.length && layout.offsets[index + 1] <= node.scrollTop) index++;
    anchor.current = snapshot.history[index] ? { id: snapshot.history[index].id, inset: node.scrollTop - layout.offsets[index] } : null;
    setViewport({ top: node.scrollTop, height: node.clientHeight });
  }}>
    {snapshot.history.length === 0 ? <div className="agent-empty"><h3>{t('논문에 대해 물어보세요', 'Ask about your paper')}</h3><p>{t('선택한 문장을 다듬거나, 코드와 결과에서 근거를 찾아 달라고 요청하세요.', 'Ask to revise selected text or find evidence in your code and results.')}</p><p className="agent-note">{t('파일 변경은 제안을 검토하고 승인한 뒤에만 적용됩니다.', 'File changes require your review and approval.')}</p></div> : <div className="agent-transcript-rows" style={{ paddingTop: layout.offsets[layout.first] ?? 0, paddingBottom: Math.max(0, layout.total - (layout.offsets[layout.end] ?? layout.total)) }}>
      {snapshot.history.slice(layout.first, layout.end).map(row => <MeasuredMessage key={row.id} row={row} measure={measure} measurementEpoch={measurementEpoch} />)}
    </div>}
    {proposals.length > 0 && <section className="agent-proposals" aria-label={t('변경 제안', 'Proposed changes')}>{proposals.map(proposal => <ProposalReview key={proposal.id} proposal={proposal} busy={snapshot.proposalBusy.includes(proposal.id)} onDecision={(id, decision) => onAction({ type: 'decide', id, decision })} onUndo={id => onAction({ type: 'undo', id })} />)}</section>}
    {snapshot.executions.length > 0 && <section className="agent-executions" aria-label={t('명령 실행', 'Command execution')}>{snapshot.executions.map(execution => <ExecutionReview key={execution.id} execution={execution} workspace={snapshot.workspace} permission={snapshot.executionPermission} onAction={onAction} />)}</section>}
  </div>;
}

export function ChatView({ snapshot, onAction, detached = false }: ChatViewProps) {
  const { t } = useI18n();
  const [sessionWarning, setSessionWarning] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => { setSessionWarning(false); setAcknowledged(false); }, [snapshot.workspace.id, snapshot.workspace.epoch, snapshot.executionPermission]);
  const { provider, model, status, busy, prompt, disclosure, context, workspace, error } = snapshot;
  const ready = snapshot.account?.provider === provider && snapshot.account.subscription && !!model && !snapshot.configuration.loading;
  const { models, allowCustom, loading } = snapshot.configuration;
  const selectedModel = models.find(row => row.id === model);
  const modelLabel = selectedModel?.label || model;
  const efforts = selectedModel?.reasoningEfforts ?? [];
  const defaultEffortLabel = efforts.find(row => row.value === selectedModel?.defaultReasoningEffort)?.label;
  const effortLabel = efforts.find(row => row.value === snapshot.reasoningEffort)?.label;
  const labels: Record<ChatSnapshot['status'], string> = { idle: t('준비', 'Ready'), running: t('작업 중', 'Working'), completed: t('응답 완료 · 변경은 별도 승인', 'Complete · changes require approval'), failed: t('작업 실패', 'Task failed'), cancelled: t('중지됨', 'Stopped'), cancelling: t('중지 중…', 'Stopping…') };
  return <section className="agent-panel" aria-label={t('논문 AI 도우미', 'Paper AI assistant')}>
    <header className="agent-chat-header">
      {snapshot.settingsOpen ? <button type="button" className="agent-icon-button" data-testid="chat-settings-back" aria-label={t('대화로 돌아가기', 'Back to chat')} title={t('대화로 돌아가기', 'Back to chat')} onClick={() => onAction({ type: 'settings', value: false })}><Icon name="chevronLeft" /></button> : <Icon name="ai" size={17} />}
      <div className="agent-header-title"><strong>{snapshot.settingsOpen ? t('AI 설정', 'AI settings') : t('AI 대화', 'AI chat')}</strong>{!snapshot.settingsOpen && <span title={`${provider} · ${modelLabel}`}>{provider === 'codex' ? 'Codex' : 'Claude'}{modelLabel && ` · ${modelLabel}`}</span>}</div>
      {!snapshot.settingsOpen && <button type="button" className="agent-icon-button" data-testid="chat-settings-button" aria-label={t('AI 설정', 'AI settings')} title={t('AI 설정', 'AI settings')} onClick={() => onAction({ type: 'settings', value: true })}><Icon name="settings" size={17} /></button>}
      <button type="button" className="agent-icon-button" data-testid={detached ? 'chat-dock' : 'chat-detach'} aria-label={detached ? t('메인 창에 붙이기', 'Dock in main window') : t('대화를 별도 창으로 열기', 'Detach chat window')} title={detached ? t('메인 창에 붙이기', 'Dock in main window') : t('대화를 별도 창으로 열기', 'Detach chat window')} onClick={() => onAction({ type: detached ? 'dock' : 'detach' })}><Icon name={detached ? 'split' : 'external'} size={17} /></button>
    </header>
    {snapshot.settingsOpen ? <div className="agent-settings-content">
      <ProviderSettings key={`${workspace.id}:${workspace.epoch}`} snapshot={snapshot} onAction={onAction} />
      <section className="agent-conversation-settings"><h3>{t('대화와 기록', 'Conversation and history')}</h3><code data-testid="agent-session" data-session-id={snapshot.sessionId}>{snapshot.sessionId || t('아직 대화 없음', 'No conversation yet')}</code><p className="agent-note">{t('유휴 공급자 프로세스는 종료하며 세션 ID로 다시 연결합니다. 숨겨진 추론은 저장하지 않습니다.', 'Idle provider processes terminate and reconnect using the session ID. Hidden reasoning is not stored.')}</p>{snapshot.pages.length > 0 && <label className="agent-setting-row">{t('기록 페이지', 'History page')}<select value={snapshot.historyPage} disabled={busy} onChange={event => onAction({ type: 'history', page: event.target.value })}>{snapshot.pages.map(page => <option key={page} value={page}>{page}</option>)}</select></label>}</section>
    </div> : <>
      {!ready && !busy && <div className="agent-connect-prompt"><span>{snapshot.configuration.loading ? t('연결 확인 중…', 'Checking connection…') : t('구독 계정과 모델을 연결하세요.', 'Connect a subscription account and model.')}</span><button type="button" onClick={() => onAction({ type: 'settings', value: true })}>{t('설정', 'Settings')}</button></div>}
      {snapshot.historyPage !== 'current.jsonl' && <div className="agent-connect-prompt"><span>{snapshot.historyPage}</span><button type="button" onClick={() => onAction({ type: 'history', page: 'current.jsonl' })}>{t('현재 대화', 'Current chat')}</button></div>}
      {snapshot.executionPermission === 'session' && <div className="agent-connect-prompt agent-session-permission"><span>{t('이 세션에서 명령 자동 실행 허용됨', 'Automatic command execution allowed for this session')}</span><button type="button" onClick={() => onAction({ type: 'execution-permission', value: 'ask' })}>{t('명령마다 승인으로 전환', 'Require approval')}</button></div>}
      <Transcript snapshot={snapshot} onAction={onAction} />
      <form className="agent-composer" onSubmit={event => { event.preventDefault(); onAction({ type: 'send' }); }}>
        <details className="agent-context"><summary>{t('공유 환경 및 선택 내용', 'Shared environment and selection')}{context.source && ` · ${context.source.path}`}{context.pdf && ` · PDF`}</summary><div><p><code>{workspace.environmentId}: {workspace.root}</code></p><ul>{[context.source?.path, ...(context.attachments ?? [])].filter(Boolean).map((path, index) => <li key={`${path}:${index}`}><code>{path}</code></li>)}</ul>{context.source?.text && <p className="agent-context-quote">{context.source.text}</p>}{context.pdf && <p className="agent-context-quote">{t('PDF 선택', 'PDF selection')}{context.pdf.page != null && ` · ${context.pdf.page}`}: {context.pdf.quote}</p>}<p className="agent-note">{t('이 작업은 위 환경에서 허용된 관련 파일을 읽을 수 있습니다. 실제로 읽은 경로는 도구 진행과 응답에 표시됩니다.', 'This task may read allowed relevant files in this environment. Inspected paths appear in tool progress and responses.')}</p></div></details>
        <label className="agent-disclosure"><input type="checkbox" checked={disclosure} disabled={busy} onChange={event => onAction({ type: 'disclosure', value: event.target.checked })} /><span>{t('선택 내용과 요청한 관련 파일을 선택한 클라우드 공급자에게 전송하는 데 동의합니다.', 'I agree to send selected content and requested relevant files to the chosen cloud provider.')}</span></label>
        <label className="agent-prompt-label" htmlFor="agent-prompt">{t('논문 작업 요청', 'Paper task')}</label><textarea id="agent-prompt" data-testid="agent-prompt" value={prompt} maxLength={65536} rows={3} placeholder={t('선택한 문장을 검토하거나 근거를 찾아 달라고 요청하세요…', 'Ask to review selected text or find supporting evidence…')} onChange={event => onAction({ type: 'prompt', value: event.target.value })} onKeyDown={event => { if (event.ctrlKey && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); onAction({ type: 'send' }); } }} />
        <div data-testid="agent-status" data-status={status} data-state={status} data-task-id={snapshot.taskId} data-session-id={snapshot.sessionId} role="status" className="agent-task-status">{busy && snapshot.executions.some(execution => execution.status === 'running') && status !== 'running' && status !== 'cancelling' ? t('명령 실행 중', 'Running command') : labels[status]}</div>
        <div className="agent-composer-footer">
          <label className="agent-quick-control agent-model-control" htmlFor="agent-model"><span>{t('모델', 'Model')}</span><select id="agent-model" value={selectedModel ? model : allowCustom ? '__custom' : ''} title={modelLabel || t('연결 후 모델 선택', 'Connect to select a model')} disabled={busy || loading || !snapshot.account?.subscription || (!models.length && !allowCustom)} onChange={event => onAction({ type: 'model', value: event.target.value === '__custom' ? '' : event.target.value })}>{!selectedModel && !allowCustom && <option value="">{t('모델 없음', 'No model')}</option>}{models.map(row => <option key={row.id} value={row.id}>{row.label || row.id}</option>)}{allowCustom && <option value="__custom">{t('직접 입력', 'Custom ID')}</option>}</select></label>
          <label className="agent-quick-control agent-effort-control" htmlFor="agent-reasoning"><span>{t('추론', 'Reasoning')}</span><select id="agent-reasoning" data-testid="reasoning-effort" aria-label={t('추론 수준', 'Reasoning effort')} value={snapshot.reasoningEffort} title={effortLabel || (defaultEffortLabel ? `${t('공급자 기본값', 'Provider default')} · ${defaultEffortLabel}` : t('공급자 기본값', 'Provider default'))} disabled={busy || loading || !ready || !efforts.length} onChange={event => onAction({ type: 'reasoning', value: event.target.value })}><option value="">{defaultEffortLabel ? `${t('기본', 'Default')} · ${defaultEffortLabel}` : t('기본', 'Default')}</option>{efforts.map(row => <option key={row.value} value={row.value}>{row.label}</option>)}</select></label>
          <label className="agent-quick-control agent-permission-control" htmlFor="agent-execution-permission"><span>{t('실행 권한', 'Execution')}</span><select id="agent-execution-permission" data-testid="execution-permission" aria-label={t('프로젝트 코드 실행 권한', 'Project code execution permission')} value={snapshot.executionPermission} title={t('실제 로컬·SSH 명령 실행 권한. 파일 수정은 별도 승인합니다.', 'Permission for real local/SSH commands. File edits require separate approval.')} onChange={event => {
            const value = event.target.value as ChatSnapshot['executionPermission'];
            if (value === 'session') { setAcknowledged(false); setSessionWarning(true); }
            else { setSessionWarning(false); onAction({ type: 'execution-permission', value }); }
          }}><option value="deny">{t('실행 안 함', 'Deny')}</option><option value="ask">{t('매번 승인', 'Ask each time')}</option><option value="session">{t('세션 허용', 'Allow session')}</option></select></label>
          {busy ? <button type="button" data-testid="agent-cancel" disabled={status === 'cancelling'} onClick={() => onAction({ type: 'cancel' })}><Icon name="stop" size={13} />{t('중지', 'Stop')}</button> : <button type="submit" className="primary" data-testid="agent-send" disabled={!disclosure || !prompt.trim() || !ready} title={t('요청 보내기 (Ctrl+Enter)', 'Send request (Ctrl+Enter)')}><Icon name="play" size={13} />{t('보내기', 'Send')}<kbd>Ctrl↵</kbd></button>}
        </div>
        {selectedModel?.catalogSource === 'official' && <p className="agent-note" data-testid="model-catalog-note">{t('CLI 목록에 없는 공식 모델입니다. 계정 사용 가능 여부는 전송 시 확인하며, 추론은 공급자 기본값을 사용합니다.', 'Official model not listed by this CLI. Account access is checked when sending; reasoning uses the provider default.')}</p>}
        {allowCustom && !selectedModel && <label className="agent-setting-row">{t('직접 입력 모델 ID', 'Custom model ID')}<input aria-label={t('모델 ID', 'Model ID')} value={model} maxLength={512} disabled={busy || loading} spellCheck={false} onChange={event => onAction({ type: 'model', value: event.target.value })} /></label>}
        {sessionWarning && snapshot.executionPermission !== 'session' && <div className="agent-permission-warning" data-testid="execution-session-warning" role="region" aria-label={t('세션 실행 권한 확인', 'Confirm session execution permission')}>
          <p>{t('명령과 스크립트는 현재 계정 권한으로 실행되어 프로젝트 밖의 파일과 시스템에도 영향을 줄 수 있습니다. 작업 폴더 제한은 샌드박스가 아니며 실행 결과를 자동으로 되돌릴 수 없습니다. 작업 공간 변경·재연결·앱 종료 시 권한이 초기화됩니다.', 'Commands and scripts run with your account permissions and can affect files and systems outside the project. The working directory is not a sandbox, and execution cannot be automatically undone. Switching workspaces, reconnecting, or exiting resets permission.')}</p>
          <label className="agent-disclosure"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>{t('위 위험을 이해하며 이 연결 세션의 개별 명령 승인을 생략합니다.', 'I understand these risks and waive individual command approval for this connection session.')}</span></label>
          <div className="agent-actions"><button type="button" data-testid="execution-permission-confirm" disabled={!acknowledged} onClick={() => { onAction({ type: 'execution-permission', value: 'session', acknowledged: true }); setSessionWarning(false); }}>{t('이 세션에서 허용', 'Allow for this session')}</button><button type="button" onClick={() => setSessionWarning(false)}>{t('취소', 'Cancel')}</button></div>
        </div>}
      </form>
    </>}
    {error && <div className="agent-error agent-task-error" role="alert"><div><p>{localizedAgentError(error.code, t)}</p><details><summary>{t('오류 세부 내용', 'Error details')}</summary><code>{error.code}: {error.message}</code></details></div><button type="button" className="agent-icon-button" aria-label={t('오류 닫기', 'Dismiss error')} onClick={() => onAction({ type: 'dismiss-error' })}><Icon name="close" size={15} /></button></div>}
  </section>;
}
export default ChatView;
