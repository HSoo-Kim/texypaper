import type { CSSProperties } from 'react';
const paths = {
  home: 'M3 11l9-8 9 8 M5 9v12h14V9 M9 21v-8h6v8',
  files: 'M4 3h10l4 4v14H4z M14 3v5h5 M8 12h6 M8 16h6',
  search: 'M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  comments: 'M4 4h16v12H9l-5 4z M8 8h8 M8 12h5',
  ai: 'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
  settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  help: 'M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4 M12 17h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  keyboard: 'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M6 9h.01 M10 9h.01 M14 9h.01 M18 9h.01 M6 12h.01 M10 12h.01 M14 12h.01 M18 12h.01 M7 15h10',
  chevronDown: 'M6 9l6 6 6-6', chevronLeft: 'M15 6l-6 6 6 6', chevronRight: 'M9 6l6 6-6 6', close: 'M6 6l12 12 M18 6L6 18',
  plus: 'M12 5v14 M5 12h14', filePlus: 'M14 3H4v18h16V9z M14 3v6h6 M12 12v6 M9 15h6', folderPlus: 'M3 6h7l2 3h9v12H3z M12 12v6 M9 15h6',
  refresh: 'M20 8a8 8 0 1 0 0 8 M20 3v5h-5', collapse: 'M5 8h14 M5 16h14 M9 4l3 3 3-3 M9 20l3-3 3 3',
  undo: 'M9 5L4 10l5 5 M4 10h10a6 6 0 0 1 6 6v3', redo: 'M15 5l5 5-5 5 M20 10H10a6 6 0 0 0-6 6v3',
  bold: 'M7 4h6a4 4 0 0 1 0 8H7z M7 12h7a4 4 0 0 1 0 8H7z', italic: 'M10 4h9 M5 20h9 M15 4L9 20',
  section: 'M6 8h12 M6 16h12 M10 3L8 21 M16 3l-2 18', cite: 'M9 6H4v7h5v-3H4 M20 6h-5v7h5v-3h-5 M4 13l3 5 M15 13l3 5',
  ref: 'M10 13a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2 M14 11a4 4 0 0 0-6 0l-4 4a4 4 0 0 0 6 6l2-2',
  list: 'M9 6h12 M9 12h12 M9 18h12 M3 6h.01 M3 12h.01 M3 18h.01', math: 'M19 4H6l7 8-7 8h13',
  play: 'M8 4l12 8-12 8z', stop: 'M5 5h14v14H5z', logs: 'M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5', zoomIn: 'M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M7 10h6 M10 7v6', zoomOut: 'M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M7 10h6',
  split: 'M3 4h18v16H3z M12 4v16', save: 'M4 3h13l4 4v14H3V3z M7 3v6h9V3 M7 21v-8h10v8',
  folder: 'M3 6h7l2 3h9v12H3z', document: 'M14 3H4v18h16V9z M14 3v6h6', external: 'M14 3h7v7 M21 3L10 14 M10 3H3v18h18v-7', more: 'M5 12h.01 M12 12h.01 M19 12h.01',
} as const;
export type IconName = keyof typeof paths;
export function Icon({name,size=18,className,style}:{name:IconName;size?:number;className?:string;style?:CSSProperties}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className} style={style}><path d={paths[name]}/></svg>;
}
