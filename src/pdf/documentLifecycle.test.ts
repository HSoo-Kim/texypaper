import {describe,it,expect,vi} from 'vitest';
import {queueDocumentTeardown,waitForDocumentTeardown} from './documentLifecycle';

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
