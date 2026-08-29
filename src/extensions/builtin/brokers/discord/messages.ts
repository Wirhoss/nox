const englishMessages = Object.freeze({
  'ui.applicationId': 'Application ID',
  'ui.applicationIdHelp':
    'The Discord application the bot belongs to. Slash commands are published against it.',
  'ui.broker': 'Discord',
  'ui.brokerHelp':
    'Carries conversations on Discord: direct messages, admitted guild channels, and threads under them.',
  'ui.channels': 'Admitted channels',
  'ui.channelsHelp':
    'Channels Nox reads, by channel ID. Empty means it reads none. Admitting a channel grants nothing; grants and per-conversation overrides decide what may be done there.',
  'ui.dms': 'Direct messages from',
  'ui.dmsHelp':
    'User IDs allowed to hold a direct conversation. A direct message needs no trigger: there is one person in it and everything they say is addressed to Nox.',
  'ui.guildId': 'Server ID',
  'ui.guildIdHelp':
    'Where slash commands are published. A server registers them immediately. Leave it empty to publish globally, which is what a bot in more than one server needs — and the only way commands work in direct messages. Global commands take about an hour to propagate.',
  'ui.names': 'Extra names',
  'ui.namesHelp':
    'Words that count as addressing Nox where a channel responds to its name. Its own Discord username always counts.',
  'ui.observe': 'Unaddressed messages',
  'ui.observe.channel': 'Everything said in the channel',
  'ui.observe.none': 'Only what is said to Nox',
  'ui.observeHelp':
    'Whether the rest of the room enters the transcript. Reading the channel costs context and puts the session permanently into shared mode, where every effectful tool call needs its originator’s approval.',
  'ui.respondTo': 'Answers when',
  'ui.respondToHelp':
    'What makes a message in this channel something said to Nox. “All” means every message in the channel is addressed to it.',
  'ui.senders': 'Answers only',
  'ui.sendersHelp':
    'Who can make the agent answer here: user IDs, or roles as “role:<id>”. Empty means anyone the channel already lets speak. This is whether a run starts at all, which is a different question from what grants let a run do.',
  'ui.threads': 'Threads',
  'ui.threads.ignore': 'Not admitted',
  'ui.threads.inherit': 'Admitted with the channel',
  'ui.threadsHelp':
    'Whether threads under this channel are admitted with it. A thread is its own conversation with its own transcript, which makes it the way to start a topic over.',
  'ui.token': 'Bot token',
  'ui.tokenHelp':
    'Configuration stores only a secret reference. The value enters through the write-only Secrets surface and never returns to this form.',
  'ui.trigger.all': 'Any message in the channel',
  'ui.trigger.mention': 'It is mentioned',
  'ui.trigger.name': 'Someone says its name',
  'ui.trigger.reply': 'Someone replies to it',
  'ui.verboseReasoning': 'Show reasoning',
  'ui.verboseReasoningHelp': 'Post what the model thought on the way to the answer.',
  'ui.verboseRuns': 'Show runs',
  'ui.verboseRunsHelp': 'Post when a run ends in anything other than a completed answer.',
  'ui.verboseToolActivity': 'Show tool activity',
  'ui.verboseToolActivityHelp':
    'Post the calls the agent makes. Also decides whether a transcript read back through Discord contains them.',
  'ui.verboseUsage': 'Show token usage',
  'ui.verboseUsageHelp': 'Post what each model call cost.',
} as const);

export { englishMessages };
