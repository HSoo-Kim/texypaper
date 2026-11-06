import { errorText } from '../../ui/errors';
import { t } from "../../ui/i18n";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppError, BuildManifest, CommentThread, WorkspaceRef } from '../../contracts';
import { normalizeError, request } from '../../api';
import type { SourceSelection } from '../../editor/buffers';
export type CommentSelection={source?:SourceSelection;pdf?:CommentThread['pdf']};
type CommentFile={version:1;revision:string;threads:CommentThread[]};
type Props={workspace:WorkspaceRef;selection?:CommentSelection|null;selectionVersion?:number;onNavigate:(thread:CommentThread)=>void;onError:(error:AppError)=>void;manifest?:BuildManifest|null;refreshKey?:number;focusThreadId?:string;displayedPdf?:{buildId:string;pdfSha256:string}|null;};
export function CommentsPanel({workspace,selection,selectionVersion,onNavigate,onError,manifest,refreshKey,focusThreadId,displayedPdf}:Props){
  const [file,setFile]=useState<CommentFile|null>(null),[text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<AppError|null>(null),[filter,setFilter]=useState('open'),[page,setPage]=useState(0),[replyTo,setReplyTo]=useState<string|null>(null);
  const mounted=useRef(true),loadSequence=useRef(0),composer=useRef<HTMLTextAreaElement>(null),latest=useRef(file);latest.current=file;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;loadSequence.current++;latest.current=null;};},[]);
  const load=useCallback(async()=>{try{const sequence=++loadSequence.current;const value=await request<CommentFile>('comments_read',workspace);if(!mounted.current||sequence!==loadSequence.current)return;setFile(value);setError(null);}catch(error){if(!mounted.current)return;const value=normalizeError(error);setError(value);onError(value);}},[workspace,onError]);
  useEffect(()=>{void load();},[load,refreshKey]);
  useEffect(()=>{
    if(!manifest)return;let cancelled=false;loadSequence.current++;
    void(async()=>{let cursor:number|undefined;do{const result=await request<{comments:CommentFile;nextCursor:number|null;warnings?:{error:AppError}[]}>('comments_refresh_pdf',workspace,{buildId:manifest.buildId,cursor});if(cancelled)return;setFile(result.comments);if(result.warnings?.[0])onError(result.warnings[0].error);cursor=result.nextCursor??undefined;}while(cursor!==undefined&&!cancelled);})().catch(error=>{if(!cancelled)onError(normalizeError(error));});
    return()=>{cancelled=true;};
  },[manifest?.buildId,workspace.id,workspace.epoch,onError]);
  useEffect(()=>{
    if(!displayedPdf)return;
    const marks=(file?.threads??[]).slice(page*30,(page+1)*30).flatMap(thread=>thread.pdf?.pdfSha256===displayedPdf.pdfSha256?[{threadId:thread.id,page:thread.pdf.page,rects:thread.pdf.rects,status:thread.status}]:[]);
    window.dispatchEvent(new CustomEvent('texypaper:comment-marks',{detail:{buildId:displayedPdf.buildId,pdfSha256:displayedPdf.pdfSha256,marks}}));
  },[file,displayedPdf,page]);
  useEffect(()=>{if(focusThreadId){const target=document.getElementById(`comment-${focusThreadId}`);target?.scrollIntoView({block:'nearest'});target?.focus();}},[focusThreadId,file]);
  useEffect(()=>{if(selectionVersion)composer.current?.focus();},[selectionVersion]);
  const save=async(threads:CommentThread[])=>{
    if(!latest.current||busy)return false;setBusy(true);try{const saved=await request<CommentFile>('comments_update',workspace,{expectedRevision:latest.current.revision,threads,transactionId:crypto.randomUUID()});if(!mounted.current)return true;setFile(saved);setError(null);return true;}catch(error){if(mounted.current){const value=normalizeError(error);setError(value);onError(value);}return false;}finally{if(mounted.current)setBusy(false);}
  };
  const send=async()=>{
    if(!text.trim()||!file)return;const now=new Date().toISOString(),message={id:crypto.randomUUID(),author:'me' as const,text:text.trim(),createdAt:now,updatedAt:now};
    const threads=replyTo?file.threads.map(thread=>thread.id===replyTo?{...thread,messages:[...thread.messages,message]}:thread):[{id:crypto.randomUUID(),status:'open' as const,...(selection??{}),messages:[message]},...file.threads];
    if(await save(threads)){setText('');setReplyTo(null);}
  };
  const change=(id:string,patch:Partial<CommentThread>)=>file&&void save(file.threads.map(thread=>thread.id===id?{...thread,...patch}:thread));
  const filtered=(file?.threads??[]).filter(thread=>filter==='all'||thread.status===filter),visible=filtered.slice(page*30,(page+1)*30);
  return <section className="comments-panel" aria-label={t("댓글")}>
    <div className="inspector-subheading"><label>{t("댓글 상태")}<select value={filter} onChange={event=>{setFilter(event.target.value);setPage(0);}}><option value="open">{t("미해결")}</option><option value="resolved">{t("해결됨")}</option><option value="orphaned">{t("연결 끊김")}</option><option value="all">{t("전체")}</option></select></label><button disabled={busy} onClick={()=>void load()}>{t("새로 고침")}</button></div>
    {error&&<div role="alert" className="inline-error"><strong>{error.code}</strong><p>{errorText(error)}</p>{error.code.includes('CONFLICT')&&<p>{t("외부 댓글 파일이 변경되었습니다. 입력 중인 내용은 유지됩니다.")}</p>}<button onClick={()=>void load()}>{t("디스크 댓글 다시 불러오기")}</button></div>}
    <div className="comments-list">{!file&&!error&&<p className="muted">{t("댓글 불러오는 중…")}</p>}{file&&filtered.length===0&&<p className="empty-small">{t("이 상태의 댓글이 없습니다.")}<br/>{t("소스나 PDF의 텍스트를 선택해 댓글을 남기세요.")}</p>}{visible.map(thread=><article className="comment-thread" key={thread.id} id={`comment-${thread.id}`} tabIndex={-1}>
      <button className="comment-anchor" onClick={()=>onNavigate(thread)} title={t("연결된 위치로 이동")}>{thread.source?.path??(thread.pdf?t(`PDF ${thread.pdf.page}쪽`,`PDF page ${thread.pdf.page}`):t('프로젝트 메모'))}<blockquote>{thread.source?.quote??thread.pdf?.quote??''}</blockquote></button>
      {thread.pdf&&!thread.source&&(!displayedPdf||thread.pdf.pdfSha256!==displayedPdf.pdfSha256)&&<p className="comment-status orphaned">{t('다른 PDF 버전 · 현재 PDF에 배치되지 않음','Different PDF revision · not placed on the current PDF')}</p>}<span className={`comment-status ${thread.status}`}>{thread.status==='open'?t('미해결'):thread.status==='resolved'?t('해결됨'):t('연결 끊김 · 다시 연결 필요')}</span>
      {thread.messages.map(message=><div className="comment-message" key={message.id}><div className="comment-meta"><span>{t("나 ·")}{new Date(message.createdAt).toLocaleString(document.documentElement.lang==='en'?'en-US':'ko-KR')}</span><button aria-label={t("내 댓글 수정")} disabled={busy} onClick={()=>{const updated=window.prompt(t('댓글 수정'),message.text);if(updated!==null)change(thread.id,{messages:thread.messages.map(item=>item.id===message.id?{...item,text:updated,updatedAt:new Date().toISOString()}:item)});}}>{t("수정")}</button><button aria-label={t("내 댓글 삭제")} disabled={busy} onClick={()=>{if(window.confirm(t('이 댓글을 삭제할까요?'))){const messages=thread.messages.filter(item=>item.id!==message.id);if(!messages.length)void save(file!.threads.filter(item=>item.id!==thread.id));else change(thread.id,{messages});}}}>{t("삭제")}</button></div><p>{message.text}</p></div>)}
      <div className="button-row"><button onClick={()=>{setReplyTo(thread.id);composer.current?.focus();}}>{t("답글")}</button><button disabled={busy} onClick={()=>change(thread.id,{status:thread.status==='resolved'?'open':'resolved'})}>{thread.status==='resolved'?t('다시 열기'):t('해결')}</button>{thread.status==='orphaned'&&<button disabled={!selection?.source&&!selection?.pdf} onClick={()=>change(thread.id,{...selection,status:'open'})}>{t("현재 선택에 다시 연결")}</button>}</div>
    </article>)}</div>
    {filtered.length>30&&<div className="pagination"><button disabled={page===0} onClick={()=>setPage(page-1)}>{t("이전")}</button><span>{page+1} / {Math.ceil(filtered.length/30)}</span><button disabled={(page+1)*30>=filtered.length} onClick={()=>setPage(page+1)}>{t("다음")}</button></div>}
    <div className="comment-composer"><label htmlFor="comment-text">{replyTo?t('답글 작성'):selection?.source?t('선택한 소스에 댓글'):selection?.pdf?t('선택한 PDF에 댓글'):t('프로젝트 메모')}</label><textarea id="comment-text" ref={composer} value={text} onChange={event=>setText(event.target.value)} placeholder={t("댓글을 입력하세요")} /><div className="button-row">{replyTo&&<button onClick={()=>setReplyTo(null)}>{t("답글 취소")}</button>}<button className="primary" disabled={busy||!text.trim()||!file} onClick={()=>void send()}>{busy?t('저장 중…'):t('댓글 저장')}</button></div></div>
  </section>;
}
