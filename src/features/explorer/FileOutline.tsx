import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import type { BufferStore } from '../../editor/buffers';
import { Icon } from '../../ui/Icon';
import { t, useI18n } from '../../ui/i18n';
import { MAX_OUTLINE_BYTES, parseOutline, type OutlineHeading } from './outline';

type Props={store:BufferStore;onNavigate:(line:number)=>void};
export function FileOutline({store,onNavigate}:Props) {
  useI18n();
  useSyncExternalStore(store.subscribe,store.snapshot);
  const [expanded,setExpanded]=useState(true);
  const [outline,setOutline]=useState<{path:string|null;headings:OutlineHeading[]}>({path:null,headings:[]});
  const contentId=useId(),path=store.activePath;
  const buffer=path?store.records.get(path):undefined;
  const isTex=!!path&&/\.(tex|ltx)$/i.test(path);
  useEffect(()=>{
    if(!path||!isTex||!buffer)return;
    const timer=window.setTimeout(()=>{
      const current=store.records.get(path);
      if(store.activePath!==path||!current||current.evicted)return;
      const text=current.state?current.state.doc.sliceString(0,Math.min(current.state.doc.length,MAX_OUTLINE_BYTES)):(current.rawText??current.document.text).slice(0,MAX_OUTLINE_BYTES);
      setOutline({path,headings:parseOutline(text)});
    },220);
    return()=>window.clearTimeout(timer);
  },[store,path,isTex,buffer?.version,buffer?.document]);
  const headings=isTex&&outline.path===path?outline.headings:[];
  const scopeHint=t('현재 파일의 소스 순서로 매긴 번호입니다. 컴파일된 문서의 번호와 다를 수 있습니다.','Numbers follow source order in the current file and may differ from the compiled document.');
  return <section className="file-outline" aria-label={t('문서 개요','File outline')}>
    <button className="outline-heading" type="button" aria-expanded={expanded} aria-controls={contentId} aria-description={scopeHint} title={scopeHint} onClick={()=>setExpanded(value=>!value)}>
      <Icon name={expanded?'chevronDown':'chevronRight'} size={14}/><span>{t('문서 개요','File outline')}</span>
    </button>
    <div id={contentId} hidden={!expanded}>
      {headings.length>0?<ol className="outline-list">{headings.map(heading=>{
        const title=heading.title||t('제목 없는 절','Untitled section');
        const label=heading.number?`${heading.number} ${title}`:title;
        return <li key={`${heading.line}-${heading.level}`}><button className="outline-item" type="button" style={{paddingInlineStart:12+(heading.level-1)*12}} title={`${label} — ${t(`${heading.line}줄로 이동`,`Go to line ${heading.line}`)}`} onClick={()=>onNavigate(heading.line)}>{heading.number&&<span className="outline-number">{heading.number}</span>}<span className="outline-title">{title}</span></button></li>;
      })}</ol>:<p className="outline-empty">{isTex?t('절 제목을 추가하면 여기에 표시됩니다.','Section headings appear here.'):t('TeX 파일을 열면 개요가 표시됩니다.','Open a TeX file to see its outline.')}</p>}
    </div>
  </section>;
}
