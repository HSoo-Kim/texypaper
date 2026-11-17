import type { PaperCorpus, PaperSource } from './types';

export type BibDiagnostic = { path: string; line: number; code: 'malformed' | 'unknown-string' | 'duplicate' | 'unsafe-key'; detail: string };
export type BibEntry = {
  path: string; line: number; type: string; key: string;
  fields: Record<string, string>; valid: boolean; duplicate: boolean; safeKey: boolean;
};
export type BibIndex = { entries: BibEntry[]; diagnostics: BibDiagnostic[]; complete: boolean };
type Atom = { literal: string } | { name: string };
type Expression = Atom[];
type PendingEntry = { entry: BibEntry; fields: Map<string, Expression> };
type Definition = { value: Expression; path: string; line: number };
const months: Record<string, string> = { jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June', jul: 'July', aug: 'August', sep: 'September', oct: 'October', nov: 'November', dec: 'December' };
export const isSafeCitationKey = (key: string) => /^[A-Za-z0-9][A-Za-z0-9_.:+/\-]*$/.test(key);

/** Literal metadata only: no TeX evaluation and no network lookups. */
export function parseBibTeX(text: string, path = ''): BibIndex {
  return parseSources([{ text, path }]);
}
export function indexBibTeX(corpus: PaperCorpus): BibIndex {
  // String definitions are database-local. Do not silently resolve a name from an
  // unrelated .bib file that the eventual root might never load.
  const results = corpus.files.filter(file => /\.bib$/i.test(file.path)).map(file => parseSources([file]));
  const result: BibIndex = {
    entries: results.flatMap(item => item.entries), diagnostics: results.flatMap(item => item.diagnostics),
    complete: corpus.complete && corpus.skipped.length === 0 && results.every(item => item.complete),
  };
  markDuplicates(result);
  return result;
}
function markDuplicates(result: BibIndex) {
  const byKey = new Map<string, BibEntry[]>();
  for (const entry of result.entries) {
    if (!entry.key) continue;
    const normalized = entry.key.toLowerCase();
    const matches = byKey.get(normalized) ?? [];
    matches.push(entry); byKey.set(normalized, matches);
  }
  for (const entries of byKey.values()) if (entries.length > 1) for (const entry of entries) {
    entry.duplicate = true;
    if (!result.diagnostics.some(issue => issue.code === 'duplicate' && issue.path === entry.path && issue.line === entry.line)) {
      result.diagnostics.push({ path: entry.path, line: entry.line, code: 'duplicate', detail: entry.key });
    }
  }
}
function parseSources(sources: PaperSource[]): BibIndex {
  const result: BibIndex = { entries: [], diagnostics: [], complete: true };
  const definitions = new Map<string, Definition>();
  const pending: PendingEntry[] = [];
  const preambles: Definition[] = [];
  for (const { text, path } of sources) {
    let cursor = 0;
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n' || (text[i] === '\r' && text[i + 1] !== '\n')) lineStarts.push(i + 1);
    const lineAt = (offset: number) => {
      let low = 0, high = lineStarts.length;
      while (low + 1 < high) { const mid = (low + high) >>> 1; if (lineStarts[mid] <= offset) low = mid; else high = mid; }
      return low + 1;
    };
    const issue = (offset: number, detail: string, code: BibDiagnostic['code'] = 'malformed') => {
      result.diagnostics.push({ path, line: lineAt(offset), code, detail });
      if (code === 'malformed' || code === 'unknown-string') result.complete = false;
    };
    const skip = () => {
      while (cursor < text.length) {
        if (/\s/.test(text[cursor])) { cursor++; continue; }
        if (text[cursor] === '%') { while (cursor < text.length && !/[\r\n]/.test(text[cursor])) cursor++; continue; }
        break;
      }
    };
    const literal = (open: '{' | '"'): string => {
      cursor++;
      let depth = open === '{' ? 1 : 0;
      let value = '';
      while (cursor < text.length) {
        const char = text[cursor++];
        if (char === '\\') { value += char; if (cursor < text.length) value += text[cursor++]; continue; }
        if (char === '{') { depth++; value += char; continue; }
        if (char === '}') {
          if (depth === 0) throw new Error('Unexpected closing brace in quoted value');
          depth--; if (open === '{' && depth === 0) return value;
          value += char; continue;
        }
        if (char === '"' && open === '"' && depth === 0) return value;
        value += char;
      }
      throw new Error('Unclosed field value');
    };
    const expression = (): Expression => {
      const atoms: Expression = [];
      while (true) {
        skip(); const char = text[cursor];
        if (char === '{' || char === '"') atoms.push({ literal: literal(char) });
        else {
          const token = /^[A-Za-z0-9_:.+\-/]+/.exec(text.slice(cursor));
          if (!token) throw new Error('Expected a braced, quoted, numeric or string value');
          cursor += token[0].length;
          atoms.push(/^\d+$/.test(token[0]) ? { literal: token[0] } : { name: token[0].toLowerCase() });
        }
        skip(); if (text[cursor] !== '#') break;
        cursor++;
      }
      return atoms;
    };
    const recover = (start: number) => {
      const next = /(?:^|[\r\n])[\t ]*@\s*[A-Za-z]+\s*[{(]/g;
      next.lastIndex = start + 1;
      const match = next.exec(text);
      cursor = match ? match.index + match[0].indexOf('@') : text.length;
    };
    while (cursor < text.length) {
      skip();
      // BibTeX permits ordinary text outside entries.
      if (text[cursor] !== '@') { cursor++; continue; }
      const start = cursor++;
      const typeMatch = /^[A-Za-z]+/.exec(text.slice(cursor));
      if (!typeMatch) { issue(start, 'Expected entry type after @'); continue; }
      const type = typeMatch[0].toLowerCase(); cursor += typeMatch[0].length; skip();
      const opener = text[cursor];
      if (type === 'comment' && opener !== '{' && opener !== '(') { recover(start); continue; }
      if (opener !== '{' && opener !== '(') { issue(start, 'Expected { or ( after entry type'); recover(start); continue; }
      const closer = opener === '{' ? '}' : ')'; cursor++;
      let entry: BibEntry | undefined;
      try {
        if (type === 'comment') {
          // @comment is opaque, not a database entry. Balance delimiters, but do
          // not interpret its prose as quoted field syntax.
          let depth = 1;
          while (cursor < text.length && depth) {
            const char = text[cursor++];
            if (char === '\\') { cursor++; continue; }
            if (char === opener) depth++;
            else if (char === closer) depth--;
          }
          if (depth) throw new Error('Unclosed @comment');
          continue;
        }
        if (type === 'preamble') {
          const value = expression(); skip(); if (text[cursor] === ',') { cursor++; skip(); }
          if (text[cursor++] !== closer) throw new Error('Expected closing delimiter after @preamble');
          preambles.push({ value, path, line: lineAt(start) }); continue;
        }
        if (type === 'string') {
          skip(); const name = /^[A-Za-z][A-Za-z0-9_:.+\-/]*/.exec(text.slice(cursor));
          if (!name) throw new Error('Expected @string name');
          cursor += name[0].length; skip(); if (text[cursor++] !== '=') throw new Error('Expected = after @string name');
          const value = expression(); skip(); if (text[cursor] === ',') { cursor++; skip(); }
          if (text[cursor++] !== closer) throw new Error('Expected closing delimiter after @string');
          const key = name[0].toLowerCase();
          if (definitions.has(key)) { issue(start, `Repeated @string definition: ${name[0]}`); }
          else definitions.set(key, { value, path, line: lineAt(start) });
          continue;
        }
        skip(); const keyStart = cursor;
        while (cursor < text.length && ![',', closer, '\r', '\n'].includes(text[cursor])) cursor++;
        const key = text.slice(keyStart, cursor).trim();
        entry = { path, line: lineAt(start), type, key, fields: {}, valid: true, duplicate: false, safeKey: isSafeCitationKey(key) };
        result.entries.push(entry);
        if (!entry.safeKey) issue(start, key || '(empty key)', 'unsafe-key');
        if (!key) throw new Error('Missing citation key');
        if (/[{}]/.test(key)) throw new Error('Unexpected brace in citation key');
        if (text[cursor] === closer) { cursor++; continue; }
        if (text[cursor++] !== ',') throw new Error('Expected comma after citation key');
        const fields = new Map<string, Expression>();
        pending.push({ entry, fields });
        while (true) {
          skip(); if (text[cursor] === closer) { cursor++; break; }
          const name = /^[A-Za-z][A-Za-z0-9_-]*/.exec(text.slice(cursor));
          if (!name) throw new Error('Expected field name or closing delimiter');
          cursor += name[0].length; skip();
          if (text[cursor++] !== '=') throw new Error(`Expected = after ${name[0]}`);
          const value = expression(), field = name[0].toLowerCase();
          if (fields.has(field)) throw new Error(`Repeated field: ${field}`);
          fields.set(field, value); skip();
          if (text[cursor] === closer) { cursor++; break; }
          if (text[cursor++] !== ',') throw new Error('Expected comma between fields');
        }
      } catch (error) {
        if (entry) entry.valid = false;
        issue(start, error instanceof Error ? error.message : 'Malformed entry'); recover(start);
      }
    }
  }
  const resolvedStrings = new Map<string, { text: string; unknown: string[] }>();
  const maxExpandedLength = 64 * 1024;
  const resolve = (value: Expression, visiting = new Set<string>()): { text: string; unknown: string[] } => {
    let text = ''; const unknown: string[] = [];
    for (const atom of value) {
      if ('literal' in atom) {
        if (text.length + atom.literal.length > maxExpandedLength) return { text: '', unknown: ['string expansion exceeds 64 KiB'] };
        text += atom.literal; continue;
      }
      const definition = definitions.get(atom.name);
      if (visiting.has(atom.name) || visiting.size >= 64) { unknown.push(atom.name); continue; }
      if (!definition) {
        if (Object.hasOwn(months, atom.name)) text += months[atom.name];
        else unknown.push(atom.name);
        continue;
      }
      const next = new Set(visiting); next.add(atom.name);
      const resolved = resolvedStrings.get(atom.name) ?? resolve(definition.value, next);
      resolvedStrings.set(atom.name, resolved);
      if (resolved.unknown.length) return { text: '', unknown: resolved.unknown };
      if (text.length + resolved.text.length > maxExpandedLength) return { text: '', unknown: ['string expansion exceeds 64 KiB'] };
      text += resolved.text;
    }
    return { text, unknown: [...new Set(unknown)] };
  };
  const reportUnknown = (value: Expression, path: string, line: number) => {
    const resolved = resolve(value);
    if (resolved.unknown.length) {
      result.complete = false;
      result.diagnostics.push({ path, line, code: 'unknown-string', detail: resolved.unknown.join(', ') });
    }
    return resolved;
  };
  for (const { entry, fields } of pending) for (const [name, value] of fields) {
    const resolved = reportUnknown(value, entry.path, entry.line);
    // Partial strings must not look like trustworthy metadata.
    entry.fields[name] = resolved.unknown.length ? '' : resolved.text;
  }
  for (const definition of definitions.values()) reportUnknown(definition.value, definition.path, definition.line);
  for (const preamble of preambles) reportUnknown(preamble.value, preamble.path, preamble.line);
  markDuplicates(result);
  return result;
}

export function bibDisplayText(value: string): string {
  // This is a search/display aid, never the source of inserted citation keys.
  return value.replace(/\\([{}"%&_#$])/g, '$1').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}
export function searchBibEntries(entries: BibEntry[], query: string): BibEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(entry => {
    const text = [entry.key, entry.fields.title, entry.fields.author, entry.fields.year, entry.fields.date].filter(Boolean).map(bibDisplayText).join(' ').toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}
