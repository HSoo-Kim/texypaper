import {describe, expect, it} from 'vitest';
import {escapeLatexText, generateLatexTable, parseTableData, TABLE_LIMITS, TableInputError, type TableOptions} from './delimitedTable';

const options: TableOptions = {header: true, caption: '', label: ''};

function expectInputError(action: () => unknown, code: TableInputError['code']) {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(TableInputError);
  expect(caught).toMatchObject({code});
}

describe('bounded CSV and TSV parsing', () => {
  it('preserves quoted delimiters, multiline cells, escaped quotes and trailing empty cells', () => {
    const table = parseTableData('Name,Note,Value\r\n"Kim, A.","First\r\nSecond ""quoted""",\r\n', ',');
    expect(table).toEqual({delimiter: ',', rows: [['Name', 'Note', 'Value'], ['Kim, A.', 'First\nSecond "quoted"', '']]});
  });
  it('parses quoted TSV with embedded tabs and newlines', () => {
    expect(parseTableData('Name\tNote\n"한글"\t"a\tb\nc"\n').rows).toEqual([['Name', 'Note'], ['한글', 'a\tb\nc']]);
  });
  it('accepts CR, LF, CRLF and a leading BOM without phantom final rows', () => {
    expect(parseTableData('\ufeffa,b\r1,2\n3,4\r\n', ',').rows).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
  it('retains empty cells, whitespace and blank records instead of trimming or skipping them', () => {
    expect(parseTableData(' a ,\n,b ', ',').rows).toEqual([[' a ', ''], ['', 'b ']]);
    expect(parseTableData('a\n\nb', ',').rows).toEqual([['a'], [''], ['b']]);
    expect(parseTableData('""', ',').rows).toEqual([['']]);
  });
  it('detects common separators outside quoted text', () => {
    expect(parseTableData('a,b\n1,2').delimiter).toBe(',');
    expect(parseTableData('a\tb\n1\t"2,3;4"').delimiter).toBe('\t');
    expect(parseTableData('a;b\n1;"2,3"').delimiter).toBe(';');
    expect(parseTableData('a\nb').rows).toEqual([['a'], ['b']]);
  });
  it('asks for an explicit separator when two consistent choices fit', () => {
    const ambiguous = 'a,b\tc\n1,2\t3';
    expectInputError(() => parseTableData(ambiguous), 'ambiguous');
    expect(parseTableData(ambiguous, '\t').rows).toEqual([['a,b', 'c'], ['1,2', '3']]);
    expect(parseTableData(ambiguous, ',').rows).toEqual([['a', 'b\tc'], ['1', '2\t3']]);
  });
  it('rejects ragged records in explicit and automatic modes without dropping any cells', () => {
    expectInputError(() => parseTableData('a,b\n1,2,3', ','), 'ragged');
    expectInputError(() => parseTableData('a\tb\n1'), 'ragged');
    expect(() => parseTableData('a,b\n1', ',')).toThrow(/Row 2.*expected 2/);
  });
  it('rejects quotes in unquoted fields and any text after a closing quote', () => {
    for (const input of ['a"b,c', '"a"x,b', '"a" ,b', '"a""b"x,c']) {
      expectInputError(() => parseTableData(input, ','), 'quote');
    }
    expectInputError(() => parseTableData('a,"unfinished\ncell', ','), 'unclosed-quote');
  });
  it('rejects empty input and unsupported control characters', () => {
    expectInputError(() => parseTableData(''), 'empty');
    expectInputError(() => parseTableData(' \r\n\t'), 'empty');
    expectInputError(() => parseTableData('a,\u0000b'), 'control');
  });
  it('accepts the exact character bound and rejects the next character, never truncating', () => {
    const cell = 'a'.repeat(TABLE_LIMITS.characters);
    expect(parseTableData(cell, ',').rows[0][0]).toHaveLength(TABLE_LIMITS.characters);
    expectInputError(() => parseTableData(cell + 'b', ','), 'size');
  });
  it('accepts the exact row bound including a final newline, and rejects the next row', () => {
    const input = Array(TABLE_LIMITS.rows).fill('a,b').join('\n');
    expect(parseTableData(input + '\n', ',').rows).toHaveLength(TABLE_LIMITS.rows);
    expectInputError(() => parseTableData(input + '\na,b', ','), 'rows');
  });
  it('accepts the exact column bound and rejects an extra empty column', () => {
    const input = Array(TABLE_LIMITS.columns).fill('a').join(',');
    expect(parseTableData(input, ',').rows[0]).toHaveLength(TABLE_LIMITS.columns);
    expectInputError(() => parseTableData(input + ',', ','), 'columns');
  });
});

describe('portable plain-text LaTeX tables', () => {
  it('escapes every TeX special character without re-escaping generated commands', () => {
    expect(escapeLatexText('\\{}$&#%_^~<>|\t')).toBe(String.raw`\textbackslash{}\{\}\$\&\#\%\_\textasciicircum{}\textasciitilde{}\textless{}\textgreater{}\textbar{}\hspace*{2em}`);
    expect(escapeLatexText('한글 café 😀')).toBe('한글 café 😀');
  });
  it('generates all rows in a single complete package-free insertion', () => {
    const latex = generateLatexTable([['Name', 'Value'], ['A&B', '50%'], ['C_D', '$2']], options);
    expect(latex).toBe(String.raw`\begin{tabular}{ll}
\hline
\textbf{Name} & \textbf{Value} \\
\hline
A\&B & 50\% \\
C\_D & \$2 \\
\hline
\end{tabular}
`);
    expect(latex).not.toMatch(/usepackage|booktabs|toprule|midrule|bottomrule/);
  });
  it('preserves multiline cells with nested standard tabulars, including empty lines', () => {
    const latex = generateLatexTable([['line 1\n\nline & 3\n']], {...options, header: false});
    expect(latex).toContain(String.raw`\begin{tabular}[t]{@{}l@{}}line 1 \\ \strut \\ line \& 3 \\ \strut\end{tabular}`);
    expect(latex).not.toContain('textbf');
  });
  it('escapes caption and cell injection attempts while validating labels independently', () => {
    const latex = generateLatexTable([['\\end{tabular}%']], {...options, caption: 'Rate 50% & cost_$\nNext', label: 'tab:results_1.2-A'});
    expect(latex).toContain(String.raw`\textbackslash{}end\{tabular\}\%`);
    expect(latex).toContain(String.raw`\caption{Rate 50\% \& cost\_\$\space{}Next}`);
    expect(latex).toContain('\\label{tab:results_1.2-A}\n\\end{table}\n');
    expect(latex.indexOf('\\caption{')).toBeLessThan(latex.indexOf('\\label{'));
  });
  it('allows captions without labels and labels without captions', () => {
    expect(generateLatexTable([['x']], {...options, caption: 'A caption'})).toContain('\\caption{A caption}\n\\end{table}');
    const labeled = generateLatexTable([['x']], {...options, label: 'tab:x'});
    expect(labeled).toContain('\\refstepcounter{table}\n\\label{tab:x}');
    expect(labeled).not.toContain('\\caption');
  });
  it('rejects raw TeX, whitespace, non-ASCII and overlong labels', () => {
    for (const label of ['tab:x}\\input{secret}', 'tab:x y', '1table', 'tab:한글', 'tab:%x', 'a'.repeat(TABLE_LIMITS.label + 1)]) {
      expectInputError(() => generateLatexTable([['x']], {...options, label}), 'label');
    }
    expect(generateLatexTable([['x']], {...options, label: 'a'.repeat(TABLE_LIMITS.label)})).toContain('\\label{');
  });
  it('rejects overlong captions, control characters and malformed direct generator inputs', () => {
    expectInputError(() => generateLatexTable([['x']], {...options, caption: 'x'.repeat(TABLE_LIMITS.caption + 1)}), 'caption-size');
    expectInputError(() => generateLatexTable([['x']], {...options, caption: '\u0000'}), 'control');
    expectInputError(() => generateLatexTable([], options), 'empty');
    expectInputError(() => generateLatexTable([['a', 'b'], ['c']], options), 'ragged');
  });
});
