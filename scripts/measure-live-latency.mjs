// Run through scripts/measure-live-latency.py and lab run. Synthetic, hidden-start release UI only.
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { assert, parseArgs, requireBinary, createRun, launchDesktop, writeJson } from './smoke-support.mjs';
import { quickOpen } from './smoke-desktop.mjs';
import { connectSshUi } from './smoke-ssh.mjs';
import { startSshSmokeHost } from './ssh-smoke-host.mjs';

import { verifyLiveRefresh, verifyReadingPosition } from './live-refresh-checks.mjs';
const args = parseArgs(), binary = await requireBinary(args), run = await createRun(args, 'live-latency');
assert(process.env.TEXYPAPER_LAB_MEASUREMENT === '1', 'Use the labrun Python entry point.');
const cases = [], rounds = 7;
const comparison=args.comparison?JSON.parse(await readFile(path.resolve(args.comparison),'utf8')):null;
let app, ssh;
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const files = pages => ({
  'main.tex': '\\documentclass{article}\n\\begin{document}\n\\input{body}\nSee Section~\\ref{sec:last} and \\cite{sample}.\n' + Array.from({length:pages-1},(_,i)=>`\\newpage\n\\section{Synthetic section ${i+2}}\nThis disposable paper measures document refresh, not scientific results.\n`).join('') + '\\label{sec:last}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n',
  'body.tex': 'Latency probe BASELINEMARKER.\n',
  'refs.bib': '@article{sample,author={Example, Synthetic},title={Disposable latency fixture},journal={Example Journal},year={2026}}\n',
  '.texypaper/project.json': JSON.stringify({version:1,rootTex:'main.tex',engine:'pdflatex',profile:'basic',autoBuild:true}),
});
async function makeLocal(name) {
  const root=path.join(run.fixtures,name);await mkdir(root,{recursive:true});
  await writeFile(path.join(root,'.texypaper-smoke-fixture'),'Owned disposable latency fixture\n',{flag:'wx'});
  return {kind:'local',root,read:relative=>readFile(path.join(root,relative),'utf8'),write:async(relative,text)=>{const destination=path.join(root,relative);await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,text);}};
}
async function observe(page) {
  await page.evaluate(() => {
    const probe=window.__liveLatency={sample:null,identity:null};
    performance.setResourceTimingBufferSize(4096);
    probe.collect=()=>{
      const sample=probe.sample;if(!sample)return null;
      sample.operations=performance.getEntriesByType('resource').flatMap(entry=>{
        const command=new URL(entry.name).pathname.slice(1);
        if(entry.startTime<sample.started||!['recovery_write','file_save','recovery_clear','build_start','artifact_metadata'].includes(command))return [];
        return [{command,phase:'start',at:entry.startTime},{command,phase:'end',at:entry.responseEnd}];
      });
      sample.resourceCommands=[...new Set(performance.getEntriesByType('resource').filter(entry=>entry.startTime>=sample.started).map(entry=>new URL(entry.name).pathname.slice(1)))];
      return sample;
    };
    document.addEventListener('beforeinput',event=>{const sample=probe.sample;if(sample&&!sample.started&&event.target instanceof Element&&event.target.closest('[data-testid="source-editor"]'))sample.started=performance.now();},true);
    window.addEventListener('texypaper:pdf-identity',event=>{probe.identity=event.detail;});
    const check=()=>{
      const sample=probe.sample;if(!sample||!sample.started)return;
      const preview=document.querySelector('.pdf-preview'),status=document.querySelector('[data-testid="build-status"]');
      const id=preview?.getAttribute('data-build-id');
      const layer=[...document.querySelectorAll('[data-testid="pdf-text-layer"][data-ready="true"]')].find(node=>node.textContent.includes(sample.token));
      const canvas=layer?.parentElement?.querySelector('canvas');
      const visible=canvas?.getBoundingClientRect(),provisional=preview?.getAttribute('data-live-preview')==='true';
      if(id&&id!==sample.previousId&&layer&&canvas?.width&&canvas?.height&&visible.width>0&&visible.height>0){
        if(!sample.done&&(provisional||id===status?.getAttribute('data-build-id'))){sample.done=performance.now();sample.buildId=id;sample.provisional=provisional;sample.exportDisabled=preview.querySelector('.pdf-export')?.disabled;sample.pageCount=Number(document.querySelector('.pdf-page-count')?.textContent.match(/\d+/)?.[0]);}
        if(!provisional&&id===status?.getAttribute('data-build-id')&&status?.getAttribute('data-status')==='published'&&!sample.canonicalDone){sample.canonicalDone=performance.now();sample.canonicalBuildId=id;sample.canonicalPageCount=probe.identity?.pageCount;sample.canonicalExportDisabled=preview.querySelector('.pdf-export')?.disabled;}
      }
    };
    new MutationObserver(check).observe(document.querySelector('#root')??document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-ready','data-build-id','data-status','data-live-preview']});
  });
}
async function replaceSource(page,text,token) {
  await page.getByTestId('source-editor').locator('.cm-content').focus();
  await page.keyboard.press('Control+Home');await page.keyboard.press('Control+Shift+End');
  await page.evaluate(token=>{const probe=window.__liveLatency;probe.sample={token,started:0,done:null,previousId:document.querySelector('.pdf-preview')?.getAttribute('data-build-id'),operations:[]};},token);
  await page.keyboard.insertText(text);
}
async function exercise(host,name,pages) {
  const output=path.join(run.output,name),dataDir=path.join(output,'app-data');await mkdir(dataDir,{recursive:true});
  for(const [relative,text]of Object.entries(files(pages)))await host.write(relative,text);
  app=await launchDesktop({binary,output,dataDir,...(host.kind==='local'?{project:host.root}:{})});
  const {page}=app;await page.setViewportSize(comparison?{width:comparison.width,height:comparison.height}:{width:1440,height:900});
  if(comparison){
    const session=await page.context().newCDPSession(page);
    await session.send('Emulation.setDeviceMetricsOverride',{width:comparison.width,height:comparison.height,deviceScaleFactor:comparison.deviceScaleFactor,mobile:false});
    const actual=await page.evaluate(()=>({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio}));
    assert(actual.width===comparison.width&&actual.height===comparison.height&&actual.deviceScaleFactor===comparison.deviceScaleFactor,'Comparison viewport must match actual CorTeX readback.');
  }
  if(host.kind==='ssh')await connectSshUi(page,host.environment,host.root,{acceptUnknownHost:true});
  await page.getByTestId('file-tree').waitFor({timeout:30000});
  await page.getByRole('button',{name:'분할',exact:true}).click();
  if(comparison){
    await page.getByRole('button',{name:'작업 패널 닫기',exact:true}).click();
    await page.getByRole('button',{name:'사이드 패널 접기',exact:true}).click();
  }
  await quickOpen(page,'body.tex');await observe(page);
  await page.getByRole('button',{name:'빌드',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="build-status"]')?.getAttribute('data-status')==='published'&&[...document.querySelectorAll('[data-testid="pdf-text-layer"][data-ready="true"]')].some(node=>node.textContent.includes('BASELINEMARKER')),null,{timeout:150000});
  if(args.resident)await page.waitForFunction(()=>document.querySelector('.pdf-preview')?.getAttribute('data-live-ready')==='true',null,{timeout:150000});
  const samples=[];
  for(let index=0;index<rounds;index++){
    const token=`LATENCYMARKER${String.fromCharCode(65+index)}001`,text=`Latency probe ${token}.\n`;
    await replaceSource(page,text,token);
    await page.waitForFunction(()=>!!window.__liveLatency.sample?.done,null,{timeout:150000,polling:20});
    if(args.resident&&index===0)await page.screenshot({path:path.join(output,'first-visible-preview.png')});
    await page.waitForFunction(resident=>!!window.__liveLatency.sample?.canonicalDone&&(!resident||document.querySelector('.pdf-preview')?.getAttribute('data-live-ready')==='true'),!!args.resident,{timeout:150000,polling:20});
    const measured=await page.evaluate(()=>window.__liveLatency.collect());
    await writeJson(path.join(output,`sample-${index}.json`),measured);
    assert(measured.started>0,'Actual source input was not observed.');
    assert(measured.pageCount===pages&&measured.canonicalPageCount===pages,'Visible and canonical PDF page counts must both match the complete fixture.');
    if(measured.provisional)assert(measured.exportDisabled===true,'A provisional PDF must not export the previous canonical artifact.');
    assert(measured.canonicalExportDisabled===false,'The verified canonical PDF must restore export availability.');
    assert(await host.read('body.tex')===text,'Published PDF must correspond to exactly saved source bytes.');
    const at=(command,phase)=>measured.operations.find(op=>op.command===command&&op.phase===phase)?.at;
    const saveStart=at('file_save','start'),saveEnd=at('file_save','end'),buildStart=at('build_start','start'),buildEnd=at('build_start','end');
    assert([saveStart,saveEnd,buildStart,buildEnd].every(Number.isFinite),'Missing real save/build timestamps.');
    const sample={index,...measured,edit_to_pdf_ms:measured.done-measured.started,edit_to_canonical_pdf_ms:measured.canonicalDone-measured.started,edit_to_save_ms:saveEnd-measured.started,save_to_build_ms:buildStart-saveEnd,build_ms:buildEnd-buildStart,preview_ms:measured.canonicalDone-buildEnd};
    samples.push(sample);console.log(JSON.stringify({case:name,index,edit_to_pdf_ms:sample.edit_to_pdf_ms,build_ms:sample.build_ms,preview_ms:sample.preview_ms}));
  }
  if(args.resident)assert(samples.some(sample=>sample.provisional),'The resident engine never displayed a real PDF; native fallback alone is not a resident-preview success.');
  await page.screenshot({path:path.join(output,'final-split.png')});
  const terminal=await page.getByTestId('build-status').getAttribute('data-status');assert(terminal==='published','Final build did not publish.');
  const summary={name,pages,host:host.kind,samples,median_ms:median(samples.map(row=>row.edit_to_pdf_ms)),max_ms:Math.max(...samples.map(row=>row.edit_to_pdf_ms)),stages:Object.fromEntries(['edit_to_save_ms','save_to_build_ms','build_ms','preview_ms'].map(key=>[key,median(samples.map(row=>row[key]))]))};
  cases.push(summary);await writeJson(path.join(run.output,'latency-results.json'),{variant:args.variant,complete:false,cases});
  if(args.verify){
    summary.verification=pages===1?await verifyLiveRefresh(page,host,output):await verifyReadingPosition(page,host,output);
    await writeJson(path.join(run.output,'latency-results.json'),{variant:args.variant,complete:false,cases});
  }
  await app.close();app=null;
}
try{
  if(!args.case||args.case==='local-short')await exercise(await makeLocal('local-short'),'local-short',1);
  if(!args.case||args.case==='local-long')await exercise(await makeLocal('local-long'),'local-long',30);
  if(!comparison&&(!args.case||args.case==='ssh-short')){
    ssh=await startSshSmokeHost({outputDir:run.output});
    await exercise({...ssh,kind:'ssh'},'ssh-short',1);
  }
  await writeJson(path.join(run.output,'latency-results.json'),{variant:args.variant,complete:true,cases});
}catch(error){await writeJson(path.join(run.output,'latency-results.json'),{variant:args.variant,complete:false,cases,error:error.stack??String(error)});throw error;}
finally{if(app)await app.close();if(ssh)await ssh.stop();}
console.log(JSON.stringify({variant:args.variant,cases:cases.map(({name,median_ms,max_ms,stages})=>({name,median_ms,max_ms,stages}))},null,2));
