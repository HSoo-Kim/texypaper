import { describe, expect, it } from 'vitest';
import { bibDisplayText, indexBibTeX, isSafeCitationKey, parseBibTeX, searchBibEntries } from './bibtex';

describe('project BibTeX parser', () => {
  it('balances nested braces and quoted values without corrupting keys or line locations', () => {
    const result = parseBibTeX(String.raw`% ignored @article{commented}
@article{Doe:2024,
  title = "He said \"hello\" and {a "nested" title}",
  author = {Doe, Jane and {Research {Group}}},
  year = 2024,
}`, 'refs.bib');
    expect(result.diagnostics).toEqual([]);
    expect(result.entries[0]).toMatchObject({ key: 'Doe:2024', path: 'refs.bib', line: 2, valid: true, safeKey: true });
    expect(result.entries[0].fields.title).toBe(String.raw`He said \"hello\" and {a "nested" title}`);
    expect(result.entries[0].fields.year).toBe('2024');
  });
  it('handles parenthesized entries, comments, preambles, months and concatenated strings', () => {
    const result = parseBibTeX(String.raw`@comment{A {nested} comment with @article{notAnEntry} and "prose"}
@string{journal = "Journal " # "of Tests"}
@preamble{"A " # journal}
@article(test, title=journal # { 2026}, month=nov, year="2026")`);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].fields).toEqual({ title: 'Journal of Tests 2026', month: 'November', year: '2026' });
    expect(result.complete).toBe(true);
  });
  it('resolves forward string references but explicitly reports unknown and cyclic strings', () => {
    const result = parseBibTeX(String.raw`@string{forward = later}
@string{later = "Resolved"}
@string{cycle = loop}
@string{loop = cycle}
@article{good, title=forward}
@article{unknown, title="Partial " # unavailable}
@article{cyclic, title=cycle}`);
    expect(result.entries[0].fields.title).toBe('Resolved');
    expect(result.entries[1].fields.title).toBe('');
    expect(result.entries[2].fields.title).toBe('');
    expect(result.diagnostics.some(issue => issue.code === 'unknown-string' && issue.detail === 'unavailable')).toBe(true);
    expect(result.diagnostics.some(issue => issue.code === 'unknown-string' && /cycle|loop/.test(issue.detail))).toBe(true);
    expect(result.complete).toBe(false);
  });
  it('does not resolve inherited object names as built-in strings', () => {
    const result = parseBibTeX('@article{key, title=constructor}');
    expect(result.entries[0].fields.title).toBe('');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'unknown-string', detail: 'constructor' }));
  });
  it('keeps malformed entries noninsertable and recovers later complete entries', () => {
    const result = parseBibTeX('@article{broken, title={Unclosed\n@book{recovered, title={Recovered}}', 'refs.bib');
    expect(result.entries.map(entry => [entry.key, entry.valid])).toEqual([['broken', false], ['recovered', true]]);
    expect(result.entries[1].line).toBe(2);
    expect(result.complete).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ path: 'refs.bib', line: 1, code: 'malformed' });
  });
  it('reports duplicate fields, malformed headers and unterminated comments', () => {
    expect(parseBibTeX('@article{key, title={One}, title={Two}}').entries[0].valid).toBe(false);
    expect(parseBibTeX('@article{key\ntitle={One}}').complete).toBe(false);
    expect(parseBibTeX('@comment{not closed').complete).toBe(false);
  });
  it('marks all case-variant duplicate keys across databases, including malformed entries', () => {
    const result = indexBibTeX({ complete: true, skipped: [], files: [
      { path: 'one.bib', text: '@article{Same, title={One}}' },
      { path: 'two.bib', text: '@book{same, title={broken' },
    ] });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.every(entry => entry.duplicate)).toBe(true);
    expect(result.diagnostics.filter(issue => issue.code === 'duplicate')).toHaveLength(2);
  });
  it('never classifies TeX-active or whitespace-containing keys as safe insertion text', () => {
    for (const key of ['a b', 'a,b', String.raw`a\input`, 'a%comment', 'a}bad', 'a#1', '', 'a\nnext']) expect(isSafeCitationKey(key)).toBe(false);
    expect(isSafeCitationKey('Author-2026:paper_v2.1/test+data')).toBe(true);
    expect(parseBibTeX('@article{unsafe key, title={Title}}').entries[0].safeKey).toBe(false);
  });
  it('searches title, author, date/year and exact key text without inventing metadata', () => {
    const entries = parseBibTeX('@article{Key:One,title={{Nested} title},author={Doe, Jane},year=2024}\n@book{Other,date={2026-01}}').entries;
    expect(searchBibEntries(entries, 'nested DOE 2024').map(entry => entry.key)).toEqual(['Key:One']);
    expect(searchBibEntries(entries, 'key:one')).toHaveLength(1);
    expect(searchBibEntries(entries, '2026').map(entry => entry.key)).toEqual(['Other']);
    expect(searchBibEntries(entries, 'nonexistent')).toEqual([]);
    expect(bibDisplayText(String.raw`{A} \"quoted\" title`)).toBe('A "quoted" title');
  });
  it('preserves CRLF and CR source line positions and skipped scan completeness', () => {
    expect(parseBibTeX('comment\r\n@article{one}\r@book{two}').entries.map(entry => entry.line)).toEqual([2, 3]);
    expect(indexBibTeX({ files: [], complete: true, skipped: [{ path: 'large.bib', reason: 'too large' }] }).complete).toBe(false);
  });
  it('accepts unbraced comment directives without treating their prose as an entry', () => {
    const result = parseBibTeX('@comment ordinary ignored prose\n@article{key,title={Title}}');
    expect(result.entries.map(entry => entry.key)).toEqual(['key']);
    expect(result.diagnostics).toEqual([]);
  });
  it('flags brace-corrupted keys as malformed instead of accepting a partial entry', () => {
    const result = parseBibTeX('@article{key title={Title}}');
    expect(result.complete).toBe(false);
    expect(result.entries[0].valid).toBe(false);
  });
  it('bounds deep and exponential string expansion without presenting partial metadata', () => {
    const definitions = ['@string{s0=\"x\"}', ...Array.from({ length: 25 }, (_, index) => `@string{s${index + 1}=s${index} # s${index}}`)];
    const result = parseBibTeX(definitions.join('\n') + '\n@article{key,title=s25}');
    expect(result.complete).toBe(false);
    expect(result.entries[0].fields.title).toBe('');
    expect(result.diagnostics.some(issue => issue.code === 'unknown-string')).toBe(true);
    const deep = Array.from({ length: 80 }, (_, index) => `@string{d${index}=d${index + 1}}`).join('\n');
    expect(parseBibTeX(deep + '\n@string{d80=\"end\"}\n@article{deep,title=d0}').complete).toBe(false);
  });
});
