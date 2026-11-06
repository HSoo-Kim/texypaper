import { EditorSelection, Text, type EditorState, type TransactionSpec } from '@codemirror/state';
import { undo, redo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';

export type EditorCommand='undo'|'redo'|'find'|'replace'|'bold'|'italic'|'section'|'cite'|'ref'|'itemize'|'math';
export type TexInsertion=Exclude<EditorCommand,'undo'|'redo'|'find'|'replace'>;
const wrappers:Record<TexInsertion,readonly [string,string]>={
  bold:['\\textbf{','}'],
  italic:['\\textit{','}'],
  section:['\\section{','}'],
  cite:['\\cite{','}'],
  ref:['\\ref{','}'],
  itemize:['\\begin{itemize}\n  \\item ','\n\\end{itemize}'],
  math:['$','$'],
};

export function texInsertion(state:EditorState,name:TexInsertion):TransactionSpec|null {
  if(state.readOnly)return null;
  const [before,after]=wrappers[name];
  return {
    ...state.changeByRange(range=>{
      const selected=state.doc.sliceString(range.from,range.to,'\n');
      const from=range.from+before.length,to=from+selected.length;
      return {changes:{from:range.from,to:range.to,insert:Text.of((before+selected+after).split('\n'))},range:range.anchor<=range.head?EditorSelection.range(from,to):EditorSelection.range(to,from)};
    }),
    scrollIntoView:true,
    userEvent:'input',
  };
}

export function runEditorCommand(view:EditorView,name:EditorCommand):void {
  if(name==='find'||name==='replace'){
    if(name==='replace'&&view.state.readOnly)return;
    openSearchPanel(view);
    if(name==='replace')view.dom.querySelector<HTMLInputElement>('.cm-search input[name="replace"]')?.focus();
    return;
  }
  if(view.state.readOnly)return;
  if(name==='undo')undo(view);
  else if(name==='redo')redo(view);
  else {const transaction=texInsertion(view.state,name);if(transaction)view.dispatch(transaction);}
  view.focus();
}
