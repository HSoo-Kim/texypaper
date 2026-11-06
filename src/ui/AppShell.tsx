import { t, setLocale, useI18n } from './i18n';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { AppError, BuildManifest, CommentThread, Diagnostic, Entry, Environment, TextDocument, WorkspaceRef } from '../contracts';
import { native, normalizeError, request, workspaceEvents } from '../api';
import { BufferStore, byteToUtf16, type SourceSelection } from '../editor/buffers';
import { SourceEditor, type SourceEditorHandle } from '../editor/SourceEditor';
import { FileTree, type FileMutation } from '../features/explorer/FileTree';
import { upsertEntries } from '../features/explorer/paperIndex';
import { CommentsPanel, type CommentSelection } from '../features/comments/CommentsPanel';
import { AgentPanel } from '../features/ai/AgentPanel';
import { PdfPreview } from '../pdf/PdfPreview';
import { SelectionPopover } from '../features/pdf-edit/SelectionPopover';
import { SourceEditReview } from '../features/pdf-edit/SourceEditReview';
import { defaultProject, findRoot, openWorkspace, type ProjectSettings } from '../state/workspace';
import { Toolbar, type ViewMode } from './Toolbar';
import { UpdateNotice, useUpdates } from './Updates';
import { SettingsSheet } from './SettingsSheet';
import { AssetPreview } from './AssetPreview';
import { WorkspacePicker, type RecentWorkspace } from './WorkspacePicker';
import { Inspector, type InspectorTab } from './Inspector';
import { applyTheme, defaultSettings, type AppSettings } from './theme';
import './tokens.css';
import { errorText } from './errors';
import { Icon, type IconName } from './Icon';
import { AppMenu } from './AppMenu';
import { ProjectSearch } from './ProjectSearch';
import { FileOutline } from '../features/explorer/FileOutline';
import productIcon from './assets/texypaper-icon.png';

type Bootstrap={dataDir:string;openPath?:string;environments:Environment[];recents:RecentWorkspace[];settings:Partial<AppSettings>};
type BuildPhase='idle'|'queued'|'building'|'published'|'failed'|'cancelled'|'timeout';
type BuildResult={status:string;manifest?:BuildManifest;diagnostics?:Diagnostic[];logTail?:string;stale?:boolean};
type Choice={title:string;message:string;options:{label:string;value:string}[];resolve:(value:string)=>void};
type DisplayedPdf={workspaceId:string;epoch:number;buildId:string;pdfSha256:string;referencePath?:string;pageCount?:number};
type TrashRecord={path:string;transactionId:string};
type SshPrompt={id:string;prompt:string;kind:'hostKey'|'password'|'passphrase'|'challenge'};
const localEnvironment:Environment={id:'local',label:t('이 컴퓨터'),kind:'local'};
const texPathPattern=/\.(tex|ltx)$/i;
function Splitter({label,min,max,value,onChange,onCommit,reverse=false}:{label:string;min:number;max:number;value:number;onChange:(value:number)=>void;onCommit:(value:number)=>void;reverse?:boolean}){
  const drag=useRef<{x:number;value:number}|null>(null),latest=useRef(value);latest.current=value;return <div role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} tabIndex={0} className="splitter" onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);drag.current={x:event.clientX,value};}} onPointerMove={event=>{if(drag.current){const next=Math.max(min,Math.min(max,drag.current.value+(event.clientX-drag.current.x)*(reverse?-1:1)));latest.current=next;onChange(next);}}} onPointerUp={()=>{drag.current=null;onCommit(latest.current);}} onPointerCancel={()=>{drag.current=null;onCommit(latest.current);}} onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();const next=Math.max(min,Math.min(max,value+(event.key==='ArrowRight'?10:-10)*(reverse?-1:1)));onChange(next);onCommit(next);}}}/>;
}
export default function AppShell(){
  useI18n();
  const [searchPanel,setSearchPanel]=useState(false),[helpOpen,setHelpOpen]=useState(false),[sourceFraction,setSourceFraction]=useState(50);
  const sourceDrag=useRef(false);
  const [chatDetached,setChatDetached]=useState(false);
  const onChatDetachedChange=useCallback((detached:boolean)=>{setChatDetached(detached);setInspector(!detached);if(!detached)setTab('ai');},[]);
  // One map owns filenames per epoch; allEntries publishes immutable array snapshots for existing UI consumers.
  const filenameIndex=useRef<{workspaceId:string;epoch:number;entries:Map<string,Entry>}|null>(null);
  const [bootstrap,setBootstrap]=useState<Bootstrap|null>(null),[settings,setSettings]=useState<AppSettings>(defaultSettings),[workspace,setWorkspace]=useState<WorkspaceRef|null>(null),[store,setStore]=useState<BufferStore|null>(null),[project,setProject]=useState<ProjectSettings>(defaultProject),[environments,setEnvironments]=useState<Environment[]>([localEnvironment]),[recents,setRecents]=useState<RecentWorkspace[]>([]);
  const [error,setError]=useState<AppError|null>(null),[opening,setOpening]=useState(false),[picker,setPicker]=useState(false),[settingsOpen,setSettingsOpen]=useState(false),[trashOpen,setTrashOpen]=useState(false),[trashRows,setTrashRows]=useState<TrashRecord[]>([]),[view,setView]=useState<ViewMode>('split'),[explorer,setExplorer]=useState(true),[inspector,setInspector]=useState(true),[tab,setTab]=useState<InspectorTab>('ai'),[refreshKey,setRefreshKey]=useState(0),[allEntries,setAllEntries]=useState<Entry[]>([]),[manifest,setManifest]=useState<BuildManifest|null>(null),[displayedPdf,setDisplayedPdf]=useState<DisplayedPdf|null>(null),[building,setBuilding]=useState(false),[buildPhase,setBuildPhase]=useState<BuildPhase>('idle'),[buildFailure,setBuildFailure]=useState<AppError|null>(null),[sourceOpening,setSourceOpening]=useState<string|null>(null),[windowWidth,setWindowWidth]=useState(window.innerWidth),[buildSequence,setBuildSequence]=useState(0),[agentBusy,setAgentBusy]=useState(false),[stale,setStale]=useState(false),[diagnostics,setDiagnostics]=useState<Diagnostic[]>([]),[logTail,setLogTail]=useState(''),[logOpen,setLogOpen]=useState(false),[syncStatus,setSyncStatus]=useState<{direction:'forward'|'inverse';sequence:number}|null>(null),[assetPath,setAssetPath]=useState<string>(),[referencePath,setReferencePath]=useState<string>(),[selection,setSelection]=useState<unknown>(null),[review,setReview]=useState(false),[sourceSelection,setSourceSelection]=useState<SourceSelection|null>(null),[commentSelection,setCommentSelection]=useState<CommentSelection|null>(null),[commentVersion,setCommentVersion]=useState(0),[commentFocus,setCommentFocus]=useState<string>(),[quick,setQuick]=useState(false),[query,setQuery]=useState(''),[quickFiles,setQuickFiles]=useState<{path:string;line?:number;text?:string}[]>([]),[searching,setSearching]=useState(false),[searchCursor,setSearchCursor]=useState<string|undefined>(),[choice,setChoice]=useState<Choice|null>(null),[sshPrompt,setSshPrompt]=useState<SshPrompt|null>(null);
  // Listed files plus TeX files that discovery found inside unexpanded folders (directory evidence).
  const texCandidates=useMemo(()=>{const paths=new Set<string>();for(const entry of allEntries){if(entry.kind!=='directory'&&texPathPattern.test(entry.path))paths.add(entry.path);for(const name of entry.evidence??[])if(texPathPattern.test(name))paths.add(entry.path?`${entry.path}/${name}`:name);}return [...paths].sort((left,right)=>left.localeCompare(right));},[allEntries]);
  const texCandidatesRef=useRef(texCandidates);texCandidatesRef.current=texCandidates;
  const compact=windowWidth/settings.zoom<1100,medium=windowWidth/settings.zoom<1280;
  // Failed builds keep the last good PDF on screen (marked stale); logs open automatically only when there is nothing to show.
  const hasBuiltPdf=useRef(false);hasBuiltPdf.current=manifest!==null;
  useEffect(()=>{const resize=()=>setWindowWidth(window.innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
  useEffect(()=>{if(compact){setInspector(false);setExplorer(false);}},[compact]);
  useEffect(()=>{if(inspector&&medium){setExplorer(false);setSearchPanel(false);}},[inspector,medium]);
  useEffect(()=>{if(compact&&sourceOpening!==null)setSearchPanel(false);},[compact,sourceOpening]);
  // True only for a main document the user chose (or project.json stores); detected roots follow the opened file.
  const rootExplicit=useRef(false);
  useEffect(()=>{if(logOpen)setView(current=>current==='source'?'pdf':current);},[logOpen]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==='Escape')setHelpOpen(false);if(event.ctrlKey&&event.key.toLowerCase()==='o'){event.preventDefault();setPicker(true);}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  const updates=useUpdates(settings.updates);
  const sshPromptRef=useRef(sshPrompt);sshPromptRef.current=sshPrompt;
  const fileOpenSequence=useRef(0),sshInput=useRef<HTMLInputElement>(null),editor=useRef<SourceEditorHandle|null>(null),active=useRef<WorkspaceRef|null>(null),storeRef=useRef<BufferStore|null>(null),projectRef=useRef(project),buildTimer=useRef<number|undefined>(undefined),buildActive=useRef(false),buildRequest=useRef<Promise<BuildResult>|null>(null),pendingBuild=useRef(false),runBuildRef=useRef<()=>Promise<void>>(async()=>{}),sourceVersion=useRef(0),choiceRef=useRef<Choice|null>(null);projectRef.current=project;choiceRef.current=choice;
  const quitInProgress=useRef(false),quitDiscardPaths=useRef<string[]>([]);
  const showError=useCallback((value:unknown)=>setError(normalizeError(value)),[]);
  const workspaceError=useCallback((value:unknown)=>{if(workspace&&active.current?.id===workspace.id&&active.current.epoch===workspace.epoch)showError(value);},[workspace,showError]);
  const choose=useCallback((title:string,message:string,options:Choice['options'])=>new Promise<string>(resolve=>setChoice({title,message,options,resolve})),[]);
  const bump=useCallback(()=>setRefreshKey(value=>value+1),[]);
  const saved=useCallback(()=>{setStale(true);sourceVersion.current++;clearTimeout(buildTimer.current);if(projectRef.current.autoBuild&&!quitInProgress.current)buildTimer.current=window.setTimeout(()=>void runBuildRef.current(),800);},[]);
  const dirty=useCallback(()=>{sourceVersion.current++;setStale(true);setSelection(null);},[]);
  const updateSettings=useCallback((patch:Partial<AppSettings>)=>{setSettings(current=>{const next={...current,...patch};void native('app_settings',{settings:patch}).catch(showError);return next;});},[showError]);
  useEffect(()=>{
    const sync=(event:Event)=>{const patch=(event as CustomEvent<Pick<AppSettings,'ai'|'providerExecutables'>>).detail;setSettings(current=>({...current,...patch}));};
    window.addEventListener('texypaper:ai-settings',sync);
    return()=>window.removeEventListener('texypaper:ai-settings',sync);
  },[]);
  useEffect(()=>{setLocale(settings.locale);applyTheme(settings);const media=matchMedia('(prefers-color-scheme: dark)'),update=()=>applyTheme(settings);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[settings]);
  useEffect(()=>{void getCurrentWindow().setTheme(settings.theme==='system'?null:settings.theme).catch(showError);},[settings.theme,showError]);
  const flush=useCallback(async()=>{try{await storeRef.current?.flush();return true;}catch(error){showError(error);return false;}},[showError]);
  const stopWork=useCallback(async()=>{
    const current=active.current;if(!current)return;
    if(buildActive.current){pendingBuild.current=false;await request('build_cancel',current);await buildRequest.current?.catch(()=>{});}
    await request('agent_cancel',current);
    const commands=await request<{requests:{id:string;status:string}[]}>('command_list',current);
    await Promise.all(commands.requests.filter(command=>command.status==='running').map(command=>request('command_cancel',current,{id:command.id})));
  },[]);
  const guardSwitch=useCallback(async(reason:'switch'|'quit'='switch')=>{
    const currentWorkspace=active.current;
    const runningCommands=reason==='quit'&&currentWorkspace?(await request<{requests:{status:string}[]}>('command_list',currentWorkspace)).requests.some(command=>command.status==='running'):false;
    if(buildActive.current||agentBusy||runningCommands){
      const answer=await choose(reason==='quit'?t('TexyPaper 종료','Exit TexyPaper'):t('진행 중인 작업'),reason==='quit'?t('TexyPaper를 종료하기 전에 실행 중인 빌드, AI 작업과 명령을 중지할까요?','Stop running builds, AI tasks, and commands before exiting TexyPaper?'):t('프로젝트를 바꾸기 전에 실행 중인 빌드와 AI 작업을 중지해야 합니다.'),[{label:reason==='quit'?t('중지하고 종료','Stop and exit'):t('중지하고 계속'),value:'stop'},{label:reason==='quit'?t('취소'):t('현재 프로젝트에 머무르기'),value:'cancel'}]);
      if(answer!=='stop')return false;await stopWork();
    }
    const current=storeRef.current;if(current&&[...current.records.values()].some(buffer=>buffer.dirty)){
      const answer=await choose(t('저장하지 않은 변경'),t('열린 파일의 변경 사항을 어떻게 처리할까요?'),[{label:t('모두 저장'),value:'save'},{label:t('변경 버리기'),value:'discard'},{label:t('취소'),value:'cancel'}]);
      if(answer==='cancel')return false;if(answer==='save'&&!await flush())return false;if(answer==='discard'){const paths=[...current.records.values()].filter(buffer=>buffer.dirty).map(buffer=>buffer.path);if(reason==='quit')quitDiscardPaths.current=paths;for(const path of paths)await request('recovery_clear',current.workspace,{path});current.discard();}
    }clearTimeout(buildTimer.current);pendingBuild.current=false;return true;
  },[agentBusy,choose,flush,stopWork]);
  const open=useCallback(async(environment:Environment,root:string)=>{
    if(quitInProgress.current)return;
    const same=active.current?.environmentId===environment.id&&active.current.root===root;const reconnect=!!(same&&storeRef.current?.disconnected);if(!reconnect&&!await guardSwitch())return;setOpening(true);setError(null);clearTimeout(buildTimer.current);
    try{
      await storeRef.current?.persistRecovery();
      const previous=active.current;if(previous)await native('workspace_close',{workspaceId:previous.id,epoch:previous.epoch});active.current=null;storeRef.current?.dispose();storeRef.current=null;filenameIndex.current=null;setStore(null);setWorkspace(null);setManifest(null);setDisplayedPdf(null);setSelection(null);setSourceSelection(null);setCommentSelection(null);setCommentFocus(undefined);setQuick(false);setQuery('');setQuickFiles([]);setSearchCursor(undefined);setAllEntries([]);setReferencePath(undefined);setAssetPath(undefined);setDiagnostics([]);setLogTail('');setLogOpen(false);setBuilding(false);setBuildPhase('idle');setBuildFailure(null);fileOpenSequence.current++;setSourceOpening(null);
      const opened=await openWorkspace(environment,root);const uiState=await request<{openPaths?:string[];activePath?:string;view?:ViewMode;trash?:TrashRecord[]}>('workspace_state_read',opened);active.current=opened;filenameIndex.current={workspaceId:opened.id,epoch:opened.epoch,entries:new Map()};setTrashRows(uiState.trash??[]);setWorkspace(opened);const buffers=new BufferStore(opened,saved,dirty,environment.kind==='ssh');storeRef.current=buffers;setStore(buffers);
      const latestBuild=await request<BuildResult>('build_status',opened).catch(()=>null);if(latestBuild?.manifest){setManifest(latestBuild.manifest);setBuildPhase('published');}if(latestBuild&&['failed','cancelled','timeout'].includes(latestBuild.status))setBuildPhase(latestBuild.status as BuildPhase);
      const projectSettings=await request<ProjectSettings>('project_read',opened);setProject({...defaultProject,...projectSettings});rootExplicit.current=!!projectSettings.rootTex;
      const first=await request<{entries:Entry[]}>('directory_list',opened,{path:'',showHidden:settings.showHidden});const index=filenameIndex.current;if(index?.workspaceId===opened.id&&index.epoch===opened.epoch&&upsertEntries(index.entries,first.entries))setAllEntries(Array.from(index.entries.values()));
      const rootTex=await findRoot(opened,undefined,projectSettings.rootTex,!!projectSettings.rootTex,first.entries.filter(entry=>entry.kind==='file').map(entry=>entry.path));if(rootTex){setProject(current=>({...current,rootTex}));await buffers.open(rootTex);}
      for(const path of (uiState.openPaths??[]).slice(0,8))if(!buffers.records.has(path))await buffers.open(path).catch(showError);if(uiState.activePath&&buffers.records.has(uiState.activePath))await buffers.open(uiState.activePath);if(uiState.view&&['source','pdf','split'].includes(uiState.view))setView(uiState.view);
      const recovered=await request<{documents:{path:string;text:string;baseSha256:string}[]}>('recovery_read',opened,{});for(const document of recovered.documents??[])if(!buffers.records.has(document.path))await buffers.open(document.path);
      const next=[{environmentId:environment.id,root:opened.root},...recents.filter(item=>item.root!==opened.root||item.environmentId!==environment.id)].slice(0,20);setRecents(next);updateSettings({recents:next,environments});setPicker(false);setStale(latestBuild?.stale??false);setRefreshKey(value=>value+1);
    }catch(error){showError(error);throw error;}finally{setOpening(false);}
  },[guardSwitch,saved,dirty,settings.showHidden,recents,environments,updateSettings,showError]);
  // Nested menu actions use this ref: directly capturing open links memoized render scopes and retains old editor states.
  const openRef=useRef(open);openRef.current=open;
  useEffect(()=>{let alive=true;void native<Bootstrap>('app_bootstrap').then(data=>{if(!alive)return;setBootstrap(data);setSettings({...defaultSettings,...data.settings});const available=data.environments?.length?data.environments:[localEnvironment];if(!available.some(environment=>environment.kind==='local'))available.unshift(localEnvironment);setEnvironments(available);setRecents(data.recents??[]);if(data.openPath)void openRef.current(available.find(environment=>environment.kind==='local')!,data.openPath).catch(()=>{});}).catch(showError);return()=>{alive=false;};},[showError]);
  useEffect(()=>{const unlisten=listen<SshPrompt>('texypaper:ssh-prompt',event=>{setSshPrompt(event.payload);if(sshInput.current)sshInput.current.value='';});return()=>{void unlisten.then(dispose=>dispose());};},[]);
  const quit=useCallback(async()=>{
    if(quitInProgress.current||choiceRef.current||opening)return;
    quitInProgress.current=true;quitDiscardPaths.current=[];
    try{
      if(!await guardSwitch('quit'))return;
      setOpening(true);clearTimeout(buildTimer.current);pendingBuild.current=false;
      await stopWork();await storeRef.current?.persistRecovery();
      const current=active.current;
      await native('app_quit',{workspaceId:current?.id??null,epoch:current?.epoch??null,discardPaths:quitDiscardPaths.current});
    }catch(error){showError(error);}finally{quitInProgress.current=false;setOpening(false);}
  },[guardSwitch,opening,stopWork,showError]);
  const quitRef=useRef(quit);quitRef.current=quit;
  useEffect(()=>{const unlisten=getCurrentWindow().listen('texypaper:quit-requested',()=>void quitRef.current());return()=>{void unlisten.then(dispose=>dispose());};},[]);
  useEffect(()=>{if(!workspace||!store)return;let polling=true,pollTimer:number|undefined;const tick=async()=>{await store.poll();if(polling)pollTimer=window.setTimeout(()=>void tick(),document.hidden?15000:2000);};pollTimer=window.setTimeout(()=>void tick(),2000);const focus=()=>void store.poll();window.addEventListener('focus',focus);const unlisten=workspaceEvents(workspace,event=>{
    if(active.current?.id!==workspace.id||active.current.epoch!==workspace.epoch)return;
    if(event.kind==='build/published'){const envelope=event.payload as {result?:BuildResult;manifest?:BuildManifest}&BuildManifest;const next=envelope.result?.manifest??envelope.manifest??(envelope.buildId?envelope:undefined);if(next){setManifest(next);setBuildPhase('published');setBuildFailure(null);setLogOpen(false);recheckStale(workspace);}setBuilding(false);}
    if(['build/failed','build/cancelled','build/timeout'].includes(event.kind)){const phase=event.kind.slice(6) as 'failed'|'cancelled'|'timeout',payload=event.payload as {result?:BuildResult};setBuildPhase(phase);setBuilding(false);setStale(true);if(payload.result?.diagnostics)setDiagnostics(payload.result.diagnostics);if(payload.result?.logTail)setLogTail(payload.result.logTail.slice(-262144));setBuildFailure({code:phase==='timeout'?'BUILD_TIMEOUT':phase==='cancelled'?'BUILD_CANCELLED':'BUILD_FAILED',message:t('빌드를 완료하지 못했습니다. 진단과 로그를 확인하세요.','The build did not complete. Check diagnostics and the log.'),retryable:true});setLogOpen(open=>open||!hasBuiltPdf.current);}
    if(event.kind==='file/changed'||event.kind==='workspace/changed'){void store.poll();bump();}
    if(event.kind==='ssh/disconnected'){store.disconnected=true;setError({code:'SSH_DISCONNECTED',message:t('SSH 연결이 끊겼습니다. 편집 내용과 마지막 PDF는 유지됩니다. 다시 연결한 뒤 변경 내용을 확인하세요.'),retryable:true});setStale(true);}
  });return()=>{polling=false;clearTimeout(pollTimer);window.removeEventListener('focus',focus);void unlisten.then(dispose=>dispose());};},[workspace,store,bump]);
  // Open buffers can lag behind disk (an applied proposal is reloaded by the next poll), so staleness is decided by
  // the native snapshot, which compares the published manifest with current files; unsaved buffers stay stale.
  // A source event during the check means the answer may be outdated, so ask again (bounded).
  const recheckStale=useCallback((current:WorkspaceRef)=>{
    void (async()=>{for(let attempt=0;attempt<6;attempt++){
      const observed=sourceVersion.current;
      const status=await request<{stale?:boolean}>('build_status',current).catch(()=>null);
      if(!status||active.current?.id!==current.id||active.current.epoch!==current.epoch)return;
      if(sourceVersion.current===observed){setStale(!!status.stale||[...(storeRef.current?.records.values()??[])].some(buffer=>buffer.dirty));return;}
      const delay=Promise.withResolvers<void>();setTimeout(delay.resolve,300);await delay.promise;
    }})();
  },[]);
  const settleStale=useCallback((current:WorkspaceRef,version:number)=>{
    if(sourceVersion.current===version){setStale(false);return;}
    setStale(true);recheckStale(current);
  },[recheckStale]);
  const runBuild=useCallback(async()=>{
    if(quitInProgress.current)return;
    const current=active.current;if(!current)return;
    if(!projectRef.current.rootTex){
      // No main document yet: resolve it from the file being edited, like Overleaf compiling the open project.
      const buffers=storeRef.current,path=buffers?.activePath??undefined,buffer=path?buffers?.records.get(path):undefined;
      const rootTex=await findRoot(current,path,null,false,[...texCandidatesRef.current,...(filenameIndex.current?.entries.keys()??[])],buffer&&buffers?buffers.text(buffer):undefined).catch(()=>null);
      if(active.current?.id!==current.id||active.current.epoch!==current.epoch)return;
      if(!rootTex){setError({code:'ROOT_TEX_REQUIRED',message:t('컴파일할 주 문서를 찾지 못했습니다.'),retryable:true});return;}
      projectRef.current={...projectRef.current,rootTex};setProject(value=>({...value,rootTex}));
    }
    if(buildActive.current){pendingBuild.current=true;setBuildPhase('queued');return;}if(!await flush())return;
    // Saves made by this flush (and any earlier autosave) are part of this build; don't queue a duplicate one.
    clearTimeout(buildTimer.current);
    buildActive.current=true;setBuilding(true);setBuildPhase('building');setBuildFailure(null);setError(null);const version=sourceVersion.current;const epoch=current.epoch;
    try{
      const operation=request<BuildResult>('build_start',current,{...projectRef.current,rootTex:projectRef.current.rootTex});buildRequest.current=operation;const result=await operation;
      if(active.current?.id!==current.id||active.current.epoch!==epoch)return;
      if(result.manifest){setBuildPhase('published');setManifest(result.manifest);setLogOpen(false);setReferencePath(path=>path);setSelection(null);settleStale(current,version);}
      if(result.status==='failed'||result.status==='cancelled'||result.status==='timeout'){setBuildPhase(result.status);setBuildFailure({code:result.status==='timeout'?'BUILD_TIMEOUT':result.status==='cancelled'?'BUILD_CANCELLED':'BUILD_FAILED',message:t('빌드를 완료하지 못했습니다. 진단과 로그를 확인하세요.','The build did not complete. Check diagnostics and the log.'),retryable:true});setStale(true);setError({code:result.status==='timeout'?'BUILD_TIMEOUT':result.status==='cancelled'?'BUILD_CANCELLED':'BUILD_FAILED',message:t('빌드를 완료하지 못했습니다. 진단과 로그를 확인하세요.','The build did not complete. Check diagnostics and the log.'),retryable:true});setLogOpen(open=>open||!hasBuiltPdf.current);}
      if(result.diagnostics)setDiagnostics(result.diagnostics);if(result.logTail)setLogTail(result.logTail.slice(-262144));
    }catch(error){const failure=normalizeError(error);setBuildFailure(failure);setBuildPhase(failure.code.includes('TIMEOUT')?'timeout':failure.code.includes('CANCEL')?'cancelled':'failed');showError(failure);setStale(true);setLogOpen(open=>open||!hasBuiltPdf.current);}finally{buildRequest.current=null;buildActive.current=false;if(active.current?.id===current.id&&active.current.epoch===epoch){setBuilding(false);setBuildSequence(value=>value+1);}if(pendingBuild.current){pendingBuild.current=false;void runBuildRef.current();}}
  },[flush,showError]);runBuildRef.current=runBuild;
  // Ctrl+S saves and recompiles, like Overleaf (unless "build after save" is turned off).
  const saveAndBuild=useCallback(()=>{void flush().then(ok=>{if(ok&&projectRef.current.autoBuild)void runBuildRef.current();});},[flush]);
  const cancelBuild=useCallback(()=>{const current=active.current;if(current){pendingBuild.current=false;void request('build_cancel',current).catch(showError);}},[showError]);
  const updateProject=useCallback(async(patch:Partial<ProjectSettings>)=>{if(!workspace)return;let next={...projectRef.current,...patch};if(next.profile==='project'&&projectRef.current.profile!=='project'){
    const consent=await choose(t('프로젝트 빌드 신뢰'),t('프로젝트 모드는 latexmk 설정 파일과 그 안의 명령을 실행할 수 있습니다. 신뢰하는 프로젝트에서만 허용하세요.'),[{label:t('이 프로젝트 신뢰'),value:'trust'},{label:t('기본 모드 유지'),value:'cancel'}]);if(consent!=='trust')return;
    await request('project_trust',workspace,{trusted:true});
  }try{next=await request<ProjectSettings>('project_update',workspace,{settings:next});if('rootTex'in patch)rootExplicit.current=!!next.rootTex;setProject(next);}catch(error){showError(error);}},[workspace,choose,showError]);
  const openFile=useCallback(async(path:string,line?:number)=>{
    const buffers=storeRef.current,current=active.current;if(!buffers||!current)return;const requestId=++fileOpenSequence.current;setError(null);
    setSourceOpening(null);setAssetPath(undefined);if(/\.pdf$/i.test(path)){setReferencePath(path);setView('pdf');setSelection(null);return;}if(/\.(png|jpe?g|webp|svg|zip|gz|tar|exe|dll|so|woff2?|ttf|otf|mp4|bin)$/i.test(path)){setAssetPath(path);setView('source');return;}
    setSourceOpening(path);if(compact)setExplorer(false);
    try{await buffers.open(path);if(requestId!==fileOpenSequence.current||active.current?.id!==current.id||active.current.epoch!==current.epoch)return;if(/\.(tex|ltx)$/i.test(path)){const record=buffers.records.get(path);const root=await findRoot(current,path,projectRef.current.rootTex,rootExplicit.current,[...texCandidatesRef.current,...(filenameIndex.current?.entries.keys()??[])],record?buffers.text(record):undefined);if(requestId===fileOpenSequence.current&&root&&root!==projectRef.current.rootTex)setProject(value=>({...value,rootTex:root}));}setView(value=>value==='pdf'?'source':value);if(line)requestAnimationFrame(()=>editor.current?.navigate(line));}catch(error){if(requestId!==fileOpenSequence.current||active.current?.id!==current.id||active.current.epoch!==current.epoch)return;const value=normalizeError(error);if(['BINARY_FILE','ENCODING_UNSUPPORTED','NOT_TEXT'].includes(value.code)){setAssetPath(path);setView('source');}else showError(value);}finally{if(requestId===fileOpenSequence.current)setSourceOpening(null);}
  },[showError,compact]);
  const fileMutation=useCallback((change:FileMutation)=>{
    if(!workspace||active.current?.id!==workspace.id||active.current.epoch!==workspace.epoch)return;
    const buffers=storeRef.current,index=filenameIndex.current;if(!buffers||index?.workspaceId!==workspace.id||index.epoch!==workspace.epoch)return;
    if(change.kind==='trash'&&change.transactionId)setTrashRows(rows=>[{path:change.path,transactionId:change.transactionId!},...rows].slice(0,100));
    if(change.kind==='restore')setTrashRows(rows=>rows.filter(row=>row.transactionId!==change.transactionId));
    if(change.kind==='rename'&&change.newPath){
      buffers.rename(change.path,change.newPath);
      const renamed=new Map<string,Entry>();
      for(const entry of index.entries.values()){
        const next=entry.path===change.path||entry.path.startsWith(`${change.path}/`)?{...entry,path:change.newPath+entry.path.slice(change.path.length),name:entry.path===change.path?change.newPath.split('/').at(-1)!:entry.name}:entry;
        renamed.set(next.path,next);
      }
      index.entries=renamed;setAllEntries(Array.from(renamed.values()));
      if(projectRef.current.rootTex&&(projectRef.current.rootTex===change.path||projectRef.current.rootTex.startsWith(`${change.path}/`)))void updateProject({rootTex:change.newPath+projectRef.current.rootTex.slice(change.path.length)});
    }else if(change.kind==='trash'){
      for(const path of [...buffers.records.keys()])if(path===change.path||path.startsWith(`${change.path}/`))buffers.close(path);
      let changed=false;
      for(const path of index.entries.keys())if(path===change.path||path.startsWith(`${change.path}/`)){index.entries.delete(path);changed=true;}
      if(changed)setAllEntries(Array.from(index.entries.values()));
      if(projectRef.current.rootTex===change.path||projectRef.current.rootTex?.startsWith(`${change.path}/`))void updateProject({rootTex:null});
    }
    bump();
  },[bump,updateProject,workspace]);
  const entriesChanged=useCallback((entries:Entry[])=>{
    const scope=workspace,index=filenameIndex.current;
    if(!scope||active.current?.id!==scope.id||active.current.epoch!==scope.epoch||index?.workspaceId!==scope.id||index.epoch!==scope.epoch)return;
    if(upsertEntries(index.entries,entries))setAllEntries(Array.from(index.entries.values()));
  },[workspace]);
  const addComment=useCallback(async(fromPdf=false)=>{
    const workspaceSnapshot=active.current;if(!workspaceSnapshot)return;
    const sourceSnapshot=fromPdf?null:editor.current?.selection()??null;
    const sourceVersionSnapshot=sourceSnapshot?storeRef.current?.records.get(sourceSnapshot.path)?.version:undefined;
    if(!fromPdf&&!await flush())return;
    if(active.current?.id!==workspaceSnapshot.id||active.current.epoch!==workspaceSnapshot.epoch)return;
    let attached:CommentSelection|null=null;
    if(fromPdf&&selection){const value=selection as {buildId:string;pdfSha256:string;quote:string;pageSelections:{page:number;rects:number[][]}[]};const page=value.pageSelections[0];if(page)attached={pdf:{buildId:value.buildId,pdfSha256:value.pdfSha256,page:page.page,rects:page.rects,quote:value.quote}};}
    else if(sourceSnapshot){
      const buffer=storeRef.current?.records.get(sourceSnapshot.path);
      if(!buffer||buffer.version!==sourceVersionSnapshot){showError({code:'SOURCE_SELECTION_CHANGED',message:t('댓글을 준비하는 동안 소스가 변경되었습니다. 범위를 다시 선택하세요.','The source changed while preparing the comment. Select the range again.'),retryable:true});return;}
      attached={source:{...sourceSnapshot,baseSha256:buffer.document.revision.sha256}};
    }
    setCommentSelection(attached);setCommentVersion(value=>value+1);setTab('comments');setInspector(true);if(compact)setExplorer(false);setSelection(null);
  },[selection,flush,compact,showError]);
  const navigateComment=useCallback((thread:CommentThread)=>{if(thread.source){const anchor=thread.source;void openFile(anchor.path).then(()=>{const buffer=storeRef.current?.records.get(anchor.path);if(buffer){const line=storeRef.current!.text(buffer).slice(0,byteToUtf16(storeRef.current!.text(buffer),Math.max(0,anchor.startByte-(buffer.document.encoding==='utf8Bom'?3:0)))).split(/\r\n|\n/).length;editor.current?.navigate(line);if(manifest&&active.current){void request('sync_forward',active.current,{buildId:manifest.buildId,file:anchor.path,line1:line}).then(result=>{window.dispatchEvent(new CustomEvent('texypaper:sync-forward',{detail:result}));}).catch(showError);}}});}else if(thread.pdf){if(displayedPdf?.pdfSha256===thread.pdf.pdfSha256){setView('pdf');}else if(manifest?.pdfSha256===thread.pdf.pdfSha256){setReferencePath(undefined);setView('pdf');}else showError({code:'COMMENT_UNPLACED',message:t('이 댓글은 다른 PDF 버전에 연결되어 있습니다. 현재 선택에 다시 연결하세요.'),retryable:false});}},[openFile,manifest,displayedPdf,showError]);
  useEffect(()=>{const keydown=(event:KeyboardEvent)=>{
    if(event.key==='Escape'){if(sshPromptRef.current){const id=sshPromptRef.current.id;if(sshInput.current)sshInput.current.value='';setSshPrompt(null);void native('ssh_prompt_answer',{id,answer:null}).catch(showError);return;}if(choiceRef.current){const current=choiceRef.current;setChoice(null);current.resolve('cancel');return;}setQuick(false);setSettingsOpen(false);setTrashOpen(false);setSelection(null);setReview(false);if(picker)setPicker(false);return;}
    if(!event.ctrlKey)return;
    if(event.key.toLowerCase()==='s'){event.preventDefault();saveAndBuild();}
    if(event.key.toLowerCase()==='p'){event.preventDefault();setQuick(true);setQuery('');}
    if(event.shiftKey&&event.key.toLowerCase()==='b'){event.preventDefault();void runBuildRef.current();}
    if(event.altKey&&event.key.toLowerCase()==='j'){event.preventDefault();const current=active.current,path=storeRef.current?.activePath;if(current&&path&&manifest){const line=editor.current?.position().line1??1;void request('sync_forward',current,{buildId:manifest.buildId,file:path,line1:line}).then(result=>{setView('pdf');setSyncStatus(value=>({direction:'forward',sequence:(value?.sequence??0)+1}));window.dispatchEvent(new CustomEvent('texypaper:sync-forward',{detail:result}));}).catch(showError);}}
  };
    // Own this shortcut before CodeMirror's alphabetic modifier fallback can run Mod-a.
    const commentShortcut=(event:KeyboardEvent)=>{if(event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==='a'){event.preventDefault();event.stopPropagation();void addComment(false);}};
    window.addEventListener('keydown',commentShortcut,true);window.addEventListener('keydown',keydown);
    return()=>{window.removeEventListener('keydown',commentShortcut,true);window.removeEventListener('keydown',keydown);};
  },[flush,addComment,manifest,picker,showError,saveAndBuild]);
  useEffect(()=>{
    if(!quick||!workspace)return;
    let cancelled=false;setSearching(true);
    const timer=setTimeout(()=>{
      if(query.startsWith('>')){
        void request<{matches:{path:string;line:number;text:string}[];nextCursor?:string}>('project_search',workspace,{query:query.slice(1),limit:200}).then(result=>{if(!cancelled){setQuickFiles(result.matches);setSearchCursor(result.nextCursor);}}).catch(showError).finally(()=>{if(!cancelled)setSearching(false);});
      }else{
        const foldedQuery=query.toLocaleLowerCase(),matches:Entry[]=[];
        for(const entry of allEntries){
          if(entry.kind==='directory'||!entry.path.toLocaleLowerCase().includes(foldedQuery))continue;
          matches.push(entry);if(matches.length===200)break;
        }
        setSearchCursor(undefined);setQuickFiles(matches);setSearching(false);
      }
    },180);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[query,quick,workspace,allEntries,showError]);
  useEffect(()=>{if(!quick||!workspace)return;let cancelled=false;void(async()=>{let examined=0;while(!cancelled&&!document.hidden&&examined<20000){const batch=await request<{entries:Entry[];complete:boolean;scanned:number;paused?:boolean}>('scan_step',workspace,{limit:256});if(cancelled)break;entriesChanged(batch.entries);examined+=Math.max(1,batch.scanned);if(batch.complete||batch.paused||batch.scanned===0)break;await new Promise<void>(resolve=>setTimeout(resolve,250));}})().catch(showError);return()=>{cancelled=true;};},[quick,workspace,entriesChanged,showError]);
  const [compare,setCompare]=useState(false);const bufferVersion=useSyncExternalStore(store?.subscribe??(()=>()=>{}),store?.snapshot??(()=>0));
  const savedUiSignature=useRef('');useEffect(()=>{if(!store)return;const state={openPaths:[...store.records.keys()],activePath:store.activePath,view,trash:trashRows};const signature=`${store.workspace.id}:${store.workspace.epoch}:${JSON.stringify(state)}`;if(signature===savedUiSignature.current)return;savedUiSignature.current=signature;void request('workspace_state_write',store.workspace,{state}).catch(showError);},[store,bufferVersion,view,trashRows,showError]);
  const currentBuffer=store?.activePath?store.records.get(store.activePath):undefined;
  // An open .tex file is enough to compile: the main document is resolved from it on demand.
  const canBuild=!!project.rootTex||/\.(tex|ltx)$/i.test(store?.activePath??'');
  useEffect(()=>{const trap=(event:KeyboardEvent)=>{const dialogs=document.querySelectorAll<HTMLElement>('[aria-modal="true"]');const dialog=dialogs.item(dialogs.length-1);if(!dialog)return;if(event.key==='Tab'){const elements=[...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(element=>element.getClientRects().length);if(!elements.length)return;const first=elements[0],last=elements[elements.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}};document.addEventListener('keydown',trap);return()=>document.removeEventListener('keydown',trap);},[]);
  useEffect(()=>{const openComment=(event:Event)=>{const detail=(event as CustomEvent<{threadId:string}>).detail;if(!detail?.threadId)return;setCommentFocus(detail.threadId);setTab('comments');setInspector(true);};window.addEventListener('texypaper:comment-open',openComment);return()=>window.removeEventListener('texypaper:comment-open',openComment);},[]);
  useEffect(()=>{const dialogs=document.querySelectorAll<HTMLElement>('[aria-modal="true"]'),dialog=dialogs.item(dialogs.length-1),previous=document.activeElement as HTMLElement|null;if(!dialog)return;if(!dialog.contains(document.activeElement))dialog.querySelector<HTMLElement>('input,select,textarea,button')?.focus();return()=>{if(previous?.isConnected)previous.focus();};},[settingsOpen,picker,quick,choice,sshPrompt,compare,review,trashOpen,helpOpen]);
  useEffect(()=>{const identity=(event:Event)=>{const value=(event as CustomEvent<DisplayedPdf&{closed?:boolean}>).detail;const current=active.current;if(!current||value?.workspaceId!==current.id||value.epoch!==current.epoch)return;setDisplayedPdf(value.closed?null:value);};window.addEventListener('texypaper:pdf-identity',identity);return()=>window.removeEventListener('texypaper:pdf-identity',identity);},[]);
  const nativeAnswer=async(answer:string|null)=>{if(!sshPrompt)return;if(sshInput.current)sshInput.current.value='';const id=sshPrompt.id;setSshPrompt(null);await native('ssh_prompt_answer',{id,answer});if(sshInput.current)sshInput.current.value='';};
  const onChanged=useCallback((paths:string[])=>{if(!workspace||active.current?.id!==workspace.id||active.current.epoch!==workspace.epoch)return;bump();void storeRef.current?.poll();if(paths.length){setStale(true);sourceVersion.current++;setSelection(null);}},[bump,workspace]);
  const showPanel=(panel:'files'|'search'|'ai'|'comments')=>{
    if(panel==='files'||panel==='search'){
      const isCurrent=panel==='files'?explorer&&!searchPanel:searchPanel;
      setExplorer(panel==='files'&&!isCurrent);setSearchPanel(panel==='search'&&!isCurrent);
      if(compact)setInspector(false);
      return;
    }
    if(panel==='ai'&&chatDetached){window.dispatchEvent(new Event('texypaper:chat-focus'));return;}
    setInspector(value=>!(value&&tab===panel));setTab(panel);
    if(medium){setExplorer(false);setSearchPanel(false);}
  };
  const createItem=async(kind:'file'|'directory')=>{if(!workspace||!await flush())return;const parent=currentBuffer?.path.split('/').slice(0,-1).join('/');const path=window.prompt(kind==='file'?t('새 파일 경로'):t('새 폴더 경로'),parent?`${parent}/`:'');if(!path)return;try{await request('file_create',workspace,{path,kind,content:''});fileMutation({kind:'create',path});if(kind==='file')await openFile(path);}catch(error){showError(error);}};
  const logsPanel=<section className="diagnostics" aria-label={t("빌드 진단")}><div className="pane-heading"><strong>{t('로그 및 출력','Logs and output')}</strong><button aria-label={t('빌드 진단 닫기','Close build diagnostics')} onClick={()=>setLogOpen(false)}>{t('PDF로 돌아가기','Back to PDF')}</button></div>{buildFailure&&<p className="diagnostic-failure" role="status"><strong>{buildFailure.code}</strong> {errorText(buildFailure)}</p>}{diagnostics.map((diagnostic,index)=><button key={index} disabled={!diagnostic.path} onClick={()=>diagnostic.path&&void openFile(diagnostic.path,diagnostic.line)}>{diagnostic.severity==='error'?t('오류'):diagnostic.severity==='warning'?t('경고'):t('정보')} · {diagnostic.path??''}{diagnostic.line?`:${diagnostic.line}`:''}{diagnostic.inferred?t(' (추정 위치)'):''} {diagnostic.message}</button>)}<pre tabIndex={0} aria-label={t('원본 빌드 로그','Raw build log')}>{logTail||t('이 세션에서 받은 빌드 로그가 없습니다.')}</pre></section>;
  const buildControls=<><div className="recompile-split"><button className="primary" disabled={!canBuild||building} onClick={()=>void runBuild()} title="Ctrl+Shift+B"><Icon name="play" size={14}/>{building?t('컴파일 중'):t('다시 컴파일','Recompile')}</button><AppMenu label={<><Icon name="chevronDown" size={14}/><span className="sr-only">{t('컴파일 옵션','Compile options')}</span></>}><label className="compile-root-label">{t('주 문서')}<select aria-label={t('컴파일 주 문서','Compile main document')} value={project.rootTex??''} onChange={event=>void updateProject({rootTex:event.target.value||null})}><option value="">{t('주 문서 선택')}</option>{[...new Set([...texCandidates,...(project.rootTex?[project.rootTex]:[])])].map(path=><option key={path} value={path}>{path}</option>)}</select></label><button role="menuitem" disabled={!building} onClick={cancelBuild}><Icon name="stop" size={14}/>{t('빌드 중지')}</button><button role="menuitem" onClick={()=>setSettingsOpen(true)}>{t('엔진 및 빌드 신뢰 설정','Engine and build trust settings')}</button></AppMenu></div><button className="icon-button logs-toggle" aria-label={t('로그 및 출력','Logs and output')} aria-pressed={logOpen} title={t('로그 및 출력','Logs and output')} onClick={()=>setLogOpen(value=>!value)}><Icon name="logs"/><span className="diagnostic-count">{diagnostics.filter(value=>value.severity==='error'||value.severity==='warning').length}</span></button></>;
  const sideOpen=explorer||searchPanel;
  const rightOpen=inspector&&(tab==='comments'||!chatDetached);
  const inspectorWidth=Math.max(360,Math.min(720,settings.inspectorWidth));
  const shellStyle={'--ui-scale':settings.zoom,'--explorer-width':`${settings.explorerWidth}px`,'--inspector-width':`${inspectorWidth}px`,'--source-fraction':`${sourceFraction}%`} as CSSProperties;
  return <div className={`app-shell ${compact?'compact-layout':''} ${medium?'medium-layout':''}`} style={shellStyle}>
    {!workspace?<div className="project-dashboard"><header className="dashboard-appbar"><div className="product-mark"><img className="product-icon" src={productIcon} width={24} height={24} alt=""/><strong>TexyPaper</strong><span>{t('논문 작업 공간')}</span></div><button data-testid="settings-button" aria-label={t('설정')} onClick={()=>setSettingsOpen(true)}><Icon name="settings" size={17}/><span>Language / 언어 · {t('테마')}</span></button></header><main className="welcome">{bootstrap?<WorkspacePicker dashboard environments={environments} recents={recents} busy={opening} onOpen={open} onEnvironments={value=>{setEnvironments(value);updateSettings({environments:value});}}/>:<p role="status">{t("작업 공간 준비 중…")}</p>}{error&&<div className="inline-error" role="alert"><strong>{error.code}</strong><p>{errorText(error)}</p><button onClick={()=>location.reload()}>{t("다시 시도")}</button></div>}</main></div>:<>
      <Toolbar workspace={workspace} compact={compact} buildPhase={buildPhase} connection={store?.disconnected?'disconnected':environments.find(value=>value.id===workspace.environmentId)?.kind==='ssh'?'connected':'local'} environmentLabel={environments.find(environment=>environment.id===workspace.environmentId)?.label??workspace.environmentId} rootTex={project.rootTex} canBuild={canBuild} candidates={texCandidates} building={building} stale={stale} view={view} onProject={()=>setPicker(true)} onRoot={path=>void updateProject({rootTex:path||null})} onBuild={()=>void runBuild()} onCancel={cancelBuild} onView={setView} onExplorer={()=>showPanel('files')} onInspector={()=>showPanel('ai')} onSettings={()=>setSettingsOpen(true)} onSave={saveAndBuild} onNewFile={()=>void createItem('file')} onNewFolder={()=>void createItem('directory')} onQuickOpen={()=>setQuick(true)} onEdit={command=>{setView(current=>current==='pdf'?'source':current);requestAnimationFrame(()=>editor.current?.command(command));}} onHelp={()=>setHelpOpen(true)} recentProjects={recents.filter(recent=>recent.root!==workspace.root||recent.environmentId!==workspace.environmentId).slice(0,5).flatMap(recent=>{const environment=environments.find(value=>value.id===recent.environmentId);return environment?[{label:recent.label??recent.root.split(/[\\/]/).at(-1)??recent.root,onOpen:()=>void openRef.current(environment,recent.root).catch(()=>{})}]:[];})}/>
      {error&&<div className="global-notice" role="alert"><div><strong>{error.code}</strong> {errorText(error)}</div><div className="button-row">{error.code==='PDF_STALE'&&<button onClick={()=>void runBuild()}>{t('다시 빌드')}</button>}{error.code==='SSH_DISCONNECTED'&&<button onClick={()=>{setPicker(true);}}>{t("다시 연결")}</button>}{error.code==='LARGE_FILE'&&currentBuffer&&<><button onClick={()=>{if(window.confirm(t('큰 파일을 편집하면 메모리 사용량이 늘어납니다. 허용할까요?')))void store?.allowLarge(currentBuffer.path).then(()=>setError(null)).catch(showError);}}>{t("이 파일 편집 허용")}</button><button onClick={()=>void request('open_external',workspace,{path:currentBuffer.path}).catch(showError)}>{environments.find(value=>value.id===workspace.environmentId)?.kind==='ssh'?t('다운로드한 복사본으로 외부에서 열기','Open a downloaded copy externally'):t("외부에서 열기")}</button></>}{error.code==='ENCODING_UNSUPPORTED'&&currentBuffer&&<button onClick={()=>{const path=window.prompt(t('변환한 UTF-8 복사본 경로'),`${currentBuffer.path}.utf8.tex`);if(path&&window.confirm(t('UTF-8로 읽을 수 없는 바이트는 대체 문자로 변환됩니다. 원본은 바꾸지 않습니다. 계속할까요?','Undecodable bytes will become replacement characters. The original stays unchanged. Continue?')))void store?.saveCopy(currentBuffer.path,path).catch(showError);}}>{t("변환한 복사본 저장")}</button>}<button aria-label={t("알림 닫기")} onClick={()=>setError(null)}>×</button></div></div>}
      <div className={`workbench ${sideOpen?'explorer-open':''} ${rightOpen?'inspector-open':''} view-${view}`}>
        <nav className="activity-rail" aria-label={t('작업 도구','Workspace tools')}><div className="rail-top">{([{panel:'files',name:'files',label:t('탐색기 표시')},{panel:'search',name:'search',label:t('프로젝트 검색','Project search')},{panel:'comments',name:'comments',label:t('댓글')},{panel:'ai',name:'ai',label:t('AI 도우미')}] as const).map(item=><button className="rail-button" key={item.panel} title={item.label} aria-label={item.panel==='ai'?t('AI 및 댓글 패널'):item.label} aria-pressed={item.panel==='files'?explorer&&!searchPanel:item.panel==='search'?searchPanel:item.panel==='ai'&&chatDetached||rightOpen&&tab===item.panel} onClick={()=>showPanel(item.panel)}><Icon name={item.name as IconName}/><span className="sr-only">{item.label}</span></button>)}</div><div className="rail-bottom"><button className="rail-button" title={t('도움말','Help')} aria-label={t('도움말','Help')} onClick={()=>setHelpOpen(true)}><Icon name="help"/></button><button className="rail-button" title={t('설정')} aria-label={t('설정')} data-testid="settings-button" onClick={()=>setSettingsOpen(true)}><Icon name="settings"/></button></div></nav>
        <aside className="explorer" hidden={!sideOpen}><div className="files-panel" hidden={!explorer||searchPanel}><FileTree key={`${workspace.id}:${workspace.epoch}`} workspace={workspace} mainPath={project.rootTex} selectedPath={store?.activePath} showHidden={settings.showHidden} refreshKey={refreshKey} onOpen={path=>void openFile(path)} onMain={path=>void updateProject({rootTex:path})} onEntries={entriesChanged} onError={workspaceError} beforeMutation={flush} onMutation={fileMutation}/>{store&&<FileOutline store={store} onNavigate={line=>{setView(current=>current==='pdf'?'source':current);requestAnimationFrame(()=>editor.current?.navigate(line));}}/>}</div>{searchPanel&&<ProjectSearch workspace={workspace} onOpen={(path,line)=>void openFile(path,line)} onError={workspaceError} onClose={()=>setSearchPanel(false)}/>}</aside>{sideOpen&&<div className="sidebar-divider"><Splitter label={t('탐색기 너비')} min={180} max={340} value={settings.explorerWidth} onChange={width=>setSettings(current=>({...current,explorerWidth:width}))} onCommit={width=>updateSettings({explorerWidth:width})}/><button className="pane-collapse" aria-label={t('사이드 패널 접기','Collapse side panel')} onClick={()=>{setExplorer(false);setSearchPanel(false);}}><Icon name="chevronLeft" size={12}/></button></div>}
        <main className="center-panes"><section className="source-pane" aria-label={t("소스")}><div className="file-tabs" role="tablist" aria-label={t("열린 파일")}>{store&&[...store.records.values()].map(buffer=><div key={buffer.path} className={store.activePath===buffer.path?'active':''}><button role="tab" aria-selected={store.activePath===buffer.path} onClick={()=>void openFile(buffer.path)} title={buffer.path}>{buffer.path.split('/').at(-1)}{buffer.dirty?' ●':''}</button><button aria-label={t(`${buffer.path} 닫기`)} onClick={()=>void(async()=>{if(buffer.dirty){const answer=await choose(t('파일 닫기'),buffer.path,[{label:t('저장'),value:'save'},{label:t('버리기'),value:'discard'},{label:t('취소'),value:'cancel'}]);if(answer==='cancel')return;if(answer==='save'){try{await store.save(buffer.path);}catch(error){showError(error);return;}}else{await request('recovery_clear',workspace,{path:buffer.path});buffer.dirty=false;}}store.close(buffer.path);})()}>×</button></div>)}</div>
          {currentBuffer?.warning&&<div className="inline-error" role="alert"><strong>{t('소스 저장 완료 · 댓글 갱신 경고','Source saved · comment refresh warning')}</strong><p>{errorText(currentBuffer.warning)}</p><button onClick={()=>{setTab('comments');setInspector(true);}}>{t('댓글 확인','Review comments')}</button></div>}{currentBuffer?.error&&<div className="inline-error" role="alert"><strong>{currentBuffer.error.code}</strong><p>{errorText(currentBuffer.error)}</p><div className="button-row">{store?.disconnected&&<button onClick={()=>setPicker(true)}>{t('다시 연결')}</button>}<button onClick={()=>setCompare(true)}>{t("비교")}</button><button data-testid="file-reload" onClick={()=>{if(window.confirm(t('현재 변경을 버리고 디스크 파일을 불러올까요?')))void store?.reload(currentBuffer.path).catch(showError);}}>{t("다시 불러오기")}</button><button onClick={()=>{const path=window.prompt(t('복사본 경로'),`${currentBuffer.path}.copy.tex`);if(path)void store?.saveCopy(currentBuffer.path,path).catch(showError);}}>{t("복사본 저장")}</button></div></div>}
          {sourceOpening&&<div className="source-loading" role="status">{t('파일을 여는 중…','Opening file…')} {sourceOpening}</div>}
          {currentBuffer?.document.readOnly&&<section className="source-safety-notice" role="status" data-testid="source-safety-notice" data-code={currentBuffer.document.encoding==='unsupported'?'ENCODING_UNSUPPORTED':'LARGE_FILE'}><strong>{currentBuffer.document.encoding==='unsupported'?'ENCODING_UNSUPPORTED':'LARGE_FILE'}</strong><p>{currentBuffer.document.encoding==='unsupported'?t('이 파일은 UTF-8이 아닙니다. 원본은 읽기 전용으로 유지되며 변환한 복사본을 저장할 수 있습니다.'):t('4 MiB보다 큰 파일은 메모리를 보호하기 위해 읽기 전용으로 열었습니다.')}</p><div className="button-row">{currentBuffer.document.encoding==='unsupported'?<button onClick={()=>{const path=window.prompt(t('변환한 UTF-8 복사본 경로'),`${currentBuffer.path}.utf8.tex`);if(path&&window.confirm(t('UTF-8로 읽을 수 없는 바이트는 대체 문자로 변환됩니다. 원본은 바꾸지 않습니다. 계속할까요?','Undecodable bytes will become replacement characters. The original stays unchanged. Continue?')))void store?.saveCopy(currentBuffer.path,path).catch(showError);}}>{t('변환한 복사본 저장')}</button>:<button onClick={()=>{if(window.confirm(t('큰 파일을 편집하면 메모리 사용량이 늘어납니다. 허용할까요?')))void store?.allowLarge(currentBuffer.path).catch(showError);}}>{t('이 파일 편집 허용')}</button>}<button onClick={()=>void request('open_external',workspace,{path:currentBuffer.path}).catch(showError)}>{environments.find(value=>value.id===workspace.environmentId)?.kind==='ssh'?t('다운로드한 복사본으로 외부에서 열기','Open a downloaded copy externally'):t('외부에서 열기')}</button></div></section>}
          {assetPath?<AssetPreview workspace={workspace} path={assetPath} onError={workspaceError}/>:store&&currentBuffer?<SourceEditor store={store} loading={sourceOpening!==null||opening} onSelection={setSourceSelection} onReady={handle=>{editor.current=handle;}}/>:<div className="pane-empty"><h2>{t("소스를 선택하세요")}</h2><p>{t("왼쪽 파일을 열거나")}<kbd>Ctrl+P</kbd>{t("로 빠르게 찾으세요.")}</p>{!project.rootTex&&<p>{t("여러 논문이 있으면 상단에서 주 문서를 선택하세요.")}</p>}</div>}
        </section><div className="center-divider"><div className="splitter" role="separator" aria-label={t('소스와 PDF 너비','Source and PDF widths')} aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(sourceFraction)} tabIndex={0} onPointerDown={event=>{sourceDrag.current=true;event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{if(!sourceDrag.current)return;const box=event.currentTarget.closest('.center-panes')?.getBoundingClientRect();if(box)setSourceFraction(Math.max(25,Math.min(75,100*(event.clientX-box.left)/box.width)));}} onPointerUp={()=>{sourceDrag.current=false;}} onPointerCancel={()=>{sourceDrag.current=false;}} onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();setSourceFraction(value=>Math.max(25,Math.min(75,value+(event.key==='ArrowLeft'?-2:2))));}}}/><div className="pane-collapse-group"><button className="pane-collapse" aria-label={t('소스 접기','Collapse source')} onClick={()=>setView('pdf')}><Icon name="chevronLeft" size={12}/></button><button className="pane-collapse" aria-label={t('PDF 접기','Collapse PDF')} onClick={()=>setView('source')}><Icon name="chevronRight" size={12}/></button></div></div><section className="pdf-pane" aria-label={t("PDF 미리 보기")}><PdfPreview workspace={workspace} manifest={manifest} referencePath={referencePath} onSelection={setSelection} onError={workspaceError} onNavigate={location=>void openFile(location.path,location.line1)} onManifest={setManifest} onReturnToBuild={()=>setReferencePath(undefined)} buildControls={buildControls} logs={logsPanel} logsOpen={logOpen}/>{stale&&manifest&&<div className="pdf-stale">{t("이전 빌드 PDF · 소스가 변경되었습니다")}<button disabled={building} onClick={()=>void runBuild()}>{t("다시 빌드")}</button></div>}</section></main>
        <div className="inspector-divider" hidden={!rightOpen}><Splitter label={t('작업 패널 너비')} min={360} max={720} value={inspectorWidth} reverse onChange={width=>setSettings(current=>({...current,inspectorWidth:width}))} onCommit={width=>updateSettings({inspectorWidth:width})}/></div>
        <div className="inspector-host" hidden={!rightOpen}>
          <Inspector tab={tab} onTab={next=>{if(next==='ai'&&chatDetached)window.dispatchEvent(new Event('texypaper:chat-focus'));else setTab(next);}} onClose={()=>setInspector(false)}
            ai={<AgentPanel workspace={workspace} settings={settings} onDetachedChange={onChatDetachedChange} context={sourceSelection?{source:{path:sourceSelection.path,text:sourceSelection.quote}}:undefined} beforeStart={flush} onBusyChange={setAgentBusy} onChanged={onChanged}/>}
            comments={<CommentsPanel key={`${workspace.id}:${workspace.epoch}`} workspace={workspace} selection={commentSelection} selectionVersion={commentVersion} focusThreadId={commentFocus} manifest={manifest} displayedPdf={displayedPdf} refreshKey={refreshKey} onNavigate={navigateComment} onError={workspaceError}/>}
          />
        </div>
      </div>
      <footer className="statusbar"><span data-testid="build-status" data-sequence={buildSequence} data-status={buildPhase==='published'&&stale?'stale':buildPhase} data-build-id={manifest?.buildId??''} className="sr-only">{buildPhase==='published'&&stale?'stale':buildPhase}</span><span data-testid="sync-status" data-status={syncStatus?'matched':'idle'} data-direction={syncStatus?.direction??''} data-sequence={syncStatus?.sequence??0} className="sr-only">{syncStatus?'matched':'idle'}</span>{store?.recoveryStatus&&<span data-testid="transaction-status" data-status={store.recoveryStatus}>{t('복구 상태','Recovery status')}: {store.recoveryStatus}</span>}<span>{currentBuffer?t(`${currentBuffer.document.readOnly?'읽기 전용':currentBuffer.saving?'저장 중':currentBuffer.dirty?'변경됨':'저장됨'} · ${currentBuffer.document.encoding.toUpperCase()} · ${currentBuffer.document.newline.toUpperCase()}`):t('파일을 선택하세요')}</span><div>{trashRows.length>0&&<button onClick={()=>setTrashOpen(true)}>{t('휴지통 복원','Restore from trash')} ({trashRows.length})</button>}<button onClick={()=>setQuick(true)}>{t("파일 찾기 Ctrl+P")}</button><button onClick={()=>setLogOpen(value=>!value)}>{t("진단")}{diagnostics.length} {t("· 빌드 로그")}</button>{currentBuffer?.transactionId&&<button onClick={()=>void(async()=>{if(!await flush())return;try{await request('undo_transaction',workspace,{transactionId:currentBuffer.transactionId});await store?.reload(currentBuffer.path);saved();}catch(error){showError(error);}})()}>{t('마지막 저장 실행 취소','Undo last save')}</button>}{sourceSelection&&<button onClick={()=>void addComment(false)}>{t("선택에 댓글")}</button>}</div></footer>
      {selection&&!review&&<SelectionPopover selection={selection} onClose={()=>setSelection(null)} onSource={()=>{void request<{kind:string;file?:{path:string}|string;startByte?:number;endByte?:number;line1?:number;code?:string;reason?:string;candidates?:{path:string;line1:number}[]}>('pdf_map_selection',workspace,selection).then(async result=>{const path=typeof result.file==='string'?result.file:result.file?.path;if(path){void openFile(path,result.line1).then(()=>{if(result.startByte!==undefined)requestAnimationFrame(()=>editor.current?.selectBytes(result.startByte!,result.endByte??result.startByte!));});setSyncStatus(value=>({direction:'inverse',sequence:(value?.sequence??0)+1}));}else if(result.candidates?.length){const candidates=result.candidates;const selected=candidates.length===1?'0':await choose(t('소스 위치 선택','Choose a source location'),result.reason??t('후보 위치를 확인하고 소스 범위를 직접 선택하세요.','Review candidate locations and select the source range explicitly.'),[...candidates.map((candidate,index)=>({label:`${candidate.path}:${candidate.line1}`,value:String(index)})),{label:t('취소'),value:'cancel'}]);if(selected!=='cancel'){const candidate=candidates[Number(selected)];if(candidate)void openFile(candidate.path,candidate.line1);}}else showError({code:result.code??'SYNC_NO_MATCH',message:result.reason??t('연결 가능한 소스가 없습니다. 탐색기에서 원문을 직접 선택하세요.'),retryable:false});}).catch(showError);setSelection(null);}} onEdit={()=>setReview(true)} onAi={()=>{setTab('ai');setInspector(true);window.dispatchEvent(new CustomEvent('texypaper:agent-context',{detail:{pdf:selection}}));setSelection(null);}} onComment={()=>addComment(true)}/>}
      {review&&selection&&<SourceEditReview workspace={workspace} selection={selection} onClose={()=>{setReview(false);setSelection(null);}} onApplied={()=>{setReview(false);setSelection(null);void store?.poll();saved();}} onNavigate={location=>void openFile(location.path,location.line1)}/>}
    </>}
    <UpdateNotice updates={updates} onConfigure={()=>setSettingsOpen(true)}/>
    {helpOpen&&<div className="modal-scrim"><section className="modal shortcuts-dialog" role="dialog" aria-modal="true" aria-label={t('키보드 단축키','Keyboard shortcuts')}><div className="dialog-heading"><h2>{t('키보드 단축키','Keyboard shortcuts')}</h2><button aria-label={t('닫기')} onClick={()=>setHelpOpen(false)}><Icon name="close"/></button></div><dl className="shortcut-list">{[[t('프로젝트 열기'),'Ctrl+O'],[t('빠른 파일 열기'),'Ctrl+P'],[t('저장 후 컴파일','Save and compile'),'Ctrl+S'],[t('빌드'),'Ctrl+Shift+B'],[t('찾기','Find'),'Ctrl+F'],[t('찾기 및 바꾸기','Find and replace'),'Ctrl+H'],[t('소스에서 PDF로 이동','Go from source to PDF'),'Ctrl+Alt+J'],[t('선택에 댓글'),'Ctrl+Shift+A']].map(([label,shortcut])=><div key={shortcut}><dt>{label}</dt><dd><kbd>{shortcut}</kbd></dd></div>)}</dl><button onClick={()=>{setHelpOpen(false);setSettingsOpen(true);}}>{t('설정')}</button></section></div>}
    {picker&&workspace&&<div className="modal-scrim"><div className="modal" role="dialog" aria-modal="true" aria-label={t("프로젝트 전환")}><WorkspacePicker environments={environments} recents={recents} busy={opening} onOpen={open} onEnvironments={value=>{setEnvironments(value);updateSettings({environments:value});}} onClose={()=>setPicker(false)}/></div></div>}
    {trashOpen&&workspace&&<div className="modal-scrim"><section className="modal" role="dialog" aria-modal="true" aria-label={t('프로젝트 휴지통','Project trash')}><h2>{t('프로젝트 휴지통','Project trash')}</h2>{trashRows.map(row=><div className="field-row" key={row.transactionId}><span className="grow">{row.path}</span><button data-testid="trash-restore" onClick={()=>void request('file_restore',workspace,{transactionId:row.transactionId}).then(()=>{fileMutation({kind:'restore',path:row.path,transactionId:row.transactionId});}).catch(showError)}>{t('복원','Restore')}</button></div>)}<button onClick={()=>setTrashOpen(false)}>{t('닫기')}</button></section></div>}
    {settingsOpen&&<div className="modal-scrim"><SettingsSheet settings={settings} onChange={updateSettings} updates={updates} project={workspace?project:null} onProject={patch=>void updateProject(patch)} onClose={()=>setSettingsOpen(false)}/></div>}
    {quick&&<div className="modal-scrim"><section className="modal quick-open" role="dialog" aria-modal="true" aria-label={t("빠른 파일 열기")}><label>{t("파일 찾기 · &gt; 로 프로젝트 본문 검색")}<input autoFocus value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&quickFiles[0]){void openFile(quickFiles[0].path,quickFiles[0].line);setQuick(false);}}}/></label><div className="quick-results">{searching?<p>{t("검색 중…")}</p>:quickFiles.map((result,index)=><button key={`${result.path}:${index}`} onClick={()=>{void openFile(result.path,result.line);setQuick(false);}}><span>{result.path}{result.line?`:${result.line}`:''}</span>{result.text&&<small>{result.text}</small>}</button>)}</div>{searchCursor&&workspace&&<button disabled={searching} onClick={()=>{setSearching(true);void request<{matches:{path:string;line:number;text:string}[];nextCursor?:string}>('project_search',workspace,{query:query.slice(1),cursor:searchCursor}).then(result=>{setQuickFiles(result.matches);setSearchCursor(result.nextCursor);}).catch(showError).finally(()=>setSearching(false));}}>{t('다음 검색 결과','Next search results')}</button>}<button onClick={()=>setQuick(false)}>{t("닫기 Esc")}</button></section></div>}
    {compare&&currentBuffer&&<div className="modal-scrim"><section className="modal compare-dialog" role="dialog" aria-modal="true" aria-label={t("파일 변경 비교")}><h2>{currentBuffer.path}</h2><div className="compare-columns"><section><h3>{t("내 변경")}</h3><pre>{store?.text(currentBuffer)}</pre></section><section><h3>{t("디스크의 현재 파일")}</h3><pre>{currentBuffer.external?.text??t('현재 내용을 다시 불러오세요.')}</pre></section></div><button onClick={()=>setCompare(false)}>{t("닫기")}</button></section></div>}
    {choice&&<div className="modal-scrim"><section className="modal confirmation" role="alertdialog" aria-modal="true" aria-label={choice.title}><h2>{choice.title}</h2><p>{choice.message}</p><div className="button-row">{choice.options.map(option=><button autoFocus={option.value==='cancel'} key={option.value} onClick={()=>{setChoice(null);choice.resolve(option.value);}}>{option.label}</button>)}</div></section></div>}
    {sshPrompt&&<div className="modal-scrim"><section className="modal ssh-prompt" role="dialog" aria-modal="true" aria-label={t("SSH 인증")} data-testid="ssh-prompt"><h2>{sshPrompt.kind==='hostKey'?t('새 SSH 호스트 확인'):t('SSH 인증')}</h2><pre>{sshPrompt.prompt}</pre>{sshPrompt.kind!=='hostKey'&&<label>{t("응답")}<input autoFocus type="password" data-testid="ssh-answer" ref={sshInput} onKeyDown={event=>{if(event.key==='Enter')void nativeAnswer(sshInput.current?.value??'').catch(showError);}} autoComplete="off"/></label>}<div className="button-row"><button data-testid="ssh-submit" onClick={()=>void nativeAnswer(sshPrompt.kind==='hostKey'?'yes':sshInput.current?.value??'').catch(showError)}>{sshPrompt.kind==='hostKey'?t('이 지문을 신뢰하고 연결'):t('확인')}</button><button data-testid="ssh-cancel" onClick={()=>void nativeAnswer(null).catch(showError)}>{t("취소")}</button></div></section></div>}
  </div>;
}
