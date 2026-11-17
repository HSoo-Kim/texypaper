import { indexBibTeX, isSafeCitationKey } from './bibtex';
import type { PaperCorpus, PaperSource } from './types';

export type PreflightIssue = {
  path: string; line: number; code: 'todo' | 'missing-citation' | 'missing-label' | 'duplicate-key' | 'duplicate-label' | 'missing-file' | 'bib-syntax' | 'coverage';
  detail: string;
};
export type PreflightResult = {
  issues: PreflightIssue[]; complete: boolean; texFiles: string[]; bibFiles: string[];
  citationCount: number; referenceCount: number;
};
type Command = { name: string; offset: number; line: number; args: string[]; optional: string[] };
type Scan = { commands: Command[]; issues: PreflightIssue[]; uncertain: boolean };
type Location = { path: string; line: number };
function skipTrivia(text: string, start: number): number {
  let offset = start;
  while (offset < text.length) {
    if (/\s/.test(text[offset])) { offset++; continue; }
    if (text[offset] !== '%') break;
    while (offset < text.length && !/[\r\n]/.test(text[offset])) offset++;
  }
  return offset;
}
const verbatimEnvironments: Readonly<Record<string, true | undefined>> = { verbatim: true, 'verbatim*': true, Verbatim: true, BVerbatim: true, LVerbatim: true, lstlisting: true, minted: true, comment: true, filecontents: true, 'filecontents*': true };
const citations: Readonly<Record<string, true | undefined>> = { cite: true, citet: true, citep: true, citealt: true, citealp: true, citeauthor: true, citeyear: true, citeyearpar: true, autocite: true, parencite: true, textcite: true, footcite: true, smartcite: true, supercite: true, fullcite: true, footfullcite: true, notecite: true, nocite: true, cites: true, parencites: true, textcites: true, autocites: true, footcites: true, smartcites: true, supercites: true };
const references: Readonly<Record<string, true | undefined>> = { ref: true, eqref: true, autoref: true, cref: true, cpageref: true, pageref: true, vref: true, nameref: true, labelcref: true };
const relevant: Readonly<Record<string, true | undefined>> = { ...citations, ...references, label: true, bibitem: true, bibliography: true, addbibresource: true, input: true, include: true, subfile: true, includeonly: true, import: true, subimport: true, todo: true, externaldocument: true };
const definitions: Readonly<Record<string, true | undefined>> = { newcommand: true, renewcommand: true, providecommand: true, DeclareRobustCommand: true, DeclareMathOperator: true, def: true, gdef: true, edef: true, xdef: true, newenvironment: true, renewenvironment: true, NewDocumentCommand: true, RenewDocumentCommand: true, ProvideDocumentCommand: true, DeclareDocumentCommand: true };
function group(text: string, start: number, open: '{' | '[', comments = true): { value: string; end: number } | null {
  if (text[start] !== open) return null;
  const close = open === '{' ? '}' : ']'; let depth = 1, braces = 0;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (comments && text[i] === '%') { while (i < text.length && !/[\r\n]/.test(text[i])) i++; continue; }
    if (open === '[') {
      if (text[i] === '{') { braces++; continue; }
      if (text[i] === '}' && braces) { braces--; continue; }
      if (braces) continue;
    }
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return { value: text.slice(start + 1, i), end: i + 1 };
  }
  return null;
}
function scanTex(source: PaperSource): Scan {
  const { path, text } = source;
  const result: Scan = { commands: [], issues: [], uncertain: false };
  const masked = text.split('');
  const erase = (from: number, to: number) => { for (let i = from; i < to; i++) if (text[i] !== '\r' && text[i] !== '\n') masked[i] = ' '; };
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n' || (text[i] === '\r' && text[i + 1] !== '\n')) lineStarts.push(i + 1);
  const lineAt = (offset: number) => { let low = 0, high = lineStarts.length; while (low + 1 < high) { const mid = (low + high) >>> 1; if (lineStarts[mid] <= offset) low = mid; else high = mid; } return low + 1; };
  const uncertainty = (offset: number, detail: string) => {
    result.uncertain = true; result.issues.push({ path, line: lineAt(offset), code: 'coverage', detail });
  };
  const commentEnd = (offset: number) => {
    let end = offset; while (end < text.length && !/[\r\n]/.test(text[end])) end++;
    const marker = /\b(?:TODO|FIXME|XXX)\b/i.exec(text.slice(offset, end));
    if (marker) result.issues.push({ path, line: lineAt(offset), code: 'todo', detail: text.slice(offset + marker.index, end).trim() });
    return end;
  };
  // Mask in source order so percent signs inside literal environments/\verb are
  // not mistaken for comments, and escaped percent signs remain active prose.
  for (let i = 0; i < text.length;) {
    if (text[i] === '%') {
      const end = commentEnd(i); erase(i, end); i = end; continue;
    }
    if (text[i] !== '\\') { i++; continue; }
    const start = i;
    const nameMatch = /^\\([A-Za-z@]+|.)/.exec(text.slice(i));
    if (!nameMatch) { i++; continue; }
    const name = nameMatch[1]; i += nameMatch[0].length;
    if (name === 'verb' || name === 'lstinline' || name === 'mintinline') {
      if (text[i] === '*') i++;
      while (/\s/.test(text[i] ?? '') && i < text.length) i++;
      if (text[i] === '[') { const option = group(text, i, '['); if (option) i = option.end; }
      if (name === 'mintinline') { while (/\s/.test(text[i] ?? '') && i < text.length) i++; const language = group(text, i, '{'); if (language) i = language.end; }
      while (/\s/.test(text[i] ?? '') && i < text.length) i++;
      const delimiter = text[i];
      if (delimiter === '{' && name !== 'verb') {
        const body = group(text, i, '{', false); if (body) { i = body.end; erase(start, i); continue; }
      }
      const end = delimiter && !/[\r\n]/.test(delimiter) ? text.indexOf(delimiter, i + 1) : -1;
      const lineEnd = text.slice(i).search(/[\r\n]/);
      if (end < 0 || (lineEnd >= 0 && end > i + lineEnd)) {
        uncertainty(start, 'unclosed-verbatim'); i = lineEnd < 0 ? text.length : i + lineEnd;
      } else i = end + 1;
      erase(start, i); continue;
    }
    if (name === 'begin') {
      const position = skipTrivia(text, i);
      const environment = group(text, position, '{');
      if (environment && verbatimEnvironments[environment.value] === true) {
        const ending = `\\end{${environment.value}}`, end = text.indexOf(ending, environment.end);
        if (end < 0) { uncertainty(start, 'unclosed-verbatim'); erase(start, text.length); i = text.length; }
        else { i = end + ending.length; erase(start, i); }
        continue;
      }
    }
    if (name === 'end' && group(text, skipTrivia(text, i), '{')?.value === 'document') {
      erase(start, text.length); break;
    }
    if (name === 'iffalse') {
      // Preserve a top-level else branch: it executes when \\iffalse is false.
      let depth = 1, end = i, elseEnd = -1, fiStart = -1;
      const condition = /\\([A-Za-z@]+|.)|%[^\r\n]*/g; condition.lastIndex = i;
      let match: RegExpExecArray | null;
      while ((match = condition.exec(text))) {
        if (!match[1]) continue;
        if (match[1] === 'fi') depth--;
        else if (/^if/.test(match[1])) depth++;
        else if (match[1] === 'else' && depth === 1) elseEnd = condition.lastIndex;
        if (!depth) { fiStart = match.index; end = condition.lastIndex; break; }
      }
      if (depth) { uncertainty(start, 'unclosed-conditional'); end = text.length; }
      if (elseEnd >= 0 && fiStart >= 0) { erase(start, elseEnd); erase(fiStart, end); i = elseEnd; }
      else { erase(start, end); i = end; }
      continue;
    }
    if (definitions[name] === true) {
      // Macro bodies contain templates (#1), not executed citations/labels.
      let position = skipTrivia(text, i);
      if (text[position] === '*') position++;
      position = skipTrivia(text, position);
      if (text[position] === '{') { const target = group(text, position, '{'); if (target) position = target.end; }
      else if (text[position] === '\\') { const target = /^\\(?:[A-Za-z@]+|.)/.exec(text.slice(position)); if (target) position += target[0].length; }
      // Parameter text for primitive \def precedes the body.
      if (['def', 'gdef', 'edef', 'xdef'].includes(name)) while (position < text.length && text[position] !== '{' && !/[\r\n]/.test(text[position])) position++;
      let bodyCount = /environment$/.test(name) ? 2 : /DocumentCommand$/.test(name) ? 2 : 1;
      let end = position;
      while (bodyCount > 0) {
        end = skipTrivia(text, end);
        if (text[end] === '[') { const option = group(text, end, '['); if (!option) break; end = option.end; continue; }
        const body = group(text, end, '{'); if (!body) break;
        end = body.end; bodyCount--;
      }
      if (bodyCount) uncertainty(start, 'unparsed-macro-definition');
      else if (/\\(?:[A-Za-z]*cite[A-Za-z]*|ref|eqref|autoref|[cC]ref|label|bibitem|input|include|bibliography|addbibresource)\b/.test(text.slice(position, end))) uncertainty(start, 'macro-generated-references');
      for (let offset = start; offset < end; offset++) {
        if (text[offset] === '\\') { offset++; continue; }
        if (text[offset] === '%') offset = commentEnd(offset);
      }
      erase(start, end); i = Math.max(i, end); continue;
    }
    if (/^if/.test(name) || ['else', 'or', 'fi', 'catcode', 'csname', 'usepackage', 'RequirePackage'].includes(name)) {
      // Packages are normal; their expansion is covered by the permanent UI
      // disclaimer. Source conditionals/catcode changes need a local warning.
      if (!['usepackage', 'RequirePackage', 'else', 'or', 'fi'].includes(name)) uncertainty(start, 'conditional-or-dynamic-tex');
    }
  }
  const active = masked.join('');
  const matcher = /\\([A-Za-z@]+|.)/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(active))) {
    const name = match[1], lower = name.toLowerCase();
    if (relevant[name] !== true && relevant[lower] !== true) continue;
    let position = matcher.lastIndex; if (active[position] === '*') position++;
    const args: string[] = [], optional: string[] = [];
    for (let count = 0; count < 100; count++) {
      while (/\s/.test(active[position] ?? '') && position < active.length) position++;
      const open = active[position]; if (open !== '{' && open !== '[') break;
      const value = group(active, position, open);
      if (!value) { uncertainty(match.index, 'unclosed-command-argument'); break; }
      (open === '[' ? optional : args).push(value.value); position = value.end;
      // Only multicite and import commands need more than one required group.
      if (open === '{' && !lower.endsWith('cites') && lower !== 'cites' && lower !== 'import' && lower !== 'subimport') break;
      if ((lower === 'import' || lower === 'subimport') && args.length === 2) break;
    }
    if ((lower === 'input' || lower === 'include') && !args.length) {
      const bare = /^[^\S\r\n]*([^\s%{}\\]+)/.exec(active.slice(position));
      if (bare) { args.push(bare[1]); position += bare[0].length; }
    }
    result.commands.push({ name: lower, offset: match.index, line: lineAt(match.index), args, optional });
    // Do not skip ordinary argument contents: \ref in prose formatting is
    // active. Citation arguments themselves cannot contain active commands.
    if (citations[lower] === true || references[lower] === true || ['label', 'bibitem', 'bibliography', 'addbibresource', 'input', 'include', 'subfile', 'includeonly', 'import', 'subimport'].includes(lower)) matcher.lastIndex = position;
  }
  return result;
}
function normalized(path: string): string | null {
  if (/^(?:[\\/]|[A-Za-z]:)|[\0\\]|:/.test(path)) return null;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
const directory = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
const literalPath = (value: string) => !!value.trim() && !/^[\\/]|[\\{}#$%~:\0]/.test(value.trim());

/** A deliberately static source check, not a TeX engine or bibliography validator. */
export function analyzePreflight(corpus: PaperCorpus, rootTex: string | null): PreflightResult {
  const report: PreflightResult = { issues: [], complete: corpus.complete && corpus.skipped.length === 0, texFiles: [], bibFiles: [], citationCount: 0, referenceCount: 0 };
  const files = new Map(corpus.files.map(file => [file.path.replaceAll('\\', '/'), file]));
  const scans = new Map<string, Scan>();
  const root = rootTex ? normalized(rootTex.replaceAll('\\', '/')) : null;
  const fallback = rootTex ?? corpus.files.find(file => /\.(?:tex|ltx)$/i.test(file.path))?.path ?? '';
  const coverage = (location: Location, detail: string) => { report.complete = false; report.issues.push({ ...location, code: 'coverage', detail }); };
  const resolve = (from: string, target: string, extension: string): { path: string | null; fallback: boolean } => {
    const bases = [...new Set([directory(root ?? from), directory(from)])];
    for (let i = 0; i < bases.length; i++) {
      const candidate = normalized(bases[i] + target.trim()); if (candidate === null) continue;
      for (const path of candidate.toLowerCase().endsWith(extension) ? [candidate] : [candidate, candidate + extension]) if (files.has(path)) return { path, fallback: i > 0 };
    }
    return { path: null, fallback: false };
  };
  const bibliography = new Set<string>();
  const scan = (path: string) => {
    const cached = scans.get(path); if (cached) return cached;
    const file = files.get(path); if (!file) return undefined;
    const value = scanTex(file); scans.set(path, value); report.texFiles.push(file.path);
    report.issues.push(...value.issues); if (value.uncertain) report.complete = false;
    return value;
  };
  let includeOnly: Set<string> | null = null;
  if (root && files.has(root)) {
    const rootScan = scan(root);
    const only = rootScan?.commands.filter(command => command.name === 'includeonly').at(-1);
    if (only?.args[0] !== undefined) {
      includeOnly = new Set(only.args[0].split(',').map(value => value.trim().replace(/\.tex$/i, '')));
      coverage({ path: root, line: only.line }, 'includeonly-active');
    }
  }
  const visit = (path: string) => {
    const value = scan(path); if (!value) return;
    if (visited.has(path)) return; visited.add(path); activeInputs.add(path);
    for (const command of value.commands) {
      const location = { path, line: command.line };
      if (['input', 'include', 'subfile', 'import', 'subimport'].includes(command.name)) {
        const target = command.name.endsWith('import') ? (command.args.length === 2 ? command.args[0] + command.args[1] : '') : command.args[0] ?? '';
        if (includeOnly && command.name === 'include' && !includeOnly.has(target.replace(/\.tex$/i, ''))) continue;
        if (!literalPath(target)) { coverage(location, 'dynamic-input'); continue; }
        const resolved = resolve(path, target, '.tex');
        if (!resolved.path) { report.issues.push({ ...location, code: 'missing-file', detail: target }); report.complete = false; }
        else {
          if (resolved.fallback || command.name === 'subimport') coverage(location, 'input-search-path-assumption');
          if (activeInputs.has(resolved.path)) coverage(location, 'cyclic-input');
          else if (visited.has(resolved.path)) coverage(location, 'repeated-input');
          else visit(resolved.path);
        }
      }
      if (command.name === 'bibliography' || command.name === 'addbibresource') {
        const targets = command.name === 'bibliography' ? (command.args[0] ?? '').split(',') : [command.args[0] ?? ''];
        for (const target of targets) {
          if (!literalPath(target)) { coverage(location, 'dynamic-bibliography'); continue; }
          const resolved = resolve(path, target, '.bib');
          if (!resolved.path) { report.issues.push({ ...location, code: 'missing-file', detail: target }); report.complete = false; }
          else { bibliography.add(resolved.path); if (resolved.fallback) coverage(location, 'bibliography-search-path-assumption'); }
        }
      }
      if (command.name === 'externaldocument') coverage(location, 'external-document-labels');
    }
    activeInputs.delete(path);
  };
  const visited = new Set<string>(), activeInputs = new Set<string>();
  if (root && files.has(root)) visit(root);
  else if (rootTex) { report.issues.push({ path: rootTex, line: 1, code: 'missing-file', detail: rootTex }); report.complete = false; }
  else {
    coverage({ path: fallback, line: 1 }, 'no-root-selected');
    for (const file of corpus.files) if (/\.(?:tex|ltx)$/i.test(file.path)) visit(file.path.replaceAll('\\', '/'));
  }
  if (!report.texFiles.length) coverage({ path: fallback, line: 1 }, 'no-tex-source');
  report.bibFiles = [...bibliography];
  const bib = indexBibTeX({ files: report.bibFiles.map(path => files.get(path)!), skipped: [], complete: true });
  if (!bib.complete) report.complete = false;
  for (const issue of bib.diagnostics) report.issues.push({ path: issue.path, line: issue.line, code: issue.code === 'duplicate' ? 'duplicate-key' : 'bib-syntax', detail: issue.detail });
  const keys = new Map<string, Location[]>(), labels = new Map<string, Location[]>();
  const add = (map: Map<string, Location[]>, key: string, location: Location) => { const matches = map.get(key) ?? []; matches.push(location); map.set(key, matches); };
  for (const entry of bib.entries) if (entry.valid) add(keys, entry.key, { path: entry.path, line: entry.line });
  const uses: { key: string; location: Location; citation: boolean }[] = [];
  for (const [path, value] of scans) for (const command of value.commands) {
    const location = { path, line: command.line };
    if (command.name === 'todo') report.issues.push({ ...location, code: 'todo', detail: command.args[0]?.trim() || '\\todo' });
    if (command.name === 'bibitem' || command.name === 'label') {
      const key = command.args[0]?.trim();
      if (!key || !isSafeCitationKey(key)) { coverage(location, 'dynamic-definition-key'); continue; }
      add(command.name === 'label' ? labels : keys, key, location);
    }
    if (citations[command.name] !== true && references[command.name] !== true) continue;
    const citation = citations[command.name] === true;
    if (!command.args.length) { coverage(location, 'unparsed-reference-command'); continue; }
    for (const argument of command.args) for (const part of argument.split(',')) {
      const key = part.trim(); if (key === '*' && command.name === 'nocite') continue;
      if (!key || !isSafeCitationKey(key)) { coverage(location, 'dynamic-reference-key'); continue; }
      uses.push({ key, location, citation });
      if (citation) report.citationCount++; else report.referenceCount++;
    }
  }
  for (const [map, code] of [[keys, 'duplicate-key'], [labels, 'duplicate-label']] as const) {
    // BibTeX treats case variants as ambiguous too; labels remain case-sensitive.
    const groups = new Map<string, Location[]>();
    for (const [key, locations] of map) {
      const folded = map === keys ? key.toLowerCase() : key;
      groups.set(folded, [...(groups.get(folded) ?? []), ...locations]);
    }
    for (const [key, locations] of groups) if (locations.length > 1) for (const location of locations) {
      if (!report.issues.some(issue => issue.code === code && issue.path === location.path && issue.line === location.line)) report.issues.push({ ...location, code, detail: key });
    }
  }
  const foldedCitationKeys = new Set([...keys.keys()].map(key => key.toLowerCase()));
  for (const use of uses) {
    const known = use.citation ? keys : labels;
    if (known.has(use.key)) continue;
    if (use.citation && foldedCitationKeys.has(use.key.toLowerCase())) { coverage(use.location, `citation-key-case:${use.key}`); continue; }
    report.issues.push({ ...use.location, code: use.citation ? 'missing-citation' : 'missing-label', detail: use.key });
  }
  // Corpus omissions remain visible even when the loaded root itself parses.
  for (const skipped of corpus.skipped) coverage({ path: skipped.path, line: 1 }, `skipped:${skipped.reason}`);
  if (!corpus.complete && !corpus.skipped.length) coverage({ path: fallback, line: 1 }, 'incomplete-corpus');
  report.issues.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.code.localeCompare(b.code));
  return report;
}
