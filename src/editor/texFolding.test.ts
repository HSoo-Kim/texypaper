import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { texCodeBeforeComment, texFoldRange } from './texFolding';

function range(doc:string,line:number){
  const state=EditorState.create({doc});
  return {state,fold:texFoldRange(state,state.doc.line(line).from)};
}

describe('TeX folding ranges',()=>{
  it('matches nested environments, including repeated environment names',()=>{
    const {state,fold}=range('\\begin{itemize}\nouter\n\\begin{itemize}\ninner\n\\end{itemize}\n\\end{itemize}',1);
    expect(fold).toEqual({from:state.doc.line(1).to,to:state.doc.line(6).from});
    expect(texFoldRange(state,state.doc.line(3).from)).toEqual({from:state.doc.line(3).to,to:state.doc.line(5).from});
  });
  it('does not fold unmatched or single-line environments',()=>{
    expect(range('\\begin{a}\ntext\n\\end{b}',1).fold).toBeNull();
    expect(range('\\begin{a}text\\end{a}',1).fold).toBeNull();
    expect(range('\\end{a}\ntext',1).fold).toBeNull();
  });
  it('does not let a single-line literal environment swallow later blocks',()=>{
    const {state}=range('\\begin{verbatim}literal\\end{verbatim}\n\\begin{real}\nbody\n\\end{real}',1);
    expect(texFoldRange(state,0)).toBeNull();
    expect(texFoldRange(state,state.doc.line(2).from)).toEqual({from:state.doc.line(2).to,to:state.doc.line(4).from});
  });
  it('ignores commented and escaped commands while recognizing commands after escaped percent signs',()=>{
    const {state,fold}=range('% \\begin{ignored}\n\\\\begin{escaped}\n\\% \\begin{real}\nbody\n\\end{real}',3);
    expect(texFoldRange(state,0)).toBeNull();
    expect(texFoldRange(state,state.doc.line(2).from)).toBeNull();
    expect(fold).toEqual({from:state.doc.line(3).to,to:state.doc.line(5).from});
    expect(texCodeBeforeComment('text \\% visible % hidden')).toBe('text \\% visible ');
    expect(texCodeBeforeComment('text \\\\% hidden')).toBe('text \\\\');
  });
  it('folds section hierarchy until the next same/higher heading',()=>{
    const {state,fold}=range('\\section{A}\nintro\n\\subsection{A1}\nbody\n\\subsection*{A2}\nmore\n\\section[short]{B}\ntail',1);
    expect(fold).toEqual({from:state.doc.line(1).to,to:state.doc.line(7).from-1});
    expect(texFoldRange(state,state.doc.line(3).from)).toEqual({from:state.doc.line(3).to,to:state.doc.line(5).from-1});
    expect(texFoldRange(state,state.doc.line(5).from)).toEqual({from:state.doc.line(5).to,to:state.doc.line(7).from-1});
    expect(texFoldRange(state,state.doc.line(7).from)).toEqual({from:state.doc.line(7).to,to:state.doc.length});
  });
  it('bounds the final section at its enclosing environment end',()=>{
    const {state}=range('\\begin{document}\n\\section{A}\nbody\n\\end{document}\ntrailer',1);
    expect(texFoldRange(state,state.doc.line(2).from)).toEqual({from:state.doc.line(2).to,to:state.doc.line(4).from});
  });
  it.each(['verbatim','verbatim*','Verbatim','lstlisting','minted','comment'])('ignores fake commands inside %s',name=>{
    const {state,fold}=range(`\\begin{${name}}\n\\begin{fake}\n\\section{fake}\n\\end{${name}}`,1);
    expect(fold).toEqual({from:state.doc.line(1).to,to:state.doc.line(4).from});
    expect(texFoldRange(state,state.doc.line(2).from)).toBeNull();
    expect(texFoldRange(state,state.doc.line(3).from)).toBeNull();
  });
  it('updates ranges after an edit instead of using a stale document index',()=>{
    const {state,fold}=range('\\begin{a}\nbody\n\\end{a}',1);
    const changed=state.update({changes:{from:state.doc.line(2).to,insert:'\nmore'}}).state;
    expect(texFoldRange(changed,0)?.to).toBe(fold!.to+5);
    expect(texFoldRange(state,0)).toEqual(fold);
  });
  it('indexes many independent blocks without a suffix scan per folding request',()=>{
    const block='\\begin{a}\nx\n\\end{a}\n',state=EditorState.create({doc:block.repeat(2000)});
    for(let line=1;line<=6000;line+=3)expect(texFoldRange(state,state.doc.line(line).from)).toEqual({from:state.doc.line(line).to,to:state.doc.line(line+2).from});
  });
});
