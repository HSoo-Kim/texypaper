import {useCallback,useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {GlobalWorkerOptions,getDocument,TextLayer,type PDFDataRangeTransport,type PDFDocumentProxy,type PDFDocumentLoadingTask,type PDFPageProxy,type PageViewport} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type {WorkspaceRef,BuildManifest} from '../contracts';
import {request} from '../api';
import {createArtifactTransport,type ArtifactMetadata} from './artifactTransport';
import {boundedPixelRatio,RenderBudget,retainedPages} from './renderBudget';
import {captureSelection,pdfRectToViewport,viewportRectToPoints,type PdfTextItem} from './selection';
import {PageLifecycle} from './pageLifecycle';
import {readPageSearchText,selectionTextStream} from './pageText';
import {DocumentWorker} from './documentLifecycle';
import {clampPdfPosition,pdfReadingIdentity,type PdfReadingPosition} from '../state/readingPosition';
import type {LivePdf} from './livePreview';
import {isCurrentPartial,partialPageNumber,partialPageSpan,type FreshPageSpan} from './partialPages';
import './pdf.css';
import {useI18n} from '../ui/i18n';
import {Icon} from '../ui/Icon';
import {invoke} from '@tauri-apps/api/core';
import {usePaneZoom} from '../ui/paneZoom';
GlobalWorkerOptions.workerSrc=workerUrl;
type Props={workspace:WorkspaceRef;manifest:BuildManifest|null;livePreview?:LivePdf|null;liveReady?:boolean;referencePath?:string;visible?:boolean;readingPositions?:PdfReadingPosition[];onReadingPositionChange?:(position:PdfReadingPosition)=>void;onViewportChange?:(page:number)=>void;buildControls?:ReactNode;logs?:ReactNode;logsOpen?:boolean;onSelection?:(selection:unknown)=>void;onError?:(error:unknown)=>void;onNavigate?:(location:{path:string;line1:number})=>void;onManifest?:(manifest:BuildManifest)=>void;onReturnToBuild?:()=>void};
type PageEntry={document:PDFDocumentProxy;layer:HTMLElement;viewport:PageViewport;view:number[];userUnit:number;items:PdfTextItem[]};
type PdfMark={threadId:string;page:number;rects:number[][];status:string};
type SyncTarget={page:number;h:number;v:number;W:number;H:number};
type PartialDocument={document:PDFDocumentProxy;id:string;scope:string;span:FreshPageSpan};
type PageStopper={document:PDFDocumentProxy;stop:()=>Promise<void>};
const zoomLevels=[0.5,0.75,1,1.25,1.5,2,3];
// The "show in PDF" marker is only a pointer to the spot; it fades out (see pdf.css) and is removed after this long.
const SYNC_MARKER_MS=3200;
function clearPdfSelection(root:HTMLElement|null){
 const selection=root?.ownerDocument.getSelection();
 // PDF replacement must not clear CodeMirror's document-global caret.
 if(root&&selection?.anchorNode&&selection.focusNode&&root.contains(selection.anchorNode)&&root.contains(selection.focusNode))selection.removeAllRanges();
}
export function PdfPreview({workspace,manifest,livePreview,liveReady=false,referencePath,visible=true,readingPositions,onReadingPositionChange,onViewportChange,buildControls,logs,logsOpen=false,onSelection,onError,onReturnToBuild}:Props){
 const {t}=useI18n();
 const live=livePreview&&!referencePath&&livePreview.rootTex===manifest?.rootTex?livePreview:null;
 const scope=`${workspace.id}:${workspace.epoch}:${manifest?.rootTex??''}:${manifest?.engine??''}:${referencePath??''}`;
 const retainedFull=useRef<{scope:string;live:LivePdf|null;partial:LivePdf|null}>({scope:'',live:null,partial:null});
 if(retainedFull.current.scope!==scope)retainedFull.current={scope,live:null,partial:null};
 // A native publication can arrive before the controller reconciles its inputs.
 // Keep only a previously authorized immutable frame, never an unseen old frame.
 const partialIntent=live?.partial&&(isCurrentPartial(live.partial,manifest?.buildId)||retainedFull.current.partial===live)?live:null;
 retainedFull.current.partial=partialIntent;
 // Resident full bytes can remain behind partials. A range-backed native base
 // must follow publication because the host prunes older artifact generations.
 if(!live?.partial)retainedFull.current.live=live;
 const fullLive=retainedFull.current.live;
 const artifactBuildId=referencePath?undefined:fullLive?`live:${fullLive.id}`:manifest?.buildId;
 const errorCallback=useRef(onError);errorCallback.current=onError;
 const [pdf,setPdf]=useState<PDFDocumentProxy|null>(null),[metadata,setMetadata]=useState<ArtifactMetadata|null>(null),[current,setCurrent]=useState(1),[zoom,setZoom]=useState(1),[fit,setFit]=useState(true),[rotation,setRotation]=useState(0),[size,setSize]=useState({width:612,height:792}),[width,setWidth]=useState(700),[error,setError]=useState(''),[loading,setLoading]=useState(false),[search,setSearch]=useState(''),[results,setResults]=useState<{page:number;text:string}[]>([]),[searching,setSearching]=useState(false),[password,setPassword]=useState(false),[passwordValue,setPasswordValue]=useState('');
 const [marks,setMarks]=useState<PdfMark[]>([]),[syncTarget,setSyncTarget]=useState<SyncTarget|null>(null);
 const [locationStatus,setLocationStatus]=useState(''),[localHit,setLocalHit]=useState<SyncTarget|null>(null);
 const hitTimer=useRef(0);
 const [renderedLiveId,setRenderedLiveId]=useState<string|null>(null);
 const [partialDocument,setPartialDocument]=useState<PartialDocument|null>(null);
 const partial=partialIntent&&partialDocument?.scope===scope?partialDocument:null;
 const displayedLiveId=partial?.id??(partialIntent?null:renderedLiveId);
 const provisional=!!partialIntent||!!renderedLiveId;
 const pageCount=Math.max(pdf?.numPages??0,partial?.span.lastPage??0);
 const [fallbackPair,setFallbackPair]=useState<{asciiBuildId:string;unicodeBuildId:string}|null>(null),[gateStatus,setGateStatus]=useState<'idle'|'pending'|'passed'|'failed'>('idle');
 const manifestHistory=useRef<{workspace:string;epoch:number;items:BuildManifest[]}>({workspace:workspace.id,epoch:workspace.epoch,items:[]});
 useEffect(()=>{const history=manifestHistory.current;if(history.workspace!==workspace.id||history.epoch!==workspace.epoch){history.workspace=workspace.id;history.epoch=workspace.epoch;history.items=[];setFallbackPair(null);setGateStatus('idle');}if(!manifest)return;history.items=[manifest,...history.items.filter(item=>item.rootTex!==manifest.rootTex)].slice(0,2);const ascii=history.items.find(item=>/^[\x00-\x7f]+$/.test(item.rootTex)),unicode=history.items.find(item=>/[^\x00-\x7f]/.test(item.rootTex));if(ascii&&unicode){setFallbackPair({asciiBuildId:ascii.buildId,unicodeBuildId:unicode.buildId});setGateStatus('idle');}},[workspace.id,workspace.epoch,manifest?.buildId]);
 const container=useRef<HTMLDivElement>(null),pages=useRef(new Map<number,PageEntry>()),budget=useRef(new RenderBudget()),cancelLoading=useRef<(()=>void)|null>(null),passwordReply=useRef<((password:string)=>void)|null>(null),searchAbort=useRef<AbortController|null>(null),position=useRef({page:1,fraction:0});
 const cancelPartial=useRef<(()=>void)|null>(null);
 const retainedPartial=useRef<{document:PDFDocumentProxy;scope:string;dispose:()=>void}|null>(null);
 const frame=useRef<HTMLElement>(null),workerOwner=useRef<DocumentWorker|null>(null),partialOwner=useRef<DocumentWorker|null>(null);
 const viewState=useRef({zoom,fit,rotation});viewState.current={zoom,fit,rotation};
 const rebuildPosition=useRef<{workspace:string;epoch:number;rootTex:string;position:PdfReadingPosition}|null>(null);
 const [paintedDocument,setPaintedDocument]=useState<PDFDocumentProxy|null>(null);
 const pagePainted=useCallback((document:PDFDocumentProxy)=>setPaintedDocument(document),[]);
 const reading=useRef({readingPositions,onReadingPositionChange});reading.current={readingPositions,onReadingPositionChange};
 const documentIdentity=useRef<string|null>(null),pendingNavigation=useRef<{buildId:string;page:number;target?:SyncTarget}|null>(null);
 const reportPosition=useCallback((position:PdfReadingPosition)=>{if(!position.identity.startsWith('live:'))reading.current.onReadingPositionChange?.(position);},[]);
 const stoppers=useRef(new Map<number,PageStopper>());
 const fail=useCallback((cause:unknown)=>{let message=String(cause);if(cause instanceof Error)message=cause.message;else if(cause&&typeof cause==='object'&&'message'in cause)message=String(cause.message);setError(message);errorCallback.current?.(cause);},[]);
 useEffect(()=>{const node=container.current;if(!node)return;const observer=new ResizeObserver(([entry])=>setWidth(Math.max(100,entry.contentRect.width-40)));observer.observe(node);return()=>observer.disconnect();},[]);
 useEffect(()=>{
  const owner=new DocumentWorker(),overlayOwner=new DocumentWorker();workerOwner.current=owner;partialOwner.current=overlayOwner;
  return()=>{
   // React runs this cleanup before the loading effects' cleanup on unmount.
   cancelLoading.current?.();
   cancelPartial.current?.();
   retainedPartial.current?.dispose();retainedPartial.current=null;
   void owner.close().catch(cause=>errorCallback.current?.(cause));
   void overlayOwner.close().catch(cause=>errorCallback.current?.(cause));
   if(workerOwner.current===owner)workerOwner.current=null;
   if(partialOwner.current===overlayOwner)partialOwner.current=null;
  };
 },[]);
 useEffect(()=>{
  let stopped=false,disposed=false,displayed=false;const controller=new AbortController();let task:PDFDocumentLoadingTask|null=null,transport:PDFDataRangeTransport|null=null,ownedDocument:PDFDocumentProxy|null=null;
  const owner=workerOwner.current!;
  const previous=rebuildPosition.current;
  const carried=!referencePath&&previous?.workspace===workspace.id&&previous.epoch===workspace.epoch&&previous.rootTex===manifest?.rootTex?previous.position:null;
  if(!carried)rebuildPosition.current=null;
  const dispose=()=>{
   if(disposed)return;disposed=true;stopped=true;controller.abort();transport?.abort();transport=null;
   if(displayed&&!referencePath&&manifest?.rootTex&&documentIdentity.current)rebuildPosition.current={workspace:workspace.id,epoch:workspace.epoch,rootTex:manifest.rootTex,position:{identity:documentIdentity.current,...position.current,...viewState.current}};
   passwordReply.current=null;searchAbort.current?.abort();searchAbort.current=null;
   for(const [page,entry] of pages.current)if(entry.document===ownedDocument)pages.current.delete(page);
   const loadingTask=task;task=null;
   if(cancelLoading.current===dispose)cancelLoading.current=null;
   const pending:Promise<void>[]=[];
   for(const [page,entry] of stoppers.current)if(entry.document===ownedDocument){pending.push(entry.stop());stoppers.current.delete(page);}
   void owner.dispose(async()=>{
    try{await Promise.all(pending);}finally{if(!retainedPartial.current)budget.current.clear();try{await loadingTask?.destroy();}finally{TextLayer.cleanup();}}
   }).catch(cause=>errorCallback.current?.(cause));
  };
  cancelLoading.current=dispose;
  const carryPartial=!!partialIntent&&retainedPartial.current?.scope===scope;
  documentIdentity.current=null;
  if(!carryPartial){position.current={page:1,fraction:0};setCurrent(1);setZoom(1);setFit(true);setRotation(0);setPdf(null);setPaintedDocument(null);pages.current.clear();}
  if(pendingNavigation.current&&(referencePath||pendingNavigation.current.buildId!==artifactBuildId))pendingNavigation.current=null;
  setLoading(true);setError('');setMetadata(null);setMarks([]);setSyncTarget(null);setLocalHit(null);setLocationStatus('');clearPdfSelection(frame.current);searchAbort.current?.abort();searchAbort.current=null;setResults([]);setSearching(false);passwordReply.current=null;setPassword(false);setPasswordValue('');
  setRenderedLiveId(null);
  const loading=async()=>{try{
   const prepare=async()=>{
    if(fullLive)return null;
    const data=await request<ArtifactMetadata>('artifact_metadata',workspace,referencePath?{path:referencePath}:{buildId:artifactBuildId});if(stopped)return null;if(!data.length)throw new Error('PDF_EMPTY');
    const scopedTransport=await createArtifactTransport(data,controller.signal);if(stopped){scopedTransport.abort();return null;}transport=scopedTransport;return data;
   };
   // Fetch immutable initial bytes while the previous document exits and the worker starts.
   const [data,worker]=await Promise.all([prepare(),owner.acquire()]);if(stopped||!data&&!fullLive)return;
   // Hardware canvases are composited directly; PDF.js's default software canvas is repainted as a new cached compositor image on every render.
   task=getDocument({worker,...(fullLive?{data:fullLive.bytes.slice()}:{range:transport!,rangeChunkSize:65536,disableAutoFetch:true,disableStream:true}),disableWorkerRendering:true,enableHWA:true,enableXfa:false,cMapUrl:'/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/pdfjs/standard_fonts/',wasmUrl:'/pdfjs/wasm/',useWorkerFetch:true});
   task.onPassword=(reply:(value:string)=>void)=>{if(stopped)return;passwordReply.current=reply;setPassword(true);};
   const document=await task.promise;if(stopped)return;ownedDocument=document;
   const identity=fullLive?`live:${fullLive.id}`:pdfReadingIdentity(data!.buildId,data!.sha256,referencePath),saved=reading.current.readingPositions?.find(value=>value.identity===identity);
   const source=saved??carried,restored=source?{...clampPdfPosition(source,document.numPages),identity}:{identity,page:1,fraction:0,zoom:1,fit:true,rotation:0};
   const explicit=pendingNavigation.current;
   if(data&&explicit?.buildId===data.buildId){restored.page=Math.max(1,Math.min(document.numPages,explicit.page));restored.fraction=0;setSyncTarget(explicit.target??null);pendingNavigation.current=null;}
   // Keep the visible proxy warm for PdfPage instead of cleaning it just before rendering.
   const first=await document.getPage(restored.page);if(stopped){first.cleanup();return;}const view=first.getViewport({scale:1});
   const latestNavigation=pendingNavigation.current;
   if(data&&latestNavigation?.buildId===data.buildId){restored.page=Math.max(1,Math.min(document.numPages,latestNavigation.page));restored.fraction=0;setSyncTarget(latestNavigation.target??null);pendingNavigation.current=null;}
   documentIdentity.current=identity;position.current={page:restored.page,fraction:restored.fraction};setZoom(restored.zoom);setFit(restored.fit);setRotation(restored.rotation);
   displayed=true;passwordReply.current=null;setPassword(false);setSize({width:view.width,height:view.height});setMetadata(data);setRenderedLiveId(fullLive?.id??null);setPdf(document);setCurrent(restored.page);setLoading(false);
  }catch(cause){if(!stopped){setLoading(false);setPdf(null);setPaintedDocument(null);setPassword(false);if(fullLive){console.warn('Rejected provisional PDF',cause);window.dispatchEvent(new Event('texypaper:live-preview-rejected'));}else fail(cause);dispose();}}};
  if(artifactBuildId!==undefined||referencePath)void loading();else setLoading(false);
  return()=>{dispose();clearPdfSelection(frame.current);window.dispatchEvent(new CustomEvent('texypaper:pdf-identity',{detail:{workspaceId:workspace.id,epoch:workspace.epoch,closed:true}}));window.dispatchEvent(new CustomEvent('texypaper:pdf-frame',{detail:{workspaceId:workspace.id,epoch:workspace.epoch,buildId:artifactBuildId,closed:true}}));};
 },[workspace.id,workspace.epoch,artifactBuildId,referencePath,fail]);
 useEffect(()=>{
  searchAbort.current?.abort();setResults([]);setSearching(false);setSyncTarget(null);setLocalHit(null);setMarks([]);
  if(!partialIntent||!pdf||retainedPartial.current?.scope!==scope){
   retainedPartial.current?.dispose();retainedPartial.current=null;setPartialDocument(null);
  }
  if(!live?.partial)return;
  if(!partialIntent){window.dispatchEvent(new Event('texypaper:live-preview-rejected'));return;}
  if(!pdf)return;
  if(retainedPartial.current?.scope===scope&&partialDocument?.id===partialIntent.id)return;
  const owner=partialOwner.current!;let stopped=false,task:PDFDocumentLoadingTask|null=null,document:PDFDocumentProxy|null=null;
  const dispose=()=>{
   if(stopped)return;stopped=true;searchAbort.current?.abort();
   if(cancelPartial.current===dispose)cancelPartial.current=null;
   const pending=Array.from(stoppers.current.values()).filter(entry=>entry.document===document).map(entry=>entry.stop()),loadingTask=task;
   void owner.dispose(async()=>{try{await Promise.all(pending);}finally{await loadingTask?.destroy();}}).catch(cause=>errorCallback.current?.(cause));
  };
  cancelPartial.current=dispose;
  const load=async()=>{try{
   const worker=await owner.acquire();if(stopped)return;
   task=getDocument({worker,data:partialIntent.bytes.slice(),disableWorkerRendering:true,enableHWA:true,enableXfa:false,cMapUrl:'/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/pdfjs/standard_fonts/',wasmUrl:'/pdfjs/wasm/',useWorkerFetch:true});
   document=await task.promise;if(stopped)return;
   const span=partialPageSpan(partialIntent.partial!,partialIntent.partial!.baseBuildId,document.numPages);
   if(!span)throw new Error('PDF_PARTIAL_RANGE_INVALID');
   const previous=retainedPartial.current;
   retainedPartial.current={document,scope,dispose};
   setPartialDocument({document,id:partialIntent.id,scope,span});
   previous?.dispose();
   clearPdfSelection(frame.current);
   window.dispatchEvent(new CustomEvent('texypaper:pdf-frame',{detail:{workspaceId:workspace.id,epoch:workspace.epoch,buildId:`live:${partialIntent.id}`}}));
  }catch(cause){if(!stopped){console.warn('Rejected partial PDF',cause);dispose();window.dispatchEvent(new Event('texypaper:live-preview-rejected'));}}};
  void load();
  // Keep the last painted partial while its successor loads; never flash the old full PDF.
  return()=>{if(retainedPartial.current?.document!==document)dispose();};
 },[scope,live?.id,partialIntent,pdf]);
 useEffect(()=>{
  // Returning from a partial to its retained canonical base must restore comment identity too.
  if(!pdf)return;
  window.dispatchEvent(new CustomEvent('texypaper:pdf-identity',{detail:metadata&&!provisional?{workspaceId:workspace.id,epoch:workspace.epoch,buildId:metadata.buildId,pdfSha256:metadata.sha256,referencePath,pageCount:pdf.numPages}:{workspaceId:workspace.id,epoch:workspace.epoch,closed:true}}));
  if(!partialIntent)window.dispatchEvent(new CustomEvent('texypaper:pdf-frame',{detail:{workspaceId:workspace.id,epoch:workspace.epoch,buildId:renderedLiveId?`live:${renderedLiveId}`:metadata?.buildId,referencePath}}));
 },[pdf,metadata,provisional,partialIntent,renderedLiveId,workspace.id,workspace.epoch,referencePath]);
 const viewportCallback=useRef(onViewportChange);viewportCallback.current=onViewportChange;
 const lastViewport=useRef<{scope:string;page:number}|null>(null);
 useEffect(()=>{
  if(!pdf||!visible||logsOpen)return;
  const previous=lastViewport.current;
  if(previous?.scope===scope&&previous.page===current)return;
  lastViewport.current={scope,page:current};viewportCallback.current?.(current);
 },[pdf,current,visible,logsOpen,scope]);
 useEffect(()=>{const listener=(event:Event)=>fail((event as CustomEvent).detail);window.addEventListener('texypaper:pdf-error',listener);return()=>window.removeEventListener('texypaper:pdf-error',listener);},[fail]);
 const scale=fit?width/(rotation%180?size.height:size.width):zoom;
 const pageWidth=(rotation%180?size.height:size.width)*scale,pageHeight=(rotation%180?size.width:size.height)*scale;
 const liveScale=useRef(scale);
 useLayoutEffect(()=>{liveScale.current=scale;},[scale]);
 const explicitZoom=(value:number)=>{const next=Math.max(0.5,Math.min(3,Math.round(value*100)/100));liveScale.current=next;setFit(false);setZoom(next);};
 usePaneZoom({root:frame,wheelRoot:container,enabled:visible&&!logsOpen&&!!pdf,onZoom:direction=>explicitZoom(liveScale.current*(direction===1?1.1:1/1.1))});
 useLayoutEffect(()=>{if(!pdf||!container.current||!visible||logsOpen)return;const node=container.current;node.scrollTop=(position.current.page-1)*(pageHeight+24)+position.current.fraction*pageHeight;},[pdf,pageHeight,logsOpen,visible]);
 useEffect(()=>{const identity=documentIdentity.current;if(!pdf||!identity||!visible||logsOpen)return;reportPosition({identity,...position.current,zoom,fit,rotation});},[pdf,zoom,fit,rotation,visible,logsOpen,reportPosition]);
 function jump(page:number){const next=Math.max(1,Math.min(pageCount||1,page));setCurrent(next);position.current={page:next,fraction:0};container.current?.scrollTo({top:(next-1)*(pageHeight+24)});const identity=documentIdentity.current;if(identity)reportPosition({identity,...position.current,zoom,fit,rotation});}
 useEffect(()=>{
  const forward=(event:Event)=>{if(referencePath||!(event instanceof CustomEvent))return;const value:unknown=event.detail;const displayed=displayedLiveId?`live:${displayedLiveId}`:partialIntent?undefined:metadata?.buildId;if(!value||typeof value!=='object'||!('records'in value)||!Array.isArray(value.records)||!('buildId'in value)||typeof value.buildId!=='string'||value.buildId!==displayed||'workspaceId'in value&&value.workspaceId!==workspace.id||'epoch'in value&&value.epoch!==workspace.epoch)return;for(const record of value.records){if(!record||typeof record!=='object')continue;if(typeof record.page==='number'&&Number.isInteger(record.page)&&record.page>0&&record.page<=pageCount&&typeof record.h==='number'&&typeof record.v==='number'&&typeof record.W==='number'&&typeof record.H==='number'&&[record.h,record.v,record.W,record.H].every(Number.isFinite)){if(partialIntent&&partialPageNumber(record.page,partial?.span??null)===null){setLocationStatus(t('이 페이지는 아직 새로 고쳐지지 않았습니다.','This page has not refreshed yet.'));continue;}const target={page:record.page,h:record.h,v:record.v,W:record.W,H:record.H};setLocalHit(null);setSyncTarget(target);jump(record.page);break;}}};
  const comments=(event:Event)=>{if(provisional||!(event instanceof CustomEvent))return;const value:unknown=event.detail;if(!value||typeof value!=='object'||!('pdfSha256'in value)||value.pdfSha256!==metadata?.sha256||!('marks'in value)||!Array.isArray(value.marks))return;const next:PdfMark[]=[];for(const mark of value.marks){if(mark&&typeof mark==='object'&&typeof mark.threadId==='string'&&typeof mark.page==='number'&&Array.isArray(mark.rects)&&typeof mark.status==='string'){const rects=mark.rects.filter((rect:unknown):rect is number[]=>Array.isArray(rect)&&rect.length===4&&rect.every(n=>typeof n==='number'&&Number.isFinite(n)));next.push({threadId:mark.threadId,page:mark.page,rects,status:mark.status});}if(next.length>=1000)break;}setMarks(next);};
  // Attachment chips in the AI panel jump to the quoted page of the displayed build only.
  const goto=(event:Event)=>{if(provisional||referencePath||!(event instanceof CustomEvent))return;const value:unknown=event.detail;if(!value||typeof value!=='object'||!('buildId'in value)||value.buildId!==metadata?.buildId||!('page'in value)||typeof value.page!=='number'||!Number.isFinite(value.page))return;jump(Math.round(value.page));};
  window.addEventListener('texypaper:sync-forward',forward);window.addEventListener('texypaper:comment-marks',comments);window.addEventListener('texypaper:pdf-goto',goto);
  return()=>{window.removeEventListener('texypaper:sync-forward',forward);window.removeEventListener('texypaper:comment-marks',comments);window.removeEventListener('texypaper:pdf-goto',goto);};
 },[metadata?.sha256,metadata?.buildId,displayedLiveId,partialIntent,partial,pageCount,provisional,workspace.id,workspace.epoch,referencePath,pdf,pageHeight,t]);
 async function find(){
  searchAbort.current?.abort();searchAbort.current=null;setSearching(false);setResults([]);
  if(!pdf||!search.trim()||partialIntent&&!partial)return;
  const controller=new AbortController();searchAbort.current=controller;setSearching(true);
  const query=search.normalize('NFC').toLocaleLowerCase(),found:{page:number;text:string}[]=[];
  try{
   const searchDocument=partial?.document??pdf,firstPage=partial?.span.firstPage??1,lastPage=partial?.span.lastPage??pdf.numPages;
   for(let number=firstPage;number<=lastPage&&!controller.signal.aborted;number++){
    const cached=pages.current.get(number);let text:string;
    if(cached?.document===searchDocument)text=cached.items.map(item=>item.str).join(' ');
    else{
     const page=await searchDocument.getPage(partial?number-firstPage+1:number);
     try{if(controller.signal.aborted)break;text=await readPageSearchText(page,controller.signal);}
     finally{if(stoppers.current.get(number)?.document!==searchDocument)page.cleanup();}
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
 function changeZoom(direction:1|-1){const currentScale=liveScale.current;explicitZoom(direction===1?(zoomLevels.find(value=>value>currentScale+0.001)??3):([...zoomLevels].reverse().find(value=>value<currentScale-0.001)??0.5));}
 const selected=()=>{const selection=window.getSelection();if(!selection||!metadata)return;if(provisional){if(!selection.isCollapsed&&selection.anchorNode&&frame.current?.contains(selection.anchorNode))setLocationStatus(t('빠른 미리보기에서는 댓글을 달 수 없습니다. 정식 빌드를 기다려 주세요.','Comments require a verified build, not a live preview.'));return;}try{const captured=captureSelection(selection,{buildId:metadata.buildId,pdfSha256:metadata.sha256},pages.current);if(captured)onSelection?.(captured);}catch(cause){fail(cause);}};
 const requestInverse=useCallback((page:number,x:number,y:number,options:{automatic:boolean;preview:boolean})=>{
  if(!pdf||!visible||logsOpen)return;
  if(partialIntent&&partialPageNumber(page,partial?.span??null)===null){setLocationStatus(t('이 페이지는 이전 빌드입니다. 새로 고쳐진 뒤 소스 위치를 찾을 수 있습니다.','This page is from the previous build. Source mapping is unavailable until it refreshes.'));return;}
  if(options.preview){
   const hit={page,h:x-4,v:y+4,W:8,H:8};setLocalHit(hit);window.clearTimeout(hitTimer.current);hitTimer.current=window.setTimeout(()=>setLocalHit(value=>value===hit?null:value),SYNC_MARKER_MS);
   setLocationStatus(referencePath?t('참조 PDF에는 소스 연결이 없습니다.','Reference PDFs have no source mapping.'):t('소스 위치 찾는 중…','Finding source location…'));
   return;
  }
  if(referencePath)return;
  const buildId=displayedLiveId?`live:${displayedLiveId}`:metadata?.buildId;
  if(!buildId){setLocationStatus(t('이 PDF의 소스 연결을 준비 중입니다.','Source mapping for this PDF is pending.'));return;}
  window.dispatchEvent(new CustomEvent('texypaper:sync-pdf-requested',{detail:{workspaceId:workspace.id,epoch:workspace.epoch,buildId,pdfSha256:provisional?undefined:metadata?.sha256,page,x,y,automatic:options.automatic}}));
 },[metadata,displayedLiveId,partialIntent,partial,provisional,pdf,referencePath,visible,logsOpen,workspace.id,workspace.epoch,t]);
 useEffect(()=>{
  const status=(event:Event)=>{const value=(event as CustomEvent).detail,buildId=displayedLiveId?`live:${displayedLiveId}`:partialIntent?undefined:metadata?.buildId;if(value?.workspaceId===workspace.id&&value.epoch===workspace.epoch&&value.buildId===buildId&&typeof value.message==='string')setLocationStatus(value.message);};
  const hit=(event:Event)=>{const value=(event as CustomEvent).detail;if(value?.workspaceId===workspace.id&&value.epoch===workspace.epoch){setLocationStatus('');setLocalHit(null);setSyncTarget(null);window.clearTimeout(hitTimer.current);}};
  window.addEventListener('texypaper:sync-status',status);window.addEventListener('texypaper:sync-location-hit',hit);return()=>{window.removeEventListener('texypaper:sync-status',status);window.removeEventListener('texypaper:sync-location-hit',hit);};
 },[workspace.id,workspace.epoch,metadata?.buildId,displayedLiveId,partialIntent]);
 useEffect(()=>{if(!locationStatus)return;const timer=window.setTimeout(()=>setLocationStatus(value=>value===locationStatus?'':value),6500);return()=>window.clearTimeout(timer);},[locationStatus]);
 const syncTimer=useRef(0);
 useEffect(()=>()=>{window.clearTimeout(syncTimer.current);window.clearTimeout(hitTimer.current);},[]);
 const revealedSyncTarget=useRef<SyncTarget|null>(null);
 const revealSyncTarget=useCallback((target:SyncTarget,marker:HTMLDivElement|null)=>{
  const node=container.current,identity=documentIdentity.current;
  if(!node||!marker||!pdf||!identity||!visible||logsOpen||target!==syncTarget||revealedSyncTarget.current===target||!node.getClientRects().length)return;
  const bounds=node.getBoundingClientRect(),rect=marker.getBoundingClientRect();
  const top=Math.max(0,Math.min(node.scrollHeight-node.clientHeight,node.scrollTop+rect.top-bounds.top+rect.height/2-node.clientHeight/2));
  const left=Math.max(0,Math.min(node.scrollWidth-node.clientWidth,node.scrollLeft+rect.left-bounds.left+rect.width/2-node.clientWidth/2));
  revealedSyncTarget.current=target;window.clearTimeout(syncTimer.current);syncTimer.current=window.setTimeout(()=>setSyncTarget(value=>value===target?null:value),SYNC_MARKER_MS);node.scrollTop=top;node.scrollLeft=left;
  const page=Math.max(1,Math.min(pageCount,Math.floor(node.scrollTop/(pageHeight+24))+1));
  position.current={page,fraction:Math.max(0,Math.min(1,(node.scrollTop-(page-1)*(pageHeight+24))/pageHeight))};
  reportPosition({identity,...position.current,zoom,fit,rotation});
 },[pdf,pageCount,visible,logsOpen,syncTarget,pageHeight,zoom,fit,rotation,reportPosition]);
 return <section ref={frame} className="pdf-preview" onPointerDownCapture={event=>{if(event.button===0&&event.target instanceof Element&&event.target.closest('.pdf-page'))window.dispatchEvent(new CustomEvent('texypaper:sync-location-hit',{detail:{workspaceId:workspace.id,epoch:workspace.epoch}}));}} aria-label={t('PDF 미리보기','PDF preview')} data-build-id={pdf?(displayedLiveId?`live:${displayedLiveId}`:metadata?.buildId??''):''} data-live-preview={provisional?'true':'false'} data-preview-kind={partial?'partial':partialIntent?'partial-pending':renderedLiveId?'live':'full'} data-preview-first={partial?.span.firstPage} data-preview-last={partial?.span.lastPage} data-live-ready={liveReady?'true':'false'} data-reference={referencePath?'true':'false'} data-scale={scale}>
  <div className="pdf-toolbar" role="toolbar" aria-label={t('PDF 도구','PDF tools')}>
   <div className="pdf-build-actions">
    {buildControls}
    <button className="pdf-export" disabled={!metadata||provisional} onClick={()=>{if(!provisional)void request('export_pdf',workspace,{buildId:metadata?.buildId}).catch(fail);}} aria-label={t('PDF 내보내기','Export PDF')} title={provisional?t('빠른 미리보기 · 내보내기와 댓글은 정식 빌드 완료 후 사용할 수 있습니다.','Live preview · export and comments require a verified build.'):t('PDF 내보내기','Export PDF')}><Icon name="download"/><span>{provisional?t('빠른 미리보기','Live preview'):t('PDF 내보내기','Export PDF')}</span></button>
   </div>
   <div className="pdf-navigation" role="group" aria-label={t('페이지 탐색','Page navigation')}>
    <button className="icon-button" disabled={!pdf||current===1} onClick={()=>jump(current-1)} aria-label={t('이전 페이지','Previous page')} title={t('이전 페이지','Previous page')}><Icon name="chevronLeft"/></button>
    <label><span className="pdf-sr-only">{t('페이지','Page')}</span><input aria-label={t('PDF 페이지','PDF page')} type="number" min={1} max={pageCount||1} value={current} onChange={event=>jump(Number(event.target.value)||1)}/></label><span className="pdf-page-count">/ {pageCount}</span>
    <button className="icon-button" disabled={!pdf||current===(pageCount||1)} onClick={()=>jump(current+1)} aria-label={t('다음 페이지','Next page')} title={t('다음 페이지','Next page')}><Icon name="chevronRight"/></button>
   </div>
   <div className="pdf-zoom" role="group" aria-label={t('확대','Zoom')}>
    <button className="icon-button" disabled={!pdf||scale<=0.5} onClick={()=>changeZoom(-1)} aria-label={t('축소','Zoom out')} title={t('축소','Zoom out')}><Icon name="zoomOut"/></button>
    <label><span className="pdf-sr-only">{t('확대','Zoom')}</span><select aria-label={t('PDF 확대','PDF zoom')} value={fit?'fit':String(zoom)} onChange={event=>{if(event.target.value==='fit')setFit(true);else explicitZoom(Number(event.target.value));}}><option value="fit">{t('자동','Auto')}</option>{!zoomLevels.includes(zoom)&&<option value={zoom}>{Math.round(zoom*100)}%</option>}{zoomLevels.map(value=><option key={value} value={value}>{value*100}%</option>)}</select></label>
    <button className="icon-button" disabled={!pdf||scale>=3} onClick={()=>changeZoom(1)} aria-label={t('확대','Zoom in')} title={t('확대','Zoom in')}><Icon name="zoomIn"/></button>
   </div>
  </div>
  <div className="pdf-secondary-toolbar">
   <div className="pdf-view-options" role="group" aria-label={t('PDF 보기 설정','PDF view options')}>
    <button onClick={()=>setFit(true)} aria-pressed={fit}>{t('너비 맞춤','Fit width')}</button>
    <button onClick={()=>explicitZoom(1)}>{t('실제 크기','Actual size')}</button>
    <button onClick={()=>{clearPdfSelection(frame.current);setRotation(value=>(value+90)%360);}} aria-label={t('PDF 90도 회전','Rotate PDF 90 degrees')} title={t('PDF 90도 회전','Rotate PDF 90 degrees')}><Icon name="refresh" size={14}/><span>{rotation}°</span></button>
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
  {partialIntent&&<div className="pdf-partial-status" role="status">{partial?t(`현재 ${partial.span.firstPage}–${partial.span.lastPage}쪽만 새로 고쳤습니다. 다른 쪽은 이전 빌드이며 검색·소스 연결에서 제외됩니다.`,`Pages ${partial.span.firstPage}–${partial.span.lastPage} are refreshed. Other pages are from the previous build and excluded from search and source mapping.`):t('현재 페이지를 새로 고치는 중입니다. 이전 빌드가 표시됩니다.','Refreshing the current page. Showing the previous build.')}</div>}
  {locationStatus&&<div className="pdf-location-status" role="status" aria-live="polite">{locationStatus}</div>}
  {password&&<form className="pdf-password" onSubmit={event=>{event.preventDefault();const reply=passwordReply.current;passwordReply.current=null;reply?.(passwordValue);setPasswordValue('');setPassword(false);}}><label>{t('PDF 암호','PDF password')}<input type="password" autoComplete="off" value={passwordValue} onChange={event=>setPasswordValue(event.target.value)}/></label><button>{t('열기','Open')}</button><button type="button" onClick={()=>{cancelLoading.current?.();setPassword(false);setPasswordValue('');setLoading(false);setError(t('PDF 암호 입력을 취소했습니다','PDF password entry was cancelled'));}}>{t('취소','Cancel')}</button></form>}
  {error&&<div role="alert" className="pdf-error">{t('PDF를 표시할 수 없습니다. 연결 및 빌드 상태를 확인하세요.','The PDF could not be displayed. Check the connection and build status.')} <details><summary>{t('상세 정보','Details')}</summary>{error}</details><button onClick={()=>{void request('build_start',workspace,{rootTex:manifest?.rootTex,engine:manifest?.engine}).catch(fail);}}>{t('다시 빌드','Rebuild')}</button></div>}
  {loading&&<p role="status">{t('PDF 여는 중…','Opening PDF…')}</p>}
  {!pdf&&!loading&&!error&&<p className="pdf-empty">{t('TeX 문서를 빌드하거나 PDF 파일을 여세요.','Build a TeX document or open a PDF file.')}</p>}
  <div ref={container} className="pdf-scroll" tabIndex={0} aria-label={t('PDF 문서 · Ctrl+휠 또는 Ctrl+더하기/빼기로 확대','PDF document · Ctrl+wheel or Ctrl+plus/minus to zoom')} onPointerUp={event=>{if(event.ctrlKey||event.metaKey){if(event.target instanceof Element&&!event.target.closest('button,a,input,select,textarea')){event.preventDefault();event.stopPropagation();}return;}selected();}} onKeyUp={event=>{if(event.key==='Shift')selected();if(event.key==='Escape')clearPdfSelection(frame.current);}} onScroll={()=>{const node=container.current,identity=documentIdentity.current;if(!node||!pdf||!identity||!visible||logsOpen||!node.getClientRects().length)return;const page=Math.max(1,Math.min(pageCount,Math.floor(node.scrollTop/(pageHeight+24))+1));position.current={page,fraction:Math.max(0,Math.min(1,(node.scrollTop-(page-1)*(pageHeight+24))/pageHeight))};const visiblePage=Math.max(1,Math.min(pageCount,Math.floor((node.scrollTop+Math.min(node.clientHeight,pageHeight)*0.4)/(pageHeight+24))+1));setCurrent(visiblePage);reportPosition({identity,...position.current,zoom,fit,rotation});}}>
   {pdf&&Array.from({length:pageCount},(_,index)=>{const page=index+1,localPage=partialPageNumber(page,partial?.span??null),document=localPage!==null?partial!.document:pdf,stale=!!partialIntent&&localPage===null;const mounted=(!loading||localPage!==null)&&(page===current||(paintedDocument===pdf||paintedDocument===partial?.document)&&retainedPages(current,pageCount).includes(page));return <div key={page} className={`pdf-page-slot${stale?' is-stale':''}`} data-page={page} data-page-fresh={stale?'false':'true'} style={{width:pageWidth,height:pageHeight}}>{mounted&&(localPage!==null||page<=pdf.numPages)&&<PdfPage document={document} number={page} pdfNumber={localPage??page} stale={stale} scale={scale} rotation={rotation} visible={page===current} budget={budget.current} entries={pages.current} stoppers={stoppers.current} marks={provisional?[]:marks.filter(mark=>mark.page===page).slice(0,30)} syncTarget={!stale&&syncTarget?.page===page?syncTarget:null} localHit={!stale&&localHit?.page===page?localHit:null} onSyncPoint={requestInverse} onRevealSyncTarget={revealSyncTarget} onPainted={pagePainted} onError={fail}/>}<span className={`pdf-page-state${stale?' is-stale':''}`}>{stale?t(`${page}쪽 · 이전 빌드`,`${page} · Previous build`):partial?t(`${page}쪽 · 새로 고침`,`${page} · Refreshed`):''}</span></div>;})}
  </div>
  </div>
  {logsOpen&&<div className="pdf-logs-view" role="region" aria-label={t('로그 및 출력','Logs and output')}>{logs}</div>}
  </div>
 </section>;
}
function PdfPage({document,number,pdfNumber,stale,scale,rotation,visible,budget,entries,stoppers,marks,syncTarget,localHit,onSyncPoint,onRevealSyncTarget,onPainted,onError}:{document:PDFDocumentProxy;number:number;pdfNumber:number;stale:boolean;scale:number;rotation:number;visible:boolean;budget:RenderBudget;entries:Map<number,PageEntry>;stoppers:Map<number,PageStopper>;marks:PdfMark[];syncTarget:SyncTarget|null;localHit:SyncTarget|null;onSyncPoint:(page:number,x:number,y:number,options:{automatic:boolean;preview:boolean})=>void;onRevealSyncTarget:(target:SyncTarget,marker:HTMLDivElement|null)=>void;onPainted:(document:PDFDocumentProxy)=>void;onError:(cause:unknown)=>void}){
 const {t}=useI18n();
 const canvas=useRef<HTMLCanvasElement>(null),layer=useRef<HTMLDivElement>(null),cleanup=useRef(Promise.resolve()),textCleanup=useRef(Promise.resolve());
 const [paint,setPaint]=useState<{document:PDFDocumentProxy;page:PDFPageProxy;viewport:PageViewport;lifetime:PageLifecycle}|null>(null),[links,setLinks]=useState<{url:string;rect:number[]}[]>([]);
 const geometry=paint?.document===document&&!paint.lifetime.isStopped?{viewport:paint.viewport,view:paint.page.view,unit:paint.page.userUnit}:null;
 const pressed=useRef<{x:number;y:number}|null>(null),clickTimer=useRef(0);
 useEffect(()=>{const cancel=()=>window.clearTimeout(clickTimer.current);window.addEventListener('texypaper:sync-location-hit',cancel);return()=>{cancel();window.removeEventListener('texypaper:sync-location-hit',cancel);};},[document,scale,rotation]);
 useEffect(()=>{
  const target=canvas.current,textNode=layer.current;
  setPaint(null);
  const lifetime=new PageLifecycle(()=>{budget.release(number);if(target){target.width=0;target.height=0;}textNode?.replaceChildren();});
  const stop=()=>{if(lifetime.isStopped)return lifetime.stop();entries.delete(number);cleanup.current=lifetime.stop();return cleanup.current;};
  const stopper={document,stop};stoppers.set(number,stopper);
  const render=async()=>{await cleanup.current;if(lifetime.isStopped)return;try{
   const page=await document.getPage(pdfNumber);if(!lifetime.adopt(page)||!target)return;
   const viewport=page.getViewport({scale,rotation:(page.rotate+rotation)%360});
   const ratio=boundedPixelRatio(viewport.width,viewport.height,window.devicePixelRatio||1);
   target.width=Math.max(1,Math.floor(viewport.width*ratio));target.height=Math.max(1,Math.floor(viewport.height*ratio));target.style.width=`${viewport.width}px`;target.style.height=`${viewport.height}px`;
   budget.retain(number,target);await lifetime.render(page.render({canvas:target,viewport,transform:ratio===1?undefined:[ratio,0,0,ratio,0,0]}));if(lifetime.isStopped)return;
   setPaint({document,page,viewport,lifetime});onPainted(document);
  }catch(cause){if(!lifetime.isStopped)onError(cause);}};void render();
  return()=>{if(stoppers.get(number)===stopper)stoppers.delete(number);void stop();};
 },[document,number,pdfNumber,scale,rotation,budget,entries,stoppers,onPainted,onError]);
 useEffect(()=>{
  const textNode=layer.current;
  setLinks([]);
  if(!visible||!paint||paint.document!==document||!textNode||paint.lifetime.isStopped)return;
  const {page,viewport,lifetime}=paint;let stopped=false,entry:PageEntry|undefined;
  const render=async()=>{await textCleanup.current;if(stopped||lifetime.isStopped)return;try{
   textNode.style.setProperty('--scale-factor',String(scale));textNode.style.setProperty('--user-unit',String(page.userUnit));textNode.style.setProperty('--total-scale-factor',String(scale*page.userUnit));textNode.style.setProperty('--scale-round-x','1px');textNode.style.setProperty('--scale-round-y','1px');
   const items:PdfTextItem[]=[];
   await lifetime.renderText(new TextLayer({textContentSource:selectionTextStream(page.streamTextContent(),items),container:textNode,viewport}));if(stopped||lifetime.isStopped)return;
   entry={document,layer:textNode,viewport,view:page.view,userUnit:page.userUnit,items};entries.set(number,entry);textNode.dataset.ready='true';
   const annotations=await page.getAnnotations({intent:'display'});if(stopped||lifetime.isStopped)return;const safe:{url:string;rect:number[]}[]=[];
   for(const annotation of annotations){if(typeof annotation.url==='string'&&Array.isArray(annotation.rect)&&annotation.rect.length===4&&annotation.rect.every((n:unknown)=>typeof n==='number'&&Number.isFinite(n))){try{const url=new URL(annotation.url);if(['http:','https:','mailto:'].includes(url.protocol))safe.push({url:url.href,rect:annotation.rect});}catch{}}if(safe.length===100)break;}setLinks(safe);
  }catch(cause){if(!stopped&&!lifetime.isStopped)onError(cause);}};void render();
  return()=>{stopped=true;delete textNode.dataset.ready;if(entries.get(number)===entry)entries.delete(number);textCleanup.current=lifetime.stopText().then(()=>{textNode.replaceChildren();});};
 },[document,paint,visible,scale,number,entries,onError]);
 const rectangle=(rect:number[])=>{if(!geometry)return {};const {view,unit,viewport}=geometry;return pdfRectToViewport([view[0]+rect[0]/unit,view[3]-(rect[1]+rect[3])/unit,view[0]+(rect[0]+rect[2])/unit,view[3]-rect[1]/unit],viewport);};
 return <div className="pdf-page" data-page={number} data-preview-stale={stale?'true':'false'} onPointerDown={event=>{window.clearTimeout(clickTimer.current);pressed.current=event.button===0?{x:event.clientX,y:event.clientY}:null;}} onPointerCancel={()=>{pressed.current=null;window.clearTimeout(clickTimer.current);}} onClick={event=>{
  window.clearTimeout(clickTimer.current);const start=pressed.current;pressed.current=null;
  const explicit=event.ctrlKey||event.metaKey;
  if(!start||event.detail!==1||event.altKey||event.shiftKey||event.button!==0||!geometry||paint?.lifetime.isStopped||!(event.target instanceof Element)||event.target.closest('button,a,input,select,textarea')||Math.hypot(event.clientX-start.x,event.clientY-start.y)>4||!explicit&&window.getSelection()?.isCollapsed===false)return;
  const bounds=event.currentTarget.getBoundingClientRect();if(!bounds.width||!bounds.height)return;
  const left=(event.clientX-bounds.left)*geometry.viewport.width/bounds.width,top=(event.clientY-bounds.top)*geometry.viewport.height/bounds.height;
  try{
   const [x,y]=viewportRectToPoints({left,top,right:left,bottom:top},geometry.viewport,geometry.view,geometry.unit);
   onSyncPoint(number,x,y,{automatic:!explicit,preview:true});
   (event.currentTarget.closest('.pdf-scroll') as HTMLElement|null)?.focus({preventScroll:true});
   if(explicit){event.preventDefault();event.stopPropagation();onSyncPoint(number,x,y,{automatic:false,preview:false});}
   else clickTimer.current=window.setTimeout(()=>{if(!paint?.lifetime.isStopped&&window.getSelection()?.isCollapsed!==false)onSyncPoint(number,x,y,{automatic:true,preview:false});},240);
  }catch(cause){onError(cause);}
 }}>
  <canvas ref={canvas} aria-label={`${t('페이지','Page')} ${number}`}/><div ref={layer} className="textLayer" data-testid="pdf-text-layer"/>
  {geometry&&syncTarget&&paint?.viewport.scale===scale&&paint.viewport.rotation===(paint.page.rotate+rotation)%360&&!paint.lifetime.isStopped&&<div className="pdf-sync-marker" ref={node=>onRevealSyncTarget(syncTarget,node)} style={rectangle([syncTarget.h,syncTarget.v-syncTarget.H,syncTarget.W,syncTarget.H])}/>}
  {geometry&&localHit&&paint?.viewport.scale===scale&&paint.viewport.rotation===(paint.page.rotate+rotation)%360&&!paint.lifetime.isStopped&&<div className="pdf-hit-marker" style={rectangle([localHit.h,localHit.v-localHit.H,localHit.W,localHit.H])}/>}
  {geometry&&marks.map(mark=><button key={mark.threadId} className="pdf-comment-mark" style={rectangle(mark.rects[0]??[0,0,12,12])} aria-label={`${t('댓글 열기','Open comment')} · ${mark.status==='resolved'?t('해결됨','Resolved'):t('열림','Open')}`} onClick={()=>window.dispatchEvent(new CustomEvent('texypaper:comment-open',{detail:{threadId:mark.threadId}}))}><Icon name="comments" size={12}/></button>)}
  {geometry&&links.map((link,index)=><button key={index} className="pdf-link-action" style={pdfRectToViewport(link.rect,geometry.viewport)} title={link.url} aria-label={`${t('외부 링크 열기','Open external link')}: ${link.url}`} onClick={()=>{void invoke('open_external_url',{url:link.url}).catch(onError);}}><Icon name="external" size={12}/></button>)}
 </div>;
}
