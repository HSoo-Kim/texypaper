import {useEffect,useRef,useState} from 'react';
import type {WorkspaceRef} from '../../contracts';
import {request} from '../../api';
import {useI18n} from '../../ui/i18n';
import {createAutomaticCheckpoint} from '../history/checkpoints';
type Exact={kind:'exact';file:{path:string};line1:number;startByte:number;endByte:number;baseSha256:string;sourceText:string;proofId:string};
type Mapping=Exact|{kind:'ambiguous';candidates:{path?:string;file?:{path:string};line1?:number;line?:number}[];reason:string}|{kind:'unavailable';code:string;reason:string};
const TEX_ESCAPES:Record<string,string>={'\\':'\\textbackslash{}','{':'\\{','}':'\\}','$':'\\$','&':'\\&','#':'\\#','%':'\\%','_':'\\_','^':'\\textasciicircum{}','~':'\\textasciitilde{}'};
export type SourceEditReviewProps={workspace:WorkspaceRef;selection:unknown;onClose:()=>void;onApplied?:()=>void;onNavigate?:(location:{path:string;line1:number})=>void};
export function SourceEditReview({workspace,selection,onClose,onApplied,onNavigate}:SourceEditReviewProps){const {t,locale}=useI18n();const [mapping,setMapping]=useState<Mapping|null>(null),[text,setText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[applied,setApplied]=useState(false);const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{dialog.current?.showModal();let cancelled=false;setBusy(true);void request<Mapping>('pdf_map_selection',workspace,selection).then(result=>{if(cancelled)return;setMapping(result);if(result.kind==='exact')setText(result.sourceText);}).catch(cause=>{if(!cancelled)setError(cause&&typeof cause==='object'&&'message'in cause?String(cause.message):String(cause));}).finally(()=>{if(!cancelled)setBusy(false);});return()=>{cancelled=true;dialog.current?.close();};},[workspace.id,workspace.epoch,selection]);
 const escapedPreview=text.replace(/[\\{}$&#%_^~]/g,character=>TEX_ESCAPES[character]);
 async function apply(){
  if(mapping?.kind!=='exact')return;setBusy(true);setError('');
  try{
   try{await createAutomaticCheckpoint({workspace,request,paths:[mapping.file.path],reason:'pdf-edit'});}
   catch{setError(t('자동 체크포인트를 저장하지 못해 원문을 변경하지 않았습니다. 저장 공간과 연결을 확인한 뒤 다시 적용하거나 원문 편집기를 사용하세요.','The source was not changed because its automatic checkpoint could not be saved. Check storage and the connection, then retry or use the source editor.'));return;}
   const result=await request<{rootTex:string;engine:string;path:string;line1:number}>('pdf_apply_edit',workspace,{proofId:mapping.proofId,text});setApplied(true);onApplied?.();
   const build=await request<{status:string;manifest?:{buildId:string}}>('build_start',workspace,{rootTex:result.rootTex,engine:result.engine});
   if(build.status!=='published'||!build.manifest){setError(t('원문은 저장되었지만 새 PDF가 아직 게시되지 않았습니다. 빌드 상태를 확인하세요.','The source was saved, but a new PDF has not been published. Check the build status.'));return;}
   onNavigate?.({path:result.path,line1:result.line1});
   try{const location=await request('sync_forward',workspace,{buildId:build.manifest.buildId,file:result.path,line1:result.line1});window.dispatchEvent(new CustomEvent('texypaper:sync-forward',{detail:location}));}catch{setError(t('원문과 새 PDF는 저장되었습니다. 새 위치의 SyncTeX 매핑이 없어 자동 이동할 수 없습니다.','The source and new PDF were saved. SyncTeX has no match for the new position, so automatic navigation is unavailable.'));return;}
   onClose();
  }catch(cause){setError(cause&&typeof cause==='object'&&'code'in cause?String(cause.code)+': '+t('원문 변경을 확인하고 다시 선택하세요.','Check source changes and select again.'):t('변경을 적용할 수 없습니다. 연결 상태를 확인하세요.','The change could not be applied. Check the connection.'));}finally{setBusy(false);}
 }
 return <dialog ref={dialog} className="source-edit-review" aria-label={t('원문 수정 검토','Review source edit')} onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
  <header><h2>{t('원문 수정 검토','Review source edit')}</h2><button disabled={busy} onClick={onClose} aria-label={t('닫기','Close')}>×</button></header>
  {busy&&!mapping&&<p role="status">{t('원문과 PDF 위치를 검증하고 있습니다…','Verifying the source and PDF positions…')}</p>}
  {error&&<p role="alert" data-testid="pdf-edit-error">{error}</p>}
  {mapping?.kind==='exact'?<>
   <p><code>{mapping.file.path}</code> · {mapping.startByte}–{mapping.endByte} {t('바이트','bytes')}</p>
   <p>{t('일반 텍스트로 변경합니다. TeX 특수문자는 안전하게 이스케이프됩니다. 명령이나 수식을 직접 바꾸려면 원문 편집기를 사용하세요.','Changes are plain text. TeX special characters are escaped. Use the source editor to change commands or equations.')}</p>
   <div className="source-edit-diff"><section><h3>{t('변경 전','Before')}</h3><pre>{mapping.sourceText}</pre></section><section><h3>{t('변경 후','After')}</h3><label>{t('바꿀 텍스트','Replacement text')}<textarea aria-label={t('바꿀 텍스트','Replacement text')} value={text} onChange={event=>setText(event.target.value)} disabled={busy||applied} autoFocus/></label><pre aria-label={t('변경 후 TeX','Resulting TeX')}>{escapedPreview}</pre></section></div>
   <footer><button disabled={busy} onClick={()=>onNavigate?.({path:mapping.file.path,line1:mapping.line1})}>{t('원문 열기','Open source')}</button><button data-testid="pdf-edit-apply" disabled={busy||applied||text===mapping.sourceText} onClick={()=>void apply()}>{busy?t('적용 및 재빌드 중…','Applying and rebuilding…'):t('변경 적용','Apply change')}</button></footer>
  </>:mapping&&<div role="status"><p>{locale==='ko'?mapping.reason:t('이 선택을 안전한 단일 원문 범위로 증명할 수 없습니다. 파일은 변경되지 않았습니다. 원문에서 범위를 명시적으로 선택하세요.','This selection cannot be proved to match one safe source interval. No files were changed. Open the source and select an explicit range.')}</p>
   {mapping.kind==='unavailable'&&<code>{mapping.code}</code>}
   {mapping.kind==='ambiguous'&&mapping.candidates.map((candidate,index)=>{const path=candidate.path??candidate.file?.path;if(!path)return null;return <button key={`${path}:${index}`} onClick={()=>onNavigate?.({path,line1:candidate.line1??candidate.line??1})}>{t('원문 열기','Open source')}: {path}:{candidate.line1??candidate.line??1}</button>;})}
   <button disabled={busy} onClick={onClose}>{t('닫기','Close')}</button>
  </div>}
 </dialog>;
}
