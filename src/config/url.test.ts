import { describe, expect, test } from 'bun:test';

import { providerBaseConfigSchema } from '../provider/config';
import { httpUrlSchema } from './url';

const url = httpUrlSchema('An endpoint.');

describe('httpUrlSchema', () => {
  test('accepts an ordinary HTTP(S) endpoint', () => {
    expect(url.parse('https://search.example/api')).toBe('https://search.example/api');
    expect(url.parse('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  test('rejects a scheme that is not HTTP(S)', () => {
    expect(url.safeParse('ftp://search.example').success).toBeFalse();
    expect(url.safeParse('not a url').success).toBeFalse();
  });

  test('refuses credentials embedded in the URL rather than stripping them', () => {
    const parsed = url.safeParse('https://nox:hunter2@search.example');

    // A URL is echoed where a secret never is: into the risk record persisted
    // with a decision, and into the log line for a request that never arrived.
    // Silently removing the userinfo would leave a URL that no longer
    // authenticates and a failure nobody could explain, so it is refused.
    expect(parsed.success).toBeFalse();
    expect(parsed.error?.issues[0]?.message).toContain('managed secret');
  });

  test('a password with no username is still credentials', () => {
    expect(url.safeParse('https://:hunter2@search.example').success).toBeFalse();
    expect(url.safeParse('https://nox@search.example').success).toBeFalse();
  });
});

describe('provider base URLs', () => {
  test('carry the same refusal, since a base URL is logged verbatim', () => {
    const configured = (baseUrl: string) => providerBaseConfigSchema.safeParse({ baseUrl });

    expect(configured('https://llama.example/v1').success).toBeTrue();
    expect(configured('https://nox:hunter2@llama.example/v1').success).toBeFalse();
  });
});
