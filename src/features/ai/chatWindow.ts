import { useCallback, useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { native } from '../../api';
import type { AppSettings } from '../../ui/theme';
import type { ChatAction, ChatSnapshot } from './chatTypes';
import { CHAT_EVENT, diffChatSnapshot, isChatActionFrame, sameChatScope, type ChatRelayEvent, type ChatStateFrame } from './chatBridge';

type ChatWindowOptions = {
  snapshot: ChatSnapshot;
  settings: AppSettings;
  onAction: (action: ChatAction) => void;
  onDetachedChange?: (detached: boolean) => void;
  onError?: (error: unknown) => void;
};
type Session = {
  id: string;
  ready: boolean;
  revision: number;
  generation: number;
  acknowledged: number;
  sentAcknowledged: number;
  snapshot?: ChatSnapshot;
  settings?: AppSettings;
};

export function useChatWindow(options: ChatWindowOptions): { detached: boolean; detach: () => Promise<void>; dock: () => Promise<void>; focus: () => Promise<void> } {
  const latest = useRef(options);
  latest.current = options;
  const [detached, setDetached] = useState(false);
  const detachedRef = useRef(false);
  const session = useRef<Session | null>(null);
  const alive = useRef(true);
  const subscriptions = useRef<Promise<void>>(Promise.resolve());
  const operations = useRef(Promise.resolve());
  const timer = useRef<number | undefined>(undefined);
  const handshakeTimer = useRef<number | undefined>(undefined);
  const transmitting = useRef(false);
  const flushRef = useRef<() => Promise<void>>(async () => {});

  const publishDetached = useCallback((value: boolean) => {
    if (!alive.current || detachedRef.current === value) return;
    detachedRef.current = value;
    setDetached(value);
    latest.current.onDetachedChange?.(value);
  }, []);
  const clearTimers = useCallback(() => {
    window.clearTimeout(timer.current);
    window.clearTimeout(handshakeTimer.current);
    timer.current = undefined;
    handshakeTimer.current = undefined;
  }, []);
  const schedule = useCallback(() => {
    if (!alive.current || !session.current?.ready || timer.current) return;
    timer.current = window.setTimeout(() => { timer.current = undefined; void flushRef.current(); }, 32);
  }, []);
  const fail = useCallback(async (error: unknown, id: string) => {
    if (session.current?.id !== id) return;
    session.current = null;
    clearTimers();
    publishDetached(false);
    latest.current.onError?.(error);
    try { await native('chat_window_dock', { session: id }); } catch { /* The failed webview may already be destroyed. */ }
  }, [clearTimers, publishDetached]);

  flushRef.current = async () => {
    const current = session.current;
    if (!current?.ready || transmitting.current || !alive.current) return;
    const { snapshot, settings } = latest.current;
    if (current.snapshot === snapshot && current.settings === settings && current.sentAcknowledged === current.acknowledged) return;
    transmitting.current = true;
    const revision = current.revision + 1;
    const acknowledged = current.acknowledged;
    const generation = current.generation;
    const reset = !current.snapshot || !sameChatScope({ workspaceId: current.snapshot.workspace.id, epoch: current.snapshot.workspace.epoch }, snapshot);
    const frame: ChatStateFrame = reset
      ? { kind: 'snapshot', session: current.id, revision, acknowledged, snapshot, settings }
      : { kind: 'patch', session: current.id, revision, acknowledged, patch: diffChatSnapshot(current.snapshot!, snapshot), ...(current.settings !== settings ? { settings } : {}) };
    try {
      await native('chat_window_snapshot', { frame });
      if (session.current !== current || !alive.current) return;
      current.revision = revision;
      if (current.generation === generation) {
        current.snapshot = snapshot;
        current.settings = settings;
      }
      current.sentAcknowledged = acknowledged;
      publishDetached(true);
    } catch (error) {
      await fail(error, current.id);
    } finally {
      transmitting.current = false;
      const next = session.current;
      if (next?.ready && (next.snapshot !== latest.current.snapshot || next.settings !== latest.current.settings || next.sentAcknowledged !== next.acknowledged)) schedule();
    }
  };

  const enqueue = useCallback((operation: () => Promise<void>) => {
    const pending = operations.current.then(operation);
    operations.current = pending.catch(() => {});
    return pending;
  }, []);
  const focus = useCallback(() => enqueue(async () => {
    const current = session.current;
    if (!current) return;
    try { await native('chat_window_focus', { session: current.id }); }
    catch (error) { await fail(error, current.id); }
  }), [enqueue, fail]);
  const dock = useCallback(() => enqueue(async () => {
    const current = session.current;
    if (!current) return;
    try {
      await native('chat_window_dock', { session: current.id });
      if (session.current === current) {
        session.current = null;
        clearTimers();
        publishDetached(false);
      }
    } catch (error) { await fail(error, current.id); }
  }), [enqueue, fail, clearTimers, publishDetached]);
  const detach = useCallback(() => enqueue(async () => {
    try { await subscriptions.current; }
    catch (error) { latest.current.onError?.(error); return; }
    if (!alive.current) return;
    const existing = session.current;
    if (existing) {
      try { await native('chat_window_focus', { session: existing.id }); }
      catch (error) { await fail(error, existing.id); }
      return;
    }
    const current: Session = { id: crypto.randomUUID(), ready: false, revision: 0, generation: 0, acknowledged: 0, sentAcknowledged: 0 };
    session.current = current;
    handshakeTimer.current = window.setTimeout(() => { void fail(new Error('The AI window did not finish connecting. Chat is still available in the main window.'), current.id); }, 15000);
    try { await native('chat_window_open', { session: current.id }); }
    catch (error) { await fail(error, current.id); }
  }), [enqueue, fail]);

  useEffect(() => {
    alive.current = true;
    let stopped = false;
    let unlisten: UnlistenFn | undefined;
    subscriptions.current = listen<ChatRelayEvent>(CHAT_EVENT, ({ payload }) => {
      if (stopped) return;
      const current = session.current;
      if (!current) return;
      if (payload.kind === 'ready' && payload.session === current.id) {
        // Repeated ready is a request to resynchronize, never to replay actions.
        current.ready = true;
        current.generation++;
        current.snapshot = undefined;
        current.settings = undefined;
        window.clearTimeout(handshakeTimer.current);
        handshakeTimer.current = undefined;
        schedule();
      } else if (payload.kind === 'closed' && payload.session === current.id) {
        session.current = null;
        clearTimers();
        publishDetached(false);
      } else if (payload.kind === 'action' && isChatActionFrame(payload.frame)) {
        const frame = payload.frame;
        if (!current.ready || frame.session !== current.id || frame.sequence <= current.acknowledged || !sameChatScope(frame, latest.current.snapshot)) return;
        current.acknowledged = frame.sequence;
        try {
          if (frame.action.type === 'dock') void dock();
          else if (frame.action.type === 'focus' || frame.action.type === 'detach') void focus();
          else latest.current.onAction(frame.action);
        }
        catch (error) { latest.current.onError?.(error); }
        schedule();
      }
    }).then(dispose => { if (stopped) dispose(); else unlisten = dispose; });
    // Avoid unhandled rejection when no one has requested detachment yet.
    void subscriptions.current.catch(() => {});
    const focusDetached = () => { void focus(); };
    window.addEventListener('texypaper:chat-focus', focusDetached);
    return () => {
      stopped = true;
      if (detachedRef.current) {
        detachedRef.current = false;
        latest.current.onDetachedChange?.(false);
      }
      alive.current = false;
      unlisten?.();
      clearTimers();
      const current = session.current;
      session.current = null;
      if (current) void native('chat_window_dock', { session: current.id }).catch(() => {});
      window.removeEventListener('texypaper:chat-focus', focusDetached);
    };
  }, [clearTimers, dock, focus, publishDetached, schedule]);

  useEffect(() => { schedule(); }, [options.snapshot, options.settings, schedule]);
  return { detached, detach, dock, focus };
}
