const englishMessages = Object.freeze({
  'toolSet.description':
    'Run persistent schedules in fresh sessions of selected configured agents.',
  'toolSet.name': 'Cron jobs',
  'tools.cron_agents.description': 'List configured agents and delivery brokers.',
  'tools.cron_create.description': 'Create a persistent one-time or recurring agent run.',
  'tools.cron_delete.description': 'Permanently delete a scheduled job and its run history.',
  'tools.cron_get.description': 'Read one scheduled job and its recent runs.',
  'tools.cron_list.description': 'List jobs owned by this cron tool-set instance.',
  'tools.cron_run.description': 'Start a fresh agent session without moving the schedule.',
  'tools.cron_update.description': 'Change an agent, channel, schedule, prompt, or enabled state.',
  'ui.maxJobs': 'Maximum jobs',
  'ui.maxJobsHelp': 'Upper bound for jobs owned by this configured tool-set instance.',
} as const);

export { englishMessages };
