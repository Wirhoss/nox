import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { Database } from '../../database/database';
import { SessionStore } from '../../database/sessionStore';
import { silentLogger } from '../../logger/logger';
import { RegistrationWindow } from '../auth/registration';
import { AuthStore } from '../auth/store';
import { ApiServer } from '../server';

const databases: Database[] = [];
const directories: string[] = [];
const servers: ApiServer[] = [];
const PASSWORD = 'correct-horse-battery';

interface SessionNox {
  readonly headers: Record<string, string>;
  readonly url: string;
}

async function sessionNox(): Promise<SessionNox> {
  const directory = await mkdtemp(join(tmpdir(), 'nox-sessions-'));
  directories.push(directory);
  const database = await Database.open({ logger: silentLogger, path: join(directory, 'nox.db') });
  databases.push(database);

  const auth = await AuthStore.open({ database, dataDirectory: directory, logger: silentLogger });
  const account = await auth.register('esteban', PASSWORD);
  const tokens = await auth.openSession(account.accountId);
  const sessions = new SessionStore(database, { logger: silentLogger });
  await sessions.create('session-1', { agentId: 'operator', title: 'Inspect the machine' });
  await sessions.create('session-2', { agentId: 'operator', title: 'Quiet conversation' });

  sessions.append('session-1', {
    content: [{ text: 'Submit it.', type: 'text' }],
    createdAt: new Date('2026-08-27T13:59:00.000Z'),
    messageId: 'message-1',
    origin: {
      principal: { issuer: 'web', subject: account.accountId },
      transportMessageId: 'transport-1',
    },
    role: 'user',
  });
  sessions.recordAuthorizationDecision({
    authority: 'nox.toolset.web.browser.act',
    createdAt: new Date('2026-08-27T14:00:00.000Z'),
    decidedBy: 'owner-grants',
    decisionId: 'authorization-1',
    matchedGrant: 'nox.toolset.web.*',
    params: { selector: '#submit' },
    principal: { issuer: 'web', subject: account.accountId },
    reason: 'The installation owner holds this authority.',
    runId: 'run-1',
    sessionId: 'session-1',
    toolName: 'browser_click',
    toolSetId: 'internet',
    trackId: 'track-1',
    verdict: 'allow',
  });
  sessions.recordGateDecision({
    authority: 'nox.toolset.web.browser.act',
    createdAt: new Date('2026-08-27T14:00:01.000Z'),
    decidedBy: 'risk-gate',
    decisionId: 'gate-1',
    params: { selector: '#submit' },
    preview: 'Submit the remote form',
    reason: 'The call performs an irreversible network write.',
    risk: {
      effects: ['network', 'write'],
      resources: [{ kind: 'url', value: 'https://example.test/form' }],
      reversible: false,
    },
    runAuthority: {
      principal: { issuer: 'web', subject: account.accountId },
      source: { messageId: 'message-1', type: 'message' },
    },
    runId: 'run-1',
    sessionId: 'session-1',
    signals: [
      {
        code: 'network-write',
        reason: 'Submitting the form changes remote state.',
        resource: 'https://example.test/form',
        severity: 'approval',
      },
    ],
    title: 'Submit form',
    toolName: 'browser_click',
    toolSetId: 'internet',
    trackId: 'track-1',
    verdict: 'escalate',
  });
  sessions.append('session-1', {
    createdAt: new Date('2026-08-27T14:00:02.000Z'),
    execution: 'permissionPending',
    isError: false,
    messageId: 'permission-1',
    name: 'browser_click',
    response: [{ text: 'Awaiting approval.', type: 'text' }],
    role: 'toolResponse',
    trackId: 'track-1',
    trust: 'trusted',
  });
  sessions.resolveGateDecision(
    'session-1',
    'gate-1',
    { resolution: 'approved', scope: 'once' },
    new Date('2026-08-27T14:00:05.000Z'),
    { issuer: 'web', subject: account.accountId },
  );
  sessions.append('session-1', {
    createdAt: new Date('2026-08-27T14:00:07.000Z'),
    execution: 'immediate',
    isError: false,
    messageId: 'response-1',
    name: 'browser_click',
    response: [
      { text: 'Form submitted.', type: 'text' },
      {
        artifact: {
          artifactId: 'artifact-1',
          filename: 'receipt.json',
          mediaType: 'application/json',
          size: 42,
        },
        type: 'artifact',
      },
    ],
    role: 'toolResponse',
    trackId: 'track-1',
    trust: 'untrusted',
  });
  await sessions.flushed;

  const server = ApiServer.create({
    auth: { registration: RegistrationWindow.closed(), store: auth },
    host: '127.0.0.1',
    logger: silentLogger,
    port: 0,
    sessions,
  });
  await server.listen();
  servers.push(server);

  return {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
    url: `${server.url}/api`,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    }),
  );
});

describe('the session routes', () => {
  test('require the installation owner for every historical projection', async () => {
    const { url } = await sessionNox();

    expect((await fetch(`${url}/sessions/agents`)).status).toBe(401);
    expect((await fetch(`${url}/sessions?agentId=operator`)).status).toBe(401);
    expect((await fetch(`${url}/sessions/session-1/transcript`)).status).toBe(401);
    expect((await fetch(`${url}/sessions/session-1/audit`)).status).toBe(401);
  });

  test('navigates agent to session without hiding sessions that have no audit', async () => {
    const { headers, url } = await sessionNox();

    const agents = await fetch(`${url}/sessions/agents`, { headers });
    expect(agents.status).toBe(200);
    expect(await agents.json()).toEqual({
      agents: [
        expect.objectContaining({
          agentId: 'operator',
          sessionCount: 2,
        }),
      ],
    });

    const page = await fetch(`${url}/sessions?agentId=operator`, { headers });
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      entries: [
        { agentId: 'operator', sessionId: 'session-1', title: 'Inspect the machine' },
        { agentId: 'operator', sessionId: 'session-2', title: 'Quiet conversation' },
      ],
      total: 2,
    });
  });

  test('opens one session transcript and groups its decision pipeline into one action', async () => {
    const { headers, url } = await sessionNox();

    const transcript = await fetch(`${url}/sessions/session-1/transcript`, { headers });
    expect(transcript.status).toBe(200);
    expect(await transcript.json()).toMatchObject({
      entries: [
        { messageId: 'message-1', role: 'user' },
        { messageId: 'permission-1', role: 'toolResponse' },
        { messageId: 'response-1', role: 'toolResponse' },
      ],
      session: { agentId: 'operator', sessionId: 'session-1', title: 'Inspect the machine' },
      total: 3,
    });

    const audit = await fetch(`${url}/sessions/session-1/audit`, { headers });
    expect(audit.status).toBe(200);
    expect(await audit.json()).toMatchObject({
      entries: [
        {
          decisions: [
            { decisionId: 'authorization-1', stage: 'authorization', verdict: 'allow' },
            {
              decisionId: 'gate-1',
              resolution: 'approved',
              scope: 'once',
              stage: 'gate',
              verdict: 'escalate',
            },
          ],
          responses: [
            {
              content: [{ text: 'Awaiting approval.', type: 'text' }],
              execution: 'permissionPending',
              isError: false,
              trust: 'trusted',
            },
            {
              content: [
                { text: 'Form submitted.', type: 'text' },
                {
                  artifact: {
                    artifactId: 'artifact-1',
                    filename: 'receipt.json',
                    mediaType: 'application/json',
                    size: 42,
                  },
                  type: 'artifact',
                },
              ],
              execution: 'immediate',
              isError: false,
              trust: 'untrusted',
            },
          ],
          sessionId: 'session-1',
          title: 'Submit form',
          trackId: 'track-1',
        },
      ],
      total: 1,
    });

    expect((await fetch(`${url}/audit/decisions`, { headers })).status).toBe(404);
  });
});
