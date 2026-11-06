import {useEffect,useRef} from 'react';
import {useI18n} from '../../ui/i18n';
export type SelectionPopoverProps={selection:unknown;onSource:()=>void;onEdit:()=>void;onAi:()=>void;onComment:()=>void;onClose:()=>void};
export function SelectionPopover({selection,onSource,onEdit,onAi,onComment,onClose}:SelectionPopoverProps){
 const {t}=useI18n();const panel=useRef<HTMLDivElement>(null),closeCallback=useRef(onClose);closeCallback.current=onClose;
 useEffect(()=>{const previous=document.activeElement;panel.current?.querySelector('button')?.focus();const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();closeCallback.current();}};window.addEventListener('keydown',close);return()=>{window.removeEventListener('keydown',close);if(previous instanceof HTMLElement)previous.focus();};},[]);
 if(!selection)return null;
 return <div ref={panel} className="pdf-selection-popover" role="dialog" aria-label={t('선택한 PDF 텍스트','Selected PDF text')}>
  <button data-testid="pdf-selection-view-source" onClick={onSource}>{t('원문 보기','View source')}</button><button onClick={onEdit}>{t('텍스트 수정','Edit text')}</button><button onClick={onAi}>{t('AI로 수정','Edit with AI')}</button><button onClick={onComment}>{t('댓글','Comment')}</button><button aria-label={t('선택 닫기','Close selection')} onClick={onClose}>×</button>
 </div>;
}
