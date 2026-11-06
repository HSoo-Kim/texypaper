import type { CommentThread } from '../../contracts';
import { byteToUtf16, utf16ToByte } from '../../editor/buffers';
export type SourceAnchor=NonNullable<CommentThread['source']>;
export function reanchor(anchor:SourceAnchor,text:string,sha256:string):SourceAnchor|null {
  if(!anchor.quote)return null;
  let start=0,found=-1;
  while(start<=text.length){const at=text.indexOf(anchor.quote,start);if(at<0)break;
    if(text.slice(Math.max(0,at-anchor.before.length),at)===anchor.before&&text.slice(at+anchor.quote.length,at+anchor.quote.length+anchor.after.length)===anchor.after){if(found>=0)return null;found=at;}
    start=at+Math.max(1,anchor.quote.length);
  }
  return found<0?null:{...anchor,startByte:utf16ToByte(text,found),endByte:utf16ToByte(text,found+anchor.quote.length),baseSha256:sha256};
}
export function mapAnchor(anchor:SourceAnchor,startByte:number,endByte:number,newByteLength:number):SourceAnchor|null {
  if(endByte<=anchor.startByte){const shift=newByteLength-(endByte-startByte);return {...anchor,startByte:anchor.startByte+shift,endByte:anchor.endByte+shift};}
  if(startByte>=anchor.endByte)return anchor;
  return null;
}
export function sourceAnchorLine(anchor:SourceAnchor,text:string){return text.slice(0,byteToUtf16(text,anchor.startByte)).split(/\r\n|\n|\r/).length;}
