import {describe,it,expect} from 'vitest';
import {byteToUtf16,utf16ToByte,viewportRectToPoints,pdfRectToViewport,projectPageText,type PdfTextItem} from './selection';
import {boundedPixelRatio,retainedPages,CANVAS_BUDGET,MAX_CANVASES,RenderBudget} from './renderBudget';
describe('physical source byte boundaries',()=>{
 it('round trips Korean, emoji, combining marks, BOM and CRLF',()=>{const source='\uFEFF한글😀e\u0301\r\nnext';let offset=0;for(const character of source){const byte=utf16ToByte(source,offset);expect(byteToUtf16(source,byte)).toBe(offset);offset+=character.length;}expect(utf16ToByte(source,1)).toBe(3);expect(byteToUtf16(source,utf16ToByte(source,source.length))).toBe(source.length);});
 it('rejects half a surrogate and UTF8 continuation bytes',()=>{expect(()=>utf16ToByte('A😀B',2)).toThrow('UNICODE_BOUNDARY');expect(()=>byteToUtf16('한글',1)).toThrow('UNICODE_BOUNDARY');expect(()=>byteToUtf16('abc',4)).toThrow('UNICODE_BOUNDARY');});
});
describe('page geometry',()=>{
 it('accounts for crop origin and UserUnit without dividing by zoom guesses',()=>{const view=[10,20,210,320],viewport={convertToPdfPoint:(x:number,y:number)=>[10+x/2,320-y/2]};expect(viewportRectToPoints({left:0,top:0,right:40,bottom:20},viewport,view,2)).toEqual([0,0,40,20]);});
 it('inverts 90 and 270 degree page rotation',()=>{const view=[10,20,210,320];const right={convertToPdfPoint:(x:number,y:number)=>[10+y/2,20+x/2]},left={convertToPdfPoint:(x:number,y:number)=>[210-y/2,320-x/2]};expect(viewportRectToPoints({left:0,top:0,right:40,bottom:20},right,view,2)).toEqual([0,560,20,40]);expect(viewportRectToPoints({left:0,top:0,right:40,bottom:20},left,view,2)).toEqual([380,0,20,40]);});
 it('transforms all four PDF corners and normalizes rotated viewport bounds',()=>{const viewport={convertToViewportPoint:(x:number,y:number)=>[2*(y-20),2*(x-10)]};expect(pdfRectToViewport([10,20,30,60],viewport)).toEqual({left:0,top:0,width:80,height:40});const shear={convertToViewportPoint:(x:number,y:number)=>[x-y,x+y]};expect(pdfRectToViewport([0,0,10,20],shear)).toEqual({left:-20,top:0,width:30,height:30});});
 it('rejects unsupported or nonfinite transforms',()=>{expect(()=>viewportRectToPoints({left:0,top:0,right:1,bottom:1},{convertToPdfPoint:()=>[NaN,0]},[0,0,10,10],1)).toThrow('PDF_GEOMETRY_UNSUPPORTED');});
});
describe('actual PDF text item boundaries',()=>{
 it('restores visual line separators without conflating DOM UTF16 offsets',()=>{const item=(str:string,hasEOL=false):PdfTextItem=>({str,hasEOL,transform:[1,0,0,1,0,0],width:10,height:10});const projection=projectPageText([item('한글😀',true),item('next ',false),item('line',true)]);expect(projection.text).toBe('한글😀\nnext line\n');expect(projection.boundaries[4]).toBe(5);expect(projection.text.slice(projection.boundaries[4],projection.boundaries[8])).toBe('next');});
});
describe('bounded render retention',()=>{
 it('retains only visible and one neighbor on either side',()=>{expect(retainedPages(1,30)).toEqual([1,2]);expect(retainedPages(15,30)).toEqual([14,15,16]);expect(retainedPages(30,30)).toEqual([29,30]);});
 it('enforces canvas byte budget at high DPI and zoom',()=>{for(const [width,height,dpr]of [[612,792,4],[6000,8000,4],[12000,4000,2]]){const ratio=boundedPixelRatio(width,height,dpr);const bytes=Math.floor(width*ratio)*Math.floor(height*ratio)*4;expect(bytes*3).toBeLessThanOrEqual(CANVAS_BUDGET);expect(ratio).toBeLessThanOrEqual(dpr);}});
 it('caps three actual backing stores at 24 MiB and releases evicted and closed canvases',()=>{
  expect(CANVAS_BUDGET).toBe(24*1024*1024);expect(MAX_CANVASES).toBe(3);
  const budget=new RenderBudget(),canvases=Array.from({length:4},()=>({width:0,height:0} as HTMLCanvasElement));
  for(const [index,canvas]of canvases.entries()){
   const ratio=boundedPixelRatio(4000,6000,3);canvas.width=Math.floor(4000*ratio);canvas.height=Math.floor(6000*ratio);
   budget.retain(index,canvas);
   expect(canvases.reduce((bytes,value)=>bytes+value.width*value.height*4,0)).toBeLessThanOrEqual(CANVAS_BUDGET);
  }
  expect(canvases[0].width).toBe(0);expect(canvases.filter(canvas=>canvas.width>0)).toHaveLength(3);
  budget.clear();expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
 });
});
