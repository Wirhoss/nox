const spanishMessages = Object.freeze({
  'toolSet.description':
    'Ejecuta programaciones persistentes en sesiones nuevas de agentes configurados.',
  'toolSet.name': 'Tareas programadas',
  'tools.cron_agents.description': 'Lista agentes configurados y brokers de entrega.',
  'tools.cron_create.description': 'Crea una ejecución de agente persistente, única o recurrente.',
  'tools.cron_delete.description': 'Elimina una tarea y todo su historial de ejecuciones.',
  'tools.cron_get.description': 'Lee una tarea programada y sus ejecuciones recientes.',
  'tools.cron_list.description': 'Lista las tareas de esta instancia del toolset cron.',
  'tools.cron_run.description': 'Inicia una sesión nueva sin mover la programación.',
  'tools.cron_update.description': 'Cambia agente, canal, horario, prompt o estado de una tarea.',
  'ui.maxJobs': 'Máximo de tareas',
  'ui.maxJobsHelp': 'Límite de tareas de esta instancia configurada del toolset.',
} as const);

export { spanishMessages };
