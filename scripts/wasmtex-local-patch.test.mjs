import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {applyWorkerPatch,localWorker,sourcePatchSha256} from './wasmtex-local-patch.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const patch=await readFile(new URL('../licenses/wasmtex-engine-2026/texypaper-local-assets.patch',import.meta.url),'utf8');
assert.equal(hash(patch),sourcePatchSha256);
const manifest=JSON.parse(await readFile(new URL('./wasmtex-engine-2026.manifest.json',import.meta.url),'utf8'));
const upstream=manifest.files.find(file=>file.name===localWorker.name);
const bytes=await readFile(new URL('../public/wasmtex/2026/'+localWorker.name,import.meta.url));
assert([upstream.sha256,localWorker.sha256].includes(hash(bytes)),'Unexpected engine worker input');
const source=hash(bytes)===localWorker.sha256?bytes.toString('utf8'):applyWorkerPatch(bytes.toString('utf8'),patch);
assert.equal(hash(source),localWorker.sha256);
assert.equal(Buffer.byteLength(source),localWorker.bytes);
// Exercise the actual generated worker's lookup and cache functions with an
// in-memory package server, without booting a compiler or opening user files.
const functions=source.slice(source.indexOf('function cacheFileName('),source.indexOf('// --- Fonts made from Metafont source'));
function resolve(endpoint,name){
 const requests=[],saved=[];
 const context={self:{texlive_endpoint:endpoint,postMessage(){},wasmtexResolverEvidence(){},wasmtexDownloadAsset(url){requests.push(url);return {status:200,response:new Uint8Array([1,2,3]).buffer,getResponseHeader:()=>null};}},
  UTF8ToString:value=>value,allocateString:value=>value,TEXCACHEROOT:'/tex',WORKROOT:'/work',FS:{writeFile(file,data){saved.push({file,bytes:[...data]});}},
  texlive404_cache:{},texlive200_cache:{},texlive404_source:{},texlive200_source:{},texliveTransport:{},bloom_bits:null,bloomMaybe:()=>true,fetchCandidates:(_format,request)=>[request]};
 runInNewContext(functions,context);
 return {result:context.findTexliveFile(name,26,false),requests,saved};
}
test('local installed-tree images resolve and occupy a flat cache path',()=>{
 for(const endpoint of ['http://texmf.localhost/2026/','https://texmf.localhost/2026/','texmf://localhost/2026/']){
  const result=resolve(endpoint,'thumbnails/cas-email.jpeg');
  assert.equal(result.result,'/tex/thumbnails%2Fcas-email.jpeg');
  assert.deepEqual(result.requests,[endpoint+'pdftex/26/thumbnails/cas-email.jpeg']);
  assert.deepEqual(result.saved,[{file:result.result,bytes:[1,2,3]}]);
 }
});
test('relative document paths never reach a remote package mirror',()=>{
 for(const endpoint of ['https://texlive.corca.ai/2026/','http://texmf.localhost.evil/2026/']){
  const result=resolve(endpoint,'private/draft.tex');assert.equal(result.result,0);assert.deepEqual(result.requests,[]);
 }
 assert.equal(resolve('https://texlive.corca.ai/2026/','article.cls').requests.length,1,'Existing bare-name lookup must remain unchanged');
});
test('local lookup rejects absolute, traversal, encoded and ambiguous paths before requesting',()=>{
 for(const name of ['/work/draft.tex','../secret','a/../secret','a//secret','a/./secret','C:/secret','a\\secret','a/%2e%2e/secret','a/secret?query','a/secret#fragment','a/\u0000secret']){
  const result=resolve('http://texmf.localhost/2026/',name);assert.equal(result.result,0,name);assert.deepEqual(result.requests,[],name);
 }
});
