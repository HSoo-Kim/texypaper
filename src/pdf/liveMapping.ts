import type {SynctexData, SynctexParser} from 'wasmtex/synctex';
import type {BuildManifest} from '../contracts';
import type {BufferStore} from '../editor/buffers';

/** Owned by one immutable PDF, never by the latest editor revision. */
export type LiveMapping={synctex:Uint8Array|null;synctexData?:SynctexData|null;prefix:string;files:Readonly<Record<string,string|Uint8Array>>;range?:{firstPage:number;lastPage:number}};
export type SyncRegion={page:number;h:number;v:number;W:number;H:number};
const parsed=new WeakMap<LiveMapping,Promise<{parser:SynctexParser;data:SynctexData}>>();
const decoder=new TextDecoder('utf-8',{fatal:true});
const decoded=new WeakMap<Uint8Array,string>();

export function inputPath(value:string):string|null {
  let path=value.replaceAll('\\','/');
  if(path.startsWith('/work/'))path=path.slice(6);
  while(path.startsWith('./'))path=path.slice(2);
  if(!path||path.startsWith('/')||path.includes(':'))return null;
  const parts=path.split('/').filter(part=>part!=='.');
  if(parts.some(part=>!part||part==='..'||part.includes('\0')))return null;
  return parts.join('/');
}
export function workspaceInput(mapping:LiveMapping,input:string):string|null {
  const path=inputPath(input),prefix=mapping.prefix?inputPath(mapping.prefix.replace(/\/$/,'')):'';
  if(!path||prefix===null||!Object.hasOwn(mapping.files,path))return null;
  return prefix?`${prefix}/${path}`:path;
}
export function compiledText(mapping:LiveMapping,path:string):string|null {
  const prefix=mapping.prefix?inputPath(mapping.prefix.replace(/\/$/,'')):'';
  if(prefix===null||prefix&&!path.startsWith(`${prefix}/`))return null;
  const input=prefix?path.slice(prefix.length+1):path;
  if(workspaceInput(mapping,input)!==path)return null;
  const value=mapping.files[input];
  if(typeof value==='string')return value;
  try{let text=decoded.get(value);if(text===undefined){text=decoder.decode(value);decoded.set(value,text);}return text;}catch{return null;}
}
export function liveSourcesAgree(mapping:LiveMapping,store:BufferStore):boolean {
  for(const record of store.records.values()){
    if(record.evicted)continue;
    const compiled=compiledText(mapping,record.path);
    if(compiled!==null&&(record.composing||record.uncertain||record.external||record.error||store.text(record)!==compiled))return false;
  }
  return true;
}
export function canonicalSourcesAgree(manifest:Pick<BuildManifest,'sources'>,store:BufferStore):boolean {
  return manifest.sources.every(source=>{
    const record=store.records.get(source.path);
    return !record||record.evicted||!record.dirty&&!record.composing&&!record.uncertain&&!record.external&&!record.error&&record.document.revision.sha256===source.sha256;
  });
}
async function index(mapping:LiveMapping){
  let pending=parsed.get(mapping);
  if(!pending){pending=(async()=>{
    const {SynctexParser}=await import('wasmtex/synctex'),parser=new SynctexParser();
    const data=mapping.synctexData??(mapping.synctex?await parser.parse(mapping.synctex):null);
    if(!data)throw new Error('SYNC_MAPPING_UNAVAILABLE');
    return {parser,data};
  })();parsed.set(mapping,pending);}
  return pending;
}
function withinFrame(mapping:LiveMapping,page:number){
  if(!Number.isSafeInteger(page)||page<1)return false;
  const range=mapping.range;
  return !range||Number.isSafeInteger(range.firstPage)&&Number.isSafeInteger(range.lastPage)&&range.firstPage>=1&&range.firstPage<=range.lastPage&&page>=range.firstPage&&page<=range.lastPage;
}
export async function liveForward(mapping:LiveMapping,path:string,line:number):Promise<SyncRegion[]> {
  const {parser,data}=await index(mapping);
  const file=[...data.inputs.values()].find(input=>workspaceInput(mapping,input)===path);
  if(!file||!Number.isInteger(line)||line<1)return [];
  const match=parser.forwardLookupDetailed(data,file,line,{acceptSource:source=>source.line===line&&workspaceInput(mapping,source.file)===path});
  if(!match||match.match!=='exact')return [];
  return match.regions.filter(region=>withinFrame(mapping,region.page)&&[region.x,region.y,region.width,region.height].every(Number.isFinite)).map(region=>({page:region.page,h:region.x,v:region.y+region.height,W:region.width,H:region.height}));
}
export async function liveInverse(mapping:LiveMapping,page:number,x:number,y:number){
  if(!withinFrame(mapping,page))return null;
  const {parser,data}=await index(mapping);
  const match=parser.inverseLookupDetailed(data,page,x,y,{acceptSource:source=>workspaceInput(mapping,source.file)!==null});
  if(!match)return null;
  const path=workspaceInput(mapping,match.source.file);
  if(!path||!Number.isInteger(match.source.line)||match.source.line<1)return null;
  return {path,line:match.source.line,column:match.source.column??1,nearby:match.match==='nearby'};
}
