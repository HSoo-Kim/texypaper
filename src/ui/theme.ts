import type { Environment } from '../contracts';
export type ThemeMode='light'|'dark';
export type ThemePalette={action:string;canvas:string;surface:string;sidebar:string};
export type AppSettings={environments?:Environment[];recents?:{environmentId:string;root:string;label?:string}[];locale:'ko'|'en';theme:'system'|ThemeMode;palettes?:Partial<Record<ThemeMode,Partial<ThemePalette>>>;paletteRecents?:{mode:ThemeMode;palette:ThemePalette}[];updates?:{enabled:boolean;feedUrl:string};ai?:{provider:'codex'|'claude';models?:Partial<Record<'codex'|'claude',string>>;reasoningEfforts?:Partial<Record<'codex'|'claude',string>>};providerExecutables?:Partial<Record<'codex'|'claude',string>>;zoom:number;lowPower:boolean;showHidden:boolean;explorerWidth:number;inspectorWidth:number;};
export const defaultSettings:AppSettings={updates:{enabled:true,feedUrl:''},locale:'ko',theme:'system',zoom:1,lowPower:false,showHidden:false,explorerWidth:240,inspectorWidth:420};
export const defaultPalettes:Record<ThemeMode,ThemePalette>={light:{action:'#a72f65',canvas:'#eef2f8',surface:'#ffffff',sidebar:'#eaf0f8'},dark:{action:'#e875ad',canvas:'#111c30',surface:'#18253d',sidebar:'#142037'}};
export function normalizeHex(value:string){const match=value.trim().match(/^#?([\da-f]{6})$/i);return match?`#${match[1].toLowerCase()}`:null;}
function channels(hex:string){return [1,3,5].map(index=>Number.parseInt(hex.slice(index,index+2),16));}
function luminance(hex:string){const [r,g,b]=channels(hex).map(value=>{const linear=value/255;return linear<=.04045?linear/12.92:((linear+.055)/1.055)**2.4;});return .2126*r+.7152*g+.0722*b;}
export function contrastRatio(first:string,second:string){const a=luminance(first),b=luminance(second);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
function minimumContrast(color:string,backgrounds:string[]){return Math.min(...backgrounds.map(background=>contrastRatio(color,background)));}
export function paletteText(palette:ThemePalette){const backgrounds=[palette.canvas,palette.surface,palette.sidebar];return minimumContrast('#202832',backgrounds)>=minimumContrast('#edf1f5',backgrounds)?'#202832':'#edf1f5';}
export function validatePalette(palette:ThemePalette):'hex'|'textContrast'|'actionContrast'|'semantic'|null{
  if(Object.values(palette).some(value=>!normalizeHex(value)))return 'hex';
  const backgrounds=[palette.canvas,palette.surface,palette.sidebar];
  if(minimumContrast(paletteText(palette),backgrounds)<4.5)return 'textContrast';
  if(minimumContrast(palette.action,backgrounds)<4.5)return 'actionContrast';
  const accent=channels(palette.action),semantic=['#b02431','#865400','#ff9c9f','#f5cb72'];
  if(semantic.some(color=>{const value=channels(color);return Math.hypot(...accent.map((channel,index)=>channel-value[index]))<45;}))return 'semantic';
  return null;
}
function blend(first:string,second:string,amount:number){const a=channels(first),b=channels(second);return '#'+a.map((value,index)=>Math.round(value*(1-amount)+b[index]*amount).toString(16).padStart(2,'0')).join('');}
export function deriveBackground(color:string,action:string):ThemePalette{const dark=luminance(color)<.3;return {action,canvas:color,surface:blend(color,'#ffffff',dark?.04:.68),sidebar:blend(color,'#000000',dark?.08:.03)};}
export function resolvePalette(settings:AppSettings,mode:ThemeMode){const palette={...defaultPalettes[mode],...settings.palettes?.[mode]};return validatePalette(palette)?defaultPalettes[mode]:palette;}
function semanticColor(color:string,text:string,backgrounds:string[]){if(minimumContrast(color,backgrounds)>=4.5)return color;for(let amount=.1;amount<=1.01;amount+=.1){const adjusted=blend(color,text,Math.min(1,amount));if(minimumContrast(adjusted,backgrounds)>=4.5)return adjusted;}return text;}
export function derivePaletteTokens(palette:ThemePalette,mode:ThemeMode){
  const text=paletteText(palette),backgrounds=[palette.canvas,palette.surface,palette.sidebar];
  const chrome=mode==='dark'?'#0c1629':'#14243f',chromeText='#f1f4f7';
  const secondary=semanticColor(blend(palette.surface,text,.66),text,backgrounds);
  let selection=palette.surface;
  for(let amount=.14;amount>0;amount-=.02){const candidate=blend(palette.surface,palette.action,amount);if(contrastRatio(text,candidate)>=4.5){selection=candidate;break;}}
  const selectedBackground=semanticColor(palette.action,'#000000',['#ffffff']);
  const error=semanticColor(text==='#edf1f5'?'#ff9c9f':'#b02431',text,backgrounds);
  const warning=semanticColor(text==='#edf1f5'?'#f5cb72':'#865400',text,backgrounds);
  let amber=palette.surface;
  for(let amount=.12;amount>0;amount-=.02){const candidate=blend(palette.surface,warning,amount);if(contrastRatio(text,candidate)>=4.5){amber=candidate;break;}}
  return {...palette,text,secondary,error,warning,selection,border:blend(palette.surface,text,.2),subtle:palette.canvas,
    'selected-background':selectedBackground,'selected-text':'#ffffff','action-fill':selectedBackground,'on-action':'#ffffff',
    amber,'amber-text':semanticColor(warning,text,[amber]),success:semanticColor(text==='#edf1f5'?'#4cc38a':'#137c4b',text,backgrounds),
    chrome,'chrome-text':chromeText,'chrome-secondary':'#bdc9db','chrome-border':'#415574','chrome-action':semanticColor(palette.action,chromeText,[chrome]),
    'pdf-action':selectedBackground,'pdf-selection':`${selectedBackground}33`};
}
export function applyTheme(settings:AppSettings){
  const mode:ThemeMode=settings.theme==='dark'||(settings.theme==='system'&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';
  const values=derivePaletteTokens(resolvePalette(settings,mode),mode);
  for(const [name,value]of Object.entries(values))document.documentElement.style.setProperty(`--${name}`,value);
  document.documentElement.dataset.theme=mode;document.documentElement.dataset.lowPower=String(settings.lowPower);document.documentElement.style.fontSize=`${16*Math.min(2,Math.max(1,settings.zoom))}px`;document.documentElement.style.colorScheme=mode;
}
