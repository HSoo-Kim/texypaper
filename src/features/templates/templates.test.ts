import { describe, expect, it } from 'vitest';
import type { Entry, WorkspaceRef } from '../../contracts';
import { createFromTemplate, TemplateCreationError, type TemplateRequest } from './createFromTemplate';
import { paperTemplates, templateConflicts, templateFolders, type PaperTemplate } from './templates';

const workspace: WorkspaceRef = { id: 'test', environmentId: 'local', root: '/paper', epoch: 1 };
const article = paperTemplates.find(template => template.id === 'article')!;
const report = paperTemplates.find(template => template.id === 'report')!;
const entry = (path: string, kind: Entry['kind'] = 'file'): Entry => ({ path, name: path.split('/').at(-1)!, kind, paper: 'none', main: false });

function fakeRequest(directories: Record<string, Entry[]> = {}, failAt?: string) {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const request: TemplateRequest = async <T>(command: string, _workspace: WorkspaceRef, args: unknown = {}) => {
    const options = args as Record<string, unknown>;
    calls.push({ command, args: options });
    if (command === 'directory_list') return { entries: directories[String(options.path)] ?? [] } as T;
    if (command === 'file_create' && options.path === failAt) throw { code: 'FILE_EXISTS', message: 'An outside writer created this path.', retryable: false };
    return {} as T;
  };
  return { request, calls };
}

function activeTex(content: string) {
  return content.split('\n').map(line => line.replace(/(^|[^\\])%.*/, '$1')).join('\n');
}

describe('paper templates', () => {
  it('offers exactly the four requested original templates', () => {
    expect(paperTemplates.map(template => template.id)).toEqual(['article', 'article-ko', 'beamer', 'report']);
    expect(paperTemplates.find(template => template.id === 'article-ko')?.engine).toBe('xelatex');
  });

  it.each(paperTemplates)('$id contains a complete root, safe unique paths and bilingual labels', template => {
    expect(template.name.ko).toBeTruthy();
    expect(template.name.en).toBeTruthy();
    expect(template.description.ko).toBeTruthy();
    expect(template.description.en).toBeTruthy();
    expect(template.rootTex).toBe('main.tex');
    const root = template.files.find(file => file.path === template.rootTex);
    expect(root?.content).toContain('\\documentclass');
    expect(root?.content).toContain('\\begin{document}');
    expect(root?.content).toContain('\\end{document}');
    const paths = template.files.map(file => file.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const file of template.files) {
      expect(file.path).not.toMatch(/(^\/|\\|:|\u0000)/);
      expect(file.path.split('/').every(part => part && part !== '..' && part !== '.' && !['.git', '.texypaper', '.paperdock'].includes(part))).toBe(true);
      for (const match of activeTex(file.content).matchAll(/\\(input|bibliography)\{([^}]+)\}/g)) {
        for (const target of match[2].split(',')) expect(paths).toContain(`${target}${match[1] === 'input' ? '.tex' : '.bib'}`);
      }
    }
  });

  it('finds direct and nested conflicts without confusing unrelated names', () => {
    expect(templateConflicts(report, ['main.tex', 'notes.tex', 'chapters/conclusion.tex'])).toEqual(['main.tex', 'chapters/conclusion.tex']);
    expect(templateConflicts(report, ['chapters', 'MAIN.TEX'])).toEqual(['chapters', 'main.tex']);
    expect(templateConflicts(article, ['chapters/main.tex', 'main.tex.bak'])).toEqual([]);
  });

  it('orders parent folders before descendants and removes duplicates', () => {
    const nested: PaperTemplate = { ...report, files: [{ path: 'z/b/file.tex', content: '' }, { path: 'a/file.tex', content: '' }, { path: 'z/b/other.tex', content: '' }] };
    expect(templateFolders(nested)).toEqual(['a', 'z', 'z/b']);
    expect(templateFolders(article)).toEqual([]);
  });
});

describe('createFromTemplate', () => {
  it('lists the root before creating folders, then files in deterministic path order', async () => {
    const fake = fakeRequest();
    const result = await createFromTemplate({ workspace, template: report, request: fake.request });
    expect(fake.calls[0]).toEqual({ command: 'directory_list', args: { path: '', cursor: undefined, showHidden: true } });
    const writes = fake.calls.filter(call => call.command === 'file_create');
    expect(writes.map(call => call.args.path)).toEqual(['chapters', 'chapters/conclusion.tex', 'chapters/introduction.tex', 'main.tex', 'references.bib']);
    expect(writes[0].args.kind).toBe('directory');
    expect(writes.slice(1).every(call => call.args.kind === 'file' && typeof call.args.content === 'string')).toBe(true);
    expect(result.created).toEqual(writes.map(call => call.args.path));
  });

  it('refuses all writes when any root template file exists', async () => {
    const fake = fakeRequest({ '': [entry('references.bib')] });
    await expect(createFromTemplate({ workspace, template: article, request: fake.request })).rejects.toMatchObject({ code: 'TEMPLATE_CONFLICT', paths: ['references.bib'], created: [] });
    expect(fake.calls.every(call => call.command === 'directory_list')).toBe(true);
  });

  it('preflights existing template folders and refuses nested collisions before writing', async () => {
    const fake = fakeRequest({ '': [entry('chapters', 'directory'), entry('.git', 'directory')], chapters: [entry('chapters/introduction.tex')] });
    await expect(createFromTemplate({ workspace, template: report, request: fake.request })).rejects.toMatchObject({ code: 'TEMPLATE_CONFLICT', paths: ['chapters/introduction.tex'] });
    expect(fake.calls.map(call => call.args.path)).toEqual(['', 'chapters']);
  });

  it('reuses a real folder and preserves unrelated content', async () => {
    const fake = fakeRequest({ '': [entry('chapters', 'directory')], chapters: [entry('chapters/notes.txt')] });
    await createFromTemplate({ workspace, template: report, request: fake.request });
    expect(fake.calls.filter(call => call.command === 'file_create').map(call => call.args.path)).not.toContain('chapters');
    expect(fake.calls.some(call => call.args.path === 'chapters/notes.txt')).toBe(false);
  });

  it.each(['file', 'symlink'] as const)('does not follow a template folder that is a %s', async kind => {
    const fake = fakeRequest({ '': [entry('chapters', kind)] });
    await expect(createFromTemplate({ workspace, template: report, request: fake.request })).rejects.toMatchObject({ code: 'TEMPLATE_CONFLICT', paths: ['chapters'] });
    expect(fake.calls).toHaveLength(1);
  });

  it('follows directory pagination before detecting a collision', async () => {
    const calls: string[] = [];
    const request: TemplateRequest = async <T>(command: string, _workspace: WorkspaceRef, args: unknown = {}) => {
      calls.push(command);
      const cursor = args && typeof args === 'object' && 'cursor' in args ? args.cursor : undefined;
      return (cursor ? { entries: [entry('main.tex')] } : { entries: [entry('notes.txt')], nextCursor: 'second' }) as T;
    };
    await expect(createFromTemplate({ workspace, template: article, request })).rejects.toMatchObject({ code: 'TEMPLATE_CONFLICT', paths: ['main.tex'] });
    expect(calls).toEqual(['directory_list', 'directory_list']);
  });

  it('stops at the first failed create and reports acknowledged paths without deleting anything', async () => {
    const fake = fakeRequest({}, 'main.tex');
    try {
      await createFromTemplate({ workspace, template: report, request: fake.request });
      throw new Error('Expected creation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateCreationError);
      expect(error).toMatchObject({ code: 'TEMPLATE_CREATE_FAILED', failedPath: 'main.tex', created: ['chapters', 'chapters/conclusion.tex', 'chapters/introduction.tex'] });
    }
    expect(fake.calls.at(-1)?.args.path).toBe('main.tex');
    expect(fake.calls.every(call => ['directory_list', 'file_create'].includes(call.command))).toBe(true);
  });

  it('does not create anything when preflight cannot list an existing folder', async () => {
    const fake = fakeRequest();
    await expect(createFromTemplate({ workspace, template: report, request: fake.request, listRoot: async path => {
      if (path === '') return [entry('chapters', 'directory')];
      throw new Error('Connection lost');
    } })).rejects.toThrow('Connection lost');
    expect(fake.calls).toEqual([]);
  });

  it.each(['../main.tex', '/main.tex', 'a\\main.tex', '.texypaper/main.tex', '.git/main.tex', 'a/../main.tex', 'C:main.tex', 'a//main.tex'])('rejects unsafe path %s before any native request', async path => {
    const fake = fakeRequest();
    await expect(createFromTemplate({ workspace, template: { ...article, files: [{ path, content: '' }] }, request: fake.request })).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
    expect(fake.calls).toEqual([]);
  });
});
