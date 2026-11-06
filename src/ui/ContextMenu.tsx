import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type ContextMenuItem={id:string;label:string;shortcut?:string;disabled?:boolean;onSelect:()=>void}|{id:string;separator:true};
type Action=Exclude<ContextMenuItem,{separator:true}>;
const isAction=(item:ContextMenuItem):item is Action=>!('separator' in item);

// Opens at the pointer, keeps focus handling keyboard-safe and hands focus back to the pane it came from
// before an action runs (clipboard commands need the editor focused).
export function ContextMenu({x,y,label,items,onClose}:{x:number;y:number;label:string;items:ContextMenuItem[];onClose:()=>void}){
  const root=useRef<HTMLDivElement>(null),origin=useRef<HTMLElement|null>(null),close=useRef(onClose);close.current=onClose;
  const [position,setPosition]=useState({left:x,top:y});
  useLayoutEffect(()=>{
    const node=root.current;if(!node)return;
    origin.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const box=node.getBoundingClientRect();
    setPosition({left:Math.max(4,Math.min(x,window.innerWidth-box.width-4)),top:Math.max(4,Math.min(y,window.innerHeight-box.height-4))});
    node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});
  },[x,y]);
  useEffect(()=>{
    const dismiss=()=>close.current();
    const outside=(event:Event)=>{if(!(event.target instanceof Node)||!root.current?.contains(event.target))dismiss();};
    window.addEventListener('pointerdown',outside,true);window.addEventListener('blur',dismiss);window.addEventListener('resize',dismiss);window.addEventListener('scroll',dismiss,true);window.addEventListener('wheel',dismiss,{passive:true});
    return()=>{
      window.removeEventListener('pointerdown',outside,true);window.removeEventListener('blur',dismiss);window.removeEventListener('resize',dismiss);window.removeEventListener('scroll',dismiss,true);window.removeEventListener('wheel',dismiss);
      if(!document.activeElement||document.activeElement===document.body)origin.current?.focus({preventScroll:true});
    };
  },[]);
  const choose=(item:Action)=>{origin.current?.focus({preventScroll:true});origin.current=null;close.current();item.onSelect();};
  return <div ref={root} className="context-menu" role="menu" aria-label={label} style={position} onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{
    const buttons=[...(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[])],index=buttons.indexOf(document.activeElement as HTMLButtonElement);
    if(event.key==='Escape'||event.key==='Tab'){event.preventDefault();event.nativeEvent.stopPropagation();close.current();return;}
    const move=event.key==='ArrowDown'?index+1:event.key==='ArrowUp'?index-1:event.key==='Home'?0:event.key==='End'?buttons.length-1:null;
    if(move===null||!buttons.length)return;
    event.preventDefault();buttons[(move+buttons.length)%buttons.length].focus();
  }}>
    {items.map(item=>isAction(item)?<button key={item.id} type="button" role="menuitem" disabled={item.disabled} onClick={()=>choose(item)}><span>{item.label}</span>{item.shortcut&&<kbd>{item.shortcut}</kbd>}</button>:<hr key={item.id} role="separator"/>)}
  </div>;
}
