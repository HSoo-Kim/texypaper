import {describe,it,expect,vi} from 'vitest';
import type {TextContent,TextItem} from 'pdfjs-dist/types/src/display/api';
import {readPageSearchText,selectionTextStream} from './pageText';
import {projectPageText,type PdfTextItem} from './selection';

const item=(str:string,hasEOL=false):TextItem=>({str,hasEOL,dir:'ltr',fontName:'font-1',transform:[1,0,0,1,10,20],width:30,height:10});

describe('one PDF extraction for text DOM and selection offsets',()=>{
 it('passes original chunks to the text layer while recording the same UTF16 item order',async()=>{
  const chunks:TextContent[]=[{items:[item('한글😀',true),{type:'beginMarkedContent',id:''}],styles:{},lang:'ko'},{items:[item('next '),item('line',true)],styles:{},lang:'ko'}];
  const source=new ReadableStream<TextContent>({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}});
  const items:PdfTextItem[]=[],reader=selectionTextStream(source,items).getReader();
  expect((await reader.read()).value).toBe(chunks[0]);
  expect((await reader.read()).value).toBe(chunks[1]);
  expect((await reader.read()).done).toBe(true);reader.releaseLock();
  expect(items.map(value=>value.str)).toEqual(['한글😀','next ','line']);
  expect(items[0]).toEqual({str:'한글😀',hasEOL:true,transform:[1,0,0,1,10,20],width:30,height:10});
  const projection=projectPageText(items);
  expect(projection.text).toBe('한글😀\nnext line\n');
  expect(projection.text.slice(projection.boundaries[4],projection.boundaries[8])).toBe('next');
 });
 it('propagates TextLayer reader cancellation to the worker extraction stream',async()=>{
  const cancel=vi.fn(),source=new ReadableStream<TextContent>({cancel});
  const reader=selectionTextStream(source,[]).getReader(),reason=new DOMException('closed','AbortError');
  await reader.cancel(reason);reader.releaseLock();
  expect(cancel).toHaveBeenCalledWith(reason);
  expect(source.locked).toBe(false);
 });
});

describe('cancellable PDF search extraction',()=>{
 it('opens one stream and preserves the existing inter-item search spacing',async()=>{
  const source=new ReadableStream<TextContent>({start(controller){controller.enqueue({items:[item('한글😀'),{type:'endMarkedContent',id:''},item('next')],styles:{},lang:'ko'});controller.close();}});
  const page={streamTextContent:vi.fn(()=>source),getTextContent:vi.fn()};
  expect(await readPageSearchText(page,new AbortController().signal)).toBe('한글😀 next');
  expect(page.streamTextContent).toHaveBeenCalledTimes(1);expect(page.getTextContent).not.toHaveBeenCalled();
  expect(source.locked).toBe(false);
 });
 it('cancels a pending worker reader and detaches the abort callback',async()=>{
  const cancel=vi.fn(),source=new ReadableStream<TextContent>({cancel}),controller=new AbortController();
  const add=vi.spyOn(controller.signal,'addEventListener'),remove=vi.spyOn(controller.signal,'removeEventListener');
  const result=readPageSearchText({streamTextContent:()=>source},controller.signal);
  controller.abort();
  await expect(result).rejects.toMatchObject({name:'AbortError'});
  expect(cancel).toHaveBeenCalledTimes(1);expect(source.locked).toBe(false);
  expect(remove).toHaveBeenCalledWith('abort',add.mock.calls[0][1]);
 });
 it('does not start an extraction for an already closed document',async()=>{
  const controller=new AbortController();controller.abort();const streamTextContent=vi.fn();
  await expect(readPageSearchText({streamTextContent},controller.signal)).rejects.toMatchObject({name:'AbortError'});
  expect(streamTextContent).not.toHaveBeenCalled();
 });
});
