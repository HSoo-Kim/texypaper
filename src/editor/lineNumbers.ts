import { EditorSelection, type Text } from '@codemirror/state';
import { EditorView, lineNumbers, ViewPlugin } from '@codemirror/view';

// Positions are document offsets, not visual rows: wrapped lines remain indivisible.
export function wholeLineSelection(doc:Text,start:number,end:number) {
  const first=doc.lineAt(Math.max(0,Math.min(doc.length,start)));
  const last=doc.lineAt(Math.max(0,Math.min(doc.length,end)));
  return last.from<first.from
    ?EditorSelection.range(Math.min(doc.length,first.to+1),last.from)
    :EditorSelection.range(first.from,Math.min(doc.length,last.to+1));
}

export function selectableLineNumbers() {
  const dragging=ViewPlugin.define(view=>{
    let start:number|null=null,source=view.state.doc,lastMove=0,pending:MouseEvent|null=null,timer:number|undefined;
    const document=view.dom.ownerDocument;
    const stop=()=>{start=null;pending=null;clearTimeout(timer);timer=undefined;document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',stop);};
    const select=()=>{
      timer=undefined;const event=pending;pending=null;
      if(!event||start===null)return;
      if(event.buttons!==1||view.state.doc!==source){stop();return;}
      lastMove=Date.now();
      const position=view.posAtCoords({x:Math.max(view.contentDOM.getBoundingClientRect().left+1,event.clientX),y:event.clientY});
      if(position!==null)view.dispatch({selection:wholeLineSelection(source,start,position)});
    };
    const move=(event:MouseEvent)=>{
      if(event.buttons!==1){stop();return;}
      pending=event;const remaining=50-(Date.now()-lastMove);
      if(remaining<=0){clearTimeout(timer);select();}else if(timer===undefined)timer=window.setTimeout(select,remaining);
    };
    return {
      start(position:number){
        stop();source=view.state.doc;start=position;lastMove=0;
        view.dispatch({selection:wholeLineSelection(source,start,start)});view.focus();
        document.addEventListener('mousemove',move);document.addEventListener('mouseup',stop);
      },
      destroy:stop,
    };
  });
  return [dragging,lineNumbers({domEventHandlers:{mousedown:(view,line,event)=>{
    if((event as MouseEvent).button!==0)return false;
    event.preventDefault();view.plugin(dragging)?.start(line.from);return true;
  }}})];
}
