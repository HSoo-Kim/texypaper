import type { AppEvent } from '../../contracts';
import type { ChatReadingPosition, HistoryRow } from './chatTypes';

export const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
export const MAX_HISTORY_ROWS = 1000;

export function readingScrollTop(position: Pick<ChatReadingPosition, 'following' | 'scrollTop' | 'anchor'>, rows: HistoryRow[], offsets: number[], scrollHeight: number, viewportHeight: number): number {
  const maximum = Math.max(0, scrollHeight - viewportHeight);
  if (position.following) return maximum;
  const index = position.anchor ? rows.findIndex(row => row.id === position.anchor?.id) : -1;
  const top = index >= 0 && offsets[index] !== undefined ? offsets[index] + position.anchor!.inset : position.scrollTop;
  return Math.min(maximum, Math.max(0, top));
}
function rowBytes(row: HistoryRow): number {
  const serialized = JSON.stringify(row);
  let utf8 = 0;
  for (let index = 0; index < serialized.length; index++) {
    const code = serialized.charCodeAt(index);
    if (code < 0x80) utf8++;
    else if (code < 0x800) utf8 += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { utf8 += 4; index++; }
    else utf8 += 3;
  }
  // JSON.stringify escapes unpaired surrogates. Bound both UTF-8 transport and UTF-16 memory.
  return Math.max(serialized.length * 2, utf8) + 2;
}

function tailWithinBytes(text: string, budget: number): string {
  let start = text.length;
  let bytes = 0;
  while (start > 0) {
    let next = start - 1;
    const code = text.charCodeAt(next);
    let cost: number;
    if (code >= 0xdc00 && code <= 0xdfff && next > 0 && text.charCodeAt(next - 1) >= 0xd800 && text.charCodeAt(next - 1) <= 0xdbff) {
      next--;
      cost = 4;
    } else if (code >= 0xd800 && code <= 0xdfff) cost = 12;
    else if (code < 0x20) cost = code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 4 : 12;
    else if (code === 0x22 || code === 0x5c) cost = 4;
    else cost = code < 0x800 ? 2 : 3;
    // Bound both encodings without repeatedly serializing and copying a large response.
    if (bytes + cost > budget) break;
    bytes += cost;
    start = next;
  }
  return text.slice(start);
}

// Native sequence counters restart for each provider task.
export function historyEventKey(event: AppEvent): string {
  const payload = event.payload as Record<string, unknown>;
  return `${String(payload.taskId ?? '')}:${String(payload.provider ?? '')}:${event.kind}:${event.sequence}`;
}
// Keep the newest content, including the tail of a single over-budget response.
export function boundedHistory(rows: HistoryRow[]): HistoryRow[] {
  let bytes = 4; // Array brackets; rowBytes also reserves each comma.
  const kept: HistoryRow[] = [];
  for (let index = rows.length - 1; index >= 0 && kept.length < MAX_HISTORY_ROWS; index--) {
    let row = rows[index];
    const size = rowBytes(row);
    if (bytes + size > MAX_HISTORY_BYTES) {
      const available = MAX_HISTORY_BYTES - bytes - rowBytes({ ...row, text: '' });
      if (available > 0) {
        row = { ...row, text: tailWithinBytes(row.text, available) };
        if (row.text) kept.push(row);
      }
      break;
    }
    kept.push(row);
    bytes += size;
  }
  return kept.reverse();
}

export function appendHistory(rows: HistoryRow[], row: HistoryRow): HistoryRow[] {
  const last = rows[rows.length - 1];
  if (row.role === 'assistant' && last?.role === 'assistant' && last.provider === row.provider && last.taskId === row.taskId) {
    return boundedHistory([...rows.slice(0, -1), { ...last, text: last.text + row.text }]);
  }
  return boundedHistory([...rows, row]);
}

export function historyFromEvents(events: AppEvent[]): HistoryRow[] {
  let rows: HistoryRow[] = [];
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    const role = event.kind === 'agent/user' ? 'user' : event.kind === 'agent/text' ? 'assistant' : event.kind === 'agent/tool' ? 'tool' : null;
    if (!role) continue;
    const text = role === 'assistant' ? String(payload.delta ?? '') : role === 'tool' ? `${String(payload.tool ?? '')}${payload.path ? ` · ${String(payload.path)}` : ''}` : String(payload.text ?? '');
    rows = appendHistory(rows, { id: `event:${historyEventKey(event)}`, role, text, provider: String(payload.provider ?? ''), taskId: String(payload.taskId ?? '') });
  }
  return rows;
}
