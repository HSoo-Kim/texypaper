import {useId, useMemo, useState} from 'react';
import {useI18n} from '../../ui/i18n';
import {generateLatexTable, parseTableData, TABLE_LIMITS, TableInputError, type TableDelimiter} from './delimitedTable';
import './tables.css';

type Props = {canInsert: boolean; onInsert: (text: string) => void};

export function TableBuilder({canInsert, onInsert}: Props) {
  const {t} = useI18n();
  const id = useId();
  const [input, setInput] = useState('');
  const [delimiter, setDelimiter] = useState<TableDelimiter>('auto');
  const [header, setHeader] = useState(true);
  const [caption, setCaption] = useState('');
  const [label, setLabel] = useState('');
  const parsed = useMemo(() => {
    try { return {table: parseTableData(input, delimiter), error: null}; }
    catch (error) { if (error instanceof TableInputError) return {table: null, error}; throw error; }
  }, [input, delimiter]);
  const generated = useMemo(() => {
    if (!parsed.table) return {latex: '', error: null};
    try { return {latex: generateLatexTable(parsed.table.rows, {header, caption, label}), error: null}; }
    catch (error) { if (error instanceof TableInputError) return {latex: '', error}; throw error; }
  }, [parsed.table, header, caption, label]);
  const error = parsed.error ?? generated.error;
  const errorMessage = (issue: TableInputError) => {
    switch (issue.code) {
      case 'empty': return t('CSV 또는 TSV 데이터를 붙여 넣으세요.', 'Paste CSV or TSV data to create a table.');
      case 'size': return t(`입력은 ${TABLE_LIMITS.characters.toLocaleString()}자 이하여야 합니다. 데이터를 여러 표로 나누세요.`, `Use at most ${TABLE_LIMITS.characters.toLocaleString()} characters. Split the data into smaller tables.`);
      case 'rows': return t(`머리글을 포함해 ${TABLE_LIMITS.rows}행 이하로 나누세요.`, `Use at most ${TABLE_LIMITS.rows} rows, including the header.`);
      case 'columns': return t(`${issue.row}행의 열이 너무 많습니다. ${TABLE_LIMITS.columns}열 이하로 줄이거나 구분자를 확인하세요.`, `Row ${issue.row} has too many columns. Use at most ${TABLE_LIMITS.columns} columns or check the delimiter.`);
      case 'ragged': return t(`${issue.row}행의 셀 수가 첫 행과 다릅니다. 빈 셀을 추가하거나 구분자를 수정하세요.`, `Row ${issue.row} has a different number of cells from the first row. Add missing cells or correct the delimiter.`);
      case 'quote': return t(`${issue.row}행 ${issue.column}열의 따옴표를 확인하세요. 셀 전체를 큰따옴표로 감싸고, 셀 안의 큰따옴표는 ""로 쓰세요.`, `Check quotes in row ${issue.row}, column ${issue.column}. Quote the entire cell and write a literal quote as "".`);
      case 'unclosed-quote': return t(`${issue.row}행 ${issue.column}열의 닫는 큰따옴표를 추가하세요.`, `Close the quoted cell in row ${issue.row}, column ${issue.column}.`);
      case 'control': return t('데이터나 캡션에서 지원하지 않는 제어 문자를 제거하세요.', 'Remove unsupported control characters from the data or caption.');
      case 'ambiguous': return t('구분자가 모호합니다. 쉼표, 탭 또는 세미콜론을 직접 선택하세요.', 'The delimiter is ambiguous. Choose comma, tab or semicolon explicitly.');
      case 'label': return t(`라벨은 영문자로 시작하고 영문자·숫자·: . _ -만 사용해야 합니다 (${TABLE_LIMITS.label}자 이하).`, `Start the label with an ASCII letter; use only letters, digits and : . _ - (at most ${TABLE_LIMITS.label} characters).`);
      case 'caption-size': return t(`캡션을 ${TABLE_LIMITS.caption}자 이하로 줄이세요.`, `Shorten the caption to ${TABLE_LIMITS.caption} characters or fewer.`);
    }
  };
  const detectedDelimiter = parsed.table?.delimiter;
  const detectedDelimiterName = detectedDelimiter === '\t' ? t('탭', 'Tab') : detectedDelimiter === ';' ? t('세미콜론', 'Semicolon') : t('쉼표', 'Comma');
  const showError = error && (error.code !== 'empty' || input.length > 0);
  return <section className="table-builder" aria-label={t('LaTeX 표 만들기', 'LaTeX table builder')}>
    <p className="table-builder-note" id={`${id}-help`}>{t(`CSV 또는 TSV를 붙여 넣고 확인한 뒤 커서 위치에 삽입하세요. 최대 ${TABLE_LIMITS.rows}행(머리글 포함), ${TABLE_LIMITS.columns}열, ${TABLE_LIMITS.characters.toLocaleString()}자입니다.`, `Paste CSV or TSV, review it, then insert at the cursor. Limit: ${TABLE_LIMITS.rows} rows including the header, ${TABLE_LIMITS.columns} columns and ${TABLE_LIMITS.characters.toLocaleString()} characters.`)}</p>
    <div className="table-builder-options">
      <label className="table-builder-field" htmlFor={`${id}-delimiter`}>{t('구분자', 'Delimiter')}
        <select id={`${id}-delimiter`} value={delimiter} onChange={event => setDelimiter(event.target.value as TableDelimiter)}>
          <option value="auto">{t('자동 감지', 'Auto-detect')}</option>
          <option value=",">{t('쉼표 (CSV)', 'Comma (CSV)')}</option>
          <option value={'\t'}>{t('탭 (TSV)', 'Tab (TSV)')}</option>
          <option value=";">{t('세미콜론', 'Semicolon')}</option>
        </select>
      </label>
      <label className="table-builder-check"><input type="checkbox" checked={header} onChange={event => setHeader(event.target.checked)}/>{t('첫 행을 머리글로 사용', 'Use first row as headers')}</label>
    </div>
    <label className="table-builder-field" htmlFor={`${id}-data`}>{t('표 데이터', 'Table data')}
      <textarea id={`${id}-data`} className="table-builder-input" data-testid="table-data" value={input} onChange={event => setInput(event.target.value)} spellCheck={false} placeholder={t('이름,값\n예시,42', 'Name,Value\nExample,42')} aria-describedby={`${id}-help${showError && parsed.error ? ` ${id}-error` : ''}`} aria-invalid={!!showError && !!parsed.error}/>
    </label>
    <div className="table-builder-metadata">
      <label className="table-builder-field" htmlFor={`${id}-caption`}>{t('캡션 (선택)', 'Caption (optional)')}
        <input id={`${id}-caption`} value={caption} onChange={event => setCaption(event.target.value)} aria-invalid={generated.error?.code === 'caption-size'} aria-describedby={generated.error?.code === 'caption-size' ? `${id}-error` : undefined}/>
      </label>
      <label className="table-builder-field" htmlFor={`${id}-label`}>{t('라벨 (선택)', 'Label (optional)')}
        <input id={`${id}-label`} value={label} onChange={event => setLabel(event.target.value)} placeholder="tab:results" spellCheck={false} aria-invalid={generated.error?.code === 'label'} aria-describedby={`${id}-label-help${generated.error?.code === 'label' ? ` ${id}-error` : ''}`}/>
      </label>
    </div>
    <p className="table-builder-note" id={`${id}-label-help`}>{t('라벨에는 영문자·숫자·: . _ -만 사용할 수 있습니다. 캡션 없이 라벨만 넣어도 표 번호가 매겨집니다.', 'Labels accept ASCII letters, digits and : . _ - only. A label without a caption still assigns a table number.')}</p>
    {showError && error && <p className="table-builder-error" role="alert" id={`${id}-error`}>{errorMessage(error)}</p>}
    {parsed.table ? <>
      <p className="table-builder-note" role="status">{t(`${parsed.table.rows.length}행 × ${parsed.table.rows[0].length}열 · 구분자: ${detectedDelimiterName}`, `${parsed.table.rows.length} rows × ${parsed.table.rows[0].length} columns · Delimiter: ${detectedDelimiterName}`)}</p>
      <div className="table-builder-preview">
        <h3 id={`${id}-preview-heading`}>{t('데이터 미리 보기', 'Data preview')}</h3>
        <div className="table-builder-table-scroll" role="region" aria-labelledby={`${id}-preview-heading`} tabIndex={0}>
          <table aria-label={t('표 데이터 미리 보기', 'Table data preview')}>
            {caption && <caption>{caption}</caption>}
            {header && <thead><tr>{parsed.table.rows[0].map((cell, column) => <th scope="col" key={column}>{cell}</th>)}</tr></thead>}
            <tbody>{parsed.table.rows.slice(header ? 1 : 0).map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </div>
    </> : !showError && <p className="table-builder-empty">{t('데이터를 입력하면 표와 LaTeX 코드가 여기에 표시됩니다.', 'Enter data to preview the table and generated LaTeX here.')}</p>}
    {generated.latex && <label className="table-builder-field" htmlFor={`${id}-latex`}>{t('생성된 LaTeX', 'Generated LaTeX')}
      <textarea id={`${id}-latex`} className="table-builder-code" data-testid="table-latex" value={generated.latex} readOnly spellCheck={false}/>
    </label>}
    <p className="table-builder-note">{t('모든 내용은 일반 텍스트로 처리합니다. 별도 패키지 없이 tabular/table을 사용하며, 글꼴·열 너비·쪽 나눔은 프로젝트에서 확인하세요.', 'All content is treated as plain text. Uses tabular/table without extra packages; check fonts, column widths and page breaks in your project.')}</p>
    <div className="table-builder-actions">
      {!canInsert && <p className="table-builder-note" id={`${id}-unavailable`}>{t('편집 가능한 LaTeX 소스 파일을 열고 커서 위치를 선택하세요.', 'Open an editable LaTeX source file and choose the cursor position.')}</p>}
      <button type="button" className="primary" data-testid="table-insert" disabled={!canInsert || !generated.latex} aria-describedby={!canInsert ? `${id}-unavailable` : undefined} onClick={() => { if (canInsert && generated.latex) onInsert(generated.latex); }}>{t('커서 위치에 삽입', 'Insert at cursor')}</button>
    </div>
  </section>;
}
