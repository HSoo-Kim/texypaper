import {afterEach,describe,it,expect,vi} from 'vitest';

// Exercise our transport lifecycle without starting PDF.js DOM/worker machinery.
// This is the installed PDFDataRangeTransport's public listener contract.
vi.mock('pdfjs-dist',()=>({PDFDataRangeTransport:class{
 initialData:Uint8Array|null;private listener:((value:unknown)=>void)|null=null;
 constructor(public length:number,initial:Uint8Array,public progressiveDone:boolean){this.initialData=initial;}
 transportReady(listener:(value:unknown)=>void){this.listener=listener;}
 onDataRange(begin:number,chunk:Uint8Array){this.listener?.({type:'range',begin,chunk});}
 abort(){}
}}));

import {createArtifactTransport,type ArtifactMetadata} from './artifactTransport';
import {PDF_RANGE_CHUNK} from './rangeRequests';

const metadata:ArtifactMetadata={length:PDF_RANGE_CHUNK*5,sha256:'hash',buildId:'build',url:'http://artifact/pdf'};
function initialResponse(){return new Response(new Uint8Array(PDF_RANGE_CHUNK),{status:206,headers:{'Content-Range':`bytes 0-${PDF_RANGE_CHUNK-1}/${metadata.length}`}});}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('ranged PDF transport disposal',()=>{
 it('detaches the parent abort listener, initial bytes and PDF.js stream listener',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(initialResponse()));
  const controller=new AbortController(),add=vi.spyOn(controller.signal,'addEventListener'),remove=vi.spyOn(controller.signal,'removeEventListener');
  const transport=await createArtifactTransport(metadata,controller.signal),deliver=vi.fn();
  transport.transportReady(deliver);expect(transport.initialData?.length).toBe(PDF_RANGE_CHUNK);
  transport.abort();transport.abort();
  expect(transport.initialData).toBeNull();
  expect(add).toHaveBeenCalledTimes(1);expect(remove).toHaveBeenCalledWith('abort',add.mock.calls[0][1]);
  transport.onDataRange(0,new Uint8Array([1]));
  // A late PDF.js ready notification must not reconnect an already aborted stream.
  transport.transportReady(deliver);transport.onDataRange(0,new Uint8Array([2]));
  expect(deliver).not.toHaveBeenCalled();
 });
 it('aborts both active fetches and drops queued ranges without late delivery',async()=>{
  vi.useFakeTimers();
  const first=Promise.withResolvers<Response>(),second=Promise.withResolvers<Response>();
  const signals:AbortSignal[]=[],pending=[first,second];let next=0;
  const fetchRange=vi.fn().mockResolvedValueOnce(initialResponse()).mockImplementation((_url:unknown,options:RequestInit)=>{
   signals.push(options.signal!);return pending[next++].promise;
  });
  vi.stubGlobal('fetch',fetchRange);
  const controller=new AbortController(),transport=await createArtifactTransport(metadata,controller.signal),deliver=vi.fn();
  transport.transportReady(deliver);
  for(let begin=PDF_RANGE_CHUNK;begin<PDF_RANGE_CHUNK*4;begin+=PDF_RANGE_CHUNK)transport.requestDataRange(begin,begin+PDF_RANGE_CHUNK);
  expect(fetchRange).toHaveBeenCalledTimes(3);expect(signals).toHaveLength(2);
  controller.abort();expect(signals.every(signal=>signal.aborted)).toBe(true);
  first.reject(new DOMException('Cancelled','AbortError'));second.reject(new DOMException('Cancelled','AbortError'));
  await Promise.allSettled([first.promise,second.promise]);
  const settled=Promise.withResolvers<void>();setTimeout(settled.resolve,0);await vi.runAllTimersAsync();await settled.promise;
  expect(fetchRange).toHaveBeenCalledTimes(3);expect(deliver).not.toHaveBeenCalled();
  transport.requestDataRange(PDF_RANGE_CHUNK*4,metadata.length);expect(fetchRange).toHaveBeenCalledTimes(3);
 });
 it('removes its abort callback when the initial range fails',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(null,{status:500})));
  const controller=new AbortController(),add=vi.spyOn(controller.signal,'addEventListener'),remove=vi.spyOn(controller.signal,'removeEventListener');
  await expect(createArtifactTransport(metadata,controller.signal)).rejects.toThrow('PDF_RANGE_500');
  expect(remove).toHaveBeenCalledWith('abort',add.mock.calls[0][1]);
 });
 it('does not fetch for an already closed document',async()=>{
  const fetchRange=vi.fn();vi.stubGlobal('fetch',fetchRange);const controller=new AbortController();controller.abort();
  await expect(createArtifactTransport(metadata,controller.signal)).rejects.toMatchObject({name:'AbortError'});
  expect(fetchRange).not.toHaveBeenCalled();
 });
});
