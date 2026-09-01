/**
 * The packages Nox resolves at runtime instead of inlining into a bundle.
 *
 * One list, because the four copies it replaces had already drifted apart: the
 * builtin build, the consumer test, the standalone example and the image each
 * named a different set, and nothing failed until the wrong one was missing at
 * the wrong moment.
 *
 * Two different reasons put a package here, and both are absolute:
 *
 * - **Identity.** `zod` must be the one instance the host holds. Contribution
 *   discovery asks `instanceof z.ZodObject` and `instanceof z.ZodLiteral`; a
 *   second copy passes every type check and then silently fails to be
 *   recognised, which is the worst shape a failure can take.
 * - **Native binaries.** `sharp` and Transformers load platform binaries that a
 *   bundler cannot carry, and that an image builds exactly once
 *   for the architecture it targets.
 *
 * Being a package the host happens to have installed is not enough to be on
 * this list. `onnxruntime-node` was on the list it replaces and is not here:
 * it is a private dependency of Transformers, not addressable from the host
 * root, so leaving it external only produced a bundle that compiled and then
 * failed to start. What the host provides is what the host can resolve.
 *
 * It lives in the public contract rather than in the kernel because the people
 * who most need to read it are outside it: an extension compiled elsewhere has
 * `@nox/extension-api` and nothing else of Nox to import.
 */
const HOST_PROVIDED_PACKAGES: readonly string[] = Object.freeze([
  '@huggingface/transformers',
  'sharp',
  'sqlite-vec',
  'zod',
]);

/**
 * What an extension bundle must leave external: everything the host provides,
 * plus the contract package itself.
 *
 * `@nox/extension-api` is the one addition, and it is a definition rather than
 * an exception: the host publishes this package, so an extension that inlined a
 * copy would be carrying a second answer to a question only the host may
 * answer. The version an extension gets is the one `engines.extensionApi`
 * selected.
 *
 * Anything not on this list, an extension bundles itself. That is the whole
 * rule for third-party libraries — and a native dependency that cannot be
 * bundled, and that Nox does not provide, is not installable today.
 */
const EXTENSION_EXTERNAL_PACKAGES: readonly string[] = Object.freeze([
  ...HOST_PROVIDED_PACKAGES,
  '@nox/extension-api',
]);

export { EXTENSION_EXTERNAL_PACKAGES, HOST_PROVIDED_PACKAGES };
