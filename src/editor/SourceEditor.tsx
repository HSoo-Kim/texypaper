import { t, useI18n } from '../ui/i18n';
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, rectangularSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, StreamLanguage, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap, type CompletionContext } from '@codemirror/autocomplete';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { BufferStore, byteToUtf16, selectionAnchor, type SourceSelection } from './buffers';
import { Icon } from '../ui/Icon';
import { runEditorCommand, type EditorCommand } from './editorCommands';
export type { EditorCommand } from './editorCommands';
import { undoDepth, redoDepth } from '@codemirror/commands';

export type SourceEditorHandle = { focus:()=>void; position:()=>{line1:number;column1:number}; selectBytes:(start:number,end:number)=>void; selection:()=>SourceSelection|null; navigate:(line:number,column?:number)=>void; command:(name:EditorCommand)=>void; };
type Props = {store:BufferStore;loading?:boolean;onSelection?:(selection:SourceSelection|null)=>void;onReady?:(handle:SourceEditorHandle|null)=>void;};
const language = new Compartment(), editable = new Compartment(), phrases=new Compartment();
// StreamLanguage registers its Document node globally; reuse one instance without constructing it at launch.
let texLanguage:Extension|undefined;
const koreanPhrases:Record<string,string>={'Find':'찾기','Replace':'바꾸기','next':'다음','previous':'이전','all':'전체','match case':'대소문자 구분','regexp':'정규식','by word':'단어 단위','replace':'바꾸기','replace all':'모두 바꾸기','close':'닫기','Go to line':'줄로 이동','go':'이동','current match':'현재 일치','replaced $ matches':'$개 바꿈','replaced match on line $':'$줄의 일치 항목 바꿈'};
const editorTheme = EditorView.theme({
  '&':{height:'100%',fontSize:'0.875rem',backgroundColor:'var(--surface)',color:'var(--text)'},
  '.cm-scroller':{fontFamily:'ui-monospace, "Cascadia Code", Consolas, monospace',lineHeight:'1.65'},
  '.cm-content':{padding:'1rem 0'}, '.cm-gutters':{background:'var(--surface)',color:'var(--secondary)',border:'none'},
  '.cm-line':{padding:'0 1rem'}, '.cm-cursor':{borderLeftColor:'var(--text)'},
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection':{backgroundColor:'var(--selection)'},
  '.cm-panels':{background:'var(--sidebar)',color:'var(--text)'},
});
// Languages are intentionally demand-loaded: the accepted memory contract forbids eager language packages.
export async function languageFor(path:string):Promise<Extension> {
  const extension=path.split('.').at(-1)?.toLowerCase();
  if(extension&&['tex','ltx','sty','cls','bib','bst','bbx','cbx'].includes(extension))return texLanguage??=StreamLanguage.define(stex);
  if(extension&&['js','jsx','ts','tsx'].includes(extension)){const {javascript}=await import('@codemirror/lang-javascript');return javascript({typescript:extension.startsWith('ts'),jsx:extension.endsWith('x')});}
  if(extension==='py'){const {python}=await import('@codemirror/lang-python');return python();}
  if(extension==='json'){const {json}=await import('@codemirror/lang-json');return json();}
  if(extension==='md'){const {markdown}=await import('@codemirror/lang-markdown');return markdown();}
  return [];
}
export function SourceEditor({store,onSelection,onReady,loading=false}:Props) {
  const {locale}=useI18n();
  const host=useRef<HTMLDivElement>(null),view=useRef<EditorView|null>(null),pathRef=useRef<string|null>(null);
  const callbacks=useRef({onSelection,onReady});callbacks.current={onSelection,onReady};
  useSyncExternalStore(store.subscribe,store.snapshot);
  useLayoutEffect(()=>{
    if(!host.current)return;
    const editor=new EditorView({parent:host.current,state:EditorState.create({extensions:[editorTheme]})});view.current=editor;
    const handle:SourceEditorHandle={command:name=>{if(pathRef.current)runEditorCommand(editor,name);},focus:()=>editor.focus(),position:()=>{const head=editor.state.selection.main.head,line=editor.state.doc.lineAt(head);return {line1:line.number,column1:head-line.from+1};},selectBytes:(start,end)=>{const path=pathRef.current,record=path?store.records.get(path):undefined;if(!record)return;const raw=store.text(record),bom=record.document.encoding==='utf8Bom'?3:0;const toEditor=(byte:number)=>raw.slice(0,byteToUtf16(raw,Math.max(0,byte-bom))).replaceAll('\r\n','\n').replaceAll('\r','\n').length;const anchor=toEditor(start),head=toEditor(end);editor.dispatch({selection:{anchor,head},effects:EditorView.scrollIntoView(anchor,{y:'center'})});editor.focus();},selection:()=>{const path=pathRef.current,buffer=path?store.records.get(path):undefined;if(!buffer)return null;const {from,to}=editor.state.selection.main;return from===to?null:selectionAnchor(buffer,from,to);},navigate:(line,column=1)=>{const target=editor.state.doc.line(Math.max(1,Math.min(line,editor.state.doc.lines)));const position=Math.min(target.to,target.from+Math.max(0,column-1));editor.dispatch({selection:{anchor:position},effects:EditorView.scrollIntoView(position,{y:'center'})});editor.focus();}};
    callbacks.current.onReady?.(handle);
    return()=>{callbacks.current.onReady?.(null);pathRef.current=null;editor.destroy();view.current=null;};
  },[store]);
  const buffer=store.activePath?store.records.get(store.activePath):undefined;
  useLayoutEffect(()=>{
    // Workspace restoration may activate several cached buffers; only install the final visible document.
    const editor=view.current;if(!editor||!buffer||loading)return;
    if(pathRef.current===buffer.path && buffer.state===editor.state)return;
    const previous=pathRef.current?store.records.get(pathRef.current):undefined;if(previous&&!previous.evicted&&pathRef.current!==buffer.path)previous.state=editor.state;
    pathRef.current=buffer.path;
    const complete=(context:CompletionContext)=>{
      const token=context.matchBefore(/[\w:.-]*/);if(!token||(!context.explicit&&token.from===token.to))return null;
      const keys=new Set<string>();for(const record of store.records.values()){const text=store.text(record);for(const match of text.matchAll(/(?:\\label\{([^}]+)\}|@[\w]+\s*\{\s*([^,\s]+))/g))keys.add(match[1]??match[2]);}
      return {from:token.from,options:[...keys].slice(0,2000).map(label=>({label,type:'constant'}))};
    };
    if(!buffer.state)buffer.state=EditorState.create({doc:buffer.document.text,extensions:[phrases.of(EditorState.phrases.of(locale==='ko'?koreanPhrases:{})),...(buffer.document.newline==='crlf'?[EditorState.lineSeparator.of('\r\n')]:[]),lineNumbers(),highlightActiveLineGutter(),highlightSpecialChars(),history(),drawSelection(),rectangularSelection(),bracketMatching(),indentOnInput(),syntaxHighlighting(defaultHighlightStyle),highlightSelectionMatches(),autocompletion({override:[complete]}),keymap.of([...defaultKeymap,...historyKeymap,...searchKeymap,...completionKeymap,indentWithTab]),editorTheme,language.of([]),editable.of([EditorState.readOnly.of(buffer.document.readOnly),EditorView.editable.of(!buffer.document.readOnly)]),EditorView.lineWrapping,EditorView.domEventHandlers({compositionstart:()=>{if(pathRef.current)store.composition(pathRef.current,true);return false;},compositionend:()=>{if(pathRef.current)store.composition(pathRef.current,false);return false;}}),EditorView.updateListener.of(update=>{
      const path=pathRef.current;if(!path)return;const record=store.records.get(path);if(!record)return;
      if(update.docChanged)store.update(path,update.state,update.changes);else record.state=update.state;
      if(update.selectionSet||update.docChanged){const {from,to}=update.state.selection.main;callbacks.current.onSelection?.(from===to?null:selectionAnchor(record,from,to));}
    })]});
    buffer.document.text='';editor.setState(buffer.state);editor.dispatch({effects:phrases.reconfigure(EditorState.phrases.of(locale==='ko'?koreanPhrases:{}))});const active=buffer.path;
    void languageFor(active).then(extension=>{if(pathRef.current===active){editor.dispatch({effects:language.reconfigure(extension)});}});
  },[buffer,buffer?.document,buffer?.state,store,loading]);
  useEffect(()=>{view.current?.dispatch({effects:phrases.reconfigure(EditorState.phrases.of(locale==='ko'?koreanPhrases:{}))});},[locale]);
  const command=(name:EditorCommand)=>{const editor=view.current;if(!editor||!buffer||loading)return;runEditorCommand(editor,name);};
  const readOnly=!buffer||loading||buffer.document.readOnly;
  const tools=[
    {name:'bold',icon:'bold',label:t('굵게','Bold'),syntax:'\\textbf{}'},
    {name:'italic',icon:'italic',label:t('기울임꼴','Italic'),syntax:'\\textit{}'},
    {name:'section',icon:'section',label:t('절 제목 삽입','Insert section'),syntax:'\\section{}'},
    {name:'cite',icon:'cite',label:t('인용 삽입','Insert citation'),syntax:'\\cite{}'},
    {name:'ref',icon:'ref',label:t('참조 삽입','Insert reference'),syntax:'\\ref{}'},
    {name:'itemize',icon:'list',label:t('글머리 목록 삽입','Insert bulleted list'),syntax:'\\begin{itemize}'},
    {name:'math',icon:'math',label:t('인라인 수식 삽입','Insert inline math'),syntax:'$…$'},
  ] as const;
  return <div className="source-editor-frame" hidden={loading}>
    <div className="editor-toolbar" role="toolbar" aria-label={t('소스 편집 도구','Source editing tools')}>
      <div className="editor-toolbar-group">
        <button className="icon-button" type="button" disabled={readOnly||!buffer?.state||undoDepth(buffer.state)===0} aria-label={t('실행 취소','Undo')} title={t('실행 취소 (Ctrl+Z)','Undo (Ctrl+Z)')} onClick={()=>command('undo')}><Icon name="undo" size={16}/></button>
        <button className="icon-button" type="button" disabled={readOnly||!buffer?.state||redoDepth(buffer.state)===0} aria-label={t('다시 실행','Redo')} title={t('다시 실행 (Ctrl+Shift+Z)','Redo (Ctrl+Shift+Z)')} onClick={()=>command('redo')}><Icon name="redo" size={16}/></button>
        <button className="icon-button" type="button" disabled={!buffer||loading} aria-label={t('찾기 및 바꾸기','Find and replace')} title={t('찾기 및 바꾸기 (Ctrl+F)','Find and replace (Ctrl+F)')} onClick={()=>command('find')}><Icon name="search" size={16}/></button>
      </div>
      <span className="editor-toolbar-separator" aria-hidden="true"/>
      <div className="editor-toolbar-group">
        {tools.map(tool=><button key={tool.name} className="icon-button" type="button" disabled={readOnly} aria-label={tool.label} title={`${tool.label} · ${tool.syntax}`} onClick={()=>command(tool.name)}><Icon name={tool.icon} size={16}/></button>)}
      </div>
    </div>
    <div className="source-editor" data-testid="source-editor" data-path={buffer?.path??''} aria-busy={loading} hidden={loading} ref={host} aria-label={buffer?t(`소스 편집기: ${buffer.path}`,`Source editor: ${buffer.path}`):t('소스 편집기','Source editor')} />
  </div>;
}
