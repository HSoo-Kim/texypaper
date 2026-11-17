import {afterEach,describe,it,expect,vi} from 'vitest';

const workers=vi.hoisted(()=>({created:[] as {promise:Promise<void>;destroy:()=>void}[],ready:undefined as Promise<void>|undefined}));
vi.mock('pdfjs-dist',()=>({PDFWorker:class{
 promise=workers.ready??Promise.resolve();
 destroy=vi.fn();
 constructor(){workers.created.push(this);}
}}));

import {DocumentWorker,queueDocumentTeardown,waitForDocumentTeardown} from './documentLifecycle';

afterEach(()=>{workers.ready=undefined;});

describe('document teardown across preview remounts',()=>{
 it('keeps a newly mounted preview behind the old document and worker destruction',async()=>{
  await waitForDocumentTeardown();
  const destroy=Promise.withResolvers<void>(),events:string[]=[];
  const closed=queueDocumentTeardown(async()=>{events.push('destroy-start');await destroy.promise;events.push('destroy-end');});
  const reopened=waitForDocumentTeardown().then(()=>{events.push('new-document');});
  await Promise.resolve();const beforeDestroyFinished=[...events];
  destroy.resolve();await closed;await reopened;
  expect(beforeDestroyFinished).toEqual(['destroy-start']);
  expect(events).toEqual(['destroy-start','destroy-end','new-document']);
 });
 it('serializes successive closes without retaining a rejected teardown in the barrier',async()=>{
  const failure=new Error('worker teardown failed'),report=vi.fn();
  const failed=queueDocumentTeardown(async()=>{throw failure;});
  await failed.catch(report);
  const next=vi.fn(async()=>{});await queueDocumentTeardown(next);await waitForDocumentTeardown();
  expect(report).toHaveBeenCalledWith(failure);expect(next).toHaveBeenCalledTimes(1);
 });
});

describe('preview-owned PDF worker',()=>{
 it('reuses the worker after document teardown and destroys it once after the last task settles',async()=>{
  const owner=new DocumentWorker(),first=await owner.acquire(),task=Promise.withResolvers<void>();
  const disposed=owner.dispose(()=>task.promise),acquired=vi.fn();
  const next=owner.acquire().then(worker=>{acquired();return worker;});
  await Promise.resolve();expect(acquired).not.toHaveBeenCalled();expect(first.destroy).not.toHaveBeenCalled();
  task.resolve();await disposed;expect(await next).toBe(first);
  const lastTask=Promise.withResolvers<void>(),lastDispose=owner.dispose(()=>lastTask.promise);
  const closed=owner.close();expect(owner.close()).toBe(closed);
  await Promise.resolve();expect(first.destroy).not.toHaveBeenCalled();
  lastTask.resolve();await lastDispose;await closed;
  expect(first.destroy).toHaveBeenCalledTimes(1);
 });
 it('never starts a worker for a preview closed while waiting for an older document',async()=>{
  const older=Promise.withResolvers<void>(),pending=queueDocumentTeardown(()=>older.promise),count=workers.created.length;
  const owner=new DocumentWorker(),acquired=owner.acquire();
  const rejected=expect(acquired).rejects.toThrow('PDF_WORKER_CLOSED'),closed=owner.close();
  older.resolve();await pending;await rejected;await closed;
  expect(workers.created).toHaveLength(count);
 });
 it('keeps remounts behind worker startup and final destruction when cancelled before getDocument',async()=>{
  const startup=Promise.withResolvers<void>();workers.ready=startup.promise;
  const owner=new DocumentWorker(),worker=await owner.acquire(),closed=owner.close(),reopened=vi.fn();
  const barrier=waitForDocumentTeardown().then(reopened);
  await Promise.resolve();expect(worker.destroy).not.toHaveBeenCalled();expect(reopened).not.toHaveBeenCalled();
  startup.resolve();await closed;await barrier;
  expect(worker.destroy).toHaveBeenCalledTimes(1);expect(reopened).toHaveBeenCalledTimes(1);
 });
 it('retires a worker after failed document destruction instead of reusing its old resources',async()=>{
  const owner=new DocumentWorker(),worker=await owner.acquire(),failure=new Error('document teardown failed');
  await expect(owner.dispose(async()=>{throw failure;})).rejects.toBe(failure);
  expect(worker.destroy).toHaveBeenCalledTimes(1);
  const replacement=await owner.acquire();expect(replacement).not.toBe(worker);
  await owner.close();expect(replacement.destroy).toHaveBeenCalledTimes(1);
 });
 it('destroys failed worker startups and leaves the global barrier usable',async()=>{
  const startup=Promise.withResolvers<void>();workers.ready=startup.promise;
  const owner=new DocumentWorker(),worker=await owner.acquire(),closed=owner.close();
  startup.reject(new Error('worker startup failed'));await closed;await waitForDocumentTeardown();
  expect(worker.destroy).toHaveBeenCalledTimes(1);
 });
});
