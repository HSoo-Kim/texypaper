import { t } from "../ui/i18n";
import { EditorState, type ChangeSet } from '@codemirror/state';
import type { AppError, Revision, TextDocument, WorkspaceRef } from '../contracts';
import { normalizeError, request } from '../api';
import type { EditorReadingPosition } from '../state/readingPosition';
import { startWorkspacePolling } from './polling';

export type BufferRecord = { path: string; generation:number; document: TextDocument; state: EditorState | null; dirty: boolean; saving: boolean; composing: boolean; version: number; lastUsed: number; error?: AppError; warning?:AppError; external?: TextDocument; rawText?:string; transactionId?:string; uncertain?:boolean;evicted?:boolean; };
export type SourceSelection = {path:string;startByte:number;endByte:number;baseSha256:string;quote:string;before:string;after:string};
const encoder = new TextEncoder();
export function utf16ToByte(text: string, offset: number): number { return encoder.encode(text.slice(0, offset)).length; }
export function byteToUtf16(text: string, offset: number): number {
  let bytes = 0, index = 0;
  for (const character of text) { const length = encoder.encode(character).length; if (bytes + length > offset) break; bytes += length; index += character.length; }
  return index;
}
export function selectionAnchor(buffer: BufferRecord, from: number, to: number): SourceSelection {
  const text = buffer.rawText ?? buffer.state?.sliceDoc() ?? buffer.document.text;
  if(buffer.document.newline==='mixed'||buffer.document.newline==='crlf'){from=editorOffsetToRaw(text,from);to=editorOffsetToRaw(text,to);}
  const bom=buffer.document.encoding==='utf8Bom'?3:0;
  return {path:buffer.path,startByte:bom+utf16ToByte(text,from),endByte:bom+utf16ToByte(text,to),baseSha256:buffer.document.revision.sha256,quote:text.slice(from,to),before:text.slice(Math.max(0,from-64),from),after:text.slice(to,to+64)};
}
export function editorOffsetToRaw(raw:string,offset:number){let editor=0,index=0;while(index<raw.length&&editor<offset){if(raw[index]==='\r'&&raw[index+1]==='\n')index++;index++;editor++;}return index;}
export function applyEditorChanges(raw:string,changes:ChangeSet){
  const replacements:{from:number;to:number;insert:string}[]=[];
  changes.iterChanges((from,to,_fromB,_toB,insert)=>{const start=editorOffsetToRaw(raw,from),end=editorOffsetToRaw(raw,to);const following=raw.slice(start).match(/\r\n|\n|\r/),preceding=[...raw.slice(0,start).matchAll(/\r\n|\n|\r/g)].at(-1);const separator=following?.[0]??preceding?.[0]??'\n';replacements.push({from:start,to:end,insert:insert.toString().replaceAll('\n',separator)});});
  let next=raw;for(const change of replacements.reverse())next=next.slice(0,change.from)+change.insert+next.slice(change.to);return next;
}
export class BufferStore {
  readonly records = new Map<string, BufferRecord>();
  activePath: string | null = null;
  readonly readingPositions=new Map<string,EditorReadingPosition>();
  rememberPosition(path:string,position:EditorReadingPosition){if(this.disposed)return;this.readingPositions.delete(path);this.readingPositions.set(path,position);if(this.readingPositions.size>64)this.readingPositions.delete(this.readingPositions.keys().next().value!);this.onReadingPosition?.(path,position);}
  private listeners = new Set<() => void>();
  private tick = 0;
  private timers = new Map<string, number>();
  private saves = new Map<string, Promise<void>>();
  private recoveryTimers=new Map<string,number>();
  private disposed = false;
  private openGeneration=0;
  private generation=0;
  private polling:Promise<boolean>|null=null;
  disconnected=false;
  recoveryStatus:string|null=null;
  constructor(readonly workspace: WorkspaceRef, private onSaved: (path:string)=>void, private onDirty:()=>void,readonly remote=false,positions:{path:string;position:EditorReadingPosition}[]=[],private onReadingPosition?:(path:string,position:EditorReadingPosition)=>void) {for(const row of positions)this.readingPositions.set(row.path,row.position);}
  subscribe = (listener:()=>void) => { this.listeners.add(listener); return ()=>this.listeners.delete(listener); };
  snapshot = () => this.tick;
  notify() { if (!this.disposed) { this.tick++; this.listeners.forEach(listener=>listener()); } }
  text(buffer:BufferRecord) { return buffer.rawText ?? buffer.state?.sliceDoc() ?? buffer.document.text; }
  owns(buffer:BufferRecord,generation:number) {return !this.disposed&&this.records.get(buffer.path)===buffer&&buffer.generation===generation;}
  private invalidate(buffer:BufferRecord) {
    buffer.generation=++this.generation;
    clearTimeout(this.timers.get(buffer.path));this.timers.delete(buffer.path);
    clearTimeout(this.recoveryTimers.get(buffer.path));this.recoveryTimers.delete(buffer.path);
    buffer.saving=false;buffer.composing=false;
  }
  private replace(buffer:BufferRecord,document:TextDocument) {
    this.invalidate(buffer);
    buffer.document=document;buffer.rawText=document.newline==='mixed'?document.text:undefined;
    buffer.state=null;buffer.dirty=false;buffer.evicted=false;buffer.external=undefined;buffer.error=undefined;buffer.warning=undefined;buffer.uncertain=false;buffer.transactionId=undefined;buffer.version++;
  }
  trackState(buffer:BufferRecord,generation:number,state:EditorState) {
    if(!this.owns(buffer,generation)||buffer.evicted)return false;
    buffer.state=state;buffer.document.text='';return true;
  }
  startPolling() {return startWorkspacePolling({remote:this.remote,poll:()=>this.poll()});}
  async open(path:string, allowLarge = false): Promise<BufferRecord> {
    const generation=++this.openGeneration;const cached = this.records.get(path);
    if (cached) {
      if(cached.evicted){
        const owner=cached.generation,document=await request<TextDocument>('file_read',this.workspace,{path,allowLarge});
        if(!this.owns(cached,owner)){const current=this.records.get(path);if(current&&!current.evicted)return current;throw new Error(t('작업 공간이 닫혔거나 파일이 변경되었습니다.','The workspace closed or the file changed.'));}
        this.replace(cached,document);
      }
      if(this.disposed)throw new Error(t('작업 공간이 닫혔습니다.'));
      if(generation===this.openGeneration){this.activePath = path;cached.lastUsed = Date.now();this.evict();this.notify();}return cached;
    }
    const document = await request<TextDocument>('file_read',this.workspace,{path,allowLarge});
    if (this.disposed) throw new Error(t('작업 공간이 닫혔습니다.'));
    const buffer:BufferRecord = {path,generation:++this.generation,document,state:null,dirty:false,saving:false,composing:false,version:0,lastUsed:Date.now(),...(document.newline==='mixed'?{rawText:document.text}:{})};
    const recovery = await request<{text?:string;baseSha256?:string;transactionId?:string}>('recovery_read',this.workspace,{path}).catch(()=>null);
    // Recovery belongs to this candidate only. Do not clear a shared journal until the candidate wins installation.
    let clearRecovery=false;
    if(recovery?.transactionId){buffer.transactionId=recovery.transactionId;try{const status=await request<{status:string;files?:{path:string;matchesResult:boolean}[]}>('transaction_status',this.workspace,{transactionId:recovery.transactionId});if(!this.disposed)this.recoveryStatus=status.status;if(status.status==='committed'&&status.files?.some(file=>file.path===path&&file.matchesResult)&&recovery.text===document.text){clearRecovery=true;}else if(!['rolledBack','undone','unknown'].includes(status.status)){buffer.uncertain=true;buffer.external=document;buffer.error={code:'TRANSACTION_PARTIAL',message:t('복구 기록을 확인한 뒤 명시적으로 다시 불러오거나 복사본을 저장하세요.','Inspect recovery records, then explicitly reload or save a copy.'),path,retryable:false};}}catch{if(!this.disposed)this.recoveryStatus='unknown';buffer.uncertain=true;}}
    if (recovery?.text !== undefined && recovery.text !== document.text) {
      buffer.document = {...document,text:recovery.text};if(document.newline==='mixed')buffer.rawText=recovery.text;buffer.dirty = true;
      if (recovery.baseSha256 !== document.revision.sha256){buffer.external=document;buffer.error={code:'FILE_CONFLICT',message:t('디스크의 파일이 변경되었습니다.'),path,retryable:true};}
    }
    if(this.disposed)throw new Error(t('작업 공간이 닫혔습니다.'));
    // A candidate never displaces a record already owned by a view, even if its read finishes later.
    const raced=this.records.get(path);
    if(raced&&!raced.evicted){if(generation===this.openGeneration){this.activePath=path;raced.lastUsed=Date.now();this.evict();this.notify();}return raced;}
    this.records.set(path,buffer);
    if(clearRecovery&&this.owns(buffer,buffer.generation))void request('recovery_clear',this.workspace,{path}).catch(()=>{});
    if(generation===this.openGeneration){this.activePath=path;this.evict();this.notify();}return buffer;
  }
  update(path:string,state:EditorState,changes:ChangeSet|undefined,generation:number) {
    const buffer = this.records.get(path); if (!buffer || !this.owns(buffer,generation)||buffer.evicted) return false;
    if(buffer.document.newline==='mixed'&&changes)buffer.rawText=applyEditorChanges(buffer.rawText??buffer.document.text,changes);
    buffer.state = state; buffer.dirty = true; buffer.version++; buffer.error = undefined; this.onDirty(); this.notify();
    this.schedule(buffer);return true;
  }
  composition(path:string, composing:boolean,generation:number) { const buffer = this.records.get(path); if (!buffer||!this.owns(buffer,generation)) return; buffer.composing = composing; if (!composing && buffer.dirty) this.schedule(buffer); }
  private schedule(buffer:BufferRecord) {
    const generation=buffer.generation;
    clearTimeout(this.timers.get(buffer.path));
    this.timers.set(buffer.path,window.setTimeout(()=>{ this.timers.delete(buffer.path); if(this.owns(buffer,generation))void this.save(buffer.path).catch(()=>{}); },700));
    clearTimeout(this.recoveryTimers.get(buffer.path));this.recoveryTimers.set(buffer.path,window.setTimeout(()=>{this.recoveryTimers.delete(buffer.path);if(!this.owns(buffer,generation))return;void request('recovery_write',this.workspace,{path:buffer.path,text:this.text(buffer),baseSha256:buffer.document.revision.sha256,transactionId:buffer.transactionId}).catch(error=>{if(this.owns(buffer,generation)){buffer.error=normalizeError(error);this.notify();}});},250));
  }
  async save(path:string):Promise<void> {
    const pending = this.saves.get(path); if (pending) { await pending; if (this.records.get(path)?.dirty) return this.save(path); return; }
    const buffer = this.records.get(path); if (!buffer || !buffer.dirty || buffer.document.readOnly) return;
    const generation=buffer.generation;
    // Explicit saves and autosaves both refresh remote conflicts, even after a long idle backoff.
    const operation = (async()=>{
      // Install the in-flight promise before any synchronous validation can settle it.
      await Promise.resolve();
      try {
        if(this.remote)await this.poll();
        if(!this.owns(buffer,generation))return;
        if(this.disconnected||buffer.uncertain)throw {code:'SSH_DISCONNECTED',message:t('다시 연결한 후 트랜잭션 상태를 확인하세요.'),retryable:true};
        if(buffer.composing)throw {code:'IME_ACTIVE',message:t('입력을 마친 후 저장해 주세요.'),retryable:true};
        if(buffer.external)throw {code:'FILE_CONFLICT',message:t('외부 변경을 먼저 비교하거나 다시 불러오세요.'),path,retryable:true};
        clearTimeout(this.timers.get(path));this.timers.delete(path);
        const text=this.text(buffer),version=buffer.version,expectedSha256=buffer.document.revision.sha256,transactionId=crypto.randomUUID();
        buffer.transactionId=transactionId;buffer.saving=true;this.notify();
        await request('recovery_write',this.workspace,{path,text,baseSha256:expectedSha256,transactionId});
        if(!this.owns(buffer,generation))return;
        const saved=await request<TextDocument|Revision|{revision:Revision;warnings?:{path:string;error:AppError}[]}>('file_save',this.workspace,{path,expectedSha256,text,transactionId});
        if(!this.owns(buffer,generation))return;
        const revision='revision' in saved?saved.revision:saved;
        buffer.document={...buffer.document,text:buffer.state?'':text,revision};buffer.dirty=buffer.version!==version;buffer.error=undefined;buffer.warning='warnings' in saved?saved.warnings?.[0]?.error:undefined;
        if(!buffer.dirty)await request('recovery_clear',this.workspace,{path});
        if(this.owns(buffer,generation))this.onSaved(path);
      } catch(error) {
        if(!this.owns(buffer,generation))return;
        const failure=normalizeError(error);buffer.error=failure;
        if(failure.code.startsWith('SSH_')||(this.remote&&failure.code==='IO_ERROR')){buffer.uncertain=true;this.disconnected=true;}
        if(failure.code==='FILE_CONFLICT'){
          const external=await request<TextDocument>('file_read',this.workspace,{path}).catch(()=>undefined);
          if(this.owns(buffer,generation))buffer.external=external;
        }
        throw failure;
      } finally {if(this.owns(buffer,generation))buffer.saving=false;this.saves.delete(path);this.notify();}
    })(); this.saves.set(path,operation); return operation;
  }
  async flush() { for (const buffer of this.records.values()) if (buffer.dirty) await this.save(buffer.path); }
  poll():Promise<boolean> {
    if(this.disposed)return Promise.resolve(false);
    if(this.polling)return this.polling;
    this.polling=this.pollBuffers().finally(()=>{this.polling=null;});return this.polling;
  }
  private async pollBuffers() {
    let changed=false;
    const paths=[...this.records.values()].filter(buffer=>!buffer.evicted&&(buffer.path===this.activePath||buffer.dirty)).slice(0,9);
    for(const buffer of paths){
      const generation=buffer.generation,expected=buffer.document.revision.sha256,version=buffer.version;
      if(!this.owns(buffer,generation)||buffer.saving)continue;
      try{
        const stat=await request<{revision?:{sha256?:string}}>('file_metadata',this.workspace,{path:buffer.path});
        if(!this.owns(buffer,generation)||buffer.saving||buffer.version!==version)continue;
        if(stat.revision?.sha256===expected)continue;
        const current=await request<TextDocument>('file_read',this.workspace,{path:buffer.path});
        if(!this.owns(buffer,generation)||buffer.saving||buffer.version!==version||buffer.document.revision.sha256!==expected)continue;
        if(current.revision.sha256===expected)continue;
        if(buffer.dirty){
          if(buffer.external?.revision.sha256===current.revision.sha256)continue;
          buffer.external=current;buffer.error={code:'FILE_CONFLICT',message:t('디스크의 파일이 변경되었습니다.'),path:buffer.path,retryable:true};
        }else this.replace(buffer,current);
        changed=true;this.notify();
      }catch(error){if(this.owns(buffer,generation)){buffer.error=normalizeError(error);this.notify();}}
    }
    return changed;
  }
  async reload(path:string) {
    const buffer=this.records.get(path);if(!buffer)return;
    const generation=buffer.generation;
    const current=await request<TextDocument>('file_read',this.workspace,{path,allowLarge:!buffer.document.readOnly});
    if(!this.owns(buffer,generation))return;
    this.replace(buffer,current);this.notify();
    await request('recovery_clear',this.workspace,{path});
  }
  async saveCopy(path:string,newPath:string) {const buffer=this.records.get(path);if(!buffer)return;await request('file_create',this.workspace,{path:newPath,kind:'file',content:this.text(buffer)});}
  async allowLarge(path:string) { const buffer=this.records.get(path);if(!buffer)return;const generation=buffer.generation,current=await request<TextDocument>('file_read',this.workspace,{path,allowLarge:true});if(this.owns(buffer,generation)){this.replace(buffer,current);this.notify();} }
  discard() {for(const buffer of this.records.values()){this.invalidate(buffer);buffer.dirty=false;}this.notify();}
  close(path:string) {const buffer=this.records.get(path);if(buffer?.dirty)return false;if(buffer)this.invalidate(buffer);this.records.delete(path);if(this.activePath===path)this.activePath=[...this.records.values()].reverse().find(buffer=>!buffer.evicted)?.path??null;this.notify();return true;}
  rename(oldPath:string,newPath:string){for(const [path,position]of [...this.readingPositions])if(path===oldPath||path.startsWith(`${oldPath}/`)){this.readingPositions.delete(path);this.rememberPosition(newPath+path.slice(oldPath.length),position);}for(const [path,buffer]of [...this.records])if(path===oldPath||path.startsWith(`${oldPath}/`)){const target=newPath+path.slice(oldPath.length);this.invalidate(buffer);this.records.delete(path);buffer.path=target;buffer.document={...buffer.document,file:{...buffer.document.file,path:target}};this.records.set(target,buffer);if(buffer.dirty)this.schedule(buffer);if(this.activePath===path)this.activePath=target;}this.notify();}
  evict() {
    const clean=[...this.records.values()].filter(buffer=>!buffer.dirty&&!buffer.evicted&&buffer.path!==this.activePath).sort((a,b)=>a.lastUsed-b.lastUsed);
    const cost=(buffer:BufferRecord)=>buffer.evicted?0:encoder.encode(this.text(buffer)).length+(buffer.rawText&&buffer.state?buffer.state.doc.length*2:0);let bytes=[...this.records.values()].reduce((sum,buffer)=>sum+cost(buffer),0);
    while(clean.length>8 || bytes>8*1024*1024) {const buffer=clean.shift();if(!buffer)break;bytes-=cost(buffer);this.invalidate(buffer);buffer.state=null;buffer.rawText=undefined;buffer.document={...buffer.document,text:''};buffer.evicted=true;}
  }
  async persistRecovery(){
    for(const buffer of this.records.values()){if(!buffer.dirty)continue;const generation=buffer.generation;let version:number;do{if(!this.owns(buffer,generation)||!buffer.dirty)break;version=buffer.version;await request('recovery_write',this.workspace,{path:buffer.path,text:this.text(buffer),baseSha256:buffer.document.revision.sha256,transactionId:buffer.transactionId});}while(this.owns(buffer,generation)&&buffer.version!==version);}
  }
  dispose() {
    // The owner calls this only after Save/Discard, or an acknowledged reconnect recovery journal.
    this.disposed=true;this.openGeneration++;this.timers.forEach(clearTimeout);this.recoveryTimers.forEach(clearTimeout);this.recoveryTimers.clear();this.timers.clear();this.listeners.clear();this.saves.clear();this.records.clear();this.readingPositions.clear();this.onReadingPosition=undefined;this.activePath=null;this.recoveryStatus=null;this.onSaved=()=>{};this.onDirty=()=>{};
  }
}
