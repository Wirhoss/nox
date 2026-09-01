/**
 * Confinement probes.
 *
 * The extension isolation design rests on four measured claims about what the
 * shipping image can enforce: that Landlock is reachable unprivileged, that it
 * denies filesystem and TCP access, that a spawned child cannot escape it, and
 * that seccomp closes the UDP hole Landlock leaves open. Those measurements
 * were taken by hand once. A kernel upgrade, a new base image or a change to
 * Docker's seccomp profile can each falsify one of them silently, so they live
 * here as something runnable instead of only as prose in
 * `docs/extension-isolation.md`.
 *
 *     bun run probe:confinement
 *
 * Linux only, and only meaningful inside the container Nox actually ships in.
 * Every claim runs in its own child process, because both mechanisms are
 * one-way: once a process is confined it cannot measure the unconfined case
 * again.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { bindSetTool } from '@nox/extension-api';
import { dlopen, FFIType, ptr, read } from 'bun:ffi';

import { confinedExtension } from '../src/extensions/confined/confinedExtension';
import { ExtensionProcess } from '../src/extensions/confined/host';
import { RemoteToolSet } from '../src/extensions/confined/toolSet';
import {
  confinementSupport,
  denyInternetSockets,
  restrictSelf,
} from '../src/extensions/confinement';
import { createLogger } from '../src/logger/logger';

import type { Allowance } from '../src/extensions/confinement';
import type { PreparedToolCall } from '@nox/extension-api';

const projectRoot = resolve(import.meta.dir, '..');

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

interface Claim {
  readonly claim: string;
  readonly expected: string;
  readonly observed: string;
  readonly ok: boolean;
}

function claim(name: string, expected: string, observed: string): Claim {
  return { claim: name, expected, observed, ok: expected === observed };
}

// ---------------------------------------------------------------------------
// libc
// ---------------------------------------------------------------------------

function openLibc() {
  return dlopen('libc.so.6', {
    __errno_location: { args: [], returns: FFIType.ptr },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    connect: { args: [FFIType.i32, FFIType.i64_fast, FFIType.u32], returns: FFIType.i32 },
    sendto: {
      args: [
        FFIType.i32,
        FFIType.i64_fast,
        FFIType.i64_fast,
        FFIType.i32,
        FFIType.i64_fast,
        FFIType.u32,
      ],
      returns: FFIType.i64_fast,
    },
    socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
}

/**
 * Opened on first use, not at import: the dispatcher has to survive on a
 * developer machine long enough to say where these probes belong.
 */
let symbols: ReturnType<typeof openLibc>['symbols'] | undefined;
function libc(): ReturnType<typeof openLibc>['symbols'] {
  symbols ??= openLibc().symbols;
  return symbols;
}

function errno(): number {
  const location = libc().__errno_location();
  if (location === null) throw new Error('__errno_location() returned null.');
  return read.i32(location);
}

const ERRNO_NAMES = new Map<number, string>([
  [1, 'EPERM'],
  [13, 'EACCES'],
  [22, 'EINVAL'],
  [101, 'ENETUNREACH'],
  [111, 'ECONNREFUSED'],
]);

function errnoName(value: number): string {
  return ERRNO_NAMES.get(value) ?? `errno ${String(value)}`;
}

const AF_UNIX = 1;
const AF_INET = 2;
const AF_INET6 = 10;
const SOCK_STREAM = 1;
const SOCK_DGRAM = 2;
const SOCK_RAW = 3;

/**
 * What a real extension needs: the runtime's own directories readable and
 * executable, one storage directory writable, and nothing else. Deliberately
 * shaped like production rather than minimal, because the open question was
 * whether the runtime survives its own confinement.
 */
function realisticAllowances(storage: string): readonly Allowance[] {
  return [
    { path: '/usr', write: false },
    { path: '/lib', write: false },
    { path: '/lib64', write: false },
    { path: '/bin', write: false },
    { path: '/etc', write: false },
    { path: '/app', write: false },
    { path: '/proc', write: false },
    { path: '/sys', write: false },
    { path: projectRoot, write: false },
    { path: '/dev', write: true },
    { path: storage, write: true },
  ];
}

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------

function loopbackAddress(port: number): ArrayBuffer {
  const address = new ArrayBuffer(16);
  const view = new DataView(address);
  view.setUint16(0, AF_INET, true); // sin_family
  view.setUint16(2, port, false); // sin_port, network order
  view.setUint32(4, 0x7f000001, false); // 127.0.0.1
  return address;
}

/**
 * Bun's own `Bun.connect` reports ECONNREFUSED for a Landlock denial, so the
 * errno has to be read from a raw connect() to mean anything.
 */
function rawConnect(port: number): string {
  const fd = libc().socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return errnoName(errno());
  const address = loopbackAddress(port);
  const result = libc().connect(fd, ptr(address), address.byteLength);
  const outcome = result === 0 ? 'connected' : errnoName(errno());
  libc().close(fd);
  return outcome;
}

function rawUdpSend(port: number): string {
  const fd = libc().socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return errnoName(errno());
  const payload = new TextEncoder().encode('probe');
  const address = loopbackAddress(port);
  const sent = Number(
    libc().sendto(fd, ptr(payload), payload.byteLength, 0, ptr(address), address.byteLength),
  );
  const outcome = sent < 0 ? errnoName(errno()) : 'sent';
  libc().close(fd);
  return outcome;
}

/**
 * A connection through the runtime's own HTTP client, which is where an
 * extension's network access actually comes from.
 *
 * Reported as the raw outcome rather than as "it failed". A dead port answers
 * `ConnectionRefused` when a socket *was* created and the stack was consulted,
 * and `FailedToOpenSocket` when `socket()` itself was denied — and those two
 * are the entire difference between confined and not. Folding them together is
 * how a probe passes while enforcing nothing.
 */
async function attemptFetch(port: number): Promise<string> {
  try {
    await fetch(`http://127.0.0.1:${String(port)}/`, { signal: AbortSignal.timeout(2_000) });
    return 'connected';
  } catch (cause) {
    return errorCode(cause);
  }
}

function openSocket(family: number, type: number): string {
  const fd = libc().socket(family, type, 0);
  if (fd < 0) return errnoName(errno());
  libc().close(fd);
  return 'opened';
}

function errorCode(cause: unknown): string {
  const code: unknown = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : String(cause);
}

function attemptWrite(path: string): string {
  try {
    writeFileSync(path, 'probe');
    return 'allowed';
  } catch (cause) {
    return errorCode(cause);
  }
}

/**
 * The same attempt, dispatched to the runtime's thread pool.
 *
 * `landlock_restrict_self` restricts the calling thread, and the pool already
 * existed when it was called — so this is expected to be *allowed* in a process
 * that confined itself in place. It is the reason the extension child confines
 * and then re-executes, and it is measured here so nobody has to rediscover it.
 */
async function attemptWriteAsync(path: string): Promise<string> {
  try {
    await writeFile(path, 'probe');
    return 'allowed';
  } catch (cause) {
    return errorCode(cause);
  }
}

function attemptRead(path: string): string {
  try {
    readFileSync(path);
    return 'allowed';
  } catch (cause) {
    return errorCode(cause);
  }
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/** A port nothing listens on, so the unconfined answer is ECONNREFUSED. */
const DEAD_PORT = 9;

function stageAvailability(): Claim[] {
  // Deliberately the host's own detection rather than a second opinion: this
  // stage measures the function the loader will refuse extensions on the
  // strength of, so a detector that disagreed with the kernel would fail here.
  const detected = confinementSupport();
  const status = readFileSync('/proc/self/status', 'utf8');
  const capabilities = /^CapEff:\s*(\S+)$/m.exec(status)?.[1] ?? 'unknown';
  return [
    claim(
      'The host detects confinement as available',
      'available',
      detected.available ? 'available' : detected.missing.join(', and '),
    ),
    claim(
      'Landlock is reachable unprivileged',
      'ABI >= 4',
      detected.landlockAbi >= 4 ? 'ABI >= 4' : `ABI ${String(detected.landlockAbi)}`,
    ),
    claim('Filter-mode seccomp is compiled in', 'yes', detected.seccompFilter ? 'yes' : 'no'),
    claim(
      '...and with no effective capabilities',
      'none',
      /^0+$/.test(capabilities) ? 'none' : capabilities,
    ),
    {
      claim: `Landlock ABI is ${String(detected.landlockAbi)}`,
      expected: '-',
      observed: '-',
      ok: true,
    },
  ];
}

async function stageFilesystem(storage: string, sandbox: string): Promise<Claim[]> {
  const outside = join(sandbox, 'outside.txt');
  const secret = join(sandbox, '.secret-key');
  writeFileSync(secret, 'not-a-real-key');

  const before = [
    claim('Write outside the storage directory, unconfined', 'allowed', attemptWrite(outside)),
    claim('Read a key file outside it, unconfined', 'allowed', attemptRead(secret)),
  ];

  restrictSelf({ allowances: realisticAllowances(storage) });

  const after = [
    claim('Write inside the storage directory', 'allowed', attemptWrite(join(storage, 'ok.txt'))),
    claim('Write outside it', 'EACCES', attemptWrite(outside)),
    claim('Read a key file outside it', 'EACCES', attemptRead(secret)),
    // Not a pass: a hole, recorded where it was found. A ruleset applied in
    // place binds to one thread, and the runtime's pool is older than the
    // call. The transport stage is where the same attempt is expected to fail.
    claim(
      'Write outside it, on the thread pool',
      'allowed',
      await attemptWriteAsync(`${outside}.async`),
    ),
  ];

  // The runtime has to survive its own confinement, native modules included.
  let nativeImport: string;
  try {
    await import('sharp');
    nativeImport = 'imported';
  } catch (cause) {
    nativeImport = errorCode(cause);
  }
  after.push(claim('Import a module that dlopens a native binary', 'imported', nativeImport));

  return [...before, ...after];
}

function stageNetwork(storage: string): Claim[] {
  const before = [
    claim('Connect to a dead port, unconfined', 'ECONNREFUSED', rawConnect(DEAD_PORT)),
  ];

  restrictSelf({ allowances: realisticAllowances(storage), restrictTcp: true });

  return [
    ...before,
    // EACCES on a port with no listener is the row that settles it: the denial
    // arrives before the network stack is consulted.
    claim('Connect to a dead port, under Landlock alone', 'EACCES', rawConnect(DEAD_PORT)),
    // Landlock's network rules are TCP only, so this row records a hole rather
    // than a pass. It is why seccomp exists in the design at all, and the
    // combined stage is where the same attempt is expected to fail.
    claim('Send a UDP packet, under Landlock alone', 'sent', rawUdpSend(DEAD_PORT)),
  ];
}

async function stageSeccomp(): Promise<Claim[]> {
  const before = [
    // Also the warm-up that makes the last row of this stage mean something:
    // the runtime creates its HTTP thread on first use, so this is what puts
    // that thread on the older side of the filter installed below.
    claim('fetch to a dead port, unfiltered', 'ConnectionRefused', await attemptFetch(DEAD_PORT)),
    claim('TCP socket, unfiltered', 'opened', openSocket(AF_INET, SOCK_STREAM)),
    claim('UDP socket, unfiltered', 'opened', openSocket(AF_INET, SOCK_DGRAM)),
    claim('UDP socket over IPv6, unfiltered', 'opened', openSocket(AF_INET6, SOCK_DGRAM)),
  ];

  denyInternetSockets();

  return [
    ...before,
    // The filter cuts at the address family, so the protocol underneath it does
    // not matter. That is the whole reason it closes the hole Landlock leaves:
    // UDP is denied by the same instruction that denies TCP.
    claim('TCP socket, filtered', 'EACCES', openSocket(AF_INET, SOCK_STREAM)),
    claim('UDP socket, filtered', 'EACCES', openSocket(AF_INET, SOCK_DGRAM)),
    claim('UDP socket over IPv6, filtered', 'EACCES', openSocket(AF_INET6, SOCK_DGRAM)),
    claim('Raw socket, filtered', 'EACCES', openSocket(AF_INET, SOCK_RAW)),
    // The channel back to the host has to survive, or the extension is mute.
    claim('AF_UNIX socket, filtered', 'opened', openSocket(AF_UNIX, SOCK_STREAM)),
    // A hole, recorded rather than passed — the twin of the thread-pool row in
    // the filesystem stage. A filter installed without SECCOMP_FILTER_FLAG_TSYNC
    // binds to the calling thread; threads created afterwards inherit it, and
    // threads that already existed do not. `ConnectionRefused` here means a
    // socket was created despite the rule three lines up, on the HTTP thread
    // the row at the top of this stage brought into being.
    //
    // Which half you get therefore depends on whether anything happened to use
    // the network earlier in the process's life. A security property that turns
    // on that is not one, and it is why the extension child execs.
    claim(
      'fetch, filtered, on a thread that already existed',
      'ConnectionRefused',
      await attemptFetch(DEAD_PORT),
    ),
  ];
}

/**
 * Both mechanisms at once, which is the only configuration an installed
 * extension ever actually runs under. The other stages measure one mechanism
 * each to show what it does and does not buy; this one is the end state, and
 * it is the stage that has to be right.
 */
function stageCombined(storage: string, sandbox: string): Claim[] {
  restrictSelf({ allowances: realisticAllowances(storage), restrictTcp: true });
  denyInternetSockets();

  return [
    claim('Connect to a dead port', 'EACCES', rawConnect(DEAD_PORT)),
    // The row that answers the obvious objection to the network stage: UDP is
    // open under Landlock alone, and closed here.
    claim('Send a UDP packet', 'EACCES', rawUdpSend(DEAD_PORT)),
    claim('Open a UDP socket over IPv6', 'EACCES', openSocket(AF_INET6, SOCK_DGRAM)),
    claim('Open the channel back to the host', 'opened', openSocket(AF_UNIX, SOCK_STREAM)),
    claim('Write inside the storage directory', 'allowed', attemptWrite(join(storage, 'both.txt'))),
    claim('Write outside it', 'EACCES', attemptWrite(join(sandbox, 'both-outside.txt'))),
  ];
}

/**
 * The loader's own path, on a kernel that can actually confine.
 *
 * Everything above measures a mechanism or a crossing. This measures the
 * product: an installed extension activated the way `discoverExtensions` does
 * it, contributing a configured tool set, whose tool answers from a process
 * that cannot read the database.
 */
async function stageInstalled(): Promise<Claim[]> {
  const logger = createLogger('probe', { level: 'error' });
  const registered: { id: string; point: string; value: unknown }[] = [];
  const disposals: (() => Promise<void> | void)[] = [];

  const extension = confinedExtension({
    entryPoint: join(projectRoot, 'src', 'extensions', 'confined', 'fixtures', 'parrot.ts'),
    logger,
    manifest: {
      engines: { extensionApi: '*', nox: '*' },
      id: 'test.parrot',
      main: 'parrot.ts',
      services: ['nox.logger'],
      version: '1.0.0',
    } as never,
  });

  await extension.activate({
    contributions: {
      register: (point: { id: string }, id: string, value: unknown) => {
        registered.push({ id, point: point.id, value });
        return { dispose: () => undefined };
      },
    },
    subscriptions: {
      add: (resource: { dispose: () => Promise<void> | void }) => {
        disposals.push(() => resource.dispose());
        return resource;
      },
    },
  } as never);

  try {
    const contribution = registered.find((entry) => entry.point === 'nox.toolsets');
    const factory = contribution?.value as {
      create(config: unknown): Promise<{
        prepare(name: string, params: unknown): Promise<PreparedToolCall>;
      }>;
    };
    const toolSet = await factory.create({ excitement: 1, type: 'parrot', word: 'confined' });
    const prepared = await toolSet.prepare('say', { times: 2 });
    const said =
      prepared.type === 'immediate'
        ? (await prepared.run({ abortSignal: new AbortController().signal }))
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('')
        : '';

    return [
      claim(
        'An installed extension activates confined',
        'nox.authorities,nox.toolsets',
        registered
          .map((entry) => entry.point)
          .sort()
          .join(','),
      ),
      claim('Its configured tool set answers', 'confined! confined!', said),
      // What this extension can and cannot reach is measured by the transport
      // stage, with a fixture written to try. Asking here would only have
      // measured this process, which is not confined.
    ];
  } finally {
    for (const dispose of disposals) await dispose();
    await extension.deactivate();
  }
}

/**
 * A tool set, used the way the kernel uses one, with its tools in a confined
 * process.
 *
 * The transport stage proves the boundary holds. This one proves the contract
 * still works through it — which is the other half of the claim, and the half
 * that would be quietly false if `prepare` or a deferred result stopped
 * crossing correctly.
 */
async function stageTools(storage: string): Promise<Claim[]> {
  const host = new ExtensionProcess({
    allowances: realisticAllowances(storage),
    extensionId: 'probe.greeter',
    logger: createLogger('probe', { level: 'error' }),
  });
  try {
    await host.load(join(projectRoot, 'src', 'extensions', 'confined', 'fixtures', 'greeter.ts'));
    await host.invoke('toolset.bind', 'greeter', 'toolSet');
    const toolSet = await RemoteToolSet.connect(host.scoped('greeter'));

    const bound = bindSetTool(toolSet, 'greet', 'greeter-1');
    const prepared = await bound.prepare({ name: 'ada' });
    const ran =
      prepared.type === 'immediate'
        ? await prepared.run({ abortSignal: new AbortController().signal })
        : [];
    const said = ran.map((part) => (part.type === 'text' ? part.text : '')).join('');

    return [
      claim(
        'The set names its tools from inside the child',
        'greet,ponder',
        Object.keys(toolSet.declarations).sort().join(','),
      ),
      claim(
        'A Zod schema arrives as JSON Schema',
        'object',
        String(toolSet.declarations.greet?.parameters.type),
      ),
      claim(
        'The gate subject is stamped on this side',
        'test.greeter.greet',
        String(prepared.gateSubject?.authority),
      ),
      claim('A tool call runs confined and answers', 'hello ada', said),
    ];
  } finally {
    await host.dispose();
  }
}

/**
 * The whole thing, end to end: a real extension body loaded into a real
 * confined child, over the real transport, trying the four things an escaping
 * package would actually try.
 *
 * The stages above measure mechanisms. This one measures the product — and it
 * is the only stage that would notice if the child confined itself correctly
 * and then loaded the extension anyway before doing so.
 */
async function stageTransport(storage: string, sandbox: string): Promise<Claim[]> {
  const secret = join(sandbox, '.secret-key');
  writeFileSync(secret, 'not-a-real-key');

  const host = new ExtensionProcess({
    allowances: realisticAllowances(storage),
    extensionId: 'probe.escapes',
    logger: createLogger('probe', { level: 'error' }),
  });
  try {
    await host.load(join(projectRoot, 'src', 'extensions', 'confined', 'fixtures', 'escapes.ts'));
    const call = async (method: string, ...params: readonly unknown[]): Promise<string> =>
      String(await host.invoke(method, ...params));

    return [
      // First, because a child that cannot answer would make every denial
      // below true for the wrong reason.
      claim(
        'A call reaches the confined extension and returns',
        'alive',
        await call('echo', 'alive'),
      ),
      claim(
        'It writes inside its storage directory',
        'allowed',
        await call('writePath', join(storage, 'from-extension.txt')),
      ),
      claim('It reads a key file outside it', 'EACCES', await call('readPath', secret)),
      claim('It reads a key file outside it (sync)', 'EACCES', await call('readPathSync', secret)),
      claim(
        'It writes outside it',
        'EACCES',
        await call('writePath', join(sandbox, 'from-extension.txt')),
      ),
      // The raw errno, not a collapsed "denied". A dead port answers
      // ConnectionRefused when a socket was created and the stack was
      // consulted — so anything that folded the two together would pass
      // whether or not the extension could reach the network at all.
      // The baseline the row below is read against: from a process that was
      // not confined, the same dead port answers ConnectionRefused.
      claim(
        'The same call, from this unconfined process',
        'ConnectionRefused',
        await attemptFetch(DEAD_PORT),
      ),
      // `FailedToOpenSocket` is `socket()` itself being denied — the filter
      // reached the thread the HTTP client runs on, which it only does because
      // the child re-executed after installing it.
      claim(
        'It opens a TCP connection',
        'FailedToOpenSocket',
        await call('reachTcp', `http://127.0.0.1:${String(DEAD_PORT)}/`),
      ),
      claim('It sends a UDP packet', 'EACCES', await call('sendUdp', DEAD_PORT)),
    ];
  } finally {
    await host.dispose();
  }
}

/**
 * Closes the hole the worker experiment opened: spawning a process is the
 * obvious escape from an in-process restriction, and it is not an escape here.
 */
function stageInheritance(storage: string, sandbox: string): Claim[] {
  restrictSelf({ allowances: realisticAllowances(storage) });
  const child = spawnSync(
    process.execPath,
    [
      'run',
      import.meta.path,
      '--stage',
      'inherited-child',
      '--storage',
      storage,
      '--sandbox',
      sandbox,
    ],
    { encoding: 'utf8' },
  );
  return parseClaims(child.stdout, child.stderr);
}

function stageInheritedChild(storage: string, sandbox: string): Claim[] {
  return [
    claim(
      'A child that applied no ruleset writes inside the storage directory',
      'allowed',
      attemptWrite(join(storage, 'child.txt')),
    ),
    claim(
      'The same child writes outside it',
      'EACCES',
      attemptWrite(join(sandbox, 'child-outside.txt')),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const STAGES = [
  'availability',
  'filesystem',
  'network',
  'seccomp',
  'combined',
  'inheritance',
  'transport',
  'tools',
  'installed',
] as const;
type Stage = (typeof STAGES)[number];

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function parseClaims(stdout: string, stderr: string): Claim[] {
  for (const line of stdout.split('\n').reverse()) {
    if (!line.startsWith('{')) continue;
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null && 'claims' in parsed) {
      return (parsed as { claims: Claim[] }).claims;
    }
  }
  const tail = stderr.trim().split('\n').slice(-3).join(' ');
  return [
    {
      claim: 'The stage produced no result',
      expected: 'claims',
      observed: tail.length === 0 ? 'no output' : tail,
      ok: false,
    },
  ];
}

function runStage(stage: Stage, storage: string, sandbox: string): Claim[] {
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      'run',
      import.meta.path,
      '--stage',
      stage,
      '--storage',
      storage,
      '--sandbox',
      sandbox,
    ],
  });
  return parseClaims(child.stdout.toString(), child.stderr.toString());
}

function report(stage: string, claims: readonly Claim[]): void {
  process.stdout.write(`\n${stage}\n`);
  const width = Math.max(...claims.map((entry) => entry.claim.length));
  for (const entry of claims) {
    const mark = entry.ok ? '  ok  ' : ' FAIL ';
    const detail =
      entry.expected === entry.observed
        ? entry.observed
        : `${entry.observed} (expected ${entry.expected})`;
    process.stdout.write(`${mark}${entry.claim.padEnd(width)}  ${detail}\n`);
  }
}

async function runRequestedStage(stage: string): Promise<Claim[]> {
  const storage = argument('storage') ?? '';
  const sandbox = argument('sandbox') ?? '';
  switch (stage) {
    case 'availability':
      return stageAvailability();
    case 'combined':
      return stageCombined(storage, sandbox);
    case 'filesystem':
      return await stageFilesystem(storage, sandbox);
    case 'inheritance':
      return stageInheritance(storage, sandbox);
    case 'inherited-child':
      return stageInheritedChild(storage, sandbox);
    case 'network':
      return stageNetwork(storage);
    case 'seccomp':
      return await stageSeccomp();
    case 'installed':
      return await stageInstalled();
    case 'tools':
      return await stageTools(storage);
    case 'transport':
      return await stageTransport(storage, sandbox);
    default:
      throw new Error(`Unknown stage "${stage}".`);
  }
}

async function main(): Promise<void> {
  const stage = argument('stage');
  if (stage !== undefined) {
    const claims = await runRequestedStage(stage);
    process.stdout.write(`${JSON.stringify({ claims })}\n`);
    return;
  }

  if (process.platform !== 'linux') {
    process.stderr.write(
      'These probes measure Linux kernel confinement, and Nox is only planned as a\n' +
        'container, so run them inside the image. It carries the built runtime\n' +
        'rather than the repository, so mount this directory in:\n\n' +
        '  docker run --rm --entrypoint bun \\\n' +
        '    -v "$PWD/scripts:/repo/scripts:ro" -v "$PWD/src:/repo/src:ro" \\\n' +
        '    -v "$PWD/packages/extension-api/dist:/app/node_modules/@nox/extension-api/dist:ro" \\\n' +
        '    -w /app \\\n' +
        '    nox:local run /repo/scripts/probe-confinement.ts\n',
    );
    process.exitCode = 1;
    return;
  }

  let failures = 0;
  for (const name of STAGES) {
    const sandbox = mkdtempSync(join(tmpdir(), 'nox-probe-'));
    const storage = join(sandbox, 'storage');
    mkdirSync(storage);
    try {
      const claims = runStage(name, storage, sandbox);
      report(name, claims);
      failures += claims.filter((entry) => !entry.ok).length;
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  }

  process.stdout.write(
    failures === 0
      ? '\nEvery confinement claim in docs/extension-isolation.md still holds.\n'
      : `\n${String(failures)} claim(s) no longer hold — docs/extension-isolation.md is now wrong.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
