import { t, useI18n } from '../ui/i18n';
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, highlightActiveLineGutter, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { history } from '@codemirror/commands';
import { bracketMatching, indentOnInput, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { BufferStore, byteToUtf16, selectionAnchor, type BufferRecord, type SourceSelection } from './buffers';
import { clampEditorPosition } from '../state/readingPosition';
import { Icon } from '../ui/Icon';
import { runEditorCommand, type EditorCommand } from './editorCommands';
import { texShortcutExtensions } from './texShortcuts';
import {clampEditorFontSize,usePaneZoom} from '../ui/paneZoom';
export type { EditorCommand } from './editorCommands';
import { undoDepth, redoDepth } from '@codemirror/commands';
import { imagePasteExtension, type ImagePasteOptions } from './imagePaste';
import type { WorkspaceRef } from '../contracts';
import { SpellEngine, spellingExtension } from './spelling';
import { countWords, countSelection } from './wordCount';
import { selectableLineNumbers } from './lineNumbers';
const emptyIgnoredWords:string[]=[];

export type SourceEditorHandle = { captureReadingPosition:()=>void;focus:()=>void; position:()=>{line1:number;column1:number}; selectBytes:(start:number,end:number)=>void; selection:()=>SourceSelection|null; navigate:(line:number,column?:number)=>void; command:(name:EditorCommand)=>void; wordCounts:()=>{words:number;characters:number;selectionWords:number}; };
type Props = {store:BufferStore;fontSize:number;onFontSizeChange:(size:number)=>void;loading?:boolean;visible?:boolean;onSelection?:(selection:SourceSelection|null)=>void;onReady?:(handle:SourceEditorHandle|null)=>void;onImages?:ImagePasteOptions['onImages'];spellCheck?:boolean;spellIgnore?:string[];onSpellIgnore?:(word:string)=>void;spellWorkspace?:WorkspaceRef;};
const language = new Compartment(), editable = new Compartment(), phrases=new Compartment(), spelling=new Compartment();
// StreamLanguage registers its Document node globally; reuse one instance without constructing it at launch.
let texLanguage:Extension|undefined;
const koreanPhrases:Record<string,string>={'Find':'찾기','Replace':'바꾸기','next':'다음','previous':'이전','all':'전체','match case':'대소문자 구분','regexp':'정규식','by word':'단어 단위','replace':'바꾸기','replace all':'모두 바꾸기','close':'닫기','Go to line':'줄로 이동','go':'이동','current match':'현재 일치','replaced $ matches':'$개 바꿈','replaced match on line $':'$줄의 일치 항목 바꿈'};
const editorTheme = EditorView.theme({
  '&':{height:'100%',fontSize:'0.875rem',backgroundColor:'var(--surface)',color:'var(--text)'},
  '.cm-scroller':{fontFamily:'ui-monospace, "Cascadia Code", Consolas, monospace',lineHeight:'1.65'},
  '.cm-content':{padding:'1rem 0'}, '.cm-gutters':{background:'var(--sidebar)',color:'var(--secondary)',border:'none',borderRight:'1px solid var(--border)'},
  '.cm-activeLineGutter':{backgroundColor:'var(--selection)',color:'var(--text)'},
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
export function SourceEditor({store,fontSize,onFontSizeChange,onSelection,onReady,onImages,spellCheck=false,spellIgnore=emptyIgnoredWords,onSpellIgnore,spellWorkspace,loading=false,visible=true}:Props) {
  const {locale}=useI18n();
  const host=useRef<HTMLDivElement>(null),view=useRef<EditorView|null>(null),pathRef=useRef<string|null>(null);
  const ownership=useRef<{buffer:BufferRecord;generation:number}|null>(null);
  const frame=useRef<HTMLDivElement>(null),fontSizeRef=useRef(clampEditorFontSize(fontSize));
  const logicalFontSize=clampEditorFontSize(fontSize);
  usePaneZoom({root:frame,wheelRoot:host,enabled:visible&&!loading,onZoom:direction=>{const next=clampEditorFontSize(fontSizeRef.current+direction);if(next!==fontSizeRef.current){fontSizeRef.current=next;onFontSizeChange(next);}},wheelTarget:target=>!!target.closest('.cm-scroller')});
  const navigation=useRef(0),capture=useRef<()=>void>(()=>{}),shown=useRef(false);
  const callbacks=useRef({onSelection,onReady});callbacks.current={onSelection,onReady};
  const images=useRef(onImages);images.current=onImages;
  const spellEngine=useMemo(()=>spellCheck&&spellWorkspace?SpellEngine(spellWorkspace):null,[spellCheck,spellWorkspace?.id,spellWorkspace?.epoch]);
  const spell=useRef({spellCheck,spellIgnore,onSpellIgnore,engine:spellEngine});spell.current={spellCheck,spellIgnore,onSpellIgnore,engine:spellEngine};
  const configureSpelling=(editor:EditorView)=>{
    const path=pathRef.current,record=path?store.records.get(path):undefined,current=spell.current;
    const enabled=!!(current.spellCheck&&current.engine&&record&&!record.document.readOnly&&!record.document.truncated&&record.document.revision.byteLength<=4*1024*1024&&['utf8','utf8Bom'].includes(record.document.encoding)&&/\.(tex|ltx)$/i.test(path??'')&&!/(?:^|\/)(?:\.texypaper|\.paperdock|\.git)(?:\/|$)/.test(path??''));
    editor.dispatch({effects:spelling.reconfigure(enabled?spellingExtension({enabled:()=>spell.current.spellCheck,ignore:()=>spell.current.spellIgnore,onIgnore:word=>spell.current.onSpellIgnore?.(word),check:text=>current.engine!.check(text),suggest:word=>current.engine!.suggest(word),language:()=>current.engine!.language()}):[])});
  };
  useSyncExternalStore(store.subscribe,store.snapshot);
  useLayoutEffect(()=>{
    if(!host.current)return;
    const editor=new EditorView({parent:host.current,state:EditorState.create({extensions:[editorTheme]})});view.current=editor;
    const remember=()=>{const path=pathRef.current;if(!path||!store.records.has(path)||!editor.scrollDOM.getClientRects().length)return;const {anchor,head}=editor.state.selection.main;const top=editor.lineBlockAtHeight(editor.scrollDOM.scrollTop);store.rememberPosition(path,{anchor,head,top:top.from,inset:editor.scrollDOM.scrollTop-top.top,left:editor.scrollDOM.scrollLeft});};capture.current=remember;editor.scrollDOM.addEventListener('scroll',remember,{passive:true});
    let countedDoc:EditorState['doc']|undefined,countedText='',counts={words:0,characters:0};
    const wordCounts=()=>{if(!pathRef.current)return {words:0,characters:0,selectionWords:0};if(countedDoc!==editor.state.doc){countedDoc=editor.state.doc;countedText=countedDoc.toString();counts=countWords(countedText);}const {from,to}=editor.state.selection.main;return {...counts,selectionWords:from===to?0:countSelection(countedText,from,to).words};};
    const handle:SourceEditorHandle={wordCounts,captureReadingPosition:remember,command:name=>{if(pathRef.current)runEditorCommand(editor,name);},focus:()=>editor.focus(),position:()=>{const head=editor.state.selection.main.head,line=editor.state.doc.lineAt(head);return {line1:line.number,column1:head-line.from+1};},selectBytes:(start,end)=>{navigation.current++;const path=pathRef.current,record=path?store.records.get(path):undefined;if(!record)return;const raw=store.text(record),bom=record.document.encoding==='utf8Bom'?3:0;const toEditor=(byte:number)=>raw.slice(0,byteToUtf16(raw,Math.max(0,byte-bom))).replaceAll('\r\n','\n').replaceAll('\r','\n').length;const anchor=toEditor(start),head=toEditor(end);editor.dispatch({selection:{anchor,head},effects:EditorView.scrollIntoView(anchor,{y:'center'})});editor.focus();},selection:()=>{const path=pathRef.current,buffer=path?store.records.get(path):undefined;if(!buffer)return null;const {from,to}=editor.state.selection.main;return from===to?null:selectionAnchor(buffer,from,to);},navigate:(line,column=1)=>{navigation.current++;const target=editor.state.doc.line(Math.max(1,Math.min(line,editor.state.doc.lines)));const position=Math.min(target.to,target.from+Math.max(0,column-1));editor.dispatch({selection:{anchor:position},effects:EditorView.scrollIntoView(position,{y:'center'})});editor.focus();}};
    callbacks.current.onReady?.(handle);
    return()=>{remember();editor.scrollDOM.removeEventListener('scroll',remember);capture.current=()=>{};callbacks.current.onReady?.(null);pathRef.current=null;ownership.current=null;editor.destroy();view.current=null;};
  },[store]);
  useLayoutEffect(()=>{
    fontSizeRef.current=logicalFontSize;
    const editor=view.current;if(!editor)return;
    const shown=visible&&!loading&&editor.scrollDOM.getClientRects().length>0;
    const top=shown?editor.lineBlockAtHeight(editor.scrollDOM.scrollTop):null;
    const fraction=top?(editor.scrollDOM.scrollTop-top.top)/Math.max(1,top.height):0,left=editor.scrollDOM.scrollLeft;
    editor.scrollDOM.style.fontSize=`${logicalFontSize/16}rem`;
    if(top){const path=pathRef.current;editor.requestMeasure({read:()=>editor.lineBlockAt(Math.min(top.from,editor.state.doc.length)),write:block=>{if(pathRef.current!==path||!editor.scrollDOM.getClientRects().length)return;editor.scrollDOM.scrollTop=block.top+fraction*block.height;editor.scrollDOM.scrollLeft=left;capture.current();}});}
  },[logicalFontSize,store]);
  const buffer=store.activePath?store.records.get(store.activePath):undefined;
  useLayoutEffect(()=>{
    // Workspace restoration may activate several cached buffers; only install the final visible document.
    const editor=view.current;if(!editor||!buffer||loading||!visible){shown.current=false;return;}
    if(shown.current&&pathRef.current===buffer.path&&ownership.current?.buffer===buffer&&store.owns(buffer,ownership.current.generation))return;shown.current=true;
    const previous=ownership.current;if(previous&&pathRef.current!==buffer.path&&store.owns(previous.buffer,previous.generation)){capture.current();store.trackState(previous.buffer,previous.generation,editor.state);}
    pathRef.current=buffer.path;ownership.current={buffer,generation:buffer.generation};
    const complete=(context:CompletionContext)=>{
      const token=context.matchBefore(/[\w:.-]*/);if(!token||(!context.explicit&&token.from===token.to))return null;
      const keys=new Set<string>();for(const record of store.records.values()){const text=store.text(record);for(const match of text.matchAll(/(?:\\label\{([^}]+)\}|@[\w]+\s*\{\s*([^,\s]+))/g))keys.add(match[1]??match[2]);}
      return {from:token.from,options:[...keys].slice(0,2000).map(label=>({label,type:'constant'}))};
    };
    const imagePaste=imagePasteExtension({onImages:files=>images.current?.(files)??Promise.resolve([]),getTexFilePath:()=>store.activePath===pathRef.current?pathRef.current:null,enabled:()=>!!images.current&&/\.(tex|ltx)$/i.test(pathRef.current??'')});
    if(!buffer.state)buffer.state=EditorState.create({doc:buffer.document.text,extensions:[imagePaste,spelling.of([]),phrases.of(EditorState.phrases.of(locale==='ko'?koreanPhrases:{})),...(buffer.document.newline==='crlf'?[EditorState.lineSeparator.of('\r\n')]:[]),...texShortcutExtensions(),selectableLineNumbers(),highlightActiveLineGutter(),highlightSpecialChars(),history(),drawSelection(),bracketMatching(),indentOnInput(),syntaxHighlighting(classHighlighter),highlightSelectionMatches(),autocompletion({override:[complete]}),editorTheme,language.of([]),editable.of([EditorState.readOnly.of(buffer.document.readOnly),EditorView.editable.of(!buffer.document.readOnly)]),EditorView.lineWrapping,EditorView.domEventHandlers({compositionstart:()=>{const owner=ownership.current;if(owner)store.composition(owner.buffer.path,true,owner.generation);return false;},compositionend:()=>{const owner=ownership.current;if(owner)store.composition(owner.buffer.path,false,owner.generation);return false;}}),EditorView.updateListener.of(update=>{
      const owner=ownership.current;if(!owner||!store.owns(owner.buffer,owner.generation))return;
      const record=owner.buffer,path=record.path;
      if(update.docChanged)store.update(path,update.state,update.changes,owner.generation);else store.trackState(record,owner.generation,update.state);
      if(update.selectionSet||update.docChanged){const {from,to}=update.state.selection.main;callbacks.current.onSelection?.(from===to?null:selectionAnchor(record,from,to));}
      if(update.selectionSet||update.docChanged){navigation.current++;const {anchor,head}=update.state.selection.main;const previous=store.readingPositions.get(path);store.rememberPosition(path,{top:previous?.top??0,inset:previous?.inset??0,left:previous?.left??0,anchor,head});}
    })]});
    const restored=store.readingPositions.get(buffer.path),position=restored?clampEditorPosition(restored,buffer.state.doc.length):undefined;
    if(position)buffer.state=buffer.state.update({selection:{anchor:position.anchor,head:position.head}}).state;
    store.trackState(buffer,buffer.generation,buffer.state);editor.setState(buffer.state);editor.dispatch({effects:phrases.reconfigure(EditorState.phrases.of(locale==='ko'?koreanPhrases:{}))});const active=buffer.path,installedGeneration=buffer.generation,sequence=++navigation.current;
    configureSpelling(editor);
    if(position)editor.requestMeasure({read:()=>view.current===editor&&pathRef.current===active&&navigation.current===sequence?editor.lineBlockAt(position.top).top:0,write:top=>{if(view.current!==editor||pathRef.current!==active||navigation.current!==sequence)return;editor.scrollDOM.scrollTop=Math.max(0,top+position.inset);editor.scrollDOM.scrollLeft=position.left;}});
    void languageFor(active).then(extension=>{if(view.current===editor&&pathRef.current===active&&store.owns(buffer,installedGeneration)){editor.dispatch({effects:language.reconfigure(extension)});}});
  },[buffer,buffer?.document,buffer?.generation,store,loading,visible]);
  useEffect(()=>{view.current?.dispatch({effects:phrases.reconfigure(EditorState.phrases.of(locale==='ko'?koreanPhrases:{}))});},[locale]);
  useEffect(()=>{const editor=view.current;if(editor&&buffer&&pathRef.current===buffer.path)configureSpelling(editor);},[spellCheck,spellIgnore,spellEngine,buffer?.path,loading,visible]);
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
  return <div className="source-editor-frame" hidden={loading} ref={frame} data-font-size={logicalFontSize}>
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
      <button className="editor-sync-button" type="button" disabled={!buffer||loading} style={{display:'inline-flex',alignItems:'center',gap:'.25rem'}} aria-label={t('PDF에서 위치 보기 · Ctrl+Alt+J','Show position in PDF · Ctrl+Alt+J')} title={t('PDF에서 위치 보기 · Ctrl+Alt+J','Show position in PDF · Ctrl+Alt+J')} onClick={()=>{const editor=view.current,path=pathRef.current;if(!editor||!path||!visible||loading)return;const offset=editor.state.selection.main.head,line=editor.state.doc.lineAt(offset);window.dispatchEvent(new CustomEvent('texypaper:sync-source-requested',{detail:{path,line1:line.number,column1:offset-line.from+1}}));}}><Icon name="document" size={14}/><span>{t('PDF에서 위치 보기','Show in PDF')}</span></button>
      <output className="editor-font-size" aria-label={t('소스 글자 크기','Source font size')} title={t('Ctrl+휠 또는 Ctrl+더하기/빼기: 소스 글자 크기','Ctrl+wheel or Ctrl+plus/minus: source font size')}>{logicalFontSize}px</output>
    </div>
    <div className="source-editor" data-testid="source-editor" data-path={buffer?.path??''} data-language={/\.(tex|ltx|sty|cls|bib|bst|bbx|cbx)$/i.test(buffer?.path??'')?'tex':undefined} aria-busy={loading} hidden={loading} ref={host} aria-label={buffer?t(`소스 편집기: ${buffer.path}`,`Source editor: ${buffer.path}`):t('소스 편집기','Source editor')} />
  </div>;
}
