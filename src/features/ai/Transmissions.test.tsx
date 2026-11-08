import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { appendTransmissions, transmissionEntries, Transmissions } from './Transmissions';
import type { Transmission } from './chatTypes';
vi.mock('../../ui/i18n', () => ({ useI18n: () => ({ t: (ko: string, en?: string) => en ?? ko }) }));
const entry = (id: string, taskId = 'first'): Transmission => ({ id, taskId, provider: 'codex', timestamp: 1_700_000_000_000, tool: 'read_text', paths: ['sections/paper.tex'], startLine: 3, endLine: 5, page: null, bytes: 27, characters: 15, count: 1 });
describe('metadata-only transmission disclosure', () => {
  it('groups sent rows by turn and filters the selected provider', () => {
    const html = renderToStaticMarkup(<Transmissions entries={[entry('one'), entry('two'), entry('three', 'second'), { ...entry('hidden'), provider: 'claude' }]} context={{}} provider="codex" />);
    expect(html.match(/data-testid="agent-transmission-turn"/g)).toHaveLength(2);
    expect(html.match(/data-testid="agent-transmission-row"/g)).toHaveLength(3);
    expect(html).toContain('Sent to'); expect(html).toContain('OpenAI · 3 items'); expect(html).toContain('sections/paper.tex:3–5'); expect(html).toContain('27 B'); expect(html).toContain('15 characters'); expect(html).toContain('not confirmation of cloud receipt');
  });
  it('shows pending source and PDF attachments honestly without exposing their contents', () => {
    const html = renderToStaticMarkup(<Transmissions entries={[]} context={{ sources: [{ path: 'main.tex', startLine: 2, endLine: 2, text: 'never reveal this' }], pdfs: [{ buildId: 'build', page: 4, quote: 'secret PDF quote' }] }} provider="codex" />);
    expect(html).toContain('Not sent yet'); expect(html).toContain('OpenAI · 0 items'); expect(html).toContain('main.tex'); expect(html).toContain('Page 4');
    expect(html.match(/data-testid="agent-transmission-pending"/g)).toHaveLength(2); expect(html).not.toContain('agent-transmission-row'); expect(html).not.toContain('never reveal this'); expect(html).not.toContain('secret PDF quote');
  });
  it('deduplicates reload/live overlap and retains only 500 newest entries', () => {
    const current = Array.from({ length: 500 }, (_, n) => entry(String(n)));
    const rows = appendTransmissions(current, [current[499], entry('new')]);
    expect(rows).toHaveLength(500); expect(rows[0].id).toBe('1'); expect(rows.at(-1)?.id).toBe('new'); expect(appendTransmissions([], [])).toEqual([]);
  });
  it('rejects contents or forged metadata in event entries', () => {
    expect(transmissionEntries({ entries: [entry('valid'), { ...entry('bad'), text: 'file contents' }, { ...entry('negative'), bytes: -1 }] })).toEqual([entry('valid')]);
    expect(transmissionEntries(null)).toEqual([]);
  });
});
