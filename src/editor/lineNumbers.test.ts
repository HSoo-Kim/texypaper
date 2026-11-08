import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { wholeLineSelection } from './lineNumbers';

describe('whole-line gutter selection',()=>{
  const doc=EditorState.create({doc:'one\n한글 😀\nlast'}).doc;
  it('selects a clicked line and its following newline',()=>{
    const range=wholeLineSelection(doc,doc.line(2).from,doc.line(2).from);
    expect(range.anchor).toBe(doc.line(2).from);expect(range.head).toBe(doc.line(3).from);
    expect(doc.sliceString(range.from,range.to)).toBe('한글 😀\n');
  });
  it('extends downwards from the first line start through the final line break',()=>{
    const range=wholeLineSelection(doc,1,doc.line(2).to);
    expect(range.anchor).toBe(0);expect(range.head).toBe(doc.line(3).from);
    expect(doc.sliceString(range.from,range.to)).toBe('one\n한글 😀\n');
  });
  it('extends upwards with the anchor after the original line',()=>{
    const range=wholeLineSelection(doc,doc.line(2).from,0);
    expect(range.anchor).toBe(doc.line(3).from);expect(range.head).toBe(0);
  });
  it('clamps the final line without a trailing newline',()=>{
    const range=wholeLineSelection(doc,doc.line(3).from,doc.length+100);
    expect(range.anchor).toBe(doc.line(3).from);expect(range.head).toBe(doc.length);
  });
  it('handles an empty document, trailing empty line, and out-of-document coordinates',()=>{
    const empty=EditorState.create().doc;expect(wholeLineSelection(empty,-10,10).empty).toBe(true);
    const trailing=EditorState.create({doc:'a\n'}).doc;expect(wholeLineSelection(trailing,2,2).head).toBe(2);
    expect(wholeLineSelection(doc,-1,doc.length+1).from).toBe(0);expect(wholeLineSelection(doc,-1,doc.length+1).to).toBe(doc.length);
  });
  it('uses normalized CodeMirror positions for CRLF documents',()=>{
    const state=EditorState.create({doc:'one\r\ntwo\r\nthree',extensions:[EditorState.lineSeparator.of('\r\n')]});
    const range=wholeLineSelection(state.doc,state.doc.line(2).from,state.doc.line(2).to);
    expect(state.sliceDoc(range.from,range.to)).toBe('two\r\n');
  });
});
