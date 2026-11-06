import type { WorkspaceRef } from '../contracts';
import type { ChatReadingPosition } from '../features/ai/chatTypes';

export type EditorReadingPosition={anchor:number;head:number;top:number;inset:number;left:number};
export type PdfReadingPosition={identity:string;page:number;fraction:number;zoom:number;fit:boolean;rotation:number};
export type WorkspaceLayout={sourceFraction:number;explorer:boolean;search:boolean;inspector:boolean;tab:'ai'|'comments';explorerWidth:number;inspectorWidth:number};
export type WorkspaceReadingState={openPaths:string[];activePath?:string|null;view?:'source'|'pdf'|'split';referencePath?:string;trash?:{path:string;transactionId:string}[];editors?:{path:string;position:EditorReadingPosition}[];pdfs?:PdfReadingPosition[];layout?:WorkspaceLayout;chat?:ChatReadingPosition};
export const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,Number.isFinite(value)?value:min));
export function clampEditorPosition(position:EditorReadingPosition,length:number):EditorReadingPosition{return {anchor:Math.floor(clamp(position.anchor,0,length)),head:Math.floor(clamp(position.head,0,length)),top:Math.floor(clamp(position.top,0,length)),inset:clamp(position.inset,-100000,100000),left:clamp(position.left,0,10000000)};}
export function clampPdfPosition(position:PdfReadingPosition,pages:number):PdfReadingPosition{return {identity:position.identity,page:Math.floor(clamp(position.page,1,Math.max(1,pages))),fraction:clamp(position.fraction,0,1),zoom:clamp(position.zoom,0.5,3),fit:position.fit,rotation:[0,90,180,270].includes(position.rotation)?position.rotation:0};}
export function pdfReadingIdentity(buildId:string,sha256:string,referencePath?:string){return JSON.stringify([referencePath??'',buildId,sha256]);}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const boundedString=(value:unknown,max:number):value is string=>typeof value==='string'&&new TextEncoder().encode(value).length<=max;
export function readWorkspaceState(value:unknown):WorkspaceReadingState{
 const input=value&&typeof value==='object'?value as Record<string,unknown>:{};
 const state:WorkspaceReadingState={openPaths:Array.isArray(input.openPaths)?input.openPaths.filter((path):path is string=>boundedString(path,4096)).slice(0,256):[]};
 if(input.activePath===null||boundedString(input.activePath,4096))state.activePath=input.activePath;
 if(input.view==='source'||input.view==='pdf'||input.view==='split')state.view=input.view;
 if(boundedString(input.referencePath,4096))state.referencePath=input.referencePath;
 if(Array.isArray(input.trash))state.trash=input.trash.filter((row):row is {path:string;transactionId:string}=>!!row&&boundedString(row.path,4096)&&boundedString(row.transactionId,128)).slice(0,100);
 if(Array.isArray(input.editors))state.editors=input.editors.filter(row=>row&&boundedString(row.path,4096)&&row.position&&['anchor','head','top','inset','left'].every(key=>finite(row.position[key]))).slice(-64).map(row=>({path:row.path,position:clampEditorPosition(row.position,1000000000)}));
 if(Array.isArray(input.pdfs))state.pdfs=input.pdfs.filter(row=>row&&boundedString(row.identity,4608)&&['page','fraction','zoom','rotation'].every(key=>finite(row[key]))&&typeof row.fit==='boolean').slice(-16).map(row=>clampPdfPosition(row,1000000));
 const layout=input.layout as WorkspaceLayout|undefined;
 if(layout&&['sourceFraction','explorerWidth','inspectorWidth'].every(key=>finite(layout[key as keyof WorkspaceLayout]))&&['explorer','search','inspector'].every(key=>typeof layout[key as keyof WorkspaceLayout]==='boolean')&&(layout.tab==='ai'||layout.tab==='comments'))state.layout={sourceFraction:clamp(layout.sourceFraction,25,75),explorerWidth:clamp(layout.explorerWidth,180,340),inspectorWidth:clamp(layout.inspectorWidth,360,720),explorer:layout.explorer,search:layout.search,inspector:layout.inspector,tab:layout.tab};
 const chat=input.chat as ChatReadingPosition|undefined;
 if(chat&&(chat.provider==='codex'||chat.provider==='claude')&&boundedString(chat.historyPage,255)&&chat.historyPage.endsWith('.jsonl')&&!/[\\/:\x00-\x1f\x7f-\x9f]/.test(chat.historyPage)&&typeof chat.following==='boolean'&&finite(chat.scrollTop)&&chat.scrollTop>=0&&(!chat.anchor||(boundedString(chat.anchor.id,1024)&&chat.anchor.id.length>0&&finite(chat.anchor.inset))))state.chat={provider:chat.provider,historyPage:chat.historyPage,following:chat.following,scrollTop:Math.min(chat.scrollTop,1000000000),...(chat.anchor?{anchor:{id:chat.anchor.id,inset:clamp(chat.anchor.inset,-1000000000,1000000000)}}:{})};
 return state;
}
function boundedSnapshot(state:WorkspaceReadingState):WorkspaceReadingState{
 const snapshot=readWorkspaceState(state);
 // Position histories are LRU metadata, never source text. Keep the complete record below native's 64 KiB cap.
 const bytes=()=>new TextEncoder().encode(JSON.stringify(snapshot)).length;
 while(bytes()>64000){if(snapshot.editors?.length)snapshot.editors.shift();else if(snapshot.pdfs?.length)snapshot.pdfs.shift();else if(snapshot.trash?.length)snapshot.trash.pop();else if(snapshot.openPaths.length>1)snapshot.openPaths.pop();else break;}
 return snapshot;
}
/** One epoch owns one serialized write queue; scroll callbacks only mutate this small record. */
export class WorkspaceStateWriter{
 readonly state:WorkspaceReadingState;
 private timer:number|undefined;
 private revision=0;
 private written=0;
 private pending:Promise<void>|undefined;
 private disposed=false;
 constructor(readonly workspace:WorkspaceRef,initial:unknown,private write:(workspace:WorkspaceRef,state:WorkspaceReadingState)=>Promise<unknown>,private onError:(error:unknown)=>void){this.state=readWorkspaceState(initial);}
 update(patch:Partial<WorkspaceReadingState>){if(this.disposed)return;Object.assign(this.state,patch);this.changed();}
 editor(path:string,position:EditorReadingPosition){if(this.disposed)return;this.state.editors=[...(this.state.editors??[]).filter(row=>row.path!==path),{path,position}].slice(-64);this.changed();}
 pdf(position:PdfReadingPosition){if(this.disposed)return;this.state.pdfs=[...(this.state.pdfs??[]).filter(row=>row.identity!==position.identity),position].slice(-16);this.changed();}
 private changed(){this.revision++;if(!this.timer)this.timer=window.setTimeout(()=>{this.timer=undefined;void this.flush().catch(this.onError);},600);}
 async flush():Promise<void>{
  clearTimeout(this.timer);this.timer=undefined;
  if(this.pending){await this.pending;return this.flush();}
  if(this.disposed||this.written===this.revision)return;
  const revision=this.revision,snapshot=boundedSnapshot(this.state);
  const pending=this.write(this.workspace,snapshot).then(()=>{this.written=revision;});this.pending=pending;
  try{await pending;}finally{if(this.pending===pending)this.pending=undefined;}
  if(this.written!==this.revision)await this.flush();
 }
 dispose(){this.disposed=true;clearTimeout(this.timer);this.timer=undefined;}
}
