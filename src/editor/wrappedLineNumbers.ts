import { gutter, GutterMarker } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/** Number of visual rows a line block occupies. Heights are measured, so round to the nearest row. */
export function wrapRows(blockHeight: number, rowHeight: number): number {
  if (!(blockHeight > 0) || !(rowHeight > 0)) return 1;
  return Math.max(1, Math.round(blockHeight / rowHeight));
}

/** One "↳" per continuation row, joined by newlines for `white-space: pre`. */
export function continuationMarks(rows: number): string {
  return Array.from({ length: Math.max(0, rows - 1) }, () => '↳').join('\n');
}

/** Same digit-width reservation as CodeMirror's own line number gutter (9, 99, 999, ...). */
function widest(lines: number): number {
  let last = 9;
  while (last < lines) last = last * 10 + 9;
  return last;
}

class NumberMarker extends GutterMarker {
  constructor(readonly line: number, readonly rows: number) { super(); }
  eq(other: GutterMarker): boolean { return other instanceof NumberMarker && other.line === this.line && other.rows === this.rows; }
  toDOM(): Node {
    // The text content stays the plain line number; continuation rows are generated CSS content
    // (see the editor theme), so they never become part of the number or of any text query.
    const element = document.createElement('div');
    element.className = 'cm-wrapped-number';
    element.textContent = String(this.line);
    if (this.rows > 1) element.dataset.wrap = continuationMarks(this.rows);
    return element;
  }
}

/**
 * Line numbers that keep the source line number on the first row of a soft-wrapped line and mark
 * every further row of the same line with a muted "↳", so build errors and SyncTeX still quote
 * the numbers shown here.
 */
export function wrappedLineNumbers(): Extension {
  return gutter({
    class: 'cm-lineNumbers',
    renderEmptyElements: false,
    lineMarker(view, line, others) {
      if (others.some(marker => marker.toDOM)) return null;
      return new NumberMarker(view.state.doc.lineAt(line.from).number, wrapRows(line.height, view.defaultLineHeight));
    },
    initialSpacer: view => new NumberMarker(widest(view.state.doc.lines), 1),
    updateSpacer(spacer, update) {
      const width = widest(update.state.doc.lines);
      return spacer instanceof NumberMarker && spacer.line === width ? spacer : new NumberMarker(width, 1);
    },
  });
}
