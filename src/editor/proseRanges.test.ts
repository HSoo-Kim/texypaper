import { describe, expect, it } from 'vitest';
import { proseRanges, proseRangeIterator, spellingText } from './proseRanges';
const words=(text:string)=>spellingText(text).match(/[A-Za-z]+(?:'[A-Za-z]+)*/g)??[];
describe('TeX prose ranges',()=>{
  it('skips preamble, including document markers in comments, and stops at document end',()=>{
    const text=String.raw`\documentclass{article}
% \begin{document} fake
\newcommand{\foo}{hidden}
\begin{document}Actual prose.\end{document}ignored`;
    expect(words(text)).toEqual(['Actual','prose']);
  });
  it('works for included chapter files without a document environment',()=>{
    expect(words(String.raw`\section[Short]{A real title}\label{sec:longkey}
\textbf{Bold words} and \emph{emphasis}.\footnote{A note}\item First item`)).toEqual(['A','real','title','Bold','words','and','emphasis','A','note','First','item']);
  });
  it('distinguishes escaped percent and escaped backslashes from comments',()=>{
    expect(words(String.raw`Before \% after % hidden
Next \\% hidden again
Last`)).toEqual(['Before','after','Next','Last']);
  });
  it.each(['$hidden$', '$$hidden$$',String.raw`\(hidden\)`,String.raw`\[hidden\]`])('skips inline and display math %s',math=>{
    expect(words(`Before ${math} after`)).toEqual(['Before','after']);
  });
  it.each(['equation','equation*','align','align*','gather','gather*','multline','multline*','eqnarray','eqnarray*','math','displaymath','verbatim','lstlisting','minted','comment'])('excludes %s environments',environment=>{
    expect(words(`Before \\begin{${environment}}{python}hidden $ \\textbf{alsohidden}\\end{${environment}} after`)).toEqual(['Before','after']);
  });
  it.each(['label','ref','eqref','autoref','cref','Cref','pageref','cite','citep','citet','parencite','textcite','nocite','input','include','includegraphics','usepackage','documentclass','bibliography','bibliographystyle','url'])('excludes technical arguments of %s',command=>{
    expect(words(`Before \\${command}*[metadata]{nested{secret}key} after`)).toEqual(['Before','after']);
  });
  it('skips multicite keys and keeps href display text',()=>{
    expect(words(String.raw`Read \cites[see]{first}[also]{second} \href{https://host/key}{the visible link}.`)).toEqual(['Read','the','visible','link']);
  });
  it.each([String.raw`\newcommand{\foo}[2][default]{hidden #1}`,String.raw`\renewcommand\foo[1]{hidden}`,String.raw`\providecommand{\foo}{hidden}`,String.raw`\DeclareRobustCommand{\foo}{hidden}`,String.raw`\DeclareMathOperator*{\foo}{hidden}`,String.raw`\def\foo#1{hidden {nested}}`,String.raw`\gdef\foo{hidden}`,String.raw`\newenvironment{foo}[1]{hidden}{alsohidden}`])('does not check macro definitions %s',definition=>{
    expect(words(`Before ${definition} after`)).toEqual(['Before','after']);
  });
  it('excludes inline verbatim commands and unbraced input paths',()=>{
    expect(words(String.raw`Before \verb|hidden words| \verb*+morehidden+ \lstinline[language=Python]!hidden! \input chapterfile.tex after`)).toEqual(['Before','after']);
  });
  it('treats unclosed math, hidden groups and verbatim conservatively',()=>{
    expect(words('Before $hidden after')).toEqual(['Before']);
    expect(words(String.raw`Before \cite{hidden after`)).toEqual(['Before']);
    expect(words(String.raw`Before \begin{verbatim}hidden after`)).toEqual(['Before']);
  });
  it('keeps valid sorted UTF-16 ranges through astral and non-ASCII text',()=>{
    const text=String.raw`😀 한글 \emph{English} $math$ 後文`;
    const ranges=proseRanges(text);let previous=0;
    for(const range of ranges){expect(range.start).toBeGreaterThanOrEqual(previous);expect(range.end).toBeGreaterThan(range.start);expect(range.end).toBeLessThanOrEqual(text.length);previous=range.end;}
    const prepared=spellingText(text);expect(prepared).toHaveLength(text.length);expect(prepared.indexOf('English')).toBe(text.indexOf('English'));expect(prepared).not.toMatch(/[한글後文😀]/u);
  });
  it('filters whole identifiers, Unicode words, acronyms, camelCase and ignored words',()=>{
    const text="Correct don't NASA CPU camelCase foo42 café 한글English nice-word under_score O'Neill UPPER MiXeD wrng";
    expect(words(text)).toEqual(['Correct',"don't","O'Neill",'wrng']);
    const prepared=spellingText(text,proseRanges(text),['WRNG']);expect(prepared).toHaveLength(text.length);expect(prepared).not.toContain('wrng');
  });
  it('handles comments between commands and technical arguments and inside math',()=>{
    expect(words(String.raw`Before \cite% ignored
{hiddenkey} \begin% ignored
{equation} % \end{equation}
hidden \end {equation} after`)).toEqual(['Before','after']);
  });
  it('does not mistake a document marker inside a definition or verbatim for the preamble end',()=>{
    expect(words(String.raw`\newcommand{\start}{\begin{document}}
\verb|\begin{document}| hiddenpreamble
\begin{document}Actual prose.\end{document}`)).toEqual(['Actual','prose']);
  });
  it.each([String.raw`\NewDocumentCommand{\foo}{m} {hidden #1}`,String.raw`\RenewDocumentEnvironment{foo}{m} {hidden} {alsohidden}`])('skips xparse definitions %s',definition=>{
    expect(words(`Before ${definition} after`)).toEqual(['Before','after']);
  });
  it('yields cooperatively in long hidden groups and never checks a long-token tail',()=>{
    const text=String.raw`\cite{`+'hidden'.repeat(2000)+'} after';
    expect([...proseRangeIterator(text)].some(range=>range===null)).toBe(true);
    expect(words(text)).toEqual(['after']);
    expect(words('a'.repeat(4097))).toEqual([]);
  });
});
