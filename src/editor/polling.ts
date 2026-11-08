// Remote checks stay quick while working, then settle at six checks/minute.
// Each delay starts after the previous request completes, so slow SSH never overlaps.
export function startWorkspacePolling(options:{remote:boolean;poll:()=>Promise<boolean|void>;visible?:()=>boolean;activityTarget?:EventTarget;visibilityTarget?:EventTarget;hidden?:()=>boolean}) {
  const activityTarget=options.activityTarget??window,visibilityTarget=options.visibilityTarget??document;
  const hidden=options.hidden??(()=>document.hidden);
  let stopped=false,running=false,timer:number|undefined,lastActivity=Date.now(),due=0;
  const delay=()=>hidden()?15000:!options.remote||Date.now()-lastActivity<10000?2000:10000;
  const schedule=()=>{clearTimeout(timer);if(!stopped){const wait=delay();due=Date.now()+wait;timer=window.setTimeout(()=>void tick(),wait);}};
  const tick=async()=>{
    if(stopped||running)return;
    running=true;
    try {if(options.visible?.()!==false&&await options.poll())lastActivity=Date.now();}
    finally {running=false;schedule();}
  };
  const activity=()=>{lastActivity=Date.now();if(!running&&due>Date.now()+delay())schedule();};
  const focus=()=>{lastActivity=Date.now();clearTimeout(timer);void tick();};
  const visibility=()=>{if(!hidden())focus();else if(!running)schedule();};
  activityTarget.addEventListener('focus',focus);
  visibilityTarget.addEventListener('visibilitychange',visibility);
  if(options.remote){activityTarget.addEventListener('pointerdown',activity);activityTarget.addEventListener('keydown',activity);}
  schedule();
  return()=>{stopped=true;clearTimeout(timer);activityTarget.removeEventListener('focus',focus);visibilityTarget.removeEventListener('visibilitychange',visibility);activityTarget.removeEventListener('pointerdown',activity);activityTarget.removeEventListener('keydown',activity);};
}
