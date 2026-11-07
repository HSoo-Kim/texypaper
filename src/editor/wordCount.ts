import { proseRanges, type ProseRange } from './proseRanges';
export type WordCount={words:number;characters:number};
/** Counts rendered-source prose, not macro expansion. A whitespace/punctuation-separated
 * Hangul or CJK run counts as one word (no dictionary segmentation). Latin contractions
 * and hyphenated words count once; standalone numbers do not. Characters include prose
 * whitespace and punctuation, counted as Unicode code points rather than UTF-16 units. */
function countRanges(text:string,ranges:ProseRange[]):WordCount {
  let words=0,characters=0;
  for(const {start,end} of ranges){const prose=text.slice(start,end);for(const _character of prose)characters++;for(const match of prose.matchAll(/[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu))if(/\p{L}/u.test(match[0]))words++;}
  return {words,characters};
}
export function countWords(text:string):WordCount { return countRanges(text,proseRanges(text)); }
/** Selection offsets are UTF-16 and retain the full document's TeX context. */
export function countSelection(text:string,from=0,to=text.length):WordCount {
  const start=Math.max(0,Math.min(from,to,text.length)),end=Math.max(start,Math.min(Math.max(from,to),text.length));
  return countRanges(text,proseRanges(text).map(range=>({start:Math.max(start,range.start),end:Math.min(end,range.end)})).filter(range=>range.end>range.start));
}
