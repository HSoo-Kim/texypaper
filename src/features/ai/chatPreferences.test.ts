import { describe, expect, it } from 'vitest';
import { clampChatFontSize, DEFAULT_CHAT_FONT_SIZE, hasDisclosureConsent, readChatPreferences, updateDisclosureConsent } from './chatPreferences';

describe('chat text size preferences', () => {
  it('uses logical 13px by default and clamps steps independently of app zoom', () => {
    expect(DEFAULT_CHAT_FONT_SIZE).toBe(13);
    expect(clampChatFontSize(10)).toBe(11);
    expect(clampChatFontSize(25)).toBe(24);
    expect(clampChatFontSize(17.6)).toBe(18);
    expect(readChatPreferences({ chatFontSize: 19, zoom: 2 }).chatFontSize).toBe(19);
    expect(readChatPreferences(JSON.parse(JSON.stringify({ chatFontSize: 22 }))).chatFontSize).toBe(22);
  });
  it('defaults invalid or missing stored data rather than accepting coerced values', () => {
    for (const chatFontSize of [undefined, null, '20', NaN, Infinity, {}, [], false]) {
      expect(readChatPreferences({ chatFontSize }).chatFontSize).toBe(13);
    }
    expect(readChatPreferences(null).chatFontSize).toBe(13);
  });
});

describe('explicit one-time disclosure per provider', () => {
  it('does not remember a checkbox without an acknowledged send', () => {
    const accepted = readChatPreferences({}).aiDisclosureAccepted;
    expect(hasDisclosureConsent(accepted, 'codex')).toBe(false);
    expect(hasDisclosureConsent(accepted, 'codex', true)).toBe(true);
    expect(readChatPreferences({}).aiDisclosureAccepted).toEqual({});
    expect(updateDisclosureConsent(accepted, 'codex', 'sent', false)).toBe(accepted);
  });
  it('persists only the provider explicitly accepted and keeps the other provider blocked', () => {
    const accepted = updateDisclosureConsent({}, 'codex', 'sent', true);
    const restored = readChatPreferences(JSON.parse(JSON.stringify({ aiDisclosureAccepted: accepted }))).aiDisclosureAccepted;
    expect(hasDisclosureConsent(restored, 'codex')).toBe(true);
    expect(hasDisclosureConsent(restored, 'claude')).toBe(false);
    const both = updateDisclosureConsent(restored, 'claude', 'sent', true);
    expect(both).toEqual({ codex: true, claude: true });
    expect(restored).toEqual({ codex: true });
  });
  it('revokes only the selected provider and requires explicit acceptance again', () => {
    const accepted = { codex: true, claude: true } as const;
    const revoked = updateDisclosureConsent(accepted, 'codex', 'revoke');
    expect(revoked).toEqual({ claude: true });
    expect(hasDisclosureConsent(revoked, 'codex')).toBe(false);
    expect(hasDisclosureConsent(revoked, 'claude')).toBe(true);
    expect(updateDisclosureConsent(revoked, 'codex', 'sent', false)).toBe(revoked);
    expect(updateDisclosureConsent(revoked, 'codex', 'sent', true)).toEqual(accepted);
  });
  it('never accepts consent from recovery/view/model data or malformed preferences', () => {
    for (const settings of [
      { disclosure: true, provider: 'codex' },
      { readingPosition: { disclosure: true } },
      { ai: { models: { codex: 'model' }, disclosure: true } },
      { aiDisclosureAccepted: { codex: false } },
      { aiDisclosureAccepted: { codex: 'true' } },
      { aiDisclosureAccepted: { codex: true, other: true } },
      { aiDisclosureAccepted: ['codex'] },
    ]) expect(readChatPreferences(settings).aiDisclosureAccepted).toEqual({});
  });
});
