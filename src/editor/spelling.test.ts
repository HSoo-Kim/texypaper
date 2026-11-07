import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { request } from '../api';
import type { WorkspaceRef } from '../contracts';
import { checkedSpans, SpellEngine, spellingExtension, type SpellingOptions } from './spelling';
vi.mock('../api',()=>({request:vi.fn()}));
const workspace={id:'test',epoch:1,environmentId:'local',root:'C:/synthetic'} as WorkspaceRef;
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();vi.mocked(request).mockReset();});
describe('spell engine',()=>{
  it('batches unique words, maps repeated offsets, and caches checks and suggestions',async()=>{
    vi.mocked(request).mockImplementation(async(command,_workspace,args)=>{
      if(command==='spell_status')return {available:true,languages:['en-US']};
      if(command==='spell_suggest')return {suggestions:['wrong','<unsafe>','two words']};
      if(!args||typeof args!=='object'||!('text' in args)||typeof args.text!=='string')throw new Error('Expected spell text');
      return {errors:[{start:args.text.indexOf('wrng'),length:4}]};
    });
    const engine=SpellEngine(workspace);
    expect(await engine.check('hello wrng wrng')).toEqual([{start:6,length:4},{start:11,length:4}]);
    expect(await engine.check('wrng hello')).toEqual([{start:0,length:4}]);
    expect(await engine.suggest('wrng')).toEqual(['wrong','two words']);await engine.suggest('wrng');
    expect(vi.mocked(request).mock.calls.filter(call=>call[0]==='spell_check')).toHaveLength(1);
    expect(vi.mocked(request).mock.calls.filter(call=>call[0]==='spell_suggest')).toHaveLength(1);
    expect(vi.mocked(request).mock.calls.find(call=>call[0]==='spell_check')?.[2]).toEqual({text:'hello\nwrng',language:'en-US'});
  });
  it('returns no errors without a dictionary and falls back to supported British English',async()=>{
    vi.mocked(request).mockResolvedValueOnce({available:false,languages:[]});const unavailable=SpellEngine(workspace);
    expect(await unavailable.check('wrng')).toEqual([]);expect(await unavailable.suggest('wrng')).toEqual([]);expect(request).toHaveBeenCalledTimes(1);
    vi.mocked(request).mockReset();vi.mocked(request).mockResolvedValueOnce({available:true,languages:['en-GB']}).mockResolvedValueOnce({errors:[]});
    const british=SpellEngine(workspace);await british.check('colour');expect(british.language()).toBe('en-GB');expect(vi.mocked(request).mock.calls[1][2]).toEqual({text:'colour',language:'en-GB'});
  });
  it('preserves bundled engine status and continues checking without a Windows dictionary',async()=>{
    const status={available:true,languages:['en-US'],engine:'bundled' as const};
    vi.mocked(request).mockResolvedValueOnce(status).mockResolvedValueOnce({errors:[{start:0,length:8}]});
    const engine=SpellEngine(workspace);
    expect(await engine.status()).toEqual(status);
    expect(await engine.check('sentense')).toEqual([{start:0,length:8}]);
    expect(request).toHaveBeenCalledWith('spell_check',workspace,{text:'sentense',language:'en-US'});
  });
  it('does not cache a failed native check as a correct word',async()=>{
    vi.mocked(request).mockResolvedValueOnce({available:true,languages:['en-US']}).mockRejectedValueOnce(new Error('failure')).mockResolvedValueOnce({errors:[{start:0,length:4}]});
    const engine=SpellEngine(workspace);await expect(engine.check('wrng')).rejects.toThrow('failure');expect(await engine.check('wrng')).toEqual([{start:0,length:4}]);
  });
});
describe('checked spans',()=>{
  it('rejects malformed spans, duplicate spans and word fragments',()=>{
    expect(checkedSpans('wrong word',[{start:0,length:5},{start:0,length:5},{start:1,length:4},{start:6,length:4},{start:-1,length:1},{start:0,length:0},{start:0.5,length:1},{start:10,length:1}])).toEqual([{start:0,length:5},{start:6,length:4}]);
  });
});
describe('viewport spelling scheduler',()=>{
  let captured:(new(view:EditorView,arg:unknown)=>PluginValue)|undefined;
  const active:PluginValue[]=[];
  beforeEach(()=>{
    vi.useFakeTimers();captured=undefined;
    const original=ViewPlugin.fromClass;
    vi.spyOn(ViewPlugin,'fromClass').mockImplementation((constructor,spec)=>{captured=constructor;return original(constructor,spec);});
  });
  afterEach(()=>{for(const plugin of active.splice(0))plugin.destroy?.();});
  function harness(text:string,patch:Partial<SpellingOptions>={},visible={from:0,to:text.length}){
    const check=vi.fn(async(source:string)=>{const at=source.indexOf('wrng');return at<0?[]:[{start:at,length:4}];});
    const options:SpellingOptions={enabled:()=>true,ignore:()=>[],onIgnore:vi.fn(),check,suggest:async()=>[],language:()=>'en-US',...patch};
    const extension=spellingExtension(options),view={state:EditorState.create({doc:text,extensions:[extension]}),visibleRanges:[visible],dispatch(spec:TransactionSpec){this.state=this.state.update(spec).state;}};
    const plugin=captured?new captured(view as unknown as EditorView,undefined):undefined;if(plugin)active.push(plugin);
    const marked=()=>{const ranges:{from:number;to:number;class:string}[]=[];for(const value of view.state.facet(EditorView.decorations)){if(typeof value==='function')continue;value.between(0,view.state.doc.length,(from,to,decoration)=>{ranges.push({from,to,class:decoration.spec.class});});}return ranges;};
    return {view,plugin,check,marked};
  }
  it('does not install work or schedule a timer when disabled',async()=>{
    const editor=harness('wrng',{enabled:()=>false});await vi.advanceTimersByTimeAsync(1000);expect(editor.check).not.toHaveBeenCalled();expect(editor.plugin).toBeUndefined();expect(vi.getTimerCount()).toBe(0);
  });
  it('debounces prose checks, excludes syntax, and publishes wavy-underline marks',async()=>{
    const text=String.raw`\section{wrng} $hidden$ % ignored
\cite{secretkey} \textbf{correct} NASA camelCase foo12 한글`;
    const editor=harness(text);await vi.advanceTimersByTimeAsync(399);expect(editor.check).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(2);
    expect(editor.check).toHaveBeenCalledTimes(1);const prepared=editor.check.mock.calls[0][0];expect(prepared.match(/[A-Za-z]+/g)).toEqual(['wrng','correct']);
    expect(editor.marked()).toEqual([{from:text.indexOf('wrng'),to:text.indexOf('wrng')+4,class:'cm-spell-error'}]);
  });
  it('checks only visible source with an 8 KiB pass cap and honors ignored words',async()=>{
    const text='offscreen '.repeat(100)+'wrng good '.repeat(1500),from='offscreen '.repeat(100).length;
    const editor=harness(text,{ignore:()=>['wrng']},{from,to:text.length});await vi.advanceTimersByTimeAsync(401);
    const prepared=editor.check.mock.calls[0][0];expect(prepared.length).toBeLessThanOrEqual(8192);expect(prepared).not.toContain('offscreen');expect(prepared).not.toContain('wrng');expect(editor.marked()).toEqual([]);
  });
  it('discards native results after edits and after plugin destruction',async()=>{
    const pending=Promise.withResolvers<{start:number;length:number}[]>();const editor=harness('wrng',{check:()=>pending.promise});await vi.advanceTimersByTimeAsync(401);
    editor.view.dispatch({changes:{from:0,to:4,insert:'right'}});editor.plugin?.update?.({docChanged:true,viewportChanged:false} as ViewUpdate);pending.resolve([{start:0,length:4}]);await vi.advanceTimersByTimeAsync(1);expect(editor.marked()).toEqual([]);
    editor.plugin?.destroy?.();await vi.advanceTimersByTimeAsync(1000);expect(editor.marked()).toEqual([]);
  });
});
