export type PdfRangeRequest={begin:number;end:number};
export const PDF_RANGE_CHUNK=65536;
/** PDF.js 6.5 consumes one complete payload for each requested range reader. */
export async function fulfillPdfRange(
 request:PdfRangeRequest,
 readChunk:(begin:number,end:number)=>Promise<Uint8Array>,
 deliver:(begin:number,bytes:Uint8Array)=>void,
 signal:AbortSignal,
){
 const {begin,end}=request;
 if(!Number.isSafeInteger(begin)||!Number.isSafeInteger(end)||begin<0||end<=begin)throw new Error('PDF_RANGE_INVALID');
 if(signal.aborted)throw new DOMException('Cancelled','AbortError');
 // The common single-chunk request transfers its fetched buffer without copying.
 if(end-begin<=PDF_RANGE_CHUNK){
  const bytes=await readChunk(begin,end);
  if(signal.aborted)throw new DOMException('Cancelled','AbortError');
  if(bytes.length!==end-begin)throw new Error('PDF_RANGE_TRUNCATED');
  deliver(begin,bytes);return;
 }
 // Do not retain individual fetched chunks. Only this requested interval is
 // assembled, then its owned buffer is handed to PDF.js for worker transfer.
 const bytes=new Uint8Array(end-begin);
 for(let offset=begin;offset<end;offset+=PDF_RANGE_CHUNK){
  const stop=Math.min(offset+PDF_RANGE_CHUNK,end);
  const chunk=await readChunk(offset,stop);
  if(signal.aborted)throw new DOMException('Cancelled','AbortError');
  if(chunk.length!==stop-offset)throw new Error('PDF_RANGE_TRUNCATED');
  bytes.set(chunk,offset-begin);
 }
 deliver(begin,bytes);
}
