import {describe,it,expect} from 'vitest';
import {SynctexParser} from 'wasmtex/synctex';
import {BufferStore,type BufferRecord} from '../editor/buffers';
import {canonicalSourcesAgree,compiledText,inputPath,liveForward,liveInverse,liveSourcesAgree,workspaceInput,type LiveMapping} from './liveMapping';

const synctex=`SyncTeX Version:1
Input:1:/work/./chapters/shared.tex
Input:2:/work/./other/shared.tex
Output:pdf
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
[1,1:0,49152000:32768000,45875200,0
(1,7:3276800,6553600:6553600,655360,131072
k1,7:3276800,6553600:655360
)
]
}
{2
[2,1:0,49152000:32768000,45875200,0
(2,12:3276800,6553600:6553600,655360,131072
k2,12:3276800,6553600:655360
)
]
}
Postamble:
`;
function mapping(parsed=true):LiveMapping {
  return {prefix:'논문/',files:{'chapters/shared.tex':'compiled chapter','other/shared.tex':'other chapter'},synctex:parsed?null:new TextEncoder().encode(synctex),...(parsed?{synctexData:new SynctexParser().parseText(synctex)}:{})};
}
function buffers(){
  const store=new BufferStore({id:'workspace',epoch:1,root:'/papers',environmentId:'local'},()=>{},()=>{});
  const record:BufferRecord={path:'논문/chapters/shared.tex',generation:1,version:0,lastUsed:0,state:null,dirty:false,saving:false,composing:false,document:{file:{workspaceId:'workspace',path:'논문/chapters/shared.tex'},text:'compiled chapter',revision:{sha256:'built',byteLength:16,modifiedNs:'0'},encoding:'utf8',newline:'lf',readOnly:false}};
  store.records.set(record.path,record);store.activePath=record.path;return {store,record};
}

describe('per-PDF live SyncTeX mapping',()=>{
  it.each([true,false])('uses the pinned public parser for parsed=%s, preserving input directories',async parsed=>{
    const frame=mapping(parsed),regions=await liveForward(frame,'논문/chapters/shared.tex',7);
    expect(regions).toHaveLength(1);expect(regions[0].page).toBe(1);
    const region=regions[0],hit=await liveInverse(frame,region.page,region.h+1,region.v-region.H/2);
    expect(hit?.path).toBe('논문/chapters/shared.tex');expect(hit?.line).toBe(7);
    const other=await liveForward(frame,'논문/other/shared.tex',12);expect(other[0]?.page).toBe(2);
  });
  it('never substitutes a nearby line for an exact forward request',async()=>{
    expect(await liveForward(mapping(),'논문/chapters/shared.tex',8)).toEqual([]);
    expect(await liveForward(mapping(),'논문/shared.tex',7)).toEqual([]);
  });
  it('rejects traversal, external inputs and basename-only collisions',async()=>{
    const frame=mapping();
    for(const path of ['../chapters/shared.tex','/texlive/shared.tex','C:/papers/shared.tex','//server/shared.tex','chapters//shared.tex'])expect(workspaceInput(frame,path)).toBeNull();
    expect(workspaceInput(frame,'/work/./chapters/./shared.tex')).toBe('논문/chapters/shared.tex');
    expect(workspaceInput(frame,'shared.tex')).toBeNull();
    expect(inputPath('chapters/../shared.tex')).toBeNull();
    frame.files={'other/shared.tex':'other chapter'};
    expect(await liveInverse(frame,1,55,95)).toBeNull();
  });
  it('does not reuse an index or source snapshot from another frame',async()=>{
    const first=mapping(),second=mapping();second.synctexData=new SynctexParser().parseText(synctex.replaceAll('1,7:','1,27:'));
    expect(await liveForward(first,'논문/chapters/shared.tex',7)).toHaveLength(1);
    expect(await liveForward(second,'논문/chapters/shared.tex',7)).toEqual([]);
    expect(await liveForward(second,'논문/chapters/shared.tex',27)).toHaveLength(1);
  });
  it('requires compiled/current agreement for every opened compiled input',()=>{
    const frame=mapping(),{store,record}=buffers();expect(liveSourcesAgree(frame,store)).toBe(true);
    record.document.text='edited after this PDF';expect(liveSourcesAgree(frame,store)).toBe(false);
    record.document.text='compiled chapter';record.composing=true;expect(liveSourcesAgree(frame,store)).toBe(false);
    record.composing=false;record.external=record.document;expect(liveSourcesAgree(frame,store)).toBe(false);
  });
  it('rejects canonical dirty or saved-but-newer source revisions',()=>{
    const {store,record}=buffers(),manifest={sources:[{path:record.path,sha256:'built',snapshotPath:'snapshot'}]};
    expect(canonicalSourcesAgree(manifest,store)).toBe(true);
    record.dirty=true;expect(canonicalSourcesAgree(manifest,store)).toBe(false);
    record.dirty=false;record.document.revision.sha256='newer';expect(canonicalSourcesAgree(manifest,store)).toBe(false);
  });
  it('decodes immutable compiled UTF-8 inputs but refuses malformed bytes and unrelated paths',()=>{
    const frame=mapping();frame.files={'chapters/shared.tex':new TextEncoder().encode('한글\r\nsource')};
    expect(compiledText(frame,'논문/chapters/shared.tex')).toBe('한글\r\nsource');
    expect(compiledText(frame,'other/chapters/shared.tex')).toBeNull();
    frame.files={'chapters/shared.tex':new Uint8Array([255])};expect(compiledText(frame,'논문/chapters/shared.tex')).toBeNull();
  });
  it('never navigates through valid-looking SyncTeX from a stale remainder page',async()=>{
    const frame=mapping();frame.range={firstPage:1,lastPage:1};
    expect(await liveForward(frame,'논문/chapters/shared.tex',7)).toHaveLength(1);
    expect(await liveForward(frame,'논문/other/shared.tex',12)).toEqual([]);
    expect(await liveInverse(frame,2,55,95)).toBeNull();
    expect((await liveInverse(frame,1,55,95))?.path).toBe('논문/chapters/shared.tex');
  });
  it('fails closed for an invalid partial-page range',async()=>{
    const frame=mapping();frame.range={firstPage:2,lastPage:1};
    expect(await liveForward(frame,'논문/chapters/shared.tex',7)).toEqual([]);
    expect(await liveInverse(frame,1,55,95)).toBeNull();
  });
});
