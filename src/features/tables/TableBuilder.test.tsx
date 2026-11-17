import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import {TableBuilder} from './TableBuilder';

vi.mock('../../ui/i18n', () => ({useI18n: () => ({t: (korean: string, english?: string) => english ?? korean})}));

describe('embedded table builder contract', () => {
  it('requires valid data before enabling explicit insertion, without inserting on render', () => {
    const onInsert = vi.fn();
    const html = renderToStaticMarkup(<TableBuilder canInsert={true} onInsert={onInsert}/>);
    expect(html).toMatch(/data-testid="table-insert" disabled=""/);
    expect(html).toContain('Insert at cursor');
    expect(html).toContain('Auto-detect');
    expect(html).toContain('Use first row as headers');
    expect(html).toContain('Enter data to preview');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('role="alert"');
    expect(onInsert).not.toHaveBeenCalled();
  });
  it('explains why insertion is unavailable without an editable source', () => {
    const html = renderToStaticMarkup(<TableBuilder canInsert={false} onInsert={vi.fn()}/>);
    expect(html).toMatch(/data-testid="table-insert" disabled=""/);
    expect(html).toContain('Open an editable LaTeX source file');
    expect(html).toContain('Caption (optional)');
    expect(html).toContain('Label (optional)');
  });
});
