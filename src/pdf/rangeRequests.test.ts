import {describe,it,expect} from 'vitest';
import {fulfillPdfRange,PDF_RANGE_CHUNK} from './rangeRequests';

describe('PDF.js complete range-reader deliveries',()=>{
 it('fetches bounded chunks but delivers a merged interval once at its original begin',async()=>{
  const begin=PDF_RANGE_CHUNK,end=PDF_RANGE_CHUNK*3+17;
  const reads:{begin:number;end:number}[]=[],deliveries:{begin:number;bytes:Uint8Array}[]=[];
  await fulfillPdfRange({begin,end},async(start,stop)=>{
   reads.push({begin:start,end:stop});
   return Uint8Array.from({length:stop-start},(_,index)=>(start+index)%251);
  },(offset,bytes)=>deliveries.push({begin:offset,bytes}),new AbortController().signal);
  expect(reads).toEqual([{begin,end:begin+PDF_RANGE_CHUNK},{begin:begin+PDF_RANGE_CHUNK,end:begin+2*PDF_RANGE_CHUNK},{begin:begin+2*PDF_RANGE_CHUNK,end}]);
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].begin).toBe(begin);
  expect(deliveries[0].bytes.length).toBe(end-begin);
  expect(deliveries[0].bytes.every((byte,index)=>byte===(begin+index)%251)).toBe(true);
  expect(reads.every(read=>read.end-read.begin<=PDF_RANGE_CHUNK)).toBe(true);
 });
 it('hands a single fetched chunk through without making a second buffer',async()=>{
  const fetched=new Uint8Array([3,4,5]);let delivered:Uint8Array|undefined;
  await fulfillPdfRange({begin:7,end:10},async()=>fetched,(begin,bytes)=>{expect(begin).toBe(7);delivered=bytes;},new AbortController().signal);
  expect(delivered).toBe(fetched);
 });
 it('never delivers a partial reader after abort between fetches',async()=>{
  const controller=new AbortController();let reads=0,delivered=0;
  await expect(fulfillPdfRange({begin:0,end:PDF_RANGE_CHUNK+8},async(begin,end)=>{
   reads++;controller.abort();return new Uint8Array(end-begin);
  },()=>{delivered++;},controller.signal)).rejects.toMatchObject({name:'AbortError'});
  expect(reads).toBe(1);expect(delivered).toBe(0);
 });
 it('rejects truncated chunks instead of delivering zero-padded fake bytes',async()=>{
  let delivered=false;
  await expect(fulfillPdfRange({begin:0,end:PDF_RANGE_CHUNK+4},async()=>new Uint8Array(2),()=>{delivered=true;},new AbortController().signal)).rejects.toThrow('PDF_RANGE_TRUNCATED');
  expect(delivered).toBe(false);
 });
});
