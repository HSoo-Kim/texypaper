import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { EditorState } from '@codemirror/state';
import { applyEditorChanges, BufferStore, selectionAnchor, type BufferRecord } from './buffers';
import { request } from '../api';
vi.mock('../api', () => ({ request: vi.fn(), normalizeError: (error: unknown) => error }));
function buffer(text:string,newline:'lf'|'crlf'|'mixed',encoding:'utf8'|'utf8Bom'='utf8'):BufferRecord{
  return {path:'paper.tex',generation:0,document:{file:{workspaceId:'workspace',path:'paper.tex'},text,revision:{sha256:'base',byteLength:new TextEncoder().encode(text).length+(encoding==='utf8Bom'?3:0),modifiedNs:'0'},newline,encoding,readOnly:false},state:EditorState.create({doc:text,extensions:newline==='crlf'?[EditorState.lineSeparator.of('\r\n')]:[]}),dirty:false,saving:false,composing:false,version:0,lastUsed:0,...(newline==='mixed'?{rawText:text}:{})};
}
describe('byte-preserving editor serialization',()=>{
  it('keeps every unaffected mixed newline while replacing Unicode prose',()=>{
    const raw='first\r\n한글 😀\nthird\r\nfourth\n';const state=EditorState.create({doc:raw});const target=state.doc.line(2);const changes=state.changes({from:target.from,to:target.to,insert:'교체 e\u0301'});
    expect(applyEditorChanges(raw,changes)).toBe('first\r\n교체 e\u0301\nthird\r\nfourth\n');
  });
  it('serializes multiple edits using original coordinates, not shifted positions',()=>{
    const raw='one\r\ntwo\nthree\r\n';const state=EditorState.create({doc:raw});const changes=state.changes([{from:0,to:3,insert:'첫째'},{from:state.doc.line(3).from,to:state.doc.line(3).to,insert:'셋째'}]);expect(applyEditorChanges(raw,changes)).toBe('첫째\r\ntwo\n셋째\r\n');
  });
  it('uses the affected line separator for new lines without rewriting its neighbors',()=>{
    const raw='a\r\nb\nc\r\n';const state=EditorState.create({doc:raw});expect(applyEditorChanges(raw,state.changes({from:state.doc.line(2).from,insert:'new\n'}))).toBe('a\r\nnew\nb\nc\r\n');
  });
  it('maps CodeMirror CRLF-normalized positions to raw BOM-inclusive byte offsets',()=>{
    const value=buffer('a\r\n한😀e\u0301\r\n','crlf','utf8Bom');const line=value.state!.doc.line(2);const anchor=selectionAnchor(value,line.from,line.from+3);expect(anchor.quote).toBe('한😀');expect(anchor.startByte).toBe(6);expect(anchor.endByte).toBe(13);
  });
  it('maps mixed source positions without dropping existing carriage returns',()=>{
    const value=buffer('a\r\n나\n😀\r\n','mixed');const line=value.state!.doc.line(3);const anchor=selectionAnchor(value,line.from,line.to);expect(anchor.quote).toBe('😀');expect(anchor.startByte).toBe(7);expect(anchor.endByte).toBe(11);
  });
  it('releases acknowledged clean workspace caches and ignores disposed editor updates',()=>{
    const store=new BufferStore({id:'workspace',environmentId:'local',root:'fixture',epoch:1},()=>{},()=>{});
    const cached=buffer('cached source\r\n','crlf');store.records.set(cached.path,cached);store.activePath=cached.path;
    let notifications=0;store.subscribe(()=>{notifications++;});
    store.dispose();store.update(cached.path,cached.state!,undefined,cached.generation);store.notify();
    expect(store.records.size).toBe(0);expect(store.activePath).toBeNull();expect(notifications).toBe(0);
  });
  it('records cursor/viewport changes without publishing document snapshots and ignores old epoch callbacks',()=>{
    let notifications=0,positions=0;
    const original={anchor:8,head:3,top:0,inset:14,left:0};
    const store=new BufferStore({id:'workspace',environmentId:'local',root:'fixture',epoch:1},()=>{},()=>{},false,[{path:'paper.tex',position:original}],()=>{positions++;});
    store.subscribe(()=>{notifications++;});
    store.rememberPosition('paper.tex',{...original,head:6});
    expect(store.readingPositions.get('paper.tex')?.head).toBe(6);expect(positions).toBe(1);expect(notifications).toBe(0);
    store.rename('paper.tex','renamed.tex');
    expect(store.readingPositions.has('paper.tex')).toBe(false);expect(store.readingPositions.get('renamed.tex')?.head).toBe(6);
    store.dispose();store.rememberPosition('late.tex',original);
    expect(store.readingPositions.size).toBe(0);expect(positions).toBe(2);
  });
  it('keeps the record the editor already installed when an older open of the same file finishes later',async()=>{
    const reads:((document:BufferRecord['document'])=>void)[]=[];
    (request as unknown as Mock).mockImplementation((command:string)=>command==='file_read'?new Promise(resolve=>reads.push(resolve)):Promise.reject(new Error('no recovery record')));
    const store=new BufferStore({id:'workspace',environmentId:'local',root:'fixture',epoch:1},()=>{},()=>{});
    const first=store.open('paper.tex'),second=store.open('paper.tex');
    expect(reads).toHaveLength(2);
    reads[1](buffer('second read\n','lf').document);const installed=await second;
    installed.state=EditorState.create({doc:'second read\n'});
    reads[0](buffer('first read\n','lf').document);
    expect(await first).toBe(installed);
    expect(store.records.get('paper.tex')).toBe(installed);
    expect(installed.state).not.toBeNull();
    expect(store.records.size).toBe(1);
  });
});

const deferred=<T,>()=>Promise.withResolvers<T>();
describe('buffer generation interleavings',()=>{
  let store:BufferStore;
  beforeEach(()=>{
    vi.useFakeTimers();vi.stubGlobal('window',globalThis);vi.mocked(request).mockReset();
    store=new BufferStore({id:'workspace',environmentId:'local',root:'fixture',epoch:1},()=>{},()=>{});
  });
  afterEach(()=>{store.dispose();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
  function install(text='original\n') {const value=buffer(text,'lf');store.records.set(value.path,value);store.activePath=value.path;return value;}
  function document(text:string,sha256='outside') {const value=buffer(text,'lf').document;value.revision.sha256=sha256;return value;}
  function edit(value:BufferRecord,text:string,generation=value.generation) {const state=value.state??EditorState.create({doc:value.document.text});const transaction=state.update({changes:{from:0,to:state.doc.length,insert:text}});store.update(value.path,transaction.state,transaction.changes,generation);return transaction.state;}

  it('keeps typing when a poll read finishes after the editor update',async()=>{
    const value=install(),read=deferred<BufferRecord['document']>();
    vi.mocked(request).mockImplementation(((command:string)=>command==='file_metadata'?Promise.resolve({revision:{sha256:'outside'}}):read.promise) as typeof request);
    const poll=store.poll();await Promise.resolve();edit(value,'typing while reading\n');read.resolve(document('outside\n'));await poll;
    expect(store.text(value)).toBe('typing while reading\n');expect(value.dirty).toBe(true);expect(value.external).toBeUndefined();expect(value.generation).toBe(0);
  });
  it('rejects an old view write after a clean poll replaced its generation',async()=>{
    const value=install(),generation=value.generation,oldState=value.state!;
    vi.mocked(request).mockImplementation(((command:string)=>Promise.resolve(command==='file_metadata'?{revision:{sha256:'outside'}}:document('outside\n'))) as typeof request);
    await store.poll();store.update(value.path,oldState.update({changes:{from:0,insert:'stale '}}).state,undefined,generation);
    expect(store.text(value)).toBe('outside\n');expect(value.dirty).toBe(false);expect(value.generation).toBeGreaterThan(generation);
  });
  it('retires a pending view update when an approved reload installs',async()=>{
    const value=install(),generation=value.generation,oldState=value.state!,read=deferred<BufferRecord['document']>();
    vi.mocked(request).mockImplementation(((command:string)=>command==='file_read'?read.promise:Promise.resolve(null)) as typeof request);
    const reload=store.reload(value.path);read.resolve(document('approved\n'));await reload;
    store.update(value.path,oldState.update({changes:{from:0,insert:'late '}}).state,undefined,generation);
    expect(value.state).toBeNull();expect(store.text(value)).toBe('approved\n');expect(value.dirty).toBe(false);
  });
  it('does not let a stale save completion overwrite a reloaded revision or clear newer recovery',async()=>{
    const value=install(),saved=deferred<BufferRecord['document']>();
    vi.mocked(request).mockImplementation(((command:string)=>command==='file_save'?saved.promise:Promise.resolve(command==='file_read'?document('reloaded\n'):null)) as typeof request);
    edit(value,'save snapshot\n');const save=store.save(value.path);await vi.advanceTimersByTimeAsync(0);
    expect(value.saving).toBe(true);await store.reload(value.path);edit(value,'new generation edit\n');
    const clears=vi.mocked(request).mock.calls.filter(call=>call[0]==='recovery_clear').length;
    saved.resolve(document('save snapshot\n','saved-old'));await save;
    expect(value.document.revision.sha256).toBe('outside');expect(store.text(value)).toBe('new generation edit\n');expect(value.dirty).toBe(true);
    expect(vi.mocked(request).mock.calls.filter(call=>call[0]==='recovery_clear')).toHaveLength(clears);
  });
  it('ignores a late save error and its conflict recovery after reload',async()=>{
    const value=install(),saved=deferred<BufferRecord['document']>();
    vi.mocked(request).mockImplementation(((command:string)=>command==='file_save'?saved.promise:Promise.resolve(command==='file_read'?document('reloaded\n'):null)) as typeof request);
    edit(value,'save snapshot\n');const save=store.save(value.path);await vi.advanceTimersByTimeAsync(0);await store.reload(value.path);
    saved.reject({code:'FILE_CONFLICT',message:'late conflict',retryable:true});await save;
    expect(value.error).toBeUndefined();expect(value.external).toBeUndefined();expect(value.dirty).toBe(false);
  });
  it('keeps a newer reopened record when two evicted reads complete out of order',async()=>{
    const value=install(),reads=[deferred<BufferRecord['document']>(),deferred<BufferRecord['document']>()];
    value.evicted=true;value.state=null;let count=0;
    vi.mocked(request).mockImplementation((()=>reads[count++].promise) as typeof request);
    const first=store.open(value.path),second=store.open(value.path);reads[1].resolve(document('new reopen\n'));expect(await second).toBe(value);
    edit(value,'edited reopened\n');const generation=value.generation;
    reads[0].resolve(document('old reopen\n'));expect(await first).toBe(value);
    expect(store.text(value)).toBe('edited reopened\n');expect(value.generation).toBe(generation);expect(value.dirty).toBe(true);
  });
  it('evicts ownership and rejects old updates after reopening',async()=>{
    const value=install(),generation=value.generation,oldState=value.state!;
    store.activePath='another.tex';
    for(let index=0;index<9;index++){const other=buffer(`fixture ${index}`,'lf');other.path=`${index}.tex`;other.lastUsed=index+1;store.records.set(other.path,other);}
    store.evict();expect(value.evicted).toBe(true);
    vi.mocked(request).mockResolvedValue(document('reopened\n'));await store.open(value.path);
    store.update(value.path,oldState,undefined,generation);
    expect(store.text(value)).toBe('reopened\n');expect(value.dirty).toBe(false);expect(value.generation).toBeGreaterThan(generation);
  });
  it('ignores a poll completing after close and reopen',async()=>{
    const value=install(),stat=deferred<{revision:{sha256:string}}>();
    vi.mocked(request).mockImplementation(((command:string)=>command==='file_metadata'?stat.promise:Promise.resolve(command==='file_read'?document('new record\n','new'):null)) as typeof request);
    const poll=store.poll();store.close(value.path);const next=await store.open(value.path);stat.resolve({revision:{sha256:'outside'}});await poll;
    expect(next.document.revision.sha256).toBe('new');expect(store.text(next)).toBe('new record\n');expect(value.error).toBeUndefined();
  });
  it('ignores a recovery write failure belonging to a retired generation',async()=>{
    const value=install(),recovery=deferred<null>();
    vi.mocked(request).mockImplementation(((command:string)=>command==='recovery_write'?recovery.promise:Promise.resolve(command==='file_read'?document('reloaded\n'):null)) as typeof request);
    edit(value,'pending recovery\n');await vi.advanceTimersByTimeAsync(250);await store.reload(value.path);recovery.reject({code:'IO_ERROR',message:'old failure',retryable:true});await Promise.resolve();
    expect(value.error).toBeUndefined();expect(value.dirty).toBe(false);
  });
  it('polls immediately before a remote save and joins an already in-flight poll',async()=>{
    store.dispose();store=new BufferStore({id:'workspace',environmentId:'ssh',root:'fixture',epoch:1},()=>{},()=>{},true);
    const value=install(),stat=deferred<{revision:{sha256:string}}>();
    vi.mocked(request).mockImplementation(((command:string)=>command==='file_metadata'?stat.promise:Promise.resolve(command==='file_save'?document('saved\n','saved'):null)) as typeof request);
    edit(value,'saved\n');const poll=store.poll(),save=store.save(value.path);await Promise.resolve();
    expect(vi.mocked(request).mock.calls.some(call=>call[0]==='file_save')).toBe(false);
    stat.resolve({revision:{sha256:'base'}});await Promise.all([poll,save]);
    expect(vi.mocked(request).mock.calls.filter(call=>call[0]==='file_metadata')).toHaveLength(1);expect(value.document.revision.sha256).toBe('saved');expect(value.dirty).toBe(false);
  });
});
