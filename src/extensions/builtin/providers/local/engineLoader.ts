import type { EngineOptions, InferenceEngine } from './engine';

const RUNTIME_PACKAGE = '@huggingface/transformers';

/**
 * Resolves the model runtime, or explains its absence.
 *
 * The runtime is an optional dependency because it ships prebuilt native
 * binaries per platform, and a Nox that nobody configures a local model on
 * should not have to carry them. That makes "it is not installed" a normal
 * state rather than a broken one — so it fails here, once, with the sentence
 * that fixes it, instead of surfacing as a module resolution error inside a
 * worker thread that an operator never sees.
 */
async function loadEngine(options: EngineOptions): Promise<InferenceEngine> {
  let module: unknown;
  try {
    module = await import(RUNTIME_PACKAGE);
  } catch (error) {
    throw new Error(
      `The local model runtime is not available: ${RUNTIME_PACKAGE} could not be loaded. ` +
        'Install it to configure a local model, or remove the local entry from configuration.',
      { cause: error },
    );
  }
  const { createTransformersEngine } = await import('./transformersEngine');
  return createTransformersEngine(module, options);
}

export { loadEngine, RUNTIME_PACKAGE };
