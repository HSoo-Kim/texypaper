import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorkspacePolling } from './polling';

describe('adaptive workspace polling',()=>{
  const stops:(()=>void)[]=[];
  let activity:EventTarget,visibility:EventTarget;
  beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(0);vi.stubGlobal('window',globalThis);activity=new EventTarget();visibility=new EventTarget();});
  afterEach(()=>{for(const stop of stops.splice(0))stop();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
  function start(remote=true,patch:Partial<Parameters<typeof startWorkspacePolling>[0]>={}){
    const poll=vi.fn(async()=>false);
    const stop=startWorkspacePolling({remote,poll,hidden:()=>false,activityTarget:activity,visibilityTarget:visibility,...patch});stops.push(stop);return {poll,stop};
  }
  it('reduces each settled remote stream from 30 to 6 requests per minute',async()=>{
    const remote=start(),local=start(false);
    await vi.advanceTimersByTimeAsync(60000);expect(remote.poll).toHaveBeenCalledTimes(10);expect(local.poll).toHaveBeenCalledTimes(30);
    remote.poll.mockClear();local.poll.mockClear();await vi.advanceTimersByTimeAsync(60000);
    expect(remote.poll).toHaveBeenCalledTimes(6);expect(local.poll).toHaveBeenCalledTimes(30);
  });
  it('skips invisible explorer polls without preventing immediate focus refresh when shown',async()=>{
    let visible=false;const loop=start(true,{visible:()=>visible});await vi.advanceTimersByTimeAsync(60000);expect(loop.poll).not.toHaveBeenCalled();
    visible=true;activity.dispatchEvent(new Event('focus'));await vi.advanceTimersByTimeAsync(0);expect(loop.poll).toHaveBeenCalledTimes(1);
  });
  it('refreshes on focus immediately and returns to a two-second cadence',async()=>{
    const loop=start();await vi.advanceTimersByTimeAsync(60000);loop.poll.mockClear();activity.dispatchEvent(new Event('focus'));await vi.advanceTimersByTimeAsync(0);
    expect(loop.poll).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1999);expect(loop.poll).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);expect(loop.poll).toHaveBeenCalledTimes(2);
  });
  it('shortens the next idle check after activity without postponing checks during continuous typing',async()=>{
    const loop=start();await vi.advanceTimersByTimeAsync(60000);loop.poll.mockClear();await vi.advanceTimersByTimeAsync(1000);activity.dispatchEvent(new Event('keydown'));
    for(let index=0;index<4;index++){await vi.advanceTimersByTimeAsync(500);activity.dispatchEvent(new Event('keydown'));}
    expect(loop.poll).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(2000);expect(loop.poll).toHaveBeenCalledTimes(2);
  });
  it('resets backoff after a detected change',async()=>{
    const loop=start();await vi.advanceTimersByTimeAsync(60000);loop.poll.mockClear();loop.poll.mockResolvedValueOnce(true);
    await vi.advanceTimersByTimeAsync(10000);expect(loop.poll).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(2000);expect(loop.poll).toHaveBeenCalledTimes(2);
  });
  it('keeps hidden checks at fifteen seconds and refreshes immediately when visible again',async()=>{
    let hidden=true;const loop=start(true,{hidden:()=>hidden});await vi.advanceTimersByTimeAsync(60000);expect(loop.poll).toHaveBeenCalledTimes(4);
    hidden=false;visibility.dispatchEvent(new Event('visibilitychange'));await vi.advanceTimersByTimeAsync(0);expect(loop.poll).toHaveBeenCalledTimes(5);
  });
  it('does not overlap slow polls or leave timers/listeners after stopping',async()=>{
    const pending=Promise.withResolvers<boolean>(),poll=vi.fn(()=>pending.promise),loop=start(true,{poll});await vi.advanceTimersByTimeAsync(2000);
    activity.dispatchEvent(new Event('focus'));await vi.advanceTimersByTimeAsync(60000);expect(poll).toHaveBeenCalledTimes(1);
    loop.stop();pending.resolve(false);await vi.advanceTimersByTimeAsync(60000);activity.dispatchEvent(new Event('focus'));visibility.dispatchEvent(new Event('visibilitychange'));expect(poll).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  });
});
