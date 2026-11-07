import { describe, expect, it } from 'vitest';
import { addChatAttachment, clearSentAttachments, parseAttachmentIntent, removeChatAttachment, truncateAttachmentText } from './chatAttachments';
import type { AgentContext } from './chatTypes';

const source = { kind: 'source' as const, path: 'main.tex', startLine: 42, endLine: 45, text: 'Selected paragraph' };
const pdf = { kind: 'pdf' as const, buildId: 'build-1', page: 3, quote: 'Selected PDF text' };

describe('explicit source and PDF attachment intents', () => {
  it('accepts only explicit bounded schemas, never implicit context or injected authority', () => {
    expect(parseAttachmentIntent({ ...source, focus: true })).toEqual({ ...source, focus: true });
    expect(parseAttachmentIntent(pdf)).toEqual(pdf);
    for (const invalid of [null, [], { source }, { ...source, disclosure: true }, { ...source, text: '' }, { ...source, startLine: 0 }, { ...source, endLine: 41 }, { ...source, startLine: NaN }, { ...source, endLine: 1.5 }, { ...source, focus: 'true' }, { ...source, path: '\0main.tex' }, { ...pdf, page: Infinity }, { ...pdf, page: 0 }, { ...pdf, quote: '' }, { ...pdf, buildId: '한'.repeat(86) }]) {
      expect(parseAttachmentIntent(invalid)).toBeNull();
    }
  });
  it('keeps an exact 6000-character prefix without ellipsis or splitting a surrogate pair', () => {
    const original = 'a'.repeat(5999) + '🧪' + 'tail';
    expect(truncateAttachmentText(original)).toBe('a'.repeat(5999));
    const parsed = parseAttachmentIntent({ ...source, text: original });
    expect(parsed).toMatchObject({ text: 'a'.repeat(5999), truncated: true });
    expect(original.includes(parsed && parsed.kind === 'source' ? parsed.text : 'invalid')).toBe(true);
    expect(parseAttachmentIntent({ ...pdf, quote: 'q'.repeat(6001) })).toMatchObject({ quote: 'q'.repeat(6000), truncated: true });
    expect(parseAttachmentIntent({ ...source, text: 'a'.repeat(6000) })).not.toHaveProperty('truncated');
  });
  it('deduplicates selections and caps each kind independently, reporting oldest exclusion', () => {
    let context: AgentContext = {};
    for (let index = 0; index < 8; index++) {
      context = addChatAttachment(context, { ...source, path: `${index}.tex` }).context;
      context = addChatAttachment(context, { ...pdf, page: index + 1 }).context;
    }
    expect(addChatAttachment(context, { ...source, path: '7.tex' })).toEqual({ context });
    const overflow = addChatAttachment(context, { ...source, path: 'new.tex' });
    expect(overflow.notice).toBe('source-limit');
    expect(overflow.context.sources).toHaveLength(8);
    expect(overflow.context.sources?.[0].path).toBe('1.tex');
    expect(overflow.context.sources?.at(-1)?.path).toBe('new.tex');
    expect(overflow.context.pdfs).toBe(context.pdfs);
    const pdfOverflow = addChatAttachment(overflow.context, { ...pdf, page: 20 });
    expect(pdfOverflow.notice).toBe('pdf-limit');
    expect(pdfOverflow.context.pdfs).toHaveLength(8);
    expect(pdfOverflow.context.pdfs?.[0].page).toBe(2);
  });
  it('removes only the chosen chip and clears sent attachments without losing a later explicit addition', () => {
    const first = addChatAttachment({}, source).context;
    const sent = addChatAttachment(first, pdf).context;
    const later = addChatAttachment(sent, { ...source, path: 'later.tex' }).context;
    expect(clearSentAttachments(sent, sent)).toEqual({});
    const remaining = clearSentAttachments(later, sent);
    expect(remaining.sources?.map(row => row.path)).toEqual(['later.tex']);
    expect(remaining.pdfs).toEqual([]);
    const removed = removeChatAttachment(sent, 'source', 0);
    expect(removed.sources).toEqual([]);
    expect(removed.pdfs).toBe(sent.pdfs);
    expect(sent.sources).toHaveLength(1);
  });
  it('carries an optional bounded prompt on a source intent without storing it in the attached context', () => {
    const asked = parseAttachmentIntent({ ...source, prompt: 'Why does the build fail?' });
    expect(asked).toMatchObject({ kind: 'source', prompt: 'Why does the build fail?' });
    expect(parseAttachmentIntent({ ...source, prompt: '' })).toBeNull();
    expect(parseAttachmentIntent({ ...source, prompt: 'p'.repeat(4001) })).toBeNull();
    expect(parseAttachmentIntent({ ...source, prompt: 'bad\0prompt' })).toBeNull();
    expect(parseAttachmentIntent({ ...pdf, prompt: 'not for pdf' })).toBeNull();
    const { context } = addChatAttachment({}, asked!);
    expect(context.sources?.[0]).toEqual({ path: 'main.tex', startLine: 42, endLine: 45, text: 'Selected paragraph' });
  });
});
