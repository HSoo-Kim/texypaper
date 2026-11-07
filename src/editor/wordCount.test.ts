import { describe, expect, it } from 'vitest';
import { countWords, countSelection } from './wordCount';
describe('source prose word count',()=>{
  it('counts a real paper fragment, excluding preamble, citations, comments and math',()=>{
    const text=String.raw`\documentclass{article}
\title{Not counted}
\begin{document}
\section{A small experiment}
We measure \emph{three useful signals}~\citep{secretkey}.
% hidden words
The result is $x + y = 2$.
\begin{align}hidden &= words\end{align}
\caption{Measured response times}
\end{document}`;
    expect(countWords(text).words).toBe(14);
  });
  it('counts whitespace-separated Hangul and CJK runs without dictionary segmentation',()=>{
    expect(countWords('한국어 문장입니다. 中文段落 日本語の文章 English words').words).toBe(6);
  });
  it('counts contractions and hyphenated words once but excludes standalone numbers',()=>{
    expect(countWords("Don't count twenty-one 123 as words; naïve café and NASA count.").words).toBe(10);
  });
  it('counts visible prose code points including whitespace and punctuation',()=>{
    expect(countWords('A 😀 한글.')).toEqual({words:2,characters:7});
    expect(countWords(String.raw`\textbf{Hello}!`)).toEqual({words:1,characters:6});
    expect(countWords('')).toEqual({words:0,characters:0});
  });
  it('uses complete document context for a selection inside multiline math or comments',()=>{
    const text=String.raw`Before $hidden
math words$ after % secret words
Last sentence.`;
    const from=text.indexOf('math'),to=from+'math words'.length;
    expect(countSelection(text,from,to).words).toBe(0);
    expect(countSelection(text,text.indexOf('secret'),text.indexOf('\nLast')).words).toBe(0);
    expect(countSelection(text,text.indexOf('Last'),text.length)).toEqual({words:2,characters:14});
  });
  it('clamps and reverses selection bounds and counts partial selected words once',()=>{
    expect(countSelection('First second',8,2)).toEqual({words:2,characters:6});
    expect(countSelection('First second',-20,200)).toEqual(countWords('First second'));
    expect(countSelection('First second',5,5)).toEqual({words:0,characters:0});
  });
});
