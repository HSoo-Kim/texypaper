// Component remounts must not reset the barrier while the previous worker exits.
let pendingTeardown=Promise.resolve();

export function waitForDocumentTeardown(){return pendingTeardown;}

export function queueDocumentTeardown(dispose:()=>Promise<void>){
 const completion=pendingTeardown.then(dispose);
 // Report the original completion at the caller without poisoning later closes.
 pendingTeardown=completion.catch(()=>{});
 return completion;
}
