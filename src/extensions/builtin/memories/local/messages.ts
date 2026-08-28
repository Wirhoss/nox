const englishMessages = Object.freeze({
  'ui.maxEntries': 'Maximum entries per scope',
  'ui.maxEntriesHelp':
    'Oldest turns are removed after this many entries for one agent and principal.',
  'ui.maxRecallItems': 'Maximum recalled turns',
  'ui.maxRecallItemsHelp':
    'Maximum number of lexically relevant turns considered for one model request.',
} as const);

export { englishMessages };
