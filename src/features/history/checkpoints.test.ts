import { describe, expect, it, vi } from 'vitest';
import type { Entry, TextDocument, WorkspaceRef } from '../../contracts';
import { buildRestorePlan, collectSnapshot, compareWithCurrent, createCheckpoint, discoverEntries, restoreFiles, snapshotEntry, type Checkpoint, type CheckpointRequest, type Snapshot } from './checkpoints';
const workspace:WorkspaceRef={id:'test',environmentId:'local',root:'fixture',epoch:1};
const entry=(path:string,kind:Entry['kind']='file'):Entry=>({path,name:path.split('/').at(-1)!,kind,paper:'none',main:false});
const file=(path:string,text:string)=>({path,text,sha256:'stored'});
const checkpoint:Checkpoint={id:'checkpoint',name:'Saved',createdAt:'2026-11-07T00:00:00.000Z',files:[file('main.tex','original\r\ntext'),file('removed.tex','removed')]};
const snapshot=(files= [file('main.tex','current')]):Snapshot=>({files,present:files.map(file=>file.path),revisions:Object.fromEntries(files.map(file=>[file.path,'revision-'+file.path])),skipped:[]});
const document=(text:string,extra:Partial<TextDocument>={}):TextDocument=>({file:{workspaceId:'test',path:'main.tex'},text,revision:{sha256:'raw-hash',byteLength:text.length,modifiedNs:'0'},encoding:'utf8',newline:'lf',readOnly:false,...extra});
describe('checkpoint collection',()=>{
 it('selects only allowed extensions and never hidden, excluded or symlink paths',()=>{
  for(const path of ['main.tex','chapter.LTX','ref.bib','style.sty','x.yaml','code.py','source/test.jl'])expect(snapshotEntry(entry(path)),path).toBe(true);
  for(const path of ['x.pdf','x.png','.secret.tex','sub/.env/x.tex','.git/config.tex','.texypaper/x.tex','.paperdock/x.tex','node_modules/x.tex','.venv/x.tex','venv/x.tex','__pycache__/x.py','build/x.tex','dist/x.tex','target/x.tex','../x.tex','a\\x.tex','C:/x.tex'])expect(snapshotEntry(entry(path)),path).toBe(false);
  expect(snapshotEntry(entry('x.tex','directory'))).toBe(false);expect(snapshotEntry(entry('x.tex','symlink'))).toBe(false);
 });
 it('reports every skipped read while hashing exact text, not BOM-inclusive revisions',async()=>{
  const request=vi.fn(async(_command:string,_workspace:WorkspaceRef,args:unknown)=>{const path=(args as {path:string}).path;if(path==='fail.tex')throw {code:'IO_ERROR',message:'Cannot read'};return document(path==='large.tex'?'x'.repeat(1048577):'a\r\n',{readOnly:path==='readonly.tex',truncated:path==='truncated.tex',encoding:path==='legacy.tex'?'unsupported':'utf8'});}) as CheckpointRequest;
  const result=await collectSnapshot({workspace,request,entries:['good.tex','readonly.tex','truncated.tex','legacy.tex','large.tex','fail.tex','hidden.pdf'].map(path=>entry(path))});
  expect(result.files.map(file=>file.path)).toEqual(['good.tex']);expect(result.files[0].text).toBe('a\r\n');expect(result.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);expect(result.revisions['good.tex']).toBe('raw-hash');expect(result.skipped).toHaveLength(5);expect(request).toHaveBeenCalledTimes(6);
 });
 it('refuses an incomplete snapshot when the total file cap would be exceeded',async()=>{
  const request=vi.fn(async()=>document('')) as CheckpointRequest;
  await expect(collectSnapshot({workspace,request,entries:Array.from({length:401},(_,i)=>entry(`${i}.tex`))})).rejects.toMatchObject({code:'CHECKPOINT_LIMIT'});
 });
 it('discovers unexpanded directories but never descends private folders',async()=>{
  const request=vi.fn(async(_command:string,_workspace:WorkspaceRef,args:unknown)=>({entries:(args as {path:string}).path===''?[entry('chapter','directory'),entry('.git','directory'),entry('build','directory')]:[entry('chapter/nested.tex')]})) as CheckpointRequest;
  expect((await discoverEntries({workspace,request})).map(entry=>entry.path)).toEqual(['chapter','chapter/nested.tex']);expect(request).toHaveBeenCalledTimes(2);
 });
 it.each(['cursor','offset'])('reads every directory page with %s pagination',async(mode)=>{
  let page=0;const request=vi.fn(async()=>++page===1?{entries:[entry('first.tex')],...(mode==='cursor'?{nextCursor:'256'}:{nextOffset:256})}:{entries:[entry('second.tex')]}) as CheckpointRequest;
  expect((await discoverEntries({workspace,request})).map(entry=>entry.path)).toEqual(['first.tex','second.tex']);expect(request).toHaveBeenLastCalledWith('directory_list',workspace,expect.objectContaining(mode==='cursor'?{cursor:'256'}:{offset:256}));
 });
 it('does not claim success if native storage refuses',async()=>{
  const request=vi.fn(async()=>{throw {code:'CHECKPOINT_EXISTS',message:'Exists'};}) as CheckpointRequest;
  await expect(createCheckpoint({workspace,request,entries:[],snapshot:snapshot([]),name:'Saved'})).rejects.toMatchObject({code:'CHECKPOINT_EXISTS'});
 });
});
describe('checkpoint comparison and restore',()=>{
 it('classifies changed, added, removed and same without treating CRLF as a visible change',()=>{
  const current=snapshot([file('main.tex','original\ntext'),file('added.tex','added')]);const result=compareWithCurrent(checkpoint,current);expect(result).toEqual({changed:[],added:['added.tex'],removed:[{path:'removed.tex',text:'removed'}],same:1});
  expect(compareWithCurrent(checkpoint,snapshot()).changed[0]).toEqual({path:'main.tex',before:'original\r\ntext',after:'current'});
 });
 it('does not mislabel unreadable present files as removed',()=>{const current=snapshot([]);current.present=['main.tex','removed.tex'];expect(compareWithCurrent(checkpoint,current).removed).toEqual([]);expect(()=>buildRestorePlan(checkpoint,current,['main.tex'])).toThrow();});
 it('uses current hashes, null for recreation, and exact checkpoint bytes; never deletes additions',()=>{
  const current=snapshot([file('main.tex','current'),file('added.tex','keep')]);expect(buildRestorePlan(checkpoint,current,['main.tex','removed.tex'])).toEqual([{action:'edit',path:'main.tex',baseSha256:'revision-main.tex',content:'original\r\ntext'},{action:'create',path:'removed.tex',baseSha256:null,content:'removed'}]);
  expect(()=>buildRestorePlan(checkpoint,current,['added.tex'])).toThrow();
 });
 it('preserves a recreated BOM without doubling BOM on existing files',()=>{const bom={...checkpoint,files:[{...file('main.tex','text'),'encoding':'utf8Bom' as const}]};expect(buildRestorePlan(bom,snapshot([]),['main.tex'])[0].content).toBe('\uFEFFtext');expect(buildRestorePlan(bom,snapshot(),['main.tex'])[0].content).toBe('text');});
 it('enforces the 16-file transaction cap before writes',async()=>{const request=vi.fn() as CheckpointRequest;await expect(restoreFiles({workspace,request,entries:[],checkpoint,paths:Array.from({length:17},(_,i)=>`${i}.tex`)})).rejects.toMatchObject({code:'CHECKPOINT_LIMIT'});expect(request).not.toHaveBeenCalled();});
 it('creates an automatic checkpoint before applying a hash-checked transaction',async()=>{
  const calls:{command:string;args:unknown}[]=[];const request=vi.fn(async(command:string,_workspace:WorkspaceRef,args:unknown)=>{calls.push({command,args});if(command==='directory_list')return {entries:[entry('main.tex'),entry('added.tex')]};if(command==='file_read')return document('current');if(command==='checkpoint_put')return {saved:true,id:'backup',pruned:['old']};if(command==='apply_proposal')return {status:'committed',transactionId:'applied'};throw new Error(command);}) as CheckpointRequest;
  const result=await restoreFiles({workspace,request,entries:[],checkpoint,paths:['main.tex','removed.tex']});expect(result.transactionId).toBe('applied');expect(calls.map(call=>call.command)).toEqual(['directory_list','file_read','file_read','checkpoint_put','apply_proposal']);expect((calls.at(-1)!.args as {files:unknown[]}).files).toEqual([{action:'edit',path:'main.tex',baseSha256:'raw-hash',content:'original\r\ntext'},{action:'create',path:'removed.tex',baseSha256:null,content:'removed'}]);
 });
 it('recreates missing ancestor directories only after recording the automatic checkpoint',async()=>{
  const commands:string[]=[];const request=vi.fn(async(command:string)=>{commands.push(command);if(command==='directory_list')return {entries:[]};if(command==='checkpoint_put')return {saved:true,id:'backup',pruned:[]};if(command==='file_create')return {created:true};if(command==='apply_proposal')return {status:'committed'};throw new Error(command);}) as CheckpointRequest;
  const nested={...checkpoint,files:[file('chapters/part/main.tex','original')]};await restoreFiles({workspace,request,entries:[],checkpoint:nested,paths:['chapters/part/main.tex']});expect(commands).toEqual(['directory_list','checkpoint_put','file_create','file_create','apply_proposal']);
 });
 it.each([undefined,'partial','rolledBack'])('never reports an uncommitted native response (%s) as success',async(status)=>{
  const request=vi.fn(async(command:string)=>{if(command==='directory_list')return {entries:[]};if(command==='checkpoint_put')return {saved:true,id:'backup',pruned:[]};return {status};}) as CheckpointRequest;
  await expect(restoreFiles({workspace,request,entries:[],checkpoint,paths:['removed.tex']})).rejects.toMatchObject({code:'TRANSACTION_PARTIAL'});
 });
 it('does not apply if the automatic checkpoint fails',async()=>{const commands:string[]=[];const request=vi.fn(async(command:string)=>{commands.push(command);if(command==='directory_list')return {entries:[]};throw {code:'IO_ERROR',message:'Disk full'};}) as CheckpointRequest;await expect(restoreFiles({workspace,request,entries:[],checkpoint,paths:['removed.tex']})).rejects.toMatchObject({code:'IO_ERROR'});expect(commands).not.toContain('apply_proposal');});
});
