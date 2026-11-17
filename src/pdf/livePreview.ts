import {convertFileSrc} from '@tauri-apps/api/core';
import {request} from '../api';
import type {BuildManifest, WorkspaceRef} from '../contracts';
import type {BufferStore} from '../editor/buffers';
import type {WasmTexCompiler as Compiler,PagePreviewResult} from 'wasmtex/headless';
import type {SynctexData} from 'wasmtex/synctex';

type Engine = 'pdflatex' | 'xelatex' | 'lualatex';
type Content = string | Uint8Array;
type Inputs = {buildId:string; rootTex:string; engine:string; files:{path:string; sha256:string; data?:string}[]};
type CachedFile = {sha256:string; bytes:Uint8Array};
export type LivePdf = {
  id:string; rootTex:string; revision:number; bytes:Uint8Array;
  partial?:{firstPage:number;pageLimit:number;baseBuildId:string};
  mapping?:{synctex:Uint8Array|null; synctexData?:SynctexData|null; prefix:string; files:Readonly<Record<string,Content>>; range?:{firstPage:number;lastPage:number}};
};
export type LivePreviewState = {pdf:LivePdf|null; ready:boolean};
type Factory = (files:Record<string,Content>, root:string, engine:Engine)=>Promise<Compiler>;

async function createCompiler(files:Record<string,Content>, root:string, engine:Engine) {
  const {WasmTexCompiler} = await import('wasmtex/headless');
  return new WasmTexCompiler({
    files, mainFile:root, engine, texliveVersion:'2026',
    assetBaseUrl:`${window.location.origin}/`,
    // This is a read-only installed-TeX provider, never the SDK's cloud mirror.
    texliveUrl:`${convertFileSrc('2026','texmf')}/`,
    persistentCache:false, incremental:true,
    // Keep an early body checkpoint for included-source edits. The SDK's byte
    // budget accommodates Asyncify heaps; an undersized cap silently drops them.
    heapCheckpointOptions:{minHeadBytes:0,maxCheckpoints:2},
    tikzExternalization:{mode:'off'},
  });
}

function decode(data:string) {
  const binary=atob(data), bytes=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);
  return bytes;
}

/** A disposable, non-authoritative PDF. Native builds alone own export and source proofs. */
export class LivePreview {
  private compiler:Compiler|null=null;
  private files=new Map<string,CachedFile>();
  private installed=new Map<string,Content>();
  private observed=new Map<string,{generation:number;version:number}>();
  private textCache=new Map<string,{generation:number;version:number;text:string}>();
  private manifest:BuildManifest|null=null;
  private loadedBuild='';
  private requestedBuild='';
  private pendingInputs:Inputs|null=null;
  private fetching=0;
  private generation=0;
  private revision=0;
  private serial=0;
  private presentation=0;
  private timer:number|undefined;
  private running=false;
  private pending=false;
  private disposed=false;
  private suspended=false;
  private awaitingManifest=false;
  private active=true;
  private blocked=false;
  private hasCompiled=false;
  private viewport=1;
  private state:LivePreviewState={pdf:null,ready:false};
  private unsubscribe:()=>void;

  constructor(
    private workspace:WorkspaceRef,
    private store:BufferStore,
    private root:string,
    private engine:Engine,
    private publish:(state:LivePreviewState)=>void,
    private factory:Factory=createCompiler,
    private readInputs:(args:{buildId:string;knownFiles:Record<string,string>})=>Promise<Inputs>=args=>request('preview_inputs',workspace,args),
  ) {
    this.observe(false);
    this.unsubscribe=store.subscribe(()=>this.observe(true));
  }

  private emit(pdf:LivePdf|null,ready=this.state.ready) {
    if(this.disposed||this.state.pdf===pdf&&this.state.ready===ready)return;
    this.state={pdf,ready};this.publish(this.state);
  }

  private unsafe() {
    if(this.store.disconnected)return true;
    for(const buffer of this.store.records.values()) {
      if(buffer.composing||buffer.uncertain||buffer.external||buffer.error)return true;
    }
    return false;
  }

  private observe(schedule:boolean) {
    let changed=false,removed=false;
    const seen=new Set<string>();
    for(const buffer of this.store.records.values()) {
      if(buffer.evicted||buffer.document.readOnly)continue;
      seen.add(buffer.path);
      const old=this.observed.get(buffer.path);
      if(!old||old.generation!==buffer.generation||old.version!==buffer.version) {
        this.observed.set(buffer.path,{generation:buffer.generation,version:buffer.version});changed=true;
      }
    }
    for(const path of this.observed.keys())if(!seen.has(path)) {
      this.observed.delete(path);this.textCache.delete(path);removed=true;
    }
    const blocked=this.unsafe(),unblocked=this.blocked&&!blocked,newlyBlocked=!this.blocked&&blocked;
    this.blocked=blocked;
    if(!schedule)return;
    if(removed) {
      // A closed/discarded or renamed buffer cannot certify its current on-disk contents.
      this.invalidate(true);return;
    }
    if(changed) {this.revision++;if(!this.awaitingManifest)this.suspended=false;}
    if(blocked) {if(newlyBlocked)this.presentation++;clearTimeout(this.timer);this.emit(null);return;}
    if(changed||unblocked)this.schedule();
  }

  private hasUnpublishedInputs() {
    if(!this.manifest)return false;
    // An unstable native build cannot prove that its PDF contains these snapshots.
    if(!this.manifest.mappingReady)return true;
    const hashes=new Map(this.manifest.sources.map(source=>[source.path,source.sha256]));
    for(const buffer of this.store.records.values()) {
      if(buffer.evicted||buffer.document.readOnly)continue;
      if(buffer.dirty||hashes.has(buffer.path)&&hashes.get(buffer.path)!==buffer.document.revision.sha256)return true;
    }
    return false;
  }

  async setManifest(manifest:BuildManifest) {
    if(this.disposed||manifest.workspaceId!==this.workspace.id||manifest.rootTex!==this.root||manifest.engine!==this.engine)return;
    this.manifest=manifest;
    // Keep already displayed immutable bytes while reconciling a newer bundle.
    // In-flight old-generation results remain fenced by valid() below.
    if(!this.hasUnpublishedInputs())this.emit(null);
    if(this.loadedBuild===manifest.buildId||this.requestedBuild===manifest.buildId||this.pendingInputs?.buildId===manifest.buildId)return;
    const requestId=++this.fetching;
    this.requestedBuild=manifest.buildId;
    try {
      const knownFiles=Object.fromEntries([...this.files].map(([path,file])=>[path,file.sha256]));
      const inputs=await this.readInputs({buildId:manifest.buildId,knownFiles});
      if(this.disposed||requestId!==this.fetching)return;
      if(inputs.buildId!==manifest.buildId||inputs.rootTex!==this.root||inputs.engine!==this.engine)throw new Error('PREVIEW_INPUT_IDENTITY');
      this.requestedBuild='';this.pendingInputs=inputs;this.suspended=false;this.awaitingManifest=false;
      this.schedule();
    } catch(cause) {
      if(this.disposed||requestId!==this.fetching)return;
      this.invalidate(true);
      console.warn('Local live preview unavailable; the native build remains authoritative.',cause);
    }
  }

  /** Unknown external edits, cancellation and native failures revoke provisional output. */
  invalidate(awaitManifest=false) {
    if(this.disposed)return;
    this.generation++;this.suspended=true;this.pending=false;
    this.fetching++;this.requestedBuild='';
    this.awaitingManifest=awaitManifest;
    clearTimeout(this.timer);this.pendingInputs=null;this.loadedBuild='';
    this.compiler?.dispose();this.compiler=null;this.installed.clear();this.hasCompiled=false;
    this.emit(null,false);
  }

  setActive(active:boolean) {
    this.active=active;
    if(active)this.schedule();else {this.presentation++;clearTimeout(this.timer);this.emit(null);}
  }

  /** One-based physical page, independent of a partial PDF's local page index. */
  setViewport(page:number) {
    if(this.disposed||!Number.isSafeInteger(page)||page<1||page>10000||page===this.viewport)return;
    this.viewport=page;
    const partial=this.state.pdf?.partial;
    if(this.running||partial&&(page<partial.firstPage||page>partial.pageLimit))this.schedule();
  }

  syncForward(buildId?:string) {
    if(buildId?.startsWith('live:'))return;
    this.presentation++;this.suspended=true;this.pending=false;clearTimeout(this.timer);this.emit(null);
  }

  async externalChanged(paths:string[]) {
    const root=this.workspace.root.replaceAll('\\','/').replace(/\/$/,'');
    for(const value of paths.slice(0,256)) {
      const normalized=value.replaceAll('\\','/'),path=normalized.startsWith(`${root}/`)?normalized.slice(root.length+1):normalized;
      // Open buffers already receive CAS conflict checking and hash-based polling.
      if(!this.files.has(path)||this.store.records.has(path))continue;
      try {
        const result=await request<{revision?:{sha256?:string}}>('file_metadata',this.workspace,{path});
        if(this.disposed)return;
        if(result.revision?.sha256!==this.files.get(path)?.sha256){this.invalidate(true);return;}
      } catch {if(!this.disposed)this.invalidate(true);return;}
    }
  }

  private enginePath(path:string) {
    const prefix=this.root.slice(0,this.root.lastIndexOf('/')+1);
    if(!path.startsWith(prefix))throw new Error('PREVIEW_PARENT_INPUT_REQUIRES_NATIVE_BUILD');
    return path.slice(prefix.length);
  }

  private schedule() {
    if(this.disposed||this.suspended||!this.active||this.unsafe())return;
    this.pending=true;clearTimeout(this.timer);
    this.timer=window.setTimeout(()=>{this.timer=undefined;void this.run();},0);
  }

  private currentFiles() {
    const files:Record<string,Content>=Object.create(null);
    for(const [path,file] of this.files)files[this.enginePath(path)]=file.bytes;
    for(const buffer of this.store.records.values()) {
      if(buffer.evicted||buffer.document.readOnly)continue;
      const prefix=this.root.slice(0,this.root.lastIndexOf('/')+1);
      if(!buffer.path.startsWith(prefix))continue;
      let cached=this.textCache.get(buffer.path);
      if(!cached||cached.generation!==buffer.generation||cached.version!==buffer.version) {
        cached={generation:buffer.generation,version:buffer.version,text:this.store.text(buffer)};
        this.textCache.set(buffer.path,cached);
      }
      files[this.enginePath(buffer.path)]=cached.text;
    }
    return files;
  }

  private applyInputs() {
    const inputs=this.pendingInputs;if(!inputs)return;
    this.pendingInputs=null;
    const next=new Map<string,CachedFile>();
    for(const file of inputs.files) {
      const cached=this.files.get(file.path);
      if(cached?.sha256===file.sha256)next.set(file.path,cached);
      else {
        if(file.data===undefined)throw new Error('PREVIEW_INPUT_CACHE_MISS');
        next.set(file.path,{sha256:file.sha256,bytes:decode(file.data)});
      }
    }
    this.files=next;
    this.loadedBuild=inputs.buildId;
  }

  private async run() {
    if(this.running||!this.pending||this.disposed||this.suspended||!this.active||this.unsafe())return;
    this.pending=false;this.running=true;
    this.emit(this.state.pdf,false);
    const generation=this.generation;
    try {
      // Do not replace the cache used by a newer in-flight delta-input request.
      if(this.pendingInputs&&this.pendingInputs.buildId!==this.manifest?.buildId)return;
      this.applyInputs();
      if(!this.files.size||this.loadedBuild!==this.manifest?.buildId)return;
      let files=this.currentFiles();
      if(!this.compiler) {
        const compiler=await this.factory(files,this.enginePath(this.root),this.engine);
        if(this.disposed||generation!==this.generation){compiler.dispose();return;}
        this.compiler=compiler;this.installed=new Map(Object.entries(files));
        await compiler.init();
        if(this.disposed||generation!==this.generation)return;
        // Initialization may take seconds. Compile the latest buffer snapshot, not
        // the now-obsolete source used to start the worker, and keep that worker warm.
        if(this.loadedBuild!==this.manifest?.buildId)return;
        files=this.currentFiles();
      }
      let changed=!this.hasCompiled;
      const removed=[...this.installed.keys()].some(path=>!(path in files));
      if(removed) {
        this.hasCompiled=false;
        await this.compiler.loadProject(files);this.installed=new Map(Object.entries(files));changed=true;
        if(this.disposed||generation!==this.generation||this.loadedBuild!==this.manifest?.buildId)return;
        files=this.currentFiles();
      }
      for(const [path,content] of Object.entries(files))if(this.installed.get(path)!==content) {
        this.compiler.setFile(path,content);this.installed.set(path,content);changed=true;
        if(!path.toLowerCase().endsWith('.tex'))this.hasCompiled=false;
      }
      if(this.disposed||generation!==this.generation||this.loadedBuild!==this.manifest?.buildId||this.suspended||this.unsafe()||!this.active)return;
      const provisional=this.hasUnpublishedInputs();
      const partial=this.state.pdf?.partial;
      const covered=!partial||this.viewport>=partial.firstPage&&this.viewport<=partial.pageLimit;
      if(!changed&&(!provisional||this.state.pdf&&covered)){this.emit(this.state.pdf,true);return;}
      // Consume all edits included in this immutable snapshot. Edits arriving after
      // this point queue a single latest compile; they do not starve completed PDFs.
      this.pending=false;
      const revision=this.revision,buildId=this.loadedBuild,presentation=this.presentation;
      const snapshot=Object.freeze(files),compiler=this.compiler;
      const valid=()=>!this.disposed&&generation===this.generation&&buildId===this.manifest?.buildId&&presentation===this.presentation&&!this.suspended&&!this.unsafe()&&this.active;
      const publish=(bytes:Uint8Array,ready:boolean,mapping?:LivePdf['mapping'],partial?:LivePdf['partial'])=>{
        const pdf=provisional?{id:`${this.workspace.epoch}:${generation}:${++this.serial}`,rootTex:this.root,revision,bytes,...(mapping?{mapping}:{}),...(partial?{partial}:{})}:null;
        this.emit(pdf,ready);return pdf;
      };
      const prefix=this.root.slice(0,this.root.lastIndexOf('/')+1),activePath=this.store.activePath;
      const path=activePath?.startsWith(prefix)?activePath:this.root;
      // Native publication changes the output frontier, not the worker's input
      // checkpoints. Keep safe body edits warm across it; the SDK checks preamble
      // and included-source compatibility. Auxiliary changes need a full pass.
      if(provisional&&this.hasCompiled&&typeof compiler.previewPages==='function') {
        const page=this.viewport,pageLimit=Math.min(page+1,10000);
        // SDK refusal includes preamble changes, unsupported engines and missing
        // checkpoints for secondary sources. Only real, explicitly placed bytes
        // may become partial frames; every refusal takes the full compile path.
        let preview:PagePreviewResult|null=null;
        try {preview=await compiler.previewPages(pageLimit,{placement:true});}
        catch(cause) {if(valid())console.warn('Page preview unavailable; compiling the complete local PDF.',cause);}
        if(!valid())return;
        const firstPage=preview?.firstPage;
        if(preview&&preview.pdf instanceof Uint8Array&&preview.pdf.length>0&&
          typeof firstPage==='number'&&Number.isSafeInteger(firstPage)&&firstPage>=1&&firstPage<=page&&preview.pageLimit===pageLimit) {
          const partial={firstPage,pageLimit,baseBuildId:buildId};
          const mapping:LivePdf['mapping']=preview.synctex?{synctex:preview.synctex,prefix,files:snapshot,range:{firstPage,lastPage:pageLimit}}:undefined;
          publish(preview.pdf,true,mapping,partial);
          return;
        }
      }
      this.hasCompiled=false;
      let progress:LivePdf|null=null;
      const result=await compiler.compile({
        incrementalPreparation:{path:this.enginePath(path),offset:this.store.records.get(path)?.state?.selection.main.head??0},
        onProgressPdf:frame=>{if(valid())progress=publish(frame.pdf,false);},
      });
      if(!result.success||!result.pdf||result.errors.some(error=>error.severity==='error')) {if(valid())this.emit(null,true);return;}
      if(this.disposed||generation!==this.generation||compiler!==this.compiler)return;
      this.hasCompiled=true;
      if(!valid())return;
      const bytes=result.pdf;
      const mapping:LivePdf['mapping']=result.synctex||result.synctexData?{synctex:result.synctex,synctexData:result.synctexData,prefix,files:snapshot}:undefined;
      // The final result can enrich an identical first-pass frame with exact
      // SyncTeX without assigning a new display identity or repainting its bytes.
      const frame=progress as LivePdf|null;
      if(frame&&this.state.pdf===frame&&frame.bytes.length===bytes.length&&frame.bytes.every((byte,index)=>byte===bytes[index]))this.emit(mapping?{...frame,mapping}:frame,true);
      else publish(bytes,true,mapping);
    } catch(cause) {
      if(this.disposed||generation!==this.generation)return;
      this.emit(null,false);
      this.compiler?.dispose();this.compiler=null;this.installed.clear();this.hasCompiled=false;
      console.warn('Local live preview failed; retaining the verified native PDF.',cause);
    } finally {
      this.running=false;
      if(!this.disposed&&this.pending&&!this.suspended&&!this.unsafe())this.schedule();
    }
  }

  dispose() {
    if(this.disposed)return;
    this.invalidate();this.disposed=true;this.fetching++;this.unsubscribe();this.files.clear();this.textCache.clear();
  }
}
