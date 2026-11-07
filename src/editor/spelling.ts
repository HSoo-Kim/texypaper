import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, hoverTooltip, keymap, showTooltip, type Tooltip, type ViewUpdate } from '@codemirror/view';
import { request } from '../api';
import type { WorkspaceRef } from '../contracts';
import { t } from '../ui/i18n';
import { proseRangeIterator, spellingText, type ProseRange } from './proseRanges';
import './spelling.css';
export type SpellError={start:number;length:number};
export type SpellStatus={available:boolean;languages:string[];engine?:'windows'|'bundled'};
export type SpellingOptions={enabled:()=>boolean;ignore:()=>string[];onIgnore:(word:string)=>void;check:(text:string)=>Promise<SpellError[]>;suggest:(word:string)=>Promise<string[]>;language:()=>string};
export interface SpellEngineInstance {status:()=>Promise<SpellStatus>;language:()=>string;check:(text:string)=>Promise<SpellError[]>;suggest:(word:string)=>Promise<string[]>}
const WORD=/[A-Za-z]+(?:'[A-Za-z]+)*/g;
const CACHE_LIMIT=2048;
function cachePut<T>(cache:Map<string,T>,key:string,value:T){if(cache.size>=CACHE_LIMIT&&!cache.has(key)){const oldest=cache.keys().next().value;if(oldest!==undefined)cache.delete(oldest);}cache.set(key,value);}
/** Small per-editor, per-language FIFO caches. All checking stays on this Windows client,
 * even for SSH workspaces; a pass batches uncached words into one bounded native call. */
export function SpellEngine(workspace:WorkspaceRef,preferredLanguage='en-US'):SpellEngineInstance {
  const checked=new Map<string,boolean>(),suggestions=new Map<string,string[]>();
  let statusPromise:Promise<SpellStatus>|undefined,selected=preferredLanguage;
  const status=()=>statusPromise??=request<SpellStatus>('spell_status',workspace).then(value=>{if(!value.languages.includes(selected))selected=value.languages[0]??preferredLanguage;return value;}).catch(error=>{statusPromise=undefined;throw error;});
  return {
    status,language:()=>selected,
    async check(text:string):Promise<SpellError[]> {
      if(!(await status()).available)return [];
      const words=[...text.matchAll(WORD)],missing=[...new Set(words.map(match=>match[0]).filter(word=>!checked.has(`${selected}:${word}`)))].slice(0,512);
      if(missing.length){
        const batch=missing.join('\n'),result=await request<{errors:SpellError[]}>('spell_check',workspace,{text:batch,language:selected});
        let start=0;for(const word of missing){const end=start+word.length;cachePut(checked,`${selected}:${word}`,result.errors.some(error=>error.start<end&&error.start+error.length>start));start=end+1;}
      }
      return words.filter(match=>checked.get(`${selected}:${match[0]}`)).map(match=>({start:match.index,length:match[0].length}));
    },
    async suggest(word:string):Promise<string[]> {
      if(word.length>64||!(await status()).available)return [];
      const key=`${selected}:${word}`,cached=suggestions.get(key);if(cached)return cached;
      const result=await request<{suggestions:string[]}>('spell_suggest',workspace,{word,language:selected});
      const values=result.suggestions.filter(value=>/^[A-Za-z][A-Za-z' -]*$/.test(value)&&value.length<=64).slice(0,8);cachePut(suggestions,key,values);return values;
    },
  };
}
/** Defend against malformed/native stale spans and don't underline fragments of identifiers. */
export function checkedSpans(text:string,errors:SpellError[]):SpellError[] {
  const spans:SpellError[]=[];
  for(const error of errors){const {start,length}=error,end=start+length;if(!Number.isInteger(start)||!Number.isInteger(length)||start<0||length<=0||end>text.length)continue;
    if(!/^[A-Za-z]+(?:'[A-Za-z]+)*$/.test(text.slice(start,end))||/[A-Za-z']/.test(text[start-1]??'')||/[A-Za-z']/.test(text[end]??''))continue;
    if(!spans.some(span=>span.start===start&&span.length===length))spans.push({start,length});
  }
  return spans.sort((a,b)=>a.start-b.start);
}
export function spellingExtension(options:SpellingOptions):Extension {
  if(!options.enabled())return [];
  const replaceErrors=StateEffect.define<SpellError[]>(),open=StateEffect.define<Tooltip|null>();
  const field=StateField.define<{errors:SpellError[];tooltip:Tooltip|null}>({
    create:()=>({errors:[],tooltip:null}),
    update(value,tr){if(tr.docChanged)value={errors:[],tooltip:null};else if(tr.selection)value={...value,tooltip:null};for(const effect of tr.effects){if(effect.is(replaceErrors))value={errors:effect.value,tooltip:null};if(effect.is(open))value={...value,tooltip:effect.value};}return value;},
    provide:field=>[EditorView.decorations.from(field,value=>Decoration.set(value.errors.map(error=>Decoration.mark({class:'cm-spell-error'}).range(error.start,error.start+error.length)))),showTooltip.from(field,value=>value.tooltip)],
  });
  const errorAt=(view:EditorView,pos:number)=>view.state.field(field).errors.find(error=>pos>=error.start&&pos<=error.start+error.length);
  const tooltip=(view:EditorView,error:SpellError):Tooltip=>({pos:error.start,end:error.start+error.length,above:false,create(){
    const doc=view.state.doc,word=doc.sliceString(error.start,error.start+error.length),dom=document.createElement('div');dom.className='cm-spell-tooltip';dom.dataset.testid='spelling-tooltip';dom.setAttribute('role','group');dom.setAttribute('aria-label',t(`맞춤법 제안: ${word}`,`Spelling suggestions: ${word}`));
    const heading=document.createElement('strong');heading.textContent=word;dom.append(heading);
    const list=document.createElement('div');list.className='cm-spell-suggestions';list.setAttribute('aria-live','polite');list.textContent=t('제안 확인 중…','Loading suggestions…');dom.append(list);
    let alive=true;
    const current=()=>alive&&options.enabled()&&view.state.doc===doc&&!view.state.readOnly;
    const close=()=>{view.dispatch({effects:open.of(null)});view.focus();};
    const ignore=document.createElement('button');ignore.type='button';ignore.dataset.testid='spelling-ignore';ignore.textContent=t('이 단어 무시','Ignore word');ignore.disabled=options.ignore().length>=500;
    ignore.addEventListener('click',()=>{if(!current())return;options.onIgnore(word);view.dispatch({effects:replaceErrors.of(view.state.field(field).errors.filter(error=>doc.sliceString(error.start,error.start+error.length).toLowerCase()!==word.toLowerCase()))});view.focus();});dom.append(ignore);
    const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent=t('닫기','Close');dismiss.addEventListener('click',close);dom.append(dismiss);
    dom.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}});
    void options.suggest(word).then(values=>{if(!alive)return;list.replaceChildren();for(const suggestion of values.slice(0,5)){const button=document.createElement('button');button.type='button';button.dataset.testid='spelling-suggestion';button.textContent=suggestion;button.addEventListener('click',()=>{if(!current())return;view.dispatch({changes:{from:error.start,to:error.start+error.length,insert:suggestion},selection:{anchor:error.start+suggestion.length},userEvent:'input.spelling'});view.focus();});list.append(button);}if(!list.childNodes.length)list.textContent=t('제안 없음','No suggestions');}).catch(()=>{if(alive)list.textContent=t('제안을 불러오지 못했습니다.','Could not load suggestions.');});
    return {dom,destroy(){alive=false;}};
  }});
  const plugin=ViewPlugin.fromClass(class {
    timer:ReturnType<typeof setTimeout>|undefined;generation=0;destroyed=false;
    constructor(readonly view:EditorView){this.schedule();}
    update(update:ViewUpdate){if(update.docChanged||update.viewportChanged)this.schedule();}
    schedule(){clearTimeout(this.timer);this.generation++;if(options.enabled()&&!this.view.state.readOnly)this.timer=setTimeout(()=>{void this.run(this.generation);},400);}
    async run(generation:number){
      const doc=this.view.state.doc,language=options.language(),ignored=options.ignore().join('\0');
      const stale=()=>this.destroyed||generation!==this.generation||this.view.state.doc!==doc||!options.enabled()||options.language()!==language||options.ignore().join('\0')!==ignored;
      if(stale())return;
      // At most 8 KiB of visible source and 512 unique words per pass. Scan preceding
      // TeX context cooperatively; no offscreen prose is sent to the system checker.
      const visible:ProseRange[]=[];let remaining=8192;
      for(const range of this.view.visibleRanges){if(!remaining)break;const end=Math.min(range.to,range.from+remaining);visible.push({start:range.from,end});remaining-=end-range.from;}
      if(!visible.length)return;
      const text=doc.toString(),ranges:ProseRange[]=[],last=visible.at(-1)!.end;
      let deadline=performance.now()+4;
      for(const range of proseRangeIterator(text)){
        if(stale())return;if(range&&range.start>=last)break;
        if(range)for(const window of visible){const start=Math.max(window.start,range.start),end=Math.min(window.end,range.end);if(end>start){const previous=ranges.at(-1);if(previous&&previous.end===start)previous.end=end;else ranges.push({start,end});}}
        if(performance.now()>=deadline){const {promise,resolve}=Promise.withResolvers<void>();setTimeout(resolve,0);await promise;deadline=performance.now()+4;}
      }
      const errors:SpellError[]=[];
      try {
        for(const window of visible){
          const source=text.slice(window.start,window.end),local=ranges.filter(range=>range.end>window.start&&range.start<window.end).map(range=>({start:Math.max(range.start,window.start)-window.start,end:Math.min(range.end,window.end)-window.start}));
          let prepared=spellingText(source,local,options.ignore());
          // A viewport edge may bisect a word: suppress both partial boundary tokens.
          if(/[\p{L}\p{N}'_\-]/u.test(text[window.start-1]??''))prepared=prepared.replace(/^[A-Za-z']+/,match=>' '.repeat(match.length));
          if(/[\p{L}\p{N}'_\-]/u.test(text[window.end]??''))prepared=prepared.replace(/[A-Za-z']+$/,match=>' '.repeat(match.length));
          if(!/[A-Za-z]/.test(prepared))continue;
          const result=await options.check(prepared);if(stale()){if(!this.destroyed&&generation===this.generation)this.schedule();return;}errors.push(...checkedSpans(prepared,result).map(error=>({start:error.start+window.start,length:error.length})));
        }
        if(!stale())this.view.dispatch({effects:replaceErrors.of(errors)});
      } catch { /* Spell checking is optional; a transient failure never interrupts editing. */ }
    }
    destroy(){this.destroyed=true;this.generation++;clearTimeout(this.timer);}
  });
  return [field,plugin,hoverTooltip((view,pos)=>{const error=errorAt(view,pos);return error&&options.enabled()?tooltip(view,error):null;},{hideOnChange:true,hoverTime:350}),EditorView.domEventHandlers({click(event,view){const target=event.target as HTMLElement;if(!target.closest('.cm-spell-error'))return false;const pos=view.posAtCoords({x:event.clientX,y:event.clientY});if(pos===null)return false;const error=errorAt(view,pos);if(!error)return false;view.dispatch({effects:open.of(tooltip(view,error))});return true;}}),keymap.of([{key:'Alt-F8',run(view){const error=errorAt(view,view.state.selection.main.head);if(!error)return false;view.dispatch({effects:open.of(tooltip(view,error))});requestAnimationFrame(()=>view.dom.querySelector<HTMLButtonElement>('.cm-spell-tooltip button')?.focus());return true;}},{key:'Escape',run(view){if(!view.state.field(field).tooltip)return false;view.dispatch({effects:open.of(null)});return true;}}])];
}
