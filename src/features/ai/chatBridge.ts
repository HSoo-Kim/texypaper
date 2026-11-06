import type { ChatAction, ChatSnapshot, HistoryRow } from './chatTypes';
import type { AppSettings } from '../../ui/theme';

export const CHAT_EVENT = 'texypaper:chat';
export type ChatScope = { workspaceId: string; epoch: number };
export type ChatActionFrame = ChatScope & { session: string; sequence: number; action: ChatAction };
export type HistoryRowDelta = { reuse: string; dropPrefix: number; append: string };
export type HistorySplice = { start: number; deleteCount: number; rows: (HistoryRow | HistoryRowDelta)[] };
export type ChatPatch = { changes: Partial<Omit<ChatSnapshot, 'history'>>; history?: HistorySplice };
export type ChatStateFrame = {
  session: string;
  revision: number;
  acknowledged: number;
  settings?: AppSettings;
} & ({ kind: 'snapshot'; snapshot: ChatSnapshot } | { kind: 'patch'; patch: ChatPatch });
export type ChatRelayEvent =
  | { kind: 'ready' | 'closed'; session: string }
  | { kind: 'action'; frame: ChatActionFrame };

// Reuse existing rows across transcript trims, and send only arriving text for a
// stable streaming row. Even a single multi-megabyte answer stays incremental.
export function diffChatSnapshot(previous: ChatSnapshot, next: ChatSnapshot): ChatPatch {
  const changes: ChatPatch['changes'] = {};
  for (const key of Object.keys(next) as (keyof ChatSnapshot)[]) {
    if (key !== 'history' && previous[key] !== next[key]) {
      Object.assign(changes, { [key]: next[key] });
    }
  }
  if (previous.history === next.history) return { changes };
  let start = 0;
  while (start < previous.history.length && start < next.history.length && previous.history[start] === next.history[start]) start++;
  let suffix = 0;
  while (suffix < previous.history.length - start && suffix < next.history.length - start && previous.history[previous.history.length - suffix - 1] === next.history[next.history.length - suffix - 1]) suffix++;
  const previousById = new Map<string, HistoryRow>();
  for (const row of previous.history) previousById.set(row.id, row);
  const rows = next.history.slice(start, next.history.length - suffix).map(row => {
    const old = previousById.get(row.id);
    if (!old || old.role !== row.role || old.provider !== row.provider || old.taskId !== row.taskId) return row;
    if (row.text.startsWith(old.text)) return { reuse: row.id, dropPrefix: 0, append: row.text.slice(old.text.length) };
    // A bounded suffix search covers the transcript-budget trim without an
    // unbounded quadratic scan on repetitive provider output.
    const anchor = row.text.slice(0, 256);
    let dropPrefix = old.text.indexOf(anchor, Math.max(1, old.text.length - row.text.length));
    for (let attempt = 0; dropPrefix >= 0 && attempt < 8; attempt++) {
      const retained = old.text.length - dropPrefix;
      if (retained <= row.text.length) {
        let matched = 0;
        while (matched < retained && old.text.charCodeAt(dropPrefix + matched) === row.text.charCodeAt(matched)) matched++;
        if (matched === retained) return { reuse: row.id, dropPrefix, append: row.text.slice(retained) };
      }
      dropPrefix = old.text.indexOf(anchor, dropPrefix + 1);
    }
    return row;
  });
  return {
    changes,
    history: { start, deleteCount: previous.history.length - start - suffix, rows },
  };
}

export function applyChatPatch(snapshot: ChatSnapshot, patch: ChatPatch): ChatSnapshot {
  let history = snapshot.history;
  if (patch.history) {
    const { start, deleteCount, rows } = patch.history;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(deleteCount) || start < 0 || deleteCount < 0 || start > history.length || deleteCount > history.length - start) throw new Error('Invalid chat history patch.');
    const previousById = new Map<string, HistoryRow>();
    for (const row of history) previousById.set(row.id, row);
    const updated = rows.map(row => {
      if (!('reuse' in row)) return row;
      const previous = previousById.get(row.reuse);
      if (!previous || !Number.isSafeInteger(row.dropPrefix) || row.dropPrefix < 0 || row.dropPrefix > previous.text.length || typeof row.append !== 'string') throw new Error('Invalid chat text delta.');
      if (row.dropPrefix === 0 && !row.append) return previous;
      return { ...previous, text: previous.text.slice(row.dropPrefix) + row.append };
    });
    history = [...history.slice(0, start), ...updated, ...history.slice(start + deleteCount)];
  }
  return { ...snapshot, ...patch.changes, history };
}

export function sameChatScope(scope: ChatScope, snapshot: ChatSnapshot): boolean {
  return scope.workspaceId === snapshot.workspace.id && scope.epoch === snapshot.workspace.epoch;
}

const simpleActions: Record<string, true> = { send: true, cancel: true, refresh: true, login: true, 'open-login': true, 'save-executable': true, 'dismiss-error': true, detach: true, dock: true, focus: true };
function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum;
}
export function isChatAction(value: unknown): value is ChatAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const action = value as Record<string, unknown>;
  if (typeof action.type !== 'string') return false;
  const keys = Object.keys(action).sort().join(',');
  if (Object.hasOwn(simpleActions, action.type)) return keys === 'type';
  switch (action.type) {
    case 'prompt': return keys === 'type,value' && boundedString(action.value, 65536);
    case 'disclosure':
    case 'settings': return keys === 'type,value' && typeof action.value === 'boolean';
    case 'provider': return keys === 'type,value' && (action.value === 'claude' || action.value === 'codex');
    case 'model': return keys === 'type,value' && boundedString(action.value, 512);
    case 'reasoning': return keys === 'type,value' && boundedString(action.value, 64);
    case 'executable': return keys === 'type,value' && boundedString(action.value, 4096);
    case 'history': return keys === 'page,type' && boundedString(action.page, 4096);
    case 'undo': return keys === 'id,type' && boundedString(action.id, 256) && action.id.length > 0;
    case 'decide': return keys === 'decision,id,type' && boundedString(action.id, 256) && action.id.length > 0 && (action.decision === 'apply' || action.decision === 'reject');
    case 'execution-permission': return (keys === 'type,value' || (keys === 'acknowledged,type,value' && typeof action.acknowledged === 'boolean')) && (action.value === 'deny' || action.value === 'ask' || action.value === 'session');
    case 'execution-decide': return keys === 'decision,id,type' && boundedString(action.id, 256) && action.id.length > 0 && (action.decision === 'approve' || action.decision === 'reject');
    case 'execution-cancel': return keys === 'id,type' && boundedString(action.id, 256) && action.id.length > 0;
    default: return false;
  }
}

export function isChatActionFrame(value: unknown): value is ChatActionFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as ChatActionFrame;
  return boundedString(frame.session, 64) && frame.session.length > 0 && boundedString(frame.workspaceId, 256) && Number.isSafeInteger(frame.epoch) && frame.epoch >= 0 && Number.isSafeInteger(frame.sequence) && frame.sequence > 0 && isChatAction(frame.action);
}
