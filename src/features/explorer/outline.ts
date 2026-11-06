export type OutlineHeading={line:number;level:1|2|3;title:string;starred:boolean;number:string|null};
export const MAX_OUTLINE_BYTES=4*1024*1024;
export const MAX_OUTLINE_HEADINGS=500;
const levels:Record<string,OutlineHeading['level']>={section:1,subsection:2,subsubsection:3};

/** Current-file, source-order numbering only; no TeX expansion or document-class counters. Offsets are one-based source lines. */
export function parseOutline(source:string):OutlineHeading[] {
  let end=0,bytes=0;
  while(end<source.length&&bytes<MAX_OUTLINE_BYTES){
    const point=source.codePointAt(end)!;
    const width=point>0xffff?2:1,cost=point<=0x7f?1:point<=0x7ff?2:point<=0xffff?3:4;
    if(bytes+cost>MAX_OUTLINE_BYTES)break;
    bytes+=cost;end+=width;
  }
  const text=source.slice(0,end),headings:OutlineHeading[]=[];
  const counters=[0,0,0];
  let cursor=0,line=1;
  const advance=()=>{
    if(text[cursor]==='\r'||text[cursor]==='\n'&&text[cursor-1]!=='\r')line++;
    cursor++;
  };
  const skipTrivia=()=>{
    while(cursor<text.length){
      if(/\s/.test(text[cursor])){advance();continue;}
      if(text[cursor]!=='%')break;
      while(cursor<text.length&&text[cursor]!=='\r'&&text[cursor]!=='\n')advance();
    }
  };
  const group=(open:string,close:string):string|null=>{
    if(text[cursor]!==open)return null;
    advance();let depth=1,braces=0;const parts:string[]=[];let start=cursor;
    while(cursor<text.length){
      const character=text[cursor];
      if(character==='\\'){
        advance();if(cursor<text.length)advance();continue;
      }
      if(character==='%'){
        parts.push(text.slice(start,cursor));
        while(cursor<text.length&&text[cursor]!=='\r'&&text[cursor]!=='\n')advance();
        start=cursor;continue;
      }
      if(open==='['){if(character==='{')braces++;else if(character==='}')braces=Math.max(0,braces-1);}
      if(braces===0||open==='{'){
        if(character===open)depth++;
        else if(character===close&&--depth===0){parts.push(text.slice(start,cursor));advance();return parts.join('');}
      }
      advance();
    }
    return null;
  };
  while(cursor<text.length&&headings.length<MAX_OUTLINE_HEADINGS){
    if(text[cursor]==='%'){while(cursor<text.length&&text[cursor]!=='\r'&&text[cursor]!=='\n')advance();continue;}
    if(text[cursor]!=='\\'){advance();continue;}
    const headingLine=line;advance();const start=cursor;
    while(cursor<text.length&&/[A-Za-z]/.test(text[cursor]))advance();
    if(cursor===start){if(cursor<text.length)advance();continue;}
    const name=text.slice(start,cursor);if(!Object.hasOwn(levels,name))continue;
    const level=levels[name];
    const starred=text[cursor]==='*';if(starred)advance();skipTrivia();
    if(text[cursor]==='['){if(group('[',']')===null)break;skipTrivia();}
    const title=group('{','}');
    if(title===null)continue;
    let number:string|null=null;
    if(!starred){
      counters[level-1]++;
      for(let index=level;index<counters.length;index++)counters[index]=0;
      number=counters.slice(0,level).join('.');
    }
    headings.push({line:headingLine,level,starred,number,title:title.replace(/\\([{}%&#_$])/g,'$1').replace(/\\[A-Za-z]+\*?/g,'').replace(/[{}]/g,'').replace(/\s+/g,' ').trim()});
  }
  return headings;
}
