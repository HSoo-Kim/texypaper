import type { Environment, TextDocument, WorkspaceRef } from '../contracts';
import { native, request } from '../api';
import { followTexRoot } from '../features/explorer/paperIndex';
export type ProjectSettings={version:1;rootTex:string|null;engine:'pdflatex'|'xelatex'|'lualatex';profile:'basic'|'project';autoBuild:boolean;};
export const defaultProject:ProjectSettings={version:1,rootTex:null,engine:'pdflatex',profile:'basic',autoBuild:true};
export async function openWorkspace(environment:Environment,root:string){return native<WorkspaceRef>('workspace_open',{environment,root});}
const texFile=/\.(tex|ltx)$/i;
// An uncommented \documentclass marks a compilable main document.
export const hasDocumentClass=(text:string)=>/^[^%\r\n]*\\documentclass\s*(?:\[[^\]]*\])?\s*\{/m.test(text);
const parent=(path:string)=>path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
/**
 * Overleaf-like main-document resolution:
 * 1. `% !TeX root = ...` in the opened file;
 * 2. the opened file itself when it declares \documentclass, unless the user explicitly chose a main document;
 * 3. the current main document (explicit or previously detected);
 * 4. the nearest folder (the opened file's, then its parents) holding exactly one \documentclass file.
 * Several candidates at the same level are ambiguous and return null, never an arbitrary pick.
 */
export async function findRoot(workspace:WorkspaceRef,opened:string|undefined,current:string|null,explicit:boolean,texPaths:Iterable<string>,openedText?:string){
  const read=async(path:string)=>(await request<TextDocument>('file_read',workspace,{path})).text;
  if(opened&&texFile.test(opened)){
    const text=openedText??await read(opened);
    if(/^\s*%\s*!TeX\s+root\s*=/im.test(text))return followTexRoot(opened,read);
    if(!explicit&&hasDocumentClass(text))return opened;
  }
  if(current)return current;
  const files=[...new Set(texPaths)].filter(path=>texFile.test(path));
  const levels:string[]=[];
  for(let level=opened?parent(opened):'';;level=parent(level)){levels.push(level);if(!level)break;}
  for(const level of levels){
    const candidates:string[]=[];
    for(const path of files.filter(path=>parent(path)===level&&path!==opened).slice(0,32))if(hasDocumentClass(await read(path).catch(()=>'')))candidates.push(path);
    if(candidates.length===1)return candidates[0];
    if(candidates.length>1)return null;
  }
  return null;
}
