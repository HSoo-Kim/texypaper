import { describe, expect, it } from 'vitest';
import { CHAT_EVENT, applyChatPatch, diffChatSnapshot, isChatAction, isChatActionFrame, sameChatScope } from './chatBridge';
import type { ChatSnapshot } from './chatTypes';

function snapshot(): ChatSnapshot {
  return {
    workspace: { id: 'workspace', epoch: 3, environmentId: 'local', root: 'C:/fixture' },
    provider: 'codex', model: 'model', reasoningEffort: '', account: null,
    configuration: { models: [], allowCustom: false, loading: false, instructions: false, executable: '', error: null },
    prompt: 'draft', disclosure: true, busy: false, status: 'idle', taskId: '', sessionId: '', loginUrl: '', error: null,
    history: [], proposals: [], proposalBusy: [], context: {}, pages: [], historyPage: '', settingsOpen: false,
    executionPermission: 'ask', executions: [],
  };
}

describe('main-owned chat patches', () => {
  it('only sends the changed transcript row, not a multi-megabyte prefix', () => {
    const previous = snapshot();
    previous.history = Array.from({ length: 100 }, (_, index) => ({ id: String(index), role: 'assistant' as const, text: 'x'.repeat(20000) }));
    const next = { ...previous, history: [...previous.history, { id: 'stream', role: 'assistant' as const, text: 'hello' }] };
    const patch = diffChatSnapshot(previous, next);
    expect(patch.history).toEqual({ start: 100, deleteCount: 0, rows: [next.history[100]] });
    expect(JSON.stringify(patch).length).toBeLessThan(256);
    const applied = applyChatPatch(previous, patch);
    expect(applied).toEqual(next);
    expect(applied.history[0]).toBe(previous.history[0]);
    const streaming = { ...next, history: [...next.history.slice(0, -1), { ...next.history[100], text: 'hello world' }] };
    expect(diffChatSnapshot(next, streaming).history).toEqual({ start: 100, deleteCount: 1, rows: [{ reuse: 'stream', dropPrefix: 0, append: ' world' }] });
    expect(applyChatPatch(next, diffChatSnapshot(next, streaming))).toEqual(streaming);
  });

  it('sends only incoming text for a single multi-megabyte assistant answer', () => {
    const previous = snapshot();
    previous.history = [{ id: 'long-answer', role: 'assistant', text: 'existing answer '.repeat(130000) }];
    const next = { ...previous, history: [{ ...previous.history[0], text: previous.history[0].text + 'next token' }] };
    const patch = diffChatSnapshot(previous, next);
    expect(patch.history?.rows).toEqual([{ reuse: 'long-answer', dropPrefix: 0, append: 'next token' }]);
    expect(JSON.stringify(patch).length).toBeLessThan(256);
    expect(applyChatPatch(previous, patch)).toEqual(next);
  });

  it('reuses shifted rows and trims an existing text prefix without retransmission', () => {
    const previous = snapshot();
    previous.history = [
      { id: 'old', role: 'user', text: 'old request' },
      { id: 'retained', role: 'tool', text: 'tool result '.repeat(100000) },
      { id: 'answer', role: 'assistant', text: 'removed-prefix: retained-answer '.repeat(10000) },
    ];
    const next = { ...previous, history: [previous.history[1], { ...previous.history[2], text: previous.history[2].text.slice(16) + 'new token' }] };
    const patch = diffChatSnapshot(previous, next);
    expect(patch.history?.rows).toEqual([
      { reuse: 'retained', dropPrefix: 0, append: '' },
      { reuse: 'answer', dropPrefix: 16, append: 'new token' },
    ]);
    expect(JSON.stringify(patch).length).toBeLessThan(512);
    const applied = applyChatPatch(previous, patch);
    expect(applied).toEqual(next);
    expect(applied.history[0]).toBe(previous.history[1]);
    expect(() => applyChatPatch(previous, { changes: {}, history: { start: 0, deleteCount: 1, rows: [{ reuse: 'missing', dropPrefix: 0, append: '' }] } })).toThrow();
    expect(() => applyChatPatch(previous, { changes: {}, history: { start: 0, deleteCount: 1, rows: [{ reuse: 'old', dropPrefix: 100, append: '' }] } })).toThrow();
  });

  it('preserves a stable suffix and handles replacement and truncation boundaries', () => {
    const previous = snapshot();
    previous.history = [{ id: 'a', role: 'user', text: 'a' }, { id: 'b', role: 'assistant', text: 'b' }, { id: 'c', role: 'tool', text: 'c' }];
    const next = { ...previous, history: [previous.history[0], { ...previous.history[1], text: 'edited' }, previous.history[2]] };
    expect(diffChatSnapshot(previous, next).history).toEqual({ start: 1, deleteCount: 1, rows: [next.history[1]] });
    expect(applyChatPatch(previous, diffChatSnapshot(previous, next))).toEqual(next);
    const cleared = { ...next, history: [] };
    expect(applyChatPatch(next, diffChatSnapshot(next, cleared))).toEqual(cleared);
    expect(diffChatSnapshot(cleared, cleared)).toEqual({ changes: {} });
    expect(() => applyChatPatch(previous, { changes: {}, history: { start: 4, deleteCount: 0, rows: [] } })).toThrow();
    expect(() => applyChatPatch(previous, { changes: {}, history: { start: 1, deleteCount: 3, rows: [] } })).toThrow();
    expect(() => applyChatPatch(previous, { changes: {}, history: { start: 0.5, deleteCount: 0, rows: [] } })).toThrow();
  });
  it('round-trips historical reading state through detach patches without restoring consent', () => {
    const previous = { ...snapshot(), disclosure: false, executionPermission: 'ask' as const };
    const readingPosition = { provider: 'claude' as const, historyPage: 'history-123.jsonl', following: false, scrollTop: 240, anchor: { id: 'message', inset: 16 } };
    const next = { ...previous, readingPosition };
    const restored = applyChatPatch(previous, diffChatSnapshot(previous, next));
    expect(restored.readingPosition).toEqual(readingPosition);
    expect(restored.disclosure).toBe(false);
    expect(restored.executionPermission).toBe('ask');
  });


});

describe('detached intent boundaries', () => {
  it('uses the same TexyPaper event namespace as the native relay',()=>{
    expect(CHAT_EVENT).toBe('texypaper:chat');
  });
  it('rejects a previous workspace epoch even when workspace id is reused', () => {
    const current = snapshot();
    expect(sameChatScope({ workspaceId: 'workspace', epoch: 3 }, current)).toBe(true);
    expect(sameChatScope({ workspaceId: 'workspace', epoch: 2 }, current)).toBe(false);
    expect(sameChatScope({ workspaceId: 'other', epoch: 3 }, current)).toBe(false);
  });

  it('accepts only bounded serializable UI actions, never executable commands', () => {
    expect(isChatAction({ type: 'send' })).toBe(true);
    expect(isChatAction({ type: 'send', argv: ['program'] })).toBe(false);
    expect(isChatAction({ type: 'execution-decide', id: 'staged', decision: 'approve' })).toBe(true);
    expect(isChatAction({ type: 'execution-decide', id: 'staged', decision: 'approve', argv: ['replacement'] })).toBe(false);
    expect(isChatAction({ type: 'execution-permission', value: 'session', acknowledged: true })).toBe(true);
    expect(isChatAction({ type: 'execution-permission', value: 'session', acknowledged: 'true' })).toBe(false);
    expect(isChatAction({ type: 'execution-cancel', id: 'staged' })).toBe(true);
    expect(isChatAction({ type: 'prompt', value: 'x'.repeat(65536) })).toBe(true);
    expect(isChatAction({ type: 'prompt', value: 'x'.repeat(65537) })).toBe(false);
    expect(isChatAction({ type: 'provider', value: 'other' })).toBe(false);
    expect(isChatAction({ type: 'reasoning', value: '' })).toBe(true);
    expect(isChatAction({ type: 'reasoning', value: 'high' })).toBe(true);
    expect(isChatAction({ type: 'reasoning', value: 'x'.repeat(65) })).toBe(false);
    expect(isChatAction({ type: 'reasoning', value: 'high', provider: 'codex' })).toBe(false);
    expect(isChatAction({ type: 'reasoning', value: 3 })).toBe(false);
    expect(isChatAction({ type: 'decide', id: '', decision: 'apply' })).toBe(false);
    expect(isChatAction({ type: '__proto__' })).toBe(false);
  });
  it('accepts reading-only intents and rejects consent injection or invalid positions', () => {
    const value = { provider: 'claude', historyPage: 'history-123.jsonl', following: false, scrollTop: 240, anchor: { id: 'message', inset: -16 } };
    expect(isChatAction({ type: 'reading-position', value })).toBe(true);
    for (const change of [{ disclosure: true }, { executionPermission: 'session' }, { sessionId: 'restored' }, { scrollTop: Infinity }, { scrollTop: -1 }, { historyPage: '../current.jsonl' }, { historyPage: 'C:current.jsonl' }, { anchor: { id: 'message', inset: NaN } }]) {
      expect(isChatAction({ type: 'reading-position', value: { ...value, ...change } })).toBe(false);
    }
    expect(isChatAction({ type: 'history', page: '../../current.jsonl' })).toBe(false);
  });
  it('matches native numeric and UTF-8 reading-position limits', () => {
    const value = { provider: 'codex', historyPage: `${'한'.repeat(83)}.jsonl`, following: false, scrollTop: 1_000_000_000, anchor: { id: '한'.repeat(341), inset: -1_000_000_000 } };
    expect(isChatAction({ type: 'reading-position', value })).toBe(true);
    for (const change of [
      { historyPage: `${'한'.repeat(84)}.jsonl` },
      { historyPage: 'bad\u0085.jsonl' },
      { scrollTop: 1_000_000_001 },
      { anchor: { ...value.anchor, id: '한'.repeat(342) } },
      { anchor: { ...value.anchor, inset: -1_000_000_001 } },
    ]) expect(isChatAction({ type: 'reading-position', value: { ...value, ...change } })).toBe(false);
  });

  it('requires a session, finite epoch and positive monotonic-sequence candidate', () => {
    const frame = { session: 'session', workspaceId: 'workspace', epoch: 3, sequence: 1, action: { type: 'send' } };
    expect(isChatActionFrame(frame)).toBe(true);
    expect(isChatActionFrame({ ...frame, session: '' })).toBe(false);
    expect(isChatActionFrame({ ...frame, epoch: NaN })).toBe(false);
    expect(isChatActionFrame({ ...frame, sequence: 0 })).toBe(false);
    expect(isChatActionFrame({ ...frame, sequence: 1.5 })).toBe(false);
  });
});
