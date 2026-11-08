import type { AppError, Entry, TextDocument, WorkspaceRef } from '../../contracts';
import { normalizeError } from '../../api';
import { t } from '../../ui/i18n';

export type CheckpointFile={path:string;sha256:string;text:string;encoding?:'utf8'|'utf8Bom'};
export type Checkpoint={id:string;name:string;createdAt:string;files:CheckpointFile[];kind?:'manual'|'auto';reason?:string;partial?:boolean};
export type CheckpointSummary=Omit<Checkpoint,'files'>&{fileCount:number;byteLength:number;corrupt?:boolean};
export type Snapshot={files:CheckpointFile[];skipped:{path:string;reason:string}[];revisions:Record<string,string>;present:string[]};
export type CheckpointRequest=<T>(command:string,workspace:WorkspaceRef,args?:unknown)=>Promise<T>;
type Context={workspace:WorkspaceRef;request:CheckpointRequest;entries:Entry[]};
export const MAX_FILES=400,MAX_AUTO_FILES=16,MAX_BYTES=8*1024*1024,MAX_FILE_BYTES=1024*1024;
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
export type AutomaticReason='ai'|'replace'|'pdf-edit'|'restore';
export function checkpointReason(reason:string):string{
 switch(reason){
  case 'ai':return t('AI 제안 적용 전','before applying AI changes');
  case 'replace':return t('프로젝트 바꾸기 전','before replace');
  case 'pdf-edit':return t('PDF 원문 수정 전','before PDF text edit');
  case 'restore':return t('복원 전','Before restore');
  default:return reason;
 }
}
export function checkpointLabel(checkpoint:Pick<Checkpoint,'kind'|'name'|'reason'>):string{
 return checkpoint.kind==='auto'?`${t('자동','Automatic')} · ${checkpointReason(checkpoint.reason??checkpoint.name)}`:checkpoint.name;
}
export function automaticCheckpointWarning(cause:unknown):AppError{
 const error=normalizeError(cause);
 return {code:'CHECKPOINT_WARNING',message:`${t('자동 체크포인트를 저장하지 못했습니다. 변경은 계속 적용됩니다.','Could not save the automatic checkpoint. The change will still be applied.')} ${error.code}: ${error.message}`,retryable:false};
}
/** Read only explicitly targeted files; never crawl a local or SSH project for an automatic snapshot. */
export async function collectTargetSnapshot(context:Omit<Context,'entries'>&{paths:string[]}):Promise<Snapshot>{
 const paths=[...new Set(context.paths)];
 if(paths.length>MAX_AUTO_FILES)fail('CHECKPOINT_LIMIT',t('자동 체크포인트는 최대 16개 파일입니다.','Automatic checkpoints support at most 16 files.'));
 const result:Snapshot={files:[],skipped:[],revisions:{},present:[]};let total=0;
 for(const path of paths){
  if(!allowedPath(path))fail('CHECKPOINT_PATH',t('체크포인트에 저장할 수 없는 경로입니다.','This path cannot be checkpointed.'));
  let document:TextDocument;
  try{document=await context.request<TextDocument>('file_read',context.workspace,{path});}
  catch(cause){const error=normalizeError(cause);if(error.code==='FILE_NOT_FOUND'||error.code==='NOT_FOUND')continue;result.present.push(path);result.skipped.push({path,reason:error.message});continue;}
  result.present.push(path);
  const bytes=new TextEncoder().encode(document.text).length;
  if(document.readOnly||document.truncated||!['utf8','utf8Bom'].includes(document.encoding)||bytes>MAX_FILE_BYTES){result.skipped.push({path,reason:t('읽을 수 있는 1 MiB 이하 UTF-8 파일이 필요합니다.','Requires readable UTF-8 text of at most 1 MiB.')});continue;}
  if(total+bytes>MAX_BYTES)fail('CHECKPOINT_LIMIT',t('체크포인트 텍스트는 최대 8 MiB입니다.','Checkpoint text is limited to 8 MiB.'));
  total+=bytes;result.files.push({path,text:document.text,sha256:await sha256(document.text),encoding:document.encoding as 'utf8'|'utf8Bom'});result.revisions[path]=document.revision.sha256;
 }
 return result;
}
export async function createAutomaticCheckpoint(context:Omit<Context,'entries'>&{paths:string[];reason:AutomaticReason;snapshot?:Snapshot}){
 if(new Set(context.paths).size>MAX_AUTO_FILES)fail('CHECKPOINT_LIMIT',t('자동 체크포인트는 최대 16개 파일입니다.','Automatic checkpoints support at most 16 files.'));
 const snapshot=context.snapshot??await collectTargetSnapshot(context);
 if(snapshot.skipped.length)fail('CHECKPOINT_UNREADABLE',snapshot.skipped.map(file=>`${file.path}: ${file.reason}`).join('; '));
 return createCheckpoint({...context,entries:[],snapshot,name:checkpointReason(context.reason),kind:'auto',reason:context.reason,partial:true});
}
export async function createCheckpoint(context:Context&{name:string;snapshot?:Snapshot;kind?:'manual'|'auto';reason?:string;partial?:boolean}){
 const snapshot=context.snapshot??await collectSnapshot(context);
 const checkpoint:Checkpoint={id:crypto.randomUUID(),name:context.name,createdAt:new Date().toISOString(),files:snapshot.files,...(context.kind?{kind:context.kind,reason:context.reason,partial:context.partial}:{})};
 const result=await context.request<{saved:boolean;id:string;pruned:string[]}>('checkpoint_put',context.workspace,checkpoint);
 if(!result.saved)fail('CHECKPOINT_FAILED',t('체크포인트 저장을 확인하지 못했습니다.','Checkpoint storage was not confirmed.'));
 return {checkpoint,skipped:snapshot.skipped,pruned:result.pruned};
}
const displayText=(text:string)=>text.replace(/\r\n/g,'\n');
export function compareWithCurrent(checkpoint:Pick<Checkpoint,'files'|'partial'>,current:Pick<Snapshot,'files'>&{present?:string[]}){
 const now=new Map(current.files.map(file=>[file.path,file])),before=new Map(checkpoint.files.map(file=>[file.path,file])),present=new Set(current.present??now.keys());
 const changed:{path:string;before:string;after:string}[]=[],removed:{path:string;text:string}[]=[];let same=0;
 for(const file of checkpoint.files){const next=now.get(file.path);if(!next){if(!present.has(file.path))removed.push({path:file.path,text:file.text});}else if(displayText(file.text)===displayText(next.text))same++;else changed.push({path:file.path,before:file.text,after:next.text});}
 return {changed,added:checkpoint.partial?[]:current.files.filter(file=>!before.has(file.path)).map(file=>file.path),removed,same};
}
export function buildRestorePlan(checkpoint:Checkpoint,current:Snapshot,paths:string[]){
 const selected=[...new Set(paths)];if(!selected.length)fail('CHECKPOINT_SELECTION',t('복원할 파일을 선택하세요.','Select files to restore.'));
 if(selected.length>16)fail('CHECKPOINT_LIMIT',t('한 번에 최대 16개 파일을 복원할 수 있습니다. 파일을 개별 선택해 복원하세요.','Restore at most 16 files at once. Select individual files to restore.'));
 return selected.map(path=>{const file=checkpoint.files.find(file=>file.path===path);if(!file||!allowedPath(path))fail('CHECKPOINT_PATH',t('복원할 수 없는 체크포인트 경로입니다.','This checkpoint path cannot be restored.'));const exists=current.present.includes(path),base=current.revisions[path];if(exists&&!base)fail('CHECKPOINT_UNREADABLE',`${path}: ${t('읽기 전용이거나 읽지 못한 파일은 복원할 수 없습니다.','Cannot restore a read-only or unreadable file.')}`);return {action:exists?'edit':'create',path,baseSha256:base??null,content:!exists&&file.encoding==='utf8Bom'?'\uFEFF'+file.text:file.text};});
}
export async function restoreFiles(context:Context&{checkpoint:Checkpoint;paths:string[]}){
 // Reject oversized selections before any reads or automatic checkpoint writes.
 if(new Set(context.paths).size>16)fail('CHECKPOINT_LIMIT',t('한 번에 최대 16개 파일을 복원하세요.','Restore at most 16 files at once.'));
 if(context.paths.some(path=>!context.checkpoint.files.some(file=>file.path===path)))fail('CHECKPOINT_PATH',t('이 기록에 포함된 파일만 복원할 수 있습니다.','Only files included in this snapshot can be restored.'));
 const entries=context.checkpoint.partial?[]:await discoverEntries(context),current=context.checkpoint.partial?await collectTargetSnapshot({...context,paths:context.paths}):await collectSnapshot({...context,entries:entries.filter(entry=>context.paths.includes(entry.path))}),files=buildRestorePlan(context.checkpoint,current,context.paths);
 const backup=await createAutomaticCheckpoint({...context,paths:context.paths,reason:'restore',snapshot:current});
 // A removed folder may need recreation before the existing file transaction can resolve its targets.
 const directories=new Set(entries.filter(entry=>entry.kind==='directory').map(entry=>entry.path));
 for(const file of files){
  if(file.action==='edit')continue;
  const parts=file.path.split('/');parts.pop();let path='';
  for(const part of parts){
   path=path?`${path}/${part}`:part;
   if(directories.has(path))continue;
   if(context.checkpoint.partial){
    try{await context.request('directory_list',context.workspace,{path,showHidden:false});directories.add(path);continue;}
    catch(cause){if(!['FILE_NOT_FOUND','NOT_FOUND'].includes(normalizeError(cause).code))throw cause;}
   }
   await context.request('file_create',context.workspace,{path,kind:'directory'});directories.add(path);
  }
 }
 const transactionId=crypto.randomUUID();
 const result=await context.request<{status?:string;transactionId?:string}>('apply_proposal',context.workspace,{files,transactionId,summary:t('체크포인트 복원','Restore checkpoint')});
 if(result.status!=='committed')fail('TRANSACTION_PARTIAL',t('복원 트랜잭션이 완료되지 않았습니다.','The restore transaction did not commit.'));
 return {transactionId:result.transactionId??transactionId,paths:files.map(file=>file.path),backup};
}
