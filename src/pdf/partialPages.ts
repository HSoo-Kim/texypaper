export type PartialPageRequest={firstPage:number;pageLimit:number;baseBuildId:string};
export type FreshPageSpan={firstPage:number;lastPage:number};

export function isCurrentPartial(request:PartialPageRequest,buildId:string|undefined){
 return request.baseBuildId===buildId&&Number.isSafeInteger(request.firstPage)&&request.firstPage>0&&Number.isSafeInteger(request.pageLimit)&&request.pageLimit>=request.firstPage;
}

/** PDF.js numbers are local to the span; every UI coordinate stays physical. */
export function partialPageSpan(request:PartialPageRequest,buildId:string|undefined,pageCount:number):FreshPageSpan|null{
 if(!isCurrentPartial(request,buildId)||!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>request.pageLimit-request.firstPage+1)return null;
 return {firstPage:request.firstPage,lastPage:request.firstPage+pageCount-1};
}

export function partialPageNumber(page:number,span:FreshPageSpan|null){
 return span&&Number.isSafeInteger(page)&&page>=span.firstPage&&page<=span.lastPage?page-span.firstPage+1:null;
}
