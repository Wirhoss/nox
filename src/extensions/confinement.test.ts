import { describe, expect, test } from 'bun:test';

import {
  confinementSupport,
  handledFilesystemAccess,
  seccompProgram,
  unconfinableReason,
} from './confinement';

const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO_EACCES = 0x0005000d;

const AUDIT_ARCH = { arm64: 0xc00000b7, x64: 0xc000003e } as const;
const SOCKET_NR = { arm64: 198, x64: 41 } as const;

const AF_UNIX = 1;
const AF_INET = 2;
const AF_INET6 = 10;
const SOCK_STREAM = 1;
const SOCK_DGRAM = 2;
const SOCK_RAW = 3;

interface SyscallAttempt {
  readonly arch?: number;
  readonly args?: readonly number[];
  readonly nr: number;
}

/**
 * Runs the seccomp filter the way the kernel would.
 *
 * The filter is the only thing standing between an extension and a UDP socket,
 * and it is eight jump offsets in a row: getting one wrong silently allows
 * rather than failing. The probe script proves it on a real kernel, but only
 * inside the image and only where Landlock exists too. This runs the same
 * program anywhere, so the claim survives on a machine that cannot enforce it.
 *
 * Supports exactly the four opcodes the program uses.
 */
function evaluate(
  program: readonly (readonly [number, number, number, number])[],
  attempt: SyscallAttempt,
): number {
  // seccomp_data: u32 nr, u32 arch, u64 instruction_pointer, u64 args[6].
  const data = new DataView(new ArrayBuffer(64));
  data.setUint32(0, attempt.nr, true);
  data.setUint32(4, attempt.arch ?? AUDIT_ARCH[process.arch === 'arm64' ? 'arm64' : 'x64'], true);
  (attempt.args ?? []).forEach((value, index) => {
    data.setUint32(16 + index * 8, value, true);
  });

  let accumulator = 0;
  for (let counter = 0; counter < program.length; counter += 1) {
    const step = program[counter];
    if (step === undefined) throw new Error('The program ran off its end.');
    const [code, jt, jf, k] = step;
    switch (code) {
      case 0x05: // BPF_JMP | BPF_JA
        counter += k;
        break;
      case 0x06: // BPF_RET | BPF_K
        return k;
      case 0x15: // BPF_JMP | BPF_JEQ | BPF_K
        counter += accumulator === k ? jt : jf;
        break;
      case 0x20: // BPF_LD | BPF_W | BPF_ABS
        accumulator = data.getUint32(k, true);
        break;
      default:
        throw new Error(`The interpreter does not implement opcode ${String(code)}.`);
    }
  }
  throw new Error('The program ended without returning.');
}

const socketNr = SOCKET_NR[process.arch === 'arm64' ? 'arm64' : 'x64'];

function attemptSocket(family: number, type: number): number {
  return evaluate(seccompProgram(), { args: [family, type, 0], nr: socketNr });
}

describe('seccompProgram', () => {
  test('denies every internet socket regardless of protocol', () => {
    // The point of filtering on the address family: one rule, and the protocol
    // underneath it cannot get around it. Landlock's network rules are TCP
    // only, so UDP is exactly the case this has to cover.
    expect(attemptSocket(AF_INET, SOCK_STREAM)).toBe(SECCOMP_RET_ERRNO_EACCES);
    expect(attemptSocket(AF_INET, SOCK_DGRAM)).toBe(SECCOMP_RET_ERRNO_EACCES);
    expect(attemptSocket(AF_INET, SOCK_RAW)).toBe(SECCOMP_RET_ERRNO_EACCES);
    expect(attemptSocket(AF_INET6, SOCK_STREAM)).toBe(SECCOMP_RET_ERRNO_EACCES);
    expect(attemptSocket(AF_INET6, SOCK_DGRAM)).toBe(SECCOMP_RET_ERRNO_EACCES);
    expect(attemptSocket(AF_INET6, SOCK_RAW)).toBe(SECCOMP_RET_ERRNO_EACCES);
  });

  test('leaves the channel back to the host open', () => {
    // An extension that cannot answer the host is not confined, it is broken.
    expect(attemptSocket(AF_UNIX, SOCK_STREAM)).toBe(SECCOMP_RET_ALLOW);
    expect(attemptSocket(AF_UNIX, SOCK_DGRAM)).toBe(SECCOMP_RET_ALLOW);
  });

  test('allows every syscall that is not socket()', () => {
    // A filter that denied more than it meant to would be discovered as a
    // runtime that cannot start, which is a worse way to find out.
    for (const nr of [0, 1, 60, socketNr + 1, socketNr - 1]) {
      expect(evaluate(seccompProgram(), { args: [AF_INET, SOCK_DGRAM, 0], nr })).toBe(
        SECCOMP_RET_ALLOW,
      );
    }
  });

  test('denies a socket reached through another ABI', () => {
    // The same syscall number means something else under a different audit
    // arch, so a filter that did not check it could be walked around.
    expect(
      evaluate(seccompProgram(), {
        arch: 0x40000028, // AUDIT_ARCH_ARM, not this process's
        args: [AF_INET, SOCK_DGRAM, 0],
        nr: socketNr,
      }),
    ).toBe(SECCOMP_RET_ERRNO_EACCES);
  });
});

describe('handledFilesystemAccess', () => {
  test('grows with the ABI and never names a right the kernel lacks', () => {
    // Handling a right this kernel does not have is rejected outright, so the
    // mask has to be derived rather than written down once.
    expect(handledFilesystemAccess(1)).toBe(0x1fffn);
    expect(handledFilesystemAccess(2)).toBe(0x3fffn); // + REFER
    expect(handledFilesystemAccess(3)).toBe(0x7fffn); // + TRUNCATE
    expect(handledFilesystemAccess(4)).toBe(0x7fffn); // network only
    expect(handledFilesystemAccess(5)).toBe(0xffffn); // + IOCTL_DEV
    expect(handledFilesystemAccess(7)).toBe(0xffffn);
  });
});

describe('confinementSupport', () => {
  test('answers once, so load order cannot change the answer', () => {
    expect(confinementSupport()).toBe(confinementSupport());
  });

  test('reports a reason exactly when confinement is unavailable', () => {
    const detected = confinementSupport();
    const reason = unconfinableReason();
    if (detected.available) {
      expect(detected.missing).toEqual([]);
      expect(reason).toBeUndefined();
      return;
    }
    // Never a bare `false`: the two things an operator can do about it depend
    // on knowing which half is missing.
    expect(detected.missing.length).toBeGreaterThan(0);
    expect(reason).toContain(detected.missing[0]);
  });

  test('reports no confinement away from Linux rather than guessing', () => {
    if (process.platform === 'linux') return;
    const detected = confinementSupport();
    expect(detected.available).toBe(false);
    expect(detected.seccompFilter).toBe(false);
    expect(detected.landlockAbi).toBeLessThan(1);
    expect(unconfinableReason()).toContain(process.platform);
  });
});
