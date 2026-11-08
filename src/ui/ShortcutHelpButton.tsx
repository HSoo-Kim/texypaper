import { Icon } from './Icon';
import { t } from './i18n';
import './shortcutHelpButton.css';

export function ShortcutHelpButton({onClick}:{onClick:()=>void}) {
  return <button type="button" className="shortcut-help-button" data-testid="shortcut-help-button" aria-haspopup="dialog" title={t('클릭하여 키보드 단축키 도움말 열기','Click to open keyboard shortcut help')} onClick={onClick}><Icon name="keyboard" size={16}/><span>{t('단축키','Shortcuts')}</span></button>;
}
