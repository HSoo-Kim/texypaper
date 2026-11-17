import { describe, expect, it, vi } from 'vitest';
import type { Entry, TextDocument, WorkspaceRef } from '../../contracts';
import type { request } from '../../api';
import { loadPaperCorpus } from './project';

const workspace: WorkspaceRef = { id: 'fixture', epoch: 1, environmentId: 'local', root: 'synthetic-paper' };
const entry = (path: string, kind: Entry['kind'] = 'file', byteLength = 20): Entry => ({ path, name: path.split('/').at(-1)!, kind, paper: 'none', main: false, byteLength });
const document = (path: string, text: string, extra: Partial<TextDocument> = {}): TextDocument => ({ file: { workspaceId: workspace.id, path }, text, revision: { sha256: 'fixture', byteLength: text.length, modifiedNs: '0' }, encoding: 'utf8', newline: 'lf', readOnly: false, ...extra });

describe('project manuscript corpus', () => {
  it('includes unopened nested bibliography and unsaved edits without reading hidden folders or other data', async () => {
    const invoke = vi.fn(async (command: string, _scope: WorkspaceRef, args: { path: string }) => {
      if (command === 'directory_list') return { entries: args.path === '' ? [entry('main.tex'), entry('refs', 'directory'), entry('.private', 'directory'), entry('build', 'directory'), entry('data.csv')] : [entry('refs/library.bib')] };
      if (command === 'file_read') return document(args.path, '@article{unopened,title={Nested evidence}}');
      throw new Error('Unexpected mutation: ' + command);
    }) as typeof request;
    const result = await loadPaperCorpus(workspace, new Map([['main.tex', 'Unsaved \\cite{unopened}']]), new AbortController().signal, invoke);
    expect(result).toEqual({ complete: true, skipped: [], files: [{ path: 'main.tex', text: 'Unsaved \\cite{unopened}' }, { path: 'refs/library.bib', text: '@article{unopened,title={Nested evidence}}' }] });
    expect(invoke).not.toHaveBeenCalledWith('file_read', workspace, { path: 'main.tex' });
  });
  it('never treats a partial, legacy, oversized or linked file as fully checked', async () => {
    const invoke = vi.fn(async (command: string, _scope: WorkspaceRef, args: { path: string }) => command === 'directory_list'
      ? { entries: [entry('good.tex'), entry('partial.tex'), entry('legacy.bib'), entry('huge.tex', 'file', 1048577), entry('linked.bib', 'symlink')] }
      : document(args.path, 'source', { truncated: args.path === 'partial.tex', encoding: args.path === 'legacy.bib' ? 'unsupported' : 'utf8' })) as typeof request;
    const result = await loadPaperCorpus(workspace, new Map(), new AbortController().signal, invoke);
    expect(result.files).toEqual([{ path: 'good.tex', text: 'source' }]);
    expect(result.complete).toBe(false);
    expect(result.skipped.map(file => file.path)).toEqual(['partial.tex', 'legacy.bib', 'huge.tex', 'linked.bib']);
  });
  it('stops immediately on a lost SSH workspace instead of presenting an empty successful scan', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'directory_list') return { entries: [entry('main.tex'), entry('refs.bib')] };
      throw { code: 'SSH_DISCONNECTED', message: 'Synthetic disconnect' };
    }) as typeof request;
    await expect(loadPaperCorpus(workspace, new Map(), new AbortController().signal, invoke)).rejects.toMatchObject({ code: 'SSH_DISCONNECTED' });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('stops directory enumeration after cancellation and never reads the next project', async () => {
    const controller = new AbortController();
    const invoke = vi.fn(async () => { controller.abort(); return { entries: [entry('nested', 'directory')], nextCursor: 'more' }; }) as typeof request;
    await expect(loadPaperCorpus(workspace, new Map(), controller.signal, invoke)).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
