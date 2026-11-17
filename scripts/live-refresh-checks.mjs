// Consumer-visible safeguards for the latency work. Called after timed samples, never against user papers.
import path from 'node:path';
import { assert, runExternal, writeJson } from './smoke-support.mjs';

async function replace(page,text){
  await page.getByTestId('source-editor').locator('.cm-content').focus();
  await page.keyboard.press('Control+Home');await page.keyboard.press('Control+Shift+End');await page.keyboard.insertText(text);
}
async function displayed(page,token,previousId){
  await page.waitForFunction(({token,previousId})=>{
    const preview=document.querySelector('.pdf-preview'),status=document.querySelector('[data-testid="build-status"]');
    return preview?.getAttribute('data-build-id')!==previousId&&preview?.getAttribute('data-build-id')===status?.getAttribute('data-build-id')&&status?.getAttribute('data-status')==='published'&&[...document.querySelectorAll('[data-testid="pdf-text-layer"][data-ready="true"]')].some(node=>node.textContent.includes(token));
  },{token,previousId},{timeout:150000,polling:20});
}
async function sameTimestampWrite(host,relative,text){
  const code='import os,sys,json; p=sys.argv[1]; s=os.stat(p); b=sys.argv[2].encode("utf-8"); assert len(b)==s.st_size; open(p,"wb").write(b); os.utime(p,ns=(s.st_atime_ns,s.st_mtime_ns)); n=os.stat(p); assert (n.st_mtime_ns,n.st_size)==(s.st_mtime_ns,s.st_size); print(json.dumps({"mtime_ns":str(n.st_mtime_ns),"bytes":n.st_size}))';
  const result=host.kind==='ssh'
    ?await runExternal('wsl.exe',['--distribution',host.distribution,'--exec','python3','-I','-c',code,`${host.root}/${relative}`,text])
    :await runExternal('python',['-I','-c',code,path.join(host.root,relative),text]);
  return JSON.parse(result.stdout.trim());
}
export async function verifyLiveRefresh(page,host,output){
  const results=[],preview=page.locator('.pdf-preview'),status=page.getByTestId('build-status');
  try{
  const id=()=>preview.getAttribute('data-build-id');
  let text=await host.read('body.tex'),before=await id();
  const original=text.match(/LATENCYMARKER[A-Z]001/)?.[0];assert(original,'Expected this run\'s own disposable source marker.');
  const hidden='H'.repeat(original.length);text=text.replace(original,hidden);
  const stamp=await sameTimestampWrite(host,'body.tex',text);
  await page.getByRole('button',{name:'빌드',exact:true}).click();await displayed(page,hidden,before);
  await page.waitForFunction(token=>document.querySelector('[data-testid="source-editor"] .cm-content')?.textContent.includes(token),hidden,{timeout:30000});
  results.push({name:'same-size-same-mtime-edit',passed:true,...stamp});

  before=await id();const bibliography=await host.read('refs.bib');await host.write('refs.bib',bibliography.replace('year={2026}','year={2027}'));
  await page.getByRole('button',{name:'빌드',exact:true}).click();await displayed(page,'2027',before);
  results.push({name:'bibliography-dependency-refresh',passed:true});

  before=await id();await replace(page,'Broken compilation.\\unknownTexyPaperLatencyCommand\n');
  await page.waitForFunction(()=>document.querySelector('[data-testid="build-status"]')?.getAttribute('data-status')==='failed',null,{timeout:150000});
  assert(await id()===before,'A failed build discarded the last successful PDF.');
  assert((await preview.innerText()).includes(hidden),'A failed build replaced the last successful PDF text.');
  await page.screenshot({path:path.join(output,'failed-build-retains-pdf.png')});
  results.push({name:'compile-error-retains-last-pdf',passed:true});
  text='Latency probe RECOVEREDLATENCY.\n';await replace(page,text);await displayed(page,'RECOVEREDLATENCY',before);
  results.push({name:'recover-after-compile-error',passed:true});

  before=await id();await page.getByTestId('source-editor').locator('.cm-content').focus();await page.keyboard.press('Control+Home');await page.keyboard.press('Control+Shift+End');
  await page.keyboard.insertText('Latency burst BURST');
  for(const letter of 'ABCDE'){await page.keyboard.insertText(letter);await new Promise(resolve=>setTimeout(resolve,30));}
  await page.keyboard.insertText('.\n');await displayed(page,'BURSTABCDE',before);
  assert(await host.read('body.tex')==='Latency burst BURSTABCDE.\n','A rapid typing burst lost source characters.');
  results.push({name:'rapid-typing-latest-text',passed:true});

  before=await id();await replace(page,'Latency queue INTERMEDIATEVALUE.\n');
  await page.waitForFunction(()=>document.querySelector('[data-testid="build-status"]')?.getAttribute('data-status')==='building',null,{timeout:30000,polling:10});
  text='Latency queue FINALQUEUEDVALUE.\n';await replace(page,text);await page.keyboard.press('Control+s');
  await displayed(page,'FINALQUEUEDVALUE',before);assert(await host.read('body.tex')===text,'An in-flight build/save lost the latest source.');
  results.push({name:'edit-and-save-during-build',passed:true});

  before=await id();await replace(page,'Cancellation probe.\n\\newcount\\latencycounter\\loop\\advance\\latencycounter by 1 \\ifnum\\latencycounter<100000000\\repeat\n');
  await page.waitForFunction(()=>document.querySelector('[data-testid="build-status"]')?.getAttribute('data-status')==='building',null,{timeout:30000,polling:10});
  await page.getByRole('button',{name:'빌드 중지',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="build-status"]')?.getAttribute('data-status')==='cancelled',null,{timeout:30000,polling:20});
  assert(await id()===before,'Cancellation replaced the last successful PDF.');
  results.push({name:'cancel-retains-last-pdf',passed:true});
  text='Latency probe FINALVERIFIEDVALUE.\n';await replace(page,text);await displayed(page,'FINALVERIFIEDVALUE',before);
  assert(await host.read('body.tex')===text,'Recovery after cancellation lost source bytes.');
  assert(await status.getAttribute('data-status')==='published','Final verification build did not publish.');
  results.push({name:'recover-after-cancel',passed:true});
  await page.screenshot({path:path.join(output,'verified-split.png')});
  return results;
  }finally{await writeJson(path.join(output,'refresh-checks.json'),results);}
}

export async function verifyReadingPosition(page,host,output){
  await page.getByRole('combobox',{name:'PDF 확대',exact:true}).selectOption('1.25');
  await page.getByRole('spinbutton',{name:'PDF 페이지',exact:true}).fill('10');
  await page.waitForFunction(()=>document.querySelector('canvas[aria-label="페이지 10"]')?.parentElement?.querySelector('[data-ready="true"]'),null,{timeout:30000});
  const preview=page.locator('.pdf-preview'),previousId=await preview.getAttribute('data-build-id');
  await replace(page,'Latency probe POSITIONRETAINED.\n');
  await page.waitForFunction(previousId=>{
    const preview=document.querySelector('.pdf-preview'),status=document.querySelector('[data-testid="build-status"]');
    return preview?.getAttribute('data-build-id')&&preview.getAttribute('data-build-id')!==previousId&&preview.getAttribute('data-build-id')===status?.getAttribute('data-build-id')&&document.querySelector('canvas[aria-label="페이지 10"]')?.parentElement?.querySelector('[data-ready="true"]');
  },previousId,{timeout:150000,polling:20});
  assert(await page.getByRole('spinbutton',{name:'PDF 페이지',exact:true}).inputValue()==='10','Recompilation reset the reading page.');
  assert(await page.getByRole('combobox',{name:'PDF 확대',exact:true}).inputValue()==='1.25','Recompilation reset zoom.');
  assert(await host.read('body.tex')==='Latency probe POSITIONRETAINED.\n','Position-preserving rebuild lost source text.');
  await page.screenshot({path:path.join(output,'reading-position-preserved.png')});
  await page.getByRole('spinbutton',{name:'PDF 페이지',exact:true}).fill('1');
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-testid="pdf-text-layer"][data-ready="true"]')].some(node=>node.textContent.includes('POSITIONRETAINED')),null,{timeout:30000});
  return [{name:'same-root-reading-position-and-zoom',passed:true,page:10,zoom:1.25}];
}
