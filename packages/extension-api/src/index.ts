/**
 * Public, versioned contract for Nox extensions.
 *
 * This package is dependency-inverted: it imports no Nox kernel modules. Runtime
 * services are supplied through ExtensionContext and addressed by typed tokens.
 */
export { z } from 'zod';

export * from './artifacts.js';
export type * from './brokers.js';
export type * from './chat.js';
export * from './commands.js';
export * from './content.js';
export * from './contributions.js';
export * from './core.js';
export type * from './memory.js';
export * from './providers.js';
export * from './schemas.js';
export * from './services.js';
export * from './tools.js';
export * from './untrusted.js';

/** Stable issuer used by Nox's authenticated browser conversation surface. */
const WEB_BROKER_ID = 'web';

export { WEB_BROKER_ID };
