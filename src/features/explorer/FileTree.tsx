import { t } from "../../ui/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { request, normalizeError } from '../../api';
import type { AppError, Entry, WorkspaceRef } from '../../contracts';
import { excludedDirectories, PaperIndex } from './paperIndex';
import { Icon } from '../../ui/Icon';
import { FileTypeIcon } from './fileIcons';
import { ASSET_SIZE_LIMIT, importAssets, type AssetImportResult } from '../assets/importAssets';
export type FileMutation={kind:'rename'|'trash'|'restore'|'create';path:string;newPath?:string;transactionId?:string};
export type FileTreeProps={workspace:WorkspaceRef;mainPath:string|null;selectedPath?:string|null;showHidden:boolean;refreshKey:number;onOpen:(path:string)=>void;onMain:(path:string)=>void;onEntries?:(entries:Entry[])=>void;onError:(error:AppError)=>void;beforeMutation?:()=>Promise<boolean>;onMutation?:(change:FileMutation)=>void;
  /** OS image/PDF drops are enabled by default; internal non-file drags remain untouched. */
  assetDropEnabled?:boolean;
  /** Optional notification after imports; existing onMutation receives each successful create. */
  onAssetImport?:(result:AssetImportResult)=>void;
};
type Row={entry:Entry;depth:number;parent:string};
export function FileTree({workspace,mainPath,selectedPath,showHidden,refreshKey,onOpen,onMain,onEntries,onError,beforeMutation,onMutation,assetDropEnabled=true,onAssetImport}:FileTreeProps) {
  const index=useMemo(()=>new PaperIndex(),[workspace.id,workspace.epoch]);
  const [expanded,setExpanded]=useState(new Set([''])),[version,setVersion]=useState(0),[active,setActive]=useState(''),[scroll,setScroll]=useState(0),[height,setHeight]=useState(500),[scanning,setScanning]=useState(false),[complete,setComplete]=useState(false),[scanCount,setScanCount]=useState(0),[menu,setMenu]=useState<Entry|null>(null);
  const scanActive=useRef(false),container=useRef<HTMLDivElement>(null),mounted=useRef(true),inFlight=useRef(new Map<string,Promise<void>>()),queue=useRef(Promise.resolve());
  const [assetStatus,setAssetStatus]=useState<string[]>([]);
  const importing=useRef(false);
  const assetWorkspace=useRef(workspace);assetWorkspace.current=workspace;
  useEffect(()=>{if(!assetStatus.length)return;const timer=window.setTimeout(()=>setAssetStatus([]),10000);return()=>clearTimeout(timer);},[assetStatus]);
  const load=useCallback((path:string)=>{
    if(!mounted.current)return Promise.resolve();
    const pending=inFlight.current.get(path);if(pending)return pending;
    const operation=queue.current.then(async()=>{if(!mounted.current)return;try{
      let cursor:string|undefined;const entries:Entry[]=[];
      do{const page=await request<{entries:Entry[];nextCursor?:string}>('directory_list',workspace,{path,cursor,showHidden});if(!mounted.current)return;entries.push(...page.entries);cursor=page.nextCursor;}while(cursor&&mounted.current);
      if(mounted.current&&index.update(path,entries)){onEntries?.(entries);setVersion(value=>value+1);}
    }catch(error){if(mounted.current)onError(normalizeError(error));}finally{inFlight.current.delete(path);}});queue.current=operation.catch(()=>{});inFlight.current.set(path,operation);return operation;
  },[workspace,index,showHidden,onEntries,onError]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;index.clear();inFlight.current.clear();queue.current=Promise.resolve();};},[index]);
  useEffect(()=>{for(const path of expanded)void load(path);},[refreshKey,showHidden,load,expanded]);
  useEffect(()=>{
    const observer=new ResizeObserver(entries=>setHeight(entries[0]?.contentRect.height??500));if(container.current)observer.observe(container.current);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{let active=true,timer:number|undefined;const tick=async()=>{for(const path of expanded){if(!active)break;await load(path);}if(active)timer=window.setTimeout(()=>void tick(),document.hidden?15000:2000);};timer=window.setTimeout(()=>void tick(),2000);return()=>{active=false;clearTimeout(timer);};},[expanded,load,workspace.environmentId]);
  const rows=useMemo(()=>{
    const result:Row[]=[];const visit=(path:string,depth:number)=>{for(const entry of index.listings.get(path)??[]){if(!showHidden&&entry.name.startsWith('.'))continue;result.push({entry,depth,parent:path});if(entry.kind==='directory'&&expanded.has(entry.path))visit(entry.path,depth+1);}};visit('',0);return result;
  },[index,version,expanded,showHidden]);
  const rowHeight=30,start=Math.max(0,Math.floor(scroll/rowHeight)-6),end=Math.min(rows.length,Math.ceil((scroll+height)/rowHeight)+6);
  const toggle=(path:string)=>setExpanded(current=>{const next=new Set(current);if(next.has(path))next.delete(path);else next.add(path);return next;});
  const focusRow=(position:number)=>{const row=rows[Math.max(0,Math.min(position,rows.length-1))];if(!row)return;setActive(row.entry.path);const target=rows.indexOf(row)*rowHeight;if(container.current){if(target<container.current.scrollTop)container.current.scrollTop=target;if(target+rowHeight>container.current.scrollTop+height)container.current.scrollTop=target-height+rowHeight;}};
  const mutate=async(action:string,entry:Entry)=>{
    setMenu(null);try{
      if(action==='main'){onMain(entry.path);return;}
      if(beforeMutation&&!await beforeMutation())return;if(!mounted.current)return;
      if(action==='trash'){
        if(!window.confirm(t(`“${entry.path}”을 프로젝트 휴지통으로 옮길까요? 복원할 수 있습니다.`)))return;
        const transactionId=crypto.randomUUID();await request('file_trash',workspace,{path:entry.path,transactionId});if(!mounted.current)return;onMutation?.({kind:'trash',path:entry.path,transactionId});
        if(window.confirm(t('휴지통으로 옮겼습니다. 지금 복원할까요?'))){await request('file_restore',workspace,{transactionId});if(!mounted.current)return;onMutation?.({kind:'restore',path:entry.path,transactionId});}
      }else if(action==='rename'){
        const newPath=window.prompt(t('새 경로 (프로젝트 기준)'),entry.path);if(!newPath||newPath===entry.path)return;await request('file_rename',workspace,{path:entry.path,newPath});if(!mounted.current)return;onMutation?.({kind:'rename',path:entry.path,newPath});
      }else{
        const parent=entry.kind==='directory'?entry.path:entry.path.split('/').slice(0,-1).join('/');
        const path=window.prompt(action==='directory'?t('새 폴더 경로'):t('새 파일 경로'),parent?`${parent}/`:'');if(!path)return;await request('file_create',workspace,{path,kind:action==='directory'?'directory':'file',content:''});if(!mounted.current)return;onMutation?.({kind:'create',path});
      }
      index.invalidate(entry.path);for(const path of expanded)await load(path);
    }catch(error){if(mounted.current)onError(normalizeError(error));}
  };
  const scan=async(resume=false)=>{
    if(scanActive.current)return;scanActive.current=true;setScanning(true);try{
      let scanned=0,first=true;setScanCount(0);while(mounted.current&&!document.hidden&&scanned<20000){
        const batch=await request<{entries:Entry[];complete:boolean;scanned:number;paused?:boolean;frontierCount?:number}>('scan_step',workspace,{limit:256,continue:first&&resume});first=false;if(!mounted.current)return;
        onEntries?.(batch.entries);index.accept(batch.entries);
        setVersion(value=>value+1);scanned+=batch.scanned;setScanCount(scanned);setComplete(batch.complete);if(batch.complete||batch.paused||batch.scanned===0)break;
        await new Promise<void>(resolve=>setTimeout(resolve,250));
      }
    }catch(error){if(mounted.current)onError(normalizeError(error));}finally{scanActive.current=false;if(mounted.current)setScanning(false);}
  };
  useEffect(()=>{const timer=window.setTimeout(()=>void scan(),500);return()=>clearTimeout(timer);},[workspace.id,workspace.epoch]);
  const createTarget=rows.find(row=>row.entry.path===active)?.entry??{path:'',name:'',kind:'directory' as const,paper:'unknown' as const,main:false};
  const dropAssets=async(files:File[],targetDir:string)=>{
    if(importing.current)return;importing.current=true;
    try{
      if(beforeMutation&&!await beforeMutation())return;
      if(targetDir.split('/').some(part=>['.git','.texypaper','.paperdock'].includes(part.toLowerCase())))throw {code:'PATH_RESERVED',message:t('비공개 프로젝트 폴더에는 가져올 수 없습니다.','Cannot import into private project folders.'),retryable:false};
      const existingNames=new Set<string>();let cursor:string|undefined;
      do{const page=await request<{entries:Entry[];nextCursor?:string}>('directory_list',workspace,{path:targetDir,cursor,showHidden:true});for(const entry of page.entries)existingNames.add(entry.name);cursor=page.nextCursor;}while(cursor);
      const result:AssetImportResult={imported:[],failed:[]};
      // Read one OS file at a time; large drops must not allocate the whole batch.
      for(const file of files){
        if(!mounted.current||assetWorkspace.current.id!==workspace.id||assetWorkspace.current.epoch!==workspace.epoch)return;
        if(file.size>ASSET_SIZE_LIMIT){result.failed.push({name:file.name,code:'ASSET_TOO_LARGE',message:t('20 MiB 이하 파일만 가져올 수 있습니다.','Files must be at most 20 MiB.')});continue;}
        try{
          const imported=await importAssets({workspace,request,targetDir,existingNames,files:[{name:file.name,bytes:await file.arrayBuffer()}]});
          if(!mounted.current||assetWorkspace.current.id!==workspace.id||assetWorkspace.current.epoch!==workspace.epoch)return;
          result.imported.push(...imported.imported);result.failed.push(...imported.failed);
          for(const item of imported.imported){existingNames.add(item.name);onMutation?.({kind:'create',path:item.path});}
        }catch(error){const failure=normalizeError(error);result.failed.push({name:file.name,code:failure.code,message:failure.message});}
      }
      if(!mounted.current||assetWorkspace.current.id!==workspace.id||assetWorkspace.current.epoch!==workspace.epoch)return;
      setAssetStatus([...result.imported.map(item=>t(`가져옴: ${item.path}`,`Imported: ${item.path}`)),...result.failed.map(item=>t(`가져오기 실패: ${item.name} (${item.code}) — ${item.message}`,`Import failed: ${item.name} (${item.code}) — ${item.message}`))]);
      onAssetImport?.(result);
      if(result.imported.length){index.invalidate(targetDir);await load(targetDir);for(const path of expanded)if(path!==targetDir)await load(path);}
    }catch(error){if(mounted.current&&assetWorkspace.current.id===workspace.id&&assetWorkspace.current.epoch===workspace.epoch){const failure=normalizeError(error);setAssetStatus([t(`가져오기 실패: ${failure.message}`,`Import failed: ${failure.message}`)]);onError(failure);}}
    finally{importing.current=false;}
  };
  return <section className="file-tree-panel" aria-label={t("프로젝트 파일")}>
    <div className="pane-heading"><span>{t('파일','Files')}</span><div className="pane-actions">
      <button className="icon-button" type="button" title={t('프로젝트에 새 파일 만들기','Create a file in the project')} aria-label={t('새 파일','New file')} onClick={()=>void mutate('file',createTarget)}><Icon name="filePlus" size={16}/></button>
      <button className="icon-button" type="button" title={t('새 폴더','New folder')} aria-label={t('새 폴더','New folder')} onClick={()=>void mutate('directory',createTarget)}><Icon name="folderPlus" size={16}/></button>
      <button className="icon-button" type="button" title={t('파일 목록 새로 고침','Refresh files')} aria-label={t('새로 고침','Refresh')} onClick={()=>{for(const path of expanded)void load(path);}}><Icon name="refresh" size={16}/></button>
      <button className="icon-button" type="button" title={t('모든 폴더 접기','Collapse all folders')} aria-label={t('모든 폴더 접기','Collapse all folders')} disabled={expanded.size<=1} onClick={()=>{setExpanded(new Set(['']));setActive('');setScroll(0);if(container.current)container.current.scrollTop=0;}}><Icon name="collapse" size={16}/></button>
    </div></div>
    <div role="tree" aria-label={t("프로젝트 파일 트리")} aria-activedescendant={active?`tree-${encodeURIComponent(active)}`:undefined} tabIndex={0} ref={container} className="tree-scroll" data-testid="file-tree" onDragOver={event=>{
      if(assetDropEnabled&&event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=importing.current?'none':'copy';}
    }} onDrop={event=>{
      if(!assetDropEnabled||!event.dataTransfer.types.includes('Files'))return;
      const files=Array.from(event.dataTransfer.files).filter(file=>/\.(png|jpe?g|gif|webp|svg|pdf|eps)$/i.test(file.name));
      if(!files.length)return;event.preventDefault();
      const path=(event.target as HTMLElement).closest('[data-path]')?.getAttribute('data-path');
      const row=rows.find(item=>item.entry.path===path);
      const targetDir=row?.entry.kind==='directory'?row.entry.path:(index.listings.get('')??[]).some(entry=>entry.kind==='directory'&&entry.name==='figures')?'figures':'';
      void dropAssets(files,targetDir);
    }} onScroll={event=>setScroll(event.currentTarget.scrollTop)} onKeyDown={event=>{
      const position=rows.findIndex(row=>row.entry.path===active);const row=rows[position];
      if(['ArrowDown','ArrowUp','Home','End','ArrowLeft','ArrowRight','Enter','F2','Delete'].includes(event.key))event.preventDefault();
      if(event.key==='ArrowDown')focusRow(position+1);if(event.key==='ArrowUp')focusRow(position-1);if(event.key==='Home')focusRow(0);if(event.key==='End')focusRow(rows.length-1);
      if(!row)return;if(event.key==='ArrowRight'&&row.entry.kind==='directory'){if(!expanded.has(active))toggle(active);else focusRow(position+1);}if(event.key==='ArrowLeft'){if(expanded.has(active))toggle(active);else{const parent=rows.findIndex(item=>item.entry.path===row.parent);focusRow(parent);}}
      if(event.key==='Enter'){if(row.entry.kind==='directory')toggle(active);else onOpen(active);}if(event.key==='F2')void mutate('rename',row.entry);if(event.key==='Delete')void mutate('trash',row.entry);
    }}><div style={{height:rows.length*rowHeight,position:'relative'}}>{rows.slice(start,end).map(({entry,depth},offset)=>{
      const mark=entry.kind==='directory'?index.mark(entry.path):'none',evidence=index.evidence.get(entry.path)??entry.evidence??[];
      const paperHint=mark==='direct'?t('논문 관련 파일 포함','Contains TeX-related files'):mark==='descendant'?t('하위 폴더에 논문 파일 포함','Contains TeX-related files in subfolders'):'';
      return <div key={entry.path} id={`tree-${encodeURIComponent(entry.path)}`} role="treeitem" data-path={entry.path} aria-level={depth+1} aria-expanded={entry.kind==='directory'?expanded.has(entry.path):undefined} aria-selected={selectedPath===entry.path} aria-label={[entry.name,paperHint,mainPath===entry.path?t('주 문서','Main document'):''].filter(Boolean).join(', ')} className={`tree-row paper-${mark} ${selectedPath===entry.path?'selected':''} ${active===entry.path?'keyboard-active':''}`} style={{top:(start+offset)*rowHeight,height:rowHeight,paddingLeft:12+depth*16}} title={[entry.path,paperHint,evidence.join(', ')].filter(Boolean).join('\n')} onClick={()=>{container.current?.focus();setActive(entry.path);if(entry.kind==='directory')toggle(entry.path);else onOpen(entry.path);}} onContextMenu={event=>{event.preventDefault();container.current?.focus();setActive(entry.path);setMenu(entry);}}>
        <span className="file-symbol" aria-hidden="true">{entry.kind==='directory'&&<Icon className="tree-chevron" name={expanded.has(entry.path)?'chevronDown':'chevronRight'} size={12}/>}<FileTypeIcon kind={entry.kind} name={entry.name} open={expanded.has(entry.path)} className={entry.kind==='directory'&&excludedDirectories[entry.name]?'file-icon-excluded':undefined}/></span>
        <span className={`file-label paper-${mark}`}>{entry.name}</span>{(mark==='direct'||mark==='descendant')&&<span className={`paper-badge${mark==='descendant'?' paper-badge-descendant':''}`} title={paperHint} aria-hidden="true">TeX</span>}{mark==='unknown'&&entry.kind==='directory'&&<span className="unknown-mark" title={t("아직 검색하지 않음")}>?</span>}{mainPath===entry.path&&<span className="main-badge">Main</span>}{excludedDirectories[entry.name]&&<span className="unknown-mark" title={t("자동 검색 제외 · 직접 열기 가능")}>{t("제외")}</span>}
      </div>;
    })}</div></div>
    {assetStatus.length>0&&<div className="discovery-status" role="status" aria-live="polite" data-testid="asset-import-status" style={{display:'block',overflowWrap:'anywhere'}}>{assetStatus.map((message,index)=><div key={index}>{message}</div>)}</div>}
    <div className="discovery-status" data-state={complete?'complete':scanning?'scanning':'paused'} data-scanned={scanCount}><span>{complete?t('논문 폴더 검색 완료'):scanning?t('논문 폴더 검색 중…'):t('일부 폴더 미검색')}</span><button disabled={scanning||complete} onClick={()=>void scan(true)}>{complete?t('검색 완료','Discovery complete'):scanning?t('검색 중…','Discovering…'):version>1?t('계속 찾기'):t('논문 찾기')}</button></div>
    {menu&&<div className="tree-context" role="menu" aria-label={menu.path} onKeyDown={event=>{if(event.key==='Escape')setMenu(null);}}><strong>{menu.name}</strong>{menu.path.endsWith('.tex')&&<button role="menuitem" onClick={()=>void mutate('main',menu)}>{t("주 문서로 설정")}</button>}<button role="menuitem" data-testid="context-create-file" onClick={()=>void mutate('file',menu)}>{t("새 파일")}</button><button role="menuitem" onClick={()=>void mutate('directory',menu)}>{t("새 폴더")}</button><button role="menuitem" data-testid="context-rename" onClick={()=>void mutate('rename',menu)}>{t("이름 변경 / 이동")}</button><button role="menuitem" data-testid="context-trash" onClick={()=>void mutate('trash',menu)}>{t("프로젝트 휴지통으로 이동")}</button><button onClick={()=>setMenu(null)}>{t("닫기")}</button></div>}
  </section>;
}
