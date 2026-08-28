const spanishMessages = Object.freeze({
  'ui.applicationId': 'ID de aplicación',
  'ui.applicationIdHelp':
    'La aplicación de Discord a la que pertenece el bot. Los comandos se publican contra ella.',
  'ui.broker': 'Discord',
  'ui.brokerHelp':
    'Lleva conversaciones en Discord: mensajes directos, canales admitidos y los hilos que cuelgan de ellos.',
  'ui.channels': 'Canales admitidos',
  'ui.channelsHelp':
    'Canales que Nox lee, por ID. Vacío significa ninguno. Admitir un canal no otorga nada: qué se puede hacer ahí lo deciden las concesiones y las excepciones por conversación.',
  'ui.dms': 'Mensajes directos de',
  'ui.dmsHelp':
    'IDs de usuario que pueden abrir una conversación directa. Un mensaje directo no necesita disparador: hay una sola persona y todo lo que dice es para Nox.',
  'ui.guildId': 'ID del servidor',
  'ui.guildIdHelp':
    'Dónde se publican los comandos. Un servidor los registra al instante. Dejalo vacío para publicarlos globalmente, que es lo que necesita un bot que está en más de un servidor —  y la única forma de que los comandos funcionen en mensajes directos. Los globales tardan cerca de una hora en propagarse.',
  'ui.names': 'Otros nombres',
  'ui.namesHelp':
    'Palabras que cuentan como dirigirse a Nox donde el canal responde a su nombre. Su propio usuario de Discord siempre cuenta.',
  'ui.observe': 'Mensajes que no le hablan',
  'ui.observeHelp':
    'Si el resto de la sala entra en el transcript. Leer el canal cuesta contexto y deja la sesión permanentemente en modo compartido, donde toda llamada con efectos necesita la aprobación de quien la originó.',
  'ui.respondTo': 'Responde cuando',
  'ui.respondToHelp':
    'Qué hace que un mensaje de este canal sea algo dicho a Nox. «Cualquier mensaje» significa que todo el canal le habla.',
  'ui.senders': 'Solo responde a',
  'ui.sendersHelp':
    'IDs de usuario que pueden hacer que el agente conteste acá. Vacío significa cualquiera que ya pueda hablar en el canal. Esto decide si una ejecución arranca, que es distinto de lo que las concesiones dejan hacer una vez que arrancó.',
  'ui.threads': 'Hilos',
  'ui.threadsHelp':
    'Si los hilos de este canal quedan admitidos con él. Un hilo es su propia conversación con su propio transcript, y por eso es la forma de empezar un tema de cero.',
  'ui.token': 'Token del bot',
  'ui.tokenHelp':
    'La configuración guarda solo una referencia al secreto. El valor se carga por la superficie de Secretos, que es de solo escritura, y nunca vuelve a este formulario.',
  'ui.trigger.all': 'Cualquier mensaje del canal',
  'ui.trigger.mention': 'Lo mencionan',
  'ui.trigger.name': 'Dicen su nombre',
  'ui.trigger.reply': 'Responden un mensaje suyo',
  'ui.verboseReasoning': 'Mostrar razonamiento',
  'ui.verboseReasoningHelp': 'Publica lo que el modelo pensó camino a la respuesta.',
  'ui.verboseRuns': 'Mostrar ejecuciones',
  'ui.verboseRunsHelp': 'Publica cuando una ejecución termina en algo que no es una respuesta.',
  'ui.verboseToolActivity': 'Mostrar actividad de herramientas',
  'ui.verboseToolActivityHelp':
    'Publica las llamadas que hace el agente. También decide si un transcript leído desde Discord las contiene.',
  'ui.verboseUsage': 'Mostrar consumo de tokens',
  'ui.verboseUsageHelp': 'Publica lo que costó cada llamada al modelo.',
} as const);

export { spanishMessages };
