const brokerMessages = Object.freeze({
  'settings.broker.addAuthority': 'Añadir autoridad',
  'settings.broker.addConversationOverride': 'Añadir excepción de conversación',
  'settings.broker.addConversationSender': 'Añadir remitente a la conversación',
  'settings.broker.addSenderGrant': 'Añadir concesión de remitente',
  'settings.broker.agentOverride': 'Agente alternativo',
  'settings.broker.authorityPattern': 'Patrón de autoridad',
  'settings.broker.authorization': 'AUTORIZACIÓN',
  'settings.broker.baseAgent': 'Agente base',
  'settings.broker.baseGrants': 'Concesiones base de remitentes',
  'settings.broker.baseGrantsHelp':
    'Este bróker autentica los ID de remitente. Sin fila no hay autoridad; las concesiones con comodines aceptan deliberadamente futuras autoridades de ese espacio de nombres.',
  'settings.broker.baseRouteOnly': 'SOLO RUTA BASE',
  'settings.broker.baseRouteOnlyHelp':
    'Todas las conversaciones usan el agente y las concesiones base.',
  'settings.broker.brokerJson': 'JSON del bróker',
  'settings.broker.brokerJsonHelp':
    'Acceso completo al enrutamiento, autorización y campos aportados. Las credenciales deben conservarse como referencias $secret.',
  'settings.broker.changeRefused': 'Cambio de bróker rechazado',
  'settings.broker.composeOnRestart': 'Activar bróker',
  'settings.broker.composeOnRestartHelp':
    'Las entradas desactivadas siguen configuradas, pero no abren conexiones, rutas ni secretos.',
  'settings.broker.contribution': 'CONTRIBUCIÓN',
  'settings.broker.contributionJson': 'JSON de la contribución',
  'settings.broker.conversation': 'CONVERSACIÓN',
  'settings.broker.conversationId': 'ID de conversación',
  'settings.broker.conversationIdHint':
    'ID nativo del transporte para el canal, sala o conversación.',
  'settings.broker.failClosed': 'FALLO SEGURO',
  'settings.broker.formatPayload': 'Formatear contenido',
  'settings.broker.header': 'BRÓKER',
  'settings.broker.held': 'RETENIDO',
  'settings.broker.id': 'ID del bróker',
  'settings.broker.idHint':
    'ID del emisor y de la instancia configurada. El ID web está reservado.',
  'settings.broker.managedCredentials': 'CREDENCIALES GESTIONADAS',
  'settings.broker.managedReferences': 'Referencias gestionadas',
  'settings.broker.managedReferencesHelp':
    'Cada credencial mencionada por la configuración de este bróker. Los valores se escriben aquí y nunca se vuelven a leer; la configuración solo conserva el ID.',
  'settings.broker.namedConversations': 'Conversaciones identificadas',
  'settings.broker.namedConversationsHelp':
    'Una conversación del transporte puede elegir otro agente y reemplazar las concesiones base por su propio mapa seguro de forma predeterminada.',
  'settings.broker.newValueLabel': 'Nuevo valor // {secret}',
  'settings.broker.newValuePlaceholder': 'Nuevo valor para {secret}',
  'settings.broker.noBaseAuthority':
    'Ningún remitente base tiene autoridad de herramientas en este bróker.',
  'settings.broker.noConversationGrants': 'SIN CONCESIONES DE CONVERSACIÓN',
  'settings.broker.noConversationGrantsHelp':
    'Todos los remitentes tienen denegada la autoridad de herramientas en esta conversación.',
  'settings.broker.overrides': 'EXCEPCIONES',
  'settings.broker.principal': 'PRINCIPAL',
  'settings.broker.remove': 'Eliminar bróker',
  'settings.broker.removeQuestion': '¿Eliminar el bróker?',
  'settings.broker.removeWarning':
    'El transporte se detendrá cuando terminen los turnos actuales de sus conversaciones.',
  'settings.broker.routing': 'ENRUTAMIENTO',
  'settings.broker.save': 'Guardar bróker',
  'settings.broker.saved': 'Configuración del bróker guardada',
  'settings.broker.secretValueHint': 'Si se deja vacío se conserva el valor existente.',
  'settings.broker.askAgentOnNewConversation': 'Preguntar al iniciar una conversación',
  'settings.broker.selectAgent': 'Selecciona un agente',
  'settings.broker.sender': 'REMITENTE',
  'settings.broker.senderId': 'ID del remitente',
  'settings.broker.senderIdHint':
    'Identidad emitida por este transporte, limitada al emisor de este bróker.',
  'settings.broker.titleFallback': 'Bróker',
  'settings.broker.titleNew': 'Nuevo bróker',
  'settings.broker.transportPayload': 'Contenido del transporte',
  'settings.broker.transportPayloadHelp':
    'Los campos de conexión pertenecen a la extensión instalada. Conserva aquí solo sus propiedades específicas del transporte; el enrutamiento y las concesiones permanecen en la superficie guiada.',
  'settings.broker.transportRoute': 'Ruta del transporte',
  'settings.broker.transportRouteHelp':
    'Cada conversación entra mediante un transporte aportado y recurre a un agente base.',
  'settings.broker.typeUnset': 'TIPO SIN DEFINIR',
  'settings.broker.useBaseAgent': 'Usar {agent}',
  'settings.broker.validation.agentAvailable': 'Elige un plano de agente disponible en este Nox.',
  'settings.broker.validation.authorityPattern':
    'Usa un ID de autoridad, un comodín de espacio de nombres o *.',
  'settings.broker.validation.baseAgentRequired':
    'Se requiere un agente base incluso cuando el bróker está desactivado.',
  'settings.broker.validation.configurationObject':
    'La configuración del bróker debe ser un único objeto JSON.',
  'settings.broker.validation.conflictingSecretValues':
    'Este ID de secreto tiene dos valores pendientes diferentes.',
  'settings.broker.validation.conversationIdRequired': 'El ID de conversación es obligatorio.',
  'settings.broker.validation.conversationIdUnique': 'Los ID de conversación deben ser únicos.',
  'settings.broker.validation.grantUnique':
    'Los patrones de concesión deben ser únicos para cada remitente.',
  'settings.broker.validation.invalidSecretId':
    'Esta configuración contiene un ID de secreto no válido.',
  'settings.broker.validation.payloadJson': 'El contenido de la contribución no es JSON válido.',
  'settings.broker.validation.payloadObject':
    'El contenido de la contribución debe ser un único objeto JSON.',
  'settings.broker.validation.senderIdRequired': 'El ID del remitente es obligatorio.',
  'settings.broker.validation.senderIdUnique':
    'Los ID de remitente deben ser únicos dentro de esta ruta.',
  'settings.broker.validation.storeBeforeEnabling':
    'Guarda un valor antes de activar esta referencia del bróker.',
  'settings.broker.validation.webReserved': 'El ID «web» está reservado para el chat de Nox.',
} as const);

export { brokerMessages };
