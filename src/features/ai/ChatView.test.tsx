import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatView } from './ChatView';
import type { ChatSnapshot } from './chatTypes';

vi.mock('../../ui/i18n', () => ({ useI18n: () => ({ t: (korean: string, english?: string) => english ?? korean }) }));

function snapshot(): ChatSnapshot {
  return {
    workspace: { id: 'workspace', epoch: 3, environmentId: 'private-host', root: '/private/project' },
    provider: 'codex', model: 'model', reasoningEffort: '', account: { provider: 'codex', available: true, loggedIn: true, subscription: true },
    configuration: { models: [{ id: 'model', label: 'Model', reasoningEfforts: [] }], allowCustom: false, loading: false, instructions: false, executable: '', error: null },
    prompt: 'Explain this', busy: false, status: 'idle', taskId: '', sessionId: '', loginUrl: '', error: null,
    history: [], proposals: [], proposalBusy: [], context: {}, pages: [], historyPage: 'current.jsonl', settingsOpen: false,
    executionPermission: 'ask', executions: [],
  };
}
function markup(change: Partial<ChatSnapshot> = {}, detached = false, fontSize = 13) {
  return renderToStaticMarkup(<ChatView snapshot={{ ...snapshot(), ...change }} onAction={() => {}} detached={detached} fontSize={fontSize} />);
}

describe('compact explicit chat composer', () => {
  it('sends a ready request without a consent step and shows no project environment/path', () => {
    const html = markup();
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('class="agent-context"');
    expect(html).not.toContain('private-host');
    expect(html).not.toContain('/private/project');
    expect(html).not.toContain('data-testid="agent-attachments"');
    expect(html).not.toMatch(/data-testid="agent-send" disabled=""/);
  });
  it('keeps send disabled without a prompt or a ready account', () => {
    expect(markup({ prompt: '  ' })).toMatch(/data-testid="agent-send" disabled=""/);
    expect(markup({ account: { provider: 'codex', available: true, loggedIn: true, subscription: false } })).toMatch(/data-testid="agent-send" disabled=""/);
  });
  it('renders source and PDF chips with quote descriptions, removal, and the same text size in either window', () => {
    const context = { sources: [{ path: 'sections/main.tex', startLine: 42, endLine: 45, text: 'Exact selected source', truncated: true }], pdfs: [{ buildId: 'build', page: 3, quote: 'Exact PDF quote' }] };
    for (const detached of [false, true]) {
      const html = markup({ context }, detached, 19);
      expect(html).toContain('data-chat-font-size="19"');
      expect(html).toContain('--chat-font-size:1.1875rem');
      expect(html).toContain('data-testid="agent-attachments"');
      expect(html).toContain('data-kind="source"');
      expect(html).toContain('data-kind="pdf"');
      expect(html).toContain('main.tex:42–45');
      expect(html).toContain('PDF 3');
      expect(html).toContain('aria-description="Exact selected source');
      expect(html).toContain('Only the beginning of the selection is attached');
      expect(html.match(/data-testid="agent-attachment-remove"/g)).toHaveLength(2);
      expect(html).not.toContain('/private/project');
    }
  });
});
