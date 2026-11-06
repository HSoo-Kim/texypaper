import { type EditorState, type Extension, type Text } from '@codemirror/state';
import { foldGutter, foldService } from '@codemirror/language';
import { EditorView } from '@codemirror/view';

type FoldRange = { from:number; to:number };
type Opening = { name:string; lineStart:number; from:number };
type Section = { level:number; lineStart:number; from:number };
const sectionLevels:Record<string,number>={part:0,chapter:1,section:2,subsection:3,subsubsection:4,paragraph:5,subparagraph:6};
const literalEnvironments:Record<string,true>={verbatim:true,'verbatim*':true,Verbatim:true,lstlisting:true,minted:true,comment:true};
const indexes=new WeakMap<Text,Map<number,FoldRange>>();

/** Strip only unescaped TeX comments (an even number of backslashes leaves % active). */
export function texCodeBeforeComment(text:string):string {
  for(let i=0;i<text.length;i++)if(text[i]==='%'){
    let slashes=0;for(let j=i-1;j>=0&&text[j]==='\\';j--)slashes++;
    if(slashes%2===0)return text.slice(0,i);
  }
  return text;
}

// One linear pass per immutable document, shared by gutter, F2 and fold-all.
// Iterating Text lines avoids flattening large buffers or rescanning the suffix for each fold.
function foldIndex(doc:Text):Map<number,FoldRange> {
  const cached=indexes.get(doc);if(cached)return cached;
  const ranges=new Map<number,FoldRange>(),environments:Opening[]=[],sections:Section[]=[];
  const save=(opening:{lineStart:number;from:number},to:number)=>{
    if(to>opening.from){const old=ranges.get(opening.lineStart);if(!old||opening.from<old.from)ranges.set(opening.lineStart,{from:opening.from,to});}
  };
  const closeSections=(to:number,minimumLevel:number,after=-1)=>{
    while(sections.length&&sections[sections.length-1].level>=minimumLevel&&sections[sections.length-1].from>after)save(sections.pop()!,to);
  };
  let lineStart=0;
  const tokens=/\\(begin|end)\s*\{([^{}\s]+)\}|\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?=\s*[\[{])/g;
  for(const text of doc.iterLines()){
    const lineEnd=lineStart+text.length,literal=environments.at(-1);
    const code=literal&&literalEnvironments[literal.name]===true?text:texCodeBeforeComment(text);
    if(literal&&literalEnvironments[literal.name]===true){
      const closing=`\\end{${literal.name}}`;
      if(code.includes(closing)){save(environments.pop()!,lineStart);}
      lineStart=lineEnd+1;continue;
    }
    tokens.lastIndex=0;
    for(let match:RegExpExecArray|null;(match=tokens.exec(code));){
      // A command preceded by an odd backslash count is escaped, not a TeX command.
      let slashes=0;for(let i=match.index!-1;i>=0&&code[i]==='\\';i--)slashes++;
      if(slashes%2)continue;
      if(match[1]==='begin'){
        environments.push({name:match[2],lineStart,from:lineEnd});
        if(literalEnvironments[match[2]]===true){
          if(code.indexOf(`\\end{${match[2]}}`,match.index+match[0].length)>=0)environments.pop();
          break;
        }
      }else if(match[1]==='end'){
        const opening=environments.at(-1);
        if(opening?.name===match[2]){
          environments.pop();save(opening,lineStart);
          closeSections(lineStart,0,opening.from-1);
        }
      }else{
        const level=sectionLevels[match[3]];
        closeSections(Math.max(0,lineStart-1),level);
        sections.push({level,lineStart,from:lineEnd});
      }
    }
    lineStart=lineEnd+1;
  }
  closeSections(doc.length,0);
  indexes.set(doc,ranges);return ranges;
}

export function texFoldRange(state:EditorState,lineStart:number):FoldRange|null {
  return foldIndex(state.doc).get(lineStart)??null;
}

export function texFoldingExtensions():Extension[] {
  return [foldService.of((state,lineStart)=>texFoldRange(state,lineStart)),foldGutter(),EditorView.theme({
    '.cm-foldGutter':{width:'1.1em'},
    '.cm-foldGutter .cm-gutterElement':{padding:'0 2px',cursor:'pointer'},
  })];
}
