import type {PDFPageProxy} from 'pdfjs-dist';
import type {TextContent} from 'pdfjs-dist/types/src/display/api';
import type {PdfTextItem} from './selection';

/** Selection offsets and the DOM must consume the same extraction, in the same order. */
export function selectionTextStream(source:ReadableStream<TextContent>,items:PdfTextItem[]){
 const reader=source.getReader();
 return new ReadableStream<TextContent>({
  async pull(controller){
   try{
    const {value,done}=await reader.read();
    if(done){reader.releaseLock();controller.close();return;}
    for(const item of value.items){
     if('str'in item)items.push({str:item.str,transform:item.transform,width:item.width,height:item.height,hasEOL:item.hasEOL});
    }
    controller.enqueue(value);
   }catch(error){reader.releaseLock();throw error;}
  },
  async cancel(reason){
   try{await reader.cancel(reason);}finally{reader.releaseLock();}
  },
 },{highWaterMark:0});
}

/** Unlike getTextContent, a stopped search can cancel its worker-side reader. */
export async function readPageSearchText(page:Pick<PDFPageProxy,'streamTextContent'>,signal:AbortSignal){
 const cancelled=()=>new DOMException('Cancelled','AbortError');
 if(signal.aborted)throw cancelled();
 const reader:ReadableStreamDefaultReader<TextContent>=page.streamTextContent().getReader();
 const abort=()=>{void reader.cancel(cancelled()).catch(()=>{});};
 signal.addEventListener('abort',abort,{once:true});
 if(signal.aborted)abort();
 try{
  const strings:string[]=[];
  while(true){
   const {value,done}=await reader.read();
   if(signal.aborted)throw cancelled();
   if(done)return strings.join(' ');
   for(const item of value.items)if('str'in item)strings.push(item.str);
  }
 }finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
}
