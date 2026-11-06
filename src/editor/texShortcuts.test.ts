import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState, Transaction, type Extension, type SelectionRange, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertBlankLine, redoSelection, selectParentSyntax, undoSelection } from '@codemirror/commands';
import { foldedRanges } from '@codemirror/language';
import { SearchQuery, search, searchKeymap, selectNextOccurrence, selectSelectionMatches, setSearchQuery } from '@codemirror/search';
import { duplicateSelectionTransaction, overleafCompatibleKeymap, texCommentTransaction, texShortcutExtensions, texShortcutKeymap } from './texShortcuts';

// Real CM states and command dispatch; only geometry is supplied, since node has no layout engine.
function editor(doc:string,anchor=0,head=anchor,extensions:Extension[]=[]){
  let state=EditorState.create({doc,selection:{anchor,head},extensions:[history(),...texShortcutExtensions(),...extensions]});
  const transactions:Transaction[]=[];
  const view={
    get state(){return state;},composing:false,lineWrapping:false,
    dispatch:(...specs:(Transaction|TransactionSpec)[])=>{
      const transaction=specs[0] instanceof Transaction?specs[0]:state.update(...specs as TransactionSpec[]);
      transactions.push(transaction);state=transaction.state;
    },
    moveVertically:(range:SelectionRange,forward:boolean)=>{
      const line=state.doc.lineAt(range.head),number=line.number+(forward?1:-1);
      if(number<1||number>state.doc.lines)return range;
      const next=state.doc.line(number);return EditorSelection.cursor(Math.min(next.to,next.from+range.head-line.from));
    },
    moveToLineBoundary:(range:SelectionRange,forward:boolean)=>EditorSelection.cursor(forward?state.doc.lineAt(range.head).to:state.doc.lineAt(range.head).from),
    lineBlockAt:(pos:number)=>state.doc.lineAt(pos),
    plugin:()=>null,
  };
  return {view:view as unknown as EditorView,transactions,get state(){return state;},setComposing:(value:boolean)=>{view.composing=value;}};
}
function run(key:string,view:EditorView){
  const binding=texShortcutKeymap.find(binding=>binding.key===key);
  if(!binding?.run)throw new Error(`Missing shortcut ${key}`);
  expect(binding.run(view)).toBe(true);
}
afterEach(()=>vi.unstubAllGlobals());

describe('Overleaf source commands',()=>{
  it.each([
    ['one\ntwo\nthree',5,5,'one\nthree'],
    ['one\ntwo\nthree',0,4,'two\nthree'],
    ['one\ntwo\nthree',0,8,'three'],
    ['one\ntwo',5,5,'one'],
    ['one',1,1,''],
  ])('Ctrl+D deletes selected lines without extending a line-start selection endpoint', (doc,anchor,head,expected)=>{
    const value=editor(doc as string,anchor as number,head as number);run('Mod-d',value.view);
    expect(value.state.doc.toString()).toBe(expected);
    run('Mod-z',value.view);expect(value.state.doc.toString()).toBe(doc);
  });
  it('toggles TeX comments without requiring a loaded language, preserves indentation and blank lines',()=>{
    const value=editor('  alpha\n\n\tbeta\nlast',0,15);
    run('Mod-/',value.view);expect(value.state.doc.toString()).toBe('  %alpha\n\n\t%beta\nlast');
    run('Mod-/',value.view);expect(value.state.doc.toString()).toBe('  alpha\n\n\tbeta\nlast');
  });
  it('comments a mixed selection and removes only one percent on the next toggle',()=>{
    const doc=' %one\n  two\n  %%three',state=EditorState.create({doc,selection:{anchor:0,head:doc.length}});
    const commented=state.update(texCommentTransaction(state)!).state;
    expect(commented.doc.toString()).toBe(' %%one\n  %two\n  %%%three');
    expect(commented.update(texCommentTransaction(commented)!).newDoc.toString()).toBe(state.doc.toString());
  });
  it('does not include a line that only touches the selection end, and ignores blank-only selections',()=>{
    const state=EditorState.create({doc:'a\nb',selection:{anchor:0,head:2}});
    expect(state.update(texCommentTransaction(state)!).newDoc.toString()).toBe('%a\nb');
    expect(texCommentTransaction(EditorState.create({doc:' \n\t',selection:{anchor:0,head:3}}))).toBeNull();
  });
  it('comments overlapping multi-cursor line selections once',()=>{
    const state=EditorState.create({doc:'abc\ndef',extensions:[EditorState.allowMultipleSelections.of(true)],selection:EditorSelection.create([EditorSelection.cursor(0),EditorSelection.cursor(2),EditorSelection.cursor(5)])});
    expect(state.update(texCommentTransaction(state)!).newDoc.toString()).toBe('%abc\n%def');
  });
  it('indents and unindents selected lines, including both Tab variants',()=>{
    const value=editor('a\nb',0,3);
    run('Mod-]',value.view);expect(value.state.doc.toString()).toBe('  a\n  b');
    run('Mod-[',value.view);expect(value.state.doc.toString()).toBe('a\nb');
    run('Tab',value.view);expect(value.state.doc.toString()).toBe('  a\n  b');
    run('Shift-Tab',value.view);expect(value.state.doc.toString()).toBe('a\nb');
  });
  it('inserts a tab at a mid-line cursor rather than indenting that line',()=>{
    const value=editor('word',2);run('Tab',value.view);expect(value.state.doc.toString()).toBe('wo\trd');
  });
  it.each([['Mod-b','\\textbf{word}'],['Mod-i','\\textit{word}']])('wraps selected text with %s', (key,expected)=>{
    const value=editor('word',4,0);run(key,value.view);expect(value.state.doc.toString()).toBe(expected);
    expect(value.state.sliceDoc(value.state.selection.main.from,value.state.selection.main.to)).toBe('word');
    expect(value.state.selection.main.anchor).toBeGreaterThan(value.state.selection.main.head);
    run('Mod-z',value.view);expect(value.state.doc.toString()).toBe('word');
    run('Mod-Shift-z',value.view);expect(value.state.doc.toString()).toBe(expected);
  });
  it('changes case rather than undoing or redoing selections, including Unicode expansion',()=>{
    const value=editor('Straße',6,0);run('Mod-u',value.view);expect(value.state.doc.toString()).toBe('STRASSE');
    expect(value.state.selection.main.anchor).toBe(7);expect(value.state.selection.main.head).toBe(0);
    run('Mod-Shift-u',value.view);expect(value.state.doc.toString()).toBe('strasse');
  });
  it('duplicates selected text, preserving selection direction and one-step undo',()=>{
    const value=editor('one two',3,0);run('Mod-Shift-d',value.view);expect(value.state.doc.toString()).toBe('oneone two');
    expect([value.state.selection.main.anchor,value.state.selection.main.head]).toEqual([6,3]);
    run('Mod-z',value.view);expect(value.state.doc.toString()).toBe('one two');
    run('Mod-y',value.view);expect(value.state.doc.toString()).toBe('oneone two');
  });
  it('duplicates the line once while preserving every cursor on that line',()=>{
    const state=EditorState.create({doc:'abc\ndef',extensions:[EditorState.allowMultipleSelections.of(true)],selection:EditorSelection.create([EditorSelection.cursor(1),EditorSelection.cursor(2)])});
    const next=state.update(duplicateSelectionTransaction(state)!).state;
    expect(next.doc.toString()).toBe('abc\nabc\ndef');expect(next.selection.ranges.map(range=>range.head)).toEqual([5,6]);
  });
  it('duplicates real lines in CRLF documents',()=>{
    const value=editor('one\r\ntwo',1,1,[EditorState.lineSeparator.of('\r\n')]);
    run('Mod-Shift-d',value.view);expect(value.state.doc.lines).toBe(3);expect(value.state.sliceDoc()).toBe('one\r\none\r\ntwo');
  });
  it.each([
    ['Alt-Shift-ArrowUp','a\nb\nb\nc'],['Alt-Shift-ArrowDown','a\nb\nb\nc'],
    ['Alt-ArrowUp','b\na\nc'],['Alt-ArrowDown','a\nc\nb'],
  ])('copies or moves lines with %s', (key,expected)=>{
    const value=editor('a\nb\nc',2);run(key,value.view);expect(value.state.doc.toString()).toBe(expected);
    run('Mod-z',value.view);expect(value.state.doc.toString()).toBe('a\nb\nc');
  });
  it('places the cursor in the copied upper/lower line',()=>{
    const up=editor('a\nb\nc',2);run('Alt-Shift-ArrowUp',up.view);expect(up.state.selection.main.head).toBe(2);
    const down=editor('a\nb\nc',2);run('Alt-Shift-ArrowDown',down.view);expect(down.state.selection.main.head).toBe(4);
  });
  it('finds next/previous matches instead of selecting syntax or occurrences',()=>{
    const value=editor('word gap word gap word',0,0,[search()]);
    value.view.dispatch({effects:setSearchQuery.of(new SearchQuery({search:'word'}))});
    run('Mod-g',value.view);expect(value.state.selection.main.from).toBe(0);
    run('Mod-g',value.view);expect(value.state.selection.main.from).toBe(9);
    run('Mod-Shift-g',value.view);expect(value.state.selection.main.from).toBe(0);
  });
  it('uses actual line boundaries for Alt+Left/Right and Shift selections',()=>{
    const value=editor('  alpha\nbeta',4);run('Alt-ArrowLeft',value.view);expect(value.state.selection.main.head).toBe(0);
    run('Alt-Shift-ArrowRight',value.view);expect([value.state.selection.main.anchor,value.state.selection.main.head]).toEqual([0,7]);
    run('Ctrl-End',value.view);expect(value.state.selection.main.head).toBe(value.state.doc.length);
    run('Ctrl-Home',value.view);expect(value.state.selection.main.head).toBe(0);
    run('Mod-a',value.view);expect(value.state.selection.main.to).toBe(value.state.doc.length);
  });
  it.each(['up','down'] as const)('adds cumulative cursors %s and removes previously added cursors',direction=>{
    const value=editor('aa\nbb\ncc\ndd\nee',7);
    const key=`Mod-Alt-Arrow${direction==='up'?'Up':'Down'}`,remove=`Mod-Alt-Shift-Arrow${direction==='up'?'Up':'Down'}`;
    const original=value.state.selection;
    run(key,value.view);const one=value.state.selection;expect(one.ranges).toHaveLength(2);
    run(key,value.view);expect(value.state.selection.ranges).toHaveLength(3);
    run(remove,value.view);expect(value.state.selection.eq(one)).toBe(true);
    run(remove,value.view);expect(value.state.selection.eq(original)).toBe(true);
  });
  it('never removes a cursor after an unrelated selection change',()=>{
    const value=editor('aa\nbb\ncc',4);run('Mod-Alt-ArrowUp',value.view);
    value.view.dispatch({selection:{anchor:1}});run('Mod-Alt-Shift-ArrowUp',value.view);
    expect(value.state.selection.main.head).toBe(1);expect(value.state.selection.ranges).toHaveLength(1);
  });
  it('removes an earlier direction independently of later cursor additions',()=>{
    const value=editor('aa\nbb\ncc\ndd\nee',7);
    run('Mod-Alt-ArrowUp',value.view);run('Mod-Alt-ArrowDown',value.view);
    expect(value.state.selection.ranges.map(range=>range.head)).toEqual([4,7,10]);
    run('Mod-Alt-Shift-ArrowUp',value.view);
    expect(value.state.selection.ranges.map(range=>range.head)).toEqual([7,10]);
    run('Mod-Alt-Shift-ArrowDown',value.view);
    expect(value.state.selection.ranges.map(range=>range.head)).toEqual([7]);
  });
  it('folds, unfolds, and toggles nested TeX blocks without editing the document',()=>{
    const value=editor('\\begin{a}\n\\begin{b}\ntext\n\\end{b}\n\\end{a}');
    run('F2',value.view);expect(foldedRanges(value.state).size).toBe(1);
    run('F2',value.view);expect(foldedRanges(value.state).size).toBe(0);
    run('Alt-Shift-1',value.view);expect(foldedRanges(value.state).size).toBe(1);
    run('Alt-Shift-0',value.view);expect(foldedRanges(value.state).size).toBe(0);
    expect(value.transactions.every(transaction=>!transaction.docChanged)).toBe(true);
  });
  it.each(['Mod-d','Mod-/','Mod-u','Mod-Shift-u','Mod-b','Mod-i','Mod-]','Mod-[','Tab','Shift-Tab','Mod-Shift-d','Alt-Shift-ArrowUp','Alt-Shift-ArrowDown','Alt-ArrowUp','Alt-ArrowDown','Mod-z','Mod-y','Mod-Shift-z'])('%s cannot mutate read-only or IME-composing source',key=>{
    const readonly=editor('one\ntwo',0,3,[EditorState.readOnly.of(true)]);run(key,readonly.view);expect(readonly.transactions).toHaveLength(0);
    const composing=editor('one\ntwo',0,3);composing.setComposing(true);run(key,composing.view);expect(composing.transactions).toHaveLength(0);
    const starting=editor('one\ntwo',0,3);Object.defineProperty(starting.view,'compositionStarted',{value:true});
    run(key,starting.view);expect(starting.transactions).toHaveLength(0);
  });
  it.each(['Mod-Enter','Mod-.','Mod-s'])('%s emits exactly one compile request, not a blank line',key=>{
    const target=new EventTarget(),listener=vi.fn();target.addEventListener('texypaper:compile-requested',listener);vi.stubGlobal('window',target);
    const value=editor('one',1);run(key,value.view);expect(listener).toHaveBeenCalledTimes(1);
    expect(value.state.doc.toString()).toBe('one');expect(value.transactions).toHaveLength(0);
    value.setComposing(true);run(key,value.view);expect(listener).toHaveBeenCalledTimes(1);
    value.setComposing(false);Object.defineProperty(value.view,'compositionStarted',{value:true});
    run(key,value.view);expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('CodeMirror conflict removal',()=>{
  it('removes native commands with incompatible Overleaf meanings, not merely their precedence',()=>{
    const fallback=overleafCompatibleKeymap([...defaultKeymap,...historyKeymap,...searchKeymap]);
    for(const command of [insertBlankLine,selectParentSyntax,undoSelection,redoSelection,selectNextOccurrence,selectSelectionMatches])expect(fallback.some(binding=>binding.run===command)).toBe(false);
  });
  it('preserves unrelated Windows word movement when its macOS alias conflicts',()=>{
    const command=vi.fn(()=>true);
    const fallback=overleafCompatibleKeymap([{key:'Ctrl-ArrowLeft',mac:'Alt-ArrowLeft',run:command}]);
    expect(fallback.some(binding=>binding.win==='Ctrl-ArrowLeft')).toBe(true);
    expect(fallback.some(binding=>binding.mac==='Alt-ArrowLeft')).toBe(false);
  });
  it('enables additive Ctrl/Meta clicks without treating Alt drags as additive clicks',()=>{
    const state=EditorState.create({extensions:texShortcutExtensions()});
    expect(state.facet(EditorState.allowMultipleSelections)).toBe(true);
    const adds=state.facet(EditorView.clickAddsSelectionRange)[0];
    expect(adds({ctrlKey:true,metaKey:false,altKey:false} as MouseEvent)).toBe(true);
    expect(adds({ctrlKey:false,metaKey:true,altKey:false} as MouseEvent)).toBe(true);
    expect(adds({ctrlKey:true,metaKey:false,altKey:true} as MouseEvent)).toBe(false);
  });
});
