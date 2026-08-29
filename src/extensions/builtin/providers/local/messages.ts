const englishMessages = Object.freeze({
  'ui.cacheDirectory': 'Weight cache directory',
  'ui.cacheDirectoryHelp':
    'Where downloaded weights are kept. Left empty, the runtime uses its own cache.',
  'ui.model': 'Model',
  'ui.modelHelp': 'Repository the weights are fetched from the first time the model is used.',
  'ui.precision': 'Weight precision',
  'ui.precisionHelp':
    'Lower precision loads faster and uses less memory, at some cost in quality.',
  'ui.threads': 'CPU threads',
  'ui.threadsHelp':
    'Kept low on purpose: these threads share the machine with the server answering requests.',
} as const);

export { englishMessages };
