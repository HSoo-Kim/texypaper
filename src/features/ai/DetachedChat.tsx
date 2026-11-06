import { useCallback, useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { native, normalizeError } from '../../api';
import { applyTheme, type AppSettings } from '../../ui/theme';
import { setLocale, useI18n } from '../../ui/i18n';
import { ChatView } from './ChatView';
import type { ChatAction, ChatSnapshot } from './chatTypes';
import { applyChatPatch, isChatAction, sameChatScope, type ChatActionFrame, type ChatStateFrame } from './chatBridge';
import { readChatPreferences } from './chatPreferences';
import '../../ui/tokens.css';

type PendingValue<T> = { sequence: number; value: T };
type ChildState = { snapshot: ChatSnapshot; settings: AppSettings; revision: number; acknowledged: number };

// This route deliberately imports no AppShell, workspace bootstrap, editor, PDF,
// provider runtime or workspace request helper. It only mirrors main-owned chat state.
export default function DetachedChat() {
  const { t } = useI18n();
  const [state, setState] = useState<ChildState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<PendingValue<string> | null>(null);
  const [pendingDisclosure, setPendingDisclosure] = useState<PendingValue<boolean> | null>(null);
  const [pendingFontSize, setPendingFontSize] = useState<PendingValue<number> | null>(null);
  const stateRef = useRef<ChildState | null>(null);
  const session = useRef<string | null>(null);
  const sequence = useRef(0);
  const actions = useRef(Promise.resolve());
  const mounted = useRef(true);
  const readyRef = useRef<() => Promise<void>>(async () => {});
  const onActionRef = useRef<(action: ChatAction) => void>(() => {});

  const onAction = useCallback((action: ChatAction) => {
    const current = stateRef.current;
    const id = session.current;
    if (!current || !id || !isChatAction(action)) return;
    const next = ++sequence.current;
    if (action.type === 'prompt') setPendingPrompt({ sequence: next, value: action.value });
    if (action.type === 'disclosure') setPendingDisclosure({ sequence: next, value: action.value });
    if (action.type === 'chat-font-size') setPendingFontSize({ sequence: next, value: action.value });
    const frame: ChatActionFrame = { session: id, sequence: next, workspaceId: current.snapshot.workspace.id, epoch: current.snapshot.workspace.epoch, action };
    // In particular, prompt-before-send and prompt-before-dock preserve ordering.
    // A failed action is never replayed, so approvals cannot be executed twice.
    actions.current = actions.current.then(async () => {
      if (!mounted.current || session.current !== id || !stateRef.current || !sameChatScope(frame, stateRef.current.snapshot)) return;
      await native('chat_window_action', { frame });
    }).catch(problem => {
      if (mounted.current && stateRef.current && sameChatScope(frame, stateRef.current.snapshot)) {
        setError(normalizeError(problem).message);
        setPendingPrompt(null);
        setPendingDisclosure(null);
        setPendingFontSize(null);
      }
    });
  }, []);
  onActionRef.current = onAction;

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let disposers: UnlistenFn[] = [];
    const ready = async () => {
      const result = await native<{ session: string; sequence: number }>('chat_window_ready');
      if (stopped) return;
      session.current = result.session;
      sequence.current = Math.max(sequence.current, result.sequence);
    };
    readyRef.current = ready;
    const acceptFrame = (frame: ChatStateFrame) => {
      if (stopped || (session.current && session.current !== frame.session)) return;
      const previous = stateRef.current;
      if (previous && frame.revision <= previous.revision) return;
      try {
        if (!Number.isSafeInteger(frame.revision) || frame.revision < 1 || !Number.isSafeInteger(frame.acknowledged) || frame.acknowledged < 0) throw new Error('Invalid chat synchronization frame.');
        if (frame.kind === 'patch' && (!previous || frame.revision !== previous.revision + 1)) {
          void ready().catch(problem => { if (!stopped) setError(normalizeError(problem).message); });
          return;
        }
        const snapshot = frame.kind === 'snapshot' ? frame.snapshot : applyChatPatch(previous!.snapshot, frame.patch);
        const settings = frame.settings ?? previous?.settings;
        if (!settings) throw new Error('Chat settings have not synchronized.');
        const changedWorkspace = previous && !sameChatScope({ workspaceId: previous.snapshot.workspace.id, epoch: previous.snapshot.workspace.epoch }, snapshot);
        if (changedWorkspace) {
          setPendingPrompt(null);
          setPendingDisclosure(null);
          setPendingFontSize(null);
        } else {
          setPendingPrompt(pending => pending && pending.sequence > frame.acknowledged ? pending : null);
          setPendingDisclosure(pending => pending && pending.sequence > frame.acknowledged ? pending : null);
          setPendingFontSize(pending => pending && pending.sequence > frame.acknowledged ? pending : null);
        }
        const next = { snapshot, settings, revision: frame.revision, acknowledged: frame.acknowledged };
        session.current = frame.session;
        stateRef.current = next;
        sequence.current = Math.max(sequence.current, frame.acknowledged);
        setState(next);
        setError(null);
      } catch (problem) { setError(normalizeError(problem).message); }
    };
    void Promise.all([
      listen<ChatStateFrame>('texypaper:chat-state', ({ payload }) => acceptFrame(payload)),
      listen<string>('texypaper:chat-close-requested', ({ payload }) => {
        if (!stopped && payload === session.current && stateRef.current) onActionRef.current({ type: 'dock' });
      }),
    ]).then(async listeners => {
      if (stopped) { listeners.forEach(dispose => dispose()); return; }
      disposers = listeners;
      await ready();
    }).catch(problem => { if (!stopped) setError(normalizeError(problem).message); });
    const timeout = window.setTimeout(() => { if (!stopped && !stateRef.current) setError(t('AI 창을 연결하지 못했습니다. 창을 닫고 주 창에서 다시 분리하세요.', 'The AI window could not connect. Close it and detach again from the main window.')); }, 12000);
    return () => {
      stopped = true;
      mounted.current = false;
      window.clearTimeout(timeout);
      disposers.forEach(dispose => dispose());
    };
  }, []);

  useEffect(() => {
    if (!state?.settings) return;
    const settings = state.settings;
    setLocale(settings.locale);
    applyTheme(settings);
    void getCurrentWindow().setTheme(settings.theme === 'system' ? null : settings.theme).catch(problem => setError(normalizeError(problem).message));
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(settings);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [state?.settings]);

  const snapshot = state && {
    ...state.snapshot,
    prompt: pendingPrompt?.value ?? state.snapshot.prompt,
    disclosure: pendingDisclosure?.value ?? state.snapshot.disclosure,
  };
  return <main className="detached-chat" style={{ height: '100dvh', display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
    {error && <div className="agent-error" role="alert"><p>{error}</p>{snapshot ? <button type="button" onClick={() => onAction({ type: 'dock' })}>{t('주 창에 붙이기', 'Return to main window')}</button> : <button type="button" onClick={() => { setError(null); void readyRef.current().catch(problem => setError(normalizeError(problem).message)); }}>{t('다시 연결', 'Reconnect')}</button>}</div>}
    {snapshot ? <ChatView snapshot={snapshot} onAction={onAction} fontSize={pendingFontSize?.value ?? readChatPreferences(state?.settings).chatFontSize} detached /> : <div className="empty-state" role="status" aria-live="polite">{t('AI 대화를 연결하는 중…', 'Connecting AI chat…')}</div>}
  </main>;
}
