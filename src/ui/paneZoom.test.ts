import {describe,expect,it} from 'vitest';
import {clampEditorFontSize,createWheelZoom,zoomKeyDirection} from './paneZoom';

describe('pane zoom input boundaries',()=>{
  it('recognizes plus, equals, minus and numpad shortcuts without consuming ordinary typing',()=>{
    const event={ctrlKey:true,metaKey:false,altKey:false,isComposing:false,key:'=',code:'Equal'};
    for(const key of ['=','+'])expect(zoomKeyDirection({...event,key})).toBe(1);
    expect(zoomKeyDirection({...event,key:'-'})).toBe(-1);
    expect(zoomKeyDirection({...event,key:'Add',code:'NumpadAdd'})).toBe(1);
    expect(zoomKeyDirection({...event,key:'Subtract',code:'NumpadSubtract'})).toBe(-1);
    expect(zoomKeyDirection({...event,ctrlKey:false,metaKey:true})).toBe(1);
    for(const patch of [{ctrlKey:false},{altKey:true},{isComposing:true},{key:'0',code:'Digit0'},{key:'a',code:'KeyA'}])expect(zoomKeyDirection({...event,...patch})).toBe(0);
  });
  it('clamps persisted and repeated font steps without admitting invalid values',()=>{
    expect(clampEditorFontSize(NaN)).toBe(14);expect(clampEditorFontSize(Infinity)).toBe(14);
    expect(clampEditorFontSize(-3)).toBe(10);expect(clampEditorFontSize(99)).toBe(32);expect(clampEditorFontSize(15.7)).toBe(16);
    let size=14;for(let index=0;index<100;index++)size=clampEditorFontSize(size+1);expect(size).toBe(32);
    for(let index=0;index<100;index++)size=clampEditorFontSize(size-1);expect(size).toBe(10);
  });
  it('normalizes pixel, line and page deltas and limits extreme events to one step',()=>{
    for(const [deltaY,deltaMode] of [[-60,0],[-4,1],[-1,2],[-100000,0]])expect(createWheelZoom()({deltaY,deltaMode,timeStamp:1},600)).toBe(1);
    expect(createWheelZoom()({deltaY:100000,deltaMode:0,timeStamp:1},600)).toBe(-1);
    expect(createWheelZoom()({deltaY:NaN,deltaMode:0,timeStamp:1},600)).toBe(0);
    expect(createWheelZoom()({deltaY:0,deltaMode:0,timeStamp:1},600)).toBe(0);
  });
  it('accumulates small trackpad deltas but resets on reversal or a pause',()=>{
    const step=createWheelZoom();
    for(let timeStamp=0;timeStamp<5;timeStamp++)expect(step({deltaY:-10,deltaMode:0,timeStamp},600)).toBe(0);
    expect(step({deltaY:-10,deltaMode:0,timeStamp:5},600)).toBe(1);
    expect(step({deltaY:-50,deltaMode:0,timeStamp:6},600)).toBe(0);
    expect(step({deltaY:10,deltaMode:0,timeStamp:7},600)).toBe(0);
    expect(step({deltaY:50,deltaMode:0,timeStamp:8},600)).toBe(-1);
    expect(step({deltaY:-50,deltaMode:0,timeStamp:9},600)).toBe(0);
    expect(step({deltaY:-10,deltaMode:0,timeStamp:300},600)).toBe(0);
  });
});
