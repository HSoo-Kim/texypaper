import type { request as workspaceRequest } from '../../api';
import type { Entry, WorkspaceRef } from '../../contracts';
import { templateConflicts, templateFolders, type PaperTemplate } from './templates';

export type TemplateRequest = typeof workspaceRequest;
export type TemplateDirectoryReader = (path: string) => Promise<Entry[]>;

export class TemplateCreationError extends Error {
  readonly retryable = false;
  readonly details: { paths: string[]; created: string[]; failedPath?: string; cause?: unknown };

  constructor(
    readonly code: 'TEMPLATE_CONFLICT' | 'TEMPLATE_CREATE_FAILED' | 'TEMPLATE_INVALID',
    message: string,
    readonly paths: string[] = [],
    readonly created: string[] = [],
    readonly failedPath?: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'TemplateCreationError';
    this.details = { paths, created, failedPath, cause };
  }
}

/** Paginated, fresh directory reads; never recursively explores unrelated folders. */
export function templateDirectoryReader(workspace: WorkspaceRef, request: TemplateRequest): TemplateDirectoryReader {
  return async path => {
    const entries: Entry[] = [];
    let cursor: string | undefined;
    do {
      const page = await request<{ entries: Entry[]; nextCursor?: string }>('directory_list', workspace, { path, cursor, showHidden: true });
      entries.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);
    return entries;
  };
}

function validateTemplate(template: PaperTemplate): void {
  const seen = new Set<string>();
  for (const { path } of template.files) {
    const parts = path.split('/');
    if (!path || /[\\:\u0000]/.test(path) || parts.some(part => !part || part === '.' || part === '..' || ['.git', '.texypaper', '.paperdock'].includes(part.toLowerCase())) || seen.has(path.toLowerCase())) {
      throw new TemplateCreationError('TEMPLATE_INVALID', 'The template contains an unsafe or duplicate path.', [path]);
    }
    seen.add(path.toLowerCase());
  }
  if (!template.files.some(file => file.path === template.rootTex) || templateFolders(template).some(folder => seen.has(folder.toLowerCase()))) {
    throw new TemplateCreationError('TEMPLATE_INVALID', 'The template is missing its root file or has a file/folder collision.');
  }
}

export async function createFromTemplate({ workspace, template, request, listRoot = templateDirectoryReader(workspace, request) }: {
  workspace: WorkspaceRef;
  template: PaperTemplate;
  request: TemplateRequest;
  /** Optional injectable directory reader; must return every page for the relative directory. */
  listRoot?: TemplateDirectoryReader;
}): Promise<{ created: string[] }> {
  validateTemplate(template);
  const folders = templateFolders(template);
  const existingDirectories = new Set<string>();
  const existingNames: string[] = [];
  // Complete every relevant directory read before creating even the first folder.
  const collect = (entries: Entry[]) => {
    for (const entry of entries) {
      const folder = folders.find(path => path.toLowerCase() === entry.path.toLowerCase());
      if (folder && entry.kind === 'directory' && entry.path === folder) existingDirectories.add(folder);
      else existingNames.push(entry.path);
    }
  };
  collect(await listRoot(''));
  for (const folder of folders) if (existingDirectories.has(folder)) collect(await listRoot(folder));
  const conflicts = templateConflicts(template, existingNames);
  if (conflicts.length) {
    throw new TemplateCreationError('TEMPLATE_CONFLICT', `Template paths already exist: ${conflicts.join(', ')}`, conflicts);
  }

  const created: string[] = [];
  const operations = [
    ...folders.filter(path => !existingDirectories.has(path)).map(path => ({ path, kind: 'directory' as const })),
    ...[...template.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => ({ ...file, kind: 'file' as const })),
  ];
  for (const operation of operations) {
    try {
      await request('file_create', workspace, operation);
      created.push(operation.path);
    } catch (cause) {
      throw new TemplateCreationError(
        'TEMPLATE_CREATE_FAILED',
        `Could not create ${operation.path}. Already created: ${created.join(', ') || '(none)'}. No files were removed or overwritten.`,
        [], [...created], operation.path, cause,
      );
    }
  }
  return { created };
}
