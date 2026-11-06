import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {clampEditorPosition,clampPdfPosition,pdfReadingIdentity,readWorkspaceState,WorkspaceStateWriter,type WorkspaceReadingState} from './readingPosition';
import type {WorkspaceRef} from '../contracts';

const workspace:WorkspaceRef={id:'paper',environmentId:'ssh:fixture',root:'/papers/article',epoch:3};
const position={anchor:140,head:120,top:90,inset:12,left:0};
beforeEach(()=>{vi.useFakeTimers();vi.stubGlobal('window',{setTimeout:globalThis.setTimeout});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('durable workspace reading positions',()=>{
 it('coalesces editor/PDF/chat movement with tabs and layout into one complete local metadata record',async()=>{
  const write=vi.fn(async(_scope:WorkspaceRef,_state:WorkspaceReadingState)=>{}),writer=new WorkspaceStateWriter(workspace,{openPaths:['main.tex'],view:'split'},write,vi.fn());
  for(let index=0;index<100;index++)writer.editor('main.tex',{...position,head:index});
  writer.pdf({identity:pdfReadingIdentity('build','hash'),page:4,fraction:0.35,zoom:1.5,fit:false,rotation:90});
  writer.update({chat:{provider:'codex',historyPage:'current.jsonl',following:false,scrollTop:800,anchor:{id:'message-9',inset:12}},layout:{sourceFraction:62,explorer:true,search:false,inspector:true,tab:'ai',explorerWidth:270,inspectorWidth:420}});
  expect(write).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(600);
  expect(write).toHaveBeenCalledTimes(1);const [scope,saved]=write.mock.calls[0] as unknown as [WorkspaceRef,WorkspaceReadingState];
  expect(scope).toEqual(workspace);expect(saved.openPaths).toEqual(['main.tex']);expect(saved.editors).toEqual([{path:'main.tex',position:{...position,head:99}}]);expect(saved.pdfs?.[0].page).toBe(4);expect(saved.chat?.anchor?.id).toBe('message-9');expect(saved.layout?.sourceFraction).toBe(62);
 });
 it('awaits in-flight writes and saves the latest movement before the close flush resolves',async()=>{
  const gate=Promise.withResolvers<void>(),write=vi.fn().mockImplementationOnce(()=>gate.promise).mockResolvedValue(undefined),writer=new WorkspaceStateWriter(workspace,{openPaths:['main.tex']},write,vi.fn());
  writer.editor('main.tex',position);const closing=writer.flush();writer.editor('main.tex',{...position,head:20});
  expect(write).toHaveBeenCalledTimes(1);gate.resolve();await closing;
  expect(write).toHaveBeenCalledTimes(2);expect(write.mock.calls[1][1].editors[0].position.head).toBe(20);
 });
 it('does not accept late callbacks from a disposed epoch or inherit them in another workspace',async()=>{
  const write=vi.fn(async(_scope:WorkspaceRef,_state:WorkspaceReadingState)=>{}),old=new WorkspaceStateWriter(workspace,{openPaths:['main.tex']},write,vi.fn());
  old.editor('main.tex',position);await old.flush();old.dispose();old.editor('late.tex',position);old.update({chat:{provider:'claude',historyPage:'current.jsonl',following:true,scrollTop:999}});
  const next=new WorkspaceStateWriter({...workspace,id:'other',epoch:4},{},write,vi.fn());next.update({openPaths:['fresh.tex']});await next.flush();await vi.runAllTimersAsync();
  expect(write).toHaveBeenCalledTimes(2);expect(write.mock.calls[1][1]).toEqual({openPaths:['fresh.tex']});
 });
 it('keeps failed metadata dirty so an explicit close flush can retry instead of silently losing it',async()=>{
  const write=vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined),writer=new WorkspaceStateWriter(workspace,{openPaths:[]},write,vi.fn());
  writer.editor('main.tex',position);await expect(writer.flush()).rejects.toThrow('disk full');await writer.flush();expect(write).toHaveBeenCalledTimes(2);
 });
 it('evicts oldest positional history to remain within the native 64 KiB record limit',async()=>{
  const write=vi.fn(async(_scope:WorkspaceRef,_state:WorkspaceReadingState)=>{}),writer=new WorkspaceStateWriter(workspace,{openPaths:['main.tex']},write,vi.fn());
  for(let index=0;index<100;index++)writer.editor(`${'가'.repeat(1000)}-${index}.tex`,position);
  await writer.flush();const saved=write.mock.calls[0][1] as unknown as WorkspaceReadingState;
  expect(new TextEncoder().encode(JSON.stringify(saved)).length).toBeLessThan(65536);expect(saved.editors?.at(-1)?.path.endsWith('-99.tex')).toBe(true);expect(saved.openPaths).toEqual(['main.tex']);
 });
 it('reads old tab-only metadata and clamps obsolete reversed selections and PDF pages safely',()=>{
  expect(readWorkspaceState({version:1,openPaths:['paper.tex'],activePath:'paper.tex',view:'source',trash:[]})).toEqual({openPaths:['paper.tex'],activePath:'paper.tex',view:'source',trash:[]});
  expect(clampEditorPosition(position,30)).toEqual({anchor:30,head:30,top:30,inset:12,left:0});
  expect(clampPdfPosition({identity:'same',page:90,fraction:7,zoom:8,fit:false,rotation:12},3)).toEqual({identity:'same',page:3,fraction:1,zoom:3,fit:false,rotation:0});
  expect(pdfReadingIdentity('build-1','hash')).not.toBe(pdfReadingIdentity('build-2','hash'));expect(pdfReadingIdentity('build','hash','a.pdf')).not.toBe(pdfReadingIdentity('build','hash','b.pdf'));
 });
 it('drops malformed restored positions and never restores chat execution authority',()=>{
  const state=readWorkspaceState({openPaths:[],editors:[{path:'main.tex',position:{...position,head:NaN}}],pdfs:[{identity:'bad',page:Infinity,fraction:0,zoom:1,fit:true,rotation:0}],chat:{provider:'codex',historyPage:'../../secret.jsonl',following:false,scrollTop:12}});
  expect(state.editors).toEqual([]);expect(state.pdfs).toEqual([]);expect(state.chat).toBeUndefined();
  expect(readWorkspaceState({chat:{provider:'codex',historyPage:'current.jsonl',following:false,scrollTop:12,approval:true}}).chat).toEqual({provider:'codex',historyPage:'current.jsonl',following:false,scrollTop:12});
 });
});
