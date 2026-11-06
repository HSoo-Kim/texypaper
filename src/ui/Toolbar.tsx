import { t } from './i18n';
import { Icon } from './Icon';
import { AppMenu } from './AppMenu';
import type { WorkspaceRef } from '../contracts';
import productIcon from './assets/texypaper-icon.png';
export type ViewMode='source'|'pdf'|'split';
type Props={workspace:WorkspaceRef;environmentLabel:string;connection:'local'|'connected'|'disconnected';compact:boolean;rootTex:string|null;canBuild:boolean;candidates:string[];building:boolean;buildPhase:'idle'|'queued'|'building'|'published'|'failed'|'cancelled'|'timeout';stale:boolean;view:ViewMode;onProject:()=>void;onRoot:(path:string)=>void;onBuild:()=>void;onCancel:()=>void;onView:(view:ViewMode)=>void;onExplorer:()=>void;onInspector:()=>void;onSettings:()=>void;onSave:()=>void;onNewFile:()=>void;onNewFolder:()=>void;onQuickOpen:()=>void;onEdit:(command:'undo'|'redo'|'find'|'replace')=>void;onHelp:()=>void;recentProjects:{label:string;onOpen:()=>void}[];};
export function Toolbar(props:Props){
  const phaseLabel=props.buildPhase==='queued'?t('다음 빌드 대기','Next build queued'):props.buildPhase==='building'?t('컴파일 중'):props.buildPhase==='failed'?t('빌드 실패','Build failed'):props.buildPhase==='cancelled'?t('빌드 중지됨','Build cancelled'):props.buildPhase==='timeout'?t('빌드 시간 초과','Build timed out'):props.stale?t('PDF 갱신 필요'):t('준비');
  const effectiveView=props.compact&&props.view==='split'?'source':props.view;
  return <header className="toolbar" data-testid="workspace-identity" data-environment-id={props.workspace.environmentId} data-root={props.workspace.root} data-epoch={props.workspace.epoch}>
    <div className="toolbar-left"><span className="product-mark" aria-label="TexyPaper"><img className="product-icon" src={productIcon} width={24} height={24} alt=""/><span className="product-wordmark">TexyPaper</span></span>
      <AppMenu label={t('파일','File')}><button role="menuitem" onClick={props.onProject}>{t('프로젝트 열기')}<kbd>Ctrl+O</kbd></button><button role="menuitem" onClick={props.onNewFile}>{t('새 파일')}</button><button role="menuitem" onClick={props.onNewFolder}>{t('새 폴더')}</button><button role="menuitem" onClick={props.onSave}>{t('저장 후 컴파일','Save and compile')}<kbd>Ctrl+S</kbd></button><button role="menuitem" onClick={props.onQuickOpen}>{t('빠른 파일 열기')}<kbd>Ctrl+P</kbd></button></AppMenu>
      <AppMenu label={t('편집','Edit')}><button role="menuitem" onClick={()=>props.onEdit('undo')}>{t('실행 취소','Undo')}<kbd>Ctrl+Z</kbd></button><button role="menuitem" onClick={()=>props.onEdit('redo')}>{t('다시 실행','Redo')}<kbd>Ctrl+Y</kbd></button><button role="menuitem" onClick={()=>props.onEdit('find')}>{t('찾기','Find')}<kbd>Ctrl+F</kbd></button><button role="menuitem" onClick={()=>props.onEdit('replace')}>{t('찾기 및 바꾸기','Find and replace')}<kbd>Ctrl+H</kbd></button></AppMenu>
      <AppMenu label={t('보기','View')}><button role="menuitem" onClick={props.onExplorer}>{t('탐색기 표시')}</button><button role="menuitem" onClick={props.onInspector}>{t('AI 및 댓글 패널')}</button><button role="menuitem" onClick={props.onSettings}>{t('설정')}</button></AppMenu>
      <AppMenu label={t('도움말','Help')}><button role="menuitem" onClick={props.onHelp}>{t('키보드 단축키','Keyboard shortcuts')}</button><button role="menuitem" onClick={props.onSettings}>{t('설정')}</button></AppMenu>
    </div>
    <div className="toolbar-project"><button className="project-button" data-testid="workspace-switch" aria-label={t('프로젝트 전환')} title={`${props.workspace.root}\n${props.environmentLabel} · ${props.connection==='local'?t('로컬'):props.connection==='disconnected'?t('연결 끊김'):t('연결됨')}`} onClick={props.onProject}><strong>{props.workspace.root.split(/[\\/]/).filter(Boolean).at(-1)}</strong></button><AppMenu className="project-menu" label={<><Icon name="chevronDown" size={14}/><span className="sr-only">{t('프로젝트 메뉴','Project menu')}</span></>}><button role="menuitem" onClick={props.onProject}>{t('프로젝트 전환')}</button>{props.recentProjects.map((recent,index)=><button role="menuitem" key={index} onClick={recent.onOpen}>{recent.label}</button>)}<button role="menuitem" onClick={props.onSettings}>{t('프로젝트 설정','Project settings')}</button></AppMenu></div>
    <div className="toolbar-actions">
      <div className="toolbar-group view-group" role="group" aria-label={t('작업 보기')}>{(['source','pdf','split'] as const).filter(mode=>!props.compact||mode!=='split').map(mode=><button key={mode} aria-pressed={effectiveView===mode} onClick={()=>props.onView(mode)} title={mode==='source'?t('소스'):mode==='pdf'?'PDF':t('분할')}>{mode==='source'?t('소스'):mode==='pdf'?'PDF':t('분할')}</button>)}</div>
      <div className="toolbar-build">
        <button className="build-button" aria-label={props.building?t('빌드 중지'):t('빌드')} title={`${phaseLabel} · Ctrl+Shift+B`} disabled={!props.canBuild&&!props.building} onClick={props.building?props.onCancel:props.onBuild}><Icon name={props.building?'stop':'play'} size={14}/><span>{props.building?t('중지','Stop'):t('빌드')}</span></button>
        <AppMenu className="build-options" label={<><Icon name="chevronDown" size={14}/><span className="sr-only">{t('빌드 옵션','Build options')}</span></>}>
          <label className="compile-root-label" htmlFor="main-root">{t('주 문서')}<select id="main-root" data-testid="root-document" value={props.rootTex??''} onChange={event=>props.onRoot(event.target.value)}><option value="">{t('자동 판별','Detect automatically')}</option>{[...new Set([...props.candidates,...(props.rootTex?[props.rootTex]:[])])].map(path=><option key={path} value={path}>{path}</option>)}</select></label>
          <p className="muted">{t('열린 TeX와 % !TeX root에서 자동으로 찾습니다. 주 문서가 여러 개일 때만 직접 선택하세요.','Detected from the open TeX file and % !TeX root. Select manually when the project has multiple main documents.')}</p>
        </AppMenu>
        <span className="sr-only" role="status">{phaseLabel}</span>
      </div>
    </div>
  </header>;
}
