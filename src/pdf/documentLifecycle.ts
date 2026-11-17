import {PDFWorker} from 'pdfjs-dist';

// Component remounts must not reset the barrier while the previous worker exits.
let pendingTeardown=Promise.resolve();

export function waitForDocumentTeardown(){return pendingTeardown;}

export function queueDocumentTeardown(dispose:()=>Promise<void>){
 const completion=pendingTeardown.then(dispose);
 // Report the original completion at the caller without poisoning later closes.
 pendingTeardown=completion.catch(()=>{});
 return completion;
}

/** One preview owns one worker, but never two live document generations. */
export class DocumentWorker{
 private worker:PDFWorker|null=null;
 private closed=false;
 private completion:Promise<void>|null=null;
 async acquire(){
  await waitForDocumentTeardown();
  if(this.closed)throw new Error('PDF_WORKER_CLOSED');
  if(!this.worker){
   this.worker=new PDFWorker();
   // Loading may be cancelled before getDocument attaches its own rejection handler.
   void this.worker.promise.catch(()=>{});
  }
  return this.worker;
 }
 dispose(dispose:()=>Promise<void>){
  return queueDocumentTeardown(async()=>{
   try{await dispose();}
   catch(cause){await this.destroyWorker();throw cause;}
  });
 }
 close(){
  if(this.completion)return this.completion;
  this.closed=true;
  return this.completion=queueDocumentTeardown(()=>this.destroyWorker());
 }
 private async destroyWorker(){
  const worker=this.worker;this.worker=null;
  if(!worker)return;
  try{await worker.promise;}catch{/* A failed startup still owns a worker handle. */}
  finally{worker.destroy();}
 }
}
