import {afterEach,describe,expect,it,vi} from 'vitest';
import {AutomaticBuild} from './automaticBuild';

afterEach(()=>vi.useRealTimers());
describe('idle automatic native builds',()=>{
  it('does not compile while saved text is still being edited and builds the latest text once',()=>{
    vi.useFakeTimers();let text='one';const built:string[]=[];
    const queue=new AutomaticBuild(()=>built.push(text),()=>false,()=>1000);
    queue.changed();queue.saved();vi.advanceTimersByTime(600);
    text='two';queue.changed();queue.saved();vi.advanceTimersByTime(999);expect(built).toEqual([]);
    vi.advanceTimersByTime(1);expect(built).toEqual(['two']);vi.advanceTimersByTime(3000);expect(built).toEqual(['two']);
  });
  it('retains one request behind an active build without running concurrently',()=>{
    vi.useFakeTimers();let busy=true,text='first';const built:string[]=[];
    const queue=new AutomaticBuild(()=>built.push(text),()=>busy,()=>1000);
    queue.changed();queue.saved();vi.advanceTimersByTime(1000);expect(built).toEqual([]);
    text='latest';queue.changed();queue.saved();vi.advanceTimersByTime(300);busy=false;queue.settled();
    vi.advanceTimersByTime(699);expect(built).toEqual([]);vi.advanceTimersByTime(1);expect(built).toEqual(['latest']);
  });
  it('does not restart a cancelled build after idle or completion',()=>{
    vi.useFakeTimers();const run=vi.fn();let busy=true;
    const queue=new AutomaticBuild(run,()=>busy,()=>1000);
    queue.changed();queue.saved();vi.advanceTimersByTime(1000);queue.cancel();busy=false;queue.settled();vi.advanceTimersByTime(5000);expect(run).not.toHaveBeenCalled();
    queue.changed();queue.saved();vi.advanceTimersByTime(1000);expect(run).toHaveBeenCalledTimes(1);
  });
  it('does not add an idle delay to the first native build or a non-live profile',()=>{
    vi.useFakeTimers();const built:string[]=[];
    const queue=new AutomaticBuild(()=>built.push('native'),()=>false,()=>0);
    queue.changed();queue.saved();vi.advanceTimersByTime(0);expect(built).toEqual(['native']);
  });
});
