export type ReplaceSource = {path: string; text: string; revisionSha256: string};
export type ReplaceOptions = {find: string; replace: string; matchCase: boolean; wholeWord: boolean};
export type ReplacePreview = {line: number; before: string; after: string};
export type ReplaceFile = {path: string; baseSha256: string; content: string; count: number; previews: ReplacePreview[]};
export type ReplaceSkip = {path: string; reason: string};
export type ReplacePlan = {
  status: 'ready' | 'limit';
  files: ReplaceFile[];
  totalMatches: number;
  skipped: ReplaceSkip[];
  limit?: 'matches' | 'files';
};
export const REPLACE_MATCH_LIMIT = 2000;
export const REPLACE_FILE_LIMIT = 16;
export const REPLACE_BYTE_LIMIT = 4 * 1024 * 1024;

export function isPrivateReplacePath(path: string): boolean {
  return path.split(/[\\/]/).some(part => ['.texypaper', '.paperdock', '.git'].includes(part.toLowerCase()));
}

const wordCharacter = /[\p{L}\p{N}\p{M}\p{Pc}\p{Join_Control}]/u;
type Span = {start: number; end: number};
function precedingCharacter(text: string, offset: number): string {
  if (!offset) return '';
  const last = text.charCodeAt(offset - 1);
  return text.slice(offset - (last >= 0xdc00 && last <= 0xdfff && offset > 1 ? 2 : 1), offset);
}
function lineIndex(starts: number[], offset: number): number {
  let low = 0, high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) low = middle; else high = middle;
  }
  return low;
}
function previewsFor(text: string, spans: Span[], replacement: string): ReplacePreview[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\r') {
      if (text[index + 1] === '\n') index++;
      starts.push(index + 1);
    } else if (text[index] === '\n') starts.push(index + 1);
  }
  const groups: {first: number; last: number; spans: Span[]}[] = [];
  for (const span of spans) {
    const first = lineIndex(starts, span.start), last = lineIndex(starts, span.end - 1);
    const previous = groups.at(-1);
    if (previous && first <= previous.last) { previous.last = Math.max(previous.last, last); previous.spans.push(span); }
    else groups.push({first, last, spans: [span]});
  }
  return groups.map(group => {
    const start = starts[group.first];
    let end = starts[group.last + 1] ?? text.length;
    // Keep internal line endings, but omit the final unchanged line terminator.
    while (end > start && /[\r\n]/.test(text[end - 1]) && end > group.spans.at(-1)!.end) end--;
    const parts: string[] = [];
    let offset = start;
    for (const span of group.spans) { parts.push(text.slice(offset, span.start), replacement); offset = span.end; }
    parts.push(text.slice(offset, end));
    return {line: group.first + 1, before: text.slice(start, end), after: parts.join('')};
  });
}

/** Input is file_read.text: encoding BOMs are omitted there and restored by apply_proposal.
 * No newline conversion or whole-string case conversion is performed. Literal Unicode
 * simple case folding matches original spans, so untouched bytes never shift or change.
 */
export function createReplacePlan(sources: readonly ReplaceSource[], options: ReplaceOptions): ReplacePlan {
  if (!options.find.length) throw new Error('Replacement requires a nonempty find string');
  const result: ReplacePlan = {status: 'ready', files: [], totalMatches: 0, skipped: []};
  // Escaping is mandatory: the query is always literal, never a user regular expression.
  const literal = options.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(literal, options.matchCase ? 'gu' : 'giu');
  const seen = new Set<string>();
  for (const source of sources) {
    if (isPrivateReplacePath(source.path)) { result.skipped.push({path: source.path, reason: 'private'}); continue; }
    if (seen.has(source.path)) { result.skipped.push({path: source.path, reason: 'duplicate'}); continue; }
    seen.add(source.path);
    matcher.lastIndex = 0;
    const spans: Span[] = [];
    let fileMatches = 0;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(source.text))) {
      const start = match.index, end = start + match[0].length;
      if (options.wholeWord && (wordCharacter.test(precedingCharacter(source.text, start)) || wordCharacter.test(String.fromCodePoint(source.text.codePointAt(end) ?? 0)))) {
        // A rejected boundary must not hide a later, overlapping valid candidate.
        matcher.lastIndex = start + (source.text.codePointAt(start)! > 0xffff ? 2 : 1);
        continue;
      }
      fileMatches++;
      result.totalMatches++;
      if (result.totalMatches > REPLACE_MATCH_LIMIT) return {...result, status: 'limit', limit: 'matches', files: []};
      // No-op spans still count as matches, but must not create writes or diff noise.
      if (match[0] !== options.replace) spans.push({start, end});
    }
    if (!spans.length) continue;
    if (result.files.length >= REPLACE_FILE_LIMIT) return {...result, status: 'limit', limit: 'files', files: []};
    const parts: string[] = [];
    let offset = 0;
    for (const span of spans) { parts.push(source.text.slice(offset, span.start), options.replace); offset = span.end; }
    parts.push(source.text.slice(offset));
    result.files.push({path: source.path, baseSha256: source.revisionSha256, content: parts.join(''), count: fileMatches, previews: previewsFor(source.text, spans, options.replace)});
  }
  return result;
}
