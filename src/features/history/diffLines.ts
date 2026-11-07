export type DiffLine={kind:'context'|'added'|'removed';text:string;beforeLine?:number;afterLine?:number};
export type DiffHunk={beforeStart:number;afterStart:number;lines:DiffLine[];blockReplace?:boolean};
/** CRLF is presentation-equivalent to LF; checkpoint restore keeps the original text untouched. */
export function diffLines(before:string,after:string,context=3):DiffHunk[]{
 const normalizedBefore=before.replace(/\r\n/g,'\n'),normalizedAfter=after.replace(/\r\n/g,'\n');
 if(normalizedBefore===normalizedAfter)return [];
 const left=normalizedBefore.split('\n'),right=normalizedAfter.split('\n');
 // Two text blocks avoid allocating an object per line for very large newline-heavy files.
 if(left.length>5000||right.length>5000||left.length*right.length>4000000)return [{beforeStart:1,afterStart:1,blockReplace:true,lines:[{kind:'removed',text:normalizedBefore,beforeLine:1},{kind:'added',text:normalizedAfter,afterLine:1}]}];
 const width=right.length+1,table=new Uint16Array((left.length+1)*width);
 for(let i=left.length-1;i>=0;i--)for(let j=right.length-1;j>=0;j--)table[i*width+j]=left[i]===right[j]?1+table[(i+1)*width+j+1]:Math.max(table[(i+1)*width+j],table[i*width+j+1]);
 const lines:DiffLine[]=[];let i=0,j=0;
 while(i<left.length||j<right.length){if(i<left.length&&j<right.length&&left[i]===right[j]){lines.push({kind:'context',text:left[i],beforeLine:i+1,afterLine:j+1});i++;j++;}else if(i<left.length&&(j===right.length||table[(i+1)*width+j]>=table[i*width+j+1])){lines.push({kind:'removed',text:left[i],beforeLine:++i});}else{lines.push({kind:'added',text:right[j],afterLine:++j});}}
 const padding=Math.max(0,Math.floor(context)),ranges:{start:number;end:number}[]=[];
 for(let index=0;index<lines.length;index++){if(lines[index].kind==='context')continue;const start=Math.max(0,index-padding),end=Math.min(lines.length,index+padding+1),last=ranges.at(-1);if(last&&start<=last.end)last.end=end;else ranges.push({start,end});}
 return ranges.map(({start,end})=>({beforeStart:lines.slice(0,start).filter(line=>line.kind!=='added').length+1,afterStart:lines.slice(0,start).filter(line=>line.kind!=='removed').length+1,lines:lines.slice(start,end)}));
}
