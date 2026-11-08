import { describe, expect, it } from 'vitest';
import { clampChatFontSize, DEFAULT_CHAT_FONT_SIZE, readChatPreferences } from './chatPreferences';

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
