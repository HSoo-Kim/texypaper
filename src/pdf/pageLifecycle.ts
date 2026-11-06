import type {PDFPageProxy,RenderTask,TextLayer} from 'pdfjs-dist';

/** Owns only one render generation, including a getPage result arriving after stop. */
export class PageLifecycle{
 private stopped=false;
 private page:Pick<PDFPageProxy,'cleanup'>|null=null;
 private renderTask:Pick<RenderTask,'cancel'|'promise'>|null=null;
 private textLayer:Pick<TextLayer,'cancel'|'render'>|null=null;
 private textPromise:Promise<unknown>|null=null;
 private completion:Promise<void>|null=null;
 constructor(private release:(()=>void)|null){}
 get isStopped(){return this.stopped;}
 adopt(page:Pick<PDFPageProxy,'cleanup'>){
  if(this.stopped){page.cleanup();return false;}
  this.page=page;return true;
 }
 render(task:Pick<RenderTask,'cancel'|'promise'>){this.renderTask=task;return task.promise;}
 renderText(layer:Pick<TextLayer,'cancel'|'render'>){
  if(this.stopped){layer.cancel();return Promise.resolve();}
  this.textLayer=layer;this.textPromise=layer.render();return this.textPromise;
 }
 stopText(){
  const text=this.textLayer,pending=this.textPromise;
  text?.cancel();
  if(!pending){this.textLayer=null;return Promise.resolve();}
  return Promise.allSettled([pending]).then(()=>{
   if(this.textLayer===text){this.textLayer=null;this.textPromise=null;}
  });
 }
 stop(){
  if(this.completion)return this.completion;
  this.stopped=true;
  const page=this.page,task=this.renderTask,text=this.textLayer,release=this.release;
  this.page=null;this.renderTask=null;this.textLayer=null;this.release=null;
  text?.cancel();task?.cancel();
  this.completion=Promise.allSettled([task?.promise,this.textPromise]).then(()=>{
   try{release?.();}finally{page?.cleanup();}
  });
  this.textPromise=null;
  return this.completion;
 }
}
