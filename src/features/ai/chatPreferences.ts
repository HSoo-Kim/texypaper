export const DEFAULT_CHAT_FONT_SIZE = 13;
export type ChatPreferences = { chatFontSize: number };

export function clampChatFontSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(11, Math.min(24, Math.round(value))) : DEFAULT_CHAT_FONT_SIZE;
}

export function readChatPreferences(settings: unknown): ChatPreferences {
  const stored = (settings && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
  return { chatFontSize: clampChatFontSize(stored.chatFontSize) };
}
