import { t } from "../../ui/i18n";
import type { Entry, PaperMark } from '../../contracts';
export const paperExtensions:Readonly<Record<string,true|undefined>>={tex:true,ltx:true,bib:true,cls:true,sty:true,bst:true,bbx:true,cbx:true};
// Legacy metadata stays excluded from discovery until its native one-time migration.
export const excludedDirectories:Readonly<Record<string,true|undefined>>={'.git':true,'.texypaper':true,'.paperdock':true,node_modules:true,'.venv':true,venv:true,__pycache__:true};
export function isPaperFile(name:string) {return paperExtensions[name.split('.').at(-1)?.toLowerCase()??'']===true;}
const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
export function sortEntries(entries:Entry[]) {return [...entries].sort((a,b)=>Number(b.kind==='directory')-Number(a.kind==='directory')||collator.compare(a.name,b.name));}
export function sameEntry(entry:Entry,next:Entry):boolean {
  return entry.path===next.path&&entry.name===next.name&&entry.kind===next.kind&&entry.byteLength===next.byteLength&&entry.paper===next.paper&&entry.main===next.main&&(entry.evidence?.length??0)===(next.evidence?.length??0)&&(!entry.evidence||entry.evidence.every((name,index)=>name===next.evidence?.[index]));
}
export function upsertEntries(index:Map<string,Entry>,entries:Entry[]):boolean {
  let changed=false;
  for(const entry of entries){
    const previous=index.get(entry.path);
    if(previous&&sameEntry(previous,entry))continue;
    index.set(entry.path,entry);changed=true;
  }
  return changed;
}
export class PaperIndex {
  readonly listings=new Map<string,Entry[]>();
  readonly marks=new Map<string,PaperMark>();
  readonly evidence=new Map<string,string[]>();
  private scannedMarks=new Map<string,PaperMark>();
  private scannedEvidence=new Map<string,string[]>();
  accept(entries:Entry[]){for(const entry of entries){if(entry.kind==='directory'&&entry.paper!=='unknown')this.scannedMarks.set(entry.path,entry.paper);else if(entry.kind==='file'&&isPaperFile(entry.name)){const parent=entry.path.split('/').slice(0,-1).join('/'),evidence=this.scannedEvidence.get(parent)??[];if(!evidence.includes(entry.name))evidence.push(entry.name);this.scannedEvidence.set(parent,evidence);this.scannedMarks.set(parent,'direct');}}this.recompute();}
  clear(){this.listings.clear();this.marks.clear();this.evidence.clear();this.scannedMarks.clear();this.scannedEvidence.clear();this.complete=false;}
  complete=false;
  update(path:string,entries:Entry[]):boolean {
    const current=this.listings.get(path),sorted=sortEntries(entries);
    const unchanged=current?.length===sorted.length&&current.every((entry,position)=>sameEntry(entry,sorted[position]));
    // A fresh listing also supersedes scan-only evidence, even when its entries did not change.
    if(unchanged&&!this.scannedEvidence.has(path)&&!this.scannedMarks.has(path))return false;
    this.scannedEvidence.delete(path);this.scannedMarks.delete(path);this.listings.set(path,sorted);
    this.recompute();return true;
  }
  invalidate(path:string) {
    const parent=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
    for(const key of this.listings.keys())if(key===path||key.startsWith(`${path}/`)||key===parent)this.listings.delete(key);
    for(const key of this.scannedMarks.keys())if(key===path||key.startsWith(`${path}/`)||key===parent)this.scannedMarks.delete(key);
    for(const key of this.scannedEvidence.keys())if(key===path||key.startsWith(`${path}/`)||key===parent)this.scannedEvidence.delete(key);
    this.complete=false;this.recompute();
  }
  private recompute() {
    this.marks.clear();this.evidence.clear();for(const [path,mark]of this.scannedMarks)this.marks.set(path,mark);
    for(const [path,entries] of this.listings) {
      const evidence=entries.filter(entry=>entry.kind!=='directory'&&isPaperFile(entry.name)).map(entry=>entry.name);
      this.marks.set(path,evidence.length?'direct':this.marks.get(path)==='descendant'?'descendant':'none');this.evidence.set(path,evidence);
      for(const entry of entries)if(entry.kind==='directory'&&entry.paper==='direct'){this.marks.set(entry.path,'direct');this.evidence.set(entry.path,entry.evidence??[]);}
    }
    for(const [path,evidence]of this.scannedEvidence){this.marks.set(path,'direct');this.evidence.set(path,evidence);}
    for(const [path,mark] of [...this.marks])if(mark==='direct'){
      let parent=path;while(parent.includes('/')){parent=parent.slice(0,parent.lastIndexOf('/'));if(this.marks.get(parent)!=='direct')this.marks.set(parent,'descendant');}
      if(path&&this.marks.get('')!=='direct')this.marks.set('','descendant');
    }
  }
  mark(path:string):PaperMark {return this.marks.get(path)??'unknown';}
}
export function resolveRelative(baseFile:string,destination:string) {
  if(!destination||/^(?:[A-Za-z]:|[\\/])/.test(destination)||destination.includes('\0')||destination.includes(':'))throw new Error(t('프로젝트 밖의 루트 문서는 사용할 수 없습니다.'));
  const parts=baseFile.split('/').slice(0,-1);
  for(const part of destination.replaceAll('\\','/').split('/')){if(part==='..'){if(!parts.length)throw new Error(t('프로젝트 밖의 루트 문서는 사용할 수 없습니다.'));parts.pop();}else if(part&&part!=='.')parts.push(part);}
  return parts.join('/');
}
export async function followTexRoot(path:string,read:(path:string)=>Promise<string>) {
  const visited=new Set<string>();let current=path;
  for(let hops=0;hops<16;hops++){
    if(visited.has(current))throw new Error(t('TeX 루트 지시문이 순환합니다.'));visited.add(current);
    const text=await read(current);const directive=text.match(/^\s*%\s*!TeX\s+root\s*=\s*(.+?)\s*$/im);
    if(!directive)return current;current=resolveRelative(current,directive[1]);
  }
  throw new Error(t('TeX 루트 지시문이 16단계를 넘었습니다.'));
}
