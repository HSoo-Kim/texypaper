import {useEffect,useRef,type RefObject} from 'react';

export function zoomKeyDirection(event:Pick<KeyboardEvent,'ctrlKey'|'metaKey'|'altKey'|'isComposing'|'key'|'code'>):1|-1|0 {
  if(!(event.ctrlKey||event.metaKey)||event.altKey||event.isComposing)return 0;
  if(event.key==='+'||event.key==='='||event.code==='NumpadAdd')return 1;
  if(event.key==='-'||event.code==='NumpadSubtract')return -1;
  return 0;
}

export function clampEditorFontSize(value:number){return Number.isFinite(value)?Math.max(10,Math.min(32,Math.round(value))):14;}

// Pane handlers run first. Everywhere else these gestures must not resize the WebView UI.
export function usePreventBrowserZoom(){
  useEffect(()=>{
    const wheel=(event:WheelEvent)=>{if(event.ctrlKey||event.metaKey)event.preventDefault();};
    const key=(event:KeyboardEvent)=>{if(zoomKeyDirection(event))event.preventDefault();};
    window.addEventListener('wheel',wheel,{passive:false});window.addEventListener('keydown',key);
    return()=>{window.removeEventListener('wheel',wheel);window.removeEventListener('keydown',key);};
  },[]);
}

// One bounded step per wheel event; small trackpad deltas accumulate instead of jumping.
export function createWheelZoom(){
  let accumulated=0,lastTime=0;
  return (event:Pick<WheelEvent,'deltaY'|'deltaMode'|'timeStamp'>,pageHeight:number):1|-1|0=>{
    const pixels=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?Math.max(1,pageHeight):1);
    if(!Number.isFinite(pixels)||pixels===0)return 0;
    if(event.timeStamp-lastTime>250||Math.sign(pixels)!==Math.sign(accumulated))accumulated=0;
    lastTime=event.timeStamp;
    accumulated+=Math.max(-60,Math.min(60,pixels));
    if(Math.abs(accumulated)<60)return 0;
    const direction=accumulated<0?1:-1;accumulated=0;return direction;
  };
}

export function usePaneZoom({root,wheelRoot=root,enabled,onZoom,wheelTarget}:{root:RefObject<HTMLElement|null>;wheelRoot?:RefObject<HTMLElement|null>;enabled:boolean;onZoom:(direction:1|-1)=>void;wheelTarget?:(target:Element)=>boolean}){
  const latest=useRef({enabled,onZoom,wheelTarget});latest.current={enabled,onZoom,wheelTarget};
  useEffect(()=>{
    const node=root.current,wheelNode=wheelRoot.current;if(!node||!wheelNode)return;
    const wheelStep=createWheelZoom();
    const active=()=>latest.current.enabled&&node.getClientRects().length>0&&!node.closest('[inert]')&&!document.querySelector('[aria-modal="true"]');
    const wheel=(event:WheelEvent)=>{
      if(!(event.ctrlKey||event.metaKey)||!active()||!(event.target instanceof Element)||latest.current.wheelTarget?.(event.target)===false)return;
      // Suppress native WebView page zoom even at our pane's limits or below a wheel step.
      event.preventDefault();event.stopPropagation();
      const direction=wheelStep(event,wheelNode.clientHeight);if(direction)latest.current.onZoom(direction);
    };
    const key=(event:KeyboardEvent)=>{
      const direction=zoomKeyDirection(event);if(!direction||event.defaultPrevented||!active())return;
      if(event.target instanceof Element&&event.target.closest('input,textarea,select,[contenteditable="true"]:not(.cm-content)'))return;
      event.preventDefault();event.stopPropagation();latest.current.onZoom(direction);
    };
    wheelNode.addEventListener('wheel',wheel,{passive:false});node.addEventListener('keydown',key,true);
    return()=>{wheelNode.removeEventListener('wheel',wheel);node.removeEventListener('keydown',key,true);};
  },[root,wheelRoot]);
}
