import type {PageViewport} from 'pdfjs-dist';
export type PdfTextItem={str:string;transform:number[];width:number;height:number;hasEOL?:boolean};
export type PageSelection={page:number;rects:number[][];textItems:PdfTextItem[];startOffset:number;endOffset:number};
export type PdfSelection={buildId:string;pdfSha256:string;pageSelections:PageSelection[];quote:string;before:string;after:string};
export function utf16ToByte(text:string,offset:number){if(offset<0||offset>text.length||offset>0&&offset<text.length&&/[\uD800-\uDBFF]/.test(text[offset-1])&&/[\uDC00-\uDFFF]/.test(text[offset]))throw new Error('UNICODE_BOUNDARY');return new TextEncoder().encode(text.slice(0,offset)).length;}
export function byteToUtf16(text:string,offset:number){const bytes=new TextEncoder().encode(text);if(offset<0||offset>bytes.length||offset<bytes.length&&(bytes[offset]&0xc0)===0x80)throw new Error('UNICODE_BOUNDARY');return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,offset)).length;}
export function viewportRectToPoints(rect:{left:number;top:number;right:number;bottom:number},viewport:Pick<PageViewport,'convertToPdfPoint'>,view:number[],userUnit:number){const corners=[[rect.left,rect.top],[rect.right,rect.top],[rect.left,rect.bottom],[rect.right,rect.bottom]].map(([x,y])=>viewport.convertToPdfPoint(x,y));if(view.length!==4||!Number.isFinite(userUnit)||userUnit<=0||corners.some(p=>p.some(v=>!Number.isFinite(v))))throw new Error('PDF_GEOMETRY_UNSUPPORTED');const xs=corners.map(p=>(p[0]-view[0])*userUnit),ys=corners.map(p=>(view[3]-p[1])*userUnit);return [Math.min(...xs),Math.min(...ys),Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys)];}
export function pdfRectToViewport(rect:number[],viewport:Pick<PageViewport,'convertToViewportPoint'>){
 if(rect.length!==4)throw new Error('PDF_GEOMETRY_UNSUPPORTED');
 const points=[[rect[0],rect[1]],[rect[2],rect[1]],[rect[0],rect[3]],[rect[2],rect[3]]].map(([x,y])=>viewport.convertToViewportPoint(x,y));
 if(points.some(point=>point.some(value=>typeof value!=='number'||!Number.isFinite(value))))throw new Error('PDF_GEOMETRY_UNSUPPORTED');
 const xs=points.map(point=>point[0]),ys=points.map(point=>point[1]);const left=Math.min(...xs),top=Math.min(...ys);
 return {left,top,width:Math.max(...xs)-left,height:Math.max(...ys)-top};
}
export function projectPageText(items:PdfTextItem[]){
 let text='',raw=0;const boundaries=[0];
 for(const item of items){for(let i=0;i<item.str.length;i++){text+=item.str[i];raw++;boundaries[raw]=text.length;}if(item.hasEOL){text+='\n';boundaries[raw]=text.length;}}
 return {text,boundaries};
}
export function captureSelection(selection:Selection,identity:{buildId:string;pdfSha256:string},pages:Map<number,{layer:HTMLElement;viewport:PageViewport;view:number[];userUnit:number;items:PdfTextItem[]}>):PdfSelection|null{
 if(selection.isCollapsed||selection.rangeCount!==1)return null;
 const range=selection.getRangeAt(0);const pageSelections:PageSelection[]=[];const quotes:string[]=[];let before='',after='';
 for(const [page,entry]of pages){
  if(!range.intersectsNode(entry.layer))continue;
  const contentRange=document.createRange();contentRange.selectNodeContents(entry.layer);const clipped=range.cloneRange();
  if(clipped.compareBoundaryPoints(Range.START_TO_START,contentRange)<0)clipped.setStart(contentRange.startContainer,contentRange.startOffset);
  if(clipped.compareBoundaryPoints(Range.END_TO_END,contentRange)>0)clipped.setEnd(contentRange.endContainer,contentRange.endOffset);
  const prefix=document.createRange();prefix.selectNodeContents(entry.layer);prefix.setEnd(clipped.startContainer,clipped.startOffset);
  const startOffset=prefix.toString().length,endOffset=startOffset+clipped.toString().length;
  const bounds=entry.layer.getBoundingClientRect(),raw=Array.from(clipped.getClientRects()).filter(r=>r.width>0.2&&r.height>0.2);
  const merged:{left:number;right:number;top:number;bottom:number}[]=[];
  for(const rect of raw){const previous=merged.find(r=>Math.abs(r.top-(rect.top-bounds.top))<2&&Math.abs(r.bottom-(rect.bottom-bounds.top))<2&&rect.left-bounds.left<=r.right+4&&rect.right-bounds.left>=r.left-4);if(previous){previous.left=Math.min(previous.left,rect.left-bounds.left);previous.right=Math.max(previous.right,rect.right-bounds.left);}else merged.push({left:rect.left-bounds.left,right:rect.right-bounds.left,top:rect.top-bounds.top,bottom:rect.bottom-bounds.top});}
  const rects=merged.map(r=>viewportRectToPoints(r,entry.viewport,entry.view,entry.userUnit));if(!rects.length)continue;
  pageSelections.push({page,rects,textItems:entry.items,startOffset,endOffset});
  const projection=projectPageText(entry.items),start=projection.boundaries[startOffset],end=projection.boundaries[endOffset];
  if(start===undefined||end===undefined)throw new Error('PDF_TEXT_OFFSET_MISMATCH');
  const selectedText=projection.text.slice(start,end),trailing=selectedText.endsWith('\n')?'\n':'';
  quotes.push(trailing?selectedText.slice(0,-1):selectedText);
  if(pageSelections.length===1)before=Array.from(projection.text.slice(0,start)).slice(-32).join('');
  after=trailing+Array.from(projection.text.slice(end)).slice(0,32).join('');
 }
 if(!pageSelections.length)return null;return {...identity,pageSelections,quote:quotes.join('\n'),before,after};
}
