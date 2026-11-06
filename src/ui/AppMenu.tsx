import { useEffect, useRef, useState, type ReactNode } from 'react';
export function AppMenu({label,children,className='',title}:{label:ReactNode;children:ReactNode;className?:string;title?:string}) {
  const ref=useRef<HTMLDetailsElement>(null),[open,setOpen]=useState(false);
  useEffect(()=>{if(!open)return;const close=(event:PointerEvent)=>{if(!ref.current?.contains(event.target as Node))ref.current!.open=false;};const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&ref.current?.open){ref.current.open=false;ref.current.querySelector('summary')?.focus();event.stopPropagation();}};document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};},[open]);
  return <details className={`app-menu ${className}`} ref={ref} onToggle={event=>setOpen(event.currentTarget.open)} onKeyDown={event=>{if((event.target as HTMLElement).closest('input,select,textarea'))return;const buttons=[...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();event.currentTarget.open=true;const index=buttons.indexOf(document.activeElement as HTMLElement),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowDown'?(index+1)%buttons.length:(index-1+buttons.length)%buttons.length;buttons[next]?.focus();}}}>
    <summary role="button" title={title} aria-haspopup="menu" aria-expanded={open}>{label}</summary>
    <div className="app-menu-popover" role="menu" onClick={event=>{if((event.target as HTMLElement).closest('[role="menuitem"]'))ref.current!.open=false;}}>{children}</div>
  </details>;
}
