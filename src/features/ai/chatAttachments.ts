import type { AgentContext } from './chatTypes';

export type ChatAttachmentIntent =
  | { kind: 'source'; path: string; startLine: number; endLine: number; text: string; focus?: boolean; prompt?: string }
  | { kind: 'pdf'; buildId: string; page: number; quote: string; focus?: boolean };
export type AttachmentNotice = 'invalid' | 'source-limit' | 'pdf-limit';
type ParsedAttachment = ChatAttachmentIntent & { truncated?: boolean };
const MAX_SELECTION = 6000;
const utf8 = new TextEncoder();

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
}
function identifier(value: unknown, maximumBytes: number): value is string {
  return text(value, maximumBytes) && utf8.encode(value).byteLength <= maximumBytes;
}
function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
export function truncateAttachmentText(value: string): string {
  if (value.length <= MAX_SELECTION) return value;
  const end = /[\uD800-\uDBFF]/.test(value[MAX_SELECTION - 1]) ? MAX_SELECTION - 1 : MAX_SELECTION;
  return value.slice(0, end);
}

export function parseAttachmentIntent(value: unknown): ParsedAttachment | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (entry.focus !== undefined && typeof entry.focus !== 'boolean') return null;
  if (entry.kind === 'source') {
    if (Object.keys(entry).some(key => !['kind', 'path', 'startLine', 'endLine', 'text', 'focus', 'prompt'].includes(key)) || !identifier(entry.path, 4096) || !positiveInteger(entry.startLine) || !positiveInteger(entry.endLine) || entry.endLine < entry.startLine || !text(entry.text, 1_000_000) || (entry.prompt !== undefined && !text(entry.prompt, 4000))) return null;
    const selected = truncateAttachmentText(entry.text);
    return { kind: 'source', path: entry.path, startLine: entry.startLine, endLine: entry.endLine, text: selected, ...(entry.focus === undefined ? {} : { focus: entry.focus }), ...(entry.prompt === undefined ? {} : { prompt: entry.prompt }), ...(selected.length < entry.text.length ? { truncated: true } : {}) };
  }
  if (entry.kind === 'pdf') {
    if (Object.keys(entry).some(key => !['kind', 'buildId', 'page', 'quote', 'focus'].includes(key)) || !identifier(entry.buildId, 256) || !positiveInteger(entry.page) || !text(entry.quote, 1_000_000)) return null;
    const quote = truncateAttachmentText(entry.quote);
    return { kind: 'pdf', buildId: entry.buildId, page: entry.page, quote, ...(entry.focus === undefined ? {} : { focus: entry.focus }), ...(quote.length < entry.quote.length ? { truncated: true } : {}) };
  }
  return null;
}

export function addChatAttachment(context: AgentContext, intent: ParsedAttachment): { context: AgentContext; notice?: AttachmentNotice } {
  if (intent.kind === 'source') {
    const { kind: _kind, focus: _focus, prompt: _prompt, ...source } = intent;
    const sources = context.sources ?? [];
    if (sources.some(row => row.path === source.path && row.startLine === source.startLine && row.endLine === source.endLine && row.text === source.text)) return { context };
    return { context: { ...context, sources: [...sources.slice(-7), source] }, ...(sources.length >= 8 ? { notice: 'source-limit' as const } : {}) };
  }
  const { kind: _kind, focus: _focus, ...pdf } = intent;
  const pdfs = context.pdfs ?? [];
  if (pdfs.some(row => row.buildId === pdf.buildId && row.page === pdf.page && row.quote === pdf.quote)) return { context };
  return { context: { ...context, pdfs: [...pdfs.slice(-7), pdf] }, ...(pdfs.length >= 8 ? { notice: 'pdf-limit' as const } : {}) };
}

export function removeChatAttachment(context: AgentContext, kind: 'source' | 'pdf', index: number): AgentContext {
  return kind === 'source' ? { ...context, sources: context.sources?.filter((_, current) => current !== index) } : { ...context, pdfs: context.pdfs?.filter((_, current) => current !== index) };
}

export function clearSentAttachments(current: AgentContext, sent: AgentContext): AgentContext {
  if (current === sent) return {};
  return { ...current, sources: current.sources?.filter(source => !sent.sources?.includes(source)), pdfs: current.pdfs?.filter(pdf => !sent.pdfs?.includes(pdf)), attachments: current.attachments?.filter(path => !sent.attachments?.includes(path)) };
}
