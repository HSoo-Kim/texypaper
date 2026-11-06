import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { selectionCase, texInsertion, type TexInsertion } from './editorCommands';

describe('TeX toolbar transactions',()=>{
  it.each<[TexInsertion,string]>([
    ['bold','\\textbf{word}'],['italic','\\textit{word}'],['section','\\section{word}'],
    ['cite','\\cite{word}'],['ref','\\ref{word}'],['math','$word$'],
    ['itemize','\\begin{itemize}\n  \\item word\n\\end{itemize}'],
  ])('wraps the selection for %s', (command,expected)=>{
    const state=EditorState.create({doc:'word',selection:{anchor:0,head:4}});
    const transaction=state.update(texInsertion(state,command)!);
    expect(transaction.newDoc.toString()).toBe(expected);
    expect(transaction.state.sliceDoc(transaction.newSelection.main.from,transaction.newSelection.main.to)).toBe('word');
    expect(transaction.isUserEvent('input')).toBe(true);
  });
  it('places an empty selection inside the inserted command',()=>{
    const state=EditorState.create({doc:'abc',selection:{anchor:1}});
    const next=state.update(texInsertion(state,'bold')!).state;
    expect(next.doc.toString()).toBe('a\\textbf{}bc');
    expect(next.selection.main.empty).toBe(true);
    expect(next.selection.main.head).toBe(9);
  });
  it('keeps reverse selections and edits all cursors atomically',()=>{
    const state=EditorState.create({doc:'one two',extensions:[EditorState.allowMultipleSelections.of(true)],selection:EditorSelection.create([EditorSelection.range(3,0),EditorSelection.range(4,7)])});
    const next=state.update(texInsertion(state,'math')!).state;
    expect(next.doc.toString()).toBe('$one$ $two$');
    expect(next.selection.ranges.map(range=>[range.anchor,range.head])).toEqual([[4,1],[7,10]]);
  });
  it('inserts real lines in CRLF documents',()=>{
    const state=EditorState.create({doc:'word',selection:{anchor:0,head:4},extensions:[EditorState.lineSeparator.of('\r\n')]});
    const next=state.update(texInsertion(state,'itemize')!).state;
    expect(next.doc.lines).toBe(3);
    expect(next.sliceDoc()).toBe('\\begin{itemize}\r\n  \\item word\r\n\\end{itemize}');
  });
  it('cannot mutate a read-only document',()=>{
    const state=EditorState.create({doc:'protected',extensions:[EditorState.readOnly.of(true)]});
    expect(texInsertion(state,'bold')).toBeNull();
    expect(state.doc.toString()).toBe('protected');
  });
});

describe('selection case transactions',()=>{
  it('preserves all reversed selections when Unicode changes their length',()=>{
    const state=EditorState.create({doc:'straße foo',extensions:[EditorState.allowMultipleSelections.of(true)],selection:EditorSelection.create([EditorSelection.range(6,0),EditorSelection.range(7,10)])});
    const transaction=state.update(selectionCase(state,true)!);
    expect(transaction.newDoc.toString()).toBe('STRASSE FOO');
    expect(transaction.newSelection.ranges.map(range=>[range.anchor,range.head])).toEqual([[7,0],[8,11]]);
    expect(transaction.isUserEvent('input')).toBe(true);
  });
  it('does nothing for an empty selection or a read-only document',()=>{
    expect(selectionCase(EditorState.create({doc:'word'}),true)).toBeNull();
    expect(selectionCase(EditorState.create({doc:'word',selection:{anchor:0,head:4},extensions:[EditorState.readOnly.of(true)]}),false)).toBeNull();
  });
});
