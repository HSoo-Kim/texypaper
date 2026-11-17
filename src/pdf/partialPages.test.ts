import {describe,it,expect} from 'vitest';
import {isCurrentPartial,partialPageNumber,partialPageSpan} from './partialPages';

const request={firstPage:12,pageLimit:14,baseBuildId:'base'};
describe('physical partial PDF pages',()=>{
 it('routes local PDF indices without changing physical page numbers',()=>{
  const span=partialPageSpan(request,'base',3);
  expect(span).toEqual({firstPage:12,lastPage:14});
  expect(partialPageNumber(12,span)).toBe(1);
  expect(partialPageNumber(14,span)).toBe(3);
 });
 it('rejects stale base builds',()=>{
  expect(isCurrentPartial(request,'next')).toBe(false);
  expect(partialPageSpan(request,'next',3)).toBeNull();
 });
 it('uses actual coverage rather than the requested absolute last page',()=>{
  const span=partialPageSpan(request,'base',1);
  expect(span).toEqual({firstPage:12,lastPage:12});
  expect(partialPageNumber(13,span)).toBeNull();
 });
 it('never maps a stale base page into a fresh partial coordinate',()=>{
  const span=partialPageSpan(request,'base',3);
  for(const page of [1,11,15,32,12.5,NaN])expect(partialPageNumber(page,span)).toBeNull();
  expect(partialPageNumber(12,null)).toBeNull();
 });
 it('rejects invalid spans and unexpected PDF page counts',()=>{
  for(const invalid of [{...request,firstPage:0},{...request,firstPage:12.5},{...request,pageLimit:11},{...request,pageLimit:Infinity}])expect(partialPageSpan(invalid,'base',1)).toBeNull();
  for(const count of [0,4,1.5,NaN])expect(partialPageSpan(request,'base',count)).toBeNull();
 });
 it('preserves the complete base layout while allowing newly added pages',()=>{
  const span=partialPageSpan(request,'base',2)!;
  expect(Math.max(32,span.lastPage)).toBe(32);
  const added=partialPageSpan({firstPage:33,pageLimit:34,baseBuildId:'base'},'base',2)!;
  expect(Math.max(32,added.lastPage)).toBe(34);
 });
});
