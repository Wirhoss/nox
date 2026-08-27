import {
  type ContentPart,
  contentPartSchema,
  contentToString,
  modalitiesIn,
  speechContentSchema,
  textFromContent,
} from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

const artifact = {
  artifactId: 'art_abcdefgh',
  filename: 'report.xlsx',
  mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  size: 42_000,
} as const;
const content: ContentPart[] = [
  { text: 'inspect this', type: 'text' },
  { source: { type: 'url', url: 'https://images.example.test/a.png' }, type: 'image' },
  {
    source: { mediaType: 'audio/wav', type: 'url', url: 'https://audio.test/a.wav' },
    type: 'audio',
  },
  { artifact, type: 'artifact' },
];

describe('multimodal content', () => {
  test('keeps non-text content out of the text projection while rendering honest references', () => {
    expect(textFromContent(content)).toBe('inspect this');
    expect(contentToString(content)).toBe(
      'inspect this\n' +
        '[Image: https://images.example.test/a.png]\n' +
        '[Audio: https://audio.test/a.wav]\n' +
        '[Artifact: report.xlsx; ID: art_abcdefgh; ' +
        'Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; Bytes: 42000]',
    );
    // Artifact is a runtime reference, not a modality a model claims to ingest.
    expect([...modalitiesIn(content)]).toEqual(['text', 'image', 'audio']);
  });

  test('allows media in the general envelope but only stored artifacts at user ingress', () => {
    expect(contentPartSchema.safeParse(content[1]).success).toBe(true);
    expect(
      speechContentSchema.safeParse([
        { text: 'read this', type: 'text' },
        { artifact, type: 'artifact' },
      ]).success,
    ).toBe(true);
    expect(
      speechContentSchema.safeParse([
        { source: { type: 'url', url: 'https://images.test/a.png' }, type: 'image' },
      ]).success,
    ).toBe(false);
    expect(
      contentPartSchema.safeParse({
        source: { mediaType: 'audio/wav', type: 'url', url: 'https://audio.test/a.wav' },
        type: 'image',
      }).success,
    ).toBe(false);
  });

  test('refuses an empty or text-only blank turn', () => {
    expect(speechContentSchema.safeParse([]).success).toBe(false);
    expect(speechContentSchema.safeParse([{ text: '   ', type: 'text' }]).success).toBe(false);
  });
});
