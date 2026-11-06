import {describe,expect,it} from 'vitest';
import {texShortcutGroups} from '../editor/texShortcuts';
import {buildShortcutHelpCategories,filterShortcutHelpCategories,splitShortcutKeys} from './ShortcutHelp';

describe('shortcut help data',()=>{
  it('derives every live editor shortcut once, including compile in the PDF workflow',()=>{
    const categories=buildShortcutHelpCategories('en');
    const rows=categories.flatMap(category=>category.rows);
    const editorRows=rows.filter(row=>row.id.startsWith('tex:'));
    expect(new Set(rows.map(row=>row.id)).size).toBe(rows.length);
    expect(editorRows).toHaveLength(texShortcutGroups.reduce((count,group)=>count+group.shortcuts.length,0));
    for(const group of texShortcutGroups){
      expect(categories.some(category=>category.id===group.id&&category.label===group.label.en)).toBe(true);
      for(const shortcut of group.shortcuts){
        const row=editorRows.find(row=>row.id===`tex:${group.id}:${shortcut.id}`);
        expect(row?.label).toBe(shortcut.label.en);
        expect(row?.keys).toEqual(shortcut.keys);
      }
    }
    expect(categories.find(category=>category.id==='compile-pdf')?.rows.some(row=>row.id==='tex:compile:compile')).toBe(true);
    expect(categories.find(category=>category.id==='compile')?.rows.some(row=>row.id==='tex:compile:compile')).toBe(false);
  });

  it('uses the supplied keymap groups without retaining missing or duplicating added shortcuts',()=>{
    const groups=[{id:'custom',label:{ko:'사용자 편집',en:'Custom editing'},shortcuts:[{id:'custom-action',label:{ko:'사용자 동작',en:'Custom action'},keys:['Ctrl+9'],macKeys:['Cmd+9'],bindings:[]}]}];
    const categories=buildShortcutHelpCategories('ko',groups);
    const rows=categories.flatMap(category=>category.rows).filter(row=>row.id.startsWith('tex:'));
    expect(rows).toEqual([{id:'tex:custom:custom-action',label:'사용자 동작',keys:['Ctrl+9']}]);
    expect(categories.find(category=>category.id==='custom')?.label).toBe('사용자 편집');
  });

  it('filters across categories by action, hint, category and keys without mutating the source',()=>{
    const categories=buildShortcutHelpCategories('en');
    const originalCount=categories.reduce((count,category)=>count+category.rows.length,0);
    const matches=filterShortcutHelpCategories(categories,'  CTRL+SHIFT+C  ');
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('ai-comments');
    expect(matches[0].rows.map(row=>row.id)).toEqual(['add-comment']);
    expect(filterShortcutHelpCategories(categories,'filename')[0].rows.map(row=>row.id)).toEqual(['quick-open']);
    expect(filterShortcutHelpCategories(categories,'Zoom focused').flatMap(category=>category.rows).map(row=>row.id)).toEqual(['focus-zoom-in','focus-zoom-out']);
    expect(filterShortcutHelpCategories(categories,'no-such-shortcut')).toEqual([]);
    expect(filterShortcutHelpCategories(categories,'   ')).toEqual(categories);
    expect(categories.reduce((count,category)=>count+category.rows.length,0)).toBe(originalCount);
  });

  it('keeps localized search and category labels together',()=>{
    const categories=buildShortcutHelpCategories('ko');
    expect(filterShortcutHelpCategories(categories,'댓글').some(category=>category.id==='ai-comments')).toBe(true);
    expect(filterShortcutHelpCategories(categories,'다중 커서').some(category=>category.id==='navigation')).toBe(true);
  });
});

describe('shortcut keycap splitting',()=>{
  it('splits modifiers and alternative combinations, preserving punctuation keys',()=>{
    expect(splitShortcutKeys('Ctrl+Shift+C')).toEqual([['Ctrl','Shift','C']]);
    expect(splitShortcutKeys('Ctrl++ / Ctrl+-')).toEqual([['Ctrl','+'],['Ctrl','-']]);
    expect(splitShortcutKeys(['Ctrl+/', 'Ctrl+Shift+/'])).toEqual([['Ctrl','/'],['Ctrl','Shift','/']]);
    expect(splitShortcutKeys(['Ctrl+s / Ctrl+Enter','Ctrl+.'])).toEqual([['Ctrl','S'],['Ctrl','Enter'],['Ctrl','.']]);
    expect(splitShortcutKeys(['Ctrl+click','Alt+drag','Right-click'])).toEqual([['Ctrl','click'],['Alt','drag'],['Right-click']]);
    expect(splitShortcutKeys('F2')).toEqual([['F2']]);
    expect(splitShortcutKeys([])).toEqual([]);
  });
});
