import type { Provider } from './ProviderSettings';

export const DEFAULT_CHAT_FONT_SIZE = 13;
export type DisclosureAcceptance = Partial<Record<Provider, true>>;
export type ChatPreferences = { chatFontSize: number; aiDisclosureAccepted: DisclosureAcceptance };

export function clampChatFontSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(11, Math.min(24, Math.round(value))) : DEFAULT_CHAT_FONT_SIZE;
}

// Only app settings are a source of remembered consent, never workspace recovery or view state.
export function readChatPreferences(settings: unknown): ChatPreferences {
  const stored = (settings && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
  const value = stored.aiDisclosureAccepted;
  const accepted: DisclosureAcceptance = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = value as Record<string, unknown>;
    if (Object.keys(entries).every(key => (key === 'codex' || key === 'claude') && entries[key] === true)) {
      if (Object.hasOwn(entries, 'codex') && entries.codex === true) accepted.codex = true;
      if (Object.hasOwn(entries, 'claude') && entries.claude === true) accepted.claude = true;
    }
  }
  return { chatFontSize: clampChatFontSize(stored.chatFontSize), aiDisclosureAccepted: accepted };
}

export function hasDisclosureConsent(accepted: DisclosureAcceptance, provider: Provider, checked = false): boolean {
  return accepted[provider] === true || checked;
}

// Call 'sent' only after agent_start acknowledges an actual explicit send.
export function updateDisclosureConsent(accepted: DisclosureAcceptance, provider: Provider, action: 'sent' | 'revoke', checked = false): DisclosureAcceptance {
  if (action === 'sent') return checked && accepted[provider] !== true ? { ...accepted, [provider]: true } : accepted;
  if (accepted[provider] !== true) return accepted;
  const next = { ...accepted };
  delete next[provider];
  return next;
}
