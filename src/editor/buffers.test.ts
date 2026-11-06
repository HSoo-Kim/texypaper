import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { applyEditorChanges, BufferStore, selectionAnchor, type BufferRecord } from './buffers';
function buffer(text:string,newline:'lf'|'crlf'|'mixed',encoding:'utf8'|'utf8Bom'='utf8'):BufferRecord{
  return {path:'paper.tex',document:{file:{workspaceId:'workspace',path:'paper.tex'},text,revision:{sha256:'base',byteLength:new TextEncoder().encode(text).length+(encoding==='utf8Bom'?3:0),modifiedNs:'0'},newline,encoding,readOnly:false},state:EditorState.create({doc:text,extensions:newline==='crlf'?[EditorState.lineSeparator.of('\r\n')]:[]}),dirty:false,saving:false,composing:false,version:0,lastUsed:0,...(newline==='mixed'?{rawText:text}:{})};
}
describe('byte-preserving editor serialization',()=>{
  it('keeps every unaffected mixed newline while replacing Unicode prose',()=>{
    const raw='first\r\n한글 😀\nthird\r\nfourth\n';const state=EditorState.create({doc:raw});const target=state.doc.line(2);const changes=state.changes({from:target.from,to:target.to,insert:'교체 e\u0301'});
    expect(applyEditorChanges(raw,changes)).toBe('first\r\n교체 e\u0301\nthird\r\nfourth\n');
  });
  it('serializes multiple edits using original coordinates, not shifted positions',()=>{
    const raw='one\r\ntwo\nthree\r\n';const state=EditorState.create({doc:raw});const changes=state.changes([{from:0,to:3,insert:'첫째'},{from:state.doc.line(3).from,to:state.doc.line(3).to,insert:'셋째'}]);expect(applyEditorChanges(raw,changes)).toBe('첫째\r\ntwo\n셋째\r\n');
  });
  it('uses the affected line separator for new lines without rewriting its neighbors',()=>{
    const raw='a\r\nb\nc\r\n';const state=EditorState.create({doc:raw});expect(applyEditorChanges(raw,state.changes({from:state.doc.line(2).from,insert:'new\n'}))).toBe('a\r\nnew\nb\nc\r\n');
  });
  it('maps CodeMirror CRLF-normalized positions to raw BOM-inclusive byte offsets',()=>{
    const value=buffer('a\r\n한😀e\u0301\r\n','crlf','utf8Bom');const line=value.state!.doc.line(2);const anchor=selectionAnchor(value,line.from,line.from+3);expect(anchor.quote).toBe('한😀');expect(anchor.startByte).toBe(6);expect(anchor.endByte).toBe(13);
  });
  it('maps mixed source positions without dropping existing carriage returns',()=>{
    const value=buffer('a\r\n나\n😀\r\n','mixed');const line=value.state!.doc.line(3);const anchor=selectionAnchor(value,line.from,line.to);expect(anchor.quote).toBe('😀');expect(anchor.startByte).toBe(7);expect(anchor.endByte).toBe(11);
  });
  it('releases acknowledged clean workspace caches and ignores disposed editor updates',()=>{
    const store=new BufferStore({id:'workspace',environmentId:'local',root:'fixture',epoch:1},()=>{},()=>{});
    const cached=buffer('cached source\r\n','crlf');store.records.set(cached.path,cached);store.activePath=cached.path;
    let notifications=0;store.subscribe(()=>{notifications++;});
    store.dispose();store.update(cached.path,cached.state!);store.notify();
    expect(store.records.size).toBe(0);expect(store.activePath).toBeNull();expect(notifications).toBe(0);
  });
});
