import type { EngineOptions, InferenceEngine } from './engine';

const RUNTIME_PACKAGE = '@huggingface/transformers';

/**
 * Resolves the model runtime, or explains its absence.
 *
 * Imported dynamically rather than at module load, because it ships prebuilt
 * native binaries and loading them costs memory an installation that never
 * configures a local model should not pay. It is a real dependency, so being
 * unable to load it means a broken install rather than a choice — and it is
 * reported here, once, with what to check, instead of surfacing as a module
 * resolution error inside a worker thread that nobody is watching.
 */
async function loadEngine(options: EngineOptions): Promise<InferenceEngine> {
  let module: unknown;
  try {
    module = await import(RUNTIME_PACKAGE);
  } catch (error) {
    throw new Error(
      `The local model runtime could not be loaded: ${RUNTIME_PACKAGE} is missing or its ` +
        'native binaries do not match this platform. Reinstall dependencies on this machine.',
      { cause: error },
    );
  }
  const { createTransformersEngine } = await import('./transformersEngine');
  return createTransformersEngine(module, options);
}

export { loadEngine, RUNTIME_PACKAGE };
