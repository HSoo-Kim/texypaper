import { describe, expect, it } from 'vitest';
import { PaperIndex, excludedDirectories, followTexRoot, isPaperFile, resolveRelative, sortEntries, upsertEntries } from './paperIndex';
import { byteToUtf16, editorOffsetToRaw, selectionAnchor, utf16ToByte, type BufferRecord } from '../../editor/buffers';
import { reanchor, mapAnchor } from '../comments/anchors';
import type { Entry } from '../../contracts';
function entry(path:string,kind:Entry['kind']='file'):Entry{return {path,name:path.split('/').at(-1)!,kind,paper:'unknown',main:false};}
describe('paper folder evidence',()=>{
  it('excludes current and legacy migration metadata without hiding ordinary paper folders',()=>{
    expect(excludedDirectories['.texypaper']).toBe(true);
    expect(excludedDirectories['.paperdock']).toBe(true);
    expect(excludedDirectories.paper).not.toBe(true);
  });
  it('does not classify PDF-only or merely expanded folders as papers',()=>{
    const index=new PaperIndex();index.update('',[entry('reference','directory')]);expect(index.mark('reference')).toBe('unknown');index.update('reference',[entry('reference/only.pdf')]);expect(index.mark('reference')).toBe('none');expect(isPaperFile('only.pdf')).toBe(false);
  });
  it('propagates verified positive evidence through deep ancestors, not negative assumptions',()=>{
    const index=new PaperIndex();index.update('a/b/c/d/e',[entry('a/b/c/d/e/main.tex'),entry('a/b/c/d/e/references.bib')]);expect(index.mark('a/b/c/d/e')).toBe('direct');expect(index.evidence.get('a/b/c/d/e')).toEqual(['main.tex','references.bib']);expect(index.mark('a')).toBe('descendant');expect(index.mark('other')).toBe('unknown');
  });
  it('shows verified nested-paper folders from the first listing before expansion',()=>{
    const index=new PaperIndex();
    index.update('',[{...entry('research','directory'),paper:'descendant'},entry('paper','directory')]);
    expect(index.mark('research')).toBe('descendant');expect(index.mark('')).toBe('descendant');
    expect(index.mark('paper')).toBe('unknown');
    index.update('',[entry('research','directory'),entry('paper','directory')]);
    expect(index.mark('research')).toBe('unknown');expect(index.mark('')).toBe('none');
  });
  it('propagates cached nested evidence without replacing a verified direct-paper parent',()=>{
    const index=new PaperIndex();
    index.update('research',[entry('research/main.tex'),{...entry('research/archive','directory'),paper:'descendant'}]);
    expect(index.mark('research/archive')).toBe('descendant');expect(index.mark('research')).toBe('direct');
    expect(index.evidence.get('research')).toEqual(['main.tex']);expect(index.mark('')).toBe('descendant');
  });
  it('invalidates descendants and evidence after rename/delete',()=>{
    const index=new PaperIndex();index.update('a',[entry('a/main.tex')]);expect(index.mark('')).toBe('descendant');index.invalidate('a/main.tex');expect(index.mark('a')).toBe('unknown');expect(index.mark('')).not.toBe('descendant');
  });
  it('propagates evidence arriving as filenames in background scan batches',()=>{
    const index=new PaperIndex();index.update('',[entry('stress-tree','directory')]);
    index.accept([entry('stress-tree/deep/paper/references.bib')]);
    expect(index.mark('stress-tree')).toBe('descendant');expect(index.mark('stress-tree/deep/paper')).toBe('direct');
    expect(index.evidence.get('stress-tree/deep/paper')).toEqual(['references.bib']);expect(index.mark('unscanned')).toBe('unknown');
    index.update('stress-tree/deep/paper',[]);expect(index.mark('stress-tree')).not.toBe('descendant');
  });
  it('keeps an unchanged listing and its derived evidence stable across fresh polling results',()=>{
    const index=new PaperIndex(),files=[entry('paper10.tex'),entry('paper2.tex'),entry('figures','directory')];
    expect(index.update('',files)).toBe(true);
    const listing=index.listings.get(''),evidence=index.evidence.get('');
    expect(index.update('',[...files].reverse().map(file=>({...file})))).toBe(false);
    expect(index.listings.get('')).toBe(listing);expect(index.evidence.get('')).toBe(evidence);
    expect(index.mark('')).toBe('direct');
  });
  it.each<{field:keyof Entry;changed:Partial<Entry>}>([
    {field:'path',changed:{path:'renamed.tex'}},
    {field:'name',changed:{name:'renamed.tex'}},
    {field:'kind',changed:{kind:'symlink'}},
    {field:'byteLength',changed:{byteLength:100}},
    {field:'paper',changed:{paper:'direct'}},
    {field:'main',changed:{main:true}},
    {field:'evidence',changed:{evidence:['new.tex']}},
  ])('publishes changed $field metadata instead of treating the listing as unchanged',({changed})=>{
    const index=new PaperIndex(),original=entry('main.tex');
    expect(index.update('',[original])).toBe(true);
    const next={...original,...changed};
    expect(index.update('',[next])).toBe(true);expect(index.listings.get('')).toEqual([next]);
    expect(index.update('',[{...next,evidence:next.evidence?.slice()}])).toBe(false);
  });
  it('refreshes directory evidence when filenames or their displayed order change',()=>{
    const index=new PaperIndex(),directory={...entry('paper','directory'),paper:'direct' as const,evidence:['main.tex','refs.bib']};
    index.update('',[directory]);
    expect(index.update('',[{...directory,evidence:['refs.bib','main.tex']}])).toBe(true);
    expect(index.evidence.get('paper')).toEqual(['refs.bib','main.tex']);
    expect(index.update('',[{...directory,evidence:['other.tex']}])).toBe(true);
    expect(index.evidence.get('paper')).toEqual(['other.tex']);
  });
  it('accepts the first empty listing and refreshes identical entries after explicit invalidation',()=>{
    const index=new PaperIndex();
    expect(index.update('paper',[])).toBe(true);expect(index.update('paper',[])).toBe(false);
    index.invalidate('paper/removed.tex');
    expect(index.update('paper',[])).toBe(true);expect(index.mark('paper')).toBe('none');
  });
  it('lets a fresh unchanged listing clear stale scan-only evidence after external deletion',()=>{
    const index=new PaperIndex();index.update('paper',[]);
    index.accept([entry('paper/removed.tex')]);expect(index.mark('paper')).toBe('direct');
    expect(index.update('paper',[])).toBe(true);expect(index.mark('paper')).toBe('none');
    expect(index.evidence.get('paper')).toEqual([]);expect(index.update('paper',[])).toBe(false);
  });
  it('orders directories first and sorts numbers naturally',()=>{expect(sortEntries([entry('paper10.tex'),entry('paper2.tex'),entry('z','directory')]).map(value=>value.path)).toEqual(['z','paper2.tex','paper10.tex']);});
});
describe('incremental filename ownership',()=>{
  it('merges bounded batches into one map without dropping earlier filenames or replacing unchanged records',()=>{
    const index=new Map<string,Entry>(),files=Array.from({length:1024},(_,position)=>entry(`stress/file-${position}.txt`));
    for(let start=0;start<files.length;start+=256)expect(upsertEntries(index,files.slice(start,start+256))).toBe(true);
    expect(index.size).toBe(1024);
    for(const file of files)expect(index.get(file.path)).toBe(file);
    expect(upsertEntries(index,files.map(file=>({...file})))).toBe(false);
    for(const file of files)expect(index.get(file.path)).toBe(file);
    expect(upsertEntries(index,[])).toBe(false);
  });
  it('replaces changed metadata without mutating previously published records',()=>{
    const index=new Map<string,Entry>(),directory={...entry('paper','directory'),paper:'direct' as const,evidence:['main.tex']},other=entry('notes.txt');
    upsertEntries(index,[directory,other]);const published=Array.from(index.values());
    const changed={...directory,main:true,byteLength:4096,evidence:['main.tex','refs.bib']};
    expect(upsertEntries(index,[changed])).toBe(true);
    expect(index.size).toBe(2);expect(index.get('paper')).toBe(changed);expect(index.get('notes.txt')).toBe(other);
    expect(published[0]).toBe(directory);expect(directory.main).toBe(false);expect(directory.evidence).toEqual(['main.tex']);
    expect(upsertEntries(index,[{...changed,evidence:[...changed.evidence]}])).toBe(false);
    expect(upsertEntries(index,[{...changed,evidence:['refs.bib','main.tex']}])).toBe(true);
  });
  it('keeps independent workspace indexes separate even when relative paths match',()=>{
    const first=new Map<string,Entry>(),second=new Map<string,Entry>();
    const local={...entry('main.tex'),byteLength:10},remote={...entry('main.tex'),byteLength:20};
    upsertEntries(first,[local]);upsertEntries(second,[remote]);first.clear();
    expect(first.size).toBe(0);expect(second.get('main.tex')).toBe(remote);
    expect(upsertEntries(first,[remote])).toBe(true);
    expect(upsertEntries(second,[{...remote}])).toBe(false);
  });
});
describe('explicit TeX root identity',()=>{
  it('resolves parent traversal within the root and refuses drive/UNC/outside-root targets',()=>{expect(resolveRelative('sections/ch1.tex','../main.tex')).toBe('main.tex');for(const path of ['../../escape.tex','C:/paper.tex','//host/paper.tex','a:stream','/home/other/main.tex'])expect(()=>resolveRelative('sections/ch1.tex',path)).toThrow();});
  it('follows a real directive chain and rejects cycles',async()=>{const files:Record<string,string>={'a.tex':'% !TeX root = nested/b.tex','nested/b.tex':'% !TeX root = ../main.tex','main.tex':'\\documentclass{article}'};expect(await followTexRoot('a.tex',async path=>files[path])).toBe('main.tex');files['main.tex']='% !TeX root = a.tex';await expect(followTexRoot('a.tex',async path=>files[path])).rejects.toThrow();});
  it('bounds root chains rather than scanning forever',async()=>{await expect(followTexRoot('0.tex',async path=>`% !TeX root = ${Number.parseInt(path)+1}.tex`)).rejects.toThrow();});
});
describe('source and comment boundaries',()=>{
  it('maps Korean, emoji, combining characters and CRLF without splitting UTF-8',()=>{const text='한글😀e\u0301\r\nnext';for(const offset of [0,1,2,4,5,6,8,12])expect(byteToUtf16(text,utf16ToByte(text,offset))).toBe(offset);expect(byteToUtf16('😀',3)).toBe(0);expect(editorOffsetToRaw('a\r\nb\nc',3)).toBe(4);});
  it('includes BOM in raw source anchor offsets',()=>{const buffer:BufferRecord={path:'한글.tex',document:{file:{workspaceId:'w',path:'한글.tex'},text:'가나다',revision:{sha256:'base',byteLength:12,modifiedNs:'0'},encoding:'utf8Bom',newline:'lf',readOnly:false},state:null,dirty:false,saving:false,composing:false,version:0,lastUsed:0};const anchor=selectionAnchor(buffer,1,2);expect(anchor.startByte).toBe(6);expect(anchor.endByte).toBe(9);expect(anchor.quote).toBe('나');});
  it('reanchors only unique quote plus complete context and orphans overlaps',()=>{const anchor={path:'main.tex',startByte:1,endByte:6,baseSha256:'old',quote:'hello',before:'[',after:']'};expect(reanchor(anchor,'prefix [hello]','new')?.startByte).toBe(8);expect(reanchor(anchor,'[hello] [hello]','new')).toBeNull();expect(reanchor(anchor,'[deleted]','new')).toBeNull();expect(mapAnchor(anchor,0,0,4)?.startByte).toBe(5);expect(mapAnchor(anchor,3,4,2)).toBeNull();});
});
