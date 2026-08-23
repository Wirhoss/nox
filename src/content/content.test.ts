import { describe, expect, test } from 'bun:test';

import {
  type ContentPart,
  contentToString,
  modalitiesIn,
  speechContentSchema,
  textFromContent,
} from './content';

const content: ContentPart[] = [
  { text: 'inspect this', type: 'text' },
  { source: { type: 'url', url: 'https://images.example.test/a.png' }, type: 'image' },
  {
    source: { data: 'YWJj', mediaType: 'audio/wav', type: 'base64' },
    type: 'audio',
  },
];

describe('multimodal content', () => {
  test('keeps media out of the text projection while rendering explicit placeholders', () => {
    expect(textFromContent(content)).toBe('inspect this');
    expect(contentToString(content)).toBe(
      'inspect this\n[Image: https://images.example.test/a.png]\n[Audio: audio/wav]',
    );
    expect([...modalitiesIn(content)]).toEqual(['text', 'image', 'audio']);
  });

  test('validates URL and inline sources without hardcoding one media modality', () => {
    expect(speechContentSchema.safeParse(content).success).toBe(true);
    expect(
      speechContentSchema.safeParse([
        { source: { data: 'YWJj', mediaType: 'video/mp4', type: 'base64' }, type: 'video' },
      ]).success,
    ).toBe(true);
    expect(
      speechContentSchema.safeParse([
        { source: { type: 'url', url: 'file:///tmp/private.png' }, type: 'image' },
      ]).success,
    ).toBe(false);
    expect(
      speechContentSchema.safeParse([
        {
          source: { data: 'YWJj', mediaType: 'audio/wav', type: 'base64' },
          type: 'image',
        },
      ]).success,
    ).toBe(false);
  });

  test('refuses an empty or text-only blank turn', () => {
    expect(speechContentSchema.safeParse([]).success).toBe(false);
    expect(speechContentSchema.safeParse([{ text: '   ', type: 'text' }]).success).toBe(false);
  });
});
