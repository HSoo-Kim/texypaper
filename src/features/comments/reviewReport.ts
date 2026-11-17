import type { request as workspaceRequest } from '../../api';
import type { CommentThread, WorkspaceRef } from '../../contracts';

export type ReviewExportPathIssue = 'relative' | 'metadata' | 'extension';
export type ReviewExportRequest = typeof workspaceRequest;

/** Keep paths portable between local Windows projects and SSH workspaces. */
export function reviewExportPathIssue(path: string): ReviewExportPathIssue | null {
  const parts = path.split('/');
  if (!path || path !== path.trim() || /[\\:*?"<>|\u0000-\u001f\u007f]/.test(path) || /^~/.test(path)
    || /%(?:2e|2f|5c|3a|00)/i.test(path)
    || parts.some(part => !part || part === '.' || part === '..' || /[.\s]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return 'relative';
  if (parts.some(part => /^(?:\.git|\.texypaper|\.paperdock)$/i.test(part)
    || /^\.(?:texypaper|paperdock)-/i.test(part))) return 'metadata';
  if (!/^.+\.md$/i.test(parts[parts.length - 1])) return 'extension';
  return null;
}

/** User Markdown stays literal, including HTML, links, headings and embedded fences. */
export function reviewLiteralBlock(value: string): string {
  const text = value.replace(/\r\n?/g, '\n');
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  return `${fence}\n${text}\n${fence}`;
}

export function reviewExportSummary(threads: readonly CommentThread[]) {
  const summary = { threads: threads.length, messages: 0, replies: 0, open: 0, resolved: 0, orphaned: 0 };
  for (const thread of threads) {
    summary[thread.status]++;
    summary.messages += thread.messages.length;
    summary.replies += Math.max(0, thread.messages.length - 1);
  }
  return summary;
}

/** Deterministic snapshot; deliberately never modifies threads or assigns author roles. */
export function buildReviewReport(threads: readonly CommentThread[]): string {
  const counts = reviewExportSummary(threads);
  const lines = [
    '# Review report', '',
    `- Threads: ${counts.threads}`,
    `- Open: ${counts.open}`,
    `- Resolved: ${counts.resolved}`,
    `- Orphaned: ${counts.orphaned}`,
    `- Recorded messages: ${counts.messages}`,
    `- Replies: ${counts.replies}`, '',
    'Snapshot of saved comments, including every status. Unsaved drafts are not included.',
    'The first retained message in each thread is labeled the original comment. Deleted message history is not available.',
    'Replies are discussion messages, not formal author responses; the saved format does not record reviewer or author roles.',
    'Anchor information is recorded metadata and has not been revalidated for this export. User text is shown literally.', '',
  ];
  for (const [index, thread] of threads.entries()) {
    lines.push(`## Thread ${index + 1}`, '', `Status: ${thread.status}`, '',
      `Orphaned: ${thread.status === 'orphaned' ? 'yes — reattachment needed' : 'not marked orphaned'}`, '',
      'Thread ID:', '', reviewLiteralBlock(thread.id), '');
    if (thread.source) {
      lines.push('### Source anchor', '', 'Path:', '', reviewLiteralBlock(thread.source.path), '',
        `Byte range: ${thread.source.startByte}–${thread.source.endByte}`, '',
        'Source revision (SHA-256):', '', reviewLiteralBlock(thread.source.baseSha256), '',
        'Source quote:', '', reviewLiteralBlock(thread.source.quote), '');
    }
    if (thread.pdf) {
      lines.push('### PDF anchor', '', `PDF page: ${thread.pdf.page}`, '',
        'Build ID:', '', reviewLiteralBlock(thread.pdf.buildId), '',
        'PDF revision (SHA-256):', '', reviewLiteralBlock(thread.pdf.pdfSha256), '',
        'PDF quote:', '', reviewLiteralBlock(thread.pdf.quote), '');
    }
    if (!thread.source && !thread.pdf) lines.push('Anchor: project note (no source or PDF anchor recorded).', '');
    if (!thread.messages.length) lines.push('No recorded messages.', '');
    thread.messages.forEach((message, messageIndex) => {
      lines.push(messageIndex === 0 ? '### Original comment (first retained message)' : `### Reply ${messageIndex}`, '',
        'Message ID:', '', reviewLiteralBlock(message.id), '',
        'Recorded author identity (not a role):', '', reviewLiteralBlock(message.author), '',
        'Created at:', '', reviewLiteralBlock(message.createdAt), '',
        'Updated at:', '', reviewLiteralBlock(message.updatedAt), '',
        'Message:', '', reviewLiteralBlock(message.text), '');
    });
  }
  if (!threads.length) lines.push('No saved comment threads.', '');
  return lines.join('\n');
}

/** file_create is the existing exclusive-create operation on the selected host. No save/overwrite fallback. */
export async function saveReviewReport({ workspace, path, content, request }: {
  workspace: WorkspaceRef;
  path: string;
  content: string;
  request: ReviewExportRequest;
}): Promise<void> {
  const issue = reviewExportPathIssue(path);
  if (issue) throw { code: 'REVIEW_EXPORT_PATH', message: 'Choose a safe relative .md path outside project metadata.', retryable: false };
  await request('file_create', workspace, { path, kind: 'file', content });
}
