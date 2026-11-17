import { describe, expect, it, vi } from 'vitest';
import type { CommentThread, WorkspaceRef } from '../../contracts';
import { buildReviewReport, reviewExportPathIssue, reviewExportSummary, reviewLiteralBlock, saveReviewReport, type ReviewExportRequest } from './reviewReport';

const workspace: WorkspaceRef = { id: 'paper', epoch: 7, root: '/papers/논문', environmentId: 'ssh-lab' };
const message = (id: string, text: string): CommentThread['messages'][number] => ({
  id, author: 'me', text, createdAt: '2026-11-15T10:00:00Z', updatedAt: '2026-11-15T11:00:00Z',
});
const threads: CommentThread[] = [
  {
    id: 'source-thread', status: 'open',
    source: { path: 'chapters/결과.tex', startByte: 4, endByte: 28, baseSha256: 'source-revision', quote: '첫째 줄\n> 인용문\n# 제목' , before: '', after: '' },
    messages: [message('original', '수치 42와 인용 [1] 확인'), message('reply-a', '첫 답글'), message('reply-b', 'Second reply')],
  },
  {
    id: 'pdf-thread', status: 'resolved',
    pdf: { buildId: 'build-9', pdfSha256: 'pdf-revision', page: 12, rects: [[0, 0, 10, 10]], quote: 'PDF의 원문\n다음 줄' },
    messages: [message('pdf-original', 'PDF comment')],
  },
  { id: 'orphan-thread', status: 'orphaned', messages: [] },
];

describe('review report serialization', () => {
  it('includes all statuses, original comments, every reply, anchors and exact counts', () => {
    expect(reviewExportSummary(threads)).toEqual({ threads: 3, messages: 4, replies: 2, open: 1, resolved: 1, orphaned: 1 });
    const report = buildReviewReport(threads);
    expect(report).toContain('- Threads: 3\n- Open: 1\n- Resolved: 1\n- Orphaned: 1\n- Recorded messages: 4\n- Replies: 2');
    expect(report.match(/^## Thread \d+$/gm)).toHaveLength(3);
    expect(report.match(/^### Original comment \(first retained message\)$/gm)).toHaveLength(2);
    expect(report).toContain('### Reply 1');
    expect(report).toContain('### Reply 2');
    for (const thread of threads) for (const item of thread.messages) expect(report).toContain(reviewLiteralBlock(item.text));
    expect(report).toContain(reviewLiteralBlock('chapters/결과.tex'));
    expect(report).toContain(reviewLiteralBlock(threads[0].source!.quote));
    expect(report).toContain('Byte range: 4–28');
    expect(report).toContain('PDF page: 12');
    expect(report).toContain(reviewLiteralBlock('build-9'));
    expect(report).toContain(reviewLiteralBlock('pdf-revision'));
    expect(report).toContain(reviewLiteralBlock(threads[1].pdf!.quote));
    expect(report).toContain('Orphaned: yes — reattachment needed');
    expect(report).toContain('No recorded messages.');
    expect(report).toContain('not formal author responses');
  });

  it('contains Unicode and multiline Markdown/HTML as literal data, even embedded fences', () => {
    const text = '한글 🧪\r\n```\r\n## injected thread\r\n``````\r\n<script>alert(1)</script>\r\n[link](https://example.org)\r\n> quote';
    const block = reviewLiteralBlock(text);
    expect(block).toBe('```````\n한글 🧪\n```\n## injected thread\n``````\n<script>alert(1)</script>\n[link](https://example.org)\n> quote\n```````');
    const malicious: CommentThread = {
      id: '\n# injected identity', status: 'open',
      source: { ...threads[0].source!, path: '`\n# injected path', quote: text },
      messages: [{ ...message('message', text), createdAt: '\n## injected timestamp' }],
    };
    const report = buildReviewReport([malicious]);
    expect(report).toContain(block);
    expect(report).toContain(reviewLiteralBlock(malicious.id));
    expect(report).toContain(reviewLiteralBlock(malicious.source!.path));
    expect(report).toContain(reviewLiteralBlock(malicious.messages[0].createdAt));
  });

  it('is deterministic and does not change frozen saved comments', () => {
    const frozen = structuredClone(threads);
    for (const thread of frozen) {
      for (const item of thread.messages) Object.freeze(item);
      Object.freeze(thread.messages);
      if (thread.source) Object.freeze(thread.source);
      if (thread.pdf) Object.freeze(thread.pdf);
      Object.freeze(thread);
    }
    Object.freeze(frozen);
    expect(buildReviewReport(frozen)).toBe(buildReviewReport(threads));
    expect(frozen).toEqual(threads);
  });

  it('exports an honest empty snapshot without inventing replies', () => {
    const report = buildReviewReport([]);
    expect(report).toContain('- Threads: 0');
    expect(report).toContain('- Replies: 0');
    expect(report).toContain('No saved comment threads.');
    expect(report).not.toContain('### Reply');
  });
});

describe('review report destinations', () => {
  it.each(['review-report.md', 'reviews/검토 결과.md', 'Review.MD'])('accepts portable project-relative Markdown destination %s', path => {
    expect(reviewExportPathIssue(path)).toBeNull();
  });

  it.each(['', '/outside.md', '../outside.md', 'reviews/../outside.md', './report.md', 'reviews//report.md', 'C:/outside.md', 'C:\\outside.md', '\\\\host\\share\\report.md', ' report.md', 'report.md ', 'reviews./report.md', 'reviews /report.md', 'reviews\u0000/report.md', 'review\nreport.md', '~/report.md', 'reports/%2e%2e/report.md', 'CON.md', 'reports/AUX/report.md', 'report:stream.md'])('rejects unsafe destination %s', path => {
    expect(reviewExportPathIssue(path)).toBe('relative');
  });

  it.each(['.git/report.md', '.texypaper/report.md', '.paperdock/report.md', 'nested/.TEXYPAPER/report.md', '.texypaper-private/report.md', '.paperdock-migration/report.md'])('rejects private metadata destination %s', path => {
    expect(reviewExportPathIssue(path)).toBe('metadata');
  });

  it.each(['report', 'report.tex', 'report.md.exe', '.md'])('requires a named Markdown file %s', path => {
    expect(reviewExportPathIssue(path)).toBe('extension');
  });
});

describe('explicit review report creation', () => {
  it('only calls file_create when explicitly saved, on the supplied workspace host', async () => {
    const calls: { command: string; workspace: WorkspaceRef; args: unknown }[] = [];
    const request: ReviewExportRequest = async <T>(command: string, current: WorkspaceRef, args?: unknown) => {
      calls.push({ command, workspace: current, args });
      return { created: true } as T;
    };
    const content = buildReviewReport(threads);
    reviewExportPathIssue('reviews/report.md');
    expect(calls).toEqual([]);
    await saveReviewReport({ workspace, path: 'reviews/report.md', content, request });
    expect(calls).toEqual([{ command: 'file_create', workspace, args: { path: 'reviews/report.md', kind: 'file', content } }]);
  });

  it('rejects unsafe paths before any request', async () => {
    const request = vi.fn() as ReviewExportRequest;
    await expect(saveReviewReport({ workspace, path: '../report.md', content: 'report', request })).rejects.toMatchObject({ code: 'REVIEW_EXPORT_PATH' });
    expect(request).not.toHaveBeenCalled();
  });

  it('retains an existing target and propagates the native failure without retry or overwrite', async () => {
    const files = new Map([['review-report.md', 'existing content']]);
    const failure = { code: 'FILE_CONFLICT', message: 'Destination exists', retryable: false };
    const commands: string[] = [];
    const request: ReviewExportRequest = async <T>(command: string, _current: WorkspaceRef, args?: unknown) => {
      commands.push(command);
      const { path, content } = args as { path: string; content: string };
      if (files.has(path)) throw failure;
      files.set(path, content);
      return {} as T;
    };
    await expect(saveReviewReport({ workspace, path: 'review-report.md', content: 'new report', request })).rejects.toBe(failure);
    expect(files.get('review-report.md')).toBe('existing content');
    expect(commands).toEqual(['file_create']);
  });
});
