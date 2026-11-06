import {describe,it,expect,vi} from 'vitest';
import {PageLifecycle} from './pageLifecycle';

describe('PDF page generation disposal',()=>{
 it('cleans up a page whose getPage result arrives after disposal',async()=>{
  const release=vi.fn(),cleanup=vi.fn(()=>true),lifetime=new PageLifecycle(release);
  await lifetime.stop();
  expect(lifetime.adopt({cleanup})).toBe(false);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
 });
 it('cancels both tasks and waits for text settlement before releasing DOM and page caches',async()=>{
  const render=Promise.withResolvers<void>(),text=Promise.withResolvers<void>();
  const events:string[]=[],cleanup=vi.fn(()=>{events.push('page');return true;});
  const lifetime=new PageLifecycle(()=>{events.push('DOM');});
  const canvasTask={promise:render.promise,cancel:vi.fn()},textLayer={render:vi.fn(()=>text.promise),cancel:vi.fn()};
  expect(lifetime.adopt({cleanup})).toBe(true);
  lifetime.render(canvasTask);lifetime.renderText(textLayer);
  const completion=lifetime.stop();
  expect(lifetime.isStopped).toBe(true);
  expect(lifetime.stop()).toBe(completion);
  expect(canvasTask.cancel).toHaveBeenCalledTimes(1);
  expect(textLayer.cancel).toHaveBeenCalledTimes(1);
  render.resolve();await render.promise;
  expect(events).toEqual([]);
  text.reject(new Error('TextLayer task cancelled.'));
  await completion;
  expect(events).toEqual(['DOM','page']);
  expect(cleanup).toHaveBeenCalledTimes(1);
  await lifetime.stop();
  expect(cleanup).toHaveBeenCalledTimes(1);
 });
 it('removes offscreen text without repainting or releasing its retained canvas',async()=>{
  const first=Promise.withResolvers<void>(),second=Promise.withResolvers<void>();
  const release=vi.fn(),cleanup=vi.fn(()=>true),canvasTask={promise:Promise.resolve(),cancel:vi.fn()};
  const lifetime=new PageLifecycle(release);lifetime.adopt({cleanup});
  await lifetime.render(canvasTask);
  const firstLayer={render:vi.fn(()=>first.promise),cancel:vi.fn(():undefined=>{first.reject(new Error('offscreen'));})};
  lifetime.renderText(firstLayer);
  await lifetime.stopText();
  expect(firstLayer.cancel).toHaveBeenCalledTimes(1);
  expect(canvasTask.cancel).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();expect(cleanup).not.toHaveBeenCalled();
  const secondLayer={render:vi.fn(()=>second.promise),cancel:vi.fn(():undefined=>{second.reject(new Error('closed'));})};
  lifetime.renderText(secondLayer);
  await lifetime.stop();
  expect(secondLayer.render).toHaveBeenCalledTimes(1);
  expect(secondLayer.cancel).toHaveBeenCalledTimes(1);
  expect(canvasTask.cancel).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);expect(cleanup).toHaveBeenCalledTimes(1);
 });
 it('does not let delayed text cleanup forget a newer layer',async()=>{
  const first=Promise.withResolvers<void>(),second=Promise.withResolvers<void>();
  const lifetime=new PageLifecycle(vi.fn());
  const firstLayer={render:vi.fn(()=>first.promise),cancel:vi.fn()};
  const secondLayer={render:vi.fn(()=>second.promise),cancel:vi.fn(():undefined=>{second.reject(new Error('closed'));})};
  lifetime.renderText(firstLayer);
  const hidden=lifetime.stopText();
  lifetime.renderText(secondLayer);first.resolve();await hidden;
  await lifetime.stop();
  expect(secondLayer.cancel).toHaveBeenCalledTimes(1);
 });
 it('refuses a text extraction arriving after its page generation was closed',async()=>{
  const lifetime=new PageLifecycle(vi.fn());await lifetime.stop();
  const textLayer={render:vi.fn(()=>Promise.resolve()),cancel:vi.fn()};
  await lifetime.renderText(textLayer);
  expect(textLayer.render).not.toHaveBeenCalled();expect(textLayer.cancel).toHaveBeenCalledTimes(1);
 });
 it('still cleans the page cache when releasing the canvas fails',async()=>{
  const failure=new Error('canvas release failed'),cleanup=vi.fn(()=>true);
  const lifetime=new PageLifecycle(()=>{throw failure;});lifetime.adopt({cleanup});
  await expect(lifetime.stop()).rejects.toBe(failure);
  expect(cleanup).toHaveBeenCalledTimes(1);
 });
});
