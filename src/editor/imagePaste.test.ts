import { describe, expect, it } from 'vitest';
import { includeGraphicsSnippet, isEditorAsset, pastedImageName } from './imagePaste';

describe('image paste helpers', () => {
  it('creates a full figure with a path relative to a nested TeX source', () => {
    expect(includeGraphicsSnippet('figures/result_plot.PNG', 'sections/results')).toBe('\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{../../figures/result_plot}\n  \\caption{}\n  \\label{fig:result_plot}\n\\end{figure}\n');
  });
  it.each([['paper/figures/chart.pdf', 'paper', 'figures/chart'], ['figures/chart.svg', '', 'figures/chart.svg'], ['figures/chart.webp', 'figures', 'chart.webp'], ['figures\\chart.eps', 'sections', '../figures/chart'], ['figures/한글.png', '', 'figures/한글']])('normalizes %s from %s', (path, directory, expected) => {
    expect(includeGraphicsSnippet(path, directory)).toContain(`{${expected}}`);
  });
  it('retains extensions not in the default LaTeX graphics search list', () => {
    expect(includeGraphicsSnippet('chart.gif', '')).toContain('{chart.gif}');
  });
  it('names pasted images with a padded local timestamp', () => {
    expect(pastedImageName(new Date(2026, 0, 2, 3, 4, 5))).toBe('pasted-image-20260102-030405.png');
  });
  it('only accepts image/PDF file drops', () => {
    expect(isEditorAsset({ name: 'chart.PDF', type: '' })).toBe(true);
    expect(isEditorAsset({ name: 'chart.eps', type: 'application/postscript' })).toBe(true);
    expect(isEditorAsset({ name: 'clipboard', type: 'image/png' })).toBe(true);
    expect(isEditorAsset({ name: 'main.tex', type: 'text/plain' })).toBe(false);
  });
});
