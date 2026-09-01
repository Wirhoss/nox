import { closeSync, openSync, readFileSync } from 'node:fs';

import { dlopen, FFIType, ptr, read } from 'bun:ffi';

/**
 * The two kernel mechanisms an installed extension is confined with, and the
 * question of whether this installation has them.
 *
 * Landlock restricts the filesystem; an unprivileged seccomp filter closes the
 * sockets Landlock cannot address. Both are applied by a process to itself,
 * both are irreversible, and both are inherited by anything that process
 * spawns — which is the property that makes them a boundary rather than a
 * suggestion. See `docs/extension-isolation.md`, whose every claim is
 * re-measured by `scripts/probe-confinement.ts` against this module.
 */

// ---------------------------------------------------------------------------
// libc
// ---------------------------------------------------------------------------

function openLibc() {
  return dlopen('libc.so.6', {
    __errno_location: { args: [], returns: FFIType.ptr },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    execv: { args: [FFIType.i64_fast, FFIType.i64_fast], returns: FFIType.i32 },
    prctl: {
      args: [FFIType.i32, FFIType.i64_fast, FFIType.i64_fast, FFIType.i64_fast, FFIType.i64_fast],
      returns: FFIType.i32,
    },
    syscall: {
      args: [
        FFIType.i64_fast,
        FFIType.i64_fast,
        FFIType.i64_fast,
        FFIType.i64_fast,
        FFIType.i64_fast,
      ],
      returns: FFIType.i64_fast,
    },
  });
}

// Opened on first use rather than at import, so a developer machine that has no
// `libc.so.6` can still load this module to be told that it has no confinement.
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

// ---------------------------------------------------------------------------
// Landlock
// ---------------------------------------------------------------------------

// Identical on x86_64 and aarch64 — these landed in the generic syscall table.
const SYS_LANDLOCK_CREATE_RULESET = 444;
const SYS_LANDLOCK_ADD_RULE = 445;
const SYS_LANDLOCK_RESTRICT_SELF = 446;

const LANDLOCK_CREATE_RULESET_VERSION = 1;
const LANDLOCK_RULE_PATH_BENEATH = 1;

const FS_EXECUTE = 1n << 0n;
const FS_READ_FILE = 1n << 2n;
const FS_READ_DIR = 1n << 3n;
const NET_CONNECT_TCP = 1n << 1n;

const PR_SET_NO_NEW_PRIVS = 38;
const PR_SET_SECCOMP = 22;
const SECCOMP_MODE_FILTER = 2;

/** The ABI this kernel implements, or a negative number if it has no Landlock. */
function landlockAbi(): number {
  return Number(
    libc().syscall(SYS_LANDLOCK_CREATE_RULESET, 0, 0, LANDLOCK_CREATE_RULESET_VERSION, 0),
  );
}

/**
 * Every filesystem right the running kernel knows about.
 *
 * A right the ruleset does not *handle* is a right it does not restrict, so
 * this mask is what makes a ruleset mean "deny unless allowed below" rather
 * than "deny the handful of things I remembered to name". Naming a right the
 * kernel does not have is rejected outright, which is why it is derived from
 * the ABI instead of written out as a constant.
 */
function handledFilesystemAccess(abi: number): bigint {
  let bits = 13; // ABI 1: EXECUTE through MAKE_SYM.
  if (abi >= 2) bits = 14; // + REFER
  if (abi >= 3) bits = 15; // + TRUNCATE
  if (abi >= 5) bits = 16; // + IOCTL_DEV
  return (1n << BigInt(bits)) - 1n;
}

interface Allowance {
  readonly path: string;
  readonly write: boolean;
}

interface RestrictOptions {
  /** Directories the process keeps, and whether it keeps them writable. */
  readonly allowances: readonly Allowance[];
  /**
   * Handle TCP connect as well, denying every port. Landlock's network rules
   * address ports rather than destinations, so this is only ever used to deny
   * outright — the reachable destinations are the host's to decide, over the
   * channel the extension already has.
   */
  readonly restrictTcp?: boolean;
}

/**
 * Applies a Landlock ruleset. Irreversible, inherited by children, and
 * impossible to relax from inside — which is the whole point, and also why the
 * caller must be the process being confined.
 *
 * It restricts the calling **thread**, not the process, and threads that
 * already exist are left with no domain. In a runtime that has a thread pool —
 * which is every runtime — calling this alone denies synchronous filesystem
 * access and allows every asynchronous one. Anything that means to be confined
 * must call {@link execSelf} straight afterwards. This was measured, not
 * assumed; see the `filesystem` and `transport` stages of the probe.
 */
function restrictSelf(options: RestrictOptions): void {
  const abi = landlockAbi();
  if (abi < 1) throw new Error('This kernel has no Landlock.');
  const handledFs = handledFilesystemAccess(abi);
  const readOnly = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR;
  const restrictTcp = options.restrictTcp === true;

  // struct landlock_ruleset_attr grew a network field in ABI 4. Passing the
  // size this kernel knows about is what keeps one caller working across both.
  const attr = new ArrayBuffer(abi >= 4 ? 16 : 8);
  const attrView = new DataView(attr);
  attrView.setBigUint64(0, handledFs, true);
  if (abi >= 4) attrView.setBigUint64(8, restrictTcp ? NET_CONNECT_TCP : 0n, true);
  if (restrictTcp && abi < 4) {
    throw new Error(`Landlock ABI ${String(abi)} cannot restrict TCP; ABI 4 or later is required.`);
  }

  const rulesetFd = Number(
    libc().syscall(SYS_LANDLOCK_CREATE_RULESET, ptr(attr), attr.byteLength, 0, 0),
  );
  if (rulesetFd < 0)
    throw new Error(`landlock_create_ruleset failed with errno ${String(errno())}.`);

  for (const allowance of options.allowances) {
    let parentFd: number;
    try {
      parentFd = openSync(allowance.path, 'r');
    } catch {
      continue; // A directory this image does not have is nothing to allow.
    }
    // struct landlock_path_beneath_attr is packed: u64 then s32.
    const rule = new ArrayBuffer(12);
    const ruleView = new DataView(rule);
    ruleView.setBigUint64(0, allowance.write ? handledFs : readOnly, true);
    ruleView.setInt32(8, parentFd, true);
    const added = Number(
      libc().syscall(SYS_LANDLOCK_ADD_RULE, rulesetFd, LANDLOCK_RULE_PATH_BENEATH, ptr(rule), 0),
    );
    closeSync(parentFd);
    if (added !== 0) {
      throw new Error(`landlock_add_rule(${allowance.path}) failed with errno ${String(errno())}.`);
    }
  }

  if (libc().prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) !== 0) {
    throw new Error('prctl(PR_SET_NO_NEW_PRIVS) failed.');
  }
  if (Number(libc().syscall(SYS_LANDLOCK_RESTRICT_SELF, rulesetFd, 0, 0, 0)) !== 0) {
    throw new Error(`landlock_restrict_self failed with errno ${String(errno())}.`);
  }
  libc().close(rulesetFd);
}

// ---------------------------------------------------------------------------
// seccomp
// ---------------------------------------------------------------------------

const AF_INET = 2;
const AF_INET6 = 10;

const SECCOMP_RET_ERRNO_EACCES = 0x0005000d;
const SECCOMP_RET_ALLOW = 0x7fff0000;

const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_JA = 0x05;
const BPF_RET_K = 0x06;

interface ArchFacts {
  readonly auditArch: number;
  readonly socketNr: number;
}

function archFacts(): ArchFacts {
  if (process.arch === 'x64') return { auditArch: 0xc000003e, socketNr: 41 };
  if (process.arch === 'arm64') return { auditArch: 0xc00000b7, socketNr: 198 };
  throw new Error(`No syscall numbers are recorded for ${process.arch}.`);
}

/**
 * A classic-BPF program that denies `socket()` for AF_INET and AF_INET6 and
 * allows everything else.
 *
 * It cuts at the address family rather than the protocol, which is what closes
 * the hole Landlock leaves: the instruction that denies a TCP socket denies a
 * UDP one and a raw one with it. AF_UNIX is untouched, because the extension's
 * channel back to the host runs over it and an extension that cannot answer is
 * not confined, it is broken.
 *
 * Returned as data rather than applied, so it can be read and executed by a
 * test on any platform. A wrong jump offset here would silently allow.
 */
function seccompProgram(): readonly (readonly [number, number, number, number])[] {
  const { auditArch, socketNr } = archFacts();
  // seccomp_data: u32 nr, u32 arch, u64 instruction_pointer, u64 args[6].
  return [
    [BPF_LD_W_ABS, 0, 0, 4], // 0: A = arch
    [BPF_JEQ_K, 0, 6, auditArch], // 1: another ABI reaching the same syscall -> deny
    [BPF_LD_W_ABS, 0, 0, 0], // 2: A = nr
    [BPF_JEQ_K, 0, 5, socketNr], // 3: not socket() -> allow
    [BPF_LD_W_ABS, 0, 0, 16], // 4: A = args[0], the address family
    [BPF_JEQ_K, 2, 0, AF_INET], // 5: -> deny
    [BPF_JEQ_K, 1, 0, AF_INET6], // 6: -> deny
    [BPF_JA, 0, 0, 1], // 7: -> allow
    [BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EACCES], // 8: deny
    [BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW], // 9: allow
  ];
}

/**
 * Installs {@link seccompProgram} on this process. Unprivileged, because
 * PR_SET_NO_NEW_PRIVS is set first. Irreversible, and inherited by children.
 */
function denyInternetSockets(): void {
  const program = seccompProgram();
  const filter = new ArrayBuffer(program.length * 8);
  const filterView = new DataView(filter);
  program.forEach(([code, jt, jf, k], index) => {
    filterView.setUint16(index * 8, code, true);
    filterView.setUint8(index * 8 + 2, jt);
    filterView.setUint8(index * 8 + 3, jf);
    filterView.setUint32(index * 8 + 4, k, true);
  });

  const prog = new ArrayBuffer(16); // struct sock_fprog { u16 len; void *filter; }
  const progView = new DataView(prog);
  progView.setUint16(0, program.length, true);
  progView.setBigUint64(8, BigInt(ptr(filter)), true);

  if (libc().prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) !== 0) {
    throw new Error('prctl(PR_SET_NO_NEW_PRIVS) failed.');
  }
  if (libc().prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ptr(prog), 0, 0) !== 0) {
    throw new Error(`prctl(PR_SET_SECCOMP) failed with errno ${String(errno())}.`);
  }
}

// ---------------------------------------------------------------------------
// Becoming the confined process
// ---------------------------------------------------------------------------

function cString(value: string): Uint8Array {
  return new TextEncoder().encode(`${value} `);
}

/**
 * Replaces this process image with a fresh one, keeping the confinement.
 *
 * This is not an optimisation, it is the correctness of the whole thing, and
 * it was measured. `landlock_restrict_self` restricts the calling **thread**;
 * threads that already exist keep no domain at all. A runtime has a thread
 * pool long before any of this code runs, and `node:fs/promises` dispatches to
 * it — so a child that only called the syscalls would deny synchronous file
 * access and quietly allow every asynchronous one, which is the kind an
 * extension actually writes.
 *
 * After `execve` the image has exactly one thread, the Landlock domain and the
 * seccomp filter both survive into it, and every thread the new runtime spawns
 * inherits them. So: confine, then become.
 */
function execSelf(args: readonly string[]): never {
  const path = cString('/proc/self/exe');
  const encoded = args.map((argument) => cString(argument));
  const argv = new BigUint64Array(encoded.length + 1);
  encoded.forEach((buffer, index) => {
    argv[index] = BigInt(ptr(buffer));
  });
  argv[encoded.length] = 0n;

  libc().execv(ptr(path), ptr(argv));
  // execv only returns when it failed; there is no success path to fall into.
  throw new Error(`execv failed with errno ${String(errno())}.`);
}

// ---------------------------------------------------------------------------
// Whether this installation has any of it
// ---------------------------------------------------------------------------

/**
 * Where the kernel says filter-mode seccomp exists.
 *
 * Read rather than tried, because trying is irreversible: a host process that
 * probed seccomp by installing a filter would confine itself to find out.
 * This file is present exactly when the kernel was built with the filter, and
 * absent otherwise.
 */
const SECCOMP_ACTIONS = '/proc/sys/kernel/seccomp/actions_avail';

interface ConfinementSupport {
  /** The Landlock ABI, or a negative number where there is none. */
  readonly landlockAbi: number;
  readonly seccompFilter: boolean;
  /** Both mechanisms are present, at versions that can enforce the design. */
  readonly available: boolean;
  /** What is missing, in the words an operator would want to read. */
  readonly missing: readonly string[];
}

function detectConfinement(): ConfinementSupport {
  if (process.platform !== 'linux') {
    return Object.freeze({
      available: false,
      landlockAbi: -1,
      missing: Object.freeze([
        `Landlock and seccomp are Linux kernel features and this is ${process.platform}`,
      ]),
      seccompFilter: false,
    });
  }

  let abi: number;
  try {
    abi = landlockAbi();
  } catch {
    abi = -1; // No libc, no FFI, no answer — which is itself the answer.
  }

  let seccompFilter: boolean;
  try {
    // The design needs SECCOMP_RET_ERRNO specifically — it denies sockets by
    // returning EACCES rather than by killing the process — so that is the
    // action looked for rather than the file's mere existence.
    seccompFilter = readFileSync(SECCOMP_ACTIONS, 'utf8').split(/\s+/).includes('errno');
  } catch {
    seccompFilter = false;
  }

  const missing: string[] = [];
  // ABI 4 is the floor: earlier versions restrict the filesystem but cannot
  // handle TCP at all, and the design denies TCP in the kernel.
  if (abi < 4) {
    missing.push(
      abi < 1
        ? 'this kernel has no Landlock'
        : `this kernel has Landlock ABI ${String(abi)} and ABI 4 or later is required`,
    );
  }
  if (!seccompFilter) missing.push('this kernel has no filter-mode seccomp');

  return Object.freeze({
    available: missing.length === 0,
    landlockAbi: abi,
    missing: Object.freeze(missing),
    seccompFilter,
  });
}

/**
 * Resolved once. The kernel cannot change while the process runs, and two
 * extensions checked against different answers would make load order matter —
 * the same reason host package versions are resolved once.
 */
let support: ConfinementSupport | undefined;
function confinementSupport(): ConfinementSupport {
  support ??= detectConfinement();
  return support;
}

/**
 * Why an installed extension cannot be confined here, or undefined when it can.
 *
 * Phrased as a single sentence a person can act on, because the two things an
 * operator can do about it — upgrade the kernel, or decide deliberately to run
 * without confinement — both depend on knowing which half is missing.
 */
function unconfinableReason(): string | undefined {
  const detected = confinementSupport();
  if (detected.available) return undefined;
  return `Extensions cannot be confined here: ${detected.missing.join(', and ')}.`;
}

export {
  confinementSupport,
  denyInternetSockets,
  execSelf,
  handledFilesystemAccess,
  landlockAbi,
  restrictSelf,
  seccompProgram,
  unconfinableReason,
};
export type { Allowance, ConfinementSupport, RestrictOptions };
