import {describe, expect, it} from 'vitest';
import {createReplacePlan, isPrivateReplacePath, type ReplaceOptions, type ReplaceSource} from './replacePlan';

const options: ReplaceOptions = {find: 'cat', replace: 'dog', matchCase: true, wholeWord: false};
const source = (text: string, path = 'main.tex'): ReplaceSource => ({path, text, revisionSha256: 'base-hash'});
const plan = (text: string, patch: Partial<ReplaceOptions> = {}) => createReplacePlan([source(text)], {...options, ...patch});

describe('literal project replacement plans', () => {
  it('rejects an empty query but permits deletion', () => {
    expect(() => plan('cat', {find: ''})).toThrow(/nonempty/);
    expect(plan('cat cat', {replace: ''}).files[0].content).toBe(' ');
  });
  it('uses nonoverlapping left-to-right literal matches without rescanning replacements', () => {
    expect(plan('aaaaa', {find: 'aa', replace: 'aaa'}).files[0]).toMatchObject({content: 'aaaaaaa', count: 2});
    expect(plan('a.* a.* axx', {find: 'a.*', replace: '$&'}).files[0]).toMatchObject({content: '$& $& axx', count: 2});
  });
  it('honors case and preserves the case and bytes of all untouched text', () => {
    expect(plan('Cat cat CAT').files[0].content).toBe('Cat dog CAT');
    expect(plan('İ — Cat / CAT — 한글 e\u0301 😀', {matchCase: false}).files[0].content).toBe('İ — dog / dog — 한글 e\u0301 😀');
    expect(plan('K K k', {find: 'k', replace: 'x', matchCase: false}).files[0].content).toBe('x x x');
  });
  it('does not let case-fold length expansion corrupt original offsets', () => {
    expect(plan('İİ cat İ CAT', {matchCase: false}).files[0].content).toBe('İİ dog İ dog');
    expect(plan('straße STRASSE', {find: 'straße', replace: 'road', matchCase: false}).files[0].content).toBe('road STRASSE');
  });
  it('uses Unicode whole words including Hangul, combining marks, digits and underscores', () => {
    const result = plan('한글 한글말 말한글 (한글) 한글_ 한글2 한글\u0301 😀한글😀', {find: '한글', replace: '글', wholeWord: true});
    expect(result.totalMatches).toBe(3);
    expect(result.files[0].content).toBe('글 한글말 말한글 (글) 한글_ 한글2 한글\u0301 😀글😀');
    expect(plan('cat 𐐀cat cat𐐀 cat\u0301 _cat cat_', {wholeWord: true}).totalMatches).toBe(1);
    expect(plan('xa a a ', {find: 'a a', replace: 'word', wholeWord: true}).files[0].content).toBe('xa word ');
  });
  it('preserves CRLF, LF, lone CR, an in-text BOM and trailing newlines exactly', () => {
    const text = '\ufeffcat\r\nuntouched\ncat\rcat\r\n';
    const file = plan(text).files[0];
    expect(file.content).toBe('\ufeffdog\r\nuntouched\ndog\rdog\r\n');
    expect(file.baseSha256).toBe('base-hash');
    expect(file.previews).toEqual([{line: 1, before: '\ufeffcat', after: '\ufeffdog'}, {line: 3, before: 'cat', after: 'dog'}, {line: 4, before: 'cat', after: 'dog'}]);
  });
  it('keeps file_read BOM-free content BOM-free for native BOM restoration', () => {
    expect(plan('cat\r\n').files[0].content).toBe('dog\r\n');
  });
  it('groups multiple changes on one line and supports multiline literal spans', () => {
    expect(plan('cat cat\ncat').files[0].previews).toEqual([{line: 1, before: 'cat cat', after: 'dog dog'}, {line: 2, before: 'cat', after: 'dog'}]);
    const file = plan('x\r\ncat\r\nnext\r\ny', {find: 'cat\r\nnext', replace: 'dog'}).files[0];
    expect(file.content).toBe('x\r\ndog\r\ny');
    expect(file.previews).toEqual([{line: 2, before: 'cat\r\nnext', after: 'dog'}]);
  });
  it('does not write no-op replacements or files with no matches', () => {
    expect(plan('cat cat', {replace: 'cat'})).toMatchObject({status: 'ready', files: [], totalMatches: 2});
    expect(plan('nothing')).toMatchObject({files: [], totalMatches: 0});
    expect(plan('cat CAT', {replace: 'cat', matchCase: false}).files[0]).toMatchObject({content: 'cat cat', count: 2});
  });
  it('accepts exactly 2000 changed matches and refuses 2001 without a partial writable plan', () => {
    expect(plan('cat '.repeat(2000)).totalMatches).toBe(2000);
    expect(plan('cat '.repeat(2001))).toMatchObject({status: 'limit', limit: 'matches', files: [], totalMatches: 2001});
    expect(plan('cat '.repeat(2001), {replace: 'cat'})).toMatchObject({status: 'limit', limit: 'matches', files: []});
  });
  it('applies the total-match cap across files', () => {
    const result = createReplacePlan([source('cat '.repeat(1001), 'a.tex'), source('cat '.repeat(1000), 'b.tex')], options);
    expect(result).toMatchObject({status: 'limit', limit: 'matches', files: []});
  });
  it('accepts 16 changed files, ignores unchanged files and refuses the seventeenth', () => {
    const files = Array.from({length: 16}, (_, index) => source('cat', `${index}.tex`));
    expect(createReplacePlan([...files, source('none', 'unchanged.tex')], options).files).toHaveLength(16);
    expect(createReplacePlan([...files, source('cat', 'seventeen.tex')], options)).toMatchObject({status: 'limit', limit: 'files', files: []});
  });
  it('excludes private metadata at any depth and avoids duplicate transaction paths', () => {
    const result = createReplacePlan([source('cat'), source('cat'), source('cat', '.git/config'), source('cat', 'nested/.texypaper/file.tex'), source('cat', '.paperdock/old.tex')], options);
    expect(result.files).toHaveLength(1);
    expect(result.skipped).toEqual([{path: 'main.tex', reason: 'duplicate'}, {path: '.git/config', reason: 'private'}, {path: 'nested/.texypaper/file.tex', reason: 'private'}, {path: '.paperdock/old.tex', reason: 'private'}]);
    expect(isPrivateReplacePath('nested\\.GIT\\config')).toBe(true);
  });
});
