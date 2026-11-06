import { describe, expect, it } from 'vitest';
import { MAX_OUTLINE_BYTES, MAX_OUTLINE_HEADINGS, parseOutline } from './outline';

describe('active TeX outline parser',()=>{
  it('recognizes section levels, starred forms and optional short titles',()=>{
    const source='\\section{Introduction}\n\\subsection*[Short]{Long title}\n\\subsubsection [A {nested ] title}]{Details}';
    expect(parseOutline(source)).toEqual([
      {line:1,level:1,title:'Introduction',starred:false,number:'1'},
      {line:2,level:2,title:'Long title',starred:true,number:null},
      {line:3,level:3,title:'Details',starred:false,number:'1.0.1'},
    ]);
  });
  it('ignores comments and escaped commands without losing line positions',()=>{
    const source='% \\section{Hidden}\r\n\\\\section{Escaped}\r\n\\section % comment\r\n {Visible}';
    expect(parseOutline(source)).toEqual([{line:3,level:1,title:'Visible',starred:false,number:'1'}]);
  });
  it('balances nested title braces, escaped percent and multiline comments',()=>{
    const source='\\section{A \\textbf{nested} title \\% % hidden }\ncontinued}';
    expect(parseOutline(source)[0]).toEqual({line:1,level:1,title:'A nested title % continued',starred:false,number:'1'});
  });
  it('tracks lone CR and CRLF lines and headings after multiline titles',()=>{
    const source='before\r\\section{One\r\ntwo}\n\\subsection{Three}';
    expect(parseOutline(source).map(({line,title})=>({line,title}))).toEqual([{line:2,title:'One two'},{line:4,title:'Three'}]);
  });
  it('does not treat similarly named commands as headings or accept incomplete groups',()=>{
    expect(parseOutline('\\sectionname{No} \\constructor{No} \\subsections{No}\n\\section{Unclosed')).toEqual([]);
    expect(parseOutline('\\section[Unclosed')).toEqual([]);
  });
  it('numbers each level and resets descendants under the next numbered parent',()=>{
    const source=[
      '\\section{First}','\\subsection{Child}','\\subsubsection{Detail}',
      '\\subsubsection{Next detail}','\\subsection{Next child}','\\subsubsection{Reset detail}',
      '\\section{Second}','\\subsection{Reset child}','\\subsubsection{New detail}',
    ].join('\n');
    expect(parseOutline(source).map(({number})=>number)).toEqual(['1','1.1','1.1.1','1.1.2','1.2','1.2.1','2','2.1','2.1.1']);
  });
  it('leaves starred headings unnumbered without advancing or resetting counters',()=>{
    const source=[
      '\\section*{Preface}','\\section{First}','\\subsection{Child}','\\subsubsection{Detail}',
      '\\section*{Interlude}','\\subsection*{Aside}','\\subsubsection*{Note}',
      '\\subsubsection{Next detail}','\\subsection{Next child}','\\section{Second}',
    ].join('\n');
    expect(parseOutline(source).map(({line,number})=>({line,number}))).toEqual([
      {line:1,number:null},{line:2,number:'1'},{line:3,number:'1.1'},{line:4,number:'1.1.1'},
      {line:5,number:null},{line:6,number:null},{line:7,number:null},
      {line:8,number:'1.1.2'},{line:9,number:'1.2'},{line:10,number:'2'},
    ]);
  });
  it('derives numbering afresh for edited source and separate files',()=>{
    expect(parseOutline('\\section{First}\\section{Second}').map(({number})=>number)).toEqual(['1','2']);
    expect(parseOutline('\\section{Second}')[0].number).toBe('1');
    expect(parseOutline('\\subsection{Standalone child}')[0].number).toBe('0.1');
    expect(parseOutline('\\section{Another file}')[0].number).toBe('1');
  });
  it('stops after 500 headings',()=>{
    const headings=parseOutline(Array.from({length:MAX_OUTLINE_HEADINGS+20},(_,index)=>`\\section{Heading ${index}}`).join('\n'));
    expect(headings).toHaveLength(MAX_OUTLINE_HEADINGS);
    expect(headings.at(-1)?.title).toBe('Heading 499');
  });
  it('includes a complete heading at the 4 MiB boundary and ignores later input',()=>{
    const heading='\\section{Last}';
    expect(parseOutline('a'.repeat(MAX_OUTLINE_BYTES-heading.length)+heading+'\n\\section{Outside}')).toEqual([{line:1,level:1,title:'Last',starred:false,number:'1'}]);
  });
  it('bounds UTF-8 bytes rather than UTF-16 characters',()=>{
    expect(parseOutline('가'.repeat(Math.ceil(MAX_OUTLINE_BYTES/3))+'\n\\section{Outside}')).toEqual([]);
    expect(parseOutline('😀'.repeat(MAX_OUTLINE_BYTES/4)+'\n\\section{Outside}')).toEqual([]);
  });
});
