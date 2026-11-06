import {PDFDataRangeTransport} from 'pdfjs-dist';
export type ArtifactMetadata={length:number;sha256:string;buildId:string;url:string;token?:string};
import {fulfillPdfRange,PDF_RANGE_CHUNK,type PdfRangeRequest} from './rangeRequests';
const CHUNK=PDF_RANGE_CHUNK;
// PDF.js has no remove-listener API; replace its stream listener on terminal abort.
const discardRangeData=()=>{};
export async function createArtifactTransport(metadata:ArtifactMetadata,signal:AbortSignal){
  const lifetime=new AbortController();
  let transport:ScopedTransport|null=null;
  const abort=()=>{lifetime.abort();transport?.abort();};
  if(signal.aborted)throw new DOMException('Cancelled','AbortError');
  signal.addEventListener('abort',abort,{once:true});
  const controllers=new Set<AbortController>();
  async function chunk(begin:number,end:number){
    if(lifetime.signal.aborted)throw new DOMException('Cancelled','AbortError');
    const controller=new AbortController();controllers.add(controller);
    const abort=()=>controller.abort();lifetime.signal.addEventListener('abort',abort,{once:true});
    try{const response=await fetch(metadata.url,{headers:{Range:`bytes=${begin}-${end-1}`},signal:controller.signal});
      if(response.status!==206)throw new Error(`PDF_RANGE_${response.status}`);
      const expected=`bytes ${begin}-${end-1}/${metadata.length}`;
      if(response.headers.get('Content-Range')!==expected)throw new Error('PDF_RANGE_MISMATCH');
      const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length!==end-begin)throw new Error('PDF_RANGE_TRUNCATED');return bytes;
    }finally{controllers.delete(controller);lifetime.signal.removeEventListener('abort',abort);}
  }
  class ScopedTransport extends PDFDataRangeTransport{
    private stopped=false;private queue:PdfRangeRequest[]=[];private running=0;
    constructor(initial:Uint8Array){super(metadata.length,initial,metadata.length===initial.length);}
    override transportReady(listener:unknown){super.transportReady(this.stopped?discardRangeData:listener);}
    override requestDataRange(begin:number,end:number){
      if(this.stopped)return;
      if(!Number.isSafeInteger(begin)||!Number.isSafeInteger(end)||begin<0||end<=begin||end>metadata.length){this.report(new Error('PDF_RANGE_INVALID'));return;}
      if(this.queue.length>=256){this.report(new Error('PDF_RANGE_QUEUE_LIMIT'));return;}
      this.queue.push({begin,end});this.pump();
    }
    private pump(){
      while(!this.stopped&&this.running<2&&this.queue.length){
        const request=this.queue.shift()!;this.running++;
        void fulfillPdfRange(request,chunk,(begin,bytes)=>{if(!this.stopped)this.onDataRange(begin,bytes);},lifetime.signal)
          .catch(error=>{if(!this.stopped)this.report(error);})
          .finally(()=>{this.running--;this.pump();});
      }
    }
    private report(error:unknown){this.abort();window.dispatchEvent(new CustomEvent('texypaper:pdf-error',{detail:error}));}
    override abort(){
      if(this.stopped)return;this.stopped=true;this.queue.length=0;
      signal.removeEventListener('abort',abort);transport=null;lifetime.abort();
      for(const controller of controllers)controller.abort();controllers.clear();
      this.initialData=null;super.transportReady(discardRangeData);
    }
  }
  try{
    const initial=await chunk(0,Math.min(CHUNK,metadata.length));
    if(lifetime.signal.aborted)throw new DOMException('Cancelled','AbortError');
    transport=new ScopedTransport(initial);return transport;
  }catch(error){signal.removeEventListener('abort',abort);lifetime.abort();controllers.clear();throw error;}
}
