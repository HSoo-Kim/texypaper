import { useEffect, useRef, useState } from 'react';
import type { AppError, Entry, WorkspaceRef } from '../../contracts';
import { normalizeError, request } from '../../api';
import { t } from '../../ui/i18n';
import { Icon } from '../../ui/Icon';
import { checkpointLabel, collectSnapshot, collectTargetSnapshot, compareWithCurrent, createCheckpoint, discoverEntries, restoreFiles, type Checkpoint, type CheckpointSummary, type Snapshot } from './checkpoints';
import { diffLines } from './diffLines';
import './history.css';

type Props={workspace:WorkspaceRef;entries:Entry[];flush:()=>Promise<boolean>;onRestored:(paths:string[])=>void;onError:(error:AppError)=>void;active:boolean};
type Comparison={checkpoint:Checkpoint;current:Snapshot};
function relativeTime(timestamp:string){const seconds=Math.round((new Date(timestamp).getTime()-Date.now())/1000),absolute=Math.abs(seconds);const [unit,size]:[Intl.RelativeTimeFormatUnit,number]=absolute<60?['second',1]:absolute<3600?['minute',60]:absolute<86400?['hour',3600]:['day',86400];return new Intl.RelativeTimeFormat(t('ko','en'),{numeric:'auto'}).format(Math.round(seconds/size),unit);}
export function CheckpointsPanel({workspace,entries,flush,onRestored,onError,active}:Props){
 const [rows,setRows]=useState<CheckpointSummary[]>([]),[name,setName]=useState(''),[busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false),[notice,setNotice]=useState(''),[comparison,setComparison]=useState<Comparison|null>(null),[selected,setSelected]=useState<string[]>([]),[file,setFile]=useState<string>(),[undo,setUndo]=useState<{id:string;paths:string[]}>();
 const [filter,setFilter]=useState<'all'|'manual'|'auto'>('all');
 const generation=useRef(0),errorRef=useRef(onError);errorRef.current=onError;
 useEffect(()=>{generation.current++;setRows([]);setComparison(null);setLoaded(false);setNotice('');setUndo(undefined);setBusy(false);},[workspace.id,workspace.epoch]);
 useEffect(()=>{if(!active)return;let cancelled=false;const current=generation.current;void request<CheckpointSummary[]>('checkpoint_list',workspace).then(value=>{if(!cancelled&&current===generation.current){setRows(value);setLoaded(true);}}).catch(error=>{if(!cancelled&&current===generation.current)errorRef.current(normalizeError(error));});return()=>{cancelled=true;};},[active,workspace.id,workspace.epoch]);
 useEffect(()=>()=>{generation.current++;},[]);
 const reload=async()=>{const current=generation.current,value=await request<CheckpointSummary[]>('checkpoint_list',workspace);if(current===generation.current){setRows(value);setLoaded(true);}};
 const run=async(action:()=>Promise<void>)=>{if(busy)return;const current=generation.current;setBusy(true);try{await action();}catch(error){if(current===generation.current)errorRef.current(normalizeError(error));}finally{if(current===generation.current)setBusy(false);}};
 const create=()=>run(async()=>{if(!await flush())return;const current=generation.current,all=await discoverEntries({workspace,request}),result=await createCheckpoint({workspace,request,entries:all,name:name.trim()||`${t('체크포인트','Checkpoint')} ${new Date().toLocaleString()}`});if(current!==generation.current)return;setName('');setNotice(`${t('체크포인트를 만들었습니다.','Checkpoint created.')} ${result.pruned.length?`${result.pruned.length} ${t('개의 오래된 체크포인트가 삭제되었습니다.','older checkpoints pruned.')}`:''} ${result.skipped.length?`${result.skipped.length} ${t('개 파일 제외','files skipped')}: ${result.skipped.map(item=>`${item.path} (${item.reason})`).join('; ')}`:''}`);await reload();});
 const compare=(row:CheckpointSummary)=>run(async()=>{const current=generation.current,checkpoint=await request<Checkpoint>('checkpoint_get',workspace,{id:row.id}),snapshot=checkpoint.partial?await collectTargetSnapshot({workspace,request,paths:checkpoint.files.map(file=>file.path)}):await collectSnapshot({workspace,request,entries:await discoverEntries({workspace,request})});if(current!==generation.current)return;setComparison({checkpoint,current:snapshot});setSelected([]);const diff=compareWithCurrent(checkpoint,snapshot);setFile(diff.changed[0]?.path??diff.removed[0]?.path??diff.added[0]);setNotice(snapshot.skipped.length?`${t('읽지 못한 파일은 비교에서 제외됩니다.','Unreadable files are excluded from comparison.')} ${snapshot.skipped.map(item=>`${item.path}: ${item.reason}`).join('; ')}`:'');});
 const restore=(paths:string[])=>{
  if(!comparison||busy)return;
  const checkpoint=comparison.checkpoint;
  if(!window.confirm(`${t('다음 파일을 복원할까요?','Restore these files?')}\n\n${paths.join('\n')}\n\n${t("먼저 'Before restore' 체크포인트를 만들고 복원 후 실행 취소를 제공합니다. 이후 추가된 파일은 삭제하지 않습니다.","A 'Before restore' checkpoint is created first, and Undo is offered afterward. Files added later are never deleted.")}`))return;
  void run(async()=>{
   const current=generation.current;if(!await flush()||current!==generation.current)return;
   try{
    const result=await restoreFiles({workspace,request,entries,checkpoint,paths});if(current!==generation.current)return;
    setUndo({id:result.transactionId,paths:result.paths});
    setNotice(`${t(`파일 ${result.paths.length}개 복원 완료`,`Restored ${result.paths.length} files`)}${result.backup.pruned.length?` · ${result.backup.pruned.length} ${t('개 오래된 체크포인트 삭제','older checkpoints pruned')}`:''}`);
    setComparison(null);onRestored(result.paths);
   }finally{await reload();}
  });
 };
 const diff=comparison?compareWithCurrent(comparison.checkpoint,comparison.current):null;
 const restorable=diff?[...diff.changed.map(item=>item.path),...diff.removed.map(item=>item.path)]:[];
 const before=comparison?.checkpoint.files.find(item=>item.path===file)?.text??'',after=comparison?.current.files.find(item=>item.path===file)?.text??'';
 const hunks=file?diffLines(before,after):[],lineLimit=2000,blockReplace=hunks.some(hunk=>hunk.blockReplace);
 const displayLines=hunks.flatMap(hunk=>hunk.blockReplace?hunk.lines.map(line=>{
  let end=0,count=0;while(count<lineLimit/2){const next=line.text.indexOf('\n',end);if(next<0){end=line.text.length;break;}end=next+1;count++;}
  return {...line,text:line.text.slice(0,end)};
 }):hunk.lines);
 return <section className="checkpoint-panel" aria-label={t('체크포인트 기록','Checkpoint history')} hidden={!active} aria-busy={busy}>
  <div className="pane-heading"><strong><Icon name="history" size={16}/> {t('체크포인트','Checkpoints')}</strong></div>
  <form className="checkpoint-create" onSubmit={event=>{event.preventDefault();void create();}}><label>{t('체크포인트 이름','Checkpoint name')}<input value={name} maxLength={120} onChange={event=>setName(event.target.value)} placeholder={`${t('체크포인트','Checkpoint')} ${new Date().toLocaleString()}`} disabled={busy}/></label><button type="submit" data-testid="checkpoint-create" disabled={busy}>{t('체크포인트 만들기','Create checkpoint')}</button></form>
  <p className="checkpoint-hint">{t('수동 50개 · 자동 20개를 각각 보관합니다. 자동 기록은 변경할 파일만 최대 16개 저장하며 수동 기록을 지우지 않습니다.','Keep 50 manual and 20 automatic checkpoints separately. Automatic snapshots include only up to 16 targeted files and never evict manual history.')}</p>
  <label className="checkpoint-filter">{t('기록 필터','History filter')}<select data-testid="checkpoint-filter" value={filter} disabled={busy} onChange={event=>setFilter(event.target.value as typeof filter)}><option value="all">{t('모든 기록','All history')}</option><option value="manual">{t('수동','Manual')}</option><option value="auto">{t('자동','Automatic')}</option></select></label>
  {busy&&<p role="status">{t('처리 중…','Working…')}</p>}
  {notice&&<p className="checkpoint-notice" role="status">{notice}</p>}
  {undo&&<div className="checkpoint-undo"><button data-testid="checkpoint-undo" disabled={busy} onClick={()=>void run(async()=>{if(!await flush())return;const current=generation.current;await request('undo_transaction',workspace,{transactionId:undo.id});if(current!==generation.current)return;onRestored(undo.paths);setUndo(undefined);setComparison(null);setNotice(t('복원을 실행 취소했습니다.','Restore undone.'));})}><Icon name="undo" size={14}/> {t('실행 취소','Undo')}</button></div>}
  {!loaded&&!busy&&<p>{t('기록 불러오는 중…','Loading history…')}</p>}
  {loaded&&!rows.length&&<p className="checkpoint-empty">{t('체크포인트가 없습니다. 중요한 수정 전에 현재 상태를 저장하세요.','No checkpoints yet. Save the current state before an important edit.')}</p>}
  <ul className="checkpoint-list">{rows.filter(row=>filter==='all'||(row.kind??'manual')===filter).map(row=><li key={row.id} data-testid="checkpoint-row" data-checkpoint-kind={row.kind??'manual'} className={row.kind==='auto'?'checkpoint-auto':undefined}><strong>{row.corrupt?t('손상된 체크포인트','Corrupt checkpoint'):checkpointLabel(row)}</strong>{!row.corrupt&&<><time dateTime={row.createdAt} title={new Date(row.createdAt).toLocaleString()}>{relativeTime(row.createdAt)} · {new Date(row.createdAt).toLocaleString()}</time><span>{row.fileCount} {t('개 파일','files')}{row.partial&&<> · {t('일부 파일 기록','Partial snapshot')}</>}</span></>}<div className="checkpoint-actions"><button data-testid="checkpoint-compare" disabled={busy||row.corrupt} aria-label={`${t('비교','Compare')}: ${checkpointLabel(row)}`} onClick={()=>void compare(row)}>{t('비교','Compare')}</button><button data-testid="checkpoint-delete" disabled={busy} aria-label={`${t('삭제','Delete')}: ${checkpointLabel(row)||row.id}`} onClick={()=>{if(window.confirm(`${t('체크포인트를 삭제할까요? 되돌릴 수 없습니다.','Delete checkpoint? This cannot be undone.')}\n${checkpointLabel(row)||row.id}`))void run(async()=>{await request('checkpoint_delete',workspace,{id:row.id});if(comparison?.checkpoint.id===row.id)setComparison(null);await reload();});}}>{t('삭제','Delete')}</button></div></li>)}</ul>
  {loaded&&rows.length>0&&!rows.some(row=>filter==='all'||(row.kind??'manual')===filter)&&<p>{t('이 필터에 해당하는 기록이 없습니다.','No history matches this filter.')}</p>}
  {comparison&&diff&&<section className="checkpoint-comparison" data-testid="checkpoint-comparison" aria-label={t('체크포인트 비교','Checkpoint comparison')}><h3>{checkpointLabel(comparison.checkpoint)}</h3>{comparison.checkpoint.partial&&<p>{t('이 기록에 포함된 파일만 비교하고 복원합니다. 다른 파일은 그대로 유지됩니다.','Only files included in this snapshot are compared and restored. Other files are kept unchanged.')}</p>}<p>{t('변경','Changed')} {diff.changed.length} · {t('추가','Added')} {diff.added.length} · {t('삭제','Removed')} {diff.removed.length} · {t('동일','Same')} {diff.same}</p>
   <div className="checkpoint-actions"><button data-testid="checkpoint-restore" disabled={busy||!restorable.length||restorable.length>16} onClick={()=>restore(restorable)}>{t('변경 파일 모두 복원','Restore all changed')}</button><button data-testid="checkpoint-restore" disabled={busy||!selected.length||selected.length>16} onClick={()=>restore(selected)}>{t('선택 파일 복원','Restore selected')}</button></div>{restorable.length>16&&<p>{t('한 번에 최대 16개 파일을 선택해 복원하세요.','Select at most 16 files to restore at once.')}</p>}
   <ul className="checkpoint-files">{[...diff.changed.map(item=>({path:item.path,label:t('변경','Changed'),restore:true})),...diff.removed.map(item=>({path:item.path,label:t('삭제','Removed'),restore:true})),...diff.added.map(path=>({path,label:t('추가 (유지)','Added (kept)'),restore:false}))].map(item=><li key={item.path}>{item.restore&&<input type="checkbox" aria-label={`${t('복원 선택','Select for restore')}: ${item.path}`} checked={selected.includes(item.path)} disabled={busy} onChange={event=>setSelected(values=>event.target.checked?[...values,item.path]:values.filter(path=>path!==item.path))}/>}<button aria-pressed={file===item.path} onClick={()=>setFile(item.path)} title={item.path}><span>{item.path}</span><small>{item.label}</small></button></li>)}</ul>
   {file&&<><h3 className="checkpoint-path">{file}</h3>{restorable.includes(file)&&<button data-testid="checkpoint-restore" disabled={busy} onClick={()=>restore([file])}>{t('이 파일 복원','Restore this file')}</button>}
    <div data-testid="checkpoint-diff" className="checkpoint-diff" tabIndex={0} role="region" aria-label={`${t('파일 차이','File diff')}: ${file}`}>
     <pre>{displayLines.slice(0,lineLimit).map((line,index)=><span className={`checkpoint-line ${line.kind}`} key={index}><span className="checkpoint-line-number">{line.beforeLine??''} {line.afterLine??''}</span>{line.kind==='added'?'+':line.kind==='removed'?'-':' '} {line.text}{'\n'}</span>)}</pre>
     {(blockReplace||displayLines.length>lineLimit)&&<p>{t('차이 미리보기는 2,000줄로 제한됩니다. 복원에는 원문 전체를 사용합니다.','Diff preview is limited to 2,000 lines. Restore uses the complete original text.')}</p>}
     {!displayLines.length&&<p>{t('표시할 텍스트 차이가 없습니다.','No text differences to display.')}</p>}
    </div>
   </>}
  </section>}
 </section>;
}
