export const CANVAS_BUDGET=24*1024*1024;
export const MAX_CANVASES=3;
export function boundedPixelRatio(width:number,height:number,desired:number,budget=CANVAS_BUDGET/MAX_CANVASES){if(!(width>0&&height>0&&desired>0))return 1;return Math.min(desired,Math.sqrt(budget/(Math.ceil(width)*Math.ceil(height)*4)));}
export function retainedPages(visible:number,total:number){return [visible-1,visible,visible+1].filter(p=>p>=1&&p<=total);}
export class RenderBudget{
 private canvases=new Map<number,HTMLCanvasElement>();
 retain(page:number,canvas:HTMLCanvasElement){const bytes=()=>Array.from(this.canvases.values()).reduce((n,c)=>n+c.width*c.height*4,0);this.release(page);this.canvases.set(page,canvas);while(this.canvases.size>MAX_CANVASES||bytes()>CANVAS_BUDGET){const oldest=this.canvases.keys().next().value as number|undefined;if(oldest===undefined)break;this.release(oldest);}}
 release(page:number){const canvas=this.canvases.get(page);if(canvas){canvas.width=0;canvas.height=0;this.canvases.delete(page);}}
 clear(){for(const page of this.canvases.keys())this.release(page);}
}
