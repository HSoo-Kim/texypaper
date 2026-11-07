import type { AppError, Entry, TextDocument, WorkspaceRef } from '../../contracts';
import { normalizeError } from '../../api';
import { t } from '../../ui/i18n';

export type CheckpointFile={path:string;sha256:string;text:string;encoding?:'utf8'|'utf8Bom'};
export type Checkpoint={id:string;name:string;createdAt:string;files:CheckpointFile[]};
export type CheckpointSummary=Omit<Checkpoint,'files'>&{fileCount:number;byteLength:number;corrupt?:boolean};
export type Snapshot={files:CheckpointFile[];skipped:{path:string;reason:string}[];revisions:Record<string,string>;present:string[]};
export type CheckpointRequest=<T>(command:string,workspace:WorkspaceRef,args?:unknown)=>Promise<T>;
type Context={workspace:WorkspaceRef;request:CheckpointRequest;entries:Entry[]};
export const MAX_FILES=400,MAX_BYTES=8*1024*1024,MAX_FILE_BYTES=1024*1024;
const extensions:Record<string,true>=Object.fromEntries('tex ltx bib bst cls sty bbx cbx dtx ins md txt csv tsv json yaml yml toml py r m jl sh'.split(' ').map(extension=>[extension,true]));
const excluded:Record<string,true>={node_modules:true,venv:true,__pycache__:true,build:true,dist:true,target:true};
export function allowedPath(path:string):boolean{return !!path&&!/[\\:\x00-\x1f]/.test(path)&&path.split('/').every(part=>!!part&&!part.startsWith('.')&&!Object.hasOwn(excluded,part));}
export function snapshotEntry(entry:Entry):boolean{return entry.kind==='file'&&allowedPath(entry.path)&&Object.hasOwn(extensions,entry.path.split('.').at(-1)!.toLowerCase());}
function fail(code:string,message:string):never{throw {code,message,retryable:false} satisfies AppError;}
async function sha256(text:string){const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');}
/** Re-list real directories, rather than relying on the explorer's partially expanded index. */
export async function discoverEntries({workspace,request}:Omit<Context,'entries'>):Promise<Entry[]>{
 const entries:Entry[]=[],queue=[''],visited=new Set<string>();
 while(queue.length){
  const path=queue.shift()!;if(visited.has(path))continue;visited.add(path);let cursor:string|undefined,offset:number|undefined;
  do{
   const result=await request<{entries:Entry[];nextCursor?:string|null;nextOffset?:number|null}>('directory_list',workspace,{path,showHidden:false,cursor,offset});
   for(const entry of result.entries){if(!allowedPath(entry.path))continue;entries.push(entry);if(entries.length>50000)fail('CHECKPOINT_LIMIT',t('프로젝트 항목이 너무 많아 전체 체크포인트를 만들 수 없습니다.','Too many project entries to collect a complete checkpoint.'));if(entry.kind==='directory')queue.push(entry.path);}
   cursor=result.nextCursor??undefined;offset=result.nextOffset??undefined;
  }while(cursor!==undefined||offset!==undefined);
 }
 return entries;
}
export async function collectSnapshot({workspace,request,entries}:Context):Promise<Snapshot>{
 const result:Snapshot={files:[],skipped:[],revisions:{},present:entries.filter(snapshotEntry).map(entry=>entry.path)};let total=0;
 for(const entry of [...new Map(entries.filter(snapshotEntry).map(entry=>[entry.path,entry])).values()].sort((a,b)=>a.path.localeCompare(b.path))){
  let document:TextDocument;
  try{document=await request<TextDocument>('file_read',workspace,{path:entry.path});}catch(error){result.skipped.push({path:entry.path,reason:normalizeError(error).message});continue;}
  const bytes=new TextEncoder().encode(document.text).length;
  const reason=document.readOnly?t('읽기 전용 파일','Read-only file'):document.truncated?t('내용이 잘린 파일','Truncated file'):!['utf8','utf8Bom'].includes(document.encoding)?t('UTF-8이 아닌 파일','Non-UTF-8 file'):bytes>MAX_FILE_BYTES?t('1 MiB 초과','Over 1 MiB'):null;
  if(reason){result.skipped.push({path:entry.path,reason});continue;}
  if(result.files.length===MAX_FILES||total+bytes>MAX_BYTES)fail('CHECKPOINT_LIMIT',t('체크포인트는 최대 400개 파일, 총 8 MiB까지 저장할 수 있습니다.','A checkpoint can contain at most 400 files and 8 MiB of text.'));
  total+=bytes;result.files.push({path:entry.path,text:document.text,sha256:await sha256(document.text),encoding:document.encoding as 'utf8'|'utf8Bom'});result.revisions[entry.path]=document.revision.sha256;
 }
 return result;
}
export async function createCheckpoint(context:Context&{name:string;snapshot?:Snapshot}){
 const snapshot=context.snapshot??await collectSnapshot(context);
 const checkpoint:Checkpoint={id:crypto.randomUUID(),name:context.name,createdAt:new Date().toISOString(),files:snapshot.files};
 const result=await context.request<{saved:boolean;id:string;pruned:string[]}>('checkpoint_put',context.workspace,checkpoint);
 if(!result.saved)fail('CHECKPOINT_FAILED',t('체크포인트 저장을 확인하지 못했습니다.','Checkpoint storage was not confirmed.'));
 return {checkpoint,skipped:snapshot.skipped,pruned:result.pruned};
}
const displayText=(text:string)=>text.replace(/\r\n/g,'\n');
export function compareWithCurrent(checkpoint:Pick<Checkpoint,'files'>,current:Pick<Snapshot,'files'>&{present?:string[]}){
 const now=new Map(current.files.map(file=>[file.path,file])),before=new Map(checkpoint.files.map(file=>[file.path,file])),present=new Set(current.present??now.keys());
 const changed:{path:string;before:string;after:string}[]=[],removed:{path:string;text:string}[]=[];let same=0;
 for(const file of checkpoint.files){const next=now.get(file.path);if(!next){if(!present.has(file.path))removed.push({path:file.path,text:file.text});}else if(displayText(file.text)===displayText(next.text))same++;else changed.push({path:file.path,before:file.text,after:next.text});}
 return {changed,added:current.files.filter(file=>!before.has(file.path)).map(file=>file.path),removed,same};
}
export function buildRestorePlan(checkpoint:Checkpoint,current:Snapshot,paths:string[]){
 const selected=[...new Set(paths)];if(!selected.length)fail('CHECKPOINT_SELECTION',t('복원할 파일을 선택하세요.','Select files to restore.'));
 if(selected.length>16)fail('CHECKPOINT_LIMIT',t('한 번에 최대 16개 파일을 복원할 수 있습니다. 파일을 개별 선택해 복원하세요.','Restore at most 16 files at once. Select individual files to restore.'));
 return selected.map(path=>{const file=checkpoint.files.find(file=>file.path===path);if(!file||!snapshotEntry({path,kind:'file'} as Entry))fail('CHECKPOINT_PATH',t('복원할 수 없는 체크포인트 경로입니다.','This checkpoint path cannot be restored.'));const exists=current.present.includes(path),base=current.revisions[path];if(exists&&!base)fail('CHECKPOINT_UNREADABLE',`${path}: ${t('읽기 전용이거나 읽지 못한 파일은 복원할 수 없습니다.','Cannot restore a read-only or unreadable file.')}`);return {action:exists?'edit':'create',path,baseSha256:base??null,content:!exists&&file.encoding==='utf8Bom'?'\uFEFF'+file.text:file.text};});
}
export async function restoreFiles(context:Context&{checkpoint:Checkpoint;paths:string[]}){
 // Reject oversized selections before any reads or automatic checkpoint writes.
 if(new Set(context.paths).size>16)fail('CHECKPOINT_LIMIT',t('한 번에 최대 16개 파일을 복원하세요.','Restore at most 16 files at once.'));
 const entries=await discoverEntries(context),current=await collectSnapshot({...context,entries}),files=buildRestorePlan(context.checkpoint,current,context.paths);
 const backup=await createCheckpoint({...context,entries,name:'Before restore',snapshot:current});
 // A removed folder may need recreation before the existing file transaction can resolve its targets.
 const directories=new Set(entries.filter(entry=>entry.kind==='directory').map(entry=>entry.path));
 for(const file of files){const parts=file.path.split('/');parts.pop();let path='';for(const part of parts){path=path?`${path}/${part}`:part;if(!directories.has(path)){await context.request('file_create',context.workspace,{path,kind:'directory'});directories.add(path);}}}
 const transactionId=crypto.randomUUID();
 const result=await context.request<{status?:string;transactionId?:string}>('apply_proposal',context.workspace,{files,transactionId,summary:t('체크포인트 복원','Restore checkpoint')});
 if(result.status!=='committed')fail('TRANSACTION_PARTIAL',t('복원 트랜잭션이 완료되지 않았습니다.','The restore transaction did not commit.'));
 return {transactionId:result.transactionId??transactionId,paths:files.map(file=>file.path),backup};
}
