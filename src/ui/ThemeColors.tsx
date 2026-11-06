import { useEffect, useState } from 'react';
import { useI18n } from './i18n';
import { defaultPalettes, deriveBackground, normalizeHex, validatePalette, type AppSettings, type ThemeMode, type ThemePalette } from './theme';
const fields:readonly (keyof ThemePalette)[]=['action','canvas','surface','sidebar'];
const presets:Record<string,Record<ThemeMode,ThemePalette>>={
  texypaper:defaultPalettes,
  blue:{light:{action:'#0068d9',canvas:'#f5f5f7',surface:'#ffffff',sidebar:'#eeeef1'},dark:{action:'#69adff',canvas:'#18181b',surface:'#222226',sidebar:'#1d1d21'}},
  forest:{light:{action:'#236445',canvas:'#f3f6f3',surface:'#ffffff',sidebar:'#e9eee9'},dark:{action:'#84c6a4',canvas:'#181d1a',surface:'#202824',sidebar:'#1b221e'}},
  pastelBlue:{light:{action:'#3458a4',canvas:'#f1f4fb',surface:'#ffffff',sidebar:'#e8edf7'},dark:{action:'#a6bcff',canvas:'#191c25',surface:'#232836',sidebar:'#1d2230'}},
  graphite:{light:{action:'#354458',canvas:'#f5f5f7',surface:'#ffffff',sidebar:'#eeeef1'},dark:{action:'#a8bed9',canvas:'#18181b',surface:'#222226',sidebar:'#1d1d21'}}
};
type Props={settings:AppSettings;onChange:(patch:Partial<AppSettings>)=>void};
export function ThemeColors({settings,onChange}:Props){
  const {t}=useI18n();const [drafts,setDrafts]=useState<Record<ThemeMode,ThemePalette>>(()=>({light:{...defaultPalettes.light,...settings.palettes?.light},dark:{...defaultPalettes.dark,...settings.palettes?.dark}}));
  const [errors,setErrors]=useState<Partial<Record<ThemeMode,string>>>({});
  useEffect(()=>setDrafts({light:{...defaultPalettes.light,...settings.palettes?.light},dark:{...defaultPalettes.dark,...settings.palettes?.dark}}),[settings.palettes]);
  const message=(code:string)=>code==='hex'?t('HEX 색상은 #RRGGBB 형식으로 입력하세요.','Enter a HEX color in #RRGGBB format.'):code==='textContrast'?t('세 배경에서 읽을 수 있는 공통 글자색이 없습니다. 배경 밝기를 비슷하게 조절하세요.','The three backgrounds cannot share readable text. Keep their brightness similar.'):code==='actionContrast'?t('강조색과 각 배경의 명암비는 4.5:1 이상이어야 합니다.','Accent text must have at least 4.5:1 contrast against every background.'):t('오류·경고 색상과 구별되는 강조색을 선택하세요.','Choose an accent distinguishable from error and warning colors.');
  const apply=(mode:ThemeMode,palette:ThemePalette)=>{
    const normalized=Object.fromEntries(fields.map(field=>[field,normalizeHex(palette[field])??palette[field]])) as ThemePalette;
    const error=validatePalette(normalized);if(error){setErrors(current=>({...current,[mode]:error}));return;}
    setErrors(current=>({...current,[mode]:undefined}));setDrafts(current=>({...current,[mode]:normalized}));const recent={mode,palette:normalized};onChange({palettes:{...settings.palettes,[mode]:normalized},paletteRecents:[recent,...(settings.paletteRecents??[]).filter(item=>item.mode!==mode||JSON.stringify(item.palette)!==JSON.stringify(normalized))].slice(0,8)});
  };
  const presetName=(name:string)=>name==='texypaper'?t('기본 네이비 · 라즈베리','Default navy · raspberry'):name==='forest'?t('연녹색','Soft green'):name==='blue'?t('하늘색','Sky blue'):name==='pastelBlue'?t('파스텔 블루','Pastel blue'):t('은은한 밤','Quiet night');
  const changeField=(mode:ThemeMode,field:keyof ThemePalette,value:string)=>{const color=normalizeHex(value);const next=field==='canvas'&&color?deriveBackground(color,drafts[mode].action):{...drafts[mode],[field]:value};setDrafts(current=>({...current,[mode]:next}));return next;};
  const label=(field:keyof ThemePalette)=>field==='action'?t('강조색','Accent'):field==='canvas'?t('배경 색','Background color'):field==='surface'?t('편집 영역','Surface'):t('사이드바','Sidebar');
  return <section className="theme-colors" aria-label={t('사용자 테마 색상','Custom theme colors')}>
    <h2>{t('색 테마 고르기','Choose a color theme')}</h2>
    <p className="muted">{t('낮과 밤의 색상을 각각 저장합니다. 글자와 선택 항목은 읽기 쉬운 대비로 조정됩니다. PDF 용지는 흰색을 유지합니다.','Light and dark palettes are saved independently. Text and selected items adapt for readable contrast. PDF paper stays white.')}</p>
    <div className="palette-columns">{(['light','dark'] as const).map(mode=><fieldset key={mode}>
      <legend>{mode==='light'?t('낮 테마','Light palette'):t('밤 테마','Dark palette')}</legend>
      <div className="preset-swatches" role="group" aria-label={t('색상 프리셋','Palette presets')}>{Object.entries(presets).map(([name,colors])=><button type="button" key={name} style={{backgroundColor:colors[mode].action}} aria-label={`${presetName(name)} ${mode==='light'?t('낮','Light'):t('밤','Dark')}`} aria-pressed={fields.every(field=>drafts[mode][field]===colors[mode][field])} title={presetName(name)} onClick={()=>apply(mode,colors[mode])}><span className="sr-only">{presetName(name)}</span></button>)}</div>
      {fields.map(field=><label className="palette-field" key={field}><span>{label(field)}</span><div>
        <input type="color" value={normalizeHex(drafts[mode][field])??defaultPalettes[mode][field]} title={t('다른 색','Other color')} aria-label={`${mode==='light'?t('낮','Light'):t('밤','Dark')} ${label(field)} ${t('다른 색','Other color')}`} onChange={event=>{const next=changeField(mode,field,event.target.value);apply(mode,next);}}/>
        <input data-testid={`palette-${mode}-${field}`} aria-label={`${mode==='light'?t('낮','Light'):t('밤','Dark')} ${label(field)} HEX`} value={drafts[mode][field]} spellCheck={false} maxLength={7} onChange={event=>setDrafts(current=>({...current,[mode]:{...current[mode],[field]:event.target.value}}))} onBlur={()=>{const next=changeField(mode,field,drafts[mode][field]);apply(mode,next);}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();apply(mode,drafts[mode]);}}}/>
      </div></label>)}
      {errors[mode]&&<p role="alert" className="palette-error" data-testid={`palette-${mode}-error`}>{message(errors[mode]!)}</p>}
      <button onClick={()=>apply(mode,drafts[mode])}>{t('색상 적용','Apply colors')}</button>
      {(settings.paletteRecents??[]).some(item=>item.mode===mode)&&<div className="recent-palettes"><span>{t('최근 조합','Recent combinations')}</span>{(settings.paletteRecents??[]).filter(item=>item.mode===mode).map((item,index)=><button key={index} style={{backgroundColor:item.palette.canvas,color:item.palette.action,borderColor:item.palette.action}} title={`${item.palette.action} / ${item.palette.canvas}`} onClick={()=>apply(mode,item.palette)}><span className="recent-palette-mark" aria-hidden="true"/><span className="sr-only">{t('최근 조합','Recent combination')} {index+1}</span></button>)}</div>}
    </fieldset>)}</div>
    <button data-testid="palette-reset" onClick={()=>{setErrors({});setDrafts({light:{...defaultPalettes.light},dark:{...defaultPalettes.dark}});onChange({palettes:{},paletteRecents:[]});}}>{t('기본 색상으로 복원','Reset theme colors')}</button>
  </section>;
}
