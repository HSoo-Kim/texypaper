import type { BufferRecord } from '../editor/buffers';
import { ShortcutHelpButton } from './ShortcutHelpButton';
import { t } from './i18n';

type Props = {
  buildSequence: number;
  buildPhase: string;
  stale: boolean;
  buildId?: string;
  syncStatus: { direction: string; sequence: number } | null;
  recoveryStatus?: string | null;
  currentBuffer?: BufferRecord;
  wordCounts: { words: number; characters: number; selectionWords: number } | null;
  trashCount: number;
  diagnosticCount: number;
  hasSourceSelection: boolean;
  onTrash: () => void;
  onQuickOpen: () => void;
  onToggleLogs: () => void;
  onUndo: () => void;
  onComment: () => void;
  onHelp: () => void;
};

export function StatusBar({ buildSequence, buildPhase, stale, buildId, syncStatus, recoveryStatus, currentBuffer, wordCounts, trashCount, diagnosticCount, hasSourceSelection, onTrash, onQuickOpen, onToggleLogs, onUndo, onComment, onHelp }: Props) {
  return <footer className="statusbar">
    <span data-testid="build-status" data-sequence={buildSequence} data-status={buildPhase==='published'&&stale?'stale':buildPhase} data-build-id={buildId??''} className="sr-only">{buildPhase==='published'&&stale?'stale':buildPhase}</span>
    <span data-testid="sync-status" data-status={syncStatus?'matched':'idle'} data-direction={syncStatus?.direction??''} data-sequence={syncStatus?.sequence??0} className="sr-only">{syncStatus?'matched':'idle'}</span>
    {recoveryStatus && <span data-testid="transaction-status" data-status={recoveryStatus}>{t('복구 상태','Recovery status')}: {recoveryStatus}</span>}
    <span>{currentBuffer?t(`${currentBuffer.document.readOnly?'읽기 전용':currentBuffer.saving?'저장 중':currentBuffer.dirty?'변경됨':'저장됨'} · ${currentBuffer.document.encoding.toUpperCase()} · ${currentBuffer.document.newline.toUpperCase()}`):t('파일을 선택하세요')}</span>
    {wordCounts && <span data-testid="word-count" data-words={wordCounts.words} data-characters={wordCounts.characters} data-selection-words={wordCounts.selectionWords}>
      {t(`${wordCounts.words.toLocaleString()}단어 · ${wordCounts.characters.toLocaleString()}자${wordCounts.selectionWords?` · 선택 ${wordCounts.selectionWords.toLocaleString()}단어`:''}`,`${wordCounts.words.toLocaleString()} words · ${wordCounts.characters.toLocaleString()} characters${wordCounts.selectionWords?` · ${wordCounts.selectionWords.toLocaleString()} selected`:''}`)}
    </span>}
    <div>
      {trashCount>0 && <button onClick={onTrash}>{t('휴지통 복원','Restore from trash')} ({trashCount})</button>}
      <button onClick={onQuickOpen}>{t("파일 찾기 Ctrl+P")}</button>
      <button onClick={onToggleLogs}>{t("진단")}{diagnosticCount} {t("· 빌드 로그")}</button>
      {currentBuffer?.transactionId && <button onClick={onUndo}>{t('마지막 저장 실행 취소','Undo last save')}</button>}
      {hasSourceSelection && <button onClick={onComment}>{t("선택에 댓글")}</button>}
      <ShortcutHelpButton onClick={onHelp}/>
    </div>
  </footer>;
}
