import { describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { StreamLanguage, syntaxTree } from '@codemirror/language';
import {classHighlighter,highlightTree} from '@lezer/highlight';
import { languageFor } from './SourceEditor';

describe('TeX language lifetime',()=>{
  it('constructs TeX only on first use and shares its registered Document type across buffers',async()=>{
    const define=vi.spyOn(StreamLanguage,'define');
    try{
      expect(await languageFor('notes.txt')).toEqual([]);
      expect(define).not.toHaveBeenCalled();
      const first=await languageFor('paper/main.tex');
      const paths=['other.tex','chapter.LTX','style.sty','class.cls','references.bib','style.bst','style.bbx','style.cbx'];
      const extensions=await Promise.all(paths.map(path=>languageFor(path)));
      for(const extension of extensions)expect(extension).toBe(first);
      expect(define).toHaveBeenCalledTimes(1);
      const firstState=EditorState.create({doc:'\\section{First}\nText.',extensions:[first]});
      const otherState=EditorState.create({doc:'\\section{Other}\nDifferent text.',extensions:[extensions[0]]});
      expect(syntaxTree(firstState).type.name).toBe('Document');
      expect(syntaxTree(otherState).type).toBe(syntaxTree(firstState).type);
      for(let cycle=0;cycle<40;cycle++)expect(await languageFor(`project-${cycle}/main.tex`)).toBe(first);
      expect(define).toHaveBeenCalledTimes(1);
    }finally{define.mockRestore();}
  });
  it('exposes TeX control sequences as type-name tokens without recoloring prose or comments',async()=>{
    const doc='\\centering\n\\section{Title}\n\\textbf{Bold}\n\\begin{document}\nOrdinary text % comment';
    const state=EditorState.create({doc,extensions:[await languageFor('main.tex')]});
    const highlighted:{text:string;classes:string}[]=[];
    highlightTree(syntaxTree(state),classHighlighter,(from,to,classes)=>highlighted.push({text:doc.slice(from,to),classes}));
    for(const command of ['\\centering','\\section','\\textbf','\\begin'])expect(highlighted.find(token=>token.text===command)?.classes.split(' ')).toContain('tok-typeName');
    expect(highlighted.find(token=>token.text.includes('% comment'))?.classes).toBe('tok-comment');
    expect(highlighted.some(token=>token.text.includes('Ordinary')&&token.classes.includes('tok-typeName'))).toBe(false);
  });
});
