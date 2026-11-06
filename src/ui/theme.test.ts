import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, contrastRatio, defaultPalettes, defaultSettings, deriveBackground, derivePaletteTokens, normalizeHex, paletteText, resolvePalette, validatePalette } from './theme';
afterEach(()=>vi.unstubAllGlobals());
describe('custom theme contrast and isolation',()=>{
  it('accepts six-digit HEX only and normalizes without interpreting CSS',()=>{expect(normalizeHex(' 1553A3 ')).toBe('#1553a3');for(const value of ['#fff','red','url(x)','#12zzff','1234567'])expect(normalizeHex(value)).toBeNull();});
  it('keeps light and dark overrides independent',()=>{const settings={...defaultSettings,palettes:{light:{action:'#1553a3'},dark:{action:'#83b9ff'}}};expect(resolvePalette(settings,'light').action).toBe('#1553a3');expect(resolvePalette(settings,'dark').action).toBe('#83b9ff');expect(resolvePalette(settings,'light').canvas).toBe(defaultPalettes.light.canvas);});
  it('rejects unreadable accents, incompatible surfaces, and semantic lookalikes',()=>{expect(validatePalette({...defaultPalettes.light,action:'#ffffff'})).toBe('actionContrast');expect(validatePalette({...defaultPalettes.light,surface:'#000000'})).toBe('textContrast');expect(validatePalette({...defaultPalettes.light,action:'#b02431'})).toBe('semantic');});
  it('derives surfaces and chooses a readable common foreground',()=>{const palette=deriveBackground('#e6edf7','#1553a3');const foreground=paletteText(palette);expect(palette.canvas).toBe('#e6edf7');expect(palette.surface).not.toBe(palette.canvas);for(const background of [palette.canvas,palette.surface,palette.sidebar])expect(contrastRatio(foreground,background)).toBeGreaterThanOrEqual(4.5);expect(validatePalette(palette)).toBeNull();});
  it('does not activate corrupted or invalid persisted palettes',()=>{const settings={...defaultSettings,palettes:{light:{action:'javascript:bad'}}};expect(resolvePalette(settings,'light')).toEqual(defaultPalettes.light);});
  it('keeps default actions readable and distinct from semantic statuses in both themes',()=>{
    for(const palette of Object.values(defaultPalettes)){
      expect(validatePalette(palette)).toBeNull();
      for(const background of [palette.canvas,palette.surface,palette.sidebar])expect(contrastRatio(palette.action,background)).toBeGreaterThanOrEqual(4.5);
      const mode=palette===defaultPalettes.light?'light':'dark',tokens=derivePaletteTokens(palette,mode);
      for(const role of ['error','warning','success'] as const){
        expect(tokens.action).not.toBe(tokens[role]);
        for(const background of [palette.canvas,palette.surface,palette.sidebar])expect(contrastRatio(tokens[role],background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('derives solid white-text selection separately from subtle text selection',()=>{
    for(const mode of ['light','dark'] as const){
      for(const palette of [defaultPalettes[mode],deriveBackground(mode==='light'?'#e6edf7':'#171e2b',mode==='light'?'#1553a3':'#83b9ff')]){
        const tokens=derivePaletteTokens(palette,mode);
        expect(tokens['selected-text']).toBe('#ffffff');
        expect(tokens['selected-background']).not.toBe(tokens.selection);
        expect(tokens['action-fill']).toBe(tokens['selected-background']);
        expect(contrastRatio(tokens['selected-background'],tokens['selected-text'])).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens.text,tokens.selection)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['amber-text'],tokens.amber)).toBeGreaterThanOrEqual(4.5);
        for(const background of [palette.canvas,palette.surface,palette.sidebar])expect(contrastRatio(tokens.secondary,background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['chrome-text'],tokens.chrome)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['chrome-secondary'],tokens.chrome)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['chrome-action'],tokens.chrome)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['pdf-action'],'#ffffff')).toBeGreaterThanOrEqual(4.5);
        // PDF highlights must remain translucent so canvas-rendered text stays visible.
        expect(tokens['pdf-selection']).toBe(`${tokens['pdf-action']}33`);
        expect(tokens['selected-background']).not.toBe(tokens.error);
        expect(tokens['selected-background']).not.toBe(tokens.warning);
      }
    }
  });
  it('limits derived tint strength for valid midtone custom surfaces',()=>{
    const palette={action:'#082d52',canvas:'#929aa3',surface:'#929aa3',sidebar:'#929aa3'};
    expect(validatePalette(palette)).toBeNull();
    const tokens=derivePaletteTokens(palette,'light');
    expect(contrastRatio(tokens.text,tokens.selection)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens.text,tokens.subtle)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens['amber-text'],tokens.amber)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens['selected-text'],tokens['selected-background'])).toBeGreaterThanOrEqual(4.5);
  });
  it('preserves complete saved palettes, including an explicitly chosen green accent',()=>{
    const light={action:'#137c4b',canvas:'#f3f5f7',surface:'#ffffff',sidebar:'#eef1f4'};
    const dark=deriveBackground('#171e2b','#83b9ff');
    const settings={...defaultSettings,palettes:{light,dark}},before=JSON.stringify(settings);
    expect(resolvePalette(settings,'light')).toEqual(light);
    expect(resolvePalette(settings,'dark')).toEqual(dark);
    expect(JSON.stringify(settings)).toBe(before);
  });
  it('follows the system theme without overwriting independently saved colors or preferences',()=>{
    const values=new Map<string,string>(),root={style:{setProperty:(name:string,value:string)=>values.set(name,value),fontSize:'',colorScheme:''},dataset:{} as Record<string,string>};
    let dark=false;
    vi.stubGlobal('document',{documentElement:root});
    vi.stubGlobal('matchMedia',()=>({matches:dark}));
    const light=deriveBackground('#e6edf7','#1553a3'),night=deriveBackground('#171e2b','#83b9ff');
    const settings={...defaultSettings,palettes:{light,dark:night}},before=JSON.stringify(settings);
    applyTheme(settings);
    expect(root.dataset.theme).toBe('light');expect(values.get('--action')).toBe(light.action);expect(values.get('--canvas')).toBe(light.canvas);
    dark=true;applyTheme(settings);
    expect(root.dataset.theme).toBe('dark');expect(values.get('--action')).toBe(night.action);expect(values.get('--surface')).toBe(night.surface);
    applyTheme({...settings,theme:'light'});
    expect(root.dataset.theme).toBe('light');expect(root.style.colorScheme).toBe('light');
    expect(JSON.stringify(settings)).toBe(before);
  });
});
