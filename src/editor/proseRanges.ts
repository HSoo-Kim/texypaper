export type ProseRange = { start:number; end:number };
const hiddenEnvironments = /^(?:equation|align|alignat|flalign|gather|multline|eqnarray|math|displaymath|verbatim|Verbatim|lstlisting|minted|comment)\*?$/;
const hiddenArguments = /^(?:label|(?:eq|auto|page|name)?ref|[cC]ref|[a-zA-Z]*[cC]ite[a-zA-Z]*|input|include|includegraphics|usepackage|documentclass|bibliography|bibliographystyle|url|path|ensuremath)$/;
const definitions = /^(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|newenvironment|renewenvironment|(?:New|Renew|Provide|Declare)Document(?:Command|Environment)|def|gdef|edef|xdef)$/;
const whitespacePattern=/\s*/y;
function whitespace(text:string, at:number) { while(at<text.length){whitespacePattern.lastIndex=at;at+=whitespacePattern.exec(text)![0].length;if(text[at]!=='%')break;at=commentEnd(text,at);}return at; }
function commentEnd(text:string, at:number) { const end=text.indexOf('\n',at);return end<0?text.length:end; }
function* groupEnd(text:string, at:number, open='{', close='}'):Generator<ProseRange|null,number> {
  if(text[at]!==open)return at;
  let depth=1;at++;
  let checkpoint=at+4096;
  while(at<text.length&&depth){if(at>=checkpoint){yield null;checkpoint=at+4096;}if(text[at]==='\\'){at+=Math.min(2,text.length-at);continue;}if(text[at]==='%'){at=commentEnd(text,at);continue;}if(text[at]===open)depth++;else if(text[at]===close)depth--;at++;}
  return at;
}
function* optionalArguments(text:string, at:number):Generator<ProseRange|null,number> { at=whitespace(text,at);while(text[at]==='['){at=whitespace(text,(yield* groupEnd(text,at,'[',']')));}return at; }
function escaped(text:string, at:number) { let count=0;while(at>0&&text[--at]==='\\')count++;return count%2===1; }
function commented(text:string, at:number) { const lineStart=text.lastIndexOf('\n',at-1)+1;let percent=text.indexOf('%',lineStart);while(percent>=0&&percent<at){if(!escaped(text,percent))return true;percent=text.indexOf('%',percent+1);}return false; }
function* documentStart(text:string):Generator<ProseRange|null,number> {
  // Ignore markers inside macro replacement groups, inline verbatim and comments.
  const tokens=/%[^\n]*|\\(?:[a-zA-Z@]+|[^\r\n])|[{}]/g;
  let depth=0,checkpoint=4096,match:RegExpExecArray|null;
  while((match=tokens.exec(text))){
    if(match.index>=checkpoint){yield null;checkpoint=match.index+4096;}
    const token=match[0];
    if(token==='{'){depth++;continue;}if(token==='}'){depth=Math.max(0,depth-1);continue;}
    if(token==='\\verb'||token==='\\lstinline'){
      let at=tokens.lastIndex;if(text[at]==='*')at++;at=yield* optionalArguments(text,at);
      const delimiter=text[at],end=delimiter?text.indexOf(delimiter,at+1):-1;tokens.lastIndex=end>=0?end+1:commentEnd(text,at);continue;
    }
    if(token!=='\\begin'||depth!==0)continue;
    const start=whitespace(text,tokens.lastIndex),end=yield* groupEnd(text,start);
    if(end===start)continue;const environment=text.slice(start+1,end-1).trim();tokens.lastIndex=end;
    if(environment==='document')return end;
    if(hiddenEnvironments.test(environment)){const close=`\\end{${environment}}`,at=text.indexOf(close,end);tokens.lastIndex=at<0?text.length:at+close.length;}
  }
  return 0;
}
/** Conservative TeX lexer, not macro expansion. Null yields are scan checkpoints:
 * consumers can cooperatively yield even inside long hidden arguments or math. */
export function* proseRangeIterator(text:string):Generator<ProseRange|null> {
  let at=yield* documentStart(text);
  let checkpoint=at+4096;
  while(at<text.length){
    if(at>=checkpoint){yield null;checkpoint=at+4096;}
    const char=text[at];
    if(char==='%'){at=commentEnd(text,at);continue;}
    if(char==='$'){
      const delimiter=text[at+1]==='$'?'$$':'$';at+=delimiter.length;
      while(at<text.length){if(at>=checkpoint){yield null;checkpoint=at+4096;}if(text[at]==='\\'){at+=2;continue;}if(text[at]==='%'){at=commentEnd(text,at);continue;}if(text.startsWith(delimiter,at)){at+=delimiter.length;break;}at++;}
      continue;
    }
    if(char==='\\'){
      at++;
      if(text[at]==='('||text[at]==='['){const end=text[at]==='('? '\\)':'\\]';at++;while(at<text.length){if(at>=checkpoint){yield null;checkpoint=at+4096;}if(text[at]==='%'){at=commentEnd(text,at);continue;}if(text.startsWith(end,at)){at+=2;break;}at+=text[at]==='\\'?2:1;}continue;}
      const command=/^[a-zA-Z@]+/.exec(text.slice(at,at+128));
      if(!command){at=Math.min(text.length,at+1);continue;}
      const name=command[0];at+=name.length;if(text[at]==='*')at++;
      if(name==='verb'||name==='lstinline'){
        at=yield* optionalArguments(text,at);const delimiter=text[at++];if(delimiter){const end=text.indexOf(delimiter,at),line=commentEnd(text,at);at=end>=0&&end<line?end+1:line;}continue;
      }
      if(name==='begin'||name==='end'){
        const arg=whitespace(text,at),end=yield* groupEnd(text,arg);if(end===arg)continue;
        const environment=text.slice(arg+1,end-1).trim();at=end;
        if(name==='end'&&environment==='document')return;
        if(name==='begin'&&hiddenEnvironments.test(environment)){
          const tag=environment.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),closing=new RegExp(`\\\\end\\s*\\{\\s*${tag}\\s*\\}`,'g');closing.lastIndex=at;
          const raw=/^(?:verbatim|Verbatim|lstlisting|minted|comment)\*?$/.test(environment);
          let close:RegExpExecArray|null;while((close=closing.exec(text))&&(escaped(text,close.index)||(!raw&&commented(text,close.index)))){if(closing.lastIndex>=checkpoint){yield null;checkpoint=closing.lastIndex+4096;}}
          at=close?close.index+close[0].length:text.length;
        }
        continue;
      }
      if(definitions.test(name)){
        at=whitespace(text,at);
        if(/^(?:[gex]?def)$/.test(name)){while(at<text.length&&text[at]!=='{'){if(at>=checkpoint){yield null;checkpoint=at+4096;}if(text[at]==='%')at=commentEnd(text,at);else at++;}}
        else {if(text[at]==='{')at=yield* groupEnd(text,at);else if(text[at]==='\\'){at++;while(at<text.length&&/[a-zA-Z@]/.test(text[at]))at++;}at=yield* optionalArguments(text,at);}
        if(/Document(?:Command|Environment)$/.test(name))at=yield* groupEnd(text,whitespace(text,at));
        at=yield* groupEnd(text,whitespace(text,at));
        if(/environment$/i.test(name))at=yield* groupEnd(text,whitespace(text,at));
        continue;
      }
      if(name==='href'||hiddenArguments.test(name)){
        at=yield* optionalArguments(text,at);
        if(text[at]==='{')at=yield* groupEnd(text,at);
        else if(name==='input'||name==='include')while(at<text.length&&!/[\s%]/.test(text[at])){if(at>=checkpoint){yield null;checkpoint=at+4096;}at++;}
        if(/cites$/i.test(name)){while(true){const next=yield* optionalArguments(text,at);if(text[next]!=='{')break;at=yield* groupEnd(text,next);}}
        continue;
      }
      // Optional layout/short-title arguments are not rendered prose. Braced text remains.
      at=yield* optionalArguments(text,at);continue;
    }
    if('{}[]&#_^~'.includes(char)){at++;continue;}
    const start=at;while(at<text.length&&at-start<4096&&!/[\\%${}\[\]&#_^~]/.test(text[at]))at++;
    if(at>start)yield {start,end:at};
  }
}
export function proseRanges(text:string):ProseRange[] {
  const ranges:ProseRange[]=[];
  for(const range of proseRangeIterator(text)){if(!range)continue;const previous=ranges.at(-1);if(previous&&previous.end===range.start)previous.end=range.end;else ranges.push(range);}
  return ranges;
}

/** Preserve UTF-16 positions, suppressing whole identifiers rather than checking fragments.
 * Non-ASCII scripts, digits, acronyms, camelCase and hyphen/underscore identifiers are not English words. */
export function spellingText(text:string, ranges:ProseRange[]=proseRanges(text), ignore:readonly string[]=[]):string {
  const output=Array<string>(text.length).fill(' '),ignored=new Set(ignore.map(word=>word.toLowerCase()));
  for(const {start,end} of ranges){
    const source=text.slice(start,end);
    for(const match of source.matchAll(/[\p{L}\p{M}\p{N}'’_\-]+/gu)){
      const word=match[0],from=start+match.index,to=from+word.length;
      if(!/^[A-Za-z]+(?:'[A-Za-z]+)*$/.test(word)||word.length>64||/^[A-Z]{2,}$/.test(word)||/[a-z][A-Z]/.test(word)||ignored.has(word.toLowerCase())||/[\p{L}\p{M}\p{N}'’_\-]/u.test(text[from-1]??'')||/[\p{L}\p{M}\p{N}'’_\-]/u.test(text[to]??''))continue;
      for(let index=0;index<word.length;index++)output[from+index]=word[index];
    }
  }
  return output.join('');
}
