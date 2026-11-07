import { memo } from 'react';
import './fileIcons.css';

type FileKind = 'file' | 'directory' | 'symlink';
type FileIcon = 'tex' | 'bib' | 'latex' | 'pdf' | 'image' | 'python' | 'javascript' | 'typescript' | 'react' | 'rust' | 'json' | 'config' | 'markdown' | 'table' | 'text' | 'archive' | 'terminal' | 'binary' | 'build' | 'git' | 'env' | 'info' | 'license' | 'unknown';
type FolderIcon = 'default' | 'figures' | 'code' | 'results' | 'sections' | 'paper' | 'docs' | 'tests' | 'references' | 'excluded' | 'muted';

const extensions: Readonly<Record<string, FileIcon | undefined>> = {
  tex: 'tex', ltx: 'tex', bib: 'bib', bst: 'bib',
  sty: 'latex', cls: 'latex', bbx: 'latex', cbx: 'latex', dtx: 'latex', ins: 'latex',
  pdf: 'pdf', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', eps: 'image',
  py: 'python', js: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'react', jsx: 'react', rs: 'rust', json: 'json',
  toml: 'config', yaml: 'config', yml: 'config', md: 'markdown', csv: 'table', tsv: 'table', xlsx: 'table', txt: 'text', log: 'text',
  zip: 'archive', gz: 'archive', tar: 'archive', '7z': 'archive', sh: 'terminal', ps1: 'terminal', bat: 'terminal',
  exe: 'binary', dll: 'binary', so: 'binary',
  aux: 'build', toc: 'build', out: 'build', synctex: 'build', fls: 'build', fdb_latexmk: 'build', bbl: 'build', blg: 'build',
};
const folders: Readonly<Record<string, FolderIcon | undefined>> = {
  figures: 'figures', figure: 'figures', images: 'figures', img: 'figures', assets: 'figures', pics: 'figures',
  plots: 'figures', plot: 'figures', graphics: 'figures', pictures: 'figures', photos: 'figures', media: 'figures',
  code: 'code', src: 'code', scripts: 'code', lib: 'code', utils: 'code', tools: 'code', notebooks: 'code',
  results: 'results', data: 'results', output: 'results', outputs: 'results', out: 'results', tables: 'results', experiments: 'results', runs: 'results',
  sections: 'sections', chapters: 'sections', chapter: 'sections', parts: 'sections', appendix: 'sections', appendices: 'sections', content: 'sections',
  paper: 'paper', papers: 'paper', manuscript: 'paper', draft: 'paper', tex: 'paper', latex: 'paper',
  docs: 'docs', doc: 'docs', documentation: 'docs', notes: 'docs', supplementary: 'docs', supplement: 'docs', tests: 'tests', test: 'tests',
  refs: 'references', references: 'references', bib: 'references', bibliography: 'references', bibs: 'references', literature: 'references',
  node_modules: 'excluded', '.venv': 'excluded', venv: 'excluded', __pycache__: 'excluded', build: 'excluded', dist: 'excluded', target: 'excluded', '.cache': 'excluded',
  '.git': 'muted', '.texypaper': 'muted', '.paperdock': 'muted', '.vscode': 'muted', '.idea': 'muted', '.github': 'muted',
};

function basename(name: string): string {
  return name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).toLowerCase();
}
function fileType(name: string): FileIcon {
  if (name.startsWith('.git')) return 'git';
  if (name.startsWith('.env')) return 'env';
  if (name.startsWith('readme')) return 'info';
  if (name.startsWith('license')) return 'license';
  if (name === 'latexmkrc' || name === '.latexmkrc' || name === 'makefile') return 'config';
  if (name.endsWith('.synctex.gz')) return 'build';
  const dot = name.lastIndexOf('.');
  return dot >= 0 && Object.hasOwn(extensions, name.slice(dot + 1)) ? extensions[name.slice(dot + 1)]! : 'unknown';
}

/** Stable, filename-only classification; paper discovery evidence never changes an icon. */
export function fileIconId(kind: FileKind, name: string, open = false): string {
  const lower = basename(name);
  if (kind === 'directory') return `folder-${Object.hasOwn(folders, lower) ? folders[lower] : 'default'}${open ? '-open' : ''}`;
  return `file-${fileType(lower)}${kind === 'symlink' ? '-symlink' : ''}`;
}

// Original 8×8 marks, drawn for this icon family rather than taken from an icon set.
function Mark({ type }: { type: FileIcon | 'check' | 'chart' | 'book' | 'code' }) {
  switch (type) {
    case 'tex': return <path d="M.8 1.5h4.4M3 1.5v5M1.7 6.5h2.6M5 4h2M5 4v2.5h2M5 5.3h1.5" />;
    case 'bib': return <path d="M1 2h2v2H1l1 2M5 2h2v2H5l1 2" />;
    case 'latex': return <><path d="M2 1.5H1v5h1M6 1.5h1v5H6" /><rect x="3" y="3" width="2" height="2" rx=".3" fill="currentColor" stroke="none" /></>;
    case 'pdf': return <path d="M1 6.5c2-1 3.5-4.7 3-5.3-.8-.9-1 3.8 2 4.4 2 .4 1.8-1.1.3-1.1C3.4 4.5.2 7.6 1 6.5Z" />;
    case 'image': return <><rect x=".7" y="1" width="6.6" height="6" rx=".8" /><path d="m1 6 2-2 1.5 1 1.2-1L7 6" /><circle cx="5.5" cy="2.7" r=".65" fill="currentColor" stroke="none" /></>;
    case 'python': return <><path d="M1 4V2.8c0-.8.7-1.3 1.5-1.3H5V4H3v1H1Z" fill="#73bbef" stroke="none" /><path d="M7 4v1.2c0 .8-.7 1.3-1.5 1.3H3V4h2V3h2Z" fill="#ffdb69" stroke="none" /><path d="M3.7 2.4h.1M4.2 5.6h.1" stroke="#243f5c" /></>;
    case 'javascript': return <path d="M1 5.2c0 2 2 1.8 2 0V2M7 2H5v2h2v2H5" />;
    case 'typescript': return <path d="M.5 2h3M2 2v4.5M7 2H5v2h2v2H5" />;
    case 'react': return <><ellipse cx="4" cy="4" rx="3.5" ry="1.4" /><ellipse cx="4" cy="4" rx="3.5" ry="1.4" transform="rotate(60 4 4)" /><ellipse cx="4" cy="4" rx="3.5" ry="1.4" transform="rotate(120 4 4)" /><circle cx="4" cy="4" r=".65" fill="currentColor" stroke="none" /></>;
    case 'rust': return <><path d="M2 6.5v-5h2a1.4 1.4 0 0 1 0 2.8H2M4 4.3l2 2.2M1 6.5h2M5.5 6.5h1" /></>;
    case 'json': return <path d="M2.5 1H2v2L1 4l1 1v2h.5M5.5 1H6v2l1 1-1 1v2h-.5" />;
    case 'config':
    case 'binary': return <><path d="m3 1 .3-.5h1.4L5 1l.8.5h.7l.7 1.2-.4.8V4l.4.8-.7 1.2h-.7L5 6.5l-.3.8H3.3L3 6.5 2.2 6h-.7L.8 4.8l.4-.8v-.5L.8 2.7l.7-1.2h.7Z" /><circle cx="4" cy="3.9" r="1.1" /></>;
    case 'markdown': return <path d="M.5 6V2l1.8 2L4 2v4M6.5 2v4M5.3 4.8 6.5 6l1.2-1.2" />;
    case 'table': return <><rect x=".7" y="1" width="6.6" height="6" rx=".6" /><path d="M1 3h6M1 5h6M3.3 3v4" /></>;
    case 'archive': return <><path d="M3 0h1M4 1.2h1M3 2.4h1M4 3.6h1" /><rect x="3" y="5" width="2" height="2" rx=".5" /></>;
    case 'terminal': return <path d="m1 2 2 2-2 2M4.5 6H7" />;
    case 'git': return <><path d="m4 .5 3.5 3.5L4 7.5.5 4Z" fill="currentColor" stroke="none" /><path d="M2.5 2.5 5 5M4 4v2" stroke="var(--file-icon-fill)" /><circle cx="2.5" cy="2.5" r=".6" fill="var(--file-icon-fill)" stroke="none" /></>;
    case 'env': return <><circle cx="2.5" cy="3" r="1.7" /><path d="m3.7 4.2 2.8 2.3M5.1 5.3l1-1M6.1 6.2l1-1" /></>;
    case 'info': return <><circle cx="4" cy="4" r="3" /><path d="M4 3.8V6M4 2.2h.01" /></>;
    case 'license': return <><circle cx="4" cy="3" r="2" /><path d="m2.5 4.5-.7 2.8L4 6l2.2 1.3-.7-2.8" /></>;
    case 'check': return <path d="m1 4 2 2 4-4" />;
    case 'chart': return <path d="M1 1v6h6M3 5V4M5 5V2M7 5V.8" />;
    case 'book': return <><path d="M4 2C3 1.3 1.8 1.2.5 1.5v5C2 6.2 3 6.3 4 7c1-.7 2-1 3.5-.5v-5C6.2 1.2 5 1.3 4 2ZM4 2v5" /></>;
    case 'code': return <path d="m2.5 1.5-2 2.5 2 2.5M5.5 1.5l2 2.5-2 2.5" />;
    case 'text':
    case 'build': return <path d="M1 2h6M1 4h6M1 6h4" />;
    case 'unknown': return <path d="M1 3h6M1 5h4" />;
  }
}

// Folders follow the usual name-driven convention: a role color, plus a small glyph on the front for known names.
// Unknown names stay a neutral blue-gray folder; excluded and tool folders keep it and are dimmed in CSS.
const folderMarks: Readonly<Partial<Record<FolderIcon, FileIcon | 'check' | 'chart' | 'book' | 'code'>>> = {
  figures: 'image', code: 'code', results: 'chart', sections: 'text', paper: 'tex', docs: 'book', tests: 'check', references: 'bib',
};

function FolderArtwork({ type, open }: { type: FolderIcon; open: boolean }) {
  const mark = folderMarks[type];
  return <>
    <path className="file-icon-tab" d="M1 4V3a1 1 0 0 1 1-1h3.6L7 3.5h6a1 1 0 0 1 1 1V12H1Z" fill="var(--folder-back)" stroke="var(--folder-edge)" strokeWidth=".55" />
    {open && <path className="file-icon-sheet" d="M2 5h11v6H2Z" fill="#fff" fillOpacity=".75" />}
    <path className="file-icon-body" d={open ? 'M2.5 5.5h12a.7.7 0 0 1 .7.9L13.7 13H1.5L.8 6.6a1 1 0 0 1 1-1.1Z' : 'M1 4.5h5L7.3 6H14v6a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1Z'} fill="var(--folder-front)" stroke="var(--folder-edge)" strokeWidth=".55" />
    {mark && <g className="file-icon-mark" transform={`translate(${open ? 5.1 : 4.7} 7) scale(.7)`} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><Mark type={mark} /></g>}
  </>;
}

export const FileTypeIcon = memo(function FileTypeIcon({ kind, name, open = false, size = 16, className = '' }: {
  kind: FileKind; name: string; open?: boolean; size?: number; className?: string;
}) {
  const lower = basename(name);
  const type = kind === 'directory' ? (Object.hasOwn(folders, lower) ? folders[lower]! : 'default') : fileType(lower);
  return <svg className={`file-type-icon file-icon--${type}${kind === 'directory' ? ' file-icon--folder' : ''} ${className}`} data-icon={fileIconId(kind, name, open)} viewBox="0 0 16 16" width={`${size / 16}rem`} height={`${size / 16}rem`} aria-hidden="true" focusable="false">
    {kind === 'directory' ? <FolderArtwork type={type as FolderIcon} open={open} /> : <>
      <path className="file-icon-body" d="M4 1.5h5.2L13 5.3v8.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" fill="var(--file-icon-fill)" stroke="var(--file-icon-edge)" strokeWidth=".65" />
      <path className="file-icon-fold" d="M9 1.6v3.1a.7.7 0 0 0 .7.7h3.1" fill="#fff" fillOpacity=".32" stroke="var(--file-icon-edge)" strokeWidth=".55" />
      <g className="file-icon-mark" transform="translate(4 6)" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><Mark type={type as FileIcon} /></g>
    </>}
    {kind === 'symlink' && <g className="file-icon-link"><rect x=".5" y="9.5" width="6" height="6" rx="1.2" fill="var(--surface)" stroke="var(--secondary)" strokeWidth=".6" /><path d="M2 13.5v-2h2.5M3 10.5l1.5 1-1.5 1" fill="none" stroke="var(--text)" strokeWidth=".9" strokeLinecap="round" strokeLinejoin="round" /></g>}
  </svg>;
});
