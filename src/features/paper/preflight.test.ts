import { describe, expect, it } from 'vitest';
import { analyzePreflight } from './preflight';
import type { PaperCorpus } from './types';

function corpus(files: Record<string, string>): PaperCorpus {
  return { files: Object.entries(files).map(([path, text]) => ({ path, text })), skipped: [], complete: true };
}
describe('conservative paper preflight', () => {
  it('accepts ordinary literal citations and comma references in the selected root graph', () => {
    const report = analyzePreflight(corpus({
      'main.tex': String.raw`\documentclass{article}
\addbibresource[location=local]{refs.bib}
\begin{document}
\input{sections/body}
\printbibliography
\end{document}`,
      'sections/body.tex': String.raw`\section{Introduction}\label{sec:intro}
\begin{equation}1=1\label{eq:one}\end{equation}
\citet[see][p.~2]{doe} \citep*{roe,doe} \autocite{doe} \parencite{roe}
\eqref{eq:one} \autoref{sec:intro} \Cref{sec:intro,eq:one}`,
      'refs.bib': '@article{doe,title={One},author={Doe},year=2024}\n@book{roe,title={Two},year=2025}',
      'unrelated.tex': String.raw`\cite{not-in-this-paper}\label{sec:intro}`,
    }), 'main.tex');
    expect(report.issues).toEqual([]);
    expect(report.complete).toBe(true);
    expect(report.texFiles).toEqual(['main.tex', 'sections/body.tex']);
    expect(report.bibFiles).toEqual(['refs.bib']);
    expect(report.citationCount).toBe(5);
    expect(report.referenceCount).toBe(4);
  });
  it('recognizes bibliography lists, multicites and bibitem optional labels', () => {
    const report = analyzePreflight(corpus({
      'main.tex': String.raw`\bibliography{one,two}
\cites[compare][2]{one}[3]{two}\nocite{*}
\begin{thebibliography}{9}\bibitem[Local, 2026]{local}Local\end{thebibliography}
\cite{local}`,
      'one.bib': '@article{one,title={One}}', 'two.bib': '@article{two,title={Two}}',
    }), 'main.tex');
    expect(report.issues).toEqual([]);
    expect(report.citationCount).toBe(3);
  });
  it('does not use unrelated project metadata to validate root citations', () => {
    const report = analyzePreflight(corpus({ 'main.tex': String.raw`\cite{notloaded}`, 'unrelated.bib': '@article{notloaded,title={Unloaded}}' }), 'main.tex');
    expect(report.bibFiles).toEqual([]);
    expect(report.issues).toContainEqual({ path: 'main.tex', line: 1, code: 'missing-citation', detail: 'notloaded' });
  });
  it('suppresses comments, escaped commands, literal environments, inline code and text after document end', () => {
    const report = analyzePreflight(corpus({ 'main.tex': String.raw`% \cite{comment} TODO fix prose
\\cite{escaped}
\verb|\cite{verb}% TODO ignored|
\lstinline[language=TeX]|\ref{listing}|
\mintinline{tex}{\cite{minted}}
\begin{verbatim}
\cite{verbatim} % TODO ignored
\end{verbatim}
\begin{lstlisting}\cite{listing}\end{lstlisting}
\begin{comment}\ref{comment}\end{comment}
\end{document}
\cite{afterend} % TODO ignored` }), 'main.tex');
    expect(report.issues).toEqual([{ path: 'main.tex', line: 1, code: 'todo', detail: 'TODO fix prose' }]);
    expect(report.citationCount).toBe(0);
  });
  it('handles comments between commands and argument groups, including literal environments', () => {
    const report = analyzePreflight(corpus({ 'main.tex': String.raw`\begin % comment
{verbatim}
\cite{notactive}
\end{verbatim}
\bibitem % comment
[Display]{key}
\cite % comment
[see]{key}` }), 'main.tex');
    expect(report.issues).toEqual([]);
    expect(report.citationCount).toBe(1);
  });
  it('retains source paths and CRLF lines for missing definitions and TODO commands', () => {
    const report = analyzePreflight(corpus({ 'main.tex': '\\input{body}', 'body.tex': '\\ref{absent}\r\n\\cite{missing}\r\\todo[inline]{Finish this}' }), 'main.tex');
    expect(report.issues).toContainEqual({ path: 'body.tex', line: 1, code: 'missing-label', detail: 'absent' });
    expect(report.issues).toContainEqual({ path: 'body.tex', line: 2, code: 'missing-citation', detail: 'missing' });
    expect(report.issues).toContainEqual({ path: 'body.tex', line: 3, code: 'todo', detail: 'Finish this' });
  });
  it('finds duplicate labels and citation keys across reachable files and manual items', () => {
    const report = analyzePreflight(corpus({
      'main.tex': String.raw`\bibliography{refs}\label{same}\input{body}\bibitem{key}`,
      'body.tex': String.raw`\label{same}`, 'refs.bib': '@article{key,title={Title}}',
    }), 'main.tex');
    expect(report.issues.filter(issue => issue.code === 'duplicate-label').map(issue => issue.path).sort()).toEqual(['body.tex', 'main.tex']);
    expect(report.issues.filter(issue => issue.code === 'duplicate-key').map(issue => issue.path).sort()).toEqual(['main.tex', 'refs.bib']);
  });
  it('does not mistake macro template bodies for executed citations or labels', () => {
    const report = analyzePreflight(corpus({ 'main.tex': String.raw`\newcommand{\mycite}[1]{\cite{#1}}
\def\mylabel#1{\label{#1}}
\newcommand{\prose}{Text % unmatched } in comment
continued}
\mycite{dynamic}` }), 'main.tex');
    expect(report.issues.every(issue => issue.code === 'coverage')).toBe(true);
    expect(report.issues.some(issue => issue.detail === 'macro-generated-references')).toBe(true);
    expect(report.complete).toBe(false);
  });
  it('discards known false code but preserves the active else branch', () => {
    const report = analyzePreflight(corpus({ 'main.tex': String.raw`\iffalse
\cite{hidden}\iftrue\ref{nested}\fi
\else
\bibitem{active}\cite{active}
\fi` }), 'main.tex');
    expect(report.issues).toEqual([]);
    expect(report.citationCount).toBe(1);
  });
  it('reports uncertainty for dynamic keys, paths, conditionals and malformed literal regions', () => {
    const report = analyzePreflight(corpus({ 'main.tex': String.raw`\ifdefined\foo\cite{\macro}\fi
\input{\generated}\addbibresource{https://example.test/refs.bib}
\begin{verbatim}
\cite{ignored}` }), 'main.tex');
    expect(report.complete).toBe(false);
    expect(report.issues.filter(issue => issue.code === 'coverage').map(issue => issue.detail)).toEqual(expect.arrayContaining(['conditional-or-dynamic-tex', 'dynamic-reference-key', 'dynamic-input', 'dynamic-bibliography', 'unclosed-verbatim']));
    expect(report.issues.some(issue => issue.code === 'missing-citation')).toBe(false);
  });
  it('reports missing source/bibliography files at their referring source lines', () => {
    const report = analyzePreflight(corpus({ 'main.tex': '\\input{missing}\n\\bibliography{lost}' }), 'main.tex');
    expect(report.complete).toBe(false);
    expect(report.issues.filter(issue => issue.code === 'missing-file')).toEqual([
      { path: 'main.tex', line: 1, code: 'missing-file', detail: 'missing' },
      { path: 'main.tex', line: 2, code: 'missing-file', detail: 'lost' },
    ]);
  });
  it('discloses incomplete scans and an absent root instead of reporting all clear', () => {
    const project = corpus({ 'main.tex': 'Plain text' }); project.complete = false;
    project.skipped.push({ path: 'private.bib', reason: 'unreadable' });
    const report = analyzePreflight(project, null);
    expect(report.complete).toBe(false);
    expect(report.issues).toContainEqual({ path: 'private.bib', line: 1, code: 'coverage', detail: 'skipped:unreadable' });
    expect(report.issues.some(issue => issue.detail === 'no-root-selected')).toBe(true);
    expect(analyzePreflight(corpus({ 'other.tex': 'Text' }), 'missing.tex').complete).toBe(false);
  });
  it('bounds graph traversal and warns on cycles, repeated input and includeonly exclusions', () => {
    const report = analyzePreflight(corpus({
      'main.tex': String.raw`\includeonly{body}\input{body}\input{body}\include{excluded}`,
      'body.tex': String.raw`\input{main}`, 'excluded.tex': String.raw`\cite{notactive}`,
    }), 'main.tex');
    expect(report.issues.filter(issue => issue.code === 'coverage').map(issue => issue.detail)).toEqual(expect.arrayContaining(['cyclic-input', 'repeated-input', 'includeonly-active']));
    expect(report.texFiles).not.toContain('excluded.tex');
    expect(report.complete).toBe(false);
  });
  it('does not claim exact validity for case-mismatched citation keys', () => {
    const report = analyzePreflight(corpus({ 'main.tex': String.raw`\bibliography{refs}\cite{KEY}`, 'refs.bib': '@article{key}' }), 'main.tex');
    expect(report.issues).toContainEqual({ path: 'main.tex', line: 1, code: 'coverage', detail: 'citation-key-case:KEY' });
    expect(report.complete).toBe(false);
  });
  it('reports malformed or unknown BibTeX syntax rather than trusting metadata completeness', () => {
    const report = analyzePreflight(corpus({ 'main.tex': String.raw`\bibliography{refs}\cite{key}`, 'refs.bib': '@article{key,title=unknownString}' }), 'main.tex');
    expect(report.issues).toContainEqual({ path: 'refs.bib', line: 1, code: 'bib-syntax', detail: 'unknownstring' });
    expect(report.complete).toBe(false);
    expect(report.issues.some(issue => issue.code === 'missing-citation')).toBe(false);
  });
  it('does not treat inherited object names as TeX commands', () => {
    expect(analyzePreflight(corpus({ 'main.tex': String.raw`\constructor{not-a-citation}` }), 'main.tex').issues).toEqual([]);
  });
  it('keeps TODO comment markers in macro definitions while disclosing generated biblatex citations', () => {
    const report = analyzePreflight(corpus({ 'main.tex': String.raw`\newcommand{\customcite}[1]{% TODO replace wrapper
\parencite{#1}}` }), 'main.tex');
    expect(report.issues).toContainEqual({ path: 'main.tex', line: 1, code: 'todo', detail: 'TODO replace wrapper' });
    expect(report.issues.some(issue => issue.detail === 'macro-generated-references')).toBe(true);
    expect(report.issues.some(issue => issue.code === 'missing-citation')).toBe(false);
  });
});
