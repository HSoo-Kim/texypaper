export type TableDelimiter = 'auto' | ',' | '\t' | ';';
export type ParsedTable = {rows: string[][]; delimiter: Exclude<TableDelimiter, 'auto'>};
export type TableOptions = {header: boolean; caption: string; label: string};
export const TABLE_LIMITS = {characters: 200_000, rows: 200, columns: 30, caption: 2_000, label: 100} as const;
export type TableErrorCode = 'empty' | 'size' | 'rows' | 'columns' | 'ragged' | 'quote' | 'unclosed-quote' | 'control' | 'ambiguous' | 'label' | 'caption-size';

export class TableInputError extends Error {
  constructor(public code: TableErrorCode, message: string, public row?: number, public column?: number) {
    super(message);
    this.name = 'TableInputError';
  }
}

const separators = [',', '\t', ';'] as const;
const unsupportedControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function detectDelimiter(text: string): Exclude<TableDelimiter, 'auto'> {
  const records: number[][] = [];
  let counts = [0, 0, 0], quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted) {
      const separator = separators.indexOf(character as typeof separators[number]);
      if (separator !== -1) counts[separator]++;
      if (character === '\r' || character === '\n') {
        records.push(counts);
        counts = [0, 0, 0];
        if (character === '\r' && text[index + 1] === '\n') index++;
      }
    }
  }
  if (!/[\r\n]$/.test(text) || quoted) records.push(counts);
  const candidates = separators.map((delimiter, index) => ({
    delimiter,
    total: records.reduce((sum, record) => sum + record[index], 0),
    consistent: records.length > 0 && records.every(record => record[index] === records[0][index]),
  })).filter(candidate => candidate.total > 0);
  if (!candidates.length) return ',';
  if (candidates.length === 1) return candidates[0].delimiter;
  const consistent = candidates.filter(candidate => candidate.consistent);
  if (consistent.length === 1) return consistent[0].delimiter;
  if (consistent.length > 1) throw new TableInputError('ambiguous', 'More than one delimiter fits. Choose comma, tab or semicolon explicitly.');
  candidates.sort((left, right) => right.total - left.total);
  if (candidates[0].total === candidates[1].total) throw new TableInputError('ambiguous', 'The delimiter is unclear. Choose comma, tab or semicolon explicitly.');
  return candidates[0].delimiter;
}

function validateRows(rows: string[][]): void {
  if (!rows.length || !rows[0].length) throw new TableInputError('empty', 'Paste CSV or TSV data to create a table.');
  if (rows.length > TABLE_LIMITS.rows) throw new TableInputError('rows', `Use at most ${TABLE_LIMITS.rows} rows, including the header.`);
  const width = rows[0].length;
  let characters = 0;
  rows.forEach((row, index) => {
    if (row.length > TABLE_LIMITS.columns) throw new TableInputError('columns', `Use at most ${TABLE_LIMITS.columns} columns.`, index + 1);
    if (row.length !== width) throw new TableInputError('ragged', `Row ${index + 1} has ${row.length} cells; expected ${width}. Add missing cells or correct the delimiter.`, index + 1);
    row.forEach((cell, column) => {
      characters += cell.length;
      if (unsupportedControls.test(cell)) throw new TableInputError('control', 'Remove unsupported control characters from the data.', index + 1, column + 1);
    });
  });
  if (characters > TABLE_LIMITS.characters) throw new TableInputError('size', `Use at most ${TABLE_LIMITS.characters} characters. Split the data into smaller tables.`);
}

export function parseTableData(input: string, choice: TableDelimiter = 'auto'): ParsedTable {
  if (input.length > TABLE_LIMITS.characters) throw new TableInputError('size', `Use at most ${TABLE_LIMITS.characters} characters. Split the data into smaller tables.`);
  const text = input.startsWith('\ufeff') ? input.slice(1) : input;
  if (!text.trim()) throw new TableInputError('empty', 'Paste CSV or TSV data to create a table.');
  if (unsupportedControls.test(text)) throw new TableInputError('control', 'Remove unsupported control characters from the data.');
  const delimiter = choice === 'auto' ? detectDelimiter(text) : choice;
  const rows: string[][] = [];
  let row: string[] = [], cell = '', state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  const pushCell = () => {
    row.push(cell);
    cell = '';
    state = 'start';
    if (row.length > TABLE_LIMITS.columns) throw new TableInputError('columns', `Use at most ${TABLE_LIMITS.columns} columns.`, rows.length + 1);
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
    if (rows.length > TABLE_LIMITS.rows) throw new TableInputError('rows', `Use at most ${TABLE_LIMITS.rows} rows, including the header.`);
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (state === 'quoted') {
      if (character === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; }
        else state = 'closed';
      } else if (character === '\r') {
        cell += '\n';
        if (text[index + 1] === '\n') index++;
      } else cell += character;
    } else if (character === delimiter) {
      pushCell();
    } else if (character === '\r' || character === '\n') {
      pushRow();
      if (character === '\r' && text[index + 1] === '\n') index++;
    } else if (character === '"' && state === 'start') {
      state = 'quoted';
    } else if (character === '"' || state === 'closed') {
      throw new TableInputError('quote', `Invalid quote at row ${rows.length + 1}, column ${row.length + 1}. Quote the entire cell and write a literal quote as "".`, rows.length + 1, row.length + 1);
    } else {
      cell += character;
      state = 'plain';
    }
  }
  if (state === 'quoted') throw new TableInputError('unclosed-quote', `Close the quoted cell at row ${rows.length + 1}, column ${row.length + 1}.`, rows.length + 1, row.length + 1);
  // A single final record separator terminates a row; it is not an extra empty row.
  if (state !== 'start' || row.length || !/[\r\n]$/.test(text)) pushRow();
  validateRows(rows);
  return {rows, delimiter};
}

const texEscapes: Record<string, string> = {
  '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&', '#': '\\#',
  '%': '\\%', '_': '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}',
  '<': '\\textless{}', '>': '\\textgreater{}', '|': '\\textbar{}', '\t': '\\hspace*{2em}',
};

export function escapeLatexText(text: string): string {
  return text.replace(/[\\{}$&#%_^~<>|\t]/g, character => texEscapes[character]);
}

function latexCell(value: string): string {
  const lines = value.split(/\r\n|\r|\n/).map(escapeLatexText);
  if (lines.length === 1) return lines[0];
  return `\\begin{tabular}[t]{@{}l@{}}${lines.map(line => line || '\\strut').join(' \\\\ ')}\\end{tabular}`;
}

export function generateLatexTable(rows: string[][], options: TableOptions): string {
  validateRows(rows);
  const label = options.label.trim();
  if (label && (label.length > TABLE_LIMITS.label || !/^[A-Za-z][A-Za-z0-9:._-]*$/.test(label))) {
    throw new TableInputError('label', `Use a label starting with a letter and containing only ASCII letters, digits, colon, dot, underscore or hyphen (maximum ${TABLE_LIMITS.label} characters).`);
  }
  if (options.caption.length > TABLE_LIMITS.caption) throw new TableInputError('caption-size', `Shorten the caption to ${TABLE_LIMITS.caption} characters or fewer.`);
  if (unsupportedControls.test(options.caption)) throw new TableInputError('control', 'Remove unsupported control characters from the caption.');
  const caption = options.caption.trim();
  const floating = !!(caption || label);
  const lines: string[] = [];
  if (floating) lines.push('\\begin{table}[htbp]', '\\centering');
  lines.push(`\\begin{tabular}{${'l'.repeat(rows[0].length)}}`, '\\hline');
  rows.forEach((row, index) => {
    lines.push(row.map(value => options.header && index === 0 ? `\\textbf{${latexCell(value)}}` : latexCell(value)).join(' & ') + ' \\\\');
    if (options.header && index === 0) lines.push('\\hline');
  });
  if (!(options.header && rows.length === 1)) lines.push('\\hline');
  lines.push('\\end{tabular}');
  if (caption) lines.push(`\\caption{${escapeLatexText(caption).replace(/\r\n|\r|\n/g, '\\space{}')}}`);
  if (label) {
    if (!caption) lines.push('\\refstepcounter{table}');
    lines.push(`\\label{${label}}`);
  }
  if (floating) lines.push('\\end{table}');
  return lines.join('\n') + '\n';
}
