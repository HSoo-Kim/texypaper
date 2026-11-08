import { Fragment, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { texShortcutGroups, type TexShortcutGroup } from '../editor/texShortcuts';
import { Icon } from './Icon';
import { t, useI18n, type Locale } from './i18n';
import './shortcutHelp.css';

type Label={ko:string;en:string};
type ShortcutDefinition={id:string;label:Label;hint?:Label;keys:readonly string[]};
type CategoryDefinition={id:string;label:Label;description:Label;note?:Label;rows:readonly ShortcutDefinition[]};
export type ShortcutHelpRow={id:string;label:string;hint?:string;keys:readonly string[]};
export type ShortcutHelpCategory={id:string;label:string;description:string;note?:string;rows:ShortcutHelpRow[]};

const appCategories:readonly CategoryDefinition[]=[
  {id:'start',label:{ko:'시작·프로젝트',en:'Start and projects'},description:{ko:'홈에서 프로젝트를 관리하고, 작업 중에는 파일 이름으로 빠르게 이동하세요.',en:'Manage projects from Home and jump between files by name while you work.'},rows:[
    {id:'home',label:{ko:'홈 · 프로젝트 관리',en:'Home · Manage projects'},keys:['Ctrl+O']},
    {id:'quick-open',label:{ko:'빠른 파일 열기',en:'Quick open'},hint:{ko:'파일 이름으로 찾기 · >를 입력하면 프로젝트 본문 검색',en:'Find by filename · type > to search project text'},keys:['Ctrl+P']},
    {id:'exit',label:{ko:'TexyPaper 완전 종료',en:'Exit TexyPaper'},hint:{ko:'창을 닫는 대신 앱을 완전히 종료합니다.',en:'Quit the app completely rather than just closing the window.'},keys:['Ctrl+Shift+Q']},
  ]},
  {id:'compile-pdf',label:{ko:'컴파일·PDF',en:'Compile and PDF'},description:{ko:'소스를 컴파일해 PDF를 갱신하고, 소스와 PDF의 같은 위치를 오가세요.',en:'Compile your source to update the PDF, then move between corresponding source and PDF locations.'},note:{ko:'PDF의 Ctrl+클릭은 소스로 이동합니다. 소스의 Ctrl+클릭은 다중 커서를 추가합니다.',en:'Ctrl+click in the PDF jumps to its source. In the source editor, Ctrl+click adds another cursor.'},rows:[
    {id:'build-now',label:{ko:'즉시 빌드',en:'Build now'},keys:['Ctrl+Shift+B']},
    {id:'source-to-pdf',label:{ko:'소스 커서에서 PDF로 이동',en:'Go from the source cursor to PDF'},hint:{ko:'컴파일된 PDF가 있어야 합니다.',en:'Requires a compiled PDF.'},keys:['Ctrl+Alt+J']},
    {id:'pdf-to-source',label:{ko:'PDF에서 클릭한 위치의 소스로 이동',en:'Go to the source of a PDF location'},keys:['Ctrl+click']},
  ]},
  {id:'display',label:{ko:'확대·화면',en:'Zoom and view'},description:{ko:'소스, PDF, AI 대화의 크기를 각각 조절합니다. 앱 전체 UI 배율은 설정에서 바꾸세요.',en:'Adjust the source, PDF and AI chat separately. Change the app-wide UI scale in Settings.'},rows:[
    {id:'pointer-zoom',label:{ko:'포인터 아래 패널 확대·축소',en:'Zoom the pane under the pointer'},hint:{ko:'조절할 소스·PDF·AI 대화 위에서 휠을 움직이세요.',en:'Scroll over the source, PDF or AI chat you want to resize.'},keys:['Ctrl+Wheel']},
    {id:'focus-zoom-in',label:{ko:'포커스한 패널 확대',en:'Zoom in the focused pane'},hint:{ko:'먼저 조절할 패널을 클릭하세요.',en:'Click the pane you want to resize first.'},keys:['Ctrl++']},
    {id:'focus-zoom-out',label:{ko:'포커스한 패널 축소',en:'Zoom out the focused pane'},keys:['Ctrl+-']},
  ]},
  {id:'ai-comments',label:{ko:'AI·댓글',en:'AI and comments'},description:{ko:'선택한 내용을 AI에 첨부하거나 댓글로 남기세요. 소스와 PDF의 우클릭 메뉴에서도 시작할 수 있습니다.',en:'Attach a selection to AI chat or leave a comment. You can also start from the source or PDF right-click menu.'},rows:[
    {id:'attach-ai',label:{ko:'선택 또는 현재 줄을 AI에 첨부',en:'Attach selection or current line to AI'},hint:{ko:'소스 선택이 없으면 커서가 있는 줄을 첨부합니다.',en:'With no source selection, attaches the line at the cursor.'},keys:['Ctrl+L']},
    {id:'context-menu',label:{ko:'선택 메뉴 열기',en:'Open the selection menu'},hint:{ko:'소스·PDF에서 AI 첨부와 댓글 추가 등을 선택합니다.',en:'Choose AI attachment, comments and other actions in the source or PDF.'},keys:['Right-click']},
    {id:'comments-panel',label:{ko:'댓글 패널 열기·닫기',en:'Toggle comments panel'},keys:['Ctrl+J']},
    {id:'add-comment',label:{ko:'선택에 댓글 추가',en:'Comment on selection'},keys:['Ctrl+Shift+C']},
    {id:'send-ai',label:{ko:'AI 메시지 보내기',en:'Send AI message'},hint:{ko:'AI 대화 입력란에서 사용합니다.',en:'Use inside the AI chat input.'},keys:['Ctrl+Enter']},
  ]},
];

const editorDescriptions:Record<string,Label>={
  compile:{ko:'소스 편집기에 포커스를 두고 자동 완성, 찾기·바꾸기, 줄 이동을 사용하세요.',en:'Use completion, find and replace, and line navigation while the source editor is focused.'},
  edit:{ko:'선택 영역에 서식을 넣거나 줄을 정리하세요. 일부 줄 작업은 선택이 없으면 현재 줄에 적용됩니다.',en:'Format selections and organize lines. Some line actions use the current line when nothing is selected.'},
  navigation:{ko:'문서 안을 이동하거나 여러 커서를 추가해 떨어진 위치를 한 번에 편집하세요.',en:'Move through your document or add cursors to edit separate locations together.'},
  fold:{ko:'소스 편집기에서 블록을 접어 긴 문서의 구조를 살펴보세요. 접힌 내용은 삭제되지 않습니다.',en:'Fold source blocks to navigate the structure of a long document. Folding does not delete any text.'},
};

/** The compile row is shown once, in the PDF workflow; all editor rows come from live keymap definitions. */
export function buildShortcutHelpCategories(locale:Locale,groups:readonly TexShortcutGroup[]=texShortcutGroups):ShortcutHelpCategory[] {
  const categories:ShortcutHelpCategory[]=appCategories.map(category=>({id:category.id,label:category.label[locale],description:category.description[locale],note:category.note?.[locale],rows:category.rows.map(row=>({id:row.id,label:row.label[locale],hint:row.hint?.[locale],keys:row.keys}))}));
  const compileGroup=groups.find(group=>group.id==='compile');
  const compileRow=compileGroup?.shortcuts.find(row=>row.id==='compile');
  if(compileGroup&&compileRow)categories.find(category=>category.id==='compile-pdf')!.rows.unshift({id:`tex:${compileGroup.id}:${compileRow.id}`,label:compileRow.label[locale],keys:compileRow.keys});
  for(const group of groups){
    categories.push({id:group.id,label:group.label[locale],description:(editorDescriptions[group.id]??{ko:'소스 편집기에 포커스를 두고 사용하는 단축키입니다.',en:'Use these shortcuts while the source editor is focused.'})[locale],note:group.id==='edit'?{ko:'Overleaf와 같은 키를 사용합니다. 줄 삭제는 Ctrl+D, 줄 주석 전환은 Ctrl+/입니다.',en:'Uses the same keys as Overleaf: Ctrl+D deletes lines; Ctrl+/ toggles line comments.'}[locale]:undefined,rows:group.shortcuts.filter(row=>row!==compileRow).map(row=>({id:`tex:${group.id}:${row.id}`,label:row.label[locale],keys:row.keys}))});
  }
  return categories;
}

/** Whitespace around / distinguishes alternatives from the Ctrl+/ key itself. */
export function splitShortcutKeys(keys:readonly string[]|string):string[][] {
  const alternatives=typeof keys==='string'?[keys]:keys;
  return alternatives.flatMap(value=>value.split(/\s+\/\s+/)).map(value=>{
    const combo=value.trim();
    const parts=combo.endsWith('++')?[...combo.slice(0,-2).split('+'),'+']:combo.split('+');
    return parts.filter(Boolean).map(key=>/^[a-z]$/.test(key)?key.toUpperCase():key);
  }).filter(parts=>parts.length>0);
}

export function filterShortcutHelpCategories(categories:readonly ShortcutHelpCategory[],query:string):ShortcutHelpCategory[] {
  const terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if(!terms.length)return [...categories];
  return categories.flatMap(category=>{
    const rows=category.rows.filter(row=>{
      const text=[category.label,row.label,row.hint??'',...row.keys].join(' ').toLocaleLowerCase();
      return terms.every(term=>text.includes(term));
    });
    return rows.length?[{...category,rows}]:[];
  });
}


function ShortcutKeycaps({keys}:{keys:readonly string[]}) {
  const keyLabels:Record<string,string>={click:t('클릭','Click'),drag:t('드래그','Drag'),Wheel:t('휠','Wheel'),'Right-click':t('우클릭','Right-click')};
  return <div className="shortcut-help-keys">{splitShortcutKeys(keys).map((parts,index)=><Fragment key={`${parts.join('+')}:${index}`}>{index>0&&<span className="shortcut-help-or">{t('또는','or')}</span>}<span className="shortcut-help-combo">{parts.map((key,keyIndex)=><Fragment key={`${key}:${keyIndex}`}>{keyIndex>0&&<span className="shortcut-help-plus">+</span>}<kbd>{keyLabels[key]??key}</kbd></Fragment>)}</span></Fragment>)}</div>;
}

export function ShortcutHelp({open,onClose,onOpenSettings}:{open:boolean;onClose:()=>void;onOpenSettings:()=>void}) {
  const {locale}=useI18n();
  const id=useId();
  const categories=useMemo(()=>buildShortcutHelpCategories(locale),[locale]);
  const [selectedId,setSelectedId]=useState('start');
  const [query,setQuery]=useState('');
  const buttons=useRef<(HTMLButtonElement|null)[]>([]);
  const content=useRef<HTMLDivElement>(null);
  const searching=query.trim().length>0;
  const results=useMemo(()=>filterShortcutHelpCategories(categories,query),[categories,query]);
  const selected=categories.find(category=>category.id===selectedId)??categories[0];
  const shown=searching?results:[selected];
  const selectCategory=(categoryId:string)=>{setSelectedId(categoryId);setQuery('');if(content.current)content.current.scrollTop=0;};
  const navigate=(event:KeyboardEvent<HTMLButtonElement>,index:number)=>{
    const key=event.key;
    if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(key))return;
    event.preventDefault();
    const next=key==='Home'?0:key==='End'?categories.length-1:(index+(key==='ArrowUp'||key==='ArrowLeft'?-1:1)+categories.length)%categories.length;
    selectCategory(categories[next].id);buttons.current[next]?.focus();
  };
  if(!open)return null;
  return <div className="modal-scrim shortcut-help-scrim" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(query)setQuery('');else onClose();}}}>
    <section className="shortcut-help" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`} data-testid="shortcut-help">
      <header className="shortcut-help-header"><div><h2 id={`${id}-title`}>{t('키보드 단축키','Keyboard shortcuts')}</h2><p id={`${id}-intro`}>{t('작업별로 찾아보고, 익숙한 키로 이어서 작업하세요.','Find the keys for your task and keep your work moving.')}</p></div><button type="button" className="icon-button" aria-label={t('단축키 도움말 닫기','Close shortcut help')} onClick={onClose}><Icon name="close"/></button></header>
      <div className="shortcut-help-layout">
        <aside className="shortcut-help-sidebar">
          <label className="shortcut-help-search" htmlFor={`${id}-search`}><span>{t('단축키 검색','Search shortcuts')}</span><span className="shortcut-help-search-field"><Icon name="search" size={16}/><input id={`${id}-search`} type="search" data-testid="shortcut-search" placeholder={t('작업 이름 또는 키','Action or key')} value={query} onChange={event=>{setQuery(event.target.value);if(content.current)content.current.scrollTop=0;}} onKeyDown={event=>{if(event.key==='Escape'&&query){event.preventDefault();event.stopPropagation();setQuery('');}}}/></span></label>
          <nav className="shortcut-help-toc" aria-label={t('단축키 분류','Shortcut categories')} data-testid="shortcut-toc"><ul>{categories.map((category,index)=><li key={category.id}><button type="button" ref={element=>{buttons.current[index]=element;}} aria-current={!searching&&category.id===selected.id?'true':undefined} aria-controls={`${id}-content`} tabIndex={category.id===selected.id?0:-1} onClick={()=>selectCategory(category.id)} onKeyDown={event=>navigate(event,index)}><span>{category.label}</span><span className="shortcut-help-count" aria-hidden="true">{category.rows.length}</span></button></li>)}</ul></nav>
          <p className="shortcut-help-platform">{t('Windows 키보드 기준','Windows keyboard shortcuts')}</p>
        </aside>
        <div ref={content} id={`${id}-content`} className="shortcut-help-content" role="region" aria-label={searching?t('단축키 검색 결과','Shortcut search results'):selected.label} tabIndex={0}>
          {searching&&<div className="shortcut-help-results" role="status">{t(`검색 결과 ${results.reduce((count,category)=>count+category.rows.length,0)}개`,`${results.reduce((count,category)=>count+category.rows.length,0)} shortcuts found`)}</div>}
          {shown.map(category=><section className="shortcut-help-category" data-testid="shortcut-category" data-id={category.id} key={category.id} aria-labelledby={`${id}-${category.id}`}><h3 id={`${id}-${category.id}`}>{category.label}</h3><p className="shortcut-help-description">{category.description}</p><dl className="shortcut-help-rows">{category.rows.map(row=><div className="shortcut-help-row" key={row.id}><dt>{row.label}{row.hint&&<span>{row.hint}</span>}</dt><dd><ShortcutKeycaps keys={row.keys}/></dd></div>)}</dl>{category.note&&<p className="shortcut-help-note">{category.note}</p>}</section>)}
          {searching&&!results.length&&<div className="shortcut-help-empty"><Icon name="search" size={24}/><h3>{t('일치하는 단축키가 없습니다.','No matching shortcuts.')}</h3><p>{t('다른 작업 이름이나 Ctrl 같은 키 이름으로 검색하세요.','Try another action name or a key such as Ctrl.')}</p><button type="button" onClick={()=>setQuery('')}>{t('검색 지우기','Clear search')}</button></div>}
        </div>
      </div>
      <footer className="shortcut-help-footer"><span>{t('Esc로 닫기 · 검색 중에는 먼저 검색어를 지웁니다.','Esc closes · clears your search first.')}</span><button type="button" onClick={()=>{onClose();onOpenSettings();}}><Icon name="settings" size={15}/>{t('설정','Settings')}</button></footer>
    </section>
  </div>;
}
