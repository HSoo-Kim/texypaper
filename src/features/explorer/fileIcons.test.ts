import { describe, expect, it } from 'vitest';
import { fileIconId } from './fileIcons';

describe('file icon classification', () => {
  it.each([
    ['tex', ['tex', 'ltx']],
    ['bib', ['bib', 'bst']],
    ['latex', ['sty', 'cls', 'bbx', 'cbx', 'dtx', 'ins']],
    ['pdf', ['pdf']],
    ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'eps']],
    ['python', ['py']],
    ['javascript', ['js', 'mjs']],
    ['typescript', ['ts']],
    ['react', ['tsx', 'jsx']],
    ['rust', ['rs']],
    ['json', ['json']],
    ['config', ['toml', 'yaml', 'yml']],
    ['markdown', ['md']],
    ['table', ['csv', 'tsv', 'xlsx']],
    ['text', ['txt', 'log']],
    ['archive', ['zip', 'gz', 'tar', '7z']],
    ['terminal', ['sh', 'ps1', 'bat']],
    ['binary', ['exe', 'dll', 'so']],
    ['build', ['aux', 'toc', 'out', 'synctex', 'fls', 'fdb_latexmk', 'bbl', 'blg']],
  ] as const)('maps %s extensions without depending on case', (id, extensions) => {
    for (const extension of extensions) {
      expect(fileIconId('file', `paper.${extension}`)).toBe(`file-${id}`);
      expect(fileIconId('file', `PAPER.${extension.toUpperCase()}`)).toBe(`file-${id}`);
    }
  });

  it.each([
    ['.gitignore', 'git'], ['.gitattributes', 'git'], ['.gitmodules', 'git'],
    ['.env', 'env'], ['.env.local', 'env'], ['.env.production', 'env'],
    ['latexmkrc', 'config'], ['.latexmkrc', 'config'], ['Makefile', 'config'],
    ['README', 'info'], ['README.md', 'info'], ['README-ko.txt', 'info'],
    ['LICENSE', 'license'], ['LICENSE.txt', 'license'], ['LICENSE-MIT', 'license'],
    ['paper.synctex.gz', 'build'], ['paper.tar.gz', 'archive'],
  ])('recognizes special filename %s before its extension', (name, id) => {
    expect(fileIconId('file', name)).toBe(`file-${id}`);
    expect(fileIconId('file', name.toUpperCase())).toBe(`file-${id}`);
  });

  it.each(['notes', 'file.unknown', '.hidden', '', 'trailing.', 'file.constructor', 'file.__proto__'])('uses a neutral document for %s', name => {
    expect(fileIconId('file', name)).toBe('file-unknown');
  });

  it('uses the basename for POSIX and Windows paths', () => {
    expect(fileIconId('file', 'project/sections/INTRO.TEX')).toBe('file-tex');
    expect(fileIconId('file', 'project\\figures\\plot.SVG')).toBe('file-image');
    expect(fileIconId('directory', 'project/Figures')).toBe('folder-figures');
  });

  it('adds a symlink overlay identity while retaining the target filename type', () => {
    expect(fileIconId('symlink', 'main.tex')).toBe('file-tex-symlink');
    expect(fileIconId('symlink', 'plot.pdf')).toBe('file-pdf-symlink');
    expect(fileIconId('symlink', 'shortcut')).toBe('file-unknown-symlink');
    expect(fileIconId('symlink', 'main.tex', true)).toBe('file-tex-symlink');
    expect(fileIconId('file', 'main.tex', true)).toBe('file-tex');
  });
});

describe('folder icon classification', () => {
  it.each([
    ['figures', ['figures', 'figure', 'images', 'img', 'assets', 'pics', 'plots', 'plot', 'graphics', 'pictures', 'photos', 'media']],
    ['code', ['code', 'src', 'scripts', 'lib', 'utils', 'tools', 'notebooks']],
    ['results', ['results', 'data', 'output', 'outputs', 'out', 'tables', 'experiments', 'runs']],
    ['sections', ['sections', 'chapters', 'chapter', 'parts', 'appendix', 'appendices', 'content']],
    ['paper', ['paper', 'papers', 'manuscript', 'draft', 'tex', 'latex']],
    ['docs', ['docs', 'doc', 'documentation', 'notes', 'supplementary', 'supplement']],
    ['tests', ['tests', 'test']],
    ['references', ['refs', 'references', 'bib', 'bibliography', 'bibs', 'literature']],
    ['excluded', ['node_modules', '.venv', 'venv', '__pycache__', 'build', 'dist', 'target', '.cache']],
    ['muted', ['.git', '.texypaper', '.paperdock', '.vscode', '.idea', '.github']],
    ['default', ['research', 'main.tex', 'constructor', '__proto__', '']],
  ] as const)('maps %s folders, case-insensitively, with a distinct open variant', (id, names) => {
    for (const name of names) {
      expect(fileIconId('directory', name)).toBe(`folder-${id}`);
      expect(fileIconId('directory', name.toUpperCase(), false)).toBe(`folder-${id}`);
      expect(fileIconId('directory', name, true)).toBe(`folder-${id}-open`);
    }
  });

  it('does not infer paper discovery evidence from a regular directory name', () => {
    expect(fileIconId('directory', 'my-research')).toBe('folder-default');
    expect(fileIconId('directory', 'paper-direct')).toBe('folder-default');
    expect(fileIconId('file', 'figures')).toBe('file-unknown');
    expect(fileIconId('file', '.git')).toBe('file-git');
    expect(fileIconId('directory', '.git')).toBe('folder-muted');
  });
});
