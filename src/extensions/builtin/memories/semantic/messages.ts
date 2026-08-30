const englishMessages = Object.freeze({
  'ui.contradictionDistance': 'Contradiction review',
  'ui.contradictionDistanceHelp':
    'How far apart two remembered facts may sit and still be put to the extraction model as a possible contradiction, so a belief a later one ended can be retired outside the turn that ended it. This is the only consolidation step that costs a model call: 0 turns it off, and larger values ask about more pairs. Must exceed the duplicate threshold, since anything nearer is merged instead.',
  'ui.dream': 'Background extraction',
  'ui.dreamHelp':
    'When Nox is allowed to spend the extraction model on turns it has stored. A pass starts once this many turns are waiting, or once the runtime has been quiet for this long, or once the oldest waiting turn reaches the maximum delay — whichever comes first. Extracting while Nox is quiet keeps the extraction model from competing with the model answering, which matters most when both run on the same local hardware.',
  'ui.embedding': 'Embedding model',
  'ui.embeddingHelp':
    'Provider and model used to place remembered facts in vector space. Changing it discards stored vectors and rebuilds them.',
  'ui.maxDistance': 'Relevance floor',
  'ui.maxDistanceHelp':
    'How far a remembered fact may be from the question and still be recalled. L2 distance from 0 to 2; lower is stricter, 2 recalls the nearest facts whether or not they are relevant. Leave it empty to have Nox measure the value that fits the chosen embedding model.',
  'ui.extraction': 'Extraction model',
  'ui.extractionHelp': 'Provider and model that decides what a finished turn is worth remembering.',
  'ui.mergeDistance': 'Duplicate threshold',
  'ui.mergeDistanceHelp':
    'How close two remembered facts must be before Nox folds them into one, combining their witnesses and confidence. Far stricter than the relevance floor, because merging two statements that only looked alike destroys one of them: the default admits restatements, not related thoughts. 0 disables merging.',
  'ui.maxRecallFacts': 'Maximum recalled facts',
  'ui.maxRecallFactsHelp':
    'Maximum number of remembered facts placed in context for one model request.',
} as const);

export { englishMessages };
