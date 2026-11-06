import type { ReactNode } from 'react';
import type { ProjectSettings } from '../state/workspace';
import type { AppSettings } from './theme';
import { ThemeColors } from './ThemeColors';
import { UpdateSettings, type UpdateController } from './Updates';
import { Icon } from './Icon';
import { t } from './i18n';
function SettingsGroup({title,description,children}:{title:string;description:string;children:ReactNode}) {
  return <section className="settings-section"><div className="settings-section-heading"><h3>{title}</h3><p>{description}</p></div><div className="settings-section-content">{children}</div></section>;
}
export function SettingsSheet({settings,onChange,updates,project,onProject,onClose}:{settings:AppSettings;onChange:(patch:Partial<AppSettings>)=>void;updates:UpdateController;project:ProjectSettings|null;onProject:(patch:Partial<ProjectSettings>)=>void;onClose:()=>void}) {
  return <section className="modal settings-dialog" role="dialog" aria-modal="true" aria-label={t('설정')}>
    <header className="settings-sheet-header"><div><Icon name="settings" size={20}/><h2>{t('설정')}</h2></div><button onClick={onClose}>{t('닫기')}</button></header>
    <div className="settings-sheet-content">
      <SettingsGroup title={t('일반','General')} description={t('작업 공간의 언어와 표시 크기입니다.','Language and display size for your workspace.')}>
        <div className="settings-control-grid"><label>{t('언어 / Language')}<select data-testid="ui-locale" aria-label="Language / 언어" value={settings.locale} onChange={event=>onChange({locale:event.target.value as 'ko'|'en'})}><option value="ko">한국어</option><option value="en">English</option></select></label><label>{t('UI 확대')}<select data-testid="ui-zoom" aria-label={t('UI 확대')} value={settings.zoom} onChange={event=>onChange({zoom:Number(event.target.value)})}><option value={1}>100%</option><option value={1.25}>125%</option><option value={1.5}>150%</option><option value={2}>200%</option></select></label></div>
      </SettingsGroup>
      <SettingsGroup title={t('모양','Appearance')} description={t('밝기와 색상을 작업 환경에 맞춥니다. PDF 용지는 흰색으로 유지됩니다.','Adjust brightness and colors for your workspace. PDF paper stays white.')}>
        <label className="settings-theme-mode">{t('테마')}<select data-testid="ui-theme" aria-label={t('테마')} value={settings.theme} onChange={event=>onChange({theme:event.target.value as AppSettings['theme']})}><option value="system">{t('시스템')}</option><option value="light">{t('밝게')}</option><option value="dark">{t('어둡게')}</option></select></label>
        <ThemeColors settings={settings} onChange={onChange}/>
        <label className="check settings-toggle"><input type="checkbox" checked={settings.lowPower} onChange={event=>onChange({lowPower:event.target.checked})}/>{t('저전력 · 투명 효과 끄기')}</label>
      </SettingsGroup>
      <SettingsGroup title={t('업데이트','Updates')} description={t('새 버전 알림과 릴리스 주소를 관리합니다.','Manage release notifications and the release feed.')}><UpdateSettings settings={settings} onChange={onChange} updates={updates}/></SettingsGroup>
      <SettingsGroup title={t('작업 공간','Workspace')} description={t('파일 탐색과 프로젝트 컴파일 설정입니다.','File discovery and project compilation settings.')}>
        <label className="check"><input type="checkbox" checked={settings.showHidden} onChange={event=>onChange({showHidden:event.target.checked})}/>{t('숨김 파일 표시')}</label>
        <p className="settings-note">{t('자동 검색 제외: .git, .texypaper, node_modules, .venv, venv, __pycache__. 탐색기에서 직접 열 수 있습니다.')}</p>
        {project&&<div className="settings-project-build"><h3>{t('프로젝트 빌드')}</h3><label>{t('엔진')}<select value={project.engine} onChange={event=>onProject({engine:event.target.value as ProjectSettings['engine']})}><option value="pdflatex">pdfLaTeX</option><option value="xelatex">XeLaTeX</option><option value="lualatex">LuaLaTeX</option></select></label><label>{t('빌드 프로필')}<select value={project.profile} onChange={event=>onProject({profile:event.target.value as ProjectSettings['profile']})}><option value="basic">{t('기본 · 설정 파일 무시 / shell escape 금지')}</option><option value="project">{t('프로젝트 · 신뢰 필요')}</option></select></label><label className="check"><input type="checkbox" checked={project.autoBuild} onChange={event=>onProject({autoBuild:event.target.checked})}/>{t('저장 후 자동 빌드')}</label></div>}
      </SettingsGroup>
    </div>
  </section>;
}
