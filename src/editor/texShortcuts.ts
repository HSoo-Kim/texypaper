import { EditorSelection, EditorState, Prec, StateEffect, StateField, Text, type Extension, type TransactionSpec } from '@codemirror/state';
import { EditorView, keymap, rectangularSelection, type Command, type KeyBinding } from '@codemirror/view';
import { addCursorAbove, addCursorBelow, copyLineDown, copyLineUp, cursorDocEnd, cursorDocStart, cursorLineEnd, cursorLineStart, defaultKeymap, deleteLine, historyKeymap, indentLess, indentMore, insertBlankLine, insertTab, isolateHistory, moveLineDown, moveLineUp, redo, redoSelection, selectAll, selectDocEnd, selectDocStart, selectLineEnd, selectLineStart, selectParentSyntax, undo, undoSelection } from '@codemirror/commands';
import { findNext, findPrevious, gotoLine, openSearchPanel, searchKeymap, selectNextOccurrence, selectSelectionMatches } from '@codemirror/search';
import { acceptCompletion, completionKeymap, startCompletion } from '@codemirror/autocomplete';
import { foldAll, toggleFold, unfoldAll } from '@codemirror/language';
import { selectionCase, texInsertion } from './editorCommands';
import { texFoldingExtensions } from './texFolding';

type Label={ko:string;en:string};
export type TexShortcut={id:string;label:Label;keys:readonly string[];macKeys:readonly string[];bindings:readonly KeyBinding[]};
export type TexShortcutGroup={id:string;label:Label;shortcuts:readonly TexShortcut[]};

function selectedLines(state:EditorState):number[] {
  const numbers=new Set<number>();
  for(const range of state.selection.ranges){
    const first=state.doc.lineAt(range.from).number;
    const last=state.doc.lineAt(range.to>range.from?range.to-1:range.to).number;
    for(let number=first;number<=last;number++)numbers.add(number);
  }
  return [...numbers].sort((a,b)=>a-b);
}

/** Independent of language-data loading: source TeX always uses % comments. */
export function texCommentTransaction(state:EditorState):TransactionSpec|null {
  if(state.readOnly)return null;
  const lines=selectedLines(state).map(number=>state.doc.line(number));
  const content=lines.filter(line=>/\S/.test(line.text));
  const uncomment=content.length>0&&content.every(line=>/^\s*%/.test(line.text));
  const changes=content.map(line=>{
    const from=line.from+line.text.search(/\S/);
    return uncomment?{from,to:from+1,insert:''}:{from,insert:'%'};
  });
  if(!changes.length)return null;
  return {changes,scrollIntoView:true,userEvent:'input.comment',annotations:isolateHistory.of('full')};
}

export function duplicateSelectionTransaction(state:EditorState):TransactionSpec|null {
  if(state.readOnly)return null;
  // Empty cursors duplicate whole lines; selected text is duplicated verbatim, not line-expanded.
  // Coalesce line insertions, not cursor selections: keep every original cursor and column.
  const lines=new Set<number>();
  const changes=state.selection.ranges.flatMap(range=>{
    if(!range.empty)return [{from:range.to,insert:state.doc.slice(range.from,range.to)}];
    const line=state.doc.lineAt(range.head);
    if(lines.has(line.number))return [];
    lines.add(line.number);
    return [{from:line.to,insert:Text.of(['',line.text])}];
  });
  const changeSet=state.changes(changes);
  const selection=EditorSelection.create(state.selection.ranges.map(range=>{
    if(range.empty){const line=state.doc.lineAt(range.head);return EditorSelection.cursor(changeSet.mapPos(line.to,-1)+1+range.head-line.from);}
    const from=changeSet.mapPos(range.to,-1),to=from+range.to-range.from;
    return range.anchor<=range.head?EditorSelection.range(from,to):EditorSelection.range(to,from);
  }),state.selection.mainIndex);
  return {changes:changeSet,selection,scrollIntoView:true,userEvent:'input.duplicate',annotations:isolateHistory.of('full')};
}

function transactionCommand(create:(state:EditorState)=>TransactionSpec|null):Command {
  return view=>{const transaction=create(view.state);if(transaction)view.dispatch(transaction);return true;};
}

/** Consume unavailable commands too: never fall through to conflicting CM/browser shortcuts. */
function safe(command:Command,mutates=false):Command {
  return view=>{if(view.composing||view.compositionStarted||(mutates&&view.state.readOnly))return true;command(view);return true;};
}

const compile:Command=view=>{
  if(!view.composing&&!view.compositionStarted)window.dispatchEvent(new CustomEvent('texypaper:compile-requested'));
  return true;
};
const comment=transactionCommand(texCommentTransaction);
const tab:Command=view=>acceptCompletion(view)||(
  view.state.selection.ranges.some(range=>!range.empty||range.head<=view.state.doc.lineAt(range.head).from+view.state.doc.lineAt(range.head).text.search(/\S|$/))
    ?indentMore(view):insertTab(view));

type CursorStep={direction:'up'|'down';before:EditorSelection;after:EditorSelection};
const cursorStepsEffect=StateEffect.define<readonly CursorStep[]>();
const cursorSteps=StateField.define<readonly CursorStep[]>({
  create:()=>[],
  update(value,tr){
    for(const effect of tr.effects)if(effect.is(cursorStepsEffect))return effect.value;
    return tr.docChanged||tr.selection?[]:value;
  },
});
function addCursor(direction:'up'|'down'):Command {
  return view=>{
    const before=view.state.selection,steps=view.state.field(cursorSteps);
    (direction==='up'?addCursorAbove:addCursorBelow)(view);
    const after=view.state.selection;
    if(!before.eq(after))view.dispatch({effects:cursorStepsEffect.of([...steps,{direction,before,after}])});
    return true;
  };
}
function removeCursor(direction:'up'|'down'):Command {
  return view=>{
    const steps=view.state.field(cursorSteps);
    let index=steps.length-1;while(index>=0&&steps[index].direction!==direction)index--;
    if(index<0)return true;
    const step=steps[index],current=view.state.selection;
    const added=step.after.ranges.filter(range=>!step.before.ranges.some(previous=>previous.eq(range)));
    const remaining=current.ranges.filter(range=>!added.some(removed=>removed.eq(range)));
    if(remaining.length){
      const preferred=index===steps.length-1?step.before.main:current.main;
      const main=Math.max(0,remaining.findIndex(range=>range.eq(preferred)));
      view.dispatch({selection:EditorSelection.create(remaining,main),effects:cursorStepsEffect.of(steps.filter((_,i)=>i!==index)),scrollIntoView:true,userEvent:'select'});
    }
    return true;
  };
}

function displayKey(key:string,mac=false):string {
  return key.replace(/Mod/g,mac?'Cmd':'Ctrl').replace(/Arrow/g,'').replace(/-/g,'+');
}
function shortcut(id:string,ko:string,en:string,bindings:readonly KeyBinding[]):TexShortcut {
  return {id,label:{ko,en},bindings,keys:[...new Set(bindings.flatMap(binding=>binding.key?[displayKey(binding.key)]:[]))],macKeys:[...new Set(bindings.flatMap(binding=>binding.mac||binding.key?[displayKey(binding.mac??binding.key!,true)]:[]))]};
}
function bind(keys:readonly string[],run:Command,mutates=false):KeyBinding[] {
  return keys.map(key=>({key,run:safe(run,mutates),preventDefault:true}));
}
const edit=(keys:readonly string[],run:Command)=>bind(keys,run,true);

/** Help rows and live bindings are derived from these same definitions, never parallel tables. */
export const texShortcutGroups:readonly TexShortcutGroup[]=[
  {id:'compile',label:{ko:'컴파일 및 검색',en:'Compile and search'},shortcuts:[
    shortcut('compile','프로젝트 컴파일','Compile project',[
      ...bind(['Mod-.','Mod-s','Mod-Enter'],compile),
      {key:'Ctrl-.',run:safe(compile),preventDefault:true},
    ]),
    shortcut('completion','자동 완성 · 인용/참조 검색','Autocomplete · citation/reference search',bind(['Ctrl-Space','Alt-Space'],startCompletion)),
    shortcut('find','찾기 및 바꾸기','Find and replace',bind(['Mod-f'],openSearchPanel)),
    shortcut('next','다음 검색 결과','Find next',bind(['Mod-g'],findNext)),
    shortcut('previous','이전 검색 결과','Find previous',bind(['Mod-Shift-g'],findPrevious)),
    shortcut('goto','줄 번호로 이동','Go to line',bind(['Mod-Shift-l'],gotoLine)),
  ]},
  {id:'edit',label:{ko:'소스 편집',en:'Source editing'},shortcuts:[
    shortcut('comment','선택한 줄 주석 전환','Toggle % line comments',edit(['Mod-/'],comment)),
    shortcut('delete','현재 줄 · 선택한 줄 삭제','Delete current/selected lines',edit(['Mod-d'],deleteLine)),
    shortcut('indentLess','들여쓰기 줄이기','Indent less',edit(['Mod-[','Shift-Tab'],indentLess)),
    shortcut('indentMore','들여쓰기 늘리기 · Tab은 줄 시작/선택 영역','Indent more · Tab at line start/selection',[...edit(['Mod-]'],indentMore),...edit(['Tab'],tab)]),
    shortcut('uppercase','선택 영역 대문자로','Uppercase selection',edit(['Mod-u','Ctrl-u'],transactionCommand(state=>selectionCase(state,true)))),
    shortcut('lowercase','선택 영역 소문자로','Lowercase selection',edit(['Mod-Shift-u','Ctrl-Shift-u'],transactionCommand(state=>selectionCase(state,false)))),
    shortcut('bold','굵게 \\textbf{}','Bold \\textbf{}',edit(['Mod-b'],transactionCommand(state=>texInsertion(state,'bold')))),
    shortcut('italic','기울임꼴 \\textit{}','Italic \\textit{}',edit(['Mod-i'],transactionCommand(state=>texInsertion(state,'italic')))),
    shortcut('cut','잘라내기','Cut',[{key:'Mod-x',run:()=>false}]),
    shortcut('copy','복사','Copy',[{key:'Mod-c',run:()=>false}]),
    shortcut('paste','붙여넣기','Paste',[{key:'Mod-v',run:()=>false}]),
    shortcut('duplicate','선택 영역 복제 · 선택이 없으면 줄 복제','Duplicate selection · current line when empty',edit(['Mod-Shift-d'],transactionCommand(duplicateSelectionTransaction))),
    shortcut('copyUp','줄 위로 복제','Copy lines up',edit(['Alt-Shift-ArrowUp'],copyLineUp)),
    shortcut('copyDown','줄 아래로 복제','Copy lines down',edit(['Alt-Shift-ArrowDown'],copyLineDown)),
    shortcut('moveUp','줄 위로 이동','Move lines up',edit(['Alt-ArrowUp'],moveLineUp)),
    shortcut('moveDown','줄 아래로 이동','Move lines down',edit(['Alt-ArrowDown'],moveLineDown)),
    shortcut('undo','실행 취소','Undo',edit(['Mod-z'],undo)),
    shortcut('redo','다시 실행','Redo',edit(['Mod-Shift-z','Mod-y'],redo)),
  ]},
  {id:'navigation',label:{ko:'이동 및 다중 커서',en:'Navigation and multiple cursors'},shortcuts:[
    shortcut('lineStart','줄 시작으로 · Shift로 선택','Line start · Shift selects',[
      ...bind(['Alt-ArrowLeft'],cursorLineStart),...bind(['Alt-Shift-ArrowLeft'],selectLineStart),
      {mac:'Ctrl-a',run:safe(cursorLineStart),shift:safe(selectLineStart),preventDefault:true},
    ]),
    shortcut('lineEnd','줄 끝으로 · Shift로 선택','Line end · Shift selects',[
      ...bind(['Alt-ArrowRight'],cursorLineEnd),...bind(['Alt-Shift-ArrowRight'],selectLineEnd),
      {mac:'Ctrl-e',run:safe(cursorLineEnd),shift:safe(selectLineEnd),preventDefault:true},
    ]),
    shortcut('docStart','문서 시작으로 · Shift로 선택','Document start · Shift selects',[
      {key:'Ctrl-Home',mac:'Mod-ArrowUp',run:safe(cursorDocStart),shift:safe(selectDocStart),preventDefault:true},
    ]),
    shortcut('docEnd','문서 끝으로 · Shift로 선택','Document end · Shift selects',[
      {key:'Ctrl-End',mac:'Mod-ArrowDown',run:safe(cursorDocEnd),shift:safe(selectDocEnd),preventDefault:true},
    ]),
    shortcut('selectAll','전체 선택','Select all',bind(['Mod-a'],selectAll)),
    shortcut('addAbove','위에 커서 추가 (누적)','Add cursor above (cumulative)',bind(['Mod-Alt-ArrowUp'],addCursor('up'))),
    shortcut('addBelow','아래에 커서 추가 (누적)','Add cursor below (cumulative)',bind(['Mod-Alt-ArrowDown'],addCursor('down'))),
    shortcut('removeAbove','직전에 추가한 위 커서 제거','Remove previously added cursor above',bind(['Mod-Alt-Shift-ArrowUp'],removeCursor('up'))),
    shortcut('removeBelow','직전에 추가한 아래 커서 제거','Remove previously added cursor below',bind(['Mod-Alt-Shift-ArrowDown'],removeCursor('down'))),
    {id:'multiClick',label:{ko:'클릭으로 다중 커서',en:'Multiple cursors by clicking'},keys:['Ctrl+click'],macKeys:['Cmd+click'],bindings:[]},
    {id:'rectangle',label:{ko:'직사각형 선택',en:'Rectangular selection'},keys:['Alt+drag'],macKeys:['Alt+drag'],bindings:[]},
  ]},
  {id:'fold',label:{ko:'코드 접기',en:'Code folding'},shortcuts:[
    shortcut('toggleFold','현재 블록 접기/펼치기','Toggle fold',bind(['F2'],toggleFold)),
    shortcut('unfoldAll','모두 펼치기','Unfold all',bind(['Alt-Shift-0'],unfoldAll)),
    shortcut('foldAll','모두 접기','Fold all',bind(['Alt-Shift-1'],foldAll)),
  ]},
];

export const texShortcutKeymap:readonly KeyBinding[]=texShortcutGroups.flatMap(group=>group.shortcuts.flatMap(shortcut=>shortcut.bindings));
// Filter by command identity, including platform overrides. Precedence alone is insufficient
// when an unavailable command returns false, or an editor is reconfigured read-only.
const conflictingCommands:readonly Command[]=[selectNextOccurrence,selectSelectionMatches,selectParentSyntax,insertBlankLine,undoSelection,redoSelection];
const platforms=['win','mac','linux'] as const;
function normalizedKey(key:string,platform:typeof platforms[number]):string {
  return key.replace(/Mod/g,platform==='mac'?'Cmd':'Ctrl').toLowerCase().split('-').sort().join('-');
}
export function overleafCompatibleKeymap(bindings:readonly KeyBinding[]):KeyBinding[] {
  return bindings.flatMap(binding=>{
    if(conflictingCommands.includes(binding.run!))return [];
    const available=platforms.filter(platform=>{
      const key=binding[platform]??binding.key;
      return key&&!texShortcutKeymap.some(own=>{
        const ownKey=own[platform]??own.key;
        return ownKey&&normalizedKey(key,platform)===normalizedKey(ownKey,platform);
      });
    });
    if(available.length===platforms.length)return [binding];
    // Keep unrelated platform bindings (for example Windows Ctrl+Left word movement
    // shares an entry with macOS Alt+Left, which Overleaf uses for line start).
    return available.map(platform=>({...binding,key:undefined,mac:undefined,win:undefined,linux:undefined,[platform]:binding[platform]??binding.key}));
  });
}
const fallbackKeymap:readonly KeyBinding[]=[...overleafCompatibleKeymap(defaultKeymap),...overleafCompatibleKeymap(historyKeymap),...overleafCompatibleKeymap(searchKeymap),...completionKeymap].map(binding=>({
  ...binding,
  run:binding.run&&((view:EditorView)=>view.composing||view.compositionStarted||binding.run!(view)),
  shift:binding.shift&&((view:EditorView)=>view.composing||view.compositionStarted||binding.shift!(view)),
}));

export function texShortcutExtensions():Extension[] {
  return [
    EditorState.allowMultipleSelections.of(true),cursorSteps,
    EditorView.clickAddsSelectionRange.of(event=>(event.ctrlKey||event.metaKey)&&!event.altKey),
    rectangularSelection({eventFilter:event=>event.altKey&&!event.ctrlKey&&!event.metaKey}),
    ...texFoldingExtensions(),
    Prec.highest(EditorView.domEventHandlers({keydown(event,view){
      if(event.isComposing||view.composing||view.compositionStarted)return false;
      // Physical slash keys cover numpad divide and layouts whose produced key isn't '/'.
      const modifier=event.ctrlKey||event.metaKey;
      if(modifier&&!event.altKey&&!event.shiftKey&&(event.code==='Slash'||event.code==='NumpadDivide')){
        event.preventDefault();safe(comment,true)(view);return true;
      }
      // Shift+digit reports ')'/'!' on US keyboards; use physical digits as a fallback.
      if(event.altKey&&event.shiftKey&&!modifier&&(event.code==='Digit0'||event.code==='Digit1')){
        event.preventDefault();safe(event.code==='Digit0'?unfoldAll:foldAll)(view);return true;
      }
      return false;
    }})),
    Prec.highest(keymap.of(texShortcutKeymap)),
    keymap.of(fallbackKeymap),
  ];
}
