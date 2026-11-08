import type { Diagnostic } from '../contracts';
import type { ProjectSettings } from '../state/workspace';
import { AppMenu } from './AppMenu';
import { Icon } from './Icon';
import { t } from './i18n';

type Props = {
  canBuild: boolean;
  building: boolean;
  project: ProjectSettings;
  texCandidates: string[];
  logOpen: boolean;
  diagnostics: Diagnostic[];
  onBuild: () => void;
  onProject: (patch: Partial<ProjectSettings>) => void;
  onCancel: () => void;
  onSettings: () => void;
  onToggleLogs: () => void;
};

export function BuildControls({ canBuild, building, project, texCandidates, logOpen, diagnostics, onBuild, onProject, onCancel, onSettings, onToggleLogs }: Props) {
  return <>
    <div className="recompile-split">
      <button className="primary" disabled={!canBuild||building} onClick={onBuild} title="Ctrl+Shift+B">
        <Icon name="play" size={14}/>{building?t('컴파일 중'):t('다시 컴파일','Recompile')}
      </button>
      <AppMenu label={<><Icon name="chevronDown" size={14}/><span className="sr-only">{t('컴파일 옵션','Compile options')}</span></>}>
        <label className="compile-root-label">{t('주 문서')}
          <select aria-label={t('컴파일 주 문서','Compile main document')} value={project.rootTex??''} onChange={event=>onProject({rootTex:event.target.value||null})}>
            <option value="">{t('주 문서 선택')}</option>
            {[...new Set([...texCandidates,...(project.rootTex?[project.rootTex]:[])])].map(path=><option key={path} value={path}>{path}</option>)}
          </select>
        </label>
        <button role="menuitem" disabled={!building} onClick={onCancel}><Icon name="stop" size={14}/>{t('빌드 중지')}</button>
        <button role="menuitem" onClick={onSettings}>{t('엔진 및 빌드 신뢰 설정','Engine and build trust settings')}</button>
      </AppMenu>
    </div>
    <button className="icon-button logs-toggle" aria-label={t('로그 및 출력','Logs and output')} aria-pressed={logOpen} title={t('로그 및 출력','Logs and output')} onClick={onToggleLogs}>
      <Icon name="logs"/><span className="diagnostic-count">{diagnostics.filter(value=>value.severity==='error'||value.severity==='warning').length}</span>
    </button>
  </>;
}
