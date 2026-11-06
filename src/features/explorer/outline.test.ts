import { describe, expect, it } from 'vitest';
import { MAX_OUTLINE_BYTES, MAX_OUTLINE_HEADINGS, parseOutline } from './outline';

describe('active TeX outline parser',()=>{
  it('recognizes section levels, starred forms and optional short titles',()=>{
    const source='\\section{Introduction}\n\\subsection*[Short]{Long title}\n\\subsubsection [A {nested ] title}]{Details}';
    expect(parseOutline(source)).toEqual([
      {line:1,level:1,title:'Introduction',starred:false},
      {line:2,level:2,title:'Long title',starred:true},
      {line:3,level:3,title:'Details',starred:false},
    ]);
  });
  it('ignores comments and escaped commands without losing line positions',()=>{
    const source='% \\section{Hidden}\r\n\\\\section{Escaped}\r\n\\section % comment\r\n {Visible}';
    expect(parseOutline(source)).toEqual([{line:3,level:1,title:'Visible',starred:false}]);
  });
  it('balances nested title braces, escaped percent and multiline comments',()=>{
    const source='\\section{A \\textbf{nested} title \\% % hidden }\ncontinued}';
    expect(parseOutline(source)[0]).toEqual({line:1,level:1,title:'A nested title % continued',starred:false});
  });
  it('tracks lone CR and CRLF lines and headings after multiline titles',()=>{
    const source='before\r\\section{One\r\ntwo}\n\\subsection{Three}';
    expect(parseOutline(source).map(({line,title})=>({line,title}))).toEqual([{line:2,title:'One two'},{line:4,title:'Three'}]);
  });
  it('does not treat similarly named commands as headings or accept incomplete groups',()=>{
    expect(parseOutline('\\sectionname{No} \\constructor{No} \\subsections{No}\n\\section{Unclosed')).toEqual([]);
    expect(parseOutline('\\section[Unclosed')).toEqual([]);
  });
  it('stops after 500 headings',()=>{
    const headings=parseOutline(Array.from({length:MAX_OUTLINE_HEADINGS+20},(_,index)=>`\\section{Heading ${index}}`).join('\n'));
    expect(headings).toHaveLength(MAX_OUTLINE_HEADINGS);
    expect(headings.at(-1)?.title).toBe('Heading 499');
  });
  it('includes a complete heading at the 4 MiB boundary and ignores later input',()=>{
    const heading='\\section{Last}';
    expect(parseOutline('a'.repeat(MAX_OUTLINE_BYTES-heading.length)+heading+'\n\\section{Outside}')).toEqual([{line:1,level:1,title:'Last',starred:false}]);
  });
  it('bounds UTF-8 bytes rather than UTF-16 characters',()=>{
    expect(parseOutline('가'.repeat(Math.ceil(MAX_OUTLINE_BYTES/3))+'\n\\section{Outside}')).toEqual([]);
    expect(parseOutline('😀'.repeat(MAX_OUTLINE_BYTES/4)+'\n\\section{Outside}')).toEqual([]);
  });
});
