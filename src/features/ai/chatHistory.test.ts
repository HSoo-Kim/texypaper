import { describe, expect, it } from 'vitest';
import type { AppEvent } from '../../contracts';
import type { HistoryRow } from './chatTypes';
import { appendHistory, boundedHistory, historyFromEvents, MAX_HISTORY_BYTES, MAX_HISTORY_ROWS } from './chatHistory';

const row = (id: string, text: string): HistoryRow => ({ id, text, role: 'assistant', provider: 'codex', taskId: 'task-a' });

describe('bounded chat transcript', () => {
  it('retains the newest thousand rows without mutating its input', () => {
    const rows = Array.from({ length: MAX_HISTORY_ROWS + 12 }, (_, index) => row(String(index), 'response'));
    const bounded = boundedHistory(rows);
    expect(bounded).toHaveLength(MAX_HISTORY_ROWS);
    expect(bounded[0].id).toBe('12');
    expect(bounded.at(-1)?.id).toBe(String(MAX_HISTORY_ROWS + 11));
    expect(rows).toHaveLength(MAX_HISTORY_ROWS + 12);
  });
  it('retains a nonempty newest response even when that response alone exceeds the budget', () => {
    const text = 'a'.repeat(MAX_HISTORY_BYTES) + 'newest answer';
    const rows = boundedHistory([row('older', 'old'), row('newest', text)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('newest');
    expect(rows[0].text.endsWith('newest answer')).toBe(true);
    expect(JSON.stringify(rows).length * 2).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
    expect(text.length).toBe(MAX_HISTORY_BYTES + 'newest answer'.length);
  });
  it('counts escaped JSON text against the budget', () => {
    const text = '\n"\\'.repeat(MAX_HISTORY_BYTES / 4);
    const rows = boundedHistory([row('escaped', text)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe(text.slice(-rows[0].text.length));
    expect(rows[0].text.length).toBeGreaterThan(MAX_HISTORY_BYTES / 8);
    expect(JSON.stringify(rows).length * 2).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
  });
  it('keeps long streamed responses intact and separates provider/task boundaries', () => {
    const original = [row('first', 'x'.repeat(70_000))];
    const merged = appendHistory(original, row('delta', 'tail'));
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('x'.repeat(70_000) + 'tail');
    expect(original[0].text).toHaveLength(70_000);
    const next = appendHistory(merged, { ...row('next', 'another task'), taskId: 'task-b' });
    expect(next).toHaveLength(2);
  });
  it('also bounds UTF-8 transport bytes for Korean responses', () => {
    const rows = boundedHistory([row('korean', '논문'.repeat(MAX_HISTORY_BYTES / 4))]);
    expect(rows[0].text.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(rows)).byteLength).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
    expect(JSON.stringify(rows).length * 2).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
  });
  it('gives repeated native sequence numbers different identities across tasks', () => {
    const events: AppEvent[] = ['first-task', 'second-task'].map(taskId => ({
      workspaceId: 'w', epoch: 1, sequence: 1, kind: 'agent/text',
      payload: { taskId, provider: 'codex', delta: taskId },
    }));
    const rows = historyFromEvents(events);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(item => item.id)).size).toBe(2);
  });
  it('reconstructs tool progress and keeps assistant deltas on the correct side of it', () => {
    const event = (sequence: number, kind: string, payload: unknown): AppEvent => ({ workspaceId: 'w', epoch: 1, sequence, kind, payload });
    const rows = historyFromEvents([
      event(1, 'agent/text', { provider: 'claude', taskId: 't', delta: 'Before' }),
      event(2, 'agent/tool', { provider: 'claude', taskId: 't', tool: 'read_file', path: 'main.tex' }),
      event(3, 'agent/text', { provider: 'claude', taskId: 't', delta: 'After' }),
    ]);
    expect(rows.map(item => item.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(rows.map(item => item.text)).toEqual(['Before', 'read_file · main.tex', 'After']);
  });
});
