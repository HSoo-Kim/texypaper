import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {GlobalWorkerOptions,getDocument,TextLayer,type PDFDataRangeTransport,type PDFDocumentProxy,type PDFDocumentLoadingTask,type PDFPageProxy,type PageViewport} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type {WorkspaceRef,BuildManifest} from '../contracts';
import {request} from '../api';
import {createArtifactTransport,type ArtifactMetadata} from './artifactTransport';
import {boundedPixelRatio,RenderBudget,retainedPages} from './renderBudget';
import {captureSelection,pdfRectToViewport,type PdfTextItem} from './selection';
import {PageLifecycle} from './pageLifecycle';
import {readPageSearchText,selectionTextStream} from './pageText';
import {queueDocumentTeardown,waitForDocumentTeardown} from './documentLifecycle';
import './pdf.css';
import {useI18n} from '../ui/i18n';
import {Icon} from '../ui/Icon';
import {invoke} from '@tauri-apps/api/core';
GlobalWorkerOptions.workerSrc=workerUrl;
type Props={workspace:WorkspaceRef;manifest:BuildManifest|null;referencePath?:string;buildControls?:ReactNode;logs?:ReactNode;logsOpen?:boolean;onSelection?:(selection:unknown)=>void;onError?:(error:unknown)=>void;onNavigate?:(location:{path:string;line1:number})=>void;onManifest?:(manifest:BuildManifest)=>void;onReturnToBuild?:()=>void};
type PageEntry={layer:HTMLElement;viewport:PageViewport;view:number[];userUnit:number;items:PdfTextItem[]};
type PdfMark={threadId:string;page:number;rects:number[][];status:string};
type SyncTarget={page:number;h:number;v:number;W:number;H:number};
export function PdfPreview({workspace,manifest,referencePath,buildControls,logs,logsOpen=false,onSelection,onError,onReturnToBuild}:Props){
 const {t}=useI18n();
 const artifactBuildId=referencePath?undefined:manifest?.buildId;
 const errorCallback=useRef(onError);errorCallback.current=onError;
 const [pdf,setPdf]=useState<PDFDocumentProxy|null>(null),[metadata,setMetadata]=useState<ArtifactMetadata|null>(null),[current,setCurrent]=useState(1),[zoom,setZoom]=useState(1),[fit,setFit]=useState(true),[rotation,setRotation]=useState(0),[size,setSize]=useState({width:612,height:792}),[width,setWidth]=useState(700),[error,setError]=useState(''),[loading,setLoading]=useState(false),[search,setSearch]=useState(''),[results,setResults]=useState<{page:number;text:string}[]>([]),[searching,setSearching]=useState(false),[password,setPassword]=useState(false),[passwordValue,setPasswordValue]=useState('');
 const [marks,setMarks]=useState<PdfMark[]>([]),[syncTarget,setSyncTarget]=useState<SyncTarget|null>(null);
 const [fallbackPair,setFallbackPair]=useState<{asciiBuildId:string;unicodeBuildId:string}|null>(null),[gateStatus,setGateStatus]=useState<'idle'|'pending'|'passed'|'failed'>('idle');
 const manifestHistory=useRef<{workspace:string;epoch:number;items:BuildManifest[]}>({workspace:workspace.id,epoch:workspace.epoch,items:[]});
 useEffect(()=>{const history=manifestHistory.current;if(history.workspace!==workspace.id||history.epoch!==workspace.epoch){history.workspace=workspace.id;history.epoch=workspace.epoch;history.items=[];setFallbackPair(null);setGateStatus('idle');}if(!manifest)return;history.items=[manifest,...history.items.filter(item=>item.rootTex!==manifest.rootTex)].slice(0,2);const ascii=history.items.find(item=>/^[\x00-\x7f]+$/.test(item.rootTex)),unicode=history.items.find(item=>/[^\x00-\x7f]/.test(item.rootTex));if(ascii&&unicode){setFallbackPair({asciiBuildId:ascii.buildId,unicodeBuildId:unicode.buildId});setGateStatus('idle');}},[workspace.id,workspace.epoch,manifest?.buildId]);
 const container=useRef<HTMLDivElement>(null),pages=useRef(new Map<number,PageEntry>()),budget=useRef(new RenderBudget()),cancelLoading=useRef<(()=>void)|null>(null),passwordReply=useRef<((password:string)=>void)|null>(null),searchAbort=useRef<AbortController|null>(null),position=useRef({page:1,fraction:0});
 const stoppers=useRef(new Map<number,()=>Promise<void>>());
 const fail=useCallback((cause:unknown)=>{let message=String(cause);if(cause instanceof Error)message=cause.message;else if(cause&&typeof cause==='object'&&'message'in cause)message=String(cause.message);setError(message);errorCallback.current?.(cause);},[]);
 useEffect(()=>{const node=container.current;if(!node)return;const observer=new ResizeObserver(([entry])=>setWidth(Math.max(100,entry.contentRect.width-40)));observer.observe(node);return()=>observer.disconnect();},[]);
 useEffect(()=>{
  let stopped=false,disposed=false;const controller=new AbortController();let task:PDFDocumentLoadingTask|null=null,transport:PDFDataRangeTransport|null=null;
  const dispose=()=>{
   if(disposed)return;disposed=true;stopped=true;controller.abort();transport?.abort();transport=null;
   passwordReply.current=null;searchAbort.current?.abort();searchAbort.current=null;pages.current.clear();
   const loadingTask=task;task=null;
   if(cancelLoading.current===dispose)cancelLoading.current=null;
   const pending=Array.from(stoppers.current.values()).map(stop=>stop());stoppers.current.clear();
   void queueDocumentTeardown(async()=>{
    try{await Promise.all(pending);}finally{budget.current.clear();try{await loadingTask?.destroy();}finally{TextLayer.cleanup();}}
   }).catch(cause=>errorCallback.current?.(cause));
  };
  cancelLoading.current=dispose;
  setLoading(true);setPdf(null);setError('');setMetadata(null);setMarks([]);setSyncTarget(null);pages.current.clear();window.getSelection()?.removeAllRanges();searchAbort.current?.abort();searchAbort.current=null;setResults([]);setSearching(false);passwordReply.current=null;setPassword(false);setPasswordValue('');
  const loading=async()=>{await waitForDocumentTeardown();if(stopped)return;try{
   const data=await request<ArtifactMetadata>('artifact_metadata',workspace,referencePath?{path:referencePath}:{buildId:artifactBuildId});if(stopped)return;if(!data.length)throw new Error('PDF_EMPTY');
   const scopedTransport=await createArtifactTransport(data,controller.signal);if(stopped){scopedTransport.abort();return;}transport=scopedTransport;
   // Hardware canvases are composited directly; PDF.js's default software canvas is repainted as a new cached compositor image on every render.
   task=getDocument({range:transport,rangeChunkSize:65536,disableAutoFetch:true,disableStream:true,disableWorkerRendering:true,enableHWA:true,enableXfa:false,cMapUrl:'/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/pdfjs/standard_fonts/',wasmUrl:'/pdfjs/wasm/',useWorkerFetch:true});
   task.onPassword=(reply:(value:string)=>void)=>{if(stopped)return;passwordReply.current=reply;setPassword(true);};
   const document=await task.promise;if(stopped)return;const first=await document.getPage(1);if(stopped){first.cleanup();return;}const view=first.getViewport({scale:1});first.cleanup();
   passwordReply.current=null;setPassword(false);setSize({width:view.width,height:view.height});setMetadata(data);setPdf(document);setCurrent(Math.min(document.numPages,position.current.page));setLoading(false);
   window.dispatchEvent(new CustomEvent('texypaper:pdf-identity',{detail:{workspaceId:workspace.id,epoch:workspace.epoch,buildId:data.buildId,pdfSha256:data.sha256,referencePath,pageCount:document.numPages}}));
  }catch(cause){if(!stopped){setLoading(false);setPassword(false);fail(cause);dispose();}}};
  if(artifactBuildId!==undefined||referencePath)void loading();else setLoading(false);
  return()=>{dispose();window.getSelection()?.removeAllRanges();window.dispatchEvent(new CustomEvent('texypaper:pdf-identity',{detail:{workspaceId:workspace.id,epoch:workspace.epoch,closed:true}}));};
 },[workspace.id,workspace.epoch,artifactBuildId,referencePath,fail]);
 useEffect(()=>{const listener=(event:Event)=>fail((event as CustomEvent).detail);window.addEventListener('texypaper:pdf-error',listener);return()=>window.removeEventListener('texypaper:pdf-error',listener);},[fail]);
 const scale=fit?width/(rotation%180?size.height:size.width):zoom;
 const pageWidth=(rotation%180?size.height:size.width)*scale,pageHeight=(rotation%180?size.width:size.height)*scale;
 useEffect(()=>{if(!pdf||!container.current)return;const node=container.current;const top=(current-1)*(pageHeight+24);if(Math.abs(node.scrollTop-top)>pageHeight)node.scrollTop=top+position.current.fraction*pageHeight;},[pdf]);
 function jump(page:number){const next=Math.max(1,Math.min(pdf?.numPages??1,page));setCurrent(next);position.current={page:next,fraction:0};container.current?.scrollTo({top:(next-1)*(pageHeight+24)});}
 useEffect(()=>{
  const forward=(event:Event)=>{if(referencePath||!(event instanceof CustomEvent))return;const value:unknown=event.detail;if(!value||typeof value!=='object'||!('records'in value)||!Array.isArray(value.records)||!('buildId'in value)||value.buildId!==manifest?.buildId)return;for(const record of value.records){if(!record||typeof record!=='object')continue;if(typeof record.page==='number'&&typeof record.h==='number'&&typeof record.v==='number'&&typeof record.W==='number'&&typeof record.H==='number'&&[record.page,record.h,record.v,record.W,record.H].every(Number.isFinite)){setSyncTarget({page:record.page,h:record.h,v:record.v,W:record.W,H:record.H});if(metadata?.buildId===value.buildId)jump(record.page);else{position.current={page:record.page,fraction:0};setCurrent(record.page);}break;}}};
  const comments=(event:Event)=>{if(!(event instanceof CustomEvent))return;const value:unknown=event.detail;if(!value||typeof value!=='object'||!('pdfSha256'in value)||value.pdfSha256!==metadata?.sha256||!('marks'in value)||!Array.isArray(value.marks))return;const next:PdfMark[]=[];for(const mark of value.marks){if(mark&&typeof mark==='object'&&typeof mark.threadId==='string'&&typeof mark.page==='number'&&Array.isArray(mark.rects)&&typeof mark.status==='string'){const rects=mark.rects.filter((rect:unknown):rect is number[]=>Array.isArray(rect)&&rect.length===4&&rect.every(n=>typeof n==='number'&&Number.isFinite(n)));next.push({threadId:mark.threadId,page:mark.page,rects,status:mark.status});}if(next.length>=1000)break;}setMarks(next);};
  window.addEventListener('texypaper:sync-forward',forward);window.addEventListener('texypaper:comment-marks',comments);
  return()=>{window.removeEventListener('texypaper:sync-forward',forward);window.removeEventListener('texypaper:comment-marks',comments);};
 },[metadata?.sha256,metadata?.buildId,manifest?.buildId,referencePath,pdf,pageHeight]);
 async function find(){
  searchAbort.current?.abort();searchAbort.current=null;setSearching(false);setResults([]);
  if(!pdf||!search.trim())return;
  const controller=new AbortController();searchAbort.current=controller;setSearching(true);
  const query=search.normalize('NFC').toLocaleLowerCase(),found:{page:number;text:string}[]=[];
  try{
   for(let number=1;number<=pdf.numPages&&!controller.signal.aborted;number++){
    const cached=pages.current.get(number);let text:string;
    if(cached)text=cached.items.map(item=>item.str).join(' ');
    else{
     const page=await pdf.getPage(number);
     try{if(controller.signal.aborted)break;text=await readPageSearchText(page,controller.signal);}
     finally{if(!stoppers.current.has(number))page.cleanup();}
    }
    if(controller.signal.aborted)break;
    const offset=text.normalize('NFC').toLocaleLowerCase().indexOf(query);
    if(offset>=0){found.push({page:number,text:text.slice(Math.max(0,offset-32),offset+query.length+64)});setResults([...found]);}
    if(found.length>=200)break;
    const delay=Promise.withResolvers<void>();setTimeout(delay.resolve,0);await delay.promise;
   }
  }catch(cause){if(!controller.signal.aborted)fail(cause);}
  finally{if(searchAbort.current===controller){searchAbort.current=null;setSearching(false);}}
 }
 function changeZoom(direction:1|-1){const levels=[0.5,0.75,1,1.25,1.5,2,3];setFit(false);setZoom(direction===1?(levels.find(value=>value>scale+0.001)??3):([...levels].reverse().find(value=>value<scale-0.001)??0.5));}
 const selected=()=>{const selection=window.getSelection();if(!selection||!metadata)return;try{const captured=captureSelection(selection,{buildId:metadata.buildId,pdfSha256:metadata.sha256},pages.current);if(captured)onSelection?.(captured);}catch(cause){fail(cause);}};
 return <section className="pdf-preview" aria-label={t('PDF 미리보기','PDF preview')} data-build-id={pdf&&metadata?metadata.buildId:''} data-reference={referencePath?'true':'false'}>
  <div className="pdf-toolbar" role="toolbar" aria-label={t('PDF 도구','PDF tools')}>
   <div className="pdf-build-actions">
    {buildControls}
    <button className="pdf-export" disabled={!metadata} onClick={()=>{void request('export_pdf',workspace,{buildId:metadata?.buildId}).catch(fail);}} aria-label={t('PDF 내보내기','Export PDF')} title={t('PDF 내보내기','Export PDF')}><Icon name="download"/><span>{t('PDF 내보내기','Export PDF')}</span></button>
   </div>
   <div className="pdf-navigation" role="group" aria-label={t('페이지 탐색','Page navigation')}>
    <button className="icon-button" disabled={!pdf||current===1} onClick={()=>jump(current-1)} aria-label={t('이전 페이지','Previous page')} title={t('이전 페이지','Previous page')}><Icon name="chevronLeft"/></button>
    <label><span className="pdf-sr-only">{t('페이지','Page')}</span><input aria-label={t('PDF 페이지','PDF page')} type="number" min={1} max={pdf?.numPages??1} value={current} onChange={event=>jump(Number(event.target.value)||1)}/></label><span className="pdf-page-count">/ {pdf?.numPages??0}</span>
    <button className="icon-button" disabled={!pdf||current===(pdf?.numPages??1)} onClick={()=>jump(current+1)} aria-label={t('다음 페이지','Next page')} title={t('다음 페이지','Next page')}><Icon name="chevronRight"/></button>
   </div>
   <div className="pdf-zoom" role="group" aria-label={t('확대','Zoom')}>
    <button className="icon-button" disabled={!pdf||scale<=0.5} onClick={()=>changeZoom(-1)} aria-label={t('축소','Zoom out')} title={t('축소','Zoom out')}><Icon name="zoomOut"/></button>
    <label><span className="pdf-sr-only">{t('확대','Zoom')}</span><select aria-label={t('PDF 확대','PDF zoom')} value={fit?'fit':String(zoom)} onChange={event=>{setFit(event.target.value==='fit');if(event.target.value!=='fit')setZoom(Number(event.target.value));}}><option value="fit">{t('자동','Auto')}</option>{[0.5,0.75,1,1.25,1.5,2,3].map(value=><option key={value} value={value}>{value*100}%</option>)}</select></label>
    <button className="icon-button" disabled={!pdf||scale>=3} onClick={()=>changeZoom(1)} aria-label={t('확대','Zoom in')} title={t('확대','Zoom in')}><Icon name="zoomIn"/></button>
   </div>
  </div>
  <div className="pdf-secondary-toolbar">
   <div className="pdf-view-options" role="group" aria-label={t('PDF 보기 설정','PDF view options')}>
    <button onClick={()=>setFit(true)} aria-pressed={fit}>{t('너비 맞춤','Fit width')}</button>
    <button onClick={()=>{setFit(false);setZoom(1);}}>{t('실제 크기','Actual size')}</button>
    <button onClick={()=>{window.getSelection()?.removeAllRanges();setRotation(value=>(value+90)%360);}} aria-label={t('PDF 90도 회전','Rotate PDF 90 degrees')} title={t('PDF 90도 회전','Rotate PDF 90 degrees')}><Icon name="refresh" size={14}/><span>{rotation}°</span></button>
   </div>
   <form className="pdf-search" onSubmit={event=>{event.preventDefault();void find();}}><input aria-label={t('PDF 텍스트 검색','Search PDF text')} value={search} onChange={event=>setSearch(event.target.value)} placeholder={t('PDF에서 찾기','Find in PDF')}/><button className="icon-button" disabled={!pdf} aria-label={t('검색','Search')} title={t('검색','Search')}><Icon name="search" size={15}/></button>{searching&&<button className="icon-button" type="button" aria-label={t('검색 중지','Stop search')} title={t('검색 중지','Stop search')} onClick={()=>{searchAbort.current?.abort();setSearching(false);}}><Icon name="stop" size={14}/></button>}<span className="pdf-search-status" role="status">{results.length?`${results.length} ${t('개 결과','results')}${results.length===200?t(' (최대 200개)',' (limit 200)'):''}`:''}</span></form>
  </div>
  {(fallbackPair||referencePath)&&<div className="pdf-context-actions">
   {fallbackPair&&<button data-testid="unicode-mapping-gate" data-status={gateStatus} disabled={gateStatus==='pending'} onClick={()=>{setGateStatus('pending');void request<{status:string}>('sync_validate_fallback',workspace,fallbackPair).then(result=>setGateStatus(result.status==='passed'?'passed':'failed')).catch(cause=>{setGateStatus('failed');fail(cause);});}}>{gateStatus==='pending'?t('Unicode 매핑 검증 중…','Verifying Unicode mapping…'):gateStatus==='passed'?t('Unicode 매핑 검증됨','Unicode mapping verified'):t('Unicode 매핑 검증','Verify Unicode mapping')}</button>}
   {referencePath&&<button onClick={onReturnToBuild}>{t('빌드 PDF로 돌아가기','Return to built PDF')}</button>}
  </div>}
  <div className="pdf-content">
  <div className={`pdf-document-view${logsOpen?' is-hidden':''}`} aria-hidden={logsOpen||undefined}>
  {results.length>0&&<div className="pdf-search-results" aria-label={t('PDF 검색 결과','PDF search results')}>{results.map(result=><button key={result.page} onClick={()=>jump(result.page)}>{t('페이지','Page')} {result.page} · {result.text}</button>)}</div>}
  {password&&<form className="pdf-password" onSubmit={event=>{event.preventDefault();const reply=passwordReply.current;passwordReply.current=null;reply?.(passwordValue);setPasswordValue('');setPassword(false);}}><label>{t('PDF 암호','PDF password')}<input type="password" autoComplete="off" value={passwordValue} onChange={event=>setPasswordValue(event.target.value)}/></label><button>{t('열기','Open')}</button><button type="button" onClick={()=>{cancelLoading.current?.();setPassword(false);setPasswordValue('');setLoading(false);setError(t('PDF 암호 입력을 취소했습니다','PDF password entry was cancelled'));}}>{t('취소','Cancel')}</button></form>}
  {error&&<div role="alert" className="pdf-error">{t('PDF를 표시할 수 없습니다. 연결 및 빌드 상태를 확인하세요.','The PDF could not be displayed. Check the connection and build status.')} <details><summary>{t('상세 정보','Details')}</summary>{error}</details><button onClick={()=>{void request('build_start',workspace,{rootTex:manifest?.rootTex,engine:manifest?.engine}).catch(fail);}}>{t('다시 빌드','Rebuild')}</button></div>}
  {loading&&<p role="status">{t('PDF 여는 중…','Opening PDF…')}</p>}
  {!pdf&&!loading&&!error&&<p className="pdf-empty">{t('TeX 문서를 빌드하거나 PDF 파일을 여세요.','Build a TeX document or open a PDF file.')}</p>}
  <div ref={container} className="pdf-scroll" onPointerUp={selected} onKeyUp={event=>{if(event.key==='Shift')selected();if(event.key==='Escape')window.getSelection()?.removeAllRanges();}} onScroll={()=>{const node=container.current;if(!node||!pdf)return;const page=Math.max(1,Math.min(pdf.numPages,Math.floor((node.scrollTop+Math.min(node.clientHeight,pageHeight)*0.4)/(pageHeight+24))+1));position.current={page,fraction:Math.max(0,(node.scrollTop-(page-1)*(pageHeight+24))/pageHeight)};setCurrent(page);}}>
   {pdf&&Array.from({length:pdf.numPages},(_,index)=>{const page=index+1;const mounted=retainedPages(current,pdf.numPages).includes(page);return <div key={page} className="pdf-page-slot" data-page={page} style={{width:pageWidth,height:pageHeight}}>{mounted&&<PdfPage document={pdf} number={page} scale={scale} rotation={rotation} visible={page===current} budget={budget.current} entries={pages.current} stoppers={stoppers.current} marks={marks.filter(mark=>mark.page===page).slice(0,30)} syncTarget={syncTarget?.page===page?syncTarget:null} onError={fail}/>}</div>;})}
  </div>
  </div>
  {logsOpen&&<div className="pdf-logs-view" role="region" aria-label={t('로그 및 출력','Logs and output')}>{logs}</div>}
  </div>
 </section>;
}
function PdfPage({document,number,scale,rotation,visible,budget,entries,stoppers,marks,syncTarget,onError}:{document:PDFDocumentProxy;number:number;scale:number;rotation:number;visible:boolean;budget:RenderBudget;entries:Map<number,PageEntry>;stoppers:Map<number,()=>Promise<void>>;marks:PdfMark[];syncTarget:SyncTarget|null;onError:(cause:unknown)=>void}){
 const {t}=useI18n();
 const canvas=useRef<HTMLCanvasElement>(null),layer=useRef<HTMLDivElement>(null),cleanup=useRef(Promise.resolve()),textCleanup=useRef(Promise.resolve());
 const [paint,setPaint]=useState<{page:PDFPageProxy;viewport:PageViewport;lifetime:PageLifecycle}|null>(null),[links,setLinks]=useState<{url:string;rect:number[]}[]>([]);
 const geometry=paint?{viewport:paint.viewport,view:paint.page.view,unit:paint.page.userUnit}:null;
 useEffect(()=>{
  const target=canvas.current,textNode=layer.current;
  setPaint(null);
  const lifetime=new PageLifecycle(()=>{budget.release(number);if(target){target.width=0;target.height=0;}textNode?.replaceChildren();});
  const stop=()=>{if(lifetime.isStopped)return lifetime.stop();entries.delete(number);cleanup.current=lifetime.stop();return cleanup.current;};
  stoppers.set(number,stop);
  const render=async()=>{await cleanup.current;if(lifetime.isStopped)return;try{
   const page=await document.getPage(number);if(!lifetime.adopt(page)||!target)return;
   const viewport=page.getViewport({scale,rotation:(page.rotate+rotation)%360});
   const ratio=boundedPixelRatio(viewport.width,viewport.height,window.devicePixelRatio||1);
   target.width=Math.max(1,Math.floor(viewport.width*ratio));target.height=Math.max(1,Math.floor(viewport.height*ratio));target.style.width=`${viewport.width}px`;target.style.height=`${viewport.height}px`;
   budget.retain(number,target);await lifetime.render(page.render({canvas:target,viewport,transform:ratio===1?undefined:[ratio,0,0,ratio,0,0]}));if(lifetime.isStopped)return;
   setPaint({page,viewport,lifetime});
  }catch(cause){if(!lifetime.isStopped)onError(cause);}};void render();
  return()=>{if(stoppers.get(number)===stop)stoppers.delete(number);void stop();};
 },[document,number,scale,rotation,budget,entries,stoppers,onError]);
 useEffect(()=>{
  const textNode=layer.current;
  setLinks([]);
  if(!visible||!paint||!textNode||paint.lifetime.isStopped)return;
  const {page,viewport,lifetime}=paint;let stopped=false,entry:PageEntry|undefined;
  const render=async()=>{await textCleanup.current;if(stopped||lifetime.isStopped)return;try{
   textNode.style.setProperty('--scale-factor',String(scale));textNode.style.setProperty('--user-unit',String(page.userUnit));textNode.style.setProperty('--total-scale-factor',String(scale*page.userUnit));textNode.style.setProperty('--scale-round-x','1px');textNode.style.setProperty('--scale-round-y','1px');
   const items:PdfTextItem[]=[];
   await lifetime.renderText(new TextLayer({textContentSource:selectionTextStream(page.streamTextContent(),items),container:textNode,viewport}));if(stopped||lifetime.isStopped)return;
   entry={layer:textNode,viewport,view:page.view,userUnit:page.userUnit,items};entries.set(number,entry);textNode.dataset.ready='true';
   const annotations=await page.getAnnotations({intent:'display'});if(stopped||lifetime.isStopped)return;const safe:{url:string;rect:number[]}[]=[];
   for(const annotation of annotations){if(typeof annotation.url==='string'&&Array.isArray(annotation.rect)&&annotation.rect.length===4&&annotation.rect.every((n:unknown)=>typeof n==='number'&&Number.isFinite(n))){try{const url=new URL(annotation.url);if(['http:','https:','mailto:'].includes(url.protocol))safe.push({url:url.href,rect:annotation.rect});}catch{}}if(safe.length===100)break;}setLinks(safe);
  }catch(cause){if(!stopped&&!lifetime.isStopped)onError(cause);}};void render();
  return()=>{stopped=true;delete textNode.dataset.ready;if(entries.get(number)===entry)entries.delete(number);textCleanup.current=lifetime.stopText().then(()=>{textNode.replaceChildren();});};
 },[paint,visible,scale,number,entries,onError]);
 const rectangle=(rect:number[])=>{if(!geometry)return {};const {view,unit,viewport}=geometry;return pdfRectToViewport([view[0]+rect[0]/unit,view[3]-(rect[1]+rect[3])/unit,view[0]+(rect[0]+rect[2])/unit,view[3]-rect[1]/unit],viewport);};
 return <div className="pdf-page">
  <canvas ref={canvas} aria-label={`${t('페이지','Page')} ${number}`}/><div ref={layer} className="textLayer" data-testid="pdf-text-layer"/>
  {geometry&&syncTarget&&<div className="pdf-sync-marker" style={rectangle([syncTarget.h,syncTarget.v-syncTarget.H,syncTarget.W,syncTarget.H])}/>}
  {geometry&&marks.map(mark=><button key={mark.threadId} className="pdf-comment-mark" style={rectangle(mark.rects[0]??[0,0,12,12])} aria-label={`${t('댓글 열기','Open comment')} · ${mark.status==='resolved'?t('해결됨','Resolved'):t('열림','Open')}`} onClick={()=>window.dispatchEvent(new CustomEvent('texypaper:comment-open',{detail:{threadId:mark.threadId}}))}><Icon name="comments" size={12}/></button>)}
  {geometry&&links.map((link,index)=><button key={index} className="pdf-link-action" style={pdfRectToViewport(link.rect,geometry.viewport)} title={link.url} aria-label={`${t('외부 링크 열기','Open external link')}: ${link.url}`} onClick={()=>{void invoke('open_external_url',{url:link.url}).catch(onError);}}><Icon name="external" size={12}/></button>)}
 </div>;
}
