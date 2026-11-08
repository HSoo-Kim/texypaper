import { Icon, type IconName } from './Icon';
import { t } from './i18n';

type Panel = 'files' | 'search' | 'history' | 'comments' | 'ai';
type Props = {
  explorer: boolean;
  searchPanel: boolean;
  historyPanel: boolean;
  chatDetached: boolean;
  rightOpen: boolean;
  tab: 'ai' | 'comments';
  onPanel: (panel: Panel) => void;
  onHelp: () => void;
  onSettings: () => void;
};

export function ActivityRail({ explorer, searchPanel, historyPanel, chatDetached, rightOpen, tab, onPanel, onHelp, onSettings }: Props) {
  return <nav className="activity-rail" aria-label={t('작업 도구','Workspace tools')}>
    <div className="rail-top">
      {([
        {panel:'files',name:'files',label:t('탐색기 표시')},
        {panel:'search',name:'search',label:t('프로젝트 검색','Project search')},
        {panel:'history',name:'history',label:t('체크포인트','Checkpoints')},
        {panel:'comments',name:'comments',label:t('댓글')},
        {panel:'ai',name:'ai',label:t('AI 도우미')},
      ] as const).map(item => <button
        className="rail-button"
        key={item.panel}
        title={item.label}
        aria-label={item.panel==='ai'?t('AI 및 댓글 패널'):item.label}
        aria-pressed={item.panel==='files'?explorer&&!searchPanel&&!historyPanel:item.panel==='search'?searchPanel:item.panel==='history'?historyPanel:item.panel==='ai'&&chatDetached||rightOpen&&tab===item.panel}
        onClick={() => onPanel(item.panel)}
      >
        <Icon name={item.name as IconName}/><span className="sr-only">{item.label}</span>
      </button>)}
    </div>
    <div className="rail-bottom">
      <button className="rail-button" title={t('도움말','Help')} aria-label={t('도움말','Help')} onClick={onHelp}><Icon name="help"/></button>
      <button className="rail-button" title={t('설정')} aria-label={t('설정')} data-testid="settings-button" onClick={onSettings}><Icon name="settings"/></button>
    </div>
  </nav>;
}
