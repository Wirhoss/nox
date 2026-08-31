import * as api from '@nox/extension-api';
import { CONTROL_PLANE_SERVICE_IDS, HOST_SERVICE_TOKENS } from '@nox/extension-api';
import { describe, expect, test } from 'bun:test';

function isServiceToken(value: unknown): value is { controlPlane?: true; id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).every((key) => key === 'id' || key === 'controlPlane') &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

describe('the host service roster', () => {
  // The roster exists so nothing downstream keeps a second copy. That only
  // holds while it stays complete, and the way it stops being complete is a
  // service added later that nobody remembers to list — after which every
  // check derived from it silently stops covering that service.
  test('holds every service token the contract exports', () => {
    const exported = Object.entries(api)
      .filter(([name, value]) => name.endsWith('Service') && isServiceToken(value))
      .map(([, value]) => (value as { id: string }).id);

    expect(exported.length).toBeGreaterThan(0);
    expect([...HOST_SERVICE_TOKENS].map((token) => token.id).sort()).toEqual(exported.sort());
  });

  test('derives the control-plane IDs from the tokens themselves', () => {
    expect(CONTROL_PLANE_SERVICE_IDS).toEqual([
      'nox.chat-hub',
      'nox.config-admin',
      'nox.scheduled-run-host',
      'nox.secret-store',
    ]);
    for (const id of CONTROL_PLANE_SERVICE_IDS) {
      expect(HOST_SERVICE_TOKENS.find((token) => token.id === id)?.controlPlane).toBeTrue();
    }
  });

  // The ordinary services are the interesting half of the assertion: a token
  // that quietly gained `controlPlane` would lock out every installed package
  // that declares it, and this is where that shows up as a failing test rather
  // than as somebody's extension refusing to load.
  test('leaves the ordinary services open to any origin', () => {
    const ordinary = HOST_SERVICE_TOKENS.filter((token) => token.controlPlane !== true).map(
      (token) => token.id,
    );

    expect(ordinary.sort()).toEqual([
      'nox.artifact-pipeline',
      'nox.config',
      'nox.data-directory',
      'nox.logger',
      'nox.model-access',
      'nox.runtime-activity',
    ]);
  });
});
