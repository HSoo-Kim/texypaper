import { t, setLocale, useI18n } from './i18n';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { AppError, BuildManifest, CommentThread, Diagnostic, Entry, Environment, TextDocument, WorkspaceRef } from '../contracts';
import { native, normalizeError, request, workspaceEvents } from '../api';
import { BufferStore, byteToUtf16, type SourceSelection } from '../editor/buffers';
import { SourceEditor, type SourceEditorHandle } from '../editor/SourceEditor';
import { FileTree, type FileMutation } from '../features/explorer/FileTree';
import { FileTypeIcon } from '../features/explorer/fileIcons';
import { upsertEntries } from '../features/explorer/paperIndex';
import { CommentsPanel, type CommentSelection } from '../features/comments/CommentsPanel';
import { AgentPanel } from '../features/ai/AgentPanel';
const PdfPreview = lazy(() => import('../pdf/PdfPreview').then(module => ({ default: module.PdfPreview })));
import { SelectionPopover } from '../features/pdf-edit/SelectionPopover';
const SourceEditReview = lazy(() => import('../features/pdf-edit/SourceEditReview').then(module => ({ default: module.SourceEditReview })));
import { defaultProject, findRoot, openWorkspace, type ProjectSettings } from '../state/workspace';
import { WorkspaceStateWriter, readWorkspaceState, type WorkspaceLayout, type PdfReadingPosition } from '../state/readingPosition';
import type { ChatReadingPosition } from '../features/ai/chatTypes';
import { Toolbar, type ViewMode } from './Toolbar';
import { UpdateNotice, useUpdates } from './Updates';
const SettingsSheet = lazy(() => import('./SettingsSheet').then(module => ({ default: module.SettingsSheet })));
const AssetPreview = lazy(() => import('./AssetPreview').then(module => ({ default: module.AssetPreview })));
import { WorkspacePicker, type RecentWorkspace } from './WorkspacePicker';
import { Inspector, type InspectorTab } from './Inspector';
import { applyTheme, defaultSettings, type AppSettings } from './theme';
import { usePreventBrowserZoom } from './paneZoom';
import './tokens.css';
import { errorText } from './errors';
import { Icon } from './Icon';
import { AppMenu } from './AppMenu';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { ShortcutHelpButton } from './ShortcutHelpButton';
const ShortcutHelp = lazy(() => import('./ShortcutHelp').then(module => ({ default: module.ShortcutHelp })));
import { ProjectSearch } from './ProjectSearch';
import { FileOutline } from '../features/explorer/FileOutline';
import { ActivityRail } from './ActivityRail';
import { BuildControls } from './BuildControls';
import { BuildDiagnostics } from './BuildDiagnostics';
import { StatusBar } from './StatusBar';
import { importAssets } from '../features/assets/importAssets';
const CheckpointsPanel = lazy(() => import('../features/history/CheckpointsPanel').then(module => ({ default: module.CheckpointsPanel })));
import { SpellEngine, type SpellStatus } from '../editor/spelling';
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
  const {locale}=useI18n();
  usePreventBrowserZoom();
  const [searchPanel,setSearchPanel]=useState(false),[historyPanel,setHistoryPanel]=useState(false),[helpOpen,setHelpOpen]=useState(false),[sourceFraction,setSourceFraction]=useState(50),[homeOpen,setHomeOpen]=useState(true);
  const sourceDrag=useRef<{pointerId:number;x:number;value:number;width:number}|null>(null),switchInProgress=useRef(false),homeVisible=useRef(true),workspaceFocus=useRef<HTMLElement|null>(null);
  homeVisible.current=homeOpen;
  const [chatDetached,setChatDetached]=useState(false);
  const onChatDetachedChange=useCallback((detached:boolean)=>{setChatDetached(detached);setInspector(!detached);if(!detached)setTab('ai');},[]);
  // One map owns filenames per epoch; allEntries publishes immutable array snapshots for existing UI consumers.
  const filenameIndex=useRef<{workspaceId:string;epoch:number;entries:Map<string,Entry>}|null>(null);
  const [bootstrap,setBootstrap]=useState<Bootstrap|null>(null),[settings,setSettings]=useState<AppSettings>(defaultSettings),[workspace,setWorkspace]=useState<WorkspaceRef|null>(null),[store,setStore]=useState<BufferStore|null>(null),[project,setProject]=useState<ProjectSettings>(defaultProject),[environments,setEnvironments]=useState<Environment[]>([localEnvironment]),[recents,setRecents]=useState<RecentWorkspace[]>([]);
  const [error,setError]=useState<AppError|null>(null),[opening,setOpening]=useState(false),[settingsOpen,setSettingsOpen]=useState(false),[trashOpen,setTrashOpen]=useState(false),[trashRows,setTrashRows]=useState<TrashRecord[]>([]),[view,setView]=useState<ViewMode>('split'),[explorer,setExplorer]=useState(true),[inspector,setInspector]=useState(true),[tab,setTab]=useState<InspectorTab>('ai'),[refreshKey,setRefreshKey]=useState(0),[allEntries,setAllEntries]=useState<Entry[]>([]),[manifest,setManifest]=useState<BuildManifest|null>(null),[displayedPdf,setDisplayedPdf]=useState<DisplayedPdf|null>(null),[building,setBuilding]=useState(false),[buildPhase,setBuildPhase]=useState<BuildPhase>('idle'),[buildFailure,setBuildFailure]=useState<AppError|null>(null),[sourceOpening,setSourceOpening]=useState<string|null>(null),[windowWidth,setWindowWidth]=useState(window.innerWidth),[buildSequence,setBuildSequence]=useState(0),[agentBusy,setAgentBusy]=useState(false),[stale,setStale]=useState(false),[diagnostics,setDiagnostics]=useState<Diagnostic[]>([]),[logTail,setLogTail]=useState(''),[logOpen,setLogOpen]=useState(false),[syncStatus,setSyncStatus]=useState<{direction:'forward'|'inverse';sequence:number}|null>(null),[assetPath,setAssetPath]=useState<string>(),[referencePath,setReferencePath]=useState<string>(),[selection,setSelection]=useState<unknown>(null),[review,setReview]=useState(false),[sourceSelection,setSourceSelection]=useState<SourceSelection|null>(null),[commentSelection,setCommentSelection]=useState<CommentSelection|null>(null),[commentVersion,setCommentVersion]=useState(0),[commentFocus,setCommentFocus]=useState<string>(),[quick,setQuick]=useState(false),[query,setQuery]=useState(''),[quickFiles,setQuickFiles]=useState<{path:string;line?:number;text?:string}[]>([]),[searching,setSearching]=useState(false),[searchCursor,setSearchCursor]=useState<string|undefined>(),[choice,setChoice]=useState<Choice|null>(null),[sshPrompt,setSshPrompt]=useState<SshPrompt|null>(null);
  const [panelWidths,setPanelWidths]=useState({explorerWidth:defaultSettings.explorerWidth,inspectorWidth:defaultSettings.inspectorWidth});
  const readingWriter=useRef<WorkspaceStateWriter|null>(null);
  const layoutSnapshot=useRef<{layout:WorkspaceLayout;view:ViewMode;trash:TrashRecord[];referencePath?:string}>(null!);
  layoutSnapshot.current={layout:{sourceFraction,explorer,search:searchPanel,inspector,tab,...panelWidths},view,trash:trashRows,referencePath};
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
  const updates=useUpdates(settings.updates);
  const sshPromptRef=useRef(sshPrompt);sshPromptRef.current=sshPrompt;
  const fileOpenSequence=useRef(0),sshInput=useRef<HTMLInputElement>(null),editor=useRef<SourceEditorHandle|null>(null),active=useRef<WorkspaceRef|null>(null),storeRef=useRef<BufferStore|null>(null),projectRef=useRef(project),buildTimer=useRef<number|undefined>(undefined),buildActive=useRef(false),buildRequest=useRef<Promise<BuildResult>|null>(null),pendingBuild=useRef(false),runBuildRef=useRef<()=>Promise<void>>(async()=>{}),sourceVersion=useRef(0),choiceRef=useRef<Choice|null>(null);projectRef.current=project;choiceRef.current=choice;
  const quitInProgress=useRef(false),quitDiscardPaths=useRef<string[]>([]);
  const showError=useCallback((value:unknown)=>setError(normalizeError(value)),[]);
  const workspaceError=useCallback((value:unknown)=>{if(workspace&&active.current?.id===workspace.id&&active.current.epoch===workspace.epoch)showError(value);},[workspace,showError]);
  const flushWorkspaceState=useCallback(async()=>{editor.current?.captureReadingPosition();const writer=readingWriter.current,buffers=storeRef.current;if(!writer||!buffers||writer.workspace.id!==buffers.workspace.id||writer.workspace.epoch!==buffers.workspace.epoch)return;writer.update({...layoutSnapshot.current,openPaths:[...buffers.records.keys()],activePath:buffers.activePath});await writer.flush();},[]);
  const showHome=useCallback(()=>{
    if(homeVisible.current||document.querySelector('[aria-modal="true"]'))return;
    editor.current?.captureReadingPosition();homeVisible.current=true;setHomeOpen(true);
    const trigger=document.activeElement;
    requestAnimationFrame(()=>{if(homeVisible.current&&!document.querySelector('[aria-modal="true"]')&&(document.activeElement===trigger||document.activeElement===document.body))document.querySelector<HTMLElement>('[data-testid="workspace-resume"]')?.focus({preventScroll:true});});
  },[]);
  const resumeWorkspace=useCallback(()=>{
    if(!active.current||switchInProgress.current)return;
    const trigger=document.activeElement,target=workspaceFocus.current;
    homeVisible.current=false;setHomeOpen(false);
    requestAnimationFrame(()=>{if(!homeVisible.current&&target?.isConnected&&target.getClientRects().length&&!document.querySelector('[aria-modal="true"]')&&(document.activeElement===trigger||document.activeElement===document.body))target.focus({preventScroll:true});});
  },[]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==='Escape')setHelpOpen(false);if(event.ctrlKey&&!event.altKey&&event.key.toLowerCase()==='o'&&!document.querySelector('[aria-modal="true"]')){event.preventDefault();showHome();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[showHome]);
  const onPdfReadingPosition=useCallback((position:PdfReadingPosition)=>{const writer=readingWriter.current;if(!homeVisible.current&&workspace&&active.current?.id===workspace.id&&active.current.epoch===workspace.epoch&&writer?.workspace.id===workspace.id&&writer.workspace.epoch===workspace.epoch)writer.pdf(position);},[workspace]);
  const onChatReadingPosition=useCallback((chat:ChatReadingPosition)=>{const writer=readingWriter.current;if(!homeVisible.current&&workspace&&active.current?.id===workspace.id&&active.current.epoch===workspace.epoch&&writer?.workspace.id===workspace.id&&writer.workspace.epoch===workspace.epoch)writer.update({chat});},[workspace]);
  const choose=useCallback((title:string,message:string,options:Choice['options'])=>new Promise<string>(resolve=>setChoice({title,message,options,resolve})),[]);
  const resolveChoice=useCallback((value:string)=>{const current=choiceRef.current;if(!current)return;choiceRef.current=null;setChoice(null);current.resolve(value);},[]);
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
    const runningCommands=currentWorkspace?(await request<{requests:{status:string}[]}>('command_list',currentWorkspace)).requests.some(command=>command.status==='running'):false;
    if(buildActive.current||agentBusy||runningCommands){
      const answer=await choose(reason==='quit'?t('TexyPaper 종료','Exit TexyPaper'):t('진행 중인 작업'),reason==='quit'?t('TexyPaper를 종료하기 전에 실행 중인 빌드, AI 작업과 명령을 중지할까요?','Stop running builds, AI tasks, and commands before exiting TexyPaper?'):t('프로젝트를 바꾸기 전에 실행 중인 빌드, AI 작업과 명령을 중지해야 합니다.','Stop running builds, AI tasks, and commands before switching projects.'),[{label:reason==='quit'?t('중지하고 종료','Stop and exit'):t('중지하고 계속'),value:'stop'},{label:reason==='quit'?t('취소'):t('현재 프로젝트에 머무르기'),value:'cancel'}]);
      if(answer!=='stop')return false;await stopWork();
    }
    const current=storeRef.current;if(current&&[...current.records.values()].some(buffer=>buffer.dirty)){
      const answer=await choose(t('저장하지 않은 변경'),t('열린 파일의 변경 사항을 어떻게 처리할까요?'),[{label:t('모두 저장'),value:'save'},{label:t('변경 버리기'),value:'discard'},{label:t('취소'),value:'cancel'}]);
      if(answer==='cancel')return false;if(answer==='save'&&!await flush())return false;if(answer==='discard'){const paths=[...current.records.values()].filter(buffer=>buffer.dirty).map(buffer=>buffer.path);if(reason==='quit')quitDiscardPaths.current=paths;for(const path of paths)await request('recovery_clear',current.workspace,{path});current.discard();}
    }clearTimeout(buildTimer.current);pendingBuild.current=false;return true;
  },[agentBusy,choose,flush,stopWork]);
  const open=useCallback(async(environment:Environment,root:string)=>{
    if(quitInProgress.current||switchInProgress.current||choiceRef.current)return;
    const same=active.current?.environmentId===environment.id&&active.current.root===root;
    if(same&&!storeRef.current?.disconnected){resumeWorkspace();return;}
    switchInProgress.current=true;setOpening(true);setError(null);homeVisible.current=true;setHomeOpen(true);
    try{
      // Reconnecting the same disconnected project keeps its edits through the recovery journal; asking to "save all" would be impossible offline.
      const reconnect=same&&!!storeRef.current?.disconnected;
      if(!reconnect&&!await guardSwitch())return;
      clearTimeout(buildTimer.current);await storeRef.current?.persistRecovery();
      await flushWorkspaceState();
      const previous=active.current;if(previous)await native('workspace_close',{workspaceId:previous.id,epoch:previous.epoch});readingWriter.current?.dispose();readingWriter.current=null;active.current=null;storeRef.current?.dispose();storeRef.current=null;filenameIndex.current=null;setStore(null);setWorkspace(null);setManifest(null);setDisplayedPdf(null);setSelection(null);setSourceSelection(null);setCommentSelection(null);setCommentFocus(undefined);setQuick(false);setQuery('');setQuickFiles([]);setSearchCursor(undefined);setAllEntries([]);setReferencePath(undefined);setAssetPath(undefined);setDiagnostics([]);setLogTail('');setLogOpen(false);setBuilding(false);setBuildPhase('idle');setBuildFailure(null);fileOpenSequence.current++;setSourceOpening(null);
      workspaceFocus.current=null;
      const opened=await openWorkspace(environment,root);const uiState=readWorkspaceState(await request('workspace_state_read',opened).catch(error=>{showError(error);return {};}));active.current=opened;
      const writer=new WorkspaceStateWriter(opened,uiState,(scope,state)=>request('workspace_state_write',scope,{state}),showError);readingWriter.current=writer;
      const layout=uiState.layout;setSourceFraction(layout?.sourceFraction??50);setExplorer(layout?.explorer??!compact);setSearchPanel(layout?.search??false);setInspector(layout?.inspector??!compact);setTab(layout?.tab??'ai');setPanelWidths({explorerWidth:layout?.explorerWidth??settings.explorerWidth,inspectorWidth:layout?.inspectorWidth??settings.inspectorWidth});setView(uiState.view??'split');setReferencePath(uiState.referencePath);setChatDetached(false);
      filenameIndex.current={workspaceId:opened.id,epoch:opened.epoch,entries:new Map()};setTrashRows(uiState.trash??[]);setWorkspace(opened);const buffers=new BufferStore(opened,saved,dirty,environment.kind==='ssh',uiState.editors,(path,position)=>{if(readingWriter.current===writer&&active.current?.id===opened.id&&active.current.epoch===opened.epoch)writer.editor(path,position);});storeRef.current=buffers;setStore(buffers);
      const latestBuild=await request<BuildResult>('build_status',opened).catch(()=>null);if(latestBuild?.manifest){setManifest(latestBuild.manifest);setBuildPhase('published');}if(latestBuild&&['failed','cancelled','timeout'].includes(latestBuild.status))setBuildPhase(latestBuild.status as BuildPhase);
      const projectSettings=await request<ProjectSettings>('project_read',opened);setProject({...defaultProject,...projectSettings});rootExplicit.current=!!projectSettings.rootTex;
      const first=await request<{entries:Entry[]}>('directory_list',opened,{path:'',showHidden:settings.showHidden});const index=filenameIndex.current;if(index?.workspaceId===opened.id&&index.epoch===opened.epoch&&upsertEntries(index.entries,first.entries))setAllEntries(Array.from(index.entries.values()));
      const rootTex=await findRoot(opened,undefined,projectSettings.rootTex,!!projectSettings.rootTex,first.entries.filter(entry=>entry.kind==='file').map(entry=>entry.path));if(rootTex){setProject(current=>({...current,rootTex}));await buffers.open(rootTex);}
      for(const path of (uiState.openPaths??[]).slice(0,8))if(!buffers.records.has(path))await buffers.open(path).catch(showError);if(uiState.activePath&&buffers.records.has(uiState.activePath))await buffers.open(uiState.activePath);if(uiState.view&&['source','pdf','split'].includes(uiState.view))setView(uiState.view);
      const recovered=await request<{documents:{path:string;text:string;baseSha256:string}[]}>('recovery_read',opened,{});for(const document of recovered.documents??[])if(!buffers.records.has(document.path))await buffers.open(document.path);
      const next=[{environmentId:environment.id,root:opened.root},...recents.filter(item=>item.root!==opened.root||item.environmentId!==environment.id)].slice(0,20);setRecents(next);updateSettings({recents:next,environments});homeVisible.current=false;setHomeOpen(false);setStale(latestBuild?.stale??false);setRefreshKey(value=>value+1);
    }catch(error){showError(error);homeVisible.current=true;setHomeOpen(true);throw error;}finally{switchInProgress.current=false;setOpening(false);}
  },[guardSwitch,resumeWorkspace,saved,dirty,settings.showHidden,settings.explorerWidth,settings.inspectorWidth,compact,recents,environments,updateSettings,showError,flushWorkspaceState]);
  // Nested menu actions use this ref: directly capturing open links memoized render scopes and retains old editor states.
  const openRef=useRef(open);openRef.current=open;
  // Start a paper from a template: open the (existing, possibly empty) folder, create only new files, then pin the main document and engine.
  const createPaperFromTemplate=useCallback(async(environment:Environment,root:string,templateId:string)=>{
    // Template contents load only for explicit creation; a static import would add them to Home startup.
    const [{paperTemplates},{createFromTemplate}]=await Promise.all([import('../features/templates/templates'),import('../features/templates/createFromTemplate')]);
    const template=paperTemplates.find(item=>item.id===templateId);
    if(!template)throw new Error(t('알 수 없는 템플릿입니다.','Unknown template.'));
    const before=active.current;
    await open(environment,root);
    const opened=active.current;
    if(!opened||opened===before||opened.environmentId!==environment.id)throw new Error(t('폴더를 열지 못해 템플릿을 만들지 않았습니다.','The folder could not be opened, so no template was created.'));
    try{
      await createFromTemplate({workspace:opened,template,request});
      const current=await request<ProjectSettings>('project_read',opened);
      const next=await request<ProjectSettings>('project_update',opened,{settings:{...defaultProject,...current,rootTex:template.rootTex,engine:template.engine}});
      if(active.current?.id===opened.id&&active.current.epoch===opened.epoch){setProject({...defaultProject,...next});rootExplicit.current=true;setRefreshKey(value=>value+1);await storeRef.current?.open(template.rootTex);}
    }catch(error){homeVisible.current=true;setHomeOpen(true);throw error;}
  },[open]);
  // Pasted or dropped images go to figures/ when it exists (otherwise the project root); names never collide and nothing is overwritten.
  const importEditorImages=useCallback(async(files:{name:string;bytes:Uint8Array}[])=>{
    const current=active.current;if(!current)return [];
    // Image import needs directory enumeration only after an explicit paste or drop.
    const {templateDirectoryReader}=await import('../features/templates/createFromTemplate');
    const reader=templateDirectoryReader(current,request);
    const root=await reader(''),targetDir=root.some(entry=>entry.kind==='directory'&&entry.name==='figures')?'figures':'';
    const names=new Set((targetDir?await reader(targetDir):root).map(entry=>entry.name));
    const result=await importAssets({workspace:current,request,files,targetDir,existingNames:names});
    if(result.failed.length)showError({code:result.failed[0].code,message:result.failed.map(item=>`${item.name}: ${item.message}`).join('\n'),retryable:false});
    return result.imported;
  },[showError]);
  useEffect(()=>{let alive=true;void native<Bootstrap>('app_bootstrap').then(data=>{if(!alive)return;setBootstrap(data);setSettings({...defaultSettings,...data.settings});const available=data.environments?.length?data.environments:[localEnvironment];if(!available.some(environment=>environment.kind==='local'))available.unshift(localEnvironment);setEnvironments(available);setRecents(data.recents??[]);if(data.openPath)void openRef.current(available.find(environment=>environment.kind==='local')!,data.openPath).catch(()=>{});}).catch(showError);return()=>{alive=false;};},[showError]);
  useEffect(()=>{const unlisten=listen<SshPrompt>('texypaper:ssh-prompt',event=>{setSshPrompt(event.payload);if(sshInput.current)sshInput.current.value='';});return()=>{void unlisten.then(dispose=>dispose());};},[]);
  const quit=useCallback(async()=>{
    if(quitInProgress.current||choiceRef.current||opening)return;
    quitInProgress.current=true;quitDiscardPaths.current=[];
    try{
      if(!await guardSwitch('quit'))return;
      setOpening(true);clearTimeout(buildTimer.current);pendingBuild.current=false;
      await stopWork();await storeRef.current?.persistRecovery();
      await flushWorkspaceState();
      const current=active.current;
      await native('app_quit',{workspaceId:current?.id??null,epoch:current?.epoch??null,discardPaths:quitDiscardPaths.current});
    }catch(error){showError(error);}finally{quitInProgress.current=false;setOpening(false);}
  },[guardSwitch,opening,stopWork,showError,flushWorkspaceState]);
  const quitRef=useRef(quit);quitRef.current=quit;
  useEffect(()=>{const unlisten=getCurrentWindow().listen('texypaper:quit-requested',()=>void quitRef.current());return()=>{void unlisten.then(dispose=>dispose());};},[]);
  const trayPromptPending=useRef(false);
  const explainTrayClose=useCallback(async()=>{
    if(trayPromptPending.current||quitInProgress.current||choiceRef.current||sshPromptRef.current||opening)return;
    trayPromptPending.current=true;
    try{
      const answer=await choose(t('창을 닫은 뒤에도 계속 실행할까요?','Keep running after closing the window?'),t('트레이에서 빌드·AI 작업을 계속할 수 있습니다. 트레이 아이콘이나 TexyPaper를 실행하면 다시 열립니다. 완전 종료는 파일 메뉴에서도 할 수 있습니다.','Builds and AI tasks can continue in the system tray. Open TexyPaper again or use its tray icon to return. File → Exit TexyPaper closes the app completely.'),[{label:t('트레이에서 계속 실행','Keep running in tray'),value:'background'},{label:t('완전 종료','Exit completely'),value:'quit'},{label:t('취소'),value:'cancel'}]);
      if(answer==='background'){await flushWorkspaceState();await native('app_hide_to_tray',{acknowledge:true});}
      else if(answer==='quit')await quitRef.current();
    }catch(error){showError(error);}finally{trayPromptPending.current=false;}
  },[choose,flushWorkspaceState,opening,showError]);
  const trayCloseRef=useRef(explainTrayClose);trayCloseRef.current=explainTrayClose;
  useEffect(()=>{const unlisten=getCurrentWindow().listen('texypaper:tray-close-requested',()=>void trayCloseRef.current());return()=>{void unlisten.then(dispose=>dispose());};},[]);
  useEffect(()=>{if(!workspace||!store)return;const stopPolling=store.startPolling();const unlisten=workspaceEvents(workspace,event=>{
    if(active.current?.id!==workspace.id||active.current.epoch!==workspace.epoch)return;
    if(event.kind==='build/published'){const envelope=event.payload as {result?:BuildResult;manifest?:BuildManifest}&BuildManifest;const next=envelope.result?.manifest??envelope.manifest??(envelope.buildId?envelope:undefined);if(next){setManifest(next);setBuildPhase('published');setBuildFailure(null);setLogOpen(false);recheckStale(workspace);}setBuilding(false);}
    if(['build/failed','build/cancelled','build/timeout'].includes(event.kind)){const phase=event.kind.slice(6) as 'failed'|'cancelled'|'timeout',payload=event.payload as {result?:BuildResult};setBuildPhase(phase);setBuilding(false);setStale(true);if(payload.result?.diagnostics)setDiagnostics(payload.result.diagnostics);if(payload.result?.logTail)setLogTail(payload.result.logTail.slice(-262144));setBuildFailure({code:phase==='timeout'?'BUILD_TIMEOUT':phase==='cancelled'?'BUILD_CANCELLED':'BUILD_FAILED',message:t('빌드를 완료하지 못했습니다. 진단과 로그를 확인하세요.','The build did not complete. Check diagnostics and the log.'),retryable:true});setLogOpen(open=>open||!hasBuiltPdf.current);}
    if(event.kind==='file/changed'||event.kind==='workspace/changed'){void store.poll();bump();}
    if(event.kind==='ssh/disconnected'){store.disconnected=true;setError({code:'SSH_DISCONNECTED',message:t('SSH 연결이 끊겼습니다. 편집 내용과 마지막 PDF는 유지됩니다. 다시 연결한 뒤 변경 내용을 확인하세요.'),retryable:true});setStale(true);}
  });return()=>{stopPolling();void unlisten.then(dispose=>dispose());};},[workspace,store,bump]);
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
    // An autosave finishing behind the switch dialogs must not start a build that then blocks closing the project.
    if(quitInProgress.current||switchInProgress.current)return;
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
    try{
      await buffers.open(path);
      if(requestId!==fileOpenSequence.current||active.current?.id!==current.id||active.current.epoch!==current.epoch)return;
      if(/\.(tex|ltx)$/i.test(path)){
        const record=buffers.records.get(path),root=await findRoot(current,path,projectRef.current.rootTex,rootExplicit.current,[...texCandidatesRef.current,...(filenameIndex.current?.entries.keys()??[])],record?buffers.text(record):undefined);
        if(requestId!==fileOpenSequence.current||active.current?.id!==current.id||active.current.epoch!==current.epoch)return;
        if(root&&root!==projectRef.current.rootTex)setProject(value=>({...value,rootTex:root}));
      }
      setView(value=>value==='pdf'?'source':value);
      if(line)requestAnimationFrame(()=>{if(requestId===fileOpenSequence.current&&active.current?.id===current.id&&active.current.epoch===current.epoch&&buffers.activePath===path)editor.current?.navigate(line);});
    }catch(error){if(requestId!==fileOpenSequence.current||active.current?.id!==current.id||active.current.epoch!==current.epoch)return;const value=normalizeError(error);if(['BINARY_FILE','ENCODING_UNSUPPORTED','NOT_TEXT'].includes(value.code)){setAssetPath(path);setView('source');}else showError(value);}finally{if(requestId===fileOpenSequence.current)setSourceOpening(null);}
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
    if(event.key==='Escape'){if(sshPromptRef.current){const id=sshPromptRef.current.id;if(sshInput.current)sshInput.current.value='';setSshPrompt(null);void native('ssh_prompt_answer',{id,answer:null}).catch(showError);return;}if(choiceRef.current){resolveChoice('cancel');return;}setQuick(false);setSettingsOpen(false);setTrashOpen(false);setSelection(null);setReview(false);return;}
    if(!event.ctrlKey)return;
    if(document.querySelector('[aria-modal="true"]'))return;
    if(event.shiftKey&&!event.altKey&&!event.isComposing&&event.key.toLowerCase()==='q'){event.preventDefault();void quitRef.current();return;}
    if(homeOpen){if(['s','p','b','j'].includes(event.key.toLowerCase()))event.preventDefault();return;}
    if(event.key.toLowerCase()==='s'){event.preventDefault();saveAndBuild();}
    if(event.key.toLowerCase()==='p'){event.preventDefault();setQuick(true);setQuery('');}
    if(event.shiftKey&&event.key.toLowerCase()==='b'){event.preventDefault();void runBuildRef.current();}
  };
    // Overleaf's "add comment" is Ctrl+Shift+C (Ctrl+Shift+A is track changes there, which TexyPaper does not have).
    // Own it before CodeMirror's modifier fallbacks can run.
    const commentShortcut=(event:KeyboardEvent)=>{if(!homeOpen&&!document.querySelector('[aria-modal="true"]')&&event.ctrlKey&&event.shiftKey&&!event.altKey&&!event.isComposing&&event.key.toLowerCase()==='c'){event.preventDefault();event.stopPropagation();void addComment(false);}};
    window.addEventListener('keydown',commentShortcut,true);window.addEventListener('keydown',keydown);
    return()=>{window.removeEventListener('keydown',commentShortcut,true);window.removeEventListener('keydown',keydown);};
  },[flush,addComment,manifest,homeOpen,showError,saveAndBuild,resolveChoice]);
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
  const savedUiSignature=useRef('');useEffect(()=>{if(!store||opening)return;const writer=readingWriter.current;if(!writer||writer.workspace.id!==store.workspace.id||writer.workspace.epoch!==store.workspace.epoch)return;const state={...layoutSnapshot.current,openPaths:[...store.records.keys()],activePath:store.activePath};const signature=`${store.workspace.id}:${store.workspace.epoch}:${JSON.stringify(state)}`;if(signature===savedUiSignature.current)return;savedUiSignature.current=signature;writer.update(state);},[store,opening,bufferVersion,view,trashRows,sourceFraction,explorer,searchPanel,inspector,tab,panelWidths,referencePath]);
  const currentBuffer=store?.activePath?store.records.get(store.activePath):undefined;
  const [spellStatus,setSpellStatus]=useState<SpellStatus|null>(null),[wordCounts,setWordCounts]=useState<{words:number;characters:number;selectionWords:number}|null>(null);
  useEffect(()=>{if(!workspace){setSpellStatus(null);return;}let alive=true;void SpellEngine(workspace).status().then(status=>{if(alive)setSpellStatus(status);}).catch(()=>{if(alive)setSpellStatus({available:false,languages:[]});});return()=>{alive=false;};},[workspace?.id,workspace?.epoch]);
  useEffect(()=>{const handle=editor.current;if(!store||!handle||!currentBuffer||!texPathPattern.test(currentBuffer.path)||homeOpen){setWordCounts(null);return;}const timer=window.setTimeout(()=>setWordCounts(handle.wordCounts()),400);return()=>window.clearTimeout(timer);},[store,bufferVersion,sourceSelection,currentBuffer?.path,homeOpen,view]);
  const ignoreSpellWord=useCallback((word:string)=>{const clean=word.trim();if(!clean||clean.length>64)return;const current=settings.spellIgnore??[];if(current.some(item=>item.toLowerCase()===clean.toLowerCase()))return;updateSettings({spellIgnore:[...current,clean].slice(-500)});},[settings.spellIgnore,updateSettings]);
  // An open .tex file is enough to compile: the main document is resolved from it on demand.
  const canBuild=!!project.rootTex||/\.(tex|ltx)$/i.test(store?.activePath??'');
  useEffect(()=>{const trap=(event:KeyboardEvent)=>{const dialogs=document.querySelectorAll<HTMLElement>('[aria-modal="true"]');const dialog=dialogs.item(dialogs.length-1);if(!dialog)return;if(event.key==='Tab'){const elements=[...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(element=>element.getClientRects().length);if(!elements.length)return;const first=elements[0],last=elements[elements.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}};document.addEventListener('keydown',trap);return()=>document.removeEventListener('keydown',trap);},[]);
  useEffect(()=>{const openComment=(event:Event)=>{const detail=(event as CustomEvent<{threadId:string}>).detail;if(!detail?.threadId)return;setCommentFocus(detail.threadId);setTab('comments');setInspector(true);};window.addEventListener('texypaper:comment-open',openComment);return()=>window.removeEventListener('texypaper:comment-open',openComment);},[]);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    let focused=false;
    const focusDialog=()=>{
      const dialogs=document.querySelectorAll<HTMLElement>('[aria-modal="true"]'),dialog=dialogs.item(dialogs.length-1);
      if(!dialog)return false;
      focused=true;
      if(!dialog.contains(document.activeElement))dialog.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
      return true;
    };
    // Lazy dialogs arrive after the disclosure render; acquire and restore focus when their DOM commits.
    const observer=!focusDialog()&&(settingsOpen||helpOpen)?new MutationObserver(()=>{if(focusDialog())observer?.disconnect();}):null;
    observer?.observe(document.getElementById('root')!,{childList:true,subtree:true});
    return()=>{observer?.disconnect();if(focused&&previous?.isConnected&&previous.getClientRects().length)previous.focus({preventScroll:true});};
  },[settingsOpen,quick,choice,sshPrompt,compare,review,trashOpen,helpOpen]);
  useEffect(()=>{const identity=(event:Event)=>{const value=(event as CustomEvent<DisplayedPdf&{closed?:boolean}>).detail;const current=active.current;if(!current||value?.workspaceId!==current.id||value.epoch!==current.epoch)return;setDisplayedPdf(value.closed?null:value);};window.addEventListener('texypaper:pdf-identity',identity);return()=>window.removeEventListener('texypaper:pdf-identity',identity);},[]);
  const nativeAnswer=async(answer:string|null)=>{if(!sshPrompt)return;if(sshInput.current)sshInput.current.value='';const id=sshPrompt.id;setSshPrompt(null);await native('ssh_prompt_answer',{id,answer});if(sshInput.current)sshInput.current.value='';};
  const onChanged=useCallback((paths:string[])=>{if(!workspace||active.current?.id!==workspace.id||active.current.epoch!==workspace.epoch)return;bump();void storeRef.current?.poll();if(paths.length){setStale(true);sourceVersion.current++;setSelection(null);}},[bump,workspace]);
  const showPanel=(panel:'files'|'search'|'history'|'ai'|'comments')=>{
    if(panel==='files'||panel==='search'||panel==='history'){
      const isCurrent=panel==='files'?explorer&&!searchPanel&&!historyPanel:panel==='search'?searchPanel:historyPanel;
      setHistoryPanel(panel==='history'&&!isCurrent);
      setExplorer(panel==='files'?!isCurrent:explorer);setSearchPanel(panel==='search'&&!isCurrent);
      if(compact)setInspector(false);
      return;
    }
    if(panel==='ai'&&chatDetached){window.dispatchEvent(new Event('texypaper:chat-focus'));return;}
    setInspector(value=>!(value&&tab===panel));setTab(panel);
    if(medium){setExplorer(false);setSearchPanel(false);setHistoryPanel(false);}
  };
  useEffect(()=>{setHistoryPanel(false);},[workspace?.id,workspace?.epoch]);
  const showPanelRef=useRef(showPanel);showPanelRef.current=showPanel;
  const viewRef=useRef(view);viewRef.current=view;
  const syncLatest=useRef({manifest,stale,compact});syncLatest.current={manifest,stale,compact};
  const inverseSequence=useRef(0);
  // A PDF older than the source still maps through its build snapshot, but lines may have moved since then.
  const approximateNotice=useCallback(()=>{if(syncLatest.current.stale)setError({code:'SYNC_APPROXIMATE',message:t('PDF가 현재 소스보다 오래되어 위치가 어긋날 수 있습니다. 다시 컴파일하면 정확해집니다.','The PDF is older than the source, so the location may be off. Recompile for an exact match.'),retryable:true});},[]);
  const syncToPdf=useCallback(()=>{
    if(homeVisible.current||document.querySelector('[aria-modal="true"]'))return;
    const current=active.current,path=storeRef.current?.activePath,{manifest:built,compact:narrow}=syncLatest.current;
    if(!current||!path)return;
    if(!built){setError({code:'PDF_NOT_BUILT',message:t('먼저 컴파일하면 소스 위치를 PDF에서 찾을 수 있습니다.','Compile first to find this source position in the PDF.'),retryable:true});return;}
    const line=editor.current?.position().line1??1;
    void request('sync_forward',current,{buildId:built.buildId,file:path,line1:line}).then(result=>{
      if(active.current?.id!==current.id||active.current.epoch!==current.epoch)return;
      setView(value=>value==='source'?(narrow?'pdf':'split'):value);
      setSyncStatus(value=>({direction:'forward',sequence:(value?.sequence??0)+1}));
      window.dispatchEvent(new CustomEvent('texypaper:sync-forward',{detail:result}));
      approximateNotice();
    }).catch(showError);
  },[showError,approximateNotice]);
  useEffect(()=>{
    type InverseRecord={path?:string;line?:number;column?:number|null};
    const located=(record:InverseRecord):record is {path:string;line:number;column?:number|null}=>typeof record.path==='string'&&typeof record.line==='number'&&Number.isInteger(record.line)&&record.line>=1;
    const idle=()=>homeVisible.current||!!document.querySelector('[aria-modal="true"]');
    const forward=()=>syncToPdf();
    const compile=()=>{if(!idle())saveAndBuild();};
    const inverse=(event:Event)=>{
      const detail=(event as CustomEvent<{workspaceId?:string;epoch?:number;buildId?:string;page?:number;x?:number;y?:number}>).detail;
      const current=active.current,{manifest:built,compact:narrow}=syncLatest.current;
      if(!detail||!current||!built||idle())return;
      if(detail.workspaceId!==current.id||detail.epoch!==current.epoch||detail.buildId!==built.buildId)return;
      const {page,x,y}=detail;
      if(typeof page!=='number'||!Number.isInteger(page)||page<1||typeof x!=='number'||!Number.isFinite(x)||typeof y!=='number'||!Number.isFinite(y))return;
      const token=++inverseSequence.current,fromPdfOnly=viewRef.current==='pdf',valid=()=>token===inverseSequence.current&&active.current?.id===current.id&&active.current.epoch===current.epoch;
      void request<{records?:InverseRecord[]}>('sync_inverse',current,{buildId:built.buildId,page1:page,xPt:x,yPt:y}).then(async result=>{
        if(!valid())return;
        const hit=result.records?.find(located);
        if(!hit){setError({code:'SYNC_NO_MATCH',message:t('이 위치에 대응하는 프로젝트 소스를 찾지 못했습니다. 본문 글자 위에서 다시 시도하세요.','No project source matches this spot. Try again on body text.'),retryable:false});return;}
        await openFile(hit.path,hit.line);
        if(!valid())return;
        setSyncStatus(value=>({direction:'inverse',sequence:(value?.sequence??0)+1}));
        if(fromPdfOnly&&!narrow)setView('split');
        requestAnimationFrame(()=>{if(valid()&&storeRef.current?.activePath===hit.path)editor.current?.navigate(hit.line,hit.column??1);});
        approximateNotice();
      }).catch(showError);
    };
    window.addEventListener('texypaper:sync-source-requested',forward);window.addEventListener('texypaper:sync-pdf-requested',inverse);window.addEventListener('texypaper:compile-requested',compile);
    return()=>{window.removeEventListener('texypaper:sync-source-requested',forward);window.removeEventListener('texypaper:sync-pdf-requested',inverse);window.removeEventListener('texypaper:compile-requested',compile);};
  },[syncToPdf,saveAndBuild,openFile,showError,approximateNotice]);
  // Overleaf-compatible app shortcuts. Editor-local ones (Ctrl+Enter, Ctrl+.) arrive from CodeMirror as 'texypaper:compile-requested'.
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if(event.isComposing||homeVisible.current||document.querySelector('[aria-modal="true"]'))return;
      if(!(event.ctrlKey||event.metaKey)||event.defaultPrevented)return;
      const target=event.target instanceof Element?event.target:null,inEditor=!!target?.closest('.cm-editor'),inField=!inEditor&&!!target?.closest('textarea,input,select,[contenteditable="true"]');
      if(event.altKey&&!event.shiftKey&&event.code==='KeyJ'){event.preventDefault();syncToPdf();return;}
      if(event.altKey||event.shiftKey)return;
      if(event.code==='KeyJ'&&!inField){event.preventDefault();showPanelRef.current('comments');return;}
      if(inEditor||inField)return;
      if(event.key==='.'||event.key==='Enter'){event.preventDefault();saveAndBuild();}
    };
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[syncToPdf,saveAndBuild]);
  const createItem=async(kind:'file'|'directory')=>{if(!workspace||!await flush())return;const parent=currentBuffer?.path.split('/').slice(0,-1).join('/');const path=window.prompt(kind==='file'?t('새 파일 경로'):t('새 폴더 경로'),parent?`${parent}/`:'');if(!path)return;try{await request('file_create',workspace,{path,kind,content:''});fileMutation({kind:'create',path});if(kind==='file')await openFile(path);}catch(error){showError(error);}};
  const logsPanel=<BuildDiagnostics buildFailure={buildFailure} diagnostics={diagnostics} logTail={logTail} onClose={()=>setLogOpen(false)} onAskAi={()=>void askAiAboutError()} onOpen={(path,line)=>void openFile(path,line)}/>;
  const buildControls=<BuildControls canBuild={canBuild} building={building} project={project} texCandidates={texCandidates} logOpen={logOpen} diagnostics={diagnostics} onBuild={()=>void runBuild()} onProject={patch=>void updateProject(patch)} onCancel={cancelBuild} onSettings={()=>setSettingsOpen(true)} onToggleLogs={()=>setLogOpen(value=>!value)}/>;
  const [contextMenu,setContextMenu]=useState<{x:number;y:number;kind:'source'|'pdf'}|null>(null);
  const pdfSelectionRef=useRef<unknown>(null);pdfSelectionRef.current=selection;
  const openAiPanel=()=>{if(chatDetached)return;setTab('ai');setInspector(true);if(medium){setExplorer(false);setSearchPanel(false);}};
  // Attachments are explicit: nothing selected in the editor or PDF is shared with the AI unless the user attaches it.
  const sendAttachment=(detail:Record<string,unknown>)=>{openAiPanel();requestAnimationFrame(()=>window.dispatchEvent(new CustomEvent('texypaper:ai-attach',{detail:{...detail,focus:true}})));};
  // One explicit click: attach the source around the first build error and prefill (never send) a question. Nothing is shared until the user sends it.
  const askAiAboutError=async()=>{
    if(!workspace)return;
    const projectDiagnostics=diagnostics.filter(item=>item.path),errors=projectDiagnostics.filter(item=>item.severity==='error'),pool=errors.length?errors:projectDiagnostics,target=pool[0];
    if(!target?.path)return;
    try{
      const buffers=storeRef.current,record=buffers?.records.get(target.path);
      const raw=record&&buffers?buffers.text(record):(await request<{text:string}>('file_read',workspace,{path:target.path})).text;
      const all=raw.split(/\r\n|\n|\r/),line=Math.min(Math.max(target.line??1,1),all.length);
      const startLine=Math.max(1,line-20),endLine=Math.min(all.length,line+20),text=all.slice(startLine-1,endLine).join('\n');
      if(!text.trim())return;
      const list=pool.slice(0,6).map(item=>`- ${item.path}${item.line?`:${item.line}`:''} ${item.message}`.slice(0,300)).join('\n');
      const prompt=`${t('LaTeX 빌드가 실패했습니다. 원인을 찾아 검토할 수 있는 수정 제안을 만들어 주세요. 적용은 제가 확인한 뒤 직접 하겠습니다.','The LaTeX build failed. Please find the cause and propose a reviewable fix; I will review it before applying.')}\n\n${t('빌드 오류:','Build errors:')}\n${list}${buildFailure?`\n${buildFailure.code}: ${errorText(buildFailure)}`:''}`.slice(0,3900);
      sendAttachment({kind:'source',path:target.path,startLine,endLine,text,prompt});
    }catch(error){showError(error);}
  };
  const attachPdfSelection=(value:unknown)=>{
    const pdf=value as {buildId?:unknown;quote?:unknown;pageSelections?:{page?:unknown}[]}|null,page=pdf?.pageSelections?.[0]?.page;
    if(!pdf||typeof pdf.buildId!=='string'||typeof pdf.quote!=='string'||!pdf.quote.trim()||typeof page!=='number'||!Number.isInteger(page)||page<1)return false;
    sendAttachment({kind:'pdf',buildId:pdf.buildId,page,quote:pdf.quote});setSelection(null);return true;
  };
  const attachSource=()=>{
    const handle=editor.current,buffers=storeRef.current,path=buffers?.activePath,record=path?buffers?.records.get(path):undefined;
    if(!handle||!buffers||!path||!record)return false;
    const raw=buffers.text(record),bom=record.document.encoding==='utf8Bom'?3:0,picked=handle.selection();
    const lineAt=(byte:number)=>{try{return raw.slice(0,byteToUtf16(raw,Math.max(0,byte-bom))).split(/\r\n|\r|\n/).length;}catch{return 1;}};
    let startLine:number,endLine:number,text:string;
    if(picked){startLine=lineAt(picked.startByte);endLine=lineAt(picked.endByte);text=picked.quote;if(text.endsWith('\n')&&endLine>startLine)endLine--;}
    else{startLine=endLine=handle.position().line1;text=raw.split(/\r\n|\r|\n/)[startLine-1]??'';}
    if(!text.trim())return false;
    sendAttachment({kind:'source',path,startLine,endLine,text});return true;
  };
  const attachRef=useRef({attachSource,attachPdfSelection});attachRef.current={attachSource,attachPdfSelection};
  useEffect(()=>{
    const idle=()=>homeVisible.current||!!document.querySelector('[aria-modal="true"]');
    // Ctrl+L attaches the selection (or the cursor line) of whichever pane has focus; it runs before CodeMirror's select-line.
    const attachKey=(event:KeyboardEvent)=>{
      if(event.isComposing||idle()||!(event.ctrlKey||event.metaKey)||event.altKey||event.shiftKey||event.code!=='KeyL')return;
      const target=event.target instanceof Element?event.target:null;
      const handled=target?.closest('.cm-editor')?attachRef.current.attachSource():target?.closest('.pdf-pane')?attachRef.current.attachPdfSelection(pdfSelectionRef.current):false;
      if(handled){event.preventDefault();event.stopPropagation();}
    };
    // A custom menu only replaces the native one while text is selected; otherwise the native menu (incl. Paste) stays.
    const openMenu=(event:MouseEvent)=>{
      if(idle()||!(event.target instanceof Element))return;
      const kind=event.target.closest('.source-editor')?(editor.current?.selection()?'source':null):event.target.closest('.pdf-scroll')&&!event.target.closest('a,button,input,select,textarea')?(pdfSelectionRef.current?'pdf':null):null;
      if(!kind)return;
      event.preventDefault();setContextMenu({x:event.clientX,y:event.clientY,kind});
    };
    const chipOpen=(event:Event)=>{
      const detail=(event as CustomEvent<{kind?:string;path?:string;line?:number;buildId?:string;page?:number}>).detail;
      if(!detail||idle())return;
      if(detail.kind==='source'&&typeof detail.path==='string')void openFile(detail.path,typeof detail.line==='number'?detail.line:undefined);
      else if(detail.kind==='pdf'&&typeof detail.page==='number'){
        const {manifest:built,compact:narrow}=syncLatest.current;
        if(!built||built.buildId!==detail.buildId){setError({code:'PDF_CHANGED',message:t('이 PDF는 다시 빌드되어 첨부한 위치로 이동할 수 없습니다. 인용문은 그대로 AI에 전달됩니다.','This PDF was rebuilt, so the attached spot cannot be opened. The quoted text is still sent to the AI.'),retryable:false});return;}
        setView(value=>value==='source'?(narrow?'pdf':'split'):value);
        requestAnimationFrame(()=>window.dispatchEvent(new CustomEvent('texypaper:pdf-goto',{detail:{buildId:detail.buildId,page:detail.page}})));
      }
    };
    window.addEventListener('keydown',attachKey,true);window.addEventListener('contextmenu',openMenu);window.addEventListener('texypaper:ai-chip-open',chipOpen);
    return()=>{window.removeEventListener('keydown',attachKey,true);window.removeEventListener('contextmenu',openMenu);window.removeEventListener('texypaper:ai-chip-open',chipOpen);};
  },[openFile]);
  const showSelectionSource=()=>{
    if(!workspace||!selection)return;
    void request<{kind:string;file?:{path:string}|string;startByte?:number;endByte?:number;line1?:number;code?:string;reason?:string;candidates?:{path:string;line1:number}[]}>('pdf_map_selection',workspace,selection).then(async result=>{const path=typeof result.file==='string'?result.file:result.file?.path;if(path){void openFile(path,result.line1).then(()=>{if(result.startByte!==undefined)requestAnimationFrame(()=>editor.current?.selectBytes(result.startByte!,result.endByte??result.startByte!));});setSyncStatus(value=>({direction:'inverse',sequence:(value?.sequence??0)+1}));}else if(result.candidates?.length){const candidates=result.candidates;const selected=candidates.length===1?'0':await choose(t('소스 위치 선택','Choose a source location'),result.reason??t('후보 위치를 확인하고 소스 범위를 직접 선택하세요.','Review candidate locations and select the source range explicitly.'),[...candidates.map((candidate,index)=>({label:`${candidate.path}:${candidate.line1}`,value:String(index)})),{label:t('취소'),value:'cancel'}]);if(selected!=='cancel'){const candidate=candidates[Number(selected)];if(candidate)void openFile(candidate.path,candidate.line1);}}else showError({code:result.code??'SYNC_NO_MATCH',message:result.reason??t('연결 가능한 소스가 없습니다. 탐색기에서 원문을 직접 선택하세요.'),retryable:false});}).catch(showError);setSelection(null);
  };
  const contextItems:ContextMenuItem[]=contextMenu?.kind==='pdf'?[
    {id:'copy',label:t('복사','Copy'),shortcut:'Ctrl+C',onSelect:()=>{const quote=(selection as {quote?:string}|null)?.quote;if(quote)void navigator.clipboard.writeText(quote).catch(showError);}},
    {id:'sep',separator:true},
    {id:'ai',label:t('AI에 첨부','Attach to AI chat'),shortcut:'Ctrl+L',onSelect:()=>void attachPdfSelection(selection)},
    {id:'source',label:t('원문 보기','View source'),onSelect:showSelectionSource},
    {id:'edit',label:t('텍스트 수정','Edit text'),onSelect:()=>setReview(true)},
    {id:'comment',label:t('댓글 추가','Add comment'),shortcut:'Ctrl+Shift+C',onSelect:()=>void addComment(true)},
  ]:[
    {id:'cut',label:t('잘라내기','Cut'),shortcut:'Ctrl+X',disabled:!!currentBuffer?.document.readOnly,onSelect:()=>{editor.current?.focus();document.execCommand('cut');}},
    {id:'copy',label:t('복사','Copy'),shortcut:'Ctrl+C',onSelect:()=>{editor.current?.focus();document.execCommand('copy');}},
    {id:'sep',separator:true},
    {id:'ai',label:t('AI에 첨부','Attach to AI chat'),shortcut:'Ctrl+L',onSelect:()=>void attachSource()},
    {id:'comment',label:t('댓글 추가','Add comment'),shortcut:'Ctrl+Shift+C',onSelect:()=>void addComment(false)},
    {id:'pdf',label:t('PDF에서 위치 보기','Show in PDF'),shortcut:'Ctrl+Alt+J',disabled:!manifest,onSelect:syncToPdf},
  ];
  const sideOpen=explorer||searchPanel||historyPanel;
  const rightOpen=inspector&&(tab==='comments'||!chatDetached);
  const inspectorWidth=Math.max(360,Math.min(720,panelWidths.inspectorWidth));
  const shellStyle={'--ui-scale':settings.zoom,'--explorer-width':`${panelWidths.explorerWidth}px`,'--inspector-width':`${inspectorWidth}px`,'--source-fraction':`${sourceFraction}%`} as CSSProperties;
  return <div className={`app-shell ${compact?'compact-layout':''} ${medium?'medium-layout':''}`} style={shellStyle}>
    <div className="project-dashboard" hidden={!homeOpen&&!!workspace} data-testid="project-home"><header className="dashboard-appbar"><div className="product-mark"><img className="product-icon" src={productIcon} width={24} height={24} alt=""/><strong>TexyPaper</strong><span>{t('홈 · 프로젝트','Home · Projects')}</span></div>{(homeOpen||!workspace)&&<div className="button-row"><AppMenu label={t('파일','File')}><button role="menuitem" data-testid="app-exit" onClick={()=>void quitRef.current()}>{t('TexyPaper 완전 종료','Exit TexyPaper')}<kbd>Ctrl+Shift+Q</kbd></button></AppMenu><ShortcutHelpButton onClick={()=>setHelpOpen(true)}/><button data-testid="settings-button" aria-label={t('설정')} onClick={()=>setSettingsOpen(true)}><Icon name="settings" size={17}/><span>{t('설정')}</span></button></div>}</header><main className="welcome">{bootstrap?<WorkspacePicker environments={environments} recents={recents} busy={opening} onOpen={open} onCreateFromTemplate={createPaperFromTemplate} currentWorkspace={workspace} disconnected={!!store?.disconnected} onResume={resumeWorkspace} onEnvironments={value=>{setEnvironments(value);updateSettings({environments:value});}}/>:<p role="status">{t("작업 공간 준비 중…")}</p>}{error&&(homeOpen||!workspace)&&<div className="home-error inline-error" role="alert"><strong>{error.code}</strong><p>{errorText(error)}</p><div className="button-row">{workspace&&<button disabled={opening} onClick={resumeWorkspace}>{t('현재 프로젝트로 돌아가기','Return to current project')}</button>}<button onClick={()=>setError(null)}>{t('알림 닫기','Dismiss')}</button></div></div>}</main></div>
    {workspace&&<div className="workspace-session" hidden={homeOpen} onFocusCapture={event=>{if((event.target as HTMLElement).closest('.workbench'))workspaceFocus.current=event.target as HTMLElement;}}>
      <Toolbar workspace={workspace} compact={compact} buildPhase={buildPhase} connection={store?.disconnected?'disconnected':environments.find(value=>value.id===workspace.environmentId)?.kind==='ssh'?'connected':'local'} environmentLabel={environments.find(environment=>environment.id===workspace.environmentId)?.label??workspace.environmentId} rootTex={project.rootTex} canBuild={canBuild} candidates={texCandidates} building={building} stale={stale} view={view} onProject={showHome} onRoot={path=>void updateProject({rootTex:path||null})} onBuild={()=>void runBuild()} onCancel={cancelBuild} onView={setView} onExplorer={()=>showPanel('files')} onInspector={()=>showPanel('ai')} onSettings={()=>setSettingsOpen(true)} onSave={saveAndBuild} onNewFile={()=>void createItem('file')} onNewFolder={()=>void createItem('directory')} onQuickOpen={()=>setQuick(true)} onEdit={command=>{setView(current=>current==='pdf'?'source':current);requestAnimationFrame(()=>{if(!homeVisible.current&&!document.querySelector('[aria-modal="true"]'))editor.current?.command(command);});}} onHelp={()=>setHelpOpen(true)} onQuit={()=>void quitRef.current()}/>
      {error&&<div className="global-notice" role="alert"><div><strong>{error.code}</strong> {errorText(error)}</div><div className="button-row">{error.code==='PDF_STALE'&&<button onClick={()=>void runBuild()}>{t('다시 빌드')}</button>}{error.code==='SSH_DISCONNECTED'&&<button onClick={showHome}>{t("다시 연결")}</button>}{error.code==='LARGE_FILE'&&currentBuffer&&<><button onClick={()=>{if(window.confirm(t('큰 파일을 편집하면 메모리 사용량이 늘어납니다. 허용할까요?')))void store?.allowLarge(currentBuffer.path).then(()=>setError(null)).catch(showError);}}>{t("이 파일 편집 허용")}</button><button onClick={()=>void request('open_external',workspace,{path:currentBuffer.path}).catch(showError)}>{environments.find(value=>value.id===workspace.environmentId)?.kind==='ssh'?t('다운로드한 복사본으로 외부에서 열기','Open a downloaded copy externally'):t("외부에서 열기")}</button></>}{error.code==='ENCODING_UNSUPPORTED'&&currentBuffer&&<button onClick={()=>{const path=window.prompt(t('변환한 UTF-8 복사본 경로'),`${currentBuffer.path}.utf8.tex`);if(path&&window.confirm(t('UTF-8로 읽을 수 없는 바이트는 대체 문자로 변환됩니다. 원본은 바꾸지 않습니다. 계속할까요?','Undecodable bytes will become replacement characters. The original stays unchanged. Continue?')))void store?.saveCopy(currentBuffer.path,path).catch(showError);}}>{t("변환한 복사본 저장")}</button>}<button aria-label={t("알림 닫기")} onClick={()=>setError(null)}>×</button></div></div>}
      <div className={`workbench ${sideOpen?'explorer-open':''} ${rightOpen?'inspector-open':''} view-${view}`}>
        <ActivityRail explorer={explorer} searchPanel={searchPanel} historyPanel={historyPanel} chatDetached={chatDetached} rightOpen={rightOpen} tab={tab} onPanel={showPanel} onHelp={()=>setHelpOpen(true)} onSettings={()=>setSettingsOpen(true)}/>
        <aside className="explorer" hidden={!sideOpen}><div className="files-panel" hidden={!explorer||searchPanel||historyPanel}><FileTree key={`${workspace.id}:${workspace.epoch}`} workspace={workspace} mainPath={project.rootTex} selectedPath={store?.activePath} showHidden={settings.showHidden} refreshKey={refreshKey} onOpen={path=>void openFile(path)} onMain={path=>void updateProject({rootTex:path})} onEntries={entriesChanged} onError={workspaceError} beforeMutation={flush} onMutation={fileMutation}/>{store&&<FileOutline store={store} onNavigate={line=>{setView(current=>current==='pdf'?'source':current);requestAnimationFrame(()=>editor.current?.navigate(line));}}/>}</div>{searchPanel&&<ProjectSearch workspace={workspace} onOpen={(path,line)=>void openFile(path,line)} onError={workspaceError} onClose={()=>setSearchPanel(false)} flush={flush} onApplied={paths=>{onChanged(paths);saved();}}/>}{historyPanel&&<Suspense fallback={null}><CheckpointsPanel key={`${workspace.id}:${workspace.epoch}`} workspace={workspace} entries={allEntries} flush={flush} onRestored={paths=>{onChanged(paths);saved();}} onError={workspaceError} active={historyPanel}/></Suspense>}</aside>{sideOpen&&<div className="sidebar-divider"><Splitter label={t('탐색기 너비')} min={180} max={340} value={panelWidths.explorerWidth} onChange={width=>setPanelWidths(current=>({...current,explorerWidth:width}))} onCommit={width=>updateSettings({explorerWidth:width})}/><button className="pane-collapse" aria-label={t('사이드 패널 접기','Collapse side panel')} onClick={()=>{setExplorer(false);setSearchPanel(false);setHistoryPanel(false);}}><Icon name="chevronLeft" size={12}/></button></div>}
        <main className="center-panes"><section className="source-pane" aria-label={t("소스")}><div className="file-tabs" role="tablist" aria-label={t("열린 파일")}>{store&&[...store.records.values()].map(buffer=><div key={buffer.path} className={store.activePath===buffer.path?'active':''}><button role="tab" aria-selected={store.activePath===buffer.path} onClick={()=>void openFile(buffer.path)} title={buffer.path}><FileTypeIcon kind="file" name={buffer.path} size={14}/><span className="file-tab-name">{buffer.path.split('/').at(-1)}{buffer.dirty?' ●':''}</span></button><button aria-label={t(`${buffer.path} 닫기`)} onClick={()=>void(async()=>{if(buffer.dirty){const answer=await choose(t('파일 닫기'),buffer.path,[{label:t('저장'),value:'save'},{label:t('버리기'),value:'discard'},{label:t('취소'),value:'cancel'}]);if(answer==='cancel')return;if(answer==='save'){try{await store.save(buffer.path);}catch(error){showError(error);return;}}else{await request('recovery_clear',workspace,{path:buffer.path});buffer.dirty=false;}}store.close(buffer.path);})()}>×</button></div>)}</div>
          {currentBuffer?.warning&&<div className="inline-error" role="alert"><strong>{t('소스 저장 완료 · 댓글 갱신 경고','Source saved · comment refresh warning')}</strong><p>{errorText(currentBuffer.warning)}</p><button onClick={()=>{setTab('comments');setInspector(true);}}>{t('댓글 확인','Review comments')}</button></div>}{currentBuffer?.error&&<div className="inline-error" role="alert"><strong>{currentBuffer.error.code}</strong><p>{errorText(currentBuffer.error)}</p><div className="button-row">{store?.disconnected&&<button onClick={showHome}>{t('다시 연결')}</button>}<button onClick={()=>setCompare(true)}>{t("비교")}</button><button data-testid="file-reload" onClick={()=>{if(window.confirm(t('현재 변경을 버리고 디스크 파일을 불러올까요?')))void store?.reload(currentBuffer.path).catch(showError);}}>{t("다시 불러오기")}</button><button onClick={()=>{const path=window.prompt(t('복사본 경로'),`${currentBuffer.path}.copy.tex`);if(path)void store?.saveCopy(currentBuffer.path,path).catch(showError);}}>{t("복사본 저장")}</button></div></div>}
          {sourceOpening&&<div className="source-loading" role="status">{t('파일을 여는 중…','Opening file…')} {sourceOpening}</div>}
          {currentBuffer?.document.readOnly&&<section className="source-safety-notice" role="status" data-testid="source-safety-notice" data-code={currentBuffer.document.encoding==='unsupported'?'ENCODING_UNSUPPORTED':'LARGE_FILE'}><strong>{currentBuffer.document.encoding==='unsupported'?'ENCODING_UNSUPPORTED':'LARGE_FILE'}</strong><p>{currentBuffer.document.encoding==='unsupported'?t('이 파일은 UTF-8이 아닙니다. 원본은 읽기 전용으로 유지되며 변환한 복사본을 저장할 수 있습니다.'):t('4 MiB보다 큰 파일은 메모리를 보호하기 위해 읽기 전용으로 열었습니다.')}</p><div className="button-row">{currentBuffer.document.encoding==='unsupported'?<button onClick={()=>{const path=window.prompt(t('변환한 UTF-8 복사본 경로'),`${currentBuffer.path}.utf8.tex`);if(path&&window.confirm(t('UTF-8로 읽을 수 없는 바이트는 대체 문자로 변환됩니다. 원본은 바꾸지 않습니다. 계속할까요?','Undecodable bytes will become replacement characters. The original stays unchanged. Continue?')))void store?.saveCopy(currentBuffer.path,path).catch(showError);}}>{t('변환한 복사본 저장')}</button>:<button onClick={()=>{if(window.confirm(t('큰 파일을 편집하면 메모리 사용량이 늘어납니다. 허용할까요?')))void store?.allowLarge(currentBuffer.path).catch(showError);}}>{t('이 파일 편집 허용')}</button>}<button onClick={()=>void request('open_external',workspace,{path:currentBuffer.path}).catch(showError)}>{environments.find(value=>value.id===workspace.environmentId)?.kind==='ssh'?t('다운로드한 복사본으로 외부에서 열기','Open a downloaded copy externally'):t('외부에서 열기')}</button></div></section>}
          {assetPath?<Suspense fallback={null}><AssetPreview workspace={workspace} path={assetPath} onError={workspaceError}/></Suspense>:store&&currentBuffer?<SourceEditor store={store} fontSize={settings.editorFontSize} onFontSizeChange={value=>updateSettings({editorFontSize:value})} visible={!homeOpen&&view!=='pdf'} loading={sourceOpening!==null||opening} onSelection={setSourceSelection} spellCheck={settings.spellCheck} spellIgnore={settings.spellIgnore} spellWorkspace={workspace} onSpellIgnore={ignoreSpellWord} onImages={importEditorImages} onReady={handle=>{editor.current=handle;}}/>:<div className="pane-empty"><h2>{t("소스를 선택하세요")}</h2><p>{t("왼쪽 파일을 열거나")}<kbd>Ctrl+P</kbd>{t("로 빠르게 찾으세요.")}</p>{!project.rootTex&&<p>{t("여러 논문이 있으면 상단에서 주 문서를 선택하세요.")}</p>}</div>}
        </section><div className="center-divider"><div className="splitter source-pdf-splitter" hidden={view!=='split'||compact} role="separator" data-testid="source-pdf-divider" aria-label={t('소스와 PDF 너비','Source and PDF widths')} aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(sourceFraction)} aria-valuetext={t(`소스 ${Math.round(sourceFraction)}%, PDF ${100-Math.round(sourceFraction)}%`,`Source ${Math.round(sourceFraction)}%, PDF ${100-Math.round(sourceFraction)}%`)} title={t('드래그 또는 방향키로 너비 조절 · 두 번 클릭하면 반씩','Drag or use arrow keys to resize · Double-click for equal widths')} tabIndex={view==='split'&&!compact?0:-1}
          onPointerDown={event=>{if(event.button!==0||!event.isPrimary||sourceDrag.current)return;const box=event.currentTarget.closest('.center-panes')?.getBoundingClientRect();if(!box?.width)return;event.preventDefault();event.currentTarget.focus({preventScroll:true});sourceDrag.current={pointerId:event.pointerId,x:event.clientX,value:sourceFraction,width:box.width};event.currentTarget.dataset.dragging='true';event.currentTarget.setPointerCapture(event.pointerId);}}
          onPointerMove={event=>{const drag=sourceDrag.current;if(drag?.pointerId===event.pointerId)setSourceFraction(Math.max(25,Math.min(75,drag.value+100*(event.clientX-drag.x)/drag.width)));}}
          onPointerUp={event=>{if(sourceDrag.current?.pointerId!==event.pointerId)return;sourceDrag.current=null;delete event.currentTarget.dataset.dragging;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
          onPointerCancel={event=>{sourceDrag.current=null;delete event.currentTarget.dataset.dragging;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
          onLostPointerCapture={event=>{sourceDrag.current=null;delete event.currentTarget.dataset.dragging;}}
          onDoubleClick={()=>setSourceFraction(50)}
          onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();setSourceFraction(value=>event.key==='Home'?25:event.key==='End'?75:Math.max(25,Math.min(75,value+(event.key==='ArrowLeft'?-2:2))));}}}><span className="splitter-grip" aria-hidden="true"/></div><div className="pane-collapse-group">{view==='split'&&!compact?<><button className="pane-collapse" aria-label={t('소스 접기','Collapse source')} onClick={()=>setView('pdf')}><Icon name="chevronLeft" size={12}/></button><button className="pane-collapse" aria-label={t('PDF 접기','Collapse PDF')} onClick={()=>setView('source')}><Icon name="chevronRight" size={12}/></button></>:view==='pdf'?<button className="pane-collapse" data-testid="restore-source" aria-label={t('소스 다시 펼치기','Restore source pane')} onClick={()=>setView(compact?'source':'split')}><Icon name="chevronRight" size={12}/></button>:<button className="pane-collapse" data-testid="restore-pdf" aria-label={t('PDF 다시 펼치기','Restore PDF pane')} onClick={()=>setView(compact?'pdf':'split')}><Icon name="chevronLeft" size={12}/></button>}</div></div><section className="pdf-pane" aria-label={t("PDF 미리 보기")}><Suspense fallback={null}><PdfPreview key={`${workspace.id}:${workspace.epoch}`} workspace={workspace} manifest={manifest} referencePath={referencePath} visible={!homeOpen&&view!=='source'&&!(compact&&view==='split')} readingPositions={readingWriter.current?.state.pdfs} onReadingPositionChange={onPdfReadingPosition} onSelection={setSelection} onError={workspaceError} onNavigate={location=>void openFile(location.path,location.line1)} onManifest={setManifest} onReturnToBuild={()=>setReferencePath(undefined)} buildControls={buildControls} logs={logsPanel} logsOpen={logOpen}/></Suspense>{stale&&manifest&&<div className="pdf-stale">{t("이전 빌드 PDF · 소스가 변경되었습니다")}<button disabled={building} onClick={()=>void runBuild()}>{t("다시 빌드")}</button></div>}</section></main>
        <div className="inspector-divider" hidden={!rightOpen}><Splitter label={t('작업 패널 너비')} min={360} max={720} value={inspectorWidth} reverse onChange={width=>setPanelWidths(current=>({...current,inspectorWidth:width}))} onCommit={width=>updateSettings({inspectorWidth:width})}/></div>
        <div className="inspector-host" hidden={!rightOpen}>
          <Inspector tab={tab} onTab={next=>{if(next==='ai'&&chatDetached)window.dispatchEvent(new Event('texypaper:chat-focus'));else setTab(next);}} onClose={()=>setInspector(false)}
            ai={<AgentPanel key={`${workspace.id}:${workspace.epoch}`} workspace={workspace} settings={settings} readingPosition={readingWriter.current?.state.chat} onReadingPositionChange={onChatReadingPosition} onDetachedChange={onChatDetachedChange} beforeStart={flush} onBusyChange={setAgentBusy} onChanged={onChanged}/>}
            comments={<CommentsPanel key={`${workspace.id}:${workspace.epoch}`} workspace={workspace} selection={commentSelection} selectionVersion={commentVersion} focusThreadId={commentFocus} manifest={manifest} displayedPdf={displayedPdf} refreshKey={refreshKey} onNavigate={navigateComment} onError={workspaceError}/>}
          />
        </div>
      </div>
      <StatusBar buildSequence={buildSequence} buildPhase={buildPhase} stale={stale} buildId={manifest?.buildId} syncStatus={syncStatus} recoveryStatus={store?.recoveryStatus} currentBuffer={currentBuffer} wordCounts={wordCounts} trashCount={trashRows.length} diagnosticCount={diagnostics.length} hasSourceSelection={!!sourceSelection} onTrash={()=>setTrashOpen(true)} onQuickOpen={()=>setQuick(true)} onToggleLogs={()=>setLogOpen(value=>!value)} onUndo={()=>void(async()=>{if(!await flush())return;try{await request('undo_transaction',workspace,{transactionId:currentBuffer!.transactionId});await store?.reload(currentBuffer!.path);saved();}catch(error){showError(error);}})()} onComment={()=>void addComment(false)} onHelp={()=>setHelpOpen(true)}/>
      {!!selection&&!review&&<SelectionPopover selection={selection} onClose={()=>setSelection(null)} onSource={showSelectionSource} onEdit={()=>setReview(true)} onAi={()=>void attachPdfSelection(selection)} onComment={()=>addComment(true)}/>}
      {review&&!!selection&&<Suspense fallback={null}><SourceEditReview workspace={workspace} selection={selection} onClose={()=>{setReview(false);setSelection(null);}} onApplied={()=>{setReview(false);setSelection(null);void store?.poll();saved();}} onNavigate={location=>void openFile(location.path,location.line1)}/></Suspense>}
    </div>}
    <UpdateNotice updates={updates} onConfigure={()=>setSettingsOpen(true)}/>
    {contextMenu&&<ContextMenu x={contextMenu.x} y={contextMenu.y} label={contextMenu.kind==='pdf'?t('PDF 선택 메뉴','PDF selection menu'):t('소스 선택 메뉴','Source selection menu')} items={contextItems} onClose={()=>setContextMenu(null)}/>}
    {helpOpen&&<Suspense fallback={null}><ShortcutHelp open={helpOpen} onClose={()=>setHelpOpen(false)} onOpenSettings={()=>setSettingsOpen(true)}/></Suspense>}
    {trashOpen&&workspace&&<div className="modal-scrim"><section className="modal" role="dialog" aria-modal="true" aria-label={t('프로젝트 휴지통','Project trash')}><h2>{t('프로젝트 휴지통','Project trash')}</h2>{trashRows.map(row=><div className="field-row" key={row.transactionId}><span className="grow">{row.path}</span><button data-testid="trash-restore" onClick={()=>void request('file_restore',workspace,{transactionId:row.transactionId}).then(()=>{fileMutation({kind:'restore',path:row.path,transactionId:row.transactionId});}).catch(showError)}>{t('복원','Restore')}</button></div>)}<button onClick={()=>setTrashOpen(false)}>{t('닫기')}</button></section></div>}
    {settingsOpen&&<div className="modal-scrim"><Suspense fallback={null}><SettingsSheet settings={settings} onChange={updateSettings} updates={updates} project={workspace?project:null} onProject={patch=>void updateProject(patch)} spellAvailable={spellStatus?.available} spellEngine={spellStatus?.engine} onClose={()=>setSettingsOpen(false)}/></Suspense></div>}
    {quick&&<div className="modal-scrim"><section className="modal quick-open" role="dialog" aria-modal="true" aria-label={t("빠른 파일 열기")}><label>{t("파일 찾기 · &gt; 로 프로젝트 본문 검색")}<input autoFocus value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&quickFiles[0]){void openFile(quickFiles[0].path,quickFiles[0].line);setQuick(false);}}}/></label><div className="quick-results">{searching?<p>{t("검색 중…")}</p>:quickFiles.map((result,index)=><button key={`${result.path}:${index}`} onClick={()=>{void openFile(result.path,result.line);setQuick(false);}}><span className="quick-result-file"><FileTypeIcon kind="file" name={result.path} size={16}/><span>{result.path}{result.line?`:${result.line}`:''}</span></span>{result.text&&<small>{result.text}</small>}</button>)}</div>{searchCursor&&workspace&&<button disabled={searching} onClick={()=>{setSearching(true);void request<{matches:{path:string;line:number;text:string}[];nextCursor?:string}>('project_search',workspace,{query:query.slice(1),cursor:searchCursor}).then(result=>{setQuickFiles(result.matches);setSearchCursor(result.nextCursor);}).catch(showError).finally(()=>setSearching(false));}}>{t('다음 검색 결과','Next search results')}</button>}<button onClick={()=>setQuick(false)}>{t("닫기 Esc")}</button></section></div>}
    {compare&&currentBuffer&&<div className="modal-scrim"><section className="modal compare-dialog" role="dialog" aria-modal="true" aria-label={t("파일 변경 비교")}><h2>{currentBuffer.path}</h2><div className="compare-columns"><section><h3>{t("내 변경")}</h3><pre>{store?.text(currentBuffer)}</pre></section><section><h3>{t("디스크의 현재 파일")}</h3><pre>{currentBuffer.external?.text??t('현재 내용을 다시 불러오세요.')}</pre></section></div><button onClick={()=>setCompare(false)}>{t("닫기")}</button></section></div>}
    {choice&&<div className="modal-scrim"><section className="modal confirmation" role="alertdialog" aria-modal="true" aria-label={choice.title}><h2>{choice.title}</h2><p>{choice.message}</p><div className="button-row">{choice.options.map(option=><button autoFocus={option.value==='cancel'} key={option.value} onClick={()=>resolveChoice(option.value)}>{option.label}</button>)}</div></section></div>}
    {sshPrompt&&<div className="modal-scrim"><section className="modal ssh-prompt" role="dialog" aria-modal="true" aria-label={t("SSH 인증")} data-testid="ssh-prompt"><h2>{sshPrompt.kind==='hostKey'?t('새 SSH 호스트 확인'):t('SSH 인증')}</h2><pre>{sshPrompt.prompt}</pre>{sshPrompt.kind!=='hostKey'&&<label>{t("응답")}<input autoFocus type="password" data-testid="ssh-answer" ref={sshInput} onKeyDown={event=>{if(event.key==='Enter')void nativeAnswer(sshInput.current?.value??'').catch(showError);}} autoComplete="off"/></label>}<div className="button-row"><button data-testid="ssh-submit" onClick={()=>void nativeAnswer(sshPrompt.kind==='hostKey'?'yes':sshInput.current?.value??'').catch(showError)}>{sshPrompt.kind==='hostKey'?t('이 지문을 신뢰하고 연결'):t('확인')}</button><button data-testid="ssh-cancel" onClick={()=>void nativeAnswer(null).catch(showError)}>{t("취소")}</button></div></section></div>}
  </div>;
}
