// Only immutable published-input copies; run through the labnote Python entry point.
import path from 'node:path';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {parseArgs,requireBinary,createRun,launchDesktop,writeJson,assert} from './smoke-support.mjs';
import {quickOpen} from './smoke-desktop.mjs';
const args=parseArgs(),binary=await requireBinary(args),run=await createRun(args,'live-project');
assert(process.env.TEXYPAPER_LAB_MEASUREMENT==='1','Use the labnote entry point.');
assert(typeof args.snapshot==='string'&&typeof args.headless==='string','An immutable input snapshot and matching headless asset are required.');
const verify=args.mode!=='baseline',partialMode=args.mode==='page-priority',project=path.join(run.fixtures,'paper'),sourcePath='paper/TR-C/03_Method/03_methodology.tex',initial='LIVEPROJECTBASE';
await cp(path.resolve(args.snapshot),project,{recursive:true,errorOnExist:true,force:false});
await mkdir(path.join(project,'.texypaper'),{recursive:true});
await writeFile(path.join(project,'.texypaper/project.json'),JSON.stringify({version:1,rootTex:'paper/TR-C/main.tex',engine:'pdflatex',profile:'basic',autoBuild:true}),{flag:'wx'});
await writeFile(path.join(project,'.texypaper-smoke-fixture'),'Owned isolated copy for actual-project interaction verification.\n',{flag:'wx'});
const original=await readFile(path.join(project,sourcePath),'utf8'),template=`\\par\n${initial}.\n\n${original}`;
await writeFile(path.join(project,sourcePath),template);
const proof={complete:false,variant:args.variant,mode:args.mode,sourcePath,samples:[],interaction:{}};
let app;
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
async function selectMarker(page){
 await page.getByTestId('source-editor').locator('.cm-content').focus();
 await page.keyboard.press('Control+Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('Home');await page.keyboard.press('Shift+End');
}
async function arm(page,token){await page.evaluate(token=>{const p=window.__projectProbe;p.sample={token,started:0,done:null,canonicalDone:null,previousId:document.querySelector('.pdf-preview')?.dataset.buildId};},token);}
async function canonical(page){await page.waitForFunction(()=>!!window.__projectProbe.sample?.canonicalDone&&document.querySelector('.pdf-preview')?.dataset.liveReady==='true',null,{timeout:180000,polling:20});}
async function clickPair(page,token,kind){
 const layer=page.locator('[data-testid="pdf-text-layer"][data-ready="true"] span').filter({hasText:token}).first();
 await layer.click({position:{x:10,y:6}});
 await page.waitForFunction(()=>!!document.querySelector('.cm-synctexLine'),null,{timeout:5000});
 assert(await page.getByTestId('source-editor').getAttribute('data-path')===sourcePath,`${kind}: inverse search opened the wrong source.`);
 assert(await page.locator('.cm-synctexLine').textContent().then(text=>text.includes(token)),`${kind}: inverse highlight is not on the clicked paragraph.`);
 assert(await page.locator('.pdf-hit-marker').count()>0,`${kind}: the actual PDF click has no marker.`);
 assert(await page.evaluate(()=>!document.activeElement?.closest('.cm-editor')),`${kind}: automatic inverse search stole editor focus.`);
 await page.screenshot({path:path.join(run.output,`${kind}-inverse.png`)});
 await page.getByTestId('source-editor').locator('.cm-line').filter({hasText:token}).first().click({position:{x:20,y:8}});
 await page.locator('.pdf-sync-marker').waitFor({timeout:5000});
 assert(await page.evaluate(()=>!!document.activeElement?.closest('.cm-editor')),`${kind}: automatic forward search stole editor focus.`);
 assert(await page.locator('.cm-activeLine').count()>0,`${kind}: source click has no active-line highlight.`);
 await page.screenshot({path:path.join(run.output,`${kind}-forward.png`)});
 proof.interaction[kind]=await page.evaluate(()=>({frame:document.querySelector('.pdf-preview')?.dataset.buildId,status:document.querySelector('.pdf-location-status')?.textContent,events:window.__projectProbe.sync.slice(-2)}));
 if(kind==='live')assert(proof.interaction[kind].events.every(event=>event.buildId?.startsWith('live:')),'The supposed live mapping check used a canonical frame.');
}
try{
 app=await launchDesktop({binary,output:run.output,dataDir:run.dataDir,project});const {page}=app;await page.setViewportSize({width:1440,height:900});
 await page.getByTestId('file-tree').waitFor({timeout:30000});await page.getByRole('button',{name:'분할',exact:true}).click();await page.getByRole('button',{name:'작업 패널 닫기',exact:true}).click();await quickOpen(page,sourcePath);
 await page.evaluate(async url=>{
  const module=await import(url),exports=[...Object.values(module),...Object.values(module).filter(v=>v&&typeof v==='object').flatMap(v=>Object.values(v))];
  const Compiler=exports.find(v=>typeof v==='function'&&typeof v.prototype?.compile==='function'&&typeof v.prototype?.init==='function');if(!Compiler)throw new Error('Compiler export missing.');
  const probe=window.__projectProbe={sample:null,compiles:[],previews:[],sync:[],frames:[],burst:null};performance.setResourceTimingBufferSize(8192);
  const compile=Compiler.prototype.compile;Compiler.prototype.compile=function(options){const record={started:performance.now()};probe.compiles.push(record);return compile.call(this,options).then(result=>{Object.assign(record,{finished:performance.now(),success:result.success,pdfBytes:result.pdf?.length??0,errors:result.errors.filter(e=>e.severity==='error'),phaseTimings:result.phaseTimings,heapCheckpointRefusals:result.heapCheckpointRefusals,heapCheckpointRetention:result.heapCheckpointRetention,heapCheckpoints:result.heapCheckpoints});return result;});};
  const previewPages=Compiler.prototype.previewPages;Compiler.prototype.previewPages=function(limit,options){const record={started:performance.now(),limit};probe.previews.push(record);return previewPages.call(this,limit,options).then(result=>{Object.assign(record,{finished:performance.now(),accepted:!!result,pdfBytes:result?.pdf.length??0,firstPage:result?.firstPage??1,compileTime:result?.compileTime,synctexBytes:result?.synctex?.length??0});return result;});};
  document.addEventListener('beforeinput',event=>{const sample=probe.sample;if(sample&&!sample.started&&event.target instanceof Element&&event.target.closest('[data-testid="source-editor"]'))sample.started=performance.now();},true);
  for(const name of ['texypaper:sync-pdf-requested','texypaper:sync-forward'])window.addEventListener(name,event=>probe.sync.push({name,...event.detail}));
  const check=()=>{
   const sample=probe.sample,preview=document.querySelector('.pdf-preview'),status=document.querySelector('[data-testid="build-status"]'),id=preview?.dataset.buildId;if(!id)return;
   const live=preview.dataset.livePreview==='true',layers=[...document.querySelectorAll('[data-testid="pdf-text-layer"][data-ready="true"]')];
   const text=layers.map(node=>node.textContent).join(' '),tokens=[...text.matchAll(/BURST(\d{3})/g)].map(match=>Number(match[1]));
   if(probe.burst&&tokens.length&&!probe.frames.some(frame=>frame.id===id))probe.frames.push({id,at:performance.now(),lastToken:Math.max(...tokens),live});
   if(!sample?.started||id===sample.previousId)return;
   const span=layers.flatMap(layer=>[...layer.querySelectorAll('span')]).find(node=>node.textContent.includes(sample.token));
   const canvas=span?.closest('.pdf-page')?.querySelector('canvas'),rect=span?.getBoundingClientRect(),viewport=preview.querySelector('.pdf-scroll')?.getBoundingClientRect();
   if(!canvas?.width||!canvas?.height||!rect||!viewport||rect.bottom<=viewport.top||rect.top>=viewport.bottom||rect.right<=viewport.left||rect.left>=viewport.right)return;
   if(!sample.done&&(live||id===status?.dataset.buildId))Object.assign(sample,{done:performance.now(),buildId:id,provisional:live,previewKind:preview.dataset.previewKind,previewFirst:Number(preview.dataset.previewFirst??0),previewLast:Number(preview.dataset.previewLast??0),exportDisabled:preview.querySelector('.pdf-export')?.disabled,pageCount:Number(document.querySelector('.pdf-page-count')?.textContent.match(/\d+/)?.[0])});
   if(!live&&id===status?.dataset.buildId&&status.dataset.status==='published'&&!sample.canonicalDone)Object.assign(sample,{canonicalDone:performance.now(),canonicalId:id,canonicalExportDisabled:preview.querySelector('.pdf-export')?.disabled});
  };
  new MutationObserver(check).observe(document.querySelector('#root'),{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-ready','data-build-id','data-status','data-live-preview','data-live-ready']});
 },args.headless);
 const started=Date.now();await page.getByRole('button',{name:'빌드',exact:true}).click();
 await page.waitForFunction(()=>{const status=document.querySelector('[data-testid="build-status"]'),preview=document.querySelector('.pdf-preview');return status?.dataset.status==='published'&&preview?.dataset.buildId===status.dataset.buildId&&!!preview.querySelector('[data-testid="pdf-text-layer"][data-ready="true"]');},null,{timeout:180000});
 await page.getByRole('textbox',{name:'PDF 텍스트 검색',exact:true}).fill(initial);await page.getByRole('textbox',{name:'PDF 텍스트 검색',exact:true}).press('Enter');
 await page.locator('.pdf-search-results button').first().click({timeout:30000});
 await page.locator('[data-testid="pdf-text-layer"][data-ready="true"] span').filter({hasText:initial}).first().evaluate(node=>node.scrollIntoView({block:'center',inline:'nearest'}));
 await page.waitForFunction(()=>document.querySelector('.pdf-preview')?.dataset.liveReady==='true',null,{timeout:180000});proof.initial_ready_ms=Date.now()-started;
 const counts=await page.locator('.pdf-page-count').textContent();proof.initial_page_count=Number(counts.match(/\d+/)[0]);
 for(let index=0;index<5;index++){
  const token=`LIVEPROJECT${String.fromCharCode(65+index)}001`;await selectMarker(page);await arm(page,token);await page.keyboard.insertText(`${token}.`);
  await page.waitForFunction(()=>!!window.__projectProbe.sample?.done,null,{timeout:180000,polling:20});
  if(index===0)await page.screenshot({path:path.join(run.output,'first-correct-frame.png')});
  await canonical(page);
  const sample=await page.evaluate(()=>{const p=window.__projectProbe,s=p.sample;return {...s,operations:performance.getEntriesByType('resource').filter(e=>e.startTime>=s.started&&['file_save','build_start','artifact_metadata'].includes(new URL(e.name).pathname.slice(1))).map(e=>({command:new URL(e.name).pathname.slice(1),start:e.startTime,end:e.responseEnd}))};});
  sample.edit_to_pdf_ms=sample.done-sample.started;sample.edit_to_canonical_pdf_ms=sample.canonicalDone-sample.started;
  assert(sample.started>0&&sample.pageCount===proof.initial_page_count,'Missing input observation or changed complete-document page count.');
  if(sample.provisional)assert(sample.exportDisabled===true,'Live PDF incorrectly allows canonical export.');assert(sample.canonicalExportDisabled===false,'Verified PDF export was not restored.');
  if(partialMode)assert(sample.previewKind==='partial'&&sample.previewLast>=sample.previewFirst&&sample.previewLast<sample.pageCount,'A full compile was mistaken for the bounded-page fast path.');
  assert(await readFile(path.join(project,sourcePath),'utf8')===template.replace(initial,token),'Saved source differs from the edited complete source.');
  proof.samples.push(sample);await writeJson(path.join(run.output,'live-project-results.json'),proof);console.log(JSON.stringify({index,edit_to_pdf_ms:sample.edit_to_pdf_ms,canonical_ms:sample.edit_to_canonical_pdf_ms,live:sample.provisional}));
 }
 if(verify){
  assert(proof.samples.some(sample=>sample.provisional),'The fast path never displayed a real PDF.');
  await quickOpen(page,'paper/TR-C/main.tex');await clickPair(page,'LIVEPROJECTE001','canonical');
  const target=page.locator('[data-testid="pdf-text-layer"][data-ready="true"] span').filter({hasText:'LIVEPROJECTE001'}).first(),bounds=await target.boundingBox();assert(bounds,'Missing PDF text bounds.');
  const before=await page.evaluate(()=>window.__projectProbe.sync.length);await page.mouse.move(bounds.x+4,bounds.y+bounds.height/2);await page.mouse.down();await page.mouse.move(bounds.x+Math.min(90,bounds.width-2),bounds.y+bounds.height/2,{steps:6});await page.mouse.up();await page.waitForTimeout(300);
  assert(await page.evaluate(()=>!!window.getSelection()?.toString()),'PDF dragging no longer selects text.');assert(await page.evaluate(()=>window.__projectProbe.sync.length)===before,'A drag triggered source navigation.');proof.interaction.drag_selection=true;
  await target.dblclick({position:{x:10,y:6}});await page.waitForTimeout(300);assert(await page.evaluate(()=>!!window.getSelection()?.toString()),'PDF double click no longer selects text.');assert(await page.evaluate(()=>window.__projectProbe.sync.length)===before,'Double click triggered source navigation.');proof.interaction.double_click_selection=true;
  await page.evaluate(()=>window.getSelection()?.removeAllRanges());
 }
 await selectMarker(page);await arm(page,'BURST059');await page.evaluate(()=>{const p=window.__projectProbe;p.burst={started:performance.now(),ended:0};});await page.keyboard.insertText('CONTINUOUSBASE');
 for(let index=0;index<60;index++){await page.keyboard.insertText(` BURST${String(index).padStart(3,'0')}`);await page.waitForTimeout(80);}
 await page.evaluate(()=>window.__projectProbe.burst.ended=performance.now());
 await page.waitForFunction(()=>!!window.__projectProbe.sample?.done,null,{timeout:180000,polling:20});
 if(verify){await page.waitForFunction(()=>document.querySelector('.pdf-preview')?.dataset.livePreview==='true'&&document.querySelector('.pdf-preview')?.dataset.liveReady==='true',null,{timeout:10000,polling:10});await clickPair(page,'CONTINUOUSBASE','live');}
 if(partialMode){
  const preview=page.locator('.pdf-preview'),last=Number(await preview.getAttribute('data-preview-last')),current=Number(await page.getByRole('spinbutton',{name:'PDF 페이지',exact:true}).inputValue()),target=Math.min(last+2,proof.initial_page_count),oldFrame=await preview.getAttribute('data-build-id');
  assert(target>last,'The supposed partial frame already covers the whole paper.');
  await page.getByRole('spinbutton',{name:'PDF 페이지',exact:true}).fill(String(target));
  await page.waitForFunction(({target,oldFrame})=>{const root=document.querySelector('.pdf-preview');return root?.dataset.previewKind==='partial'&&root.dataset.buildId!==oldFrame&&Number(root.dataset.previewLast)>=target&&document.querySelector(`.pdf-page[data-page="${target}"] [data-ready="true"]`);},{target,oldFrame},{timeout:10000,polling:10});
  proof.interaction.viewport_expansion={from:last,to:target,frame:await preview.getAttribute('data-build-id')};
  await page.screenshot({path:path.join(run.output,'expanded-partial.png')});
  await page.getByRole('spinbutton',{name:'PDF 페이지',exact:true}).fill(String(current));
 }
 await canonical(page);
 proof.burst=await page.evaluate(()=>({ ...window.__projectProbe.burst,frames:window.__projectProbe.frames,final:window.__projectProbe.sample}));
 proof.burst.intermediate_frames=proof.burst.frames.filter(frame=>frame.at<proof.burst.ended).length;
 if(verify)assert(proof.burst.intermediate_frames>0,'Continuous typing starved every completed preview.');
 const expected=template.replace(`${initial}.`,`CONTINUOUSBASE${Array.from({length:60},(_,i)=>` BURST${String(i).padStart(3,'0')}`).join('')}`);assert(await readFile(path.join(project,sourcePath),'utf8')===expected,'The continuous edit was not saved exactly.');
 if(partialMode){
  const nativeStarts=await page.evaluate(()=>{const p=window.__projectProbe;return performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname==='/build_start'&&e.startTime>=p.burst.started&&e.startTime<p.burst.ended).map(e=>e.startTime);});
  assert(nativeStarts.length===0,'An automatic full build competed with uninterrupted typing.');proof.interaction.native_builds_during_typing=nativeStarts.length;
  const rootPath=path.join(project,'paper/TR-C/main.tex'),rootSource=await readFile(rootPath,'utf8'),prefix='\\AtBeginDocument{PREAMBLECHECK.\\par}\n';
  await quickOpen(page,'paper/TR-C/main.tex');await page.getByRole('spinbutton',{name:'PDF 페이지',exact:true}).fill('1');await page.getByTestId('source-editor').locator('.cm-content').focus();await page.keyboard.press('Control+Home');await arm(page,'PREAMBLECHECK');await page.keyboard.insertText(prefix);
  await page.waitForFunction(()=>!!window.__projectProbe.sample?.done,null,{timeout:180000,polling:20});await canonical(page);
  const fallback=await page.evaluate(()=>({sample:window.__projectProbe.sample,refused:window.__projectProbe.previews.some(row=>row.started>=window.__projectProbe.sample.started&&!row.accepted),full:window.__projectProbe.compiles.some(row=>row.started>=window.__projectProbe.sample.started&&row.success)}));
  assert(fallback.sample.previewKind!=='partial'&&fallback.refused&&fallback.full,'A changed preamble did not take the safe full-compile path.');assert(await readFile(rootPath,'utf8')===prefix+rootSource,'Preamble editing lost source bytes.');proof.interaction.preamble_fallback=fallback;
  await page.screenshot({path:path.join(run.output,'preamble-fallback.png')});
  const goodId=await page.locator('.pdf-preview').getAttribute('data-build-id');
  await page.getByTestId('source-editor').locator('.cm-content').focus();await page.keyboard.press('Control+Home');await page.keyboard.insertText('\\UndefinedPagePreviewCommand\n');
  await page.waitForFunction(()=>document.querySelector('[data-testid="build-status"]')?.dataset.status==='failed',null,{timeout:180000,polling:20});
  assert(await page.locator('.pdf-preview').getAttribute('data-build-id')===goodId,'A failed compilation replaced the last authoritative PDF.');
  await page.getByTestId('source-editor').locator('.cm-content').focus();await page.keyboard.press('Control+Home');await page.keyboard.press('Control+Shift+End');await arm(page,'PREAMBLECHECK');await page.keyboard.insertText(prefix+rootSource);await canonical(page);
  assert(await readFile(rootPath,'utf8')===prefix+rootSource,'Recovery did not preserve exact source.');proof.interaction.error_retention_and_recovery=true;
 }
 proof.edit_to_pdf_median_ms=median(proof.samples.map(sample=>sample.edit_to_pdf_ms));proof.canonical_median_ms=median(proof.samples.map(sample=>sample.edit_to_canonical_pdf_ms));proof.complete=true;
 await page.screenshot({path:path.join(run.output,'final-project.png')});
}catch(error){proof.error=error.stack??String(error);throw error;}
finally{
 if(app){try{proof.compiles=await app.page.evaluate(()=>window.__projectProbe?.compiles);proof.previews=await app.page.evaluate(()=>window.__projectProbe?.previews);proof.finalState=await app.page.evaluate(()=>({status:document.querySelector('[data-testid="build-status"]')?.dataset,preview:document.querySelector('.pdf-preview')?.dataset,sync:document.querySelector('.pdf-location-status')?.textContent,alerts:[...document.querySelectorAll('[role="alert"]')].map(node=>node.textContent?.slice(0,500))}));await app.page.screenshot({path:path.join(run.output,'last-state.png')});}catch{}await app.close();}
 await writeJson(path.join(run.output,'live-project-results.json'),proof);
}
console.log(JSON.stringify({complete:proof.complete,variant:proof.variant,initial_ready_ms:proof.initial_ready_ms,edit_to_pdf_median_ms:proof.edit_to_pdf_median_ms,canonical_median_ms:proof.canonical_median_ms,intermediate_frames:proof.burst?.intermediate_frames,interaction:proof.interaction},null,2));
