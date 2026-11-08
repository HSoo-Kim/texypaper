import { useI18n } from '../../ui/i18n';
import type { AgentContext, Transmission } from './chatTypes';
import type { Provider } from './ProviderSettings';

export function transmissionEntries(payload: unknown): Transmission[] {
  if (!payload || typeof payload !== 'object' || !('entries' in payload) || !Array.isArray(payload.entries)) return [];
  return payload.entries.filter((row): row is Transmission => {
    if (!row || typeof row !== 'object') return false;
    const keys = ['id', 'taskId', 'provider', 'timestamp', 'tool', 'paths', 'startLine', 'endLine', 'page', 'bytes', 'characters', 'count'];
    return Object.keys(row).every(key => keys.includes(key))
      && ['id', 'taskId', 'provider', 'tool'].every(key => typeof row[key] === 'string')
      && ['timestamp', 'bytes', 'count'].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0)
      && ['startLine', 'endLine', 'page', 'characters'].every(key => row[key] === null || (Number.isSafeInteger(row[key]) && row[key] >= 0))
      && Array.isArray(row.paths) && row.paths.every((path: unknown) => typeof path === 'string');
  });
}
export function appendTransmissions(current: Transmission[], incoming: Transmission[]): Transmission[] {
  const rows = new Map(current.map(row => [row.id, row]));
  for (const row of incoming) rows.set(row.id, row);
  return [...rows.values()].slice(-500);
}

export function Transmissions({ entries, context, provider }: { entries: Transmission[]; context: AgentContext; provider: Provider }) {
  const { t } = useI18n();
  const rows = entries.filter(row => row.provider === provider);
  const turns = new Map<string, Transmission[]>();
  for (const row of rows) { const group = turns.get(row.taskId) ?? []; group.push(row); turns.set(row.taskId, group); }
  const pending = [...(context.sources ?? []).map(row => ({ path: row.path, range: `${row.startLine}–${row.endLine}`, characters: [...row.text].length })), ...(context.pdfs ?? []).map(row => ({ path: `PDF build ${row.buildId}`, range: `${t('쪽', 'Page')} ${row.page}`, characters: [...row.quote].length }))];
  return <details className="agent-transmissions" data-testid="agent-transmissions">
    <summary>{t('전송 내역', 'Sent to')} {provider === 'codex' ? 'OpenAI' : 'Anthropic'} · {rows.length}{t('개', ' items')}{pending.length ? ` · ${t('대기', 'pending')} ${pending.length}` : ''}</summary>
    <div className="agent-transmission-list">
      <p className="agent-note">{t('공급자 CLI에 전달한 내역입니다. 클라우드 수신을 확인하는 영수증은 아닙니다. 최근 500개만 저장하며 파일 내용은 이 내역에 저장하지 않습니다.', 'Successful handoffs to the provider CLI, not confirmation of cloud receipt. Only the latest 500 items are retained; this record stores no file contents.')}</p>
      {pending.length > 0 && <section aria-label={t('아직 전송 안 됨', 'Not sent yet')}><strong>{t('아직 전송 안 됨', 'Not sent yet')}</strong><ul>{pending.map((row, index) => <li key={index} data-testid="agent-transmission-pending" data-state="pending"><span>{row.path} · {row.range}</span><span>{row.characters} {t('자', 'characters')}</span></li>)}</ul></section>}
      {!rows.length && <p className="agent-note">{t('아직 전송한 항목이 없습니다.', 'No items have been sent yet.')}</p>}
      {[...turns].map(([task, items], index) => <section key={task} data-testid="agent-transmission-turn" aria-label={`${t('요청', 'Turn')} ${index + 1}`}><strong>{t('요청', 'Turn')} {index + 1}</strong><ul>{items.map(row => <li key={row.id} data-testid="agent-transmission-row" data-state="sent" data-tool={row.tool}>
        <span><b>{row.tool}</b>{row.paths.length ? ` · ${row.paths.join(', ')}` : ''}{row.startLine !== null ? `:${row.startLine}–${row.endLine}` : ''}{row.page !== null ? ` · ${t('쪽', 'Page')} ${row.page}` : ''}</span>
        <span>{row.bytes} B{row.characters !== null ? ` · ${row.characters} ${t('자', 'characters')}` : ''}{row.count !== 1 ? ` · ${row.count} ${t('항목', 'results')}` : ''} · <time dateTime={new Date(row.timestamp).toISOString()}>{new Date(row.timestamp).toLocaleTimeString()}</time></span>
      </li>)}</ul></section>)}
    </div>
  </details>;
}
